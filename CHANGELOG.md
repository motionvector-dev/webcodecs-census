# Changelog

All three packages share one version and are released together, because
`-cdp` and `-mcp` depend on an exact version of the core.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `test/platform-assumptions.test.mjs`, which asserts the undocumented Chrome
  behaviour worker injection depends on and prints what it measured at each
  pause point, so a drift report says which assumption moved rather than
  reading as a bug in this project.
- CI pinned to Chrome 151.0.7922.71 — the version every claim in the README was
  measured against — plus a weekly job running the same suite against Chrome
  stable, kept out of required checks so a Chrome release cannot block an
  unrelated pull request.
- `npm run preflight`, which checks npm login and org membership before a
  release spends a full build-and-test cycle discovering it cannot publish.
- Publishing over OIDC trusted publishing rather than a long-lived npm token,
  so nothing durable exists to leak or rotate and provenance is automatic.
- `scripts/publish.mjs`, which skips any package already on the registry at the
  version being released, so re-running a release that failed part-way finishes
  the job instead of aborting on the first "cannot publish over previously
  published versions".

- `test/mediabunny.test.mjs`, which builds a real MP4 with
  [mediabunny](https://github.com/Vanilagy/mediabunny), decodes it back through
  that library's own `VideoSampleSink`, and asserts the census counts the codecs
  mediabunny created internally — the case where an instrument that only traps
  what the application constructs reports nothing at all. It also leaks frames
  through mediabunny's documented sample-versus-frame ownership split and
  asserts the leak is attributed to `toVideoFrame`, the method whose contract
  was broken.

### Changed

- Tests no longer bind fixed debugging ports, and pass `--no-sandbox` under CI.

### Fixed

- `launchChrome` drained neither of Chrome's output streams. Chrome fills the
  64 kB stderr buffer within seconds on Linux and then blocks forever; macOS is
  quiet enough that it never appeared locally. The first CI run hung with no
  output at all.
- `kill()` removed the profile directory in the same breath as signalling
  Chrome, racing the helper processes still writing there and failing with
  `ENOTEMPTY` — which surfaced as a stalled test file rather than anything
  resembling a cleanup problem.

## [0.1.0] - 2026-08-13

First release.

### Added

- **Two-phase worker injection.** `Target.setAutoAttach` with
  `waitForDebuggerOnStart` pauses a worker before its first line, but a
  dedicated worker's global is only half built at that point: `VideoFrame` and
  `AudioData` exist while all four codec constructors and every timer function
  do not. Injection resumes into a `beforeScriptExecution` instrumentation
  breakpoint, which is the only moment that is both complete and early enough.
- **Decoded-frame tracking.** Frames produced by a codec never pass through a
  JS constructor — the platform creates them and hands them to the `output`
  callback. They are wrapped at construction time and attributed to the codec
  that produced them, since no application frames exist above a platform
  callback. `.clone()` is tracked for the same reason.
- **Explicit transfer accounting.** Transferring a `VideoFrame` detaches the
  sender's handle without calling `close()`, and the receiver obtains it by
  structured clone. Counted naively that is a false leak in one context and an
  invisible object in the other.
- **A `FinalizationRegistry` check** for the unambiguous case: an object
  collected by GC that was never closed.
- **A rolling timeline** of live counts, codec throughput, queue depth and
  media-element `readyState`, because a static count cannot distinguish a busy
  pipeline from a wedged one.
- **Media element tracking**, since Chrome caps `WebMediaPlayer`s per frame and
  elements past the cap stall at `readyState 0` with no error event.
- `checkLeaks()` / `expectNoLeaks()` / `expectNoLeakedFrames()` so a leak can
  fail a test rather than waiting to be noticed.
- An MV3 extension with two modes: `debugger`-based exact mode, and a
  best-effort patch mode that reports whatever it could not instrument instead
  of silently missing it.
- An MCP server exposing `webcodecs_attach`, `webcodecs_census`,
  `webcodecs_leak_sites`, `webcodecs_timeline`, `webcodecs_evaluate` and
  `webcodecs_detach`.

[Unreleased]: https://github.com/unfoundbox/webcodecs-census/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/unfoundbox/webcodecs-census/releases/tag/v0.1.0
