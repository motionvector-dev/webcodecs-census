# @motionvector/webcodecs-census

[![npm](https://img.shields.io/npm/v/@motionvector/webcodecs-census?logo=npm&color=cb3837)](https://www.npmjs.com/package/@motionvector/webcodecs-census)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![licence](https://img.shields.io/npm/l/@motionvector/webcodecs-census?color=blue)](https://github.com/motionvector-dev/webcodecs-census/blob/main/LICENSE)

**Find leaked `VideoFrame`s, `AudioData` and codecs, and get the line of code that allocated them.**

WebCodecs objects hold resources from a finite pool outside the JS heap. The
garbage collector never reclaims them — only `close()` does. Nothing in the
platform tells you *that* you leaked one, *how many*, or *where from*: the app
just gets slower, then quietly stops decoding.

This is the instrumentation core. It runs in any context — page, dedicated
worker, shared worker — and has **no dependencies**.

> Instrumenting a worker you did not write, from outside the app, needs
> [`@motionvector/webcodecs-census-cdp`](https://www.npmjs.com/package/@motionvector/webcodecs-census-cdp).
> This package is what you reach for when you can edit the code being measured.

## Install

```bash
npm install --save-dev @motionvector/webcodecs-census
```

## Use

Install it as early as you can in every context that touches media — the main
thread and each worker. Anything allocated before it installs is invisible to
it.

```js
import { installCensus, localCensus } from '@motionvector/webcodecs-census';

installCensus({ context: 'decoder-worker' });
```

Then ask what is still open:

```js
const census = localCensus();
// {
//   live:       { VideoFrame: 58, VideoDecoder: 1 },
//   entered:    { 'VideoFrame:decoded': 238, 'VideoDecoder:constructed': 1 },
//   left:       { 'VideoFrame:closed': 179 },
//   leakSites:  [ { count: 58, type: 'VideoFrame', origin: 'decoded', stack, oldestAgeMs } ],
//   collectedUnclosed: { VideoFrame: 1 },
//   mediaElements:     { total: 4, stalled: 1, byReadyState: { 0: 1, 4: 3 } },
//   timeline:   [ … ],
// }
```

`leakSites` is the part that matters: live objects grouped by where they entered
the context, worst first. A count alone cannot be acted on.

## Make a leak fail the build

```js
import { expectNoLeakedFrames } from '@motionvector/webcodecs-census';

test('the editor releases every frame it decodes', async () => {
  await playThroughTimeline();
  expectNoLeakedFrames([localCensus()], { minAgeMs: 1000 });
});
```

`checkLeaks()` returns the same information without throwing. `minAgeMs` ignores
objects that may still legitimately be in flight.

`types` decides what counts as live too long. It defaults to the frame-like
types, because a long-lived decoder is normal and a long-lived frame almost
never is. Pass `types: 'all'` to hold the codecs to the same standard:

```js
expectNoLeaks([localCensus()], { types: 'all' });
```

Two things `types` deliberately does not do. It never hides an object the GC
collected while it was still open — that is the definitive leak, and it fails
the check whatever its type. And it never lets the report claim a clean bill of
health for a type it did not look at: an unenforced type with live objects is
named in the message.

```
No leaks in VideoFrame, AudioData, ImageBitmap — but VideoDecoder=47 still
live and not enforced. Pass types: 'all' to check those too.
```

## What it counts, and why that is not obvious

Tracked: `VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`,
`VideoFrame`, `AudioData`, `ImageBitmap` — plus `<video>`/`<audio>` elements,
because Chrome caps `WebMediaPlayer`s per frame and elements past the cap stall
at `readyState 0` with no error event.

Each live object records how it entered the context, because provenance decides
whether a leak is yours:

| Origin | Meaning |
| --- | --- |
| `constructed` | `new VideoFrame(...)` here |
| `decoded` | produced by a codec, attributed to that codec's construction site |
| `cloned` | `.clone()` — an independent handle needing its own `close()` |
| `received` | arrived over `postMessage`; this context owns it now |

**`decoded` is the one that catches real bugs.** Frames that leak in production
never pass through a JS constructor — the platform creates them and hands them
to the `output` callback you gave `new VideoDecoder({output})`. An instrument
that only traps the constructor reports a clean pipeline for an app losing every
frame. This wraps that callback, and since a platform callback has no
application frames above it, attributes each frame to the codec that produced
it.

**Transfers are accounted for explicitly.** Transferring a `VideoFrame` detaches
the sender's handle *without* calling `close()`, and the receiver gets it by
structured clone rather than a constructor. Counted naively that is a false leak
in one context and an invisible object in the other.

A `FinalizationRegistry` catches the unambiguous case: an object collected by GC
that was never closed. That is a leak, not a heuristic.

## The timeline, and why a snapshot lies

A static count says how many are live. It cannot say whether the pipeline was
*busy* — and that difference is what tells a backlog apart from a wedge. Every
context keeps a rolling sample of live counts, codec throughput, queue depth and
media-element `readyState`:

```
   t(s)  liveVF  dec/out  queued
     12      59    0/0        0
     58      58    0/0        0
    162      58    0/0        0
```

Decoder idle, queue empty, frames frozen: wedged, not buffering. A snapshot
alone reads that as normal.

## Cost

Measured, not estimated: **+5.6 µs per tracked allocation** and **~284 bytes per
live tracked object**, the latter bounded by the size of the leak itself. At
60 fps that is 0.03% of a second. It only matters above roughly 100k allocations
per second.

Suitable for development and CI. Not recommended enabled by default in
production builds — not for speed, but because it patches global constructors
and retains a stack per live object.

## API

| | |
| --- | --- |
| `installCensus(options?)` | Patch this context. Safe to call more than once. |
| `localCensus()` | Snapshot this context. |
| `timeline()` | The rolling samples on their own. |
| `checkLeaks(censuses, options?)` | A pass/fail report, without throwing. |
| `expectNoLeaks(censuses, options?)` | Throws with the allocation sites. |
| `expectNoLeakedFrames(censuses, options?)` | The common case, named for what it means. |
| `summarize(censuses)` | A compact digest, sized for an agent to read. |
| `totalLive(censuses, type)` | Sum one type across contexts. |
| `resetCensus()` | Clear counters without unpatching. Tests only. |

`installCensus` accepts `context`, `sampleIntervalMs`, `keepSamples`,
`stackDepth` and `warnOnCollect`.

## No network, no dependencies

The core makes no requests of any kind: no telemetry, no beacons, no reporting.
Verify with
`grep -rE 'fetch\(|sendBeacon|WebSocket' node_modules/@motionvector/webcodecs-census/dist`.

Published from GitHub Actions with
[provenance](https://docs.npmjs.com/generating-provenance-statements), so every
release is traceable to the commit and workflow that built it.

## Documentation

Full documentation, the two-phase worker injection, and the honest limits:
**[github.com/motionvector-dev/webcodecs-census](https://github.com/motionvector-dev/webcodecs-census)**

MIT
