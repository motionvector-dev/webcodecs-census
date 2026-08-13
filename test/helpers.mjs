import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

/** Serves test/fixtures. Workers need a real origin, so file:// will not do. */
export async function serveFixtures(port = 0) {
  const server = createServer(async (req, res) => {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const body = await readFile(join(HERE, 'fixtures', path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return { server, origin: `http://127.0.0.1:${actual}`, close: () => server.close() };
}

/**
 * Chrome for Testing from the local Puppeteer cache. Never the user's own
 * Chrome — instrumenting that would touch their profile and their session.
 */
export function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const base = join(process.env.HOME ?? '', '.cache/puppeteer/chrome');
  if (!existsSync(base)) return null;
  const builds = readdirSync(base).sort().reverse();
  for (const b of builds) {
    for (const candidate of [
      join(base, b, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      join(base, b, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      join(base, b, 'chrome-linux64/chrome'),
      join(base, b, 'chrome-win64/chrome.exe'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Serve one file with Range support. Media pipelines issue range requests and
 * a server that ignores them either stalls or hands back the whole file for
 * every seek, which changes the behaviour being measured.
 */
export async function serveFile(path, contentType = 'video/mp4') {
  const { createReadStream, statSync } = await import('node:fs');
  const size = statSync(path).size;

  // When this stands in for a cross-origin asset the page still applies CORS to
  // it, so the headers have to be permissive or the fetch fails with ERR_FAILED
  // and the app simply waits forever.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'content-length,content-range,accept-ranges',
  };

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET,HEAD,OPTIONS' });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        ...cors,
        'content-length': size,
        'content-type': contentType,
        'accept-ranges': 'bytes',
      });
      createReadStream(path).pipe(res);
      return;
    }
    const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
    const start = Number(startRaw);
    const end = endRaw ? Number(endRaw) : size - 1;
    res.writeHead(206, {
      ...cors,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': contentType,
    });
    createReadStream(path, { start, end }).pipe(res);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/media.mp4`,
    close: () => server.close(),
  };
}

/**
 * Chrome's sandbox needs privileges a CI container usually will not grant, and
 * the failure is an opaque early exit rather than a message about sandboxing.
 */
export const ciArgs = () => (process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []);

export const waitFor = async (fn, { timeoutMs = 5000, everyMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
};
