# Changelog

All three packages share one version and are released together, because
`-cdp` and `-mcp` depend on an exact version of the core.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `bin` path in the MCP package dropped its `./` prefix. npm auto-corrected it
  at publish time and warned; the published package works, but the warning is
  noise on every release until the source matches what npm wants.

## [0.2.0] - 2026-08-13

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
- A README section measuring this against Chrome 151's heap-snapshot tools for
  agents, since that is the first thing a knowledgeable reader will reach for
  instead. It cannot answer the question: the resource is outside the JS heap,
  a page snapshot does not cover worker isolates, and a frame collected without
  `close()` is gone from the heap before it could be captured.

- `SECURITY.md`, which separates the capabilities that are deliberate — patching
  globals, retaining stacks, `webcodecs_evaluate` running arbitrary JavaScript,
  unauthenticated CDP ports — from the things that would be defects, so a real
  report is easier to recognise. Plus `CONTRIBUTING.md`, `CODEOWNERS` and
  Dependabot.

### Changed

- Moved to the `motionvector-dev` GitHub organisation, matching the
  `motionvector.dev` domain and the `@motionvector` npm scope. GitHub redirects
  the old URL, but **the npm trusted-publisher configuration names the repository
  owner and must be re-pointed by hand**, or publishing fails with an
  authentication error that says nothing about the cause.
- The internal state key moves from `Symbol.for('unfoundbox.webcodecs-census')`
  to `Symbol.for('motionvector.webcodecs-census')`. It is an implementation
  detail, but two versions in one page would no longer share state — harmless
  now, worth knowing before 1.0.
- **The extension no longer instruments anything until you enable a site.** It
  previously declared content scripts on `<all_urls>`, so installing it patched
  the WebCodecs globals and exposed the census API in the main world of every
  page the user visited — for a tool you need on one app. It now ships no host
  permissions, requests a single origin when you opt in, registers that origin's
  content script at runtime, and hands the permission back when you opt out.
- The injection diagram is a sequence diagram rather than a picture of a table.
  The previous one drew the same ✓/✗ grid the README already carries in
  markdown, which is searchable, diffable and readable by a screen reader; what
  it did not show was the control handoff, which is the part prose handles
  badly.
- Tests no longer bind fixed debugging ports, and pass `--no-sandbox` under CI.

### Fixed

- `launchChrome` drained neither of Chrome's output streams. Chrome fills the
  64 kB stderr buffer within seconds on Linux and then blocks forever; macOS is
  quiet enough that it never appeared locally. The first CI run hung with no
  output at all.
- `pageBridge` posted the census with a `'*'` target origin. Same-window
  delivery means this crossed no origin boundary, and the API is a page global
  regardless — hygiene rather than a hole, but named now.
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

[Unreleased]: https://github.com/motionvector-dev/webcodecs-census/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/motionvector-dev/webcodecs-census/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/motionvector-dev/webcodecs-census/releases/tag/v0.1.0
