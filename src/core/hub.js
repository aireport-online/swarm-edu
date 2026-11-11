import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ChatError } from './errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { TokenBucket } from './ratelimit.js';
import {
  cleanText,
  isChannelName,
  nickKey,
  parseChannel,
  parseEmoji,
  parseLine,
  parseNick,
  parsePassword,
  parseText,
} from './validate.js';

const DEFAULTS = {
  serverName: 'Swarm',
  motd: '',
  defaultChannels: ['#lobby'],
  /** Registered nicks (lowercase) that run the default channels. */
  admins: [],
  /** How long a user stays "online" after their last connection drops. */
  graceMs: 20_000,
  maxMessageLength: 4000,
  maxTopicLength: 300,
  maxChannelsPerUser: 50,
  maxReactionsPerMessage: 20,
  historyPageSize: 50,
  messageBurst: 10,
  messagesPerSecond: 1.5,
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  /** Registered nicks (lowercase) that are teachers whatever their account says. */
  teachers: [],
  /** Whoever registers or types /teacher with this code becomes a teacher. Null: nobody can. */
  teacherCode: null,
  /** The school rules. Switch them all off and this is plain Swarm again. */
  school: {
    /** A guest can only come in through a class, with its code. */
    guestsNeedCode: true,
    /** Students join classes; only teachers open them. */
    onlyTeachersCreate: true,
    /** A new class gets a code at once. */
    autoCode: true,
    /** Private messages need a teacher at one end. */
    studentDms: false,
    /** Students see only their own classes in the list. */
    privateList: true,
  },
};

// No I, O, 0 or 1: a code is read off a board and typed on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const POLL_MAX_OPTIONS = 8;
const TRANSCRIPT_LINES = 5000;
const sha = (value) => createHash('sha256').update(String(value)).digest();

const MESSAGE_KINDS = new Set(['msg', 'action', 'notice']);
const FLAG_MODES = ['t', 'm', 'i'];
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/**
 * A person, online. One user can hold several connections at once (two
 * browser tabs and an IRC client, say) and they all see the same thing.
 */
class User {
  constructor(nick, account, hub) {
    this.nick = nick;
    this.key = nickKey(nick);
    this.hub = hub;
    /** @type {{id: number, createdAt: number, role: string|null}|null} null for guests */
    this.account = account;
    this.conns = new Set();
    this.channels = new Set();
    this.away = null;
    this.connectedAt = hub.now();
    this.lastActive = this.connectedAt;
    /** Ids of messages a guest sent this session: the only ones they may edit. */
    this.sentIds = new Set();
    this.graceTimer = null;
    this.bucket = new TokenBucket(hub.config.messageBurst, hub.config.messagesPerSecond, hub.now);
  }
  get registered() {
    return this.account !== null;
  }
  /** Teachers are accounts: by their role, or because the school's configuration names them. */
  get teacher() {
    return this.account !== null && (this.account.role === 'teacher' || this.hub.config.teachers.includes(this.key));
  }
}

/**
 * The chat itself, independent of any wire protocol. Gateways hand it
 * connections (`{ id, deliver(event, meta) }`) and call its methods on behalf
 * of users; it validates, persists and tells every affected connection what
 * happened. Methods throw `ChatError` for anything the user got wrong.
 */
export class Hub {
  constructor({ store, config = {}, now = Date.now }) {
    this.store = store;
    this.now = now;
    this.config = { ...DEFAULTS, ...config, school: { ...DEFAULTS.school, ...config.school } };
    /** @type {Map<string, User>} online users by lowercased nick */
    this.users = new Map();
    /** @type {Map<number, User>} online registered users by account id */
    this.byAccount = new Map();
    /** @type {Map<string, object>} every channel by name */
    this.channels = new Map();
    /** @type {Map<string, User>} resume tokens of guests */
    this.guestTokens = new Map();
    /** @type {Map<string, object>} classes by their code */
    this.codes = new Map();
    this.ephemeralSeq = 0;
    this.#load();
    this.pruneTimer = setInterval(
      () => this.store.pruneSessions(this.now() - this.config.sessionTtlMs),
      6 * 3600 * 1000,
    );
    this.pruneTimer.unref?.();
  }

