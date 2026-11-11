import { createServer } from 'node:net';
import { ChatError } from '../core/errors.js';
import { TokenBucket } from '../core/ratelimit.js';
import { isChannelName, nickKey } from '../core/validate.js';

const CAPS = ['server-time', 'echo-message'];
const MAX_LINE_BYTES = 4096;
const MAX_TEXT_BYTES = 400;
const REGISTRATION_TIMEOUT_MS = 30_000;
const PING_AFTER_MS = 90_000;
const DROP_AFTER_MS = 240_000;
const PLAYBACK_LINES = 50;
const CLOAK = 'user.swarm';
/** A client that stops reading is cut off once this much is waiting for it. */
const MAX_BUFFERED = 1024 * 1024;

/** Hub error codes with a numeric that IRC clients understand. */
const NUMERIC_FOR = {
  no_such_channel: 403,
  no_such_nick: 401,
  not_in_channel: 442,
  not_op: 482,
  invite_only: 473,
  invalid_nick: 432,
  nick_in_use: 433,
  nick_registered: 433,
  invalid_channel: 403,
  too_many_channels: 405,
  bad_code: 475,
};

function parseIrcLine(line) {
  let rest = line;
  if (rest.startsWith('@')) rest = rest.slice(rest.indexOf(' ') + 1).trimStart();
  if (rest.startsWith(':')) rest = rest.includes(' ') ? rest.slice(rest.indexOf(' ') + 1).trimStart() : '';
  const params = [];
  while (rest) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const space = rest.indexOf(' ');
    if (space < 0) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, space));
    rest = rest.slice(space + 1).trimStart();
  }
  return { command: (params.shift() ?? '').toUpperCase(), params };
}

/** Splits text into pieces that fit an IRC line, at spaces where possible. */
export function wrapForIrc(text, maxBytes = MAX_TEXT_BYTES) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    let size = 0;
    for (const word of paragraph.split(/(?<= )/)) {
      const bytes = Buffer.byteLength(word);
      if (size + bytes <= maxBytes) {
        current += word;
        size += bytes;
        continue;
      }
      if (current) lines.push(current);
      current = '';
      size = 0;
      // A single word longer than a line is cut by code point.
      for (const char of word) {
        const charBytes = Buffer.byteLength(char);
        if (size + charBytes > maxBytes) {
          lines.push(current);
          current = '';
          size = 0;
        }
        current += char;
        size += charBytes;
      }
    }
    if (current.trim()) lines.push(current);
  }
  return lines;
}

const sigil = (role) => (role === 'op' ? '@' : role === 'voice' ? '+' : '');
const mask = (nick) => `${nick}!${nickKey(nick)}@${CLOAK}`;

/** One IRC client connection: translates between IRC lines and the hub. */
class IrcClient {
  constructor(socket, hub, options, id) {
    this.socket = socket;
    this.hub = hub;
    this.options = options;
    this.host = options.host;
    this.id = id;
    this.kind = 'irc';
    this.user = null;
    this.token = null;
    this.closed = false;
    this.caps = new Set();
    this.negotiating = false;
    this.wantedNick = null;
    this.gotUser = false;
    this.password = null;
    this.buffer = '';
    this.lastHeard = Date.now();
    this.bucket = new TokenBucket(40, 10);
    this.queue = Promise.resolve();
    this.address = socket.remoteAddress ?? 'unknown';

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.#onClose());
    this.registrationTimer = setTimeout(() => {
      if (!this.user) this.drop('Registration timed out');
    }, REGISTRATION_TIMEOUT_MS);
    this.registrationTimer.unref();
  }

  get nick() {
    return this.user?.nick ?? this.wantedNick ?? '*';
  }

  // ------------------------------------------------------------------ output

  raw(line) {
    if (this.closed || this.dead || !this.socket.writable) return;
    if (this.socket.writableLength > MAX_BUFFERED) return this.socket.destroy();
    // One call, one line: whatever a string carries, it cannot start another.
    this.socket.write(`${line.replace(/[\r\n\0]/g, ' ')}\r\n`);
  }

  /** `:server 001 nick middle... :trailing` */
  num(code, ...params) {
    const trailing = params.pop();
    const middle = params.length ? ` ${params.join(' ')}` : '';
    this.raw(`:${this.host} ${String(code).padStart(3, '0')} ${this.nick}${middle} :${trailing}`);
  }

