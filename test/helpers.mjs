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

export const waitFor = async (fn, { timeoutMs = 5000, everyMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
};
