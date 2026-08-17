# @motionvector/webcodecs-census-mcp

[![npm](https://img.shields.io/npm/v/@motionvector/webcodecs-census-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/@motionvector/webcodecs-census-mcp)
[![provenance](https://img.shields.io/badge/npm-provenance-2ea44f?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)
[![licence](https://img.shields.io/npm/l/@motionvector/webcodecs-census-mcp?color=blue)](https://github.com/motionvector-dev/webcodecs-census/blob/main/LICENSE)

**Let an agent find a leaked `VideoFrame` — with the allocation stack — without
a browser UI in the loop.**

Existing media tooling is built for human eyes: panels, flamegraphs,
screenshots. An agent cannot read those efficiently. This exposes the same
information as small, structured text.

## Install

```json
{
  "mcpServers": {
    "webcodecs-census": {
      "command": "npx",
      "args": ["-y", "@motionvector/webcodecs-census-mcp"]
    }
  }
}
```

## Tools

| Tool | What it answers |
| --- | --- |
| `webcodecs_attach` | Instrument a page and every one of its Web Workers. Call first. |
| `webcodecs_census` | What is open right now, as a digest. |
| `webcodecs_leak_sites` | *Which line is leaking* — grouped by allocation site, worst first. |
| `webcodecs_timeline` | Live counts, throughput, queue depth and media readiness over time. |
| `webcodecs_evaluate` | Drive the app so the census has activity to observe. |
| `webcodecs_detach` | Stop, and close any browser this launched. |

Output is deliberately small. A full census is mostly stack strings, which is
not what you want filling a context window — so `webcodecs_census` returns a
digest and `webcodecs_leak_sites` returns the attribution separately.

## A session

```
webcodecs_attach { executablePath: "/path/to/chrome", url: "http://localhost:5173/" }
→ Instrumented 3 context(s): page, worker, worker
  Workers are instrumented before their first line, so allocations at worker
  startup are counted.

webcodecs_census
→ worker (20s): VideoDecoder=1 VideoFrame=58
  1 VideoFrame garbage collected without close() — definitively leaked.

webcodecs_leak_sites { type: "VideoFrame" }
→ 58x VideoFrame — decoded, oldest 124609ms, in worker
      at PackagerWorker.setupDecoder (worker.js:1756:21)
      (frame emitted by this VideoDecoder)
```

## Why the timeline matters

A snapshot says how many objects are live. It cannot say whether the pipeline
was busy — and a leak and a backlog look identical in a single count.

```
webcodecs_timeline { context: "worker", lastN: 20 }

   t(ms)  live      dec/out  queued  media(stalled)
   12000  VF=59     0/0      0       4(0)
   58000  VF=58     0/0      0       4(1)
  162000  VF=58     0/0      0       4(1)
```

Decoder idle, queue empty, count frozen: wedged, not buffering. That distinction
is the difference between chasing a resource limit that does not exist and
finding the actual bug.

## Attaching to a browser you already have

`webcodecs_attach` takes either `executablePath` — which launches Chrome with a
throwaway profile — or `browserURL` for a Chrome already started with
`--remote-debugging-port`.

Several CDP clients can attach to one page at the same time, so this runs
happily alongside
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp).
They cover different ground: heap snapshots measure the JS heap, and a
WebCodecs resource lives outside it — a page-target snapshot reports tens of
bytes for frames holding megabytes of GPU memory, does not cover worker
isolates, and cannot see a frame that GC already collected without `close()`.

## Trust boundary

`webcodecs_evaluate` runs arbitrary JavaScript in the page under test — that is
how an agent drives the app it is measuring. Anything driving this server can
run code in any page it attaches to. Point it at applications you control.

Chrome's DevTools Protocol is unauthenticated by design. Never expose a
debugging port beyond localhost.

## Documentation

Full reference, tool by tool:
**[motionvector-dev.github.io/webcodecs-census](https://motionvector-dev.github.io/webcodecs-census/mcp.html)**

Source and issues:
[github.com/motionvector-dev/webcodecs-census](https://github.com/motionvector-dev/webcodecs-census)

MIT
