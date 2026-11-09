import { app } from './app.js';
import { formatAgo, formatWhen } from './format.js';

const channelOf = (buffer) => {
  if (buffer.type !== 'channel') throw new Error('That only works in a channel.');
  return buffer.name;
};
const need = (value, usage) => {
  if (!value) throw new Error(`Usage: ${usage}`);
  return value;
};
const words = (text) => text.split(/\s+/).filter(Boolean);
const say = (text, kind = 'info') => app.note(app.active, kind, text);

const role = (mode, add) => ({
  usage: `<nick> [nick…]`,
  run(rest, buffer) {
    const nicks = words(need(rest, `<nick>`));
    return app.run('mode', { channel: channelOf(buffer), changes: nicks.map((arg) => ({ add, mode, arg })) });
  },
});

/**
 * Every slash command. `usage` and `help` feed /help and the autocomplete;
 * `run` gets the text after the command and the buffer it was typed in.
 */
export const COMMANDS = {
  join: {
    usage: '<#channel>', help: 'Join a channel, or create it',
    run: (rest) => app.join(need(words(rest)[0], '/join <#channel>')),
  },
  part: {
    usage: '[reason]', help: 'Leave this channel',
    run: (rest, buffer) => app.run('part', { channel: channelOf(buffer), reason: rest }),
  },
  close: { usage: '', help: 'Close this conversation or leave this channel', run: (rest, buffer) => app.close(buffer) },
  msg: {
    usage: '<nick> <text>', help: 'Send a private message',
    async run(rest) {
      const [, nick, text] = /^(\S+)\s+([\s\S]+)$/.exec(rest) ?? [];
      need(text, '/msg <nick> <text>');
      const target = nick.startsWith('#') ? app.buffers.get(nick.toLowerCase()) : app.ensureDm(nick);
      if (!target) throw new Error(`You are not in ${nick}.`);
      if (await app.send(text, { target })) app.activate(target.key);
    },
  },
  query: {
    usage: '<nick>', help: 'Open a private conversation',
    run: (rest) => app.openDm(need(words(rest)[0], '/query <nick>')),
  },
  me: {
    usage: '<action>', help: 'Say what you are doing: /me waves',
    run: (rest) => app.send(need(rest, '/me <action>'), { kind: 'action' }),
  },
  nick: {
    usage: '<new nick>', help: 'Change your nick',
    run: (rest) => app.run('nick', { nick: need(words(rest)[0], '/nick <new nick>') }),
  },
  topic: {
    usage: '[text]', help: 'Show or change the topic',
    run(rest, buffer) {
      const channel = channelOf(buffer);
      if (rest) return app.run('topic', { channel, topic: rest });
      say(buffer.topic ? `Topic: ${buffer.topic}${buffer.topicBy ? ` (set by ${buffer.topicBy})` : ''}` : 'No topic is set.');
    },
  },
  whois: {
    usage: '<nick>', help: 'Who is this?',
    async run(rest, buffer) {
      const nick = words(rest)[0] ?? (buffer.type === 'dm' ? buffer.name : null);
      const who = await app.request('whois', { nick: need(nick, '/whois <nick>') });
      const lines = [`${who.nick} is ${who.registered ? 'a registered nick' : 'a guest'}.`];
      if (who.online) {
        lines.push(`Online for ${formatAgo(Date.now() - who.connectedAt)}, last active ${formatAgo(Date.now() - who.lastActive)} ago.`);
      } else if (who.lastSeen) {
        lines.push(`Offline, last seen ${formatWhen(who.lastSeen)}.`);
      }
      if (who.away) lines.push(`Away: ${who.away}`);
      if (who.channels.length) {
        lines.push(`In ${who.channels.map((c) => (c.role === 'op' ? '@' : c.role === 'voice' ? '+' : '') + c.name).join(' ')}`);
      }
      say(lines.join('\n'));
    },
  },
  list: { usage: '', help: 'Browse all channels', run: () => app.emit('dialog', 'jump') },
  search: {
    usage: '<text>', help: 'Search your channels and conversations',
    run: (rest) => app.emit('dialog', { name: 'search', query: rest }),
  },
  away: {
    usage: '[message]', help: 'Mark yourself away; without a message, come back',
    async run(rest) {
      if (await app.run('away', { message: rest || null })) say(rest ? `You are away: ${rest}` : 'You are back.');
    },
  },
  back: { usage: '', help: 'You are no longer away', run: () => COMMANDS.away.run('') },
  register: {
    usage: '<password>', help: 'Keep your nick: turn it into an account',
    async run(rest) {
      const result = await app.request('register', { password: need(rest, '/register <password>') });
      app.self = result.self;
      if (result.token) app.stored.set('token', result.token);
      app.emit('self');
      say(`${result.self.nick} is now registered. Sign in with this password next time.`);
    },
  },
  kick: {
    usage: '<nick> [reason]', help: 'Remove someone from the channel',
    run(rest, buffer) {
      const [, nick, reason = ''] = /^(\S+)\s*([\s\S]*)$/.exec(rest) ?? [];
      return app.run('kick', { channel: channelOf(buffer), nick: need(nick, '/kick <nick> [reason]'), reason });
    },
  },
  ban: { help: 'Ban a nick from the channel', ...role('b', true) },
  unban: { help: 'Lift a ban', ...role('b', false) },
  kickban: {
    usage: '<nick> [reason]', help: 'Ban and remove someone',
    async run(rest, buffer) {
      const [, nick, reason = ''] = /^(\S+)\s*([\s\S]*)$/.exec(rest) ?? [];
      const channel = channelOf(buffer);
      await app.request('mode', { channel, changes: [{ add: true, mode: 'b', arg: need(nick, '/kickban <nick> [reason]') }] });
      await app.request('kick', { channel, nick, reason });
    },
  },
  bans: {
    usage: '', help: 'List the bans of this channel',
    async run(rest, buffer) {
      const { bans } = await app.request('bans', { channel: channelOf(buffer) });
      say(bans.length ? `Banned: ${bans.map((ban) => `${ban.nick} (by ${ban.by})`).join(', ')}` : 'Nobody is banned.');
    },
  },
  op: { help: 'Make someone an operator', ...role('o', true) },
  deop: { help: 'Take operator status away', ...role('o', false) },
  voice: { help: 'Let someone speak in a moderated channel', ...role('v', true) },
  devoice: { help: 'Take voice away', ...role('v', false) },
  mode: {
    usage: '<+flags|-flags> [nick…]', help: 'Channel modes: t topic lock, m moderated, i invite-only, o v b',
    run(rest, buffer) {
      const [flags, ...args] = words(rest);
      const channel = channelOf(buffer);
      if (!flags) return say(`Modes of ${channel}: +${buffer.modes || ''}`);
      const changes = [];
      let add = true;
      for (const flag of flags) {
        if (flag === '+' || flag === '-') add = flag === '+';
        else changes.push({ add, mode: flag, ...('ovb'.includes(flag) ? { arg: args.shift() } : {}) });
      }
      return app.run('mode', { channel, changes });
    },
  },
  invite: {
    usage: '<nick>', help: 'Invite someone to this channel',
    async run(rest, buffer) {
      const nick = need(words(rest)[0], '/invite <nick>');
      await app.request('invite', { channel: channelOf(buffer), nick });
      say(`Invited ${nick}.`);
    },
  },
  clear: {
    usage: '', help: 'Clear this window (history stays on the server)',
    run(rest, buffer) {
      buffer.items = [];
      buffer.hasMore = buffer.type !== 'status';
      app.emit('items', { buffer, kind: 'reset' });
    },
  },
  quit: { usage: '', help: 'Sign out', run: () => app.signOut() },
  help: {
    usage: '', help: 'Show this list',
    run() {
      const lines = Object.entries(COMMANDS).map(([name, c]) => `/${name}${c.usage ? ` ${c.usage}` : ''}  ${c.help}`);
      say(`${lines.join('\n')}\nTab completes nicks, commands and channels. Up and Down recall what you typed.`);
    },
  },
};

const ALIASES = { j: 'join', leave: 'part', q: 'query', w: 'whois', signout: 'quit', logout: 'quit' };

/**
 * Handles one line from the composer.
 * @returns {Promise<boolean>} false when the input should stay in the box
 */
export async function submit(input, { replyTo = null } = {}) {
  const buffer = app.active;
  // "//" at the start sends a message that begins with a slash.
  if (!input.startsWith('/') || input.startsWith('//')) {
    return app.send(input.startsWith('//') ? input.slice(1) : input, { replyTo });
  }
  const [, word, rest = ''] = /^\/(\S*)\s*([\s\S]*)$/.exec(input);
  const name = ALIASES[word.toLowerCase()] ?? word.toLowerCase();
  if (!Object.hasOwn(COMMANDS, name)) {
    say(`Unknown command /${word}. Type /help for the list.`, 'error');
    return false;
  }
  try {
    await COMMANDS[name].run(rest.trim(), buffer);
    return true;
  } catch (err) {
    say(err.message, 'error');
    return false;
  }
}
