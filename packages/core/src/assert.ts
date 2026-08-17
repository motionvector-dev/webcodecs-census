/**
 * Turning a census into a pass/fail signal, so a leak becomes a test failure
 * rather than something a human has to notice in a panel.
 */

import { TRACKED } from './types';
import type { ContextCensus, LeakSite, OverCloseSite, TrackedType } from './types';

export interface LeakReport {
  ok: boolean;
  /** Live objects of the enforced types, summed across contexts. */
  live: Partial<Record<TrackedType, number>>;
  /** Live objects of the types `types` left out. Reported, never failed on. */
  unenforcedLive: Partial<Record<TrackedType, number>>;
  /**
   * GC'd without close(), summed across contexts and across every tracked
   * type. `types` cannot filter this one away — see `checkLeaks`.
   */
  collectedUnclosed: Partial<Record<TrackedType, number>>;
  /** The types `types` resolved to. */
  enforced: TrackedType[];
  /** Allocation sites holding live objects, worst first. */
  sites: (LeakSite & { context: string })[];
  /**
   * close() calls that threw, worst first. Never a leak, so it does not decide
   * `ok` unless `failOnOverClose` says so — but always reported, because the
   * platform reports it to nobody who can act on it.
   */
  overCloses: (OverCloseSite & { context: string })[];
  message: string;
}

export interface LeakOptions {
  /**
   * Types to enforce, or `'all'` for every tracked type. Defaults to the
   * frame-like types, because a long-lived decoder is normal and a long-lived
   * frame almost never is.
   */
  types?: TrackedType[] | 'all';
  /** Tolerated live count per type. A steady-state pipeline holds a few. */
  allow?: Partial<Record<TrackedType, number>>;
  /** Ignore live objects younger than this — they may be legitimately in flight. */
  minAgeMs?: number;
  /**
   * Fail when a `close()` threw. Off by default: the usual cause is a library
   * closing a codec twice, which the app that would see the failure cannot
   * fix. Turn it on for code you own.
   */
  failOnOverClose?: boolean;
}

const DEFAULT_TYPES: TrackedType[] = ['VideoFrame', 'AudioData', 'ImageBitmap'];

export function totalLive(censuses: ContextCensus[], type: TrackedType): number {
  return censuses.reduce((sum, c) => sum + (c.live[type] ?? 0), 0);
}

const counts = (m: Partial<Record<TrackedType, number>>) =>
  Object.entries(m)
    .filter(([, n]) => n)
    .map(([t, n]) => `${t}=${n}`)
    .join(' ');

/**
 * Build a report without throwing. `checkLeaks(...).ok` is the boolean form.
 *
 * `types` narrows what counts as *live too long*. It deliberately does not
 * narrow objects the GC collected while they were still open: that is the
 * definitive leak, and a filter aimed at live frames must not hide a decoder
 * that was dropped on the floor.
 */
export function checkLeaks(censuses: ContextCensus[], options: LeakOptions = {}): LeakReport {
  const enforced = options.types === 'all' ? [...TRACKED] : options.types ?? DEFAULT_TYPES;
  const allow = options.allow ?? {};
  const minAgeMs = options.minAgeMs ?? 0;

  const live: Partial<Record<TrackedType, number>> = {};
  const unenforcedLive: Partial<Record<TrackedType, number>> = {};
  const collectedUnclosed: Partial<Record<TrackedType, number>> = {};
  const sites: (LeakSite & { context: string })[] = [];
  const overCloses: (OverCloseSite & { context: string })[] = [];

  for (const c of censuses) {
    for (const t of TRACKED) {
      const n = c.live[t] ?? 0;
      if (n) {
        const bucket = enforced.includes(t) ? live : unenforcedLive;
        bucket[t] = (bucket[t] ?? 0) + n;
      }
      if (c.collectedUnclosed[t]) {
        collectedUnclosed[t] = (collectedUnclosed[t] ?? 0) + c.collectedUnclosed[t]!;
      }
    }
    for (const o of c.overCloses ?? []) overCloses.push({ ...o, context: c.context });
    for (const s of c.leakSites) {
      if (enforced.includes(s.type) && s.oldestAgeMs >= minAgeMs) {
        sites.push({ ...s, context: c.context });
      }
    }
  }
  sites.sort((a, b) => b.count - a.count);
  overCloses.sort((a, b) => b.count - a.count);

  const over = enforced.filter((t) => (live[t] ?? 0) > (allow[t] ?? 0));
  const collected = TRACKED.filter((t) => (collectedUnclosed[t] ?? 0) > 0);
  const ok =
    over.length === 0 &&
    collected.length === 0 &&
    !(options.failOnOverClose && overCloses.length);

  return {
    ok,
    live,
    unenforcedLive,
    collectedUnclosed,
    enforced,
    sites,
    overCloses,
    message: describe(
      ok,
      over,
      collected,
      enforced,
      live,
      unenforcedLive,
      collectedUnclosed,
      sites,
      overCloses,
      allow,
    ),
  };
}

