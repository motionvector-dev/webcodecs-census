/**
 * Point the census at a real application and print what it finds.
 *
 * Not a unit test — a harness for pointing the tool at something it knows
 * nothing about, which is the only way to find out whether it can instrument
 * a build it did not help design.
 *
 *   node test/validate-app.mjs http://localhost:5173/ --seconds=30
 *   node test/validate-app.mjs http://localhost:5173/ --headed
 *   node test/validate-app.mjs http://localhost:5173/ --redirect='cdn.example.com/big.mp4,/path/to/local.mp4'
 */

import { attach, launchChrome } from '../packages/cdp/dist/index.js';
import { summarize } from '../packages/core/dist/index.js';
import { findChrome, serveFile } from './helpers.mjs';

const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 20);
const headed = process.argv.includes('--headed');

const chromePath = findChrome();
if (!chromePath) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(1);
}

const chrome = await launchChrome({
  executablePath: chromePath,
  headless: !headed,
  // An app that also drives WebGPU may refuse the software adapter headless
  // Chrome offers, in which case its pipeline never starts and nothing decodes.
  // --headed gets the real adapter; the software flags are for headless runs
  // only, where they would otherwise force the very adapter such an app rejects.
  args: headed
    ? ['--autoplay-policy=no-user-gesture-required']
    : [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--enable-features=Vulkan',
      ],
});

const errors = [];
const session = await attach({
  browserURL: chrome.browserURL,
  install: { sampleIntervalMs: 250, keepSamples: 400 },
  onContext: (c) => {
    // A data: URL worker carries its whole source inline; printing one buries
    // the run in base64.
    const shown = c.url.length > 90 ? `${c.url.slice(0, 70)}… (${c.url.length} chars)` : c.url;
    console.log(`  instrumented ${c.type.padEnd(14)} ${shown}`);
  },
  onError: (e) => errors.push(e.message),
});

// Serve a large remote asset from disk so a run takes seconds rather than
// minutes, without editing the app: its code, URLs and control flow are
// unchanged, only where the bytes come from.
const redirect = process.argv.find((a) => a.startsWith('--redirect='))?.split('=')[1];
let mediaServer = null;
if (redirect) {
  const [from, file] = redirect.split(',');
  mediaServer = await serveFile(file);
  await session.redirect([{ from, to: mediaServer.url }]);
  console.log(`  ${from} served from ${file}`);
}

console.log(`\nattaching to ${url}\n`);
await session.navigate(url);

for (let i = 0; i < seconds; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  process.stdout.write('.');
}
console.log('\n');

const censuses = await session.census();
console.log('='.repeat(70));
console.log(summarize(censuses));
console.log('='.repeat(70));

for (const c of censuses) {
  const hasContent =
    Object.values(c.live).some(Boolean) || c.mediaElements.total || c.problems.length;
  if (!hasContent) continue;

  console.log(`\n### ${c.context} — ${c.targetUrl ?? ''}`);
  console.log(`  entered: ${JSON.stringify(c.entered)}`);
  console.log(`  left:    ${JSON.stringify(c.left)}`);
  if (c.problems.length) console.log(`  problems: ${c.problems.join('; ')}`);
  if (c.mediaElements.total) {
    console.log(
      `  media elements: ${c.mediaElements.total}, stalled ${c.mediaElements.stalled}, ` +
        `readyState ${JSON.stringify(c.mediaElements.byReadyState)}`,
    );
  }
  for (const site of c.leakSites.slice(0, 4)) {
    console.log(`  ${site.count}x ${site.type} (${site.origin}, oldest ${site.oldestAgeMs}ms)`);
    for (const l of site.stack.split('\n').slice(0, 3)) console.log(`       ${l.trim()}`);
  }

  // The part a static count cannot give you: whether the pipeline was busy at
  // the moment something stopped working.
  const busy = c.timeline.filter((s) => s.activity.decodeCalls || s.activity.outputs);
  const stalls = c.timeline.filter((s) => s.mediaElements.stalled > 0);
  if (busy.length || stalls.length) {
    console.log(
      `  timeline: ${c.timeline.length} samples, ${busy.length} with decode activity, ` +
        `${stalls.length} with a stalled media element`,
    );
  }
}

if (errors.length) {
  console.log(`\ninjection errors (${errors.length}):`);
  for (const e of new Set(errors)) console.log(`  ${e}`);
}

// A hidden tab never fires requestAnimationFrame, so a render loop stops and an
// app can look wedged when it is merely backgrounded. Rule that out before
// concluding anything from a flat timeline.
const visibility = await session.evaluate('document.visibilityState');
if (visibility && visibility !== 'visible') {
  console.log(`\nnote: the page was '${visibility}', so rAF-driven work was throttled or stopped.`);
}

mediaServer?.close();
session.detach();
await chrome.kill();
