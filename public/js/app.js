import { mentions } from './format.js';
import { Connection } from './net.js';

const STATUS = '*';
const TYPING_SHOWN_MS = 5000;
const keyOf = (name) => name.toLowerCase();
const isChannel = (name) => name.startsWith('#');

const stored = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(`swarm.${key}`);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`swarm.${key}`);
      else localStorage.setItem(`swarm.${key}`, JSON.stringify(value));
    } catch {
      // Private browsing: the session simply does not survive a reload.
    }
  },
};

const listeners = new Map();
let conn = null;
let localSeq = 0;
let retryTimer = null;
let retries = 0;

/**
 * The client's state and everything that changes it. The UI modules listen
 * with `app.on(...)` and redraw; they never touch the connection themselves.
 *
 * A "buffer" is one conversation: a channel, a direct message, or the
 * status window that shows what the server has to say.
 */
export const app = {
  /** 'login' | 'connecting' | 'online' | 'reconnecting' */
  phase: 'login',
  self: null,
  server: { name: 'Swarm', motd: '' },
  info: { ircPort: null },
  /** @type {Map<string, object>} */
  buffers: new Map(),
  activeKey: STATUS,
  settings: { notify: false, showJoins: true, ...stored.get('settings', {}) },
  theme: stored.get('theme'),
  stored,

  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
  },
  emit(name, detail) {
    for (const fn of listeners.get(name) ?? []) fn(detail);
  },

  get active() {
    return this.buffers.get(this.activeKey) ?? this.buffers.get(STATUS);
  },
  isSelf(nick) {
    return this.self != null && keyOf(nick) === keyOf(this.self.nick);
  },
  /** Channels first, then conversations; the status window is separate. */
  list(type) {
    return [...this.buffers.values()]
      .filter((buffer) => buffer.type === type)
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  // ------------------------------------------------------------ connecting

  /** @param {{nick?: string, password?: string, register?: boolean, token?: string}} credentials */
  async connect(credentials) {
    clearTimeout(retryTimer);
    conn?.close();
    conn = new Connection({ onEvent: (event) => this.handle(event), onClose: () => this.lostConnection() });
    const resuming = this.phase === 'reconnecting';
    if (!resuming) this.setPhase('connecting');
    try {
      await conn.open();
      const snapshot = await conn.request('hello', credentials);
      retries = 0;
      this.applySnapshot(snapshot, resuming);
    } catch (err) {
      conn?.close();
      conn = null;
      throw err;
    }
  },

  /** Picks up a stored session, if there is one. */
  async resume() {
    const token = stored.get('token');
    if (!token) return false;
    try {
      await this.connect({ token });
      return true;
    } catch (err) {
      if (err.code === 'bad_token') stored.set('token', null);
      this.setPhase('login');
      return false;
    }
  },

  lostConnection() {
    conn = null;
    if (this.phase !== 'online' && this.phase !== 'reconnecting') return;
    this.setPhase('reconnecting');
    const delay = Math.min(15000, 500 * 2 ** retries) * (0.75 + Math.random() / 2);
    retries += 1;
    retryTimer = setTimeout(async () => {
      try {
        await this.connect({ token: stored.get('token') });
      } catch (err) {
        if (err.code === 'bad_token') return this.signedOut('Your session has expired. Sign in again.');
        this.lostConnection();
      }
    }, delay);
  },

  async signOut() {
    try {
      await conn?.request('logout');
    } catch {
      // Offline already: forgetting the token locally is all that is left to do.
    }
    this.signedOut();
  },

  signedOut(message = '') {
    clearTimeout(retryTimer);
    conn?.close();
    conn = null;
    stored.set('token', null);
    this.buffers.clear();
    this.self = null;
    this.setPhase('login', message);
  },

  setPhase(phase, message = '') {
    this.phase = phase;
    this.emit('phase', { phase, message });
  },

  applySnapshot(snapshot, resuming) {
    this.self = snapshot.self;
    this.server = snapshot.server;
    stored.set('token', snapshot.token);
    stored.set('nick', snapshot.self.nick);

    const previous = this.buffers;
    this.buffers = new Map();
    const status = previous.get(STATUS) ?? this.makeBuffer(STATUS, 'status', snapshot.server.name);
    status.name = snapshot.server.name;
    this.buffers.set(STATUS, status);
    if (!resuming) {
      if (snapshot.server.motd) this.note(status, 'info', snapshot.server.motd);
      this.note(
        status,
        'info',
        snapshot.self.registered
          ? `You are signed in as ${snapshot.self.nick}.`
          : `You are a guest. Type /register <password> to keep the nick ${snapshot.self.nick}.`,
      );
    }
    for (const state of snapshot.channels) this.addChannel(state, previous.get(keyOf(state.name)));
    for (const dm of snapshot.dms) {
      const buffer = previous.get(keyOf(dm.nick)) ?? this.makeBuffer(keyOf(dm.nick), 'dm', dm.nick);
      Object.assign(buffer, { unread: dm.unread, mentions: dm.unread, lastRead: dm.lastRead, peer: dm });
      this.buffers.set(buffer.key, buffer);
    }
    // Conversations with guests exist only on this side; keep them open.
    for (const buffer of previous.values()) {
      if (buffer.type === 'dm' && !this.buffers.has(buffer.key)) this.buffers.set(buffer.key, buffer);
    }
    // Whatever was on screen may have moved on while we were away.
    for (const buffer of this.buffers.values()) {
      if (buffer.type !== 'status') buffer.loaded = false;
    }

    // A link such as /#dev opens (and if need be joins) that channel.
    const fromHash = location.hash.length > 1 ? `#${decodeURIComponent(location.hash.slice(1))}` : null;
    const wanted = resuming ? this.activeKey : keyOf(fromHash ?? stored.get('active') ?? '');
    this.setPhase('online');
    const first = this.buffers.has(wanted) ? wanted : this.list('channel')[0]?.key ?? STATUS;
    this.activate(first);
    if (!resuming && isChannel(wanted) && !this.buffers.has(wanted)) this.join(wanted);
  },

  // --------------------------------------------------------------- buffers

  makeBuffer(key, type, name) {
    return {
      key, type, name,
      topic: '', topicBy: null, topicAt: null, modes: '',
      members: new Map(),
      peer: null,
      items: [],
      loaded: type === 'status',
      loading: false,
      hasMore: type !== 'status',
      unread: 0, mentions: 0,
      lastRead: null,
      /** Where the "new" line sits while the buffer is on screen. */
      newAfter: null,
      typing: new Map(),
      draft: '',
    };
  },

  addChannel(state, existing) {
    const buffer = existing ?? this.makeBuffer(keyOf(state.name), 'channel', state.name);
    Object.assign(buffer, {
      name: state.name, topic: state.topic, topicBy: state.topicBy, topicAt: state.topicAt, modes: state.modes,
      unread: state.unread, mentions: state.mentions, lastRead: state.lastRead,
    });
    buffer.members = new Map(state.members.map((member) => [keyOf(member.nick), member]));
    this.buffers.set(buffer.key, buffer);
    return buffer;
  },

  ensureDm(nick) {
    let buffer = this.buffers.get(keyOf(nick));
    if (!buffer) {
      buffer = this.makeBuffer(keyOf(nick), 'dm', nick);
      this.buffers.set(buffer.key, buffer);
      this.emit('buffers');
      this.refreshPeer(buffer);
    }
    return buffer;
  },

  async refreshPeer(buffer) {
    try {
      buffer.peer = await conn.request('whois', { nick: buffer.name });
      buffer.name = buffer.peer.nick;
      this.emit('buffers');
      if (buffer === this.active) this.emit('header');
    } catch {
      // Unknown nick: the first message to it will say so.
    }
  },

  activate(key) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    const previous = this.active;
    if (previous && previous !== buffer) previous.newAfter = null;
    this.activeKey = key;
    buffer.newAfter = buffer.unread > 0 ? buffer.lastRead : null;
    stored.set('active', buffer.type === 'status' ? null : buffer.name);
    const hash = buffer.type === 'status' ? '' : `#${encodeURIComponent(buffer.name.replace(/^#/, ''))}`;
    if (buffer.type === 'channel' && location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
    else if (buffer.type !== 'channel' && location.hash) history.replaceState(null, '', location.pathname);
    this.emit('active', buffer);
    if (!buffer.loaded) this.loadHistory(buffer);
    else this.markRead(buffer);
  },

  /** Leaves a channel, or closes a conversation. */
  close(buffer = this.active) {
    if (buffer.type === 'channel') return this.run('part', { channel: buffer.name });
    if (buffer.type === 'dm') this.dropBuffer(buffer);
  },

  dropBuffer(buffer) {
    this.buffers.delete(buffer.key);
    this.emit('buffers');
    if (this.activeKey === buffer.key) this.activate(this.list('channel')[0]?.key ?? STATUS);
  },

  async loadHistory(buffer, older = false) {
    if (buffer.loading || buffer.type === 'status' || (older && !buffer.hasMore)) return;
    buffer.loading = true;
    try {
      const first = older ? buffer.items.find((item) => Number.isInteger(item.id)) : null;
      const page = await conn.request('history', { target: buffer.name, before: first?.id });
      if (!this.buffers.has(buffer.key)) return;
      const known = new Set(buffer.items.map((item) => item.id));
      const fresh = page.messages.filter((msg) => !known.has(msg.id));
      if (older) {
        buffer.items = [...fresh, ...buffer.items];
      } else {
        // Notes written locally and messages that never reach the server's
        // history (talk with guests) are kept; the rest is replaced.
        const local = buffer.items.filter((item) => !Number.isInteger(item.id));
        buffer.items = [...page.messages, ...local].sort((a, b) => a.ts - b.ts);
      }
      buffer.hasMore = page.hasMore;
      buffer.loaded = true;
      this.emit('items', { buffer, kind: older ? 'prepend' : 'reset' });
      if (!older && buffer === this.active) this.markRead(buffer);
    } catch (err) {
      if (err.code !== 'closed') this.note(buffer, 'error', err.message);
    } finally {
      buffer.loading = false;
    }
  },

  /** A line written by the client itself: joins, errors, command output. */
  note(buffer, kind, text, extra = {}) {
    const item = { id: `l${++localSeq}`, local: true, kind, text, ts: Date.now(), ...extra };
    buffer.items.push(item);
    this.emit('items', { buffer, kind: 'append', item });
    return item;
  },

  /** Tells the server how far the user has read, once they have really seen it. */
  markRead(buffer) {
    if (buffer !== this.active || document.hidden || !buffer.loaded) return;
    const last = buffer.items.findLast((item) => Number.isInteger(item.id));
    const changed = buffer.unread > 0 || buffer.mentions > 0;
    buffer.unread = 0;
    buffer.mentions = 0;
    if (changed) this.emit('buffers');
    if (last && last.id > (buffer.lastRead ?? 0)) {
      buffer.lastRead = last.id;
      if (this.self.registered) conn?.request('read', { target: buffer.name, msgId: last.id }).catch(() => {});
    }
  },

  // --------------------------------------------------------------- actions

  request(op, params) {
    if (!conn) return Promise.reject(Object.assign(new Error('You are offline.'), { code: 'closed' }));
    return conn.request(op, params);
  },

  /** Like `request`, but a failure is shown in the current buffer instead of thrown. */
  async run(op, params) {
    try {
      return await this.request(op, params);
    } catch (err) {
      this.note(this.active, 'error', err.message);
      return undefined;
    }
  },

  async join(name) {
    const key = keyOf(name.startsWith('#') ? name : `#${name}`);
    if (this.buffers.has(key)) return this.activate(key);
    const result = await this.run('join', { channel: key });
    if (result) this.activate(keyOf(result.channel.name));
  },

  openDm(nick) {
    if (this.isSelf(nick)) return;
    this.activate(this.ensureDm(nick).key);
  },

  async send(text, { kind = 'msg', replyTo = null, target = this.active } = {}) {
    if (target.type === 'status') {
      this.note(target, 'error', 'This is the status window. Join a channel with /join #name to talk.');
      return false;
    }
    try {
      const sent = await this.request('send', { target: target.name, text, kind, replyTo });
      if (sent.away) this.note(target, 'info', `${target.name} is away: ${sent.away}`);
      else if (sent.offline) this.note(target, 'info', `${target.name} is offline and will see this later.`);
      return true;
    } catch (err) {
      this.note(target, 'error', err.message);
      return false;
    }
  },

  setTheme(theme) {
    this.theme = theme;
    stored.set('theme', theme);
    this.emit('theme', theme);
  },

  setSetting(name, value) {
    this.settings[name] = value;
    stored.set('settings', this.settings);
    this.emit('settings');
  },

  // ---------------------------------------------------------------- events

  handle(event) {
    const handler = this.events[event.type];
    if (handler) handler.call(this, event);
  },

  channelsWith(nick) {
    const key = keyOf(nick);
    return [...this.buffers.values()].filter((buffer) => buffer.type === 'channel' && buffer.members.has(key));
  },

  touchMembers(buffer) {
    this.emit('buffers');
    if (buffer === this.active) this.emit('members');
  },

  join_note(buffer, kind, nick, text) {
    if (this.settings.showJoins) this.note(buffer, kind, text, { nick });
  },

  events: {
    message({ target, msg }) {
      const buffer = isChannel(target) ? this.buffers.get(keyOf(target)) : this.ensureDm(target);
      if (!buffer || buffer.items.some((item) => item.id === msg.id)) return;
      buffer.items.push(msg);
      buffer.typing.delete(keyOf(msg.nick));
      const own = this.isSelf(msg.nick);
      const seen = buffer === this.active && !document.hidden && buffer.loaded;
      const pinged = !own && (buffer.type === 'dm' || mentions(msg.text, this.self.nick));
      if (!own && !seen) {
        if (buffer.newAfter == null && buffer === this.active) {
          buffer.newAfter = buffer.items.findLast((item) => Number.isInteger(item.id) && item.id !== msg.id)?.id ?? 0;
        }
        buffer.unread += 1;
        if (pinged) buffer.mentions += 1;
        this.emit('buffers');
        if (pinged) this.emit('ping', { buffer, msg });
      }
      this.emit('items', { buffer, kind: 'append', item: msg });
      this.emit('typing', buffer);
      if (seen) this.markRead(buffer);
    },

    message_update({ target, msg }) {
      const buffer = this.buffers.get(keyOf(target));
      const index = buffer?.items.findIndex((item) => item.id === msg.id) ?? -1;
      if (index < 0) return;
      buffer.items[index] = msg;
      this.emit('items', { buffer, kind: 'update', item: msg });
    },

    channel_joined({ channel }) {
      this.addChannel(channel, this.buffers.get(keyOf(channel.name)));
      this.emit('buffers');
    },

    join({ channel, member }) {
      const buffer = this.buffers.get(keyOf(channel));
      if (!buffer) return;
      buffer.members.set(keyOf(member.nick), member);
      this.join_note(buffer, 'join', member.nick, 'joined');
      this.touchMembers(buffer);
    },

    part({ channel, nick, reason }) {
      const buffer = this.buffers.get(keyOf(channel));
      if (!buffer) return;
      if (this.isSelf(nick)) return this.dropBuffer(buffer);
      buffer.members.delete(keyOf(nick));
      this.join_note(buffer, 'part', nick, reason ? `left (${reason})` : 'left');
      this.touchMembers(buffer);
    },

    kick({ channel, nick, by, reason }) {
      const buffer = this.buffers.get(keyOf(channel));
      if (!buffer) return;
      const why = reason ? ` (${reason})` : '';
      if (this.isSelf(nick)) {
        this.dropBuffer(buffer);
        this.note(this.buffers.get(STATUS), 'error', `You were kicked from ${buffer.name} by ${by}${why}.`);
        if (this.active.type !== 'status') this.note(this.active, 'error', `You were kicked from ${buffer.name} by ${by}${why}.`);
        return;
      }
      buffer.members.delete(keyOf(nick));
      this.note(buffer, 'part', `was kicked by ${by}${why}`, { nick });
      this.touchMembers(buffer);
    },

    quit({ nick, reason }) {
      for (const buffer of this.channelsWith(nick)) {
        buffer.members.delete(keyOf(nick));
        this.join_note(buffer, 'part', nick, reason ? `quit (${reason})` : 'quit');
        this.touchMembers(buffer);
      }
      this.peerChanged(nick, { online: false });
    },

    presence({ change, nick, online, away, registered }) {
      if (this.isSelf(nick)) {
        this.self = { ...this.self, away, registered };
        this.emit('self');
      }
      for (const buffer of this.channelsWith(nick)) {
        Object.assign(buffer.members.get(keyOf(nick)), { online, away, registered });
        if (change === 'online') this.join_note(buffer, 'join', nick, 'is back online');
        if (change === 'offline') this.join_note(buffer, 'part', nick, 'went offline');
        this.touchMembers(buffer);
      }
      this.peerChanged(nick, { online, away, registered });
    },

    nick({ old, nick }) {
      const oldKey = keyOf(old);
      const key = keyOf(nick);
      if (this.isSelf(old)) {
        this.self = { ...this.self, nick };
        stored.set('nick', nick);
        this.emit('self');
      }
      for (const buffer of this.channelsWith(old)) {
        const member = buffer.members.get(oldKey);
        buffer.members.delete(oldKey);
        buffer.members.set(key, { ...member, nick });
        this.note(buffer, 'info', `is now known as ${nick}`, { nick: old });
        this.touchMembers(buffer);
      }
      const dm = this.buffers.get(oldKey);
      if (dm?.type === 'dm' && !this.buffers.has(key)) {
        this.buffers.delete(oldKey);
        Object.assign(dm, { key, name: nick });
        this.buffers.set(key, dm);
        if (this.activeKey === oldKey) this.activeKey = key;
        this.emit('buffers');
        if (dm === this.active) this.emit('header');
      }
    },

    topic({ channel, topic, by, at }) {
      const buffer = this.buffers.get(keyOf(channel));
      if (!buffer) return;
      Object.assign(buffer, { topic, topicBy: by, topicAt: at });
      this.note(buffer, 'info', topic ? `changed the topic to: ${topic}` : 'cleared the topic', { nick: by });
      if (buffer === this.active) this.emit('header');
    },

    mode({ channel, by, changes, modes }) {
      const buffer = this.buffers.get(keyOf(channel));
      if (!buffer) return;
      buffer.modes = modes;
      for (const change of changes) {
        const member = change.arg && 'ov'.includes(change.mode) ? buffer.members.get(keyOf(change.arg)) : null;
        if (member) member.role = change.role;
      }
      const flags = changes.map((change) => `${change.add ? '+' : '-'}${change.mode}${change.arg ? ` ${change.arg}` : ''}`);
      this.note(buffer, 'info', `set mode ${flags.join(' ')}`, { nick: by });
      this.touchMembers(buffer);
      if (buffer === this.active) this.emit('header');
    },

    invite({ channel, by }) {
      const text = `${by} invites you to ${channel}. Type /join ${channel} to accept.`;
      this.note(this.buffers.get(STATUS), 'info', text);
      if (this.active.type !== 'status') this.note(this.active, 'info', text);
    },

    typing({ target, nick }) {
      const buffer = this.buffers.get(keyOf(target));
      if (!buffer) return;
      const key = keyOf(nick);
      clearTimeout(buffer.typing.get(key)?.timer);
      buffer.typing.set(key, {
        nick,
        timer: setTimeout(() => {
          buffer.typing.delete(key);
          this.emit('typing', buffer);
        }, TYPING_SHOWN_MS),
      });
      this.emit('typing', buffer);
    },

    read({ target, lastRead }) {
      const buffer = this.buffers.get(keyOf(target));
      if (!buffer) return;
      buffer.lastRead = Math.max(buffer.lastRead ?? 0, lastRead);
      buffer.unread = 0;
      buffer.mentions = 0;
      this.emit('buffers');
    },

    self({ self, token }) {
      this.self = self;
      if (token) stored.set('token', token);
      this.emit('self');
    },
  },

  peerChanged(nick, change) {
    const dm = this.buffers.get(keyOf(nick));
    if (dm?.type !== 'dm') return;
    dm.peer = { ...dm.peer, nick, ...change };
    this.emit('buffers');
    if (dm === this.active) this.emit('header');
  },
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.phase === 'online') app.markRead(app.active);
});
