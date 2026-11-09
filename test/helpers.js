import { Hub } from '../src/core/hub.js';
import { Store } from '../src/db.js';

let seq = 0;

/** A connection that records what the hub delivers to it. */
export function fakeConn() {
  const conn = {
    id: `test${++seq}`,
    user: null,
    token: null,
    closed: false,
    events: [],
    deliver(event, meta) {
      conn.events.push({ ...event, meta });
    },
    /** Events of one type, oldest first. */
    of(type) {
      return conn.events.filter((event) => event.type === type);
    },
    last(type) {
      return conn.of(type).at(-1);
    },
    clear() {
      conn.events.length = 0;
    },
  };
  return conn;
}

/** A hub on an in-memory database, with a clock the test controls. */
export function makeHub(config = {}, store = new Store(':memory:')) {
  const clock = { t: 1_700_000_000_000 };
  const hub = new Hub({
    store,
    now: () => clock.t,
    config: { graceMs: 0, messageBurst: 1000, ...config },
  });
  const login = async (nick, options = {}) => {
    const conn = fakeConn();
    conn.snapshot = await hub.login(conn, { nick, ...options });
    return conn;
  };
  return { hub, store, clock, login };
}

export const rejectsWith = (code) => (err) => err.name === 'ChatError' && err.code === code;
