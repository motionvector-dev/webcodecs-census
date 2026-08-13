/**
 * Does the census see codecs created inside a library, rather than by the app?
 *
 * mediabunny is a WebCodecs toolkit: applications using it never write
 * `new VideoDecoder`, so an instrument that only catches what the application
 * constructs would report a clean bill of health for every mediabunny user.
 *
 * It also has a documented double-ownership rule — a VideoFrame taken from a
 * VideoSample "must be closed separately from this video sample" — which is a
 * silent leak the moment someone closes the sample and forgets the frame. That
 * is the mistake the fixture makes on purpose.
 *
 * Two things make this work, and both are load-bearing:
 *   - mediabunny references the codec globals at call time, never capturing
 *     them at module scope, so patching them afterwards is still seen.
 *   - injection happens before the worker's first line, so a library that
 *     builds a decoder during module initialisation is still caught.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, launchChrome } from '../packages/cdp/dist/index.js';
import { checkLeaks } from '../packages/core/dist/index.js';
import { serveFixtures, findChrome, waitFor, ciArgs } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, 'fixtures/mediabunny-worker.js');
const chromePath = findChrome();
const skip = !chromePath
  ? 'no Chrome found'
  : !existsSync(BUNDLE)
    ? 'fixture not bundled — run `npm run build:fixtures`'
    : false;

describe('mediabunny integration', { skip }, () => {
  let fixtures;
  let chrome;
  let session;
  let result;
  let workerCensus;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({ executablePath: chromePath, args: ciArgs() });
    session = await attach({ browserURL: chrome.browserURL, install: { sampleIntervalMs: 150 } });
    await session.navigate(fixtures.origin + '/mediabunny.html');

    result = JSON.parse(
      await waitFor(
        async () => await session.evaluate('window.__done && JSON.stringify(window.__done)'),
        { timeoutMs: 60_000 },
      ),
    );
    const all = await session.census();
    workerCensus = all.find((c) => /worker/i.test(c.targetType));
  });

  after(async () => {
    session?.detach();
    await chrome?.kill();
    fixtures?.close();
  });

  test('mediabunny really encoded and decoded', () => {
    assert.ok(!result.error, `fixture failed: ${result.error}`);
    assert.ok(result.bytes > 0, 'no MP4 was produced');
    assert.ok(result.samples > 0, 'no samples were decoded');
    assert.ok(result.expectedLeak > 0, 'the fixture was supposed to leak frames');
  });

  test('the census is installed in the worker mediabunny runs in', () => {
    assert.equal(result.instrumented, true, 'no census in the mediabunny worker');
    assert.ok(workerCensus, 'no worker census returned');
  });

  test('sees the decoder mediabunny created, which the app never constructed', () => {
    const decoders =
      (workerCensus.entered['VideoDecoder:constructed'] ?? 0) +
      (workerCensus.entered['VideoEncoder:constructed'] ?? 0);
    assert.ok(
      decoders > 0,
      'no codecs counted — mediabunny builds them internally, so this is the ' +
        'case where an app-only instrument reports nothing. ' +
        `entered: ${JSON.stringify(workerCensus.entered)}`,
    );
  });

  test('catches frames leaked through the sample/frame ownership split', () => {
    const live = workerCensus.live.VideoFrame ?? 0;
    assert.ok(
      live >= result.expectedLeak,
      `fixture leaked ${result.expectedLeak} frames via toVideoFrame(); census sees ${live}`,
    );
  });

  test('attributes the leak to a mediabunny call site', () => {
    const report = checkLeaks([workerCensus], { types: ['VideoFrame'] });
    assert.equal(report.ok, false, 'fixture leaks on purpose; report said it was clean');
    const site = report.sites[0];
    assert.ok(site, 'no site attributed');
    assert.ok(site.stack.length > 0, 'attributed site has no stack');
    assert.ok(
      !site.stack.includes('webcodecs-census-shim'),
      'stack points at the census rather than the caller',
    );
  });
});