  notice(text) {
    this.raw(`:${this.host} NOTICE ${this.nick} :${text}`);
  }

  /** Says why, then closes for good: nothing the client sends afterwards is read. */
  drop(reason) {
    this.raw(`ERROR :Closing link: ${reason}`);
    this.dead = true;
    this.buffer = '';
    this.socket.destroySoon();
  }

  // ------------------------------------------------------------------- input

  #onData(chunk) {
    if (this.dead) return;
    this.lastHeard = Date.now();
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.drop('Line too long');
      // One line at a time, so a sign-in in progress is never overtaken.
      this.queue = this.queue.then(() => this.#handle(line));
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.drop('Line too long');
  }

  #onClose() {
    this.closed = true;
    clearTimeout(this.registrationTimer);
    this.hub.disconnect(this, { reason: this.quitReason ?? 'Connection closed', immediate: Boolean(this.quitReason) });
  }

  async #handle(line) {
    if (this.closed || this.dead) return;
    const { command, params } = parseIrcLine(line);
    if (!command) return;
    try {
      if (!this.bucket.take()) throw new ChatError('rate_limited', 'Too many commands. Slow down.');
      const beforeSignIn = PRE_REGISTRATION[command];
      if (beforeSignIn) return await beforeSignIn.call(this, params);
      if (!this.user) return this.num(451, 'You have not registered');
      const handler = COMMANDS[command];
      if (!handler) return this.num(421, command, 'Unknown command');
      await handler.call(this, params);
    } catch (err) {
      if (err instanceof ChatError) return this.fail(err, params[0]);
      this.options.log('irc command failed', command, err);
      this.notice('Something went wrong on the server.');
    }
  }

  fail(err, subject = '*') {
    const code = NUMERIC_FOR[err.code];
    if (code) this.num(code, subject || '*', err.message);
    else if (err.code === 'banned' || err.code === 'moderated') this.num(404, subject, err.message);
    else this.notice(err.message);
  }

  need(params, count, command) {
    if (params.length >= count && params[count - 1] !== '') return true;
    this.num(461, command, 'Not enough parameters');
    return false;
  }

  // ------------------------------------------------------------ registration

  async tryRegister() {
    if (this.user || this.negotiating || !this.wantedNick || !this.gotUser) return;
    const { loginGuard } = this.options;
    if (this.password && loginGuard.blocked(this.address)) return this.drop('Too many failed sign-ins');
    const nick = this.wantedNick;
    const guessing = Boolean(this.password || this.classCode);
    let snapshot;
    try {
      // Counted up front so parallel attempts cannot slip under the limit.
      if (guessing) loginGuard.fail(this.address);
      snapshot = await this.hub.login(this, { nick, password: this.password, code: this.classCode, session: false });
      if (guessing) loginGuard.forgive(this.address);
    } catch (err) {
      if (guessing && !['bad_password', 'bad_code'].includes(err.code)) loginGuard.forgive(this.address);
      if (err.code === 'closed') return;
      if (err.code === 'bad_password') {
        this.num(464, 'Password incorrect');
        return this.drop('Bad password');
      }
      if (err.code === 'no_such_account') {
        // A server password with an unregistered nick is a class code: a
        // student comes in as a guest, straight into that class.
        this.classCode = this.password;
        this.password = null;
        return this.tryRegister();
      }
      if (err.code === 'code_required' || err.code === 'bad_code') {
        this.num(464, err.message);
        return this.drop('Connect with your class code as the server password');
      }
      if (err.code === 'nick_registered') {
        this.notice(`${nick} is a registered nick. Connect with its password as the server password.`);
      }
      if (err instanceof ChatError) {
        // The client answers these with another NICK, which tries again.
        this.wantedNick = null;
        return this.num(NUMERIC_FOR[err.code] ?? 432, nick, err.message);
      }
      throw err;
    }
    clearTimeout(this.registrationTimer);
    this.#welcome(snapshot);
  }

  #welcome(snapshot) {
    const { name, motd } = snapshot.server;
    const version = `swarm-${this.options.version}`;
    this.num(1, `Welcome to ${name}, ${this.nick}`);
    this.num(2, `Your host is ${this.host}, running ${version}`);
    this.num(3, `This server was started ${new Date(this.options.startedAt).toUTCString()}`);
    this.raw(`:${this.host} 004 ${this.nick} ${this.host} ${version} o imnt`);
    this.num(
      5,
      'CHANTYPES=#', 'PREFIX=(ov)@+', 'CHANMODES=b,k,,imt', 'NICKLEN=20', 'CHANNELLEN=33', 'TOPICLEN=300',
      `NETWORK=${name.replace(/\s+/g, '-')}`, 'CASEMAPPING=ascii',
      'are supported by this server',
    );
    this.motd(motd);
    this.notice(
      snapshot.self.registered
        ? `You are signed in as ${this.nick}.`
        : `You are a guest. To keep the nick ${this.nick}: /msg NickServ REGISTER <password>`,
    );
    for (const channel of snapshot.channels) this.sendJoin(channel);
  }

  motd(text) {
    if (!text) return this.num(422, 'MOTD is not set');
    this.num(375, `- ${this.host} message of the day -`);
    for (const line of wrapForIrc(text)) this.num(372, `- ${line}`);
    this.num(376, 'End of /MOTD command.');
  }

  // ------------------------------------------------------- channel state out

  sendJoin(channel) {
    this.raw(`:${mask(this.nick)} JOIN ${channel.name}`);
    this.sendTopic(channel, false);
    this.sendNames(channel);
    if (!this.caps.has('server-time')) return;
    // With timestamps the client can show what was said while it was away.
    const { messages } = this.hub.history(this.user, channel.name, { limit: PLAYBACK_LINES });
    for (const msg of messages) {
      if (!msg.deleted) this.sendMessage(channel.name, msg);
    }
  }

  sendTopic(channel, always) {
    if (channel.topic) {
      this.num(332, channel.name, channel.topic);
      if (channel.topicBy) {
        this.raw(`:${this.host} 333 ${this.nick} ${channel.name} ${channel.topicBy} ${Math.floor(channel.topicAt / 1000)}`);
      }
    } else if (always) {
      this.num(331, channel.name, 'No topic is set');
    }
  }

  sendNames(channel) {
    const names = channel.members.filter((member) => member.online).map((member) => sigil(member.role) + member.nick);
    for (let i = 0; i < names.length; i += 20) {
      this.num(353, '=', channel.name, names.slice(i, i + 20).join(' '));
    }
    this.num(366, channel.name, 'End of /NAMES list.');
  }

  sendMessage(target, msg) {
    const own = nickKey(msg.nick) === this.user.key;
    const dest = isChannelName(target) ? target : own ? target : this.nick;
    const verb = msg.kind === 'notice' ? 'NOTICE' : 'PRIVMSG';
    if (msg.kind === 'poll') {
      // Voting happens in the web client; IRC at least sees the question.
      const options = msg.poll ? ` (${msg.poll.options.join(' / ')})` : '';
      const tags = this.caps.has('server-time') ? `@time=${new Date(msg.ts).toISOString()} ` : '';
      return this.raw(`${tags}:${mask(msg.nick)} NOTICE ${dest} :[poll] ${msg.text}${options}`);
    }
    const tags = this.caps.has('server-time') ? `@time=${new Date(msg.ts).toISOString()} ` : '';
    for (const line of wrapForIrc(msg.text)) {
      const text = msg.kind === 'action' ? `\x01ACTION ${line}\x01` : line;
      this.raw(`${tags}:${mask(msg.nick)} ${verb} ${dest} :${text}`);
    }
  }

  /** Called by the hub for everything this user should hear about. */
  deliver(event, meta) {
    if (!this.user) return;
    switch (event.type) {
      case 'message':
        if (meta?.origin === this.id && !this.caps.has('echo-message')) return;
        return this.sendMessage(event.target, event.msg);
      case 'channel_joined':
        return this.sendJoin(event.channel);
      case 'join':
        if (!event.member.online) return;
        this.raw(`:${mask(event.member.nick)} JOIN ${event.channel}`);
        return this.#announceRole(event.channel, event.member.nick, event.member.role);
      case 'part':
        return this.raw(`:${mask(event.nick)} PART ${event.channel} :${event.reason}`);
      case 'kick':
        if (!event.online) return;
        return this.raw(`:${mask(event.by)} KICK ${event.channel} ${event.nick} :${event.reason || event.nick}`);
      case 'quit':
        return this.raw(`:${mask(event.nick)} QUIT :${event.reason}`);
      case 'presence':
        // IRC only knows people who are connected: coming online is a join.
        if (event.change === 'offline') return this.raw(`:${mask(event.nick)} QUIT :${event.reason}`);
        if (event.change !== 'online') return;
        for (const { name, role } of this.hub.sharedChannels(this.user, event.nick)) {
          this.raw(`:${mask(event.nick)} JOIN ${name}`);
          this.#announceRole(name, event.nick, role);
        }
        return;
      case 'nick':
        return this.raw(`:${mask(event.old)} NICK :${event.nick}`);
      case 'topic':
        return this.raw(`:${mask(event.by)} TOPIC ${event.channel} :${event.topic}`);
      case 'mode': {
        const visible = event.changes.filter((change) => change.online !== false);
        if (!visible.length) return;
        const flags = visible.map((change) => (change.add ? '+' : '-') + change.mode).join('');
        // IRC wants a parameter with +k; the code itself stays with the people who run the class.
        const args = visible.map((change) => change.arg ?? (change.mode === 'k' && change.add ? '*' : null))
          .filter(Boolean).map((arg) => ` ${arg}`).join('');
        return this.raw(`:${mask(event.by)} MODE ${event.channel} ${flags}${args}`);
      }
      case 'invite':
        return this.raw(`:${mask(event.by)} INVITE ${this.nick} :${event.channel}`);
      default:
        // Edits, reactions, typing and read markers have no IRC equivalent.
    }
  }

  /** The state of a channel the user is in, or null. */
  viewOf(name) {
    try {
      return this.hub.channelInfo(this.user, name);
    } catch (err) {
      if (err instanceof ChatError) return null;
      throw err;
    }
  }

  #announceRole(channel, nick, role) {
    if (role) this.raw(`:${this.host} MODE ${channel} +${role === 'op' ? 'o' : 'v'} ${nick}`);
  }

  // ---------------------------------------------------------------- services

  async nickServ(text) {
    // Everything after the verb is the password, so it may contain spaces.
    const [, verb = '', password = ''] = /^\s*(\S*)\s*(.*)$/s.exec(text);
    const say = (line) => this.raw(`:NickServ!services@${this.host} NOTICE ${this.nick} :${line}`);
    if (verb.toUpperCase() !== 'REGISTER') {
      return say('Commands: REGISTER <password>. To sign in, connect with the password as the server password.');
    }
    const { registrationGuard } = this.options;
    if (registrationGuard.blocked(this.address)) return say('Too many nicks were registered from your address. Try again later.');
    try {
      await this.hub.register(this.user, password, this);
      registrationGuard.fail(this.address);
      say(`${this.nick} is now registered. Use the password as the server password when you connect.`);
    } catch (err) {
      if (!(err instanceof ChatError)) throw err;
      say(err.message);
    }
  }
}

