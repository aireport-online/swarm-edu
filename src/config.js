import { resolve } from 'node:path';
import { parseChannel } from './core/validate.js';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Reads the configuration from environment variables. See the README. */
export function loadConfig(env = process.env) {
  const serverName = env.SWARM_NAME?.trim() || 'Swarm';
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000),
    /** 0 switches the IRC gateway off. */
    ircPort: int(env.IRC_PORT, 6667),
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : resolve(env.DB_PATH || 'data/swarm.db'),
    /** Believe X-Forwarded-For. Only behind a reverse proxy you control. */
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    hub: {
      serverName,
      motd: env.SWARM_MOTD ?? `Welcome to ${serverName}. Type /help to see what you can do here.`,
      defaultChannels: (env.SWARM_CHANNELS || '#lobby').split(',').map((name) => parseChannel(name)),
      graceMs: int(env.SWARM_GRACE_MS, 20_000),
      /** Registered nicks that are operators of the default channels. */
      admins: (env.SWARM_ADMINS || '').split(',').map((nick) => nick.trim().toLowerCase()).filter(Boolean),
    },
  };
}
