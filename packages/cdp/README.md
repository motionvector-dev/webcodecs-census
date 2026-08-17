# @motionvector/webcodecs-census-cdp

[![npm](https://img.shields.io/npm/v/@motionvector/webcodecs-census-cdp?logo=npm&color=cb3837)](https://www.npmjs.com/package/@motionvector/webcodecs-census-cdp)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![licence](https://img.shields.io/npm/l/@motionvector/webcodecs-census-cdp?color=blue)](https://github.com/motionvector-dev/webcodecs-census/blob/main/LICENSE)

**Instrument a page and every one of its Web Workers, from outside the app, with
no change to the code being measured.**

Decoders almost always live in a Web Worker. Page-level monkey-patching — how
every other web-graphics inspector works — cannot reach a worker the page
created. This drives Chrome over the DevTools Protocol instead, and gets the
census in **before the worker's first line runs**.

## Install

```bash
npm install --save-dev @motionvector/webcodecs-census-cdp
```

## Use

```js
import { attach, launchChrome } from '@motionvector/webcodecs-census-cdp';
import { summarize, checkLeaks } from '@motionvector/webcodecs-census';

const chrome = await launchChrome({ executablePath: CHROME });
const session = await attach({ browserURL: chrome.browserURL });

await session.navigate('http://localhost:5173/');
// …drive the app…

console.log(summarize(await session.census()));

session.detach();
await chrome.kill();
```

```
3 context(s): main, worker, worker
  main (21s): nothing live
  worker (20s): VideoDecoder=1 VideoFrame=58

58 VideoFrame still live (allowed 0).

Held by:
  58x VideoFrame (decoded, oldest 124609ms) in worker
      at PackagerWorker.setupDecoder (worker.js:1756:21)
      (frame emitted by this VideoDecoder)
```

To attach to a browser you already started, pass its endpoint instead:

```js
const session = await attach({ browserURL: 'http://127.0.0.1:9222' });
```

## Why this needs two pauses, not one

`Target.setAutoAttach` with `waitForDebuggerOnStart` pauses a worker before its
first line — but at that moment a dedicated worker's global is only half built.
Measured on Chrome 151:

| At the auto-attach pause | |
| --- | --- |
| `VideoFrame`, `AudioData`, `ImageBitmap`, `EncodedVideoChunk` | present |
| `VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder` | **absent** |
| `setInterval`, `setTimeout`, `queueMicrotask` | **absent** |

Patch there and you instrument the frame types but miss **every codec**. So this
resumes into a second, later pause — a `beforeScriptExecution` instrumentation
breakpoint — which fires with the global fully populated and still before the
worker's own script runs. It is the only moment that is both complete and early
enough.

Auto-attach is not recursive, so each attached target arms it again for its
children. That is what reaches nested workers. `data:` and `blob:` URL workers
are covered too.

This behaviour is measured rather than specified, so the repository has a test
that asserts it directly and prints what it found — a Chrome change is reported
as a Chrome change, rather than surfacing as a mysterious failure.

## API

| | |
| --- | --- |
| `attach(options)` | Instrument a page and its workers. Returns a `CensusSession`. |
| `launchChrome(options)` | Launch Chrome with a throwaway profile on a free port. |
| `findPageTarget(origin, match?)` | Resolve a page target from a DevTools endpoint. |
| `CdpClient` | A minimal flat-session CDP client, if you need one. |

`CensusSession` provides `census()`, `contexts()`, `evaluate(expr, sessionId?)`,
`navigate(url)`, `redirect(rules)` and `detach()`.

`redirect()` serves a matching URL from somewhere else — useful for pinning a
large media asset to a local copy so runs are fast and repeatable without
editing the app under test.

## Safety

`launchChrome()` always uses a **throwaway profile** and lets Chrome pick a free
port. It never reuses, and never kills, a browser you already have open.
Instrumenting a browser you are signed into risks touching your session, and a
shared profile makes runs non-repeatable.

Chrome's DevTools Protocol is **unauthenticated by design** — anything that can
reach the port controls the browser. Never expose a debugging port beyond
localhost.

## Documentation

Full reference, the extension, and the MCP server:
**[motionvector-dev.github.io/webcodecs-census](https://motionvector-dev.github.io/webcodecs-census/cdp.html)**

Source and issues:
[github.com/motionvector-dev/webcodecs-census](https://github.com/motionvector-dev/webcodecs-census)

MIT