const PRE_REGISTRATION = {
  CAP([sub = '', arg = '']) {
    switch (sub.toUpperCase()) {
      case 'LS':
        if (!this.user) this.negotiating = true;
        return this.raw(`:${this.host} CAP ${this.nick} LS :${CAPS.join(' ')}`);
      case 'LIST':
        return this.raw(`:${this.host} CAP ${this.nick} LIST :${[...this.caps].join(' ')}`);
      case 'REQ': {
        if (!this.user) this.negotiating = true;
        const wanted = arg.split(/\s+/).filter(Boolean);
        if (!wanted.every((cap) => CAPS.includes(cap.replace(/^-/, '')))) {
          return this.raw(`:${this.host} CAP ${this.nick} NAK :${arg}`);
        }
        for (const cap of wanted) {
          if (cap.startsWith('-')) this.caps.delete(cap.slice(1));
          else this.caps.add(cap);
        }
        return this.raw(`:${this.host} CAP ${this.nick} ACK :${arg}`);
      }
      case 'END':
        this.negotiating = false;
        return this.tryRegister();
      default:
        return this.num(410, sub || '*', 'Invalid CAP command');
    }
  },
  PASS(params) {
    if (this.user) return this.num(462, 'You may not reregister');
    this.password = params[0] || null;
  },
  NICK(params) {
    if (!this.need(params, 1, 'NICK')) return;
    if (this.user) {
      this.hub.changeNick(this.user, params[0]);
      return;
    }
    this.wantedNick = params[0];
    return this.tryRegister();
  },
  USER() {
    if (this.user) return this.num(462, 'You may not reregister');
    this.gotUser = true;
    return this.tryRegister();
  },
  PING(params) {
    this.raw(`:${this.host} PONG ${this.host} :${params[0] ?? ''}`);
  },
  PONG() {},
  QUIT(params) {
    this.quitReason = params[0] ? `Quit: ${params[0].slice(0, 200)}` : 'Quit';
    this.drop('bye');
  },
};

