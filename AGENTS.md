# AGENTS.md

Orientation for an agent landing in this repository cold. `CLAUDE.md` is a
symlink to this file — edit this one.

## What this is

`webcodecs-census` finds leaked WebCodecs objects in a browser app and hands
back the line of code that allocated them. WebCodecs objects hold resources
from a finite pool outside the JS heap; GC never reclaims them, only `close()`
does, and nothing in the platform tells you that you leaked one. The hard part
is that decoders live in Web Workers, which page-level monkey-patching cannot
reach — so the exact path drives Chrome over the DevTools Protocol and injects
into each worker at a `beforeScriptExecution` pause, before its first line.

Public repository, published to npm as three packages under `@motionvector/`.

| Path | What |
| --- | --- |
| `packages/core` | The instrumentation and the assertion API. No dependencies. Also builds the injectable IIFE shim. |
| `packages/cdp` | Injects the shim into a running Chrome — page, iframes, workers — over CDP. |
| `packages/mcp` | An MCP server wrapping the above, so an agent can use it. |
| `extension/` | A Chrome MV3 extension. Patch mode (no debugger) and exact mode (`chrome.debugger`). |
| `docs/` | The documentation site. Plain HTML, no build step. See `docs/README.md`. |
| `test/` | Real-browser tests. No mocks. |
| `scripts/` | Release plumbing: `version.mjs`, `preflight.mjs`, `publish.mjs`, `release-notes.mjs`, `make-diagram.mjs`. |

## The one rule that matters

**A change must not let this tool report "no leaks" for an app that is
leaking.** Everything else is style. A leak detector that silently sees nothing
is worse than no leak detector, because it converts an open question into a
wrong answer. `CONTRIBUTING.md` has the long version.

Several things exist only to protect that property, and they are not
refactoring targets:

- `installCensus()` wraps each patch step separately and records failures in
  `problems[]` instead of throwing.
- Patch mode reports every worker it could not wrap, with the reason.
- `checkLeaks()` never lets `types` filter away `collectedUnclosed`, and never
  prints an unqualified all-clear while an unenforced type holds live objects.
- `test/platform-assumptions.test.mjs` asserts the undocumented Chrome
  behaviour injection depends on, so a browser change is reported as a browser
  change.

The corollary matters too: the tool must not invent leaks either. A codec the
platform closed after an error is not a leak, and reporting it as one would be
the same class of failure pointed the other way.

If you add a path that can silently observe less than it appears to, add the
counter or the `problems[]` entry that makes it visible.

## Build and test

```bash
npm install
npm run build:all     # core + cdp + mcp, then the extension, then test fixtures
npm test              # node --test over test/*.test.mjs
npm run typecheck     # tsc over all three packages; needs npm run build first
```

Tests drive a **real Chrome** — there are no mocks, deliberately. A mocked
`VideoDecoder` would have hidden every bug worth finding here. They find a
Chrome for Testing in the Puppeteer cache, or you point at one:

```bash
CHROME_PATH="$HOME/.cache/puppeteer/chrome/mac_arm-151.0.7922.71/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm test
```

Never the user's own Chrome. Instrumenting that would touch their profile and
their session.

### The git-worktree trap

**Run `npm ci` inside the worktree before trusting a `test` or `typecheck`
result.** A worktree with no `node_modules` of its own resolves
`@motionvector/*` upwards to the main checkout, so:

- `typecheck` checks `mcp` against whatever declarations are built over there —
  reporting errors against code that is fine, or missing errors in code that is
  not.
- The tests import their entry points by relative path, but `packages/cdp`
  loads the shim by package name, so a run in a bare worktree tests the *main
  checkout's* shim, not yours.

`ls -la node_modules/@motionvector` should show symlinks pointing back into the
worktree you are standing in.

## Releasing

Maintainers only, and all three packages move together — `-cdp` and `-mcp`
depend on an **exact** version of the core, so bumping one alone publishes a
package whose dependency does not exist.

```bash
node scripts/version.mjs minor        # or patch / major / an explicit version
git commit -am "release: v0.3.0" && git tag v0.3.0
git push origin main --tags
```

`scripts/version.mjs` moves the three `package.json` versions, rewrites the
cross-dependencies, rewrites the two version strings that live in source
(`VERSION` in `packages/core/src/census.ts` and the name the MCP server
announces in `packages/mcp/src/index.ts`), and promotes the `Unreleased`
section of `CHANGELOG.md`. It refuses a dirty tree, and it fails loudly rather
than silently if a version pattern stops matching — those two stamps shipped
two releases stale once because nothing rewrote them.

The `v*` tag triggers `.github/workflows/release.yml`, which refuses a tag that
disagrees with the packages, runs the full browser suite against pinned Chrome
*before* publishing, then publishes all three in dependency order over OIDC
trusted publishing with provenance, and opens a GitHub Release from that
version's changelog section with the packed extension attached. There is no npm
token.

## Verifying, not asserting

Claims in this repository are measured. The overhead figures, the globals
table, the comparison against heap snapshots — each came from a run, not from
reasoning about what ought to happen. Hold new claims to that. If you cannot
measure it, write down that you could not, or leave it out.

## Style

Short sentences, active voice, no filler. Comments explain *why*, particularly
where the reason is a platform quirk that will look like a mistake to the next
reader. Do not add comments that restate the code.

## Publishing anything public

This is a public repository. Do not push, open a pull request, publish to npm,
or enable GitHub Pages without the maintainer saying so in the conversation.
Draft it, then hand it over.
