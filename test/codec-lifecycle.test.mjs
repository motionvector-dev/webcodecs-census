/**
 * Codec lifecycle, both directions, measured rather than assumed.
 *
 * A codec that fails is closed by the platform: the spec's Close algorithm sets
 * `[[state]]` to "closed" before it invokes the error callback, so no `close()`
 * call is ever made. Counted naively that codec stays live forever and is
 * eventually filed as "garbage collected without close()" — a definitive leak
 * report for a resource the platform already reclaimed. A leak detector that
 * invents leaks is worse than one that stays quiet.
 *
 * The mirror image: closing an already-closed codec throws InvalidStateError,
 * which from a floating `.finally()` becomes an unhandled rejection no
 * application code can catch. The census sees that call and nothing else does.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attach, launchChrome } from '../packages/cdp/dist/index.js';
import { checkLeaks } from '../packages/core/dist/index.js';
import { serveFixtures, findChrome, waitFor, ciArgs } from './helpers.mjs';

const chromePath = findChrome();

describe('codec lifecycle', { skip: chromePath ? false : 'no Chrome for Testing found' }, () => {
  let fixtures;
  let chrome;
  let session;
  let done;
  let census;

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({
      executablePath: chromePath,
      // --expose-gc so the finalizer path can be driven rather than waited on.
      args: [...ciArgs(), '--js-flags=--expose-gc'],
    });
    // Sampling deliberately far apart: a sample tick also reconciles codec
    // state, and a fast one would let the census pass this suite by luck on a
    // machine where the tick beats the GC. It did exactly that locally while
    // failing on Linux CI. With the sampler out of reach, only reconciliation
    // at the error callback can save it.
    session = await attach({ browserURL: chrome.browserURL, install: { sampleIntervalMs: 30_000 } });
    await session.navigate(fixtures.origin + '/codec-lifecycle.html');

    done = JSON.parse(
      await waitFor(async () => await session.evaluate('window.__done && JSON.stringify(window.__done)'), {
        timeoutMs: 20_000,
      }),
    );

    // Collect what the fixture dropped, so a codec the platform closed has its
    // chance to be filed as collectedUnclosed if the census got this wrong.
    await session.evaluate('window.gc && window.gc()');
    await new Promise((r) => setTimeout(r, 500));
    [census] = await session.census();
  });

  after(async () => {
    session?.detach();
    await chrome?.kill();
    fixtures?.close();
  });

  test('the fixture really provoked the platform, not a JS close', () => {
    assert.ok(!done.error, `fixture failed: ${done.error}`);
    assert.equal(done.platformClosed.state, 'closed', 'the platform never closed the failing codec');
    assert.ok(done.platformClosed.errors >= 1, 'no error callback fired');
    assert.equal(done.platformClosed.closedByJs, false);
  });

  test('a platform close is a release, not a leak', () => {
    assert.equal(
      census.live.VideoDecoder ?? 0,
      0,
      `census still counts ${census.live.VideoDecoder} VideoDecoder live after the platform closed it`,
    );
    assert.ok(
      (census.left['VideoDecoder:closedByPlatform'] ?? 0) >= 1,
      `expected a closedByPlatform fate, got ${JSON.stringify(census.left)}`,
    );
  });

  test('and is never reported as garbage collected without close()', () => {
    assert.equal(
      census.collectedUnclosed.VideoDecoder ?? 0,
      0,
      'a codec the platform reclaimed was reported as a definitive leak',
    );
  });

  test('the verdict on that run is clean, under every type', () => {
    const report = checkLeaks([census], { types: 'all' });
    assert.equal(report.ok, true, `expected a clean verdict, got:\n${report.message}`);
  });

  test('a close() that threw is counted, with the line that called it', () => {
    assert.equal(done.overClose.threw, true, 'Chrome no longer throws on a double codec close');
    const site = census.overCloses.find((o) => o.type === 'VideoDecoder');
    assert.ok(site, `no over-close recorded, got ${JSON.stringify(census.overCloses)}`);
    assert.equal(site.count, 1);
    assert.match(site.message, /closed codec/i);
    assert.match(site.stack, /codec-lifecycle\.html/, `stack should name the caller:\n${site.stack}`);
  });

  test('an over-close is reported but does not fail a leak check by itself', () => {
    const quiet = checkLeaks([census], { types: 'all' });
    assert.equal(quiet.ok, true);
    assert.match(quiet.message, /close\(\) call\(s\) threw/);

    const strict = checkLeaks([census], { types: 'all', failOnOverClose: true });
    assert.equal(strict.ok, false, 'failOnOverClose did not fail');
  });
});
