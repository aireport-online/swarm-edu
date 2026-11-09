import { WebSocketServer } from 'ws';
import { ChatError } from '../core/errors.js';
import { TokenBucket } from '../core/ratelimit.js';

const PING_INTERVAL_MS = 30_000;
const MAX_PAYLOAD = 64 * 1024;
/** A client that stops reading is cut off once this much is waiting for it. */
const MAX_BUFFERED = 4 * 1024 * 1024;

const TOO_MANY_NICKS = 'Too many nicks were registered from your address. Try again later.';

/**
 * What a signed-in client may ask for. Each entry receives the hub, the
 * user, the request and the connection, and returns the reply's data.
 */
const OPS = {
  join: (hub, user, p) => hub.join(user, p.channel),
  part: (hub, user, p) => hub.part(user, p.channel, p.reason),
  send: (hub, user, p, conn) => hub.send(user, p.target, p.text, { kind: p.kind, replyTo: p.replyTo, origin: conn.id }),
  edit: (hub, user, p) => hub.edit(user, p.msgId, p.text),
  delete: (hub, user, p) => hub.remove(user, p.msgId),
  react: (hub, user, p) => hub.react(user, p.msgId, p.emoji),
  history: (hub, user, p) => hub.history(user, p.target, { before: p.before, limit: p.limit }),
  topic: (hub, user, p) => hub.setTopic(user, p.channel, p.topic),
  nick: (hub, user, p) => hub.changeNick(user, p.nick),
  kick: (hub, user, p) => hub.kick(user, p.channel, p.nick, p.reason),
  mode: (hub, user, p) => hub.setMode(user, p.channel, p.changes),
  bans: (hub, user, p) => hub.bans(user, p.channel),
  invite: (hub, user, p) => hub.invite(user, p.channel, p.nick),
  list: (hub) => hub.list(),
  whois: (hub, user, p) => hub.whois(user, p.nick),
  away: (hub, user, p) => hub.setAway(user, p.message),
  typing: (hub, user, p) => hub.typing(user, p.target),
  read: (hub, user, p, conn) => hub.markRead(user, p.target, p.msgId, { origin: conn.id }),
  search: (hub, user, p) => hub.search(user, p.query),
  register: (hub, user, p, conn) => hub.register(user, p.password, conn),
};

/**
 * The JSON protocol of the web client, on `/ws`.
 *
 * Requests are `{ id, op, ...params }` (so no parameter is called `id`:
 * messages are referred to as `msgId`) and are answered with
 * `{ type: 'reply', id, ok, data | error }`. Everything else the server sends
 * is an event: `{ type, ... }`. The first request must be `hello`.
 */
export function attachWebSocket(httpServer, hub, { loginGuard, registrationGuard, clientAddress, log = () => {} }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD });
  let seq = 0;

  wss.on('connection', (ws, req) => {
    const address = clientAddress(req);
    const bucket = new TokenBucket(40, 20);
    const conn = {
      id: `ws${++seq}`,
      kind: 'ws',
      user: null,
      token: null,
      closed: false,
      deliver(event, meta) {
        // Reading up to a message is echoed to a user's *other* devices only.
        if (event.type === 'read' && meta?.origin === conn.id) return;
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
        ws.send(JSON.stringify(event));
      },
    };
    const reply = (id, ok, body) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'reply', id, ok, ...(ok ? { data: body ?? null } : { error: body }) }));
      }
    };

    async function hello(request) {
      const guessing = Boolean(request.password) && !request.register;
      if (guessing && loginGuard.blocked(address)) {
        throw new ChatError('rate_limited', 'Too many failed sign-ins from your address. Try again later.');
      }
      if (request.register && registrationGuard.blocked(address)) throw new ChatError('rate_limited', TOO_MANY_NICKS);
      // Counted before the password is checked, so attempts made in parallel
      // cannot all slip under the limit; a correct password is forgiven.
      if (guessing) loginGuard.fail(address);
      const snapshot = await hub.login(conn, request);
      if (guessing) loginGuard.forgive(address);
      if (request.register) registrationGuard.fail(address);
      return snapshot;
    }

    async function handle(raw) {
      let request;
      try {
        request = JSON.parse(raw);
      } catch {
        return reply(null, false, { code: 'bad_request', message: 'Not JSON.' });
      }
      if (request === null || typeof request !== 'object' || typeof request.op !== 'string') {
        return reply(request?.id ?? null, false, { code: 'bad_request', message: 'Requests need an "op".' });
      }
      const { id, op } = request;
      try {
        if (!bucket.take()) throw new ChatError('rate_limited', 'Too many requests. Slow down.');
        if (op === 'ping') return reply(id, true);
        if (op === 'hello') return reply(id, true, await hello(request));
        if (!conn.user) throw new ChatError('not_signed_in', 'Say hello first.');
        if (op === 'logout') {
          hub.logout(conn);
          reply(id, true);
          return ws.close(1000, 'Signed out');
        }
        if (!Object.hasOwn(OPS, op)) throw new ChatError('bad_request', `Unknown op "${op}".`);
        if (op === 'register') {
          if (registrationGuard.blocked(address)) throw new ChatError('rate_limited', TOO_MANY_NICKS);
          const result = await OPS.register(hub, conn.user, request, conn);
          registrationGuard.fail(address);
          return reply(id, true, result);
        }
        reply(id, true, await OPS[op](hub, conn.user, request, conn));
      } catch (err) {
        if (err instanceof ChatError) return reply(id, false, { code: err.code, message: err.message });
        log('ws request failed', op, err);
        reply(id, false, { code: 'internal', message: 'Something went wrong on the server.' });
      }
    }

    // One request at a time per connection, so a slow sign-in cannot be overtaken.
    let queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'Text only');
      queue = queue.then(() => handle(data.toString()));
    });
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => {
      conn.closed = true;
      hub.disconnect(conn);
    });
    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