  #load() {
    const byId = new Map();
    for (const row of this.store.loadChannels()) {
      const channel = this.#channelFromRow(row);
      this.channels.set(channel.name, channel);
      byId.set(channel.id, channel);
      if (channel.code) this.codes.set(channel.code, channel);
    }
    for (const row of this.store.loadMemberships()) {
      const key = nickKey(row.nick);
      byId.get(row.channelId)?.members.set(key, {
        nick: row.nick, key, accountId: row.accountId, role: row.role, user: null,
        teacher: row.teacher || this.config.teachers.includes(key),
      });
    }
    for (const row of this.store.loadBans()) byId.get(row.channelId)?.bans.set(row.nickKey, row.accountId);
    for (const name of this.config.defaultChannels) {
      if (!this.channels.has(name)) {
        this.#createChannel(name, null, `Welcome to ${this.config.serverName}. Say hello.`);
      }
    }
    this.store.pruneSessions(this.now() - this.config.sessionTtlMs);
  }

  #channelFromRow(row) {
    return {
      id: row.id,
      name: row.name,
      topic: row.topic,
      topicBy: row.topicBy,
      topicAt: row.topicAt,
      modes: Object.fromEntries(FLAG_MODES.map((flag) => [flag, row.modes.includes(flag)])),
      founderId: row.founderId,
      createdAt: row.createdAt,
      /** The class code: what a student types to get in. Null for an open channel. */
      code: row.code ?? null,
      pinnedId: row.pinnedId ?? null,
      /** @type {Map<string, number>} raised hands, first up first: nick -> when */
      hands: new Map(),
      /** @type {Map<string, {nick, key, accountId, role, user, teacher}>} online guests, and registered members online or not */
      members: new Map(),
      /** @type {Map<string, number|null>} banned nick -> the account behind it, if any */
      bans: new Map(),
      /** Invitations are for a person, not a nick: they end when the invited user goes offline. */
      invites: new WeakSet(),
    };
  }

  #createChannel(name, founder, topic = '') {
    const now = this.now();
    const founderId = founder?.account?.id ?? null;
    const id = this.store.createChannel({ name, founderId, modes: 't', topic, now });
    const channel = this.#channelFromRow({
      id, name, topic, topicBy: null, topicAt: null, modes: 't', founderId, createdAt: now,
    });
    this.channels.set(name, channel);
    if (founder && this.config.school.autoCode) this.#setCode(channel, this.#newCode());
    return channel;
  }

  // ---------------------------------------------------------------- delivery

  #toUser(user, event, meta) {
    for (const conn of user.conns) {
      try {
        conn.deliver(event, meta);
      } catch {
        // A broken connection is cleaned up by its gateway's close handler.
      }
    }
  }

  #toChannel(channel, event, meta) {
    for (const member of channel.members.values()) {
      if (member.user) this.#toUser(member.user, event, meta);
    }
  }

  /** Everyone who shares a channel with `user`, each once, never the user. */
  #peersOf(user) {
    const peers = new Set();
    for (const channel of user.channels) {
      for (const member of channel.members.values()) {
        if (member.user && member.user !== user) peers.add(member.user);
      }
    }
    return peers;
  }

  /** @param {'online'|'offline'|'away'|'registered'|'role'} change what is new about the user */
  #presence(user, change, extra = {}) {
    const event = {
      type: 'presence', change, nick: user.nick, online: change !== 'offline', away: user.away,
      registered: user.registered, teacher: user.teacher, ...extra,
    };
    for (const peer of this.#peersOf(user)) this.#toUser(peer, event);
    return event;
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Attaches a connection to a user, creating or resuming the user as needed.
   *
   * - `token` resumes an earlier session without a password.
   * - `nick` alone connects as a guest, unless the nick is registered.
   * - `nick` + `password` signs in to a registered nick.
   * - `nick` + `password` + `register` claims a free nick.
   *
   * Pass `session: false` when the client has no use for a resume token.
   *
   * @returns {Promise<object>} everything a client needs to draw itself
   */
  async login(conn, { nick, password, token, register = false, session = true, code, teacherCode } = {}) {
    if (conn.user) throw new ChatError('bad_request', 'This connection is already signed in.');
    let user = token ? this.#resume(token) : null;
    let notice = null;
    if (!user) {
      if (token && !nick) throw new ChatError('bad_token', 'Your session has expired. Sign in again.');
      // A wrong class code or staff code stops the sign-in before anything is created.
      const classroom = code ? this.#classByCode(code) : null;
      if (register && teacherCode) this.#checkTeacherCode(teacherCode);
      user = await this.#authenticate({ nick, password, register, classroom });
      if (register && teacherCode) this.#makeTeacher(user);
      if (classroom && !classroom.members.has(user.key)) {
        try {
          this.#enter(user, classroom, { coded: true });
        } catch (err) {
          if (!(err instanceof ChatError)) throw err;
          notice = err.message; // signed in all the same; the class just did not open
        }
      }
      token = session ? this.#issueToken(user) : null;
    }
    if (conn.user) throw new ChatError('bad_request', 'This connection is already signed in.');
    conn.user = user;
    conn.token = token;
    user.conns.add(conn);
    clearTimeout(user.graceTimer);
    user.graceTimer = null;
    if (conn.closed) {
      // The socket went away while the password was being checked.
      this.disconnect(conn);
      throw new ChatError('closed', 'Connection closed.');
    }
    return { ...this.snapshot(user, token), notice };
  }

  // Password hashing is the only asynchronous step, so it always comes first:
  // everything that looks at shared state runs after it, in one go, and two
  // simultaneous logins cannot both win the same nick.
  async #authenticate({ nick, password, register, classroom = null }) {
    nick = parseNick(nick);
    const key = nickKey(nick);

    if (register) {
      const free = () => {
        if (this.store.accountByKey(key)) {
          throw new ChatError('nick_registered', `The nick ${nick} is already registered.`);
        }
        if (this.users.has(key)) throw new ChatError('nick_in_use', `The nick ${nick} is in use.`);
      };
      parsePassword(password);
      free(); // before hashing, so a taken nick costs nothing; and again after, for races
      const hash = await hashPassword(password);
      free();
      return this.#bringOnline(nick, this.store.createAccount(nick, hash, this.now()), true);
    }

    const claimed = this.store.accountByKey(key);
    if (claimed) {
      if (!password) {
        throw new ChatError('nick_registered', `The nick ${nick} is registered. Sign in with its password.`);
      }
      const ok = await verifyPassword(password, claimed.passwordHash);
      const account = ok ? this.store.accountById(claimed.id) : null;
      if (!account) throw new ChatError('bad_password', 'Wrong password.');
      return this.byAccount.get(account.id) ?? this.#bringOnline(account.nick, account);
    }

    if (password) throw new ChatError('no_such_account', `The nick ${nick} is not registered.`);
    if (this.users.has(key)) throw new ChatError('nick_in_use', `The nick ${nick} is in use.`);
    // In a school a guest is somebody's student: no class, no way in.
    if (this.config.school.guestsNeedCode && !classroom) {
      throw new ChatError('code_required', 'Enter the class code your teacher gave you.');
    }
    if (classroom?.modes.i) throw new ChatError('invite_only', `${classroom.name} is locked. Ask your teacher to let you in.`);
    if (classroom?.bans.has(key)) throw new ChatError('banned', `You are banned from ${classroom.name}.`);
    return this.#bringOnline(nick, null, true);
  }

  #resume(token) {
    const guest = this.guestTokens.get(token);
    if (guest) return guest;
    const accountId = this.store.useSession(hashToken(token), this.now(), this.config.sessionTtlMs);
    if (accountId == null) return null;
    const account = this.store.accountById(accountId);
    if (!account) return null;
    return this.byAccount.get(account.id) ?? this.#bringOnline(account.nick, account);
  }

  #issueToken(user) {
    const token = newToken();
    if (user.registered) this.store.addSession(hashToken(token), user.account.id, this.now());
    else this.guestTokens.set(token, user);
    return token;
  }

  /** @param {boolean} [fresh] a new guest or a new account: put them in the default channels */
  #bringOnline(nick, account, fresh = false) {
    const user = new User(nick, account && { id: account.id, createdAt: account.createdAt, role: account.role }, this);
    this.users.set(user.key, user);
    if (account) this.byAccount.set(account.id, user);
    if (fresh) {
      for (const name of this.config.defaultChannels) {
        const channel = this.channels.get(name);
        if (channel && !channel.modes.i && !this.#isBanned(channel, user)) this.#addMember(channel, user);
      }
      return user;
    }
    for (const channel of this.channels.values()) {
      const member = channel.members.get(user.key);
      if (member?.accountId === account.id) {
        member.user = user;
        user.channels.add(channel);
        if (member.role !== 'op' && this.#runsChannel(channel, user)) {
          member.role = 'op';
          this.store.setRole(channel.id, account.id, 'op');
        }
      }
    }
    this.#presence(user, 'online');
    return user;
  }

  /** Call when a connection closes for any reason. */
  disconnect(conn, { immediate = false, reason = 'Connection closed' } = {}) {
    const user = conn.user;
    if (!user || this.closed) return;
    conn.user = null;
    user.conns.delete(conn);
    if (user.conns.size > 0) return;
    // The reason is shown to others, so it gets the same cleaning as any other line.
    reason = cleanText(String(reason)).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Connection closed';
    clearTimeout(user.graceTimer);
    if (immediate || this.config.graceMs <= 0) {
      this.#goOffline(user, reason);
    } else {
      user.graceTimer = setTimeout(() => this.#goOffline(user, reason), this.config.graceMs);
      user.graceTimer.unref?.();
    }
  }

  /** Ends the session for good: the token stops working. */
  logout(conn) {
    const user = conn.user;
    if (!user) return;
    if (conn.token) {
      if (user.registered) this.store.deleteSession(hashToken(conn.token));
      else this.guestTokens.delete(conn.token);
    }
    this.disconnect(conn, { immediate: true, reason: 'Signed out' });
  }

  #goOffline(user, reason) {
    if (user.conns.size > 0 || this.users.get(user.key) !== user) return;
    clearTimeout(user.graceTimer);
    this.users.delete(user.key);

    if (user.registered) {
      // Registered users stay members of their channels while away.
      this.byAccount.delete(user.account.id);
      this.store.touchAccount(user.account.id, this.now());
      this.#presence(user, 'offline', { reason });
      for (const channel of user.channels) {
        channel.members.get(user.key).user = null;
        channel.hands.delete(user.key);
      }
      user.channels.clear();
      return;
    }

    for (const [token, owner] of this.guestTokens) {
      if (owner === user) this.guestTokens.delete(token);
    }
    const peers = this.#peersOf(user);
    const channels = [...user.channels];
    for (const channel of channels) {
      channel.members.delete(user.key);
      channel.hands.delete(user.key);
    }
    user.channels.clear();
    for (const peer of peers) this.#toUser(peer, { type: 'quit', nick: user.nick, reason });
    for (const channel of channels) this.#dropIfEmpty(channel);
  }

  /**
   * Call before closing the store. Connections that drop afterwards are
   * ignored, since there is nothing left to record them in.
   */
  close() {
    this.closed = true;
    clearInterval(this.pruneTimer);
    for (const user of this.users.values()) clearTimeout(user.graceTimer);
  }

  snapshot(user, token) {
    return {
      self: this.#self(user),
      token,
      server: {
        name: this.config.serverName,
        motd: this.config.motd,
        rules: { ...this.config.school, teacherCode: Boolean(this.config.teacherCode) },
      },
      channels: [...user.channels].map((channel) => this.#channelState(channel, user)),
      dms: user.registered
        ? this.store.dmList(user.account.id).map((dm) => {
            const peer = this.byAccount.get(dm.peerId);
            return {
              nick: dm.nick,
              unread: dm.unread,
              lastRead: dm.lastRead,
              latestId: dm.latestId,
              registered: true,
              online: Boolean(peer),
              away: peer?.away ?? null,
            };
          })
        : [],
    };
  }

  #self(user) {
    return { nick: user.nick, registered: user.registered, away: user.away, teacher: user.teacher };
  }

  // ---------------------------------------------------------------- channels

  #member(member) {
    return {
      nick: member.nick,
      role: member.role,
      teacher: member.teacher,
      registered: member.accountId != null,
      online: member.user !== null,
      away: member.user?.away ?? null,
    };
  }

  #modeString(channel) {
    return FLAG_MODES.filter((flag) => channel.modes[flag]).join('') + (channel.code ? 'k' : '');
  }

  #channelState(channel, user) {
    const read = user.registered
      ? this.store.channelUnread(channel.id, user.account.id, user.nick)
      : { lastRead: null, unread: 0, mentions: 0 };
    return {
      name: channel.name,
      topic: channel.topic,
      topicBy: channel.topicBy,
      topicAt: channel.topicAt,
      modes: this.#modeString(channel),
      createdAt: channel.createdAt,
      members: [...channel.members.values()].map((member) => this.#member(member)),
      hands: [...channel.hands.keys()].map((key) => channel.members.get(key)?.nick).filter(Boolean),
      pinned: this.#pinned(channel),
      // What only the people running the class get to see.
      ...(channel.members.get(user.key)?.role === 'op' ? { code: channel.code, reports: this.#reports(channel) } : {}),
      ...read,
    };
  }

  #channel(name) {
    const channel = this.channels.get(parseChannel(name));
    if (!channel) throw new ChatError('no_such_channel', `There is no channel ${name}.`);
    return channel;
  }

  /** The channel and the caller's membership in it. */
  #membership(user, name) {
    const channel = this.#channel(name);
    const member = channel.members.get(user.key);
    if (!member) throw new ChatError('not_in_channel', `You are not in ${channel.name}.`);
    return { channel, member };
  }

  #asOp(user, name) {
    const found = this.#membership(user, name);
    if (found.member.role !== 'op') {
      throw new ChatError('not_op', `You are not an operator of ${found.channel.name}.`);
    }
    return found;
  }

  #target(channel, nick) {
    const target = channel.members.get(nickKey(String(nick ?? '')));
    if (!target) throw new ChatError('no_such_nick', `${nick} is not in ${channel.name}.`);
    return target;
  }

  #protectFounder(channel, user, target) {
    if (target.accountId != null && target.accountId === channel.founderId && target.key !== user.key) {
      throw new ChatError('forbidden', `${target.nick} founded ${channel.name} and cannot be removed.`);
    }
  }

  #addMember(channel, user) {
    // Like IRC: whoever walks into a channel without operators runs it. The
    // default channels are the exception: everybody lands there, so only the
    // configured admins run those.
    const hasOps = [...channel.members.values()].some((member) => member.role === 'op');
    const adopts = !hasOps && !this.config.defaultChannels.includes(channel.name);
    const member = {
      nick: user.nick,
      key: user.key,
      accountId: user.account?.id ?? null,
      role: adopts || this.#runsChannel(channel, user) ? 'op' : null,
      user,
      teacher: user.teacher,
    };
    if (user.registered) this.store.addMembership(channel.id, user.account.id, member.role, this.now());
    this.#toChannel(channel, { type: 'join', channel: channel.name, member: this.#member(member) });
    channel.members.set(user.key, member);
    channel.invites.delete(user);
    user.channels.add(channel);
    this.#toUser(user, { type: 'channel_joined', channel: this.#channelState(channel, user) });
    return member;
  }

  /** Founders run their channel; admins run the default channels. */
  #runsChannel(channel, user) {
    if (!user.registered) return false;
    if (user.account.id === channel.founderId) return true;
    return this.config.defaultChannels.includes(channel.name) && this.config.admins.includes(user.key);
  }

  #isBanned(channel, user) {
    if (channel.bans.has(user.key)) return true;
    if (!user.registered) return false;
    for (const accountId of channel.bans.values()) if (accountId === user.account.id) return true;
    return false;
  }

  #removeMember(channel, member) {
    channel.members.delete(member.key);
    channel.hands.delete(member.key);
    member.user?.channels.delete(channel);
    if (member.accountId != null) this.store.removeMembership(channel.id, member.accountId);
  }

  /** A channel exists for as long as it has members; the defaults always do. */
  #dropIfEmpty(channel) {
    if (channel.members.size > 0 || this.config.defaultChannels.includes(channel.name)) return;
    this.channels.delete(channel.name);
    if (channel.code) this.codes.delete(channel.code);
    this.store.deleteChannel(channel.id);
  }

  /** What a member sees of a channel: topic, modes, members, read position. */
  channelInfo(user, name) {
    return this.#channelState(this.#membership(user, name).channel, user);
  }

  /**
   * Joins a channel by name, creating it if the user may. A class with a
   * code wants that code, from everyone but teachers and invited people.
   */
  join(user, name, { code } = {}) {
    name = parseChannel(name);
    const channel = this.channels.get(name);
    if (channel?.members.has(user.key)) return { channel: this.#channelState(channel, user) };
    if (channel) {
      const coded = Boolean(channel.code) && code != null && this.#normalizeCode(code) === channel.code;
      if (channel.code && !coded && code != null) this.#take(user, 2); // a wrong guess costs more
      return this.#enter(user, channel, { coded });
    }
    if (this.config.school.onlyTeachersCreate && !user.teacher) {
      throw new ChatError('forbidden', 'Only teachers can open a class. Ask your teacher for the class code.');
    }
    this.#roomFor(user);
    this.#take(user, 2);
    const created = this.#createChannel(name, user);
    this.#addMember(created, user);
    return { channel: this.#channelState(created, user) };
  }

  /** Joins whichever class the code belongs to. */
  joinByCode(user, code) {
    this.#take(user, 2);
    const channel = this.#classByCode(code);
    if (channel.members.has(user.key)) return { channel: this.#channelState(channel, user) };
    return this.#enter(user, channel, { coded: true });
  }

  #roomFor(user) {
    if (user.channels.size >= this.config.maxChannelsPerUser) {
      throw new ChatError('too_many_channels', 'You are in too many channels. Leave one first.');
    }
  }

  /** The door of an existing channel: bans, the lock, then the code. */
  #enter(user, channel, { coded = false } = {}) {
    const { name } = channel;
    this.#roomFor(user);
    if (this.#isBanned(channel, user)) throw new ChatError('banned', `You are banned from ${name}.`);
    const invited = channel.invites.has(user);
    if (channel.modes.i && !invited) throw new ChatError('invite_only', `${name} is locked: nobody new can join right now.`);
    if (channel.code && !coded && !invited && !user.teacher) {
      throw new ChatError('bad_code', `${name} needs its class code.`);
    }
    this.#take(user);
    this.#addMember(channel, user);
    return { channel: this.#channelState(channel, user) };
  }

  // ----------------------------------------------------------------- school

  #normalizeCode(value) {
    return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  }

  #classByCode(value) {
    const channel = this.codes.get(this.#normalizeCode(value));
    if (!channel) throw new ChatError('bad_code', 'That class code is not in use. Check it with your teacher.');
    return channel;
  }

  #newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.codes.has(code)) return code;
    }
  }

  #setCode(channel, code) {
    if (channel.code) this.codes.delete(channel.code);
    channel.code = code;
    if (code) this.codes.set(code, channel);
    this.store.setChannelCode(channel.id, code);
  }

  #ops(channel) {
    return [...channel.members.values()].filter((member) => member.role === 'op' && member.user);
  }

  /**
   * Gives a class a fresh code (`new`) or none at all (`off`). The people
   * already in it stay; the old code stops working at once.
   */
  setCode(user, name, action = 'new') {
    const { channel } = this.#asOp(user, name);
    if (action !== 'new' && action !== 'off') throw new ChatError('bad_request', 'Use "new" or "off".');
    this.#take(user);
    const had = Boolean(channel.code);
    this.#setCode(channel, action === 'new' ? this.#newCode() : null);
    this.#codeChanged(channel, user, had);
    return { code: channel.code };
  }

  #codeChanged(channel, user, had) {
    if (had !== Boolean(channel.code)) {
      this.#toChannel(channel, {
        type: 'mode', channel: channel.name, by: user.nick,
        changes: [{ add: Boolean(channel.code), mode: 'k' }], modes: this.#modeString(channel),
      });
    }
    // The code itself is for the people who run the class.
    for (const op of this.#ops(channel)) this.#toUser(op.user, { type: 'code', channel: channel.name, code: channel.code });
  }

  #checkTeacherCode(value) {
    const { teacherCode } = this.config;
    if (!teacherCode) throw new ChatError('forbidden', 'Teacher accounts are set up by the school.');
    if (!timingSafeEqual(sha(value), sha(teacherCode))) {
      throw new ChatError('bad_teacher_code', 'That is not the staff code.');
    }
  }

  #makeTeacher(user) {
    this.store.setAccountRole(user.account.id, 'teacher');
    user.account.role = 'teacher';
    for (const channel of user.channels) channel.members.get(user.key).teacher = true;
  }

  /** Turns a registered student account into a teacher's, given the school's staff code. */
  becomeTeacher(user, code) {
    if (!user.registered) throw new ChatError('forbidden', 'Register your nick first: /register <password>.');
    if (user.teacher) return this.#self(user);
    this.#take(user, 3);
    // The staff code is the key to the school: a handful of guesses, then no more this session.
    if (user.staffCodeMisses >= 5) throw new ChatError('rate_limited', 'Too many wrong staff codes. Ask a colleague.');
    try {
      this.#checkTeacherCode(code);
    } catch (err) {
      if (err.code === 'bad_teacher_code') user.staffCodeMisses = (user.staffCodeMisses ?? 0) + 1;
      throw err;
    }
    this.#makeTeacher(user);
    this.#toUser(user, this.#presence(user, 'role'));
    return this.#self(user);
  }

  /** Puts a hand up or down. Operators may lower anyone's. */
  hand(user, name, { up = true, nick = null } = {}) {
    const { channel, member } = this.#membership(user, name);
    const target = nick == null || nickKey(String(nick)) === user.key ? member : this.#target(channel, nick);
    if (target !== member && (member.role !== 'op' || up)) {
      throw new ChatError('not_op', 'You can only raise or lower your own hand.');
    }
    up = Boolean(up);
    if (channel.hands.has(target.key) === up) return { up };
    this.#take(user);
    this.#setHand(channel, target, up);
    return { up };
  }

  #setHand(channel, member, up) {
    if (up) channel.hands.set(member.key, this.now());
    else if (!channel.hands.delete(member.key)) return;
    this.#toChannel(channel, { type: 'hand', channel: channel.name, nick: member.nick, up });
  }

  #voter(user) {
    return user.registered ? `a${user.account.id}` : `g${user.key}`;
  }

  /** A poll as one person may see it: no tally before they vote, no answer before it closes. */
  #pollView(poll, user, isOp) {
    const mine = poll.votes.get(this.#voter(user)) ?? null;
    const closed = poll.closedAt != null;
    const tally = closed || isOp || (poll.kind === 'poll' && mine != null);
    let counts = null;
    if (tally) {
      counts = poll.options.map(() => 0);
      for (const choice of poll.votes.values()) counts[choice] += 1;
    }
    return {
      kind: poll.kind, options: poll.options, total: poll.votes.size, closed, mine, counts,
      correct: closed || isOp ? poll.correct : null,
    };
  }

  /** Adds each poll, as `user` may see it, to the messages that carry one. */
  #withPolls(messages, user, channel) {
    const ids = messages.filter((msg) => msg.kind === 'poll' && !msg.deleted).map((msg) => msg.id);
    if (!ids.length) return messages;
    const polls = this.store.polls(ids);
    const isOp = channel.members.get(user.key)?.role === 'op';
    for (const msg of messages) {
      const poll = polls.get(msg.id);
      if (poll && !msg.deleted) msg.poll = this.#pollView(poll, user, isOp);
    }
    return messages;
  }

  /** Sends a channel message to everyone in it; a poll goes out once per person, as they may see it. */
  #announce(channel, type, msg, meta) {
    if (msg.kind !== 'poll' || msg.deleted) return this.#toChannel(channel, { type, target: channel.name, msg }, meta);
    const poll = this.store.polls([msg.id]).get(msg.id);
    for (const member of channel.members.values()) {
      if (!member.user) continue;
      const view = { ...msg, poll: poll && this.#pollView(poll, member.user, member.role === 'op') };
      this.#toUser(member.user, { type, target: channel.name, msg: view }, meta);
    }
  }

  /**
   * Asks the class something. With `correct` (the index of the right option)
   * it is a quiz: nobody sees the tally or the answer until it is closed.
   */
  createPoll(user, name, { question, options, correct = null, origin = null } = {}) {
    const { channel } = this.#asOp(user, name);
    question = parseLine(question, 300, 'A question');
    if (!question) throw new ChatError('bad_request', 'A poll needs a question.');
    if (!Array.isArray(options)) throw new ChatError('bad_request', 'A poll needs options.');
    options = options.map((option) => parseLine(option, 120, 'An option')).filter(Boolean);
    if (options.length < 2 || options.length > POLL_MAX_OPTIONS) {
      throw new ChatError('bad_request', `A poll has 2 to ${POLL_MAX_OPTIONS} options.`);
    }
    if (correct != null && (!Number.isInteger(correct) || correct < 0 || correct >= options.length)) {
      throw new ChatError('bad_request', 'The right answer must be one of the options.');
    }
    this.#take(user, 2);
    const msg = this.store.addMessage({
      channelId: channel.id, nick: user.nick, accountId: user.account?.id ?? null, kind: 'poll', text: question, now: this.now(),
    });
    this.store.createPoll({ messageId: msg.id, kind: correct == null ? 'poll' : 'quiz', options, correct });
    if (!user.registered) this.#remember(user, msg.id);
    this.#announce(channel, 'message', msg, { origin });
    return { id: msg.id };
  }

  #poll(user, id) {
    const location = this.#locate(user, id);
    const poll = location.channel ? this.store.polls([id]).get(id) : null;
    if (!poll) throw new ChatError('not_found', 'That is not a poll.');
    return { ...location, poll };
  }

  /** One vote each; it can be changed until the poll closes. */
  vote(user, id, choice) {
    const { channel, poll } = this.#poll(user, id);
    if (poll.closedAt != null) throw new ChatError('forbidden', 'This poll is closed.');
    if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) {
      throw new ChatError('bad_request', 'Pick one of the options.');
    }
    this.#take(user);
    this.store.setVote(id, this.#voter(user), choice);
    this.#announce(channel, 'message_update', this.store.message(id));
  }

  closePoll(user, id) {
    const { channel, member, poll } = this.#poll(user, id);
    if (member.role !== 'op') throw new ChatError('not_op', 'Only the teacher can close a poll.');
    if (poll.closedAt != null) return;
    this.store.closePoll(id, this.now());
    this.#announce(channel, 'message_update', this.store.message(id));
  }

  #brief(msg) {
    return msg && !msg.deleted ? { id: msg.id, nick: msg.nick, kind: msg.kind, text: msg.text.slice(0, 300), ts: msg.ts } : null;
  }

  #pinned(channel) {
    return channel.pinnedId == null ? null : this.#brief(this.store.message(channel.pinnedId));
  }

  /** Keeps one message at the top of the class: the assignment, the rule of the day. Null unpins. */
  pin(user, name, id) {
    const { channel } = this.#asOp(user, name);
    if (id != null) {
      const row = this.store.messageRow(id);
      if (!row || row.deleted || row.channelId !== channel.id) throw new ChatError('not_found', 'That message no longer exists.');
    }
    this.#setPinned(channel, id ?? null, user.nick);
  }

  #setPinned(channel, id, by) {
    if (channel.pinnedId === id) return;
    channel.pinnedId = id;
    this.store.setPinned(channel.id, id);
    this.#toChannel(channel, { type: 'pin', channel: channel.name, pinned: this.#pinned(channel), by });
  }

  #reports(channel) {
    return this.store.openReports(channel.id)
      .map((report) => ({ id: report.id, by: report.by, at: report.at, msg: this.#brief(this.store.message(report.messageId)) }))
      .filter((report) => report.msg);
  }

  #reportsChanged(channel) {
    const reports = this.#reports(channel);
    for (const op of this.#ops(channel)) this.#toUser(op.user, { type: 'reports', channel: channel.name, reports });
  }

  /** Tells the people who run the class about a message. They see who reported; the class does not. */
  report(user, id) {
    const { row, channel } = this.#locate(user, id);
    if (!channel) throw new ChatError('bad_request', 'Only messages in a class can be reported.');
    if (this.#isAuthor(user, row)) throw new ChatError('bad_request', 'That is your own message.');
    this.#take(user, 2);
    if (this.store.addReport(channel.id, id, user.nick, this.now()) != null) this.#reportsChanged(channel);
  }

  resolveReport(user, reportId) {
    const report = this.store.report(reportId);
    const channel = report && [...user.channels].find((item) => item.id === report.channelId);
    if (!channel || channel.members.get(user.key)?.role !== 'op') {
      throw new ChatError('not_found', 'That report no longer exists.');
    }
    this.store.resolveReport(reportId);
    this.#reportsChanged(channel);
  }

  /** Everyone in the class and how much they have said, most first. */
  participation(user, name) {
    const { channel } = this.#asOp(user, name);
    const spoke = this.store.participation(channel.id);
    const seen = new Set(spoke.map((row) => nickKey(row.nick)));
    const quiet = [...channel.members.values()]
      .filter((member) => !seen.has(member.key))
      .map((member) => ({ nick: member.nick, messages: 0, lastAt: null }));
    return { people: [...spoke, ...quiet] };
  }

  /** The class's conversation as lines of text, for the record. */
  transcript(user, name) {
    const { channel } = this.#asOp(user, name);
    return { name: channel.name, topic: channel.topic, lines: this.store.transcript(channel.id, TRANSCRIPT_LINES) };
  }

  part(user, name, reason = '') {
    const { channel, member } = this.#membership(user, name);
    this.#take(user);
    const event = {
      type: 'part', channel: channel.name, nick: user.nick, reason: parseLine(String(reason ?? ''), 200, 'A reason'),
    };
    this.#removeMember(channel, member);
    this.#toChannel(channel, event);
    this.#toUser(user, event);
    this.#dropIfEmpty(channel);
  }

  kick(user, name, nick, reason = '') {
    const { channel } = this.#asOp(user, name);
    const target = this.#target(channel, nick);
    this.#protectFounder(channel, user, target);
    const event = {
      type: 'kick', channel: channel.name, nick: target.nick, by: user.nick, online: target.user !== null,
      reason: parseLine(String(reason ?? ''), 200, 'A reason'),
    };
    this.#toChannel(channel, event);
    this.#removeMember(channel, target);
    this.#dropIfEmpty(channel);
  }

  setTopic(user, name, topic) {
    const { channel, member } = this.#membership(user, name);
    if (channel.modes.t && member.role !== 'op') {
      throw new ChatError('not_op', `Only operators can change the topic of ${channel.name}.`);
    }
    channel.topic = parseLine(topic, this.config.maxTopicLength, 'A topic');
    channel.topicBy = user.nick;
    channel.topicAt = this.now();
    this.store.updateTopic(channel.id, channel.topic, channel.topicBy, channel.topicAt);
    this.#toChannel(channel, {
      type: 'topic', channel: channel.name, topic: channel.topic, by: user.nick, at: channel.topicAt,
    });
  }

  /**
   * Applies IRC-style mode changes. Flags: `t` only operators set the topic,
   * `m` only operators and voiced members may speak, `i` invite-only.
   * With a nick: `o` operator, `v` voice, `b` ban.
   * @param {Array<{add: boolean, mode: string, arg?: string}>} changes
   */
  setMode(user, name, changes) {
    const { channel } = this.#asOp(user, name);
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 8) {
      throw new ChatError('bad_request', 'Give between one and eight mode changes.');
    }
    const applied = [];
    try {
      this.#applyModes(channel, user, changes, applied);
    } finally {
      // Changes made before a bad one in the same request still stand.
      if (applied.length) {
        this.store.updateModes(channel.id, this.#modeString(channel));
        this.#toChannel(channel, {
          type: 'mode', channel: channel.name, by: user.nick, changes: applied, modes: this.#modeString(channel),
        });
      }
    }
    return { changes: applied, modes: this.#modeString(channel) };
  }

  #applyModes(channel, user, changes, applied) {
    for (const { add, mode, arg } of changes) {
      if (FLAG_MODES.includes(mode)) {
        if (channel.modes[mode] === Boolean(add)) continue;
        channel.modes[mode] = Boolean(add);
        if (mode === 'i' && !add) channel.invites = new WeakSet();
        applied.push({ add: Boolean(add), mode });
      } else if (mode === 'o' || mode === 'v') {
        const target = this.#target(channel, arg);
        // Taking a status away only touches that status: -o leaves a voiced member voiced.
        const has = mode === 'o' ? 'op' : 'voice';
        const role = add ? (mode === 'o' ? 'op' : target.role ?? 'voice') : target.role === has ? null : target.role;
        if (role === target.role) continue;
        if (mode === 'o' && !add) this.#protectFounder(channel, user, target);
        target.role = role;
        if (target.accountId != null) this.store.setRole(channel.id, target.accountId, role);
        if (add) this.#setHand(channel, target, false); // given the floor: the hand comes down
        applied.push({ add: Boolean(add), mode, arg: target.nick, role, online: target.user !== null });
      } else if (mode === 'k') {
        // The code is always generated, so every class has a different one.
        if (Boolean(channel.code) === Boolean(add)) continue;
        this.#setCode(channel, add ? this.#newCode() : null);
        for (const op of this.#ops(channel)) this.#toUser(op.user, { type: 'code', channel: channel.name, code: channel.code });
        applied.push({ add: Boolean(add), mode });
      } else if (mode === 'b') {
        const banned = parseNick(arg);
        const key = nickKey(banned);
        if (add) {
          const target = channel.members.get(key);
          if (target) this.#protectFounder(channel, user, target);
          if (channel.bans.has(key)) continue;
          // A registered nick is banned as an account, so renaming does not lift it.
          const accountId = target?.accountId ?? this.store.accountByKey(key)?.id ?? null;
          channel.bans.set(key, accountId);
          this.store.addBan(channel.id, key, accountId, user.nick, this.now());
        } else {
          if (!channel.bans.delete(key)) continue;
          this.store.removeBan(channel.id, key);
        }
        applied.push({ add: Boolean(add), mode, arg: banned });
      } else {
        throw new ChatError('bad_request', `Unknown mode "${mode}".`);
      }
    }
  }

  bans(user, name) {
    const { channel } = this.#membership(user, name);
    return { bans: this.store.listBans(channel.id) };
  }

  invite(user, name, nick) {
    const { channel, member } = this.#membership(user, name);
    if (channel.modes.i && member.role !== 'op') {
      throw new ChatError('not_op', `Only operators can invite people to ${channel.name}.`);
    }
    const target = this.users.get(nickKey(String(nick ?? '')));
    if (!target) throw new ChatError('no_such_nick', `${nick} is not online.`);
    if (channel.members.has(target.key)) {
      throw new ChatError('bad_request', `${target.nick} is already in ${channel.name}.`);
    }
    this.#take(user);
    channel.invites.add(target);
    this.#toUser(target, { type: 'invite', channel: channel.name, by: user.nick });
  }

  /** Every channel; in a school, a student only gets to see the classes they are in. */
  list(user) {
    const own = this.config.school.privateList && user && !user.teacher;
    const channels = [...(own ? user.channels : this.channels.values())].map((channel) => {
      let online = 0;
      for (const member of channel.members.values()) if (member.user) online += 1;
      return {
        name: channel.name, topic: channel.topic, members: channel.members.size, online,
        modes: this.#modeString(channel),
      };
    });
    channels.sort((a, b) => b.online - a.online || b.members - a.members || a.name.localeCompare(b.name));
    return { channels };
  }

  // ---------------------------------------------------------------- messages

  #take(user, cost = 1) {
    if (!user.bucket.take(cost)) {
      throw new ChatError('rate_limited', 'You are doing that too fast. Wait a moment.');
    }
  }

  /** Who a nick refers to: someone online, a registered account, or both. */
  #lookup(nick) {
    const key = nickKey(parseNick(nick));
    const user = this.users.get(key) ?? null;
    const account = user?.account ?? this.store.accountByKey(key);
    if (!user && !account) throw new ChatError('no_such_nick', `There is nobody called ${nick}.`);
    const teacher = user?.teacher ?? (account.role === 'teacher' || this.config.teachers.includes(key));
    return { user, accountId: account?.id ?? null, nick: user?.nick ?? account.nick, key, teacher };
  }

  /**
   * @param {string} target a channel name or a nick
   * @param {object} [options]
   * @param {'msg'|'action'|'notice'} [options.kind]
   * @param {number} [options.replyTo] id of the message being answered
   * @param {string} [options.origin] id of the sending connection
   */
  send(user, target, text, { kind = 'msg', replyTo = null, origin = null } = {}) {
    if (!MESSAGE_KINDS.has(kind)) throw new ChatError('bad_request', 'Unknown kind of message.');
    text = parseText(text, this.config.maxMessageLength);
    const now = this.now();
    const base = { nick: user.nick, accountId: user.account?.id ?? null, kind, text, now };

    if (isChannelName(target)) {
      const { channel, member } = this.#membership(user, target);
      this.#maySpeak(channel, user, member);
      if (replyTo != null && this.store.messageRow(replyTo)?.channelId !== channel.id) {
        throw new ChatError('not_found', 'The message you are replying to is gone.');
      }
      this.#take(user);
      user.lastActive = now;
      const msg = this.store.addMessage({ ...base, channelId: channel.id, replyTo });
      if (!user.registered) this.#remember(user, msg.id);
      this.#toChannel(channel, { type: 'message', target: channel.name, msg }, { origin });
      return { id: msg.id };
    }

    const peer = this.#lookup(target);
    if (peer.key === user.key) throw new ChatError('bad_request', 'You cannot message yourself.');
    if (!this.config.school.studentDms && !user.teacher && !peer.teacher) {
      throw new ChatError('forbidden', 'Private messages are for talking to a teacher. Use the class to talk to each other.');
    }
    // A conversation is only kept when both ends are accounts. A guest nick
    // can be taken by someone else tomorrow, and must not inherit the history.
    const kept = user.registered && peer.accountId != null;
    if (!kept && !peer.user) {
      throw new ChatError('no_such_nick', `${peer.nick} is offline. Register your nick to leave a message.`);
    }
    let msg;
    if (kept) {
      const [dmA, dmB] = [user.account.id, peer.accountId].sort((a, b) => a - b);
      if (replyTo != null) {
        const row = this.store.messageRow(replyTo);
        if (row?.dmA !== dmA || row?.dmB !== dmB) {
          throw new ChatError('not_found', 'The message you are replying to is gone.');
        }
      }
      this.#take(user);
      msg = this.store.addMessage({ ...base, dmA, dmB, replyTo });
    } else {
      this.#take(user);
      msg = {
        id: `e${++this.ephemeralSeq}`, nick: user.nick, registered: user.registered, kind, text, ts: now,
        editedAt: null, deleted: false, replyTo: null, reactions: [], ephemeral: true,
      };
    }
    user.lastActive = now;
    this.#toUser(user, { type: 'message', target: peer.nick, msg }, { origin });
    if (peer.user) this.#toUser(peer.user, { type: 'message', target: user.nick, msg }, { origin });
    return { id: msg.id, away: peer.user?.away ?? null, offline: !peer.user };
  }

  #maySpeak(channel, user, member) {
    if (this.#isBanned(channel, user)) throw new ChatError('banned', `You are banned from ${channel.name}.`);
    if (channel.modes.m && !member.role) {
      throw new ChatError('moderated', `${channel.name} is moderated: only operators and voiced members can speak.`);
    }
  }

  #remember(user, id) {
    user.sentIds.add(id);
    if (user.sentIds.size > 500) user.sentIds.delete(user.sentIds.values().next().value);
  }

  /** Where a stored message lives, if the user is allowed to see it. */
  #locate(user, id) {
    const row = this.store.messageRow(id);
    const gone = new ChatError('not_found', 'That message no longer exists.');
    if (!row || row.deleted) throw gone;
    if (row.channelId != null) {
      const channel = [...user.channels].find((item) => item.id === row.channelId);
      if (!channel) throw gone;
      return { row, channel, member: channel.members.get(user.key) };
    }
    if (!user.registered || (row.dmA !== user.account.id && row.dmB !== user.account.id)) throw gone;
    return { row, dm: [row.dmA, row.dmB] };
  }

  #isAuthor(user, row) {
    return user.registered ? row.accountId === user.account.id : row.accountId == null && user.sentIds.has(row.id);
  }

  #announceUpdate(location) {
    const msg = this.store.message(location.row.id);
    if (location.channel) return this.#announce(location.channel, 'message_update', msg);
    const [a, b] = location.dm.map((id) => ({ user: this.byAccount.get(id), nick: this.store.accountById(id)?.nick }));
    if (a.user) this.#toUser(a.user, { type: 'message_update', target: b.nick, msg });
    if (b.user) this.#toUser(b.user, { type: 'message_update', target: a.nick, msg });
  }

  edit(user, id, text) {
    const location = this.#locate(user, id);
    if (!this.#isAuthor(user, location.row)) {
      throw new ChatError('forbidden', 'You can only edit your own messages.');
    }
    if (location.row.kind === 'poll') throw new ChatError('forbidden', 'A poll cannot be edited. Close it and ask again.');
    // Rewriting an old message is speaking: the same rules apply.
    if (location.channel) this.#maySpeak(location.channel, user, location.member);
    text = parseText(text, this.config.maxMessageLength);
    this.#take(user);
    this.store.editMessage(id, text, this.now());
    this.#announceUpdate(location);
  }

  /** Authors delete their own messages; operators delete anything in their channel. */
  remove(user, id) {
    const location = this.#locate(user, id);
    if (!this.#isAuthor(user, location.row) && location.member?.role !== 'op') {
      throw new ChatError('forbidden', 'You can only delete your own messages.');
    }
    this.store.deleteMessage(id);
    this.#announceUpdate(location);
    const { channel } = location;
    if (!channel) return;
    // What pointed at the message goes with it.
    if (channel.pinnedId === id) this.#setPinned(channel, null, user.nick);
    if (this.store.resolveReportsFor(id) > 0) this.#reportsChanged(channel);
  }

  /** Adds the reaction, or takes it back if the user already gave it. */
  react(user, id, emoji) {
    emoji = parseEmoji(emoji);
    const location = this.#locate(user, id);
    this.#take(user);
    const added = this.store.toggleReaction(id, emoji, user.nick, this.now());
    if (added && this.store.reactionKinds(id) > this.config.maxReactionsPerMessage) {
      this.store.toggleReaction(id, emoji, user.nick, this.now());
      throw new ChatError('bad_request', 'That message has enough different reactions.');
    }
    this.#announceUpdate(location);
  }

  history(user, target, { before = null, limit } = {}) {
    const size = this.config.historyPageSize;
    limit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), size * 2) : size;
    if (before != null && !Number.isInteger(before)) before = null;
    if (isChannelName(target)) {
      const { channel } = this.#membership(user, target);
      const page = this.store.channelHistory(channel.id, { before, limit });
      this.#withPolls(page.messages, user, channel);
      return page;
    }
    const peer = this.#lookup(target);
    if (!user.registered || peer.accountId == null) return { messages: [], hasMore: false };
    return this.store.dmHistory(user.account.id, peer.accountId, { before, limit });
  }

  /** Remembers how far a registered user has read, across their devices. */
  markRead(user, target, id, { origin = null } = {}) {
    if (!user.registered || !Number.isInteger(id)) return;
    let name;
    if (isChannelName(target)) {
      const { channel } = this.#membership(user, target);
      this.store.setLastRead(channel.id, user.account.id, id);
      name = channel.name;
    } else {
      const peer = this.#lookup(target);
      if (peer.accountId == null) return;
      this.store.setDmRead(user.account.id, peer.accountId, id);
      name = peer.nick;
    }
    this.#toUser(user, { type: 'read', target: name, lastRead: id }, { origin });
  }

  typing(user, target) {
    if (!user.bucket.take(0.2)) return;
    const event = { type: 'typing', nick: user.nick };
    if (isChannelName(target)) {
      const { channel } = this.#membership(user, target);
      for (const member of channel.members.values()) {
        if (member.user && member.user !== user) this.#toUser(member.user, { ...event, target: channel.name });
      }
    } else {
      const peer = this.users.get(nickKey(String(target ?? '')));
      if (peer && peer !== user) this.#toUser(peer, { ...event, target: user.nick });
    }
  }

  search(user, query) {
    query = parseLine(query, 100, 'A search').trim();
    if (query.length < 2) throw new ChatError('bad_request', 'Search for at least two characters.');
    this.#take(user);
    const channels = new Map([...user.channels].map((channel) => [channel.id, channel.name]));
    const results = this.store.search({
      query,
      channelIds: [...channels.keys()],
      accountId: user.account?.id ?? null,
      limit: 50,
    });
    return {
      results: results.map(({ channelId, peerId, message }) => ({
        target: channelId != null ? channels.get(channelId) : this.store.accountById(peerId)?.nick,
        msg: message,
      })),
    };
  }

  // ------------------------------------------------------------------ people

  changeNick(user, nick) {
    nick = parseNick(nick);
    const key = nickKey(nick);
    if (nick === user.nick) return this.#self(user);
    if (key !== user.key) {
      if (this.users.has(key)) throw new ChatError('nick_in_use', `The nick ${nick} is in use.`);
      if (this.store.accountByKey(key)) throw new ChatError('nick_registered', `The nick ${nick} is registered.`);
    }
    for (const channel of user.channels) {
      if (this.#isBanned(channel, user)) {
        throw new ChatError('banned', `You cannot change your nick while banned from ${channel.name}.`);
      }
    }
    this.#take(user, 3);
    const event = { type: 'nick', old: user.nick, nick };
    const peers = this.#peersOf(user);
    for (const channel of user.channels) {
      const member = channel.members.get(user.key);
      channel.members.delete(user.key);
      member.nick = nick;
      member.key = key;
      channel.members.set(key, member);
      // A raised hand keeps its place in the queue under the new name.
      if (channel.hands.has(user.key)) {
        channel.hands = new Map([...channel.hands].map(([hand, at]) => [hand === user.key ? key : hand, at]));
      }
    }
    this.users.delete(user.key);
    user.nick = nick;
    user.key = key;
    this.users.set(key, user);
    if (user.registered) this.store.renameAccount(user.account.id, nick);
    for (const peer of peers) this.#toUser(peer, event);
    this.#toUser(user, event);
    return this.#self(user);
  }

  /** Turns the guest's current nick into an account. */
  async register(user, password, conn) {
    if (user.registered) throw new ChatError('bad_request', `${user.nick} is already registered.`);
    this.#take(user, 3);
    const hash = await hashPassword(parsePassword(password));
    if (user.registered || this.users.get(user.key) !== user) {
      throw new ChatError('bad_request', 'Registration was interrupted. Try again.');
    }
    if (this.store.accountByKey(user.key)) {
      throw new ChatError('nick_registered', `The nick ${user.nick} is already registered.`);
    }
    const account = this.store.createAccount(user.nick, hash, this.now());
    user.account = { id: account.id, createdAt: account.createdAt, role: null };
    this.byAccount.set(account.id, user);
    for (const channel of user.channels) {
      const member = channel.members.get(user.key);
      member.accountId = account.id;
      this.store.addMembership(channel.id, account.id, member.role, this.now());
    }
    // Guest tokens die with the guest; every connection gets a durable one.
    for (const [token, owner] of this.guestTokens) {
      if (owner === user) this.guestTokens.delete(token);
    }
    for (const other of user.conns) {
      if (!other.token) continue; // an IRC connection has no use for one
      other.token = this.#issueToken(user);
      if (other === conn) continue;
      try {
        other.deliver({ type: 'self', self: this.#self(user), token: other.token });
      } catch {
        // See #toUser.
      }
    }
    this.#presence(user, 'registered');
    return { self: this.#self(user), token: conn?.token ?? null };
  }

  setAway(user, message) {
    this.#take(user);
    user.away = message ? parseLine(String(message), 200, 'An away message') || null : null;
    this.#toUser(user, this.#presence(user, 'away'));
    return this.#self(user);
  }

  whois(user, nick) {
    const found = this.#lookup(nick);
    const account = found.accountId != null ? this.store.accountById(found.accountId) : null;
    const channels = [];
    for (const channel of this.channels.values()) {
      const member = channel.members.get(found.key);
      if (!member || (channel.modes.i && !channel.members.has(user.key))) continue;
      channels.push({ name: channel.name, role: member.role });
    }
    return {
      nick: found.nick,
      registered: Boolean(account),
      teacher: found.teacher,
      registeredAt: account?.createdAt ?? null,
      online: Boolean(found.user),
      away: found.user?.away ?? null,
      connectedAt: found.user?.connectedAt ?? null,
      lastActive: found.user?.lastActive ?? null,
      lastSeen: found.user ? null : account?.lastSeen ?? null,
      channels,
    };
  }

  /** The channels two people are both in, with the other's role in each. */
  sharedChannels(user, nick) {
    const key = nickKey(nick);
    const shared = [];
    for (const channel of user.channels) {
      const member = channel.members.get(key);
      if (member) shared.push({ name: channel.name, role: member.role });
    }
    return shared;
  }

  stats() {
    return { users: this.users.size, channels: this.channels.size };
  }
}
