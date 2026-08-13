# Contributing

## Getting set up

```bash
npm install
npm run build:all
npm test
```

Tests drive a real Chrome. They find one from the Puppeteer cache, or you can
point at your own:

```bash
CHROME_PATH=/path/to/chrome npm test
```

## The one rule that matters

**A change must not let this tool report "no leaks" for an app that is leaking.**

Everything else is style. A leak detector that silently sees nothing is worse
than no leak detector, because it converts an open question into a wrong answer.
Several things here exist only to protect that property:

- `installCensus()` wraps each patch step separately and records what failed in
  `problems[]` instead of throwing. A context it could not fully instrument says
  so.
- Patch mode reports every worker it could not wrap, rather than quietly
  covering fewer than it claims.
- `test/platform-assumptions.test.mjs` asserts the undocumented Chrome behaviour
  injection depends on, so a browser change is reported as a browser change
  rather than surfacing as a mysterious failure elsewhere.

If you add a code path that can silently observe less than it appears to, add
the counter or the `problems[]` entry that makes it visible.

## Tests

Real browsers, no mocks. A mocked `VideoDecoder` would have hidden every bug
worth finding here — that decoded frames never pass through a constructor, that
a worker's global is incomplete at the first pause, that Chrome blocks on an
undrained stderr pipe.

New behaviour needs a test that fails without it. If something can only be
verified by hand, say so in the pull request rather than leaving it implied.

## Verifying, not asserting

Claims in this repository are measured. The README's overhead figures, the
globals table, the comparison against heap snapshots — each came from a run, not
from reasoning about what ought to happen. Please hold new claims to that: if
you cannot measure it, write down that you could not.

## Releasing

Maintainers only. All three packages move together, because `-cdp` and `-mcp`
depend on an exact version of the core:

```bash
node scripts/version.mjs minor
git commit -am "release: v0.2.0" && git tag v0.2.0
git push origin main --tags
```

The tag runs `.github/workflows/release.yml`, which refuses a tag that disagrees
with the packages, runs the full browser suite before publishing rather than
after, and publishes over OIDC with provenance.

## Code style

Match the surrounding code. Comments explain why something is the way it is —
particularly where the reason is a platform quirk that will look like a mistake
to the next reader. Do not add comments that restate the code.
