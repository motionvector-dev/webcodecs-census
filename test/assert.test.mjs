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
function census({
  context = 'main',
  live = {},
  liveAges = {},
  collectedUnclosed = {},
  leakSites = [],
  overCloses = [],
} = {}) {
  return {
    context,
    uptimeMs: 30_000,
    entered: {},
    left: {},
    live,
    liveAges,
    liveAgesCap: 256,
    collectedUnclosed,
    overCloses,
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

describe('minAgeMs reaches the verdict, not just the reported sites', () => {
  // Five frames: two held a long time, three that only just arrived.
  const inFlight = () => [
    census({
      live: { VideoFrame: 5 },
      liveAges: { VideoFrame: [5000, 4000, 40, 30, 20] },
      leakSites: [site('VideoFrame', 5)],
    }),
  ];

  test('young objects are excluded from the count that decides ok', () => {
    const report = checkLeaks(inFlight(), { minAgeMs: 1000, allow: { VideoFrame: 2 } });
    assert.equal(report.live.VideoFrame, 2, 'only the two old frames should count');
    assert.equal(report.ok, true);
    assert.equal(report.minAgeMsApplied, true);
  });

  test('and old ones still fail it', () => {
    const report = checkLeaks(inFlight(), { minAgeMs: 1000 });
    assert.equal(report.ok, false);
    assert.match(report.message, /2 VideoFrame still live \(allowed 0, at least 1000ms old\)/);
  });

  test('a threshold above everything live is clean', () => {
    const report = checkLeaks(inFlight(), { minAgeMs: 10_000 });
    assert.equal(report.ok, true);
    assert.equal(report.live.VideoFrame ?? 0, 0);
  });

  test('without minAgeMs nothing is filtered', () => {
    const report = checkLeaks(inFlight());
    assert.equal(report.live.VideoFrame, 5);
    assert.equal(report.minAgeMsApplied, false);
  });

  test('a census with no ages says so instead of ignoring the option', () => {
    const old = [census({ live: { VideoFrame: 5 }, leakSites: [site('VideoFrame', 5)] })];
    delete old[0].liveAges;
    const report = checkLeaks(old, { minAgeMs: 1000 });

    assert.equal(report.minAgeMsApplied, false, 'it cannot have been applied');
    assert.equal(report.live.VideoFrame, 5, 'unfiltered — never fewer than the truth');
    assert.equal(report.ok, false);
    assert.match(report.message, /minAgeMs=1000 was NOT applied in: main/);
  });

  test('a saturated cap is a lower bound, and says so rather than over-claiming', () => {
    const capped = [
      census({
        live: { VideoFrame: 9000 },
        // What a real census carries: the oldest 256, every one of them old.
        liveAges: { VideoFrame: Array.from({ length: 256 }, (_, i) => 60_000 - i) },
        leakSites: [site('VideoFrame', 9000)],
      }),
    ];
    const report = checkLeaks(capped, { minAgeMs: 1000 });

    assert.equal(report.ok, false, 'a 9000-frame leak must fail');
    assert.equal(report.live.VideoFrame, 256, 'the claim is a bound, not the total');
    assert.equal(report.liveBounded.VideoFrame, 9000, 'the exact total is still carried');
    assert.match(report.message, /at least 256 VideoFrame still live/);
    assert.match(report.message, /9000 live in total/);
  });

  test('below saturation the count is exact, because the oldest are kept', () => {
    // 300 live, the oldest 256 reported: 3 clear the bar, so everything the
    // census dropped is younger than the 4th-oldest and cannot clear it.
    const ages = [9000, 8000, 7000, ...Array.from({ length: 253 }, () => 10)];
    const report = checkLeaks(
      [census({ live: { VideoFrame: 300 }, liveAges: { VideoFrame: ages } })],
      { minAgeMs: 1000 },
    );
    assert.equal(report.live.VideoFrame, 3);
    assert.equal(report.liveBounded.VideoFrame, undefined, 'not a bound — this one is exact');
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
