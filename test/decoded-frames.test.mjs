/**
 * Decoded frames are the ones that actually leak in production, and they never
 * pass through a JS constructor — the platform creates them and hands them to
 * the codec's output callback. An instrument that only traps `new VideoFrame()`
 * reports a clean bill of health for a pipeline that is losing every frame.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attach, launchChrome } from '../packages/cdp/dist/index.js';
import { checkLeaks } from '../packages/core/dist/index.js';
import { serveFixtures, findChrome, waitFor } from './helpers.mjs';

const chromePath = findChrome();

describe('decoded frames', { skip: chromePath ? false : 'no Chrome for Testing found' }, () => {
  let fixtures;
  let chrome;
  let session;
  let result;
  let workerCensus;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({ executablePath: chromePath, port: 9334 });
    session = await attach({ browserURL: chrome.browserURL, install: { sampleIntervalMs: 100 } });
    await session.navigate(fixtures.origin + '/roundtrip.html');

    result = JSON.parse(
      await waitFor(async () => await session.evaluate('window.__done && JSON.stringify(window.__done)'), {
        timeoutMs: 20_000,
      }),
    );
    const all = await session.census();
    workerCensus = all.find((c) => /worker/i.test(c.targetType));
  });

  after(async () => {
    session?.detach();
    await chrome?.kill();
    fixtures?.close();
  });

  test('the fixture really encoded and decoded', () => {
    assert.ok(!result.error, `codec error: ${result.error}`);
    assert.ok(result.encoded > 0, 'nothing was encoded');
    assert.ok(result.decodedSeen > 0, 'nothing was decoded');
    assert.ok(result.expectedLeak > 0, 'fixture was supposed to leak some frames');
  });

  test('counts frames the platform produced, not just constructed ones', () => {
    assert.ok(workerCensus, 'no worker census');
    const decoded = workerCensus.entered['VideoFrame:decoded'] ?? 0;
    assert.equal(
      decoded,
      result.decodedSeen,
      `census saw ${decoded} decoded frames, the worker saw ${result.decodedSeen}`,
    );
  });

  test('live count matches exactly the frames the fixture failed to close', () => {
    assert.equal(
      workerCensus.live.VideoFrame ?? 0,
      result.expectedLeak,
      `expected ${result.expectedLeak} leaked frames, census says ${workerCensus.live.VideoFrame}`,
    );
  });

  test('blames the decoder that produced the frames', () => {
    const site = workerCensus.leakSites.find((s) => s.origin === 'decoded');
    assert.ok(site, 'no leak site for decoded frames');
    assert.equal(site.count, result.expectedLeak);
    assert.match(
      site.stack,
      /roundtrip-worker\.js/,
      `stack should point at the decoder's construction site, got:\n${site.stack}`,
    );
    assert.match(site.stack, /emitted by this VideoDecoder/);
  });

  test('source frames that were closed properly are not reported', () => {
    // The fixture constructs COUNT frames for the encoder and closes them all.
    const constructed = workerCensus.entered['VideoFrame:constructed'] ?? 0;
    const closed = workerCensus.left['VideoFrame:closed'] ?? 0;
    assert.ok(constructed >= 10, `expected the encoder source frames, saw ${constructed}`);
    assert.ok(closed >= constructed, 'constructed frames should all have been closed');
  });

  test('reports the leak as a failing check', () => {
    const report = checkLeaks([workerCensus], { types: ['VideoFrame'] });
    assert.equal(report.ok, false);
    assert.match(report.message, /VideoFrame/);
  });
});
