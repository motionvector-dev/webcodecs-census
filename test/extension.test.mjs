/**
 * Patch mode is the no-permissions fallback, and its worth depends entirely on
 * whether the `Worker` rewrite actually lands. If it silently fails, the popup
 * shows a clean page for a leaking one.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { CdpClient, findPageTarget, launchChrome } from '../packages/cdp/dist/index.js';
import { serveFixtures, findChrome, waitFor } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../extension/dist');
const chromePath = findChrome();
const skip = !chromePath
  ? 'no Chrome for Testing found'
  : !existsSync(EXT)
    ? 'extension not built — run `npm run build` in extension/'
    : false;

describe('extension patch mode', { skip }, () => {
  let fixtures;
  let chrome;
  let client;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({
      executablePath: chromePath,
      port: 9335,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    const target = await findPageTarget(chrome.browserURL);
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.navigate', { url: fixtures.origin + '/' });
    await waitFor(async () => {
      const r = await client.send('Runtime.evaluate', {
        expression: 'window.__messages?.length ?? 0',
        returnByValue: true,
      });
      return r.result.value >= 1;
    }, { timeoutMs: 15_000 });
  });

  after(async () => {
    client?.close();
    await chrome?.kill();
    fixtures?.close();
  });

  test('the content script installs the census in the page world', async () => {
    const r = await client.send('Runtime.evaluate', {
      expression: 'typeof window.__webcodecsCensus',
      returnByValue: true,
    });
    assert.equal(r.result.value, 'function', 'no census in the page — the injected tag did not run');
  });

  test('the page census sees the main-thread allocation', async () => {
    const r = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__webcodecsCensus.local())',
      returnByValue: true,
    });
    const census = JSON.parse(r.result.value);
    assert.ok((census.live.VideoFrame ?? 0) >= 1, 'page census missed the main-thread frame');
  });

  test('rewrites Worker so the worker is instrumented too', async () => {
    const messages = JSON.parse(
      (
        await client.send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__messages)',
          returnByValue: true,
        })
      ).result.value,
    );
    const ready = messages.find((m) => m.ready);
    assert.ok(ready, 'worker never reported ready');
    assert.equal(ready.instrumented, true, 'Worker rewrite did not install the census in the worker');
  });

  test('reports how many workers it wrapped, and any it could not', async () => {
    const r = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify(globalThis[Symbol.for('unfoundbox.webcodecs-census.worker-patch')] ?? null)`,
      returnByValue: true,
    });
    const state = JSON.parse(r.result.value);
    assert.ok(state, 'no worker-patch state recorded');
    assert.equal(state.wrapped, 1, `expected 1 wrapped worker, got ${state.wrapped}`);
    assert.deepEqual(state.skipped, [], `unexpected skips: ${JSON.stringify(state.skipped)}`);
  });
});