const COMMANDS = {
  JOIN(params) {
    if (!this.need(params, 1, 'JOIN')) return;
    const keys = (params[1] ?? '').split(',');
    for (const [i, name] of params[0].split(',').filter(Boolean).entries()) {
      if (name === '0') continue;
      try {
        this.hub.join(this.user, name, { code: keys[i] || undefined });
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
        if (err.code === 'banned') this.num(474, name, err.message);
        else this.fail(err, name);
      }
    }
  },

  PART(params) {
    if (!this.need(params, 1, 'PART')) return;
    for (const name of params[0].split(',').filter(Boolean)) {
      try {
        this.hub.part(this.user, name, params[1]);
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
        this.fail(err, name);
      }
    }
  },

  async PRIVMSG(params, kind = 'msg') {
    if (params.length < 1) return this.num(411, 'No recipient given');
    if (!params[1]) return this.num(412, 'No text to send');
    let text = params[1];
    const ctcp = /^\x01(\w+) ?(.*?)\x01?$/s.exec(text);
    if (ctcp) {
      if (ctcp[1].toUpperCase() !== 'ACTION') return; // Other CTCP requests are not relayed.
      kind = 'action';
      text = ctcp[2];
    }
    for (const target of params[0].split(',').filter(Boolean)) {
      if (nickKey(target) === 'nickserv') {
        await this.nickServ(text);
        continue;
      }
      try {
        const sent = this.hub.send(this.user, target, text, { kind, origin: this.id });
        if (sent.away) this.num(301, target, sent.away);
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
        this.fail(err, target);
      }
    }
  },

  NOTICE(params) {
    return COMMANDS.PRIVMSG.call(this, params, 'notice');
  },

  TOPIC(params) {
    if (!this.need(params, 1, 'TOPIC')) return;
    if (params.length > 1) return void this.hub.setTopic(this.user, params[0], params[1]);
    this.sendTopic(this.hub.channelInfo(this.user, params[0]), true);
  },

  NAMES(params) {
    if (!params[0]) return this.num(366, '*', 'End of /NAMES list.');
    for (const name of params[0].split(',').filter(Boolean)) {
      const channel = this.viewOf(name);
      if (channel) this.sendNames(channel);
      else this.num(366, name, 'End of /NAMES list.');
    }
  },

  LIST() {
    this.num(321, 'Channel', 'Users  Name');
    for (const channel of this.hub.list(this.user).channels) {
      this.num(322, channel.name, String(channel.online), channel.topic);
    }
    this.num(323, 'End of /LIST');
  },

  WHO(params) {
    const target = params[0] ?? '*';
    const row = (channel, member) =>
      this.num(
        352, channel, nickKey(member.nick), CLOAK, this.host, member.nick,
        (member.away ? 'G' : 'H') + sigil(member.role), `0 ${member.nick}`,
      );
    if (isChannelName(target)) {
      const channel = this.viewOf(target);
      for (const member of channel?.members ?? []) if (member.online) row(channel.name, member);
    } else {
      try {
        const who = this.hub.whois(this.user, target);
        if (who.online) row('*', { nick: who.nick, role: null, away: who.away });
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
      }
    }
    this.num(315, target, 'End of /WHO list.');
  },

  WHOIS(params) {
    if (!this.need(params, 1, 'WHOIS')) return;
    const nick = params[params.length - 1];
    let who;
    try {
      who = this.hub.whois(this.user, nick);
    } catch (err) {
      if (!(err instanceof ChatError)) throw err;
    }
    if (!who?.online) {
      this.num(401, nick, 'No such nick');
      return this.num(318, nick, 'End of /WHOIS list.');
    }
    this.num(311, who.nick, nickKey(who.nick), CLOAK, '*', who.nick);
    if (who.channels.length) {
      this.num(319, who.nick, who.channels.map((channel) => sigil(channel.role) + channel.name).join(' '));
    }
    this.num(312, who.nick, this.host, this.options.name);
    if (who.away) this.num(301, who.nick, who.away);
    if (who.registered) this.num(330, who.nick, who.nick, 'is logged in as');
    this.num(
      317, who.nick, String(Math.floor((Date.now() - who.lastActive) / 1000)),
      String(Math.floor(who.connectedAt / 1000)), 'seconds idle, signon time',
    );
    this.num(318, who.nick, 'End of /WHOIS list.');
  },

  MODE(params) {
    if (!this.need(params, 1, 'MODE')) return;
    const [target, flags, ...args] = params;
    if (!isChannelName(target)) return this.raw(`:${this.host} 221 ${this.nick} +i`);
    if (!flags) {
      const channel = this.viewOf(target);
      if (!channel) return this.num(403, target, 'No such channel');
      this.raw(`:${this.host} 324 ${this.nick} ${channel.name} +${channel.modes}`);
      return this.raw(`:${this.host} 329 ${this.nick} ${channel.name} ${Math.floor(channel.createdAt / 1000)}`);
    }
    if (/^\+?b$/.test(flags) && args.length === 0) {
      for (const ban of this.hub.bans(this.user, target).bans) {
        this.raw(`:${this.host} 367 ${this.nick} ${target} ${ban.nick}!*@* ${ban.by} ${Math.floor(ban.at / 1000)}`);
      }
      return this.num(368, target, 'End of channel ban list');
    }
    const changes = [];
    let add = true;
    for (const flag of flags) {
      if (flag === '+' || flag === '-') {
        add = flag === '+';
        continue;
      }
      const change = { add, mode: flag };
      // Clients send bans as masks; here a ban is on a nick.
      if ('ovb'.includes(flag)) change.arg = (args.shift() ?? '').replace(/!.*$/, '');
      if (flag === 'k') args.shift(); // the key a client sends is ignored: codes are generated
      changes.push(change);
    }
    this.hub.setMode(this.user, target, changes);
  },

  KICK(params) {
    if (!this.need(params, 2, 'KICK')) return;
    for (const nick of params[1].split(',').filter(Boolean)) {
      this.hub.kick(this.user, params[0], nick, params[2]);
    }
  },

  INVITE(params) {
    if (!this.need(params, 2, 'INVITE')) return;
    this.hub.invite(this.user, params[1], params[0]);
    this.raw(`:${this.host} 341 ${this.nick} ${params[0]} ${params[1]}`);
  },

  AWAY(params) {
    this.hub.setAway(this.user, params[0] || null);
    if (params[0]) this.num(306, 'You have been marked as being away');
    else this.num(305, 'You are no longer marked as being away');
  },

  MOTD() {
    this.motd(this.hub.config.motd);
  },

  LUSERS() {
    const { users, channels } = this.hub.stats();
    this.num(251, `There are ${users} users on 1 server`);
    this.num(254, String(channels), 'channels formed');
  },

  USERHOST(params) {
    const replies = [];
    for (const nick of params.slice(0, 5)) {
      const user = this.hub.users.get(nickKey(nick));
      if (user) replies.push(`${user.nick}=${user.away ? '-' : '+'}${nickKey(user.nick)}@${CLOAK}`);
    }
    this.num(302, replies.join(' '));
  },

  ISON(params) {
    const online = params.join(' ').split(/\s+/).filter((nick) => this.hub.users.has(nickKey(nick)));
    this.num(303, online.join(' '));
  },
};

/**
 * Speaks enough of the IRC protocol for ordinary clients (irssi, WeeChat,
 * HexChat, ...) to take part: registration with an optional server password,
 * channels, private messages, topics, modes, kicks, WHO/WHOIS and LIST.
 */
export function createIrcServer(hub, options) {
  const settings = { log: () => {}, startedAt: Date.now(), version: '0', host: 'irc.swarm', ...options };
  const clients = new Set();
  let seq = 0;

  const server = createServer((socket) => {
    const client = new IrcClient(socket, hub, settings, `irc${++seq}`);
    clients.add(client);
    socket.on('close', () => clients.delete(client));
  });

  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      const quiet = now - client.lastHeard;
      if (quiet > DROP_AFTER_MS) client.socket.destroy();
      else if (quiet > PING_AFTER_MS) client.raw(`PING :${settings.host}`);
    }
  }, 30_000);
  keepalive.unref();
  server.on('close', () => clearInterval(keepalive));

  /** Closes the listener and every client connection. */
  server.shutdown = () => {
    for (const client of clients) client.socket.destroy();
    server.close();
  };
  return server;
}
