import { createHash, randomBytes } from 'node:crypto';
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
};

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
    /** @type {{id: number, createdAt: number}|null} null for guests */
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
    this.config = { ...DEFAULTS, ...config };
    /** @type {Map<string, User>} online users by lowercased nick */
    this.users = new Map();
    /** @type {Map<number, User>} online registered users by account id */
    this.byAccount = new Map();
    /** @type {Map<string, object>} every channel by name */
    this.channels = new Map();
    /** @type {Map<string, User>} resume tokens of guests */
    this.guestTokens = new Map();
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
    }
    for (const row of this.store.loadMemberships()) {
      const key = nickKey(row.nick);
      byId.get(row.channelId)?.members.set(key, {
        nick: row.nick, key, accountId: row.accountId, role: row.role, user: null,
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
      /** @type {Map<string, {nick, key, accountId, role, user}>} online guests, and registered members online or not */
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

  /** @param {'online'|'offline'|'away'|'registered'} change what is new about the user */
  #presence(user, change, extra = {}) {
    const event = {
      type: 'presence', change, nick: user.nick, online: change !== 'offline', away: user.away,
      registered: user.registered, ...extra,
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
  async login(conn, { nick, password, token, register = false, session = true } = {}) {
    if (conn.user) throw new ChatError('bad_request', 'This connection is already signed in.');
    let user = token ? this.#resume(token) : null;
    if (!user) {
      if (token && !nick) throw new ChatError('bad_token', 'Your session has expired. Sign in again.');
      user = await this.#authenticate({ nick, password, register });
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
    return this.snapshot(user, token);
  }

  // Password hashing is the only asynchronous step, so it always comes first:
  // everything that looks at shared state runs after it, in one go, and two
  // simultaneous logins cannot both win the same nick.
  async #authenticate({ nick, password, register }) {
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
    const user = new User(nick, account && { id: account.id, createdAt: account.createdAt }, this);
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
      for (const channel of user.channels) channel.members.get(user.key).user = null;
      user.channels.clear();
      return;
    }

    for (const [token, owner] of this.guestTokens) {
      if (owner === user) this.guestTokens.delete(token);
    }
    const peers = this.#peersOf(user);
    const channels = [...user.channels];
    for (const channel of channels) channel.members.delete(user.key);
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
      server: { name: this.config.serverName, motd: this.config.motd },
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
    return { nick: user.nick, registered: user.registered, away: user.away };
  }

  // ---------------------------------------------------------------- channels

  #member(member) {
    return {
      nick: member.nick,
      role: member.role,
      registered: member.accountId != null,
      online: member.user !== null,
      away: member.user?.away ?? null,
    };
  }

  #modeString(channel) {
    return FLAG_MODES.filter((flag) => channel.modes[flag]).join('');
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
    member.user?.channels.delete(channel);
    if (member.accountId != null) this.store.removeMembership(channel.id, member.accountId);
  }

  /** A channel exists for as long as it has members; the defaults always do. */
  #dropIfEmpty(channel) {
    if (channel.members.size > 0 || this.config.defaultChannels.includes(channel.name)) return;
    this.channels.delete(channel.name);
    this.store.deleteChannel(channel.id);
  }

  /** What a member sees of a channel: topic, modes, members, read position. */
  channelInfo(user, name) {
    return this.#channelState(this.#membership(user, name).channel, user);
  }

  join(user, name) {
    name = parseChannel(name);
    let channel = this.channels.get(name);
    if (channel?.members.has(user.key)) return { channel: this.#channelState(channel, user) };
    if (user.channels.size >= this.config.maxChannelsPerUser) {
      throw new ChatError('too_many_channels', 'You are in too many channels. Leave one first.');
    }
    if (channel) {
      if (this.#isBanned(channel, user)) throw new ChatError('banned', `You are banned from ${name}.`);
      if (channel.modes.i && !channel.invites.has(user)) {
        throw new ChatError('invite_only', `${name} is invite-only.`);
      }
      this.#take(user);
    } else {
      this.#take(user, 2);
      channel = this.#createChannel(name, user);
    }
    this.#addMember(channel, user);
    return { channel: this.#channelState(channel, user) };
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
        applied.push({ add: Boolean(add), mode, arg: target.nick, role, online: target.user !== null });
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

  list() {
    const channels = [...this.channels.values()].map((channel) => {
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
    return { user, accountId: account?.id ?? null, nick: user?.nick ?? account.nick, key };
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
    if (location.channel) {
      this.#toChannel(location.channel, { type: 'message_update', target: location.channel.name, msg });
      return;
    }
    const [a, b] = location.dm.map((id) => ({ user: this.byAccount.get(id), nick: this.store.accountById(id)?.nick }));
    if (a.user) this.#toUser(a.user, { type: 'message_update', target: b.nick, msg });
    if (b.user) this.#toUser(b.user, { type: 'message_update', target: a.nick, msg });
  }

  edit(user, id, text) {
    const location = this.#locate(user, id);
    if (!this.#isAuthor(user, location.row)) {
      throw new ChatError('forbidden', 'You can only edit your own messages.');
    }
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
      return this.store.channelHistory(channel.id, { before, limit });
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
    user.account = { id: account.id, createdAt: account.createdAt };
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
