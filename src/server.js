import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Hub } from './core/hub.js';
import { FailureWindow } from './core/ratelimit.js';
import { Store } from './db.js';
import { createHttpServer } from './gateways/http.js';
import { createIrcServer } from './gateways/irc.js';
import { attachWebSocket } from './gateways/ws.js';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

/**
 * Builds the whole application without starting it, so tests can run it on
 * throwaway ports with an in-memory database.
 */
export function createApp(config = loadConfig(), { log = console.error } = {}) {
  const store = new Store(config.dbPath);
  const hub = new Hub({ store, config: config.hub });
  const startedAt = Date.now();
  // Ten wrong passwords from one address lock sign-in for ten minutes, and
  // one address may register five nicks an hour.
  const loginGuard = new FailureWindow(10, 10 * 60 * 1000);
  const registrationGuard = new FailureWindow(5, 60 * 60 * 1000);
  const ports = { http: null, irc: null };

  const http = createHttpServer({
    root: join(here, '..', 'public'),
    info: () => ({ name: hub.config.serverName, version, ircPort: ports.irc, staffCode: Boolean(hub.config.teacherCode) }),
    health: () => ({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), ...hub.stats() }),
  });
  // Behind a proxy, the last X-Forwarded-For entry is the one the proxy itself
  // added; anything before it was sent by the client and proves nothing.
  const clientAddress = (req) =>
    (config.trustProxy && req.headers['x-forwarded-for']?.split(',').at(-1).trim()) || req.socket.remoteAddress || 'unknown';
  const wss = attachWebSocket(http, hub, { loginGuard, registrationGuard, clientAddress, log });
  const irc = config.ircPort === 0
    ? null
    : createIrcServer(hub, { loginGuard, registrationGuard, log, version, startedAt, name: hub.config.serverName });

  return {
    hub,
    store,
    ports,
    async start() {
      ports.http = await listen(http, config.port, config.host);
      if (irc) ports.irc = await listen(irc, config.ircPort < 0 ? 0 : config.ircPort, config.host);
      return ports;
    },
    async stop() {
      hub.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      irc?.shutdown();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = createApp(config);
  const ports = await app.start();
  console.log(`${config.hub.serverName} ${version}`);
  console.log(`  web  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${ports.http}`);
  if (ports.irc) console.log(`  irc  ${config.host === '0.0.0.0' ? 'localhost' : config.host}:${ports.irc}`);
  console.log(`  data ${config.dbPath}`);
  if (!config.hub.teacherCode && config.hub.teachers.length === 0 && config.hub.school.onlyTeachersCreate) {
    console.log('  note: nobody can open a class yet. Set SWARM_TEACHER_CODE (a staff code) or SWARM_TEACHERS (nicks).');
  }

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
      process.exit(0);
    });
  }
}
