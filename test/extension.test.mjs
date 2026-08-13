/**
 * Two things worth testing about the extension.
 *
 * First, that it does nothing until asked. It ships `optional_host_permissions`
 * and registers content scripts per origin at runtime, so a freshly installed
 * copy must not patch WebCodecs or expose the census on a site the user has not
 * opted in. An earlier version declared content scripts on <all_urls>, which
 * instrumented every page the user ever visited; this test exists so that
 * cannot come back unnoticed.
 *
 * Second, that the code the content script runs actually works — the Worker
 * rewrite in particular, because patch mode is worthless if it silently fails.
 * That is exercised by injecting the same bundle the content script registers,
 * which avoids driving Chrome's permission dialog in CI while still covering
 * the logic.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

import { CdpClient, findPageTarget, launchChrome } from '../packages/cdp/dist/index.js';
import { serveFixtures, findChrome, waitFor, ciArgs } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../extension/dist');
const chromePath = findChrome();
const skip = !chromePath
  ? 'no Chrome for Testing found'
  : !existsSync(EXT)
    ? 'extension not built — run `npm run build:extension`'
    : false;

describe('extension', { skip }, () => {
  let fixtures;
  let chrome;
  let client;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({
      executablePath: chromePath,
      args: [...ciArgs(), `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    client = await CdpClient.connect((await findPageTarget(chrome.browserURL)).webSocketDebuggerUrl);
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

  test('the manifest asks for no host access up front', () => {
    const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
    assert.equal(
      manifest.host_permissions,
      undefined,
      'host_permissions would grant access to sites without the user choosing them',
    );
    assert.equal(
      manifest.content_scripts,
      undefined,
      'a declared content_scripts block runs on every matching site from install; ' +
        'registration must be per origin, at runtime, after the user opts in',
    );
    assert.ok(
      manifest.optional_host_permissions?.length,
      'the opt-in flow needs optional host permissions to request',
    );
  });

  test('an un-opted-in page is left completely alone', async () => {
    const probe = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        census: typeof window.__webcodecsCensus,
        patched: !!(VideoFrame && VideoFrame.__wccPatched),
        workerPatch: !!globalThis[Symbol.for('motionvector.webcodecs-census.worker-patch')],
      })`,
      returnByValue: true,
    });
    const state = JSON.parse(probe.result.value);
    assert.equal(state.census, 'undefined', 'census API exposed without the user opting in');
    assert.equal(state.patched, false, 'VideoFrame patched without the user opting in');
    assert.equal(state.workerPatch, false, 'Worker rewritten without the user opting in');
  });

  test('the worker got no census either', async () => {
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
    assert.equal(ready.instrumented, false, 'worker instrumented without the user opting in');
  });

  test('the registered bundle installs the census and rewrites Worker', async () => {
    // The same file sites.js registers as a MAIN-world content script.
    const bundle = readFileSync(join(EXT, 'src/shim.global.js'), 'utf8');
    await client.send('Page.navigate', { url: fixtures.origin + '/' });
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle });
    await client.send('Page.reload');
    await waitFor(async () => {
      const r = await client.send('Runtime.evaluate', {
        expression: 'window.__messages?.length ?? 0',
        returnByValue: true,
      });
      return r.result.value >= 1;
    }, { timeoutMs: 15_000 });

    const messages = JSON.parse(
      (
        await client.send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__messages)',
          returnByValue: true,
        })
      ).result.value,
    );
    assert.equal(
      messages.find((m) => m.ready)?.instrumented,
      true,
      'Worker rewrite did not install the census in the worker',
    );

    const state = JSON.parse(
      (
        await client.send('Runtime.evaluate', {
          expression: `JSON.stringify(globalThis[Symbol.for('motionvector.webcodecs-census.worker-patch')] ?? null)`,
          returnByValue: true,
        })
      ).result.value,
    );
    assert.ok(state, 'no worker-patch state recorded');
    assert.equal(state.wrapped, 1, `expected 1 wrapped worker, got ${state.wrapped}`);
    assert.deepEqual(state.skipped, [], `unexpected skips: ${JSON.stringify(state.skipped)}`);
  });
});