function describe(
  ok: boolean,
  over: TrackedType[],
  collected: TrackedType[],
  enforced: TrackedType[],
  live: Partial<Record<TrackedType, number>>,
  unenforcedLive: Partial<Record<TrackedType, number>>,
  collectedUnclosed: Partial<Record<TrackedType, number>>,
  sites: (LeakSite & { context: string })[],
  overCloses: (OverCloseSite & { context: string })[],
  allow: Partial<Record<TrackedType, number>>,
): string {
  const unenforced = counts(unenforcedLive);
  const overClose = overCloses.length
    ? [
        '',
        `${overCloses.reduce((n, o) => n + o.count, 0)} close() call(s) threw — a codec was closed twice:`,
        ...overCloses.slice(0, 3).flatMap((o) => [
          `  ${o.count}x ${o.type}: ${o.message} (in ${o.context})`,
          ...o.stack.split('\n').slice(0, 2).map((l) => `      ${l.trim()}`),
        ]),
      ]
    : [];

  if (ok) {
    if (!unenforced && !overClose.length) return 'No leaked WebCodecs objects.';
    if (!unenforced) return ['No leaked WebCodecs objects.', ...overClose].join('\n');
    // An unqualified all-clear next to 47 live decoders is how this tool
    // reported clean on the exact leak it was pointed at.
    return (
      `No leaks in ${enforced.join(', ')} — but ${unenforced} still live and not enforced. ` +
      `Pass types: 'all' to check those too.` + overClose.join('\n')
    );
  }

  const lines: string[] = [];
  for (const t of collected) {
    lines.push(`${collectedUnclosed[t]} ${t} garbage collected without close() — definitively leaked.`);
  }
  for (const t of over) {
    lines.push(`${live[t]} ${t} still live (allowed ${allow[t] ?? 0}).`);
  }
  if (unenforced) {
    lines.push(`Not enforced, and still live: ${unenforced}. Pass types: 'all' to check those too.`);
  }
  lines.push(...overClose);
  if (sites.length) {
    lines.push('', 'Held by:');
    for (const s of sites.slice(0, 5)) {
      lines.push(
        `  ${s.count}x ${s.type} (${s.origin}, oldest ${s.oldestAgeMs}ms) in ${s.context}`,
        ...s.stack.split('\n').slice(0, 3).map((l) => `      ${l.trim()}`),
      );
    }
  }
  return lines.join('\n');
}

/** Throws unless every tracked type is within its allowance. For tests and CI. */
export function expectNoLeaks(censuses: ContextCensus[], options: LeakOptions = {}): void {
  const report = checkLeaks(censuses, options);
  if (!report.ok) throw new Error(report.message);
}

/** The common case, named for what it means. */
export function expectNoLeakedFrames(censuses: ContextCensus[], options: LeakOptions = {}): void {
  expectNoLeaks(censuses, { types: ['VideoFrame'], ...options });
}

/**
 * A compact digest for an agent to read in one call. Deliberately small: the
 * full census is large and mostly stacks.
 */
export function summarize(censuses: ContextCensus[]): string {
  const report = checkLeaks(censuses);
  const lines = [`${censuses.length} context(s): ${censuses.map((c) => c.context).join(', ')}`];

  for (const c of censuses) {
    const live = Object.entries(c.live).filter(([, n]) => n);
    const media = c.mediaElements;
    lines.push(
      `  ${c.context} (${Math.round(c.uptimeMs / 1000)}s): ` +
        (live.length ? live.map(([t, n]) => `${t}=${n}`).join(' ') : 'nothing live') +
        (media.total ? ` | media ${media.total} (${media.stalled} stalled)` : ''),
    );
  }
  lines.push('', report.message);
  return lines.join('\n');
}
