# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/unfoundbox/webcodecs-census/security/advisories/new).
Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a few days. This is a small project maintained
by one person, so a fix may take longer than that — you will be told either way
rather than left guessing.

## What this software can do, by design

Several capabilities here look alarming out of context and are the point of the
tool. Knowing which is which makes a real report easier to spot.

**The census patches global constructors.** `installCensus()` replaces
`VideoFrame`, `VideoDecoder` and the rest with `Proxy` wrappers and patches
`close`, `clone` and `postMessage`. It cannot observe a leak otherwise. It never
copies frame contents, and it holds no strong reference to any tracked object —
only metadata, so the census cannot itself be the leak.

**It keeps allocation stacks in memory.** Roughly 284 bytes per live tracked
object, retained only while that object is live. Those stacks contain your
source URLs, function names and line numbers.

**The census API is a page global.** `window.__webcodecsCensus` is readable by
any script in the page, including third-party ones. Everything it exposes —
counts, stacks, timings — is already derivable in-page, but treat it as visible
rather than private, and do not enable it on a page handling data you would not
want an analytics script to see.

**The MCP server executes arbitrary JavaScript.** `webcodecs_evaluate` runs an
expression in the page under test, so an agent can drive the app it is
measuring. Anything driving that server can run code in any page it attaches to.
Run it against applications you control.

**The CDP driver talks to an unauthenticated port.** Chrome's DevTools Protocol
has no authentication; anything that can reach the port controls the browser.
`launchChrome()` always uses a throwaway profile and lets Chrome pick a free
port. Never expose a debugging port beyond localhost, and prefer a dedicated
browser over one holding your logged-in sessions.

**The extension can attach a debugger.** Exact mode uses `chrome.debugger`,
which is why Chrome shows a banner while it is on. Nothing is instrumented until
you enable a specific site, and disabling one hands its host permission back.

## What it does not do

- No network requests. The core makes none: no telemetry, no beacons, no
  reporting. Verify with `grep -rE 'fetch\(|sendBeacon|WebSocket' packages/core/src`.
- No frame or audio contents are read, copied or transmitted.
- No runtime dependencies in the core package.

## Supply chain

Releases publish from GitHub Actions over OIDC
[trusted publishing](https://docs.npmjs.com/trusted-publishers/). There is no
long-lived npm token to steal, and every published package carries provenance
linking it to the commit and workflow that built it. Check it with
`npm view @motionvector/webcodecs-census --json | grep -A5 provenance`, or on
the package page.

## Supported versions

Pre-1.0: only the latest release gets fixes.
