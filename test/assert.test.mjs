/**
 * The verdict layer, on synthetic censuses. No browser: the point is what
 * `checkLeaks` does with numbers, and a GC'd-unclosed decoder is not something
 * a test can make Chrome produce on demand.
 *
 * Found by dogfooding, 2026-08-17: a run that ended with 47 live VideoDecoders
 * and ~10 collected without close() printed "No leaked WebCodecs objects."
 * The shim saw all of it. The default `types` filter threw it away.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkLeaks, expectNoLeaks, summarize, TRACKED } from '../packages/core/dist/index.js';

/** A census with only the fields the verdict layer reads. */
function census({ context = 'main', live = {}, collectedUnclosed = {}, leakSites = [] } = {}) {
  return {
    context,
    uptimeMs: 30_000,
    entered: {},
    left: {},
    live,
    collectedUnclosed,
    closedUnseen: 0,
    leakSites,
    oldestLive: [],
    mediaElements: { total: 0, stalled: 0, byReadyState: {} },
    timeline: [],
    problems: [],
  };
}

const site = (type, count) => ({
  type,
  origin: 'constructed',
  stack: `    at leakOne (app.js:1:1)`,
  count,
  oldestAgeMs: 5_000,
});

describe('a leaking VideoDecoder under the default types', () => {
  const leaked = [
    census({
      live: { VideoDecoder: 47 },
      collectedUnclosed: { VideoDecoder: 10 },
      leakSites: [site('VideoDecoder', 47)],
    }),
  ];

  test('a decoder collected without close() fails whatever types says', () => {
    const report = checkLeaks(leaked);
    assert.equal(report.ok, false, `verdict was clean:\n${report.message}`);
    assert.equal(report.collectedUnclosed.VideoDecoder, 10);
    assert.match(report.message, /10 VideoDecoder garbage collected without close\(\)/);
  });

  test('the same holds for a type nobody asked about at all', () => {
    const report = checkLeaks([census({ collectedUnclosed: { AudioEncoder: 3 } })], {
      types: ['VideoFrame'],
    });
    assert.equal(report.ok, false, `verdict was clean:\n${report.message}`);
    assert.throws(() => expectNoLeaks([census({ collectedUnclosed: { AudioEncoder: 3 } })]), /AudioEncoder/);
  });

  test('live decoders are still not enforced by default — but never reported as clean', () => {
    const live = [census({ live: { VideoDecoder: 47 }, leakSites: [site('VideoDecoder', 47)] })];
    const report = checkLeaks(live);

    assert.equal(report.ok, true, 'a live decoder is normal; the default must not fail on it');
    assert.equal(report.unenforcedLive.VideoDecoder, 47);
    assert.doesNotMatch(
      report.message,
      /^No leaked WebCodecs objects\.$/,
      'an unqualified all-clear next to 47 live decoders is the bug',
    );
    assert.match(report.message, /VideoDecoder=47/);
    assert.match(summarize(live), /VideoDecoder=47/);
  });

  test("types: 'all' enforces every tracked type", () => {
    const report = checkLeaks([census({ live: { VideoDecoder: 47 } })], { types: 'all' });
    assert.equal(report.ok, false);
    assert.deepEqual(report.enforced, [...TRACKED]);
    assert.equal(report.live.VideoDecoder, 47);
    assert.match(report.message, /47 VideoDecoder still live/);
  });

  test("types: 'all' surfaces the codec's allocation site", () => {
    const report = checkLeaks(
      [census({ live: { VideoDecoder: 47 }, leakSites: [site('VideoDecoder', 47)] })],
      { types: 'all' },
    );
    assert.equal(report.sites.length, 1);
    assert.equal(report.sites[0].type, 'VideoDecoder');
  });
});

describe('the clean case stays clean', () => {
  test('nothing live, nothing collected', () => {
    const report = checkLeaks([census()]);
    assert.equal(report.ok, true);
    assert.equal(report.message, 'No leaked WebCodecs objects.');
  });

  test('frames within their allowance', () => {
    const report = checkLeaks([census({ live: { VideoFrame: 2 } })], { allow: { VideoFrame: 2 } });
    assert.equal(report.ok, true);
    assert.equal(report.message, 'No leaked WebCodecs objects.');
  });

  test('leaked frames still fail, and still say where', () => {
    const report = checkLeaks([
      census({ live: { VideoFrame: 5 }, leakSites: [site('VideoFrame', 5)] }),
    ]);
    assert.equal(report.ok, false);
    assert.match(report.message, /5 VideoFrame still live \(allowed 0\)/);
    assert.match(report.message, /Held by:/);
  });
});
