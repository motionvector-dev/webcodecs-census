# WebCodecs Census

Find leaked `VideoFrame`s, `AudioData` and codecs in a WebCodecs app — **including inside Web Workers** — and get the line of code that allocated them.

WebCodecs objects hold resources from a finite pool outside the JS heap. The garbage collector never reclaims them; only `close()` does. Chrome's own guidance is blunt about the consequence: forget `frame.close()` and you leak GPU memory fast. But nothing in the platform tells you *that* you leaked one, *how many*, or *where from*. The app just gets slower, then quietly stops decoding.

DevTools' Media panel lists media players. It does not tell you which frames leaked or who allocated them. As far as we can find, nothing else does either.

## Why this is hard, and why it didn't exist

Decoders almost always live in a Web Worker. Page-level monkey-patching — how [Spector.js](https://github.com/BabylonJS/Spector.js) and [WebGPU Inspector](https://github.com/brendan-duncan/webgpu_inspector) both work — cannot reach a worker the page created. That is the whole problem, and it has two teeth:

- A Manifest V3 `world: "MAIN"` content script at `document_start` is **not guaranteed** to run before the page's inline scripts.
- Rewriting `new Worker()` to load a shim from a blob URL **fails outright** on any site whose CSP omits `blob:` from `worker-src`/`script-src`.

Either failure is silent, and a leak detector that silently sees nothing reports a clean bill of health for an app that is losing every frame. That is worse than having no tool.

So the exact path uses the DevTools Protocol, and it needs **two** pauses, not one.

### The two-phase injection

`Target.setAutoAttach` with `waitForDebuggerOnStart` pauses a worker before its first line. Inject there and you catch an allocation on line 1. But at that moment a dedicated worker's global is only half built. Measured on Chrome 151:

| At the auto-attach pause | Present | Absent |
| --- | --- | --- |
| `VideoFrame`, `AudioData`, `ImageBitmap`, `EncodedVideoChunk` | ✅ | |
| `VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder` | | ❌ |
| `setInterval`, `setTimeout`, `queueMicrotask` | | ❌ |

Patch there and you instrument the frame types but miss **every codec** — most of what the tool is for. So we resume into a second, later pause: a `beforeScriptExecution` instrumentation breakpoint. That fires with the global fully populated and still before the worker's own script runs. It is the only moment that is both complete and early enough.

Auto-attach is not recursive, so each attached target arms it again for its children. That is what reaches nested workers.

### Decoded frames never pass through a constructor

The frames that leak in production are not the ones you build with `new VideoFrame()`. They are created by the platform and handed to the `output` callback you gave `new VideoDecoder({output})`. An instrument that only traps the constructor counts a handful of hand-built frames and misses the entire decode pipeline.

The census wraps the `output` callback at construction time. Because there are no application frames above a platform callback, a decoded frame is attributed to **the decoder that produced it** — which is the line you can actually act on. `.clone()` is tracked too: it returns an independent handle needing its own `close()`, and it also bypasses the constructor.

## Install

```bash
npm install --save-dev @motionvector/webcodecs-census
```

## Use it from an agent

The point of this project. One call, structured output, no screenshots:

```js
import { attach, launchChrome } from '@motionvector/webcodecs-census-cdp';
import { summarize, checkLeaks } from '@motionvector/webcodecs-census';

const chrome = await launchChrome({ executablePath: CHROME });
const session = await attach({ browserURL: chrome.browserURL });
await session.navigate('http://localhost:5173/');

const censuses = await session.census();   // every context, page + workers
console.log(summarize(censuses));
```

```
3 context(s): main, decoder_worker, transformer_worker
  main (21s): VideoFrame=1 | media 4 (1 stalled)
  decoder_worker (20s): VideoFrame=137
  transformer_worker (20s): nothing live

137 VideoFrame still live (allowed 0).

Held by:
  137x VideoFrame (decoded, oldest 18420ms) in decoder_worker
      at Renderer.setupDecoder (renderer.js:68:24)
      (frame emitted by this VideoDecoder)
```

### Found in the wild

Pointed at [the application](https://example.com)'s server-render pipeline — a Vite app with eleven worker call sites — it instrumented 11 contexts, including `data:` and `blob:` URL workers, with no change to the application. In one of them:

```
entered: {VideoDecoder:constructed: 1, VideoFrame:decoded: 238}
left:    {VideoFrame:closed: 179}
live:     58 VideoFrame          collectedUnclosed: {VideoFrame: 1}
site:     PackagerWorker.setupDecoder
          ← initializeBuffers ← start
```

The timeline is what made it diagnosable rather than merely visible:

```
   t(s)  liveVF  dec/out  queued
     12      59    0/0        0
     58      58    0/0        0
    162      58    0/0        0
```

Two of 330 samples had any decode activity, all in the first seconds, with the decode queue pinned at 0. The decoder was **idle, not backlogged** — while the UI read "Rendering in Progress — 0%" indefinitely, throwing nothing and logging nothing. A snapshot alone reports "58 frames live", which reads like normal buffering. Reading the attributed function then showed a `pendingWork` flag that is set before an `await` with no `try/finally` and one early return that skips its reset: strand it once and the buffer never drains again.

### MCP server

```json
{
  "mcpServers": {
    "webcodecs-census": { "command": "npx", "args": ["-y", "@motionvector/webcodecs-census-mcp"] }
  }
}
```

Tools: `webcodecs_attach`, `webcodecs_census`, `webcodecs_leak_sites`, `webcodecs_timeline`, `webcodecs_evaluate`, `webcodecs_detach`. Output is kept small on purpose — a full census is mostly stack strings, which is not what you want filling an agent's context.

## Use it in CI

A leak becomes a test failure instead of something someone notices six months later:

```js
import { expectNoLeakedFrames } from '@motionvector/webcodecs-census';

test('the editor releases every frame it decodes', async () => {
  await playThroughTimeline();
  expectNoLeakedFrames(await session.census(), { minAgeMs: 1000 });
});
```

`checkLeaks()` returns the same information without throwing. `minAgeMs` ignores objects that may still legitimately be in flight.

## The timeline, and why a snapshot lies

A static count answers "how many are live". It cannot answer "was the pipeline busy when playback stalled" — and that difference matters. In the app this was built against, live decoder count did **not** predict failure: the highest count succeeded and lower counts stalled. A snapshot would have sent you after a resource-exhaustion bug that wasn't there.

So every context keeps a rolling sample of live counts, decode/encode throughput, codec queue depth, and every media element's `readyState`:

```js
webcodecs_timeline({ context: 'main', lastN: 20 })
```

```
   t(ms)  live          dec/out  queued  media(stalled)
   8000   VF=12         30/30    2       4(0)
   8250   VF=41         30/29    9       4(1)   <- stalled while decoding hard
   8500   VF=88         30/28    17      4(1)
```

Media elements are tracked because Chrome caps `WebMediaPlayer`s per frame (75 desktop, 40 mobile since Chrome 92). Past the cap, new elements stall at `readyState 0` / `networkState 2` with **no error event** — a failure with no signal attached to it.

## Browser extension

Two modes, because the exact one is not free:

| | Patch mode | Exact mode |
| --- | --- | --- |
| Permissions | none beyond the page | `debugger` |
| Banner | none | "debugging this browser" |
| Works with DevTools open | yes | no |
| Workers started before the page script | missed | caught |
| Workers blocked by `worker-src` CSP | missed (reported) | caught |
| Codecs inside workers | caught | caught |

Patch mode never fails silently: whatever it could not wrap is listed in the popup and in `problems[]` on the census.

```bash
npm run build && (cd extension && node build.mjs)   # load extension/dist unpacked
```

## What it tracks

`VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`, `VideoFrame`, `AudioData`, `ImageBitmap` — plus `<video>`/`<audio>` elements.

Each live object records how it entered the context:

| Origin | Meaning |
| --- | --- |
| `constructed` | `new VideoFrame(...)` here |
| `decoded` | produced by a codec, attributed to that codec's construction site |
| `cloned` | `.clone()` — an independent handle needing its own `close()` |
| `received` | arrived over `postMessage`; this context owns it now |

**Transfers are accounted for explicitly.** Transferring a `VideoFrame` detaches the sender's handle *without* calling `close()`, and the receiver gets it by structured clone rather than a constructor. Counted naively that is a false leak in the sender and an invisible object in the receiver. The census records a transfer as a distinct fate, and scans incoming messages (bounded depth) to adopt what arrives.

A `FinalizationRegistry` catches the unambiguous case: an object collected by GC that was never closed. That is a leak, not a heuristic.

## Honest limits

- `EncodedVideoChunk`/`EncodedAudioChunk` have no `close()` and hold no external resource, so they are not tracked as leakable.
- Frames from `MediaStreamTrackProcessor` are not yet attributed; they are counted when closed or transferred.
- The message scanner walks 3 levels and 64 keys. A frame buried deeper arrives uncounted and shows up as `closedUnseen`.
- Patch mode changes `self.location` inside wrapped workers to the loader blob URL. Workers using `import.meta.url` are unaffected; workers building paths from `self.location` are not.
- Exact mode cannot share a tab with an open DevTools window. Chrome allows one debugger client.

## Development

```bash
npm install && npm run build && npm test
```

Tests drive a real Chrome and assert the things that would otherwise fail silently: that the shim beats a worker's first line, that decoded frames are counted, that a transferred frame is not blamed on the sender, and that patch mode really rewrites `Worker`.

## Prior art

- [webgpu_inspector](https://github.com/brendan-duncan/webgpu_inspector) — excellent, actively maintained, and the quality bar for this project. Solves the analogous problem for WebGPU and ships a Claude Code plugin. Does not cover WebCodecs.
- [Spector.js](https://github.com/BabylonJS/Spector.js) — WebGL. Page-level patching, same worker blind spot.
- Chrome DevTools Media panel — lists players and logs; does not attribute frame lifetimes.

## Licence

MIT
