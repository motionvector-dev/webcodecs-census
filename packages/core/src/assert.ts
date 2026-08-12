/**
 * Turning a census into a pass/fail signal, so a leak becomes a test failure
 * rather than something a human has to notice in a panel.
 */

import type { ContextCensus, LeakSite, TrackedType } from './types';

export interface LeakReport {
  ok: boolean;
  /** Live objects, summed across contexts, by type. */
  live: Partial<Record<TrackedType, number>>;
  /** GC'd without close(), summed across contexts. Always a genuine leak. */
  collectedUnclosed: Partial<Record<TrackedType, number>>;
  /** Allocation sites holding live objects, worst first. */
  sites: (LeakSite & { context: string })[];
  message: string;
}

export interface LeakOptions {
  /**
   * Types to enforce. Defaults to the frame-like types, because a long-lived
   * decoder is normal and a long-lived frame almost never is.
   */
  types?: TrackedType[];
  /** Tolerated live count per type. A steady-state pipeline holds a few. */
  allow?: Partial<Record<TrackedType, number>>;
  /** Ignore live objects younger than this — they may be legitimately in flight. */
  minAgeMs?: number;
}

const DEFAULT_TYPES: TrackedType[] = ['VideoFrame', 'AudioData', 'ImageBitmap'];

export function totalLive(censuses: ContextCensus[], type: TrackedType): number {
  return censuses.reduce((sum, c) => sum + (c.live[type] ?? 0), 0);
}

/** Build a report without throwing. `checkLeaks(...).ok` is the boolean form. */
export function checkLeaks(censuses: ContextCensus[], options: LeakOptions = {}): LeakReport {
  const types = options.types ?? DEFAULT_TYPES;
  const allow = options.allow ?? {};
  const minAgeMs = options.minAgeMs ?? 0;

  const live: Partial<Record<TrackedType, number>> = {};
  const collectedUnclosed: Partial<Record<TrackedType, number>> = {};
  const sites: (LeakSite & { context: string })[] = [];

  for (const c of censuses) {
    for (const t of types) {
      if (c.live[t]) live[t] = (live[t] ?? 0) + c.live[t]!;
      if (c.collectedUnclosed[t]) {
        collectedUnclosed[t] = (collectedUnclosed[t] ?? 0) + c.collectedUnclosed[t]!;
      }
    }
    for (const s of c.leakSites) {
      if (types.includes(s.type) && s.oldestAgeMs >= minAgeMs) {
        sites.push({ ...s, context: c.context });
      }
    }
  }
  sites.sort((a, b) => b.count - a.count);

  const over = types.filter((t) => (live[t] ?? 0) > (allow[t] ?? 0));
  const collected = types.filter((t) => (collectedUnclosed[t] ?? 0) > 0);
  const ok = over.length === 0 && collected.length === 0;

  return { ok, live, collectedUnclosed, sites, message: describe(ok, over, collected, live, collectedUnclosed, sites, allow) };
}

function describe(
  ok: boolean,
  over: TrackedType[],
  collected: TrackedType[],
  live: Partial<Record<TrackedType, number>>,
  collectedUnclosed: Partial<Record<TrackedType, number>>,
  sites: (LeakSite & { context: string })[],
  allow: Partial<Record<TrackedType, number>>,
): string {
  if (ok) return 'No leaked WebCodecs objects.';

  const lines: string[] = [];
  for (const t of collected) {
    lines.push(`${collectedUnclosed[t]} ${t} garbage collected without close() — definitively leaked.`);
  }
  for (const t of over) {
    lines.push(`${live[t]} ${t} still live (allowed ${allow[t] ?? 0}).`);
  }
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
  const report = checkLeaks(censuses, { types: ['VideoFrame', 'AudioData', 'ImageBitmap'] });
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
