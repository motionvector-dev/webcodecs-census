/**
 * The claim this project rests on: instrumentation reaches a Web Worker before
 * its first line, and sees frames the platform produced rather than JS
 * constructed. If these fail, the tool is reporting "no leaks" because it
 * cannot see, which is worse than not existing.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attach, launchChrome } from '../packages/cdp/dist/index.js';
import { checkLeaks, summarize } from '../packages/core/dist/index.js';
import { serveFixtures, findChrome, waitFor } from './helpers.mjs';

const chromePath = findChrome();

describe('worker injection over CDP', { skip: chromePath ? false : 'no Chrome for Testing found' }, () => {
  let fixtures;
  let chrome;
  let session;
  let contexts = [];

  before(async () => {
    fixtures = await serveFixtures();
    chrome = await launchChrome({ executablePath: chromePath, port: 9333 });
    session = await attach({
      browserURL: chrome.browserURL,
      install: { sampleIntervalMs: 100, keepSamples: 100 },
      onContext: (c) => contexts.push(c),
    });
    await session.navigate(fixtures.origin + '/');
    await waitFor(async () => (await session.evaluate('window.__messages?.length')) >= 1);
  });

  after(async () => {
    session?.detach();
    await chrome?.kill();
    fixtures?.close();
  });

  test('instruments the page and the module worker', async () => {
    const types = session.contexts().map((c) => c.type).sort();
    assert.ok(types.includes('page'), `expected a page context, got ${types.join(', ')}`);
    assert.ok(
      types.some((t) => /worker/i.test(t)),
      `expected a worker context, got ${types.join(', ')}`,
    );
  });

  test('the shim is installed inside the worker, before its first line', async () => {
    const messages = await session.evaluate('JSON.stringify(window.__messages)');
    const ready = JSON.parse(messages).find((m) => m.ready);
    assert.ok(ready, 'worker never reported ready');
    assert.equal(ready.instrumented, true, 'worker had no census installed');
    assert.equal(
      ready.sawLineOneAllocation,
      true,
      'census missed the VideoFrame allocated on line 1 — injection was late',
    );
  });

  test('counts the main-thread leak and does not blame the transferred frame', async () => {
    const all = await session.census();
    const page = all.find((c) => c.context === 'main');
    assert.ok(page, 'no page census');

    // index.html constructs two frames: one kept, one transferred away.
    assert.equal(page.live.VideoFrame, 1, 'transferred frame should not count as live here');
    assert.ok(
      (page.left['VideoFrame:transferred'] ?? 0) >= 1,
      `expected a transferred VideoFrame, saw ${JSON.stringify(page.left)}`,
    );
  });

  test('attributes every live object to an allocation stack', async () => {
    const all = await session.census();
    const withLive = all.filter((c) => Object.values(c.live).some(Boolean));
    assert.ok(withLive.length > 0, 'nothing live anywhere — fixture did not run');
    for (const c of withLive) {
      assert.ok(c.leakSites.length > 0, `${c.context} has live objects but no leak sites`);
      for (const site of c.leakSites) {
        assert.ok(site.stack.length > 0, `${c.context}: a leak site has an empty stack`);
        assert.ok(
          !site.stack.includes('webcodecs-census-shim'),
          'stack was not filtered — it points at the census, not the caller',
        );
      }
    }
  });

  test('records a rolling timeline, not just a snapshot', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const all = await session.census();
    const sampled = all.find((c) => c.timeline.length > 1);
    assert.ok(sampled, 'no context produced more than one sample');
    const [a, b] = sampled.timeline;
    assert.ok(b.t > a.t, 'samples are not ordered in time');
    assert.ok('activity' in b && 'mediaElements' in b, 'sample is missing its correlation fields');
  });

  test('checkLeaks turns the census into a failing assertion', async () => {
    const all = await session.census();
    const report = checkLeaks(all, { types: ['VideoFrame'] });
    assert.equal(report.ok, false, 'fixture leaks on purpose; report said it was clean');
    assert.match(report.message, /VideoFrame/);
    assert.ok(report.sites.length > 0, 'no sites attributed');
    assert.ok(summarize(all).includes('context'), 'summary is not agent-readable');
  });
});
