/**
 * The undocumented Chrome behaviour this project is built on.
 *
 * The two-phase injection is not derived from a spec — it was measured on
 * Chrome 151, and Chrome is free to change it. If it does, every other test
 * fails in a way that looks like our bug. These tests fail in a way that says
 * which platform assumption moved, and prints the measurement.
 *
 * Run against Chrome stable on a schedule. A failure here is a heads-up, not
 * necessarily a defect.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CdpClient, findPageTarget, launchChrome } from '../packages/cdp/dist/index.js';
import { serveFixtures, findChrome, ciArgs } from './helpers.mjs';

const chromePath = findChrome();

const PROBE = `JSON.stringify(${JSON.stringify([
  'VideoFrame',
  'AudioData',
  'ImageBitmap',
  'EncodedVideoChunk',
  'VideoDecoder',
  'VideoEncoder',
  'AudioDecoder',
  'AudioEncoder',
  'setInterval',
  'setTimeout',
  'queueMicrotask',
  'Promise',
])}.reduce((a, k) => (a[k] = typeof globalThis[k], a), {}))`;

describe('platform assumptions', { skip: chromePath ? false : 'no Chrome found' }, () => {
  let fixtures;
  let chrome;
  let client;
  let version = '';
  const measured = { autoAttach: null, beforeScript: null };
  let instrumentationSupported = false;
  let sawWaitingForDebugger = false;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({ executablePath: chromePath, args: ciArgs() });
    version = (await (await fetch(`${chrome.browserURL}/json/version`)).json()).Browser;

    client = await CdpClient.connect((await findPageTarget(chrome.browserURL)).webSocketDebuggerUrl);
    const pending = new Set();

    client.on(async (msg) => {
      if (msg.method === 'Target.attachedToTarget' && /worker/i.test(msg.params.targetInfo.type)) {
        const s = msg.params.sessionId;
        sawWaitingForDebugger ||= msg.params.waitingForDebugger === true;
        await client.trySend('Runtime.enable', {}, s);

        const at = await client.trySend('Runtime.evaluate', { expression: PROBE, returnByValue: true }, s);
        measured.autoAttach ??= JSON.parse(at?.result?.value ?? 'null');

        const enabled = await client.trySend('Debugger.enable', {}, s);
        const bp = enabled
          ? await client.trySend('Debugger.setInstrumentationBreakpoint', {
              instrumentation: 'beforeScriptExecution',
            }, s)
          : null;
        instrumentationSupported ||= Boolean(bp?.breakpointId);
        if (bp) pending.add(s);

        await client.trySend('Runtime.runIfWaitingForDebugger', {}, s);
      }

      if (msg.method === 'Debugger.paused' && pending.has(msg.sessionId)) {
        const s = msg.sessionId;
        pending.delete(s);
        const at = await client.trySend('Runtime.evaluate', { expression: PROBE, returnByValue: true }, s);
        measured.beforeScript ??= JSON.parse(at?.result?.value ?? 'null');
        await client.trySend('Debugger.resume', {}, s);
        await client.trySend('Debugger.disable', {}, s);
      }
    });

    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: fixtures.origin + '/' });

    const deadline = Date.now() + 15_000;
    while ((!measured.autoAttach || !measured.beforeScript) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  after(async () => {
    client?.close();
    await chrome?.kill();
    fixtures?.close();

    const row = (label, m) =>
      m ? `  ${label}: ${Object.entries(m).map(([k, v]) => `${k}=${v === 'function' ? 'y' : 'n'}`).join(' ')}` : `  ${label}: not measured`;
    console.log(`\nplatform measurement — ${version}`);
    console.log(row('at auto-attach pause  ', measured.autoAttach));
    console.log(row('at beforeScriptExecution', measured.beforeScript));
  });

  test('a worker can still be paused before its first line', () => {
    assert.equal(
      sawWaitingForDebugger,
      true,
      'Target.setAutoAttach no longer reports waitingForDebugger for workers — ' +
        'the whole early-injection approach depends on this.',
    );
  });

  test('the beforeScriptExecution instrumentation breakpoint still exists', () => {
    assert.equal(
      instrumentationSupported,
      true,
      'Debugger.setInstrumentationBreakpoint({beforeScriptExecution}) was rejected. ' +
        'This is the only pause point that is both complete and early enough.',
    );
  });

  test('every global we patch exists at beforeScriptExecution', () => {
    assert.ok(measured.beforeScript, 'never reached the beforeScriptExecution pause');
    const missing = Object.entries(measured.beforeScript)
      .filter(([, v]) => v !== 'function')
      .map(([k]) => k);
    assert.deepEqual(
      missing,
      [],
      `these are undefined at the injection point, so they will not be instrumented: ${missing.join(', ')}`,
    );
  });

  test('the auto-attach pause is still too early, which is why phase two exists', () => {
    assert.ok(measured.autoAttach, 'never measured the auto-attach pause');
    const codecsPresent = ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder'].filter(
      (k) => measured.autoAttach[k] === 'function',
    );

    // Not a defect if this changes — it would mean injection could be simplified
    // to a single pause. Fail anyway so nobody has to rediscover it by accident.
    assert.deepEqual(
      codecsPresent,
      [],
      `GOOD NEWS, probably: ${codecsPresent.join(', ')} now exist at the auto-attach pause. ` +
        'Chrome used to install codecs later, which is the only reason this project ' +
        'resumes into a second breakpoint. Re-check whether phase two is still needed.',
    );
  });
});
