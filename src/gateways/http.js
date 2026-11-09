import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Serves the web client and two small JSON endpoints.
 * @param {object} options
 * @param {string} options.root directory with the client's files
 * @param {() => object} options.info what `/api/info` returns
 * @param {() => object} options.health what `/healthz` returns
 */
export function createHttpServer({ root, info, health }) {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') return json(res, 200, health());
      if (pathname === '/api/info') return json(res, 200, info());

      // normalize() collapses "..", so a path that still starts with the root is inside it.
      const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
      let file = join(root, relative);
      if (file !== root && !file.startsWith(root + sep)) return json(res, 404, { error: 'Not found' });
      let found = await stat(file).catch(() => null);
      if (found?.isDirectory()) {
        file = join(file, 'index.html');
        found = await stat(file).catch(() => null);
      }
      if (!found?.isFile()) return json(res, 404, { error: 'Not found' });

      const fonts = file.endsWith('.woff2');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': found.size,
        'Cache-Control': fonts ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      // pipeline() closes the file when the client goes away mid-download.
      pipeline(createReadStream(file), res, () => {});
    } catch {
      if (!res.headersSent) json(res, 400, { error: 'Bad request' });
      else res.destroy();
    }
  });
}
