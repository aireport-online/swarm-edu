import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  nick          TEXT NOT NULL,
  nick_key      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  topic      TEXT NOT NULL DEFAULT '',
  topic_by   TEXT,
  topic_at   INTEGER,
  modes      TEXT NOT NULL DEFAULT 't',
  founder_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       TEXT,
  last_read  INTEGER NOT NULL DEFAULT 0,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, account_id)
);
CREATE TABLE IF NOT EXISTS bans (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  nick_key   TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  set_by     TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  PRIMARY KEY (channel_id, nick_key)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  dm_a       INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  dm_b       INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  nick       TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'msg',
  text       TEXT NOT NULL,
  reply_to   INTEGER,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel_id, id);
CREATE INDEX IF NOT EXISTS messages_by_dm ON messages (dm_a, dm_b, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  nick_key   TEXT NOT NULL,
  nick       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, nick_key)
);
CREATE TABLE IF NOT EXISTS dm_reads (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  peer_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last_read  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, peer_id)
);
`;

const REPLY_PREVIEW_LENGTH = 140;
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
const marks = (list) => list.map(() => '?').join(',');

const toAccount = (row) =>
  row && {
    id: row.id,
    nick: row.nick,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };

/**
 * Everything that outlives a restart. The hub keeps live state in memory and
 * calls in here to persist it; nothing in this file knows about connections.
 */
export class Store {
  #db;
  #cache = new Map();

  /** @param {string} path a file path, or `:memory:` */
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#cache.clear();
    this.#db.close();
  }

  #stmt(sql) {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }
  #get(sql, ...params) {
    return this.#stmt(sql).get(...params) ?? null;
  }
  #all(sql, ...params) {
    return this.#stmt(sql).all(...params);
  }
  #run(sql, ...params) {
    return this.#stmt(sql).run(...params);
  }

  transaction(fn) {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- accounts and sessions ----

  accountByKey(key) {
    return toAccount(this.#get('SELECT * FROM accounts WHERE nick_key = ?', key));
  }
  accountById(id) {
    return toAccount(this.#get('SELECT * FROM accounts WHERE id = ?', id));
  }
  createAccount(nick, passwordHash, now) {
    const { lastInsertRowid } = this.#run(
      'INSERT INTO accounts (nick, nick_key, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
      nick, nick.toLowerCase(), passwordHash, now, now,
    );
    return this.accountById(Number(lastInsertRowid));
  }
  renameAccount(id, nick) {
    this.#run('UPDATE accounts SET nick = ?, nick_key = ? WHERE id = ?', nick, nick.toLowerCase(), id);
  }
  touchAccount(id, now) {
    this.#run('UPDATE accounts SET last_seen = ? WHERE id = ?', now, id);
  }

  addSession(tokenHash, accountId, now) {
    this.#run(
      'INSERT INTO sessions (token_hash, account_id, created_at, last_used) VALUES (?, ?, ?, ?)',
      tokenHash, accountId, now, now,
    );
  }
  /** @returns {number|null} the account the token belongs to, unless it went unused for `ttl` */
  useSession(tokenHash, now, ttl) {
    const row = this.#get('SELECT account_id, last_used FROM sessions WHERE token_hash = ?', tokenHash);
    if (!row) return null;
    if (now - row.last_used > ttl) {
      this.deleteSession(tokenHash);
      return null;
    }
    this.#run('UPDATE sessions SET last_used = ? WHERE token_hash = ?', now, tokenHash);
    return row.account_id;
  }
  deleteSession(tokenHash) {
    this.#run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }
  pruneSessions(unusedSince) {
    this.#run('DELETE FROM sessions WHERE last_used < ?', unusedSince);
  }

  // ---- channels ----

  loadChannels() {
    return this.#all('SELECT * FROM channels ORDER BY id').map((row) => ({
      id: row.id,
      name: row.name,
      topic: row.topic,
      topicBy: row.topic_by,
      topicAt: row.topic_at,
      modes: row.modes,
      founderId: row.founder_id,
      createdAt: row.created_at,
    }));
  }
  loadMemberships() {
    return this.#all(
      `SELECT m.channel_id, m.account_id, m.role, a.nick
         FROM memberships m JOIN accounts a ON a.id = m.account_id
        ORDER BY m.joined_at, m.rowid`,
    ).map((row) => ({ channelId: row.channel_id, accountId: row.account_id, role: row.role, nick: row.nick }));
  }
  loadBans() {
    return this.#all('SELECT channel_id, nick_key, account_id FROM bans').map((row) => ({
      channelId: row.channel_id,
      nickKey: row.nick_key,
      accountId: row.account_id,
    }));
  }
  createChannel({ name, founderId = null, modes, topic = '', now }) {
    const { lastInsertRowid } = this.#run(
      'INSERT INTO channels (name, topic, modes, founder_id, created_at) VALUES (?, ?, ?, ?, ?)',
      name, topic, modes, founderId, now,
    );
    return Number(lastInsertRowid);
  }
  deleteChannel(id) {
    this.#run('DELETE FROM channels WHERE id = ?', id);
  }
  updateTopic(id, topic, by, at) {
    this.#run('UPDATE channels SET topic = ?, topic_by = ?, topic_at = ? WHERE id = ?', topic, by, at, id);
  }
  updateModes(id, modes) {
    this.#run('UPDATE channels SET modes = ? WHERE id = ?', modes, id);
  }

  addMembership(channelId, accountId, role, now) {
    this.#run(
      `INSERT OR REPLACE INTO memberships (channel_id, account_id, role, last_read, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId, accountId, role, this.latestId(channelId), now,
    );
  }
  removeMembership(channelId, accountId) {
    this.#run('DELETE FROM memberships WHERE channel_id = ? AND account_id = ?', channelId, accountId);
  }
  setRole(channelId, accountId, role) {
    this.#run('UPDATE memberships SET role = ? WHERE channel_id = ? AND account_id = ?', role, channelId, accountId);
  }

  addBan(channelId, key, accountId, by, now) {
    this.#run(
      'INSERT OR IGNORE INTO bans (channel_id, nick_key, account_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)',
      channelId, key, accountId, by, now,
    );
  }
  removeBan(channelId, key) {
    this.#run('DELETE FROM bans WHERE channel_id = ? AND nick_key = ?', channelId, key);
  }
  listBans(channelId) {
    return this.#all('SELECT nick_key, set_by, set_at FROM bans WHERE channel_id = ? ORDER BY set_at', channelId)
      .map((row) => ({ nick: row.nick_key, by: row.set_by, at: row.set_at }));
  }

  // ---- messages ----

  /** @returns {object} the stored message, in the shape clients receive */
  addMessage({ channelId = null, dmA = null, dmB = null, nick, accountId = null, kind, text, replyTo = null, now }) {
    const { lastInsertRowid } = this.#run(
      `INSERT INTO messages (channel_id, dm_a, dm_b, nick, account_id, kind, text, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId, dmA, dmB, nick, accountId, kind, text, replyTo, now,
    );
    return this.message(Number(lastInsertRowid));
  }
  /** The raw row, including where the message lives and who owns it. */
  messageRow(id) {
    if (!Number.isInteger(id)) return null;
    const row = this.#get('SELECT * FROM messages WHERE id = ?', id);
    return row && {
      id: row.id,
      channelId: row.channel_id,
      dmA: row.dm_a,
      dmB: row.dm_b,
      nick: row.nick,
      accountId: row.account_id,
      deleted: row.deleted === 1,
    };
  }
  message(id) {
    const row = this.#get('SELECT * FROM messages WHERE id = ?', id);
    return row ? this.#hydrate([row])[0] : null;
  }
  editMessage(id, text, now) {
    this.#run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, now, id);
  }
  deleteMessage(id) {
    this.transaction(() => {
      this.#run("UPDATE messages SET text = '', deleted = 1 WHERE id = ?", id);
      this.#run('DELETE FROM reactions WHERE message_id = ?', id);
    });
  }
  /** @returns {boolean} true when the reaction was added, false when removed */
  toggleReaction(id, emoji, nick, now) {
    const key = nick.toLowerCase();
    const { changes } = this.#run(
      'DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND nick_key = ?',
      id, emoji, key,
    );
    if (changes > 0) return false;
    this.#run(
      'INSERT INTO reactions (message_id, emoji, nick_key, nick, created_at) VALUES (?, ?, ?, ?, ?)',
      id, emoji, key, nick, now,
    );
    return true;
  }
  reactionKinds(id) {
    return this.#get('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', id).n;
  }

  /** Oldest first. `before` pages backwards from a message id. */
  channelHistory(channelId, { before = null, limit }) {
    const rows = before
      ? this.#all('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', channelId, before, limit + 1)
      : this.#all('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', channelId, limit + 1);
    return this.#page(rows, limit);
  }
  dmHistory(a, b, { before = null, limit }) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const rows = before
      ? this.#all('SELECT * FROM messages WHERE dm_a = ? AND dm_b = ? AND id < ? ORDER BY id DESC LIMIT ?', lo, hi, before, limit + 1)
      : this.#all('SELECT * FROM messages WHERE dm_a = ? AND dm_b = ? ORDER BY id DESC LIMIT ?', lo, hi, limit + 1);
    return this.#page(rows, limit);
  }
  #page(rows, limit) {
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    return { messages: this.#hydrate(rows.reverse()), hasMore };
  }

  latestId(channelId) {
    return this.#get('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?', channelId).id;
  }

  /** Read position and what arrived after it, for one member of a channel. */
  channelUnread(channelId, accountId, nick) {
    const lastRead = this.#get(
      'SELECT last_read FROM memberships WHERE channel_id = ? AND account_id = ?',
      channelId, accountId,
    )?.last_read ?? 0;
    const row = this.#get(
      `SELECT COUNT(*) AS unread,
              COALESCE(SUM(CASE WHEN text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END), 0) AS mentions
         FROM messages
        WHERE channel_id = ? AND id > ? AND deleted = 0
          AND (account_id IS NULL OR account_id != ?)`,
      likePattern(nick), channelId, lastRead, accountId,
    );
    return { lastRead, unread: row.unread, mentions: row.mentions };
  }
  setLastRead(channelId, accountId, id) {
    this.#run(
      'UPDATE memberships SET last_read = MAX(last_read, ?) WHERE channel_id = ? AND account_id = ?',
      id, channelId, accountId,
    );
  }

  /** Every conversation the account has had, newest first. */
  dmList(accountId) {
    return this.#all(
      `SELECT t.peer_id, a.nick, t.latest, COALESCE(r.last_read, 0) AS last_read,
              (SELECT COUNT(*) FROM messages m
                WHERE m.dm_a = MIN(t.peer_id, ?1) AND m.dm_b = MAX(t.peer_id, ?1)
                  AND m.id > COALESCE(r.last_read, 0) AND m.account_id = t.peer_id AND m.deleted = 0) AS unread
         FROM (SELECT CASE WHEN dm_a = ?1 THEN dm_b ELSE dm_a END AS peer_id, MAX(id) AS latest
                 FROM messages WHERE dm_a = ?1 OR dm_b = ?1 GROUP BY peer_id) t
         JOIN accounts a ON a.id = t.peer_id
         LEFT JOIN dm_reads r ON r.account_id = ?1 AND r.peer_id = t.peer_id
        ORDER BY t.latest DESC`,
      accountId,
    ).map((row) => ({
      peerId: row.peer_id,
      nick: row.nick,
      latestId: row.latest,
      lastRead: row.last_read,
      unread: row.unread,
    }));
  }
  setDmRead(accountId, peerId, id) {
    this.#run(
      `INSERT INTO dm_reads (account_id, peer_id, last_read) VALUES (?, ?, ?)
       ON CONFLICT (account_id, peer_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)`,
      accountId, peerId, id,
    );
  }

  /**
   * Newest first. Looks only in the given channels and, when `accountId` is
   * set, in that account's direct messages.
   * @returns {Array<{channelId: number|null, peerId: number|null, message: object}>}
   */
  search({ query, channelIds, accountId = null, limit }) {
    const scopes = [];
    const params = [likePattern(query)];
    if (channelIds.length) {
      scopes.push(`channel_id IN (${marks(channelIds)})`);
      params.push(...channelIds);
    }
    if (accountId != null) {
      scopes.push('dm_a = ? OR dm_b = ?');
      params.push(accountId, accountId);
    }
    if (!scopes.length) return [];
    const rows = this.#db
      .prepare(
        `SELECT * FROM messages
          WHERE deleted = 0 AND text LIKE ? ESCAPE '\\' AND (${scopes.join(' OR ')})
          ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit);
    const messages = this.#hydrate(rows);
    return rows.map((row, i) => ({
      channelId: row.channel_id,
      peerId: row.channel_id == null ? (row.dm_a === accountId ? row.dm_b : row.dm_a) : null,
      message: messages[i],
    }));
  }

  /** Adds reactions and reply previews to raw rows. */
  #hydrate(rows) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const reactions = new Map();
    const reactionRows = this.#db
      .prepare(
        `SELECT message_id, emoji, nick FROM reactions
          WHERE message_id IN (${marks(ids)}) ORDER BY created_at, rowid`,
      )
      .all(...ids);
    for (const { message_id: id, emoji, nick } of reactionRows) {
      let list = reactions.get(id);
      if (!list) reactions.set(id, (list = []));
      let entry = list.find((item) => item.emoji === emoji);
      if (!entry) list.push((entry = { emoji, nicks: [] }));
      entry.nicks.push(nick);
    }

    const replyIds = [...new Set(rows.map((row) => row.reply_to).filter((id) => id != null))];
    const replies = new Map();
    if (replyIds.length) {
      const replyRows = this.#db
        .prepare(`SELECT id, nick, text, deleted FROM messages WHERE id IN (${marks(replyIds)})`)
        .all(...replyIds);
      for (const row of replyRows) {
        replies.set(row.id, {
          id: row.id,
          nick: row.nick,
          text: row.text.slice(0, REPLY_PREVIEW_LENGTH),
          deleted: row.deleted === 1,
        });
      }
    }

    return rows.map((row) => ({
      id: row.id,
      nick: row.nick,
      registered: row.account_id != null,
      kind: row.kind,
      text: row.text,
      ts: row.created_at,
      editedAt: row.edited_at,
      deleted: row.deleted === 1,
      replyTo: row.reply_to == null ? null : replies.get(row.reply_to) ?? null,
      reactions: reactions.get(row.id) ?? [],
    }));
  }
}
