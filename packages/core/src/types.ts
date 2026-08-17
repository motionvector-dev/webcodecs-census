/** Types whose resources GC cannot reclaim, so an unclosed one is a real leak. */
export const TRACKED = [
  'VideoDecoder',
  'VideoEncoder',
  'AudioDecoder',
  'AudioEncoder',
  'VideoFrame',
  'AudioData',
  'ImageBitmap',
] as const;

export type TrackedType = (typeof TRACKED)[number];

/** How an object entered this context. Provenance decides whether a leak is ours. */
export type Origin =
  | 'constructed' // `new VideoFrame(...)` in this context
  | 'decoded' // handed to a decoder/encoder `output` callback by the platform
  | 'cloned' // `.clone()` — an independent handle needing its own close()
  | 'received'; // arrived over postMessage; this context owns it now

/** How an object left. Anything still live at snapshot time is unaccounted for. */
export type Fate =
  | 'closed'
  | 'transferred'
  | 'collectedUnclosed'
  /**
   * The platform closed a codec out from under the application — the spec's
   * Close algorithm sets `[[state]]` to "closed" before it invokes the error
   * callback, so no `close()` call is ever made. The resource went; this is
   * not a leak.
   */
  | 'closedByPlatform';

export interface LiveObject {
  type: TrackedType;
  origin: Origin;
  /** Where it entered this context. The whole point — a count alone can't be acted on. */
  stack: string;
  ageMs: number;
}

/** Live objects sharing one allocation site, which is how you find a leak. */
export interface LeakSite {
  type: TrackedType;
  origin: Origin;
  stack: string;
  count: number;
  oldestAgeMs: number;
}

/**
 * A `close()` that threw, and the line that called it. Closing an already
 * closed codec throws `InvalidStateError`; from a floating `.finally()` that
 * becomes an unhandled rejection no application code can catch, which is why
 * counting it here is worth anything.
 */
export interface OverCloseSite {
  type: TrackedType;
  /** What the platform threw, e.g. "Cannot call 'close' on a closed codec". */
  message: string;
  stack: string;
  count: number;
}

export interface MediaElementCensus {
  total: number;
  /** readyState 0 + networkState 2: asked for a player, never got one. */
  stalled: number;
  byReadyState: Record<number, number>;
}

/** Throughput in the current sampling interval. Distinguishes busy from wedged. */
export interface Activity {
  decodeCalls: number;
  encodeCalls: number;
  outputs: number;
  errors: number;
  /** Summed decodeQueueSize/encodeQueueSize across live codecs. Backpressure. */
  queued: number;
  /** Codecs whose state is 'configured' right now. */
  configured: number;
}

export interface Sample {
  /** ms since install. */
  t: number;
  live: Partial<Record<TrackedType, number>>;
  /** Entered since the previous sample, by origin. */
  gained: Partial<Record<TrackedType, number>>;
  /** Left since the previous sample, by fate. */
  lost: Partial<Record<TrackedType, number>>;
  activity: Activity;
  mediaElements: MediaElementCensus;
}

export interface ContextCensus {
  context: string;
  /** ms the census has been installed — makes rates computable. */
  uptimeMs: number;
  entered: Record<string, number>;
  left: Record<string, number>;
  live: Partial<Record<TrackedType, number>>;
  /** Collected by GC without close(). Unambiguous: the resource was held to the end. */
  collectedUnclosed: Partial<Record<TrackedType, number>>;
  /** Closed here but never seen entering — usually a missed receive path. */
  closedUnseen: number;
  /** close() calls that threw. Not a leak — a lifecycle bug, and uncatchable. */
  overCloses: OverCloseSite[];
  leakSites: LeakSite[];
  oldestLive: LiveObject[];
  mediaElements: MediaElementCensus;
  timeline: Sample[];
  /**
   * Anything that could not be instrumented here. Non-empty means the numbers
   * below it are a floor, not a total — worth surfacing rather than trusting.
   */
  problems: string[];
}
