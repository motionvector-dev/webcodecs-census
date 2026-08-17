/**
 * A census of the WebCodecs resources a context holds open.
 *
 * WebCodecs objects own resources from a finite pool outside the JS heap, and the
 * garbage collector will not reclaim them — only `close()` does. Nothing in a
 * browser tells you when you have leaked one: the app gets slower, then stops
 * decoding, with no error anywhere.
 *
 * This module makes the pool observable. It counts what is live, records where
 * each object entered the context, and samples the pool over time so a stall can
 * be correlated with what the pipeline was doing when it happened.
 *
 * It is written to run in any context — page, dedicated worker, shared worker —
 * and to be injected as a source string, so it takes no imports at runtime.
 */

import {
  LIVE_AGES_CAP,
  TRACKED,
  type Activity,
  type ContextCensus,
  type Fate,
  type LeakSite,
  type LiveObject,
  type MediaElementCensus,
  type Origin,
  type OverCloseSite,
  type Sample,
  type TrackedType,
} from './types';

export interface InstallOptions {
  /** Name for this context in reports. Defaults to a guess from the global scope. */
  context?: string;
  /** Rolling timeline. `false` disables; a number sets the interval in ms. */
  sampleIntervalMs?: number | false;
  /** How many samples to retain. Older ones are dropped. */
  keepSamples?: number;
  /** Frames of allocation stack to keep. */
  stackDepth?: number;
  /** Log a warning when an object is GC'd without close(). */
  warnOnCollect?: boolean;
}

interface Entry {
  type: TrackedType;
  origin: Origin;
  stack: string;
  at: number;
}

/**
 * The patches install onto globals and outlive this module. Re-executing it —
 * HMR, a second bundle chunk, a second injection into the same context — would
 * otherwise leave a patched constructor writing into the previous instance's
 * counters while the census reads an empty one.
 */
interface State {
  installed: boolean;
  context: string;
  installedAt: number;
  opts: Required<Omit<InstallOptions, 'context'>>;
  entered: Record<string, number>;
  left: Record<string, number>;
  collectedUnclosed: Record<string, number>;
  closedUnseen: number;
  /** close() calls that threw, grouped by type, message and calling line. */
  overCloses: Map<string, OverCloseSite>;
  nextId: number;
  /** Metadata only — never a strong reference, or we would cause the leak. */
  liveEntries: Map<number, Entry>;
  idOf: WeakMap<object, number>;
  codecs: Set<WeakRef<any>>;
  mediaElements: Set<WeakRef<HTMLMediaElement>>;
  activity: Activity;
  timeline: Sample[];
  prevEntered: Record<string, number>;
  prevLeft: Record<string, number>;
  timer: any;
}

const STATE_KEY = Symbol.for('motionvector.webcodecs-census');
const g = globalThis as any;

const zeroActivity = (): Activity => ({
  decodeCalls: 0,
  encodeCalls: 0,
  outputs: 0,
  errors: 0,
  queued: 0,
  configured: 0,
});

function freshCounters() {
  return {
    entered: {} as Record<string, number>,
    left: {} as Record<string, number>,
    collectedUnclosed: {} as Record<string, number>,
    closedUnseen: 0,
    overCloses: new Map<string, OverCloseSite>(),
    nextId: 1,
    liveEntries: new Map<number, Entry>(),
    idOf: new WeakMap<object, number>(),
    activity: zeroActivity(),
    timeline: [] as Sample[],
    prevEntered: {} as Record<string, number>,
    prevLeft: {} as Record<string, number>,
  };
}

function guessContext(): string {
  if (typeof (g as any).window !== 'undefined' && g.window === g) return 'main';
  const scope = g.constructor?.name ?? '';
  if (scope.includes('DedicatedWorker')) return 'worker';
  if (scope.includes('SharedWorker')) return 'shared-worker';
  if (scope.includes('ServiceWorker')) return 'service-worker';
  return 'unknown';
}

const state: State =
  g[STATE_KEY] ??
  (g[STATE_KEY] = {
    installed: false,
    context: guessContext(),
    installedAt: 0,
    opts: {
      sampleIntervalMs: 500,
      keepSamples: 240,
      stackDepth: 8,
      warnOnCollect: true,
    },
    codecs: new Set<WeakRef<any>>(),
    mediaElements: new Set<WeakRef<HTMLMediaElement>>(),
    timer: null,
    ...freshCounters(),
  });

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

const bump = (bag: Record<string, number>, k: string, by = 1) => {
  bag[k] = (bag[k] ?? 0) + by;
};

const key = (type: string, tag: string) => `${type}:${tag}`;

/**
 * Frames belonging to this file are noise in an allocation stack. Injected
 * builds carry a sourceURL marker so they can be filtered the same way whether
 * the code was imported or evaluated.
 */
const SELF_MARKER = 'webcodecs-census';

/** No application frames exist above the platform for some allocation paths. */
const NO_APP_FRAMES = '(no application frames — created by the platform)';

function captureStack(): string {
  const raw = new Error().stack ?? '';
  // Drop our own frames wherever they appear, not just at the top: the message
  // scanner recurses, so census frames can sit between application frames.
  const lines = raw
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() && !l.includes(SELF_MARKER));
  if (!lines.length) return NO_APP_FRAMES;
  return lines.slice(0, state.opts.stackDepth).join('\n').trim();
}

/**
 * A worker paused before its first line does not have timers yet: `setInterval`,
 * `setTimeout` and `queueMicrotask` are all undefined at that point, even though
 * `VideoFrame` and `performance` already exist. Injecting there is the whole
 * value of this tool, so the sampler has to start on the first thing that
 * happens after the worker resumes instead of at install time.
 */
function maybeStartSampler(): void {
  if (state.timer || state.opts.sampleIntervalMs === false) return;
  if (typeof setInterval !== 'function') return;
  state.timer = setInterval(takeSample, state.opts.sampleIntervalMs as number);
  (state.timer as any)?.unref?.(); // never hold a Node test process open
}

function track(type: TrackedType, obj: object, origin: Origin, stack?: string): void {
  if (!obj || typeof obj !== 'object') return;
  if (!state.timer) maybeStartSampler();
  if (state.idOf.has(obj)) return; // already counted; don't double-count a re-entry
  const id = state.nextId++;
  state.liveEntries.set(id, { type, origin, stack: stack ?? captureStack(), at: now() });
  state.idOf.set(obj, id);
  finalizers?.register(obj, id, obj);
  bump(state.entered, key(type, origin));
}

function release(obj: unknown, fate: Fate): void {
  if (!obj || typeof obj !== 'object') return;
  const id = state.idOf.get(obj as object);
  if (id === undefined) {
    if (fate === 'closed') state.closedUnseen++;
    return;
  }
  const entry = state.liveEntries.get(id);
  // Already released. Harmless to the count either way, but not harmless to the
  // app: on the four codec types a second close() throws InvalidStateError,
  // which `recordOverClose` catches on the way past. The frame types are
  // idempotent and throw nothing, so there is nothing to record for them.
  if (!entry) return;
  state.liveEntries.delete(id);
  finalizers?.unregister(obj as object);
  bump(state.left, key(entry.type, fate));
}

/**
 * Fires when the GC collects an object. A surviving live entry means nothing
 * ever called close(), so the resource was held for the object's whole
 * lifetime. That is a leak, not a heuristic.
 */
const finalizers =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<number>((id) => {
        const entry = state.liveEntries.get(id);
        if (!entry) return;
        state.liveEntries.delete(id);
        bump(state.collectedUnclosed, entry.type);
        if (state.opts.warnOnCollect) {
          console.warn(
            `[webcodecs-census] ${entry.type} garbage collected without close() — ` +
              `resource held ${Math.round(now() - entry.at)}ms. Entered as '${entry.origin}' at:\n${entry.stack}`,
          );
        }
      })
    : null;

const isTracked = (v: unknown): TrackedType | null => {
  if (!v || typeof v !== 'object') return null;
  const n = (v as any).constructor?.name;
  return (TRACKED as readonly string[]).includes(n) ? (n as TrackedType) : null;
};

/**
 * Decoded frames are the ones that actually leak, and they never pass through a
 * constructor: the platform creates them and hands them to the `output`
 * callback. Counting only `new VideoFrame()` misses essentially all of them.
 */
function wrapCodecInit(
  init: any,
  birthSite: string,
  emits: TrackedType | null,
  holder: { codec: any },
): any {
  if (!init || typeof init !== 'object') return init;
  const { output, error } = init;
  if (typeof output !== 'function') return init;

  return {
    ...init,
    output(this: unknown, obj: any, ...rest: unknown[]) {
      state.activity.outputs++;
      // Prefer what the object says it is, but fall back to what this codec is
      // defined to emit. `constructor.name` is the one identifier here we do not
      // control, and a wrapped or proxied frame could report something else.
      const t = isTracked(obj) ?? (obj && typeof obj === 'object' ? emits : null);
      // The platform calls this, so there are no application frames above us.
      // Attribute the frame to the codec that produced it instead — that is the
      // line a developer can actually act on.
      if (t) track(t, obj, 'decoded', birthSite);
      return output.call(this, obj, ...rest);
    },
    error:
      typeof error === 'function'
        ? function (this: unknown, e: unknown) {
            state.activity.errors++;
            // The spec closes the codec at step 2 and calls this at step 4, so
            // the resource is already gone. Record it HERE rather than at the
            // next sample tick: the codec is usually unreachable the moment
            // this callback returns, and a GC that runs first would file it as
            // collectedUnclosed — a leak report for something already
            // reclaimed. Chrome on Linux loses that race routinely.
            try {
              if (holder.codec && holder.codec.state === 'closed') {
                release(holder.codec, 'closedByPlatform');
              }
            } catch {
              /* reading state on a dead codec is not worth an exception here */
            }
            return error.call(this, e);
          }
        : error,
  };
}

/**
 * What each codec hands to its output callback. Encoders emit EncodedChunks,
 * which own no external resource and need no close(), so only decoders produce
 * something worth tracking.
 */
const CODEC_EMITS: Record<string, TrackedType | null> = {
  VideoDecoder: 'VideoFrame',
  AudioDecoder: 'AudioData',
  VideoEncoder: null,
  AudioEncoder: null,
};
const CODECS = Object.keys(CODEC_EMITS);

function patchConstructor(name: TrackedType): void {
  const Original = g[name];
  if (typeof Original !== 'function') return; // unsupported in this context
  if (Original.__wccPatched) return;

  const isCodec = CODECS.includes(name);

  const Patched = new Proxy(Original, {
    construct(target, args, newTarget) {
      const site = isCodec ? captureStack() : '';
      // The error callback needs the codec it belongs to, and the codec does
      // not exist until Reflect.construct returns. One box, filled in after.
      const holder = { codec: null as any };
      const patchedArgs = isCodec
        ? [
            wrapCodecInit(
              args[0],
              `${site}\n    (frame emitted by this ${name})`,
              CODEC_EMITS[name] ?? null,
              holder,
            ),
            ...args.slice(1),
          ]
        : args;
      const obj = Reflect.construct(target, patchedArgs, newTarget);
      if (isCodec) {
        // A WeakRef, so the holder cannot be what keeps the codec alive.
        const weak = new WeakRef(obj);
        Object.defineProperty(holder, 'codec', { get: () => weak.deref() });
        state.codecs.add(weak);
      }
      track(name, obj, 'constructed');
      return obj;
    },
  });
  (Patched as any).__wccPatched = true;
  g[name] = Patched;

  const proto = Original.prototype;
  if (!proto) return;

  // A `close()` that throws is a lifecycle bug the platform reports to nobody
  // useful. Closing an already-closed codec throws InvalidStateError (measured
  // on Chrome 151; the four codec types throw, the frame types are idempotent),
  // and in a library that closes from a floating `.finally` it surfaces as an
  // unhandled rejection no application code can catch. Counted here, with the
  // line that did it, because there is no other place to see it.
  patchMethod(
    proto,
    'close',
    (self) => release(self, 'closed'),
    undefined,
    (self, err) => recordOverClose(self, err),
  );

  // clone() hands back an independent handle that needs its own close(), and it
  // does not go through the construct trap.
  patchMethod(proto, 'clone', undefined, (self, result) => {
    const t = isTracked(result);
    if (t) track(t, result as object, 'cloned');
  });

  if (isCodec) {
    patchMethod(proto, 'decode', () => state.activity.decodeCalls++);
    patchMethod(proto, 'encode', () => state.activity.encodeCalls++);
  }
}

function patchMethod(
  proto: any,
  name: string,
  before?: (self: any, args: unknown[]) => void,
  after?: (self: any, result: unknown) => void,
  onThrow?: (self: any, err: unknown) => void,
): void {
  const original = proto[name];
  if (typeof original !== 'function' || original.__wccPatched) return;
  const patched = function (this: any, ...args: unknown[]) {
    before?.(this, args);
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      // Observed, never swallowed: the caller must still see what the platform
      // threw, or instrumenting the app would change how it behaves.
      onThrow?.(this, err);
      throw err;
    }
    after?.(this, result);
    return result;
  };
  (patched as any).__wccPatched = true;
  try {
    proto[name] = patched;
  } catch {
    /* frozen prototype; nothing to do */
  }
}

/**
 * Transferring a VideoFrame detaches the sender's handle without calling
 * close(), and the receiver gets it by structured clone rather than a
 * constructor. Unaccounted, that reads as a leak here and as nothing at all
 * there.
 */
function patchPostMessage(): void {
  const targets = [
    g,
    typeof MessagePort !== 'undefined' ? MessagePort.prototype : null,
    typeof Worker !== 'undefined' ? Worker.prototype : null,
  ].filter(Boolean);

  for (const target of targets as any[]) {
    const original = target.postMessage;
    if (typeof original !== 'function' || original.__wccPatched) continue;
    const patched = function (this: any, message: unknown, ...rest: any[]) {
      const list = Array.isArray(rest[0]) ? rest[0] : rest[0]?.transfer;
      if (Array.isArray(list)) {
        for (const item of list) release(item, 'transferred');
      }
      return original.apply(this, [message, ...rest]);
    };
    patched.__wccPatched = true;
    try {
      target.postMessage = patched;
    } catch {
      /* ignore */
    }
  }
}

/**
 * The receive side of a transfer. Objects arrive inside `event.data` without
 * ever being constructed here, so scan incoming messages for them. Depth is
 * bounded — this runs on every message and must stay cheap.
 */
const SCAN_DEPTH = 3;
const SCAN_BREADTH = 64;

function adopt(value: unknown, depth = 0, seen = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || depth > SCAN_DEPTH) return;
  if (seen.has(value)) return;
  seen.add(value);

  const t = isTracked(value);
  if (t) {
    track(t, value as object, 'received');
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, SCAN_BREADTH)) adopt(v, depth + 1, seen);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return; // only plain carriers
  let n = 0;
  for (const k in value as object) {
    if (n++ > SCAN_BREADTH) break;
    adopt((value as any)[k], depth + 1, seen);
  }
}

function patchIncomingMessages(): void {
  const proto =
    typeof EventTarget !== 'undefined' ? EventTarget.prototype : null;
  if (!proto) return;
  const original = proto.addEventListener;
  if ((original as any).__wccPatched) return;

  const patched = function (this: EventTarget, type: string, listener: any, ...rest: any[]) {
    if (type === 'message' && typeof listener === 'function') {
      const wrapped = function (this: unknown, event: MessageEvent) {
        adopt(event?.data);
        return listener.call(this, event);
      };
      // Keep removeEventListener working with the caller's original reference.
      (listener as any).__wccWrapped ??= wrapped;
      return original.call(this, type, (listener as any).__wccWrapped, ...rest);
    }
    return original.call(this, type, listener, ...rest);
  };
  (patched as any).__wccPatched = true;
  proto.addEventListener = patched;

  const originalRemove = proto.removeEventListener;
  if (!(originalRemove as any).__wccPatched) {
    const patchedRemove = function (this: EventTarget, type: string, listener: any, ...rest: any[]) {
      const target = type === 'message' && listener?.__wccWrapped ? listener.__wccWrapped : listener;
      return originalRemove.call(this, type, target, ...rest);
    };
    (patchedRemove as any).__wccPatched = true;
    proto.removeEventListener = patchedRemove;
  }

  // `onmessage = fn` bypasses addEventListener entirely.
  for (const holder of [g, typeof MessagePort !== 'undefined' ? MessagePort.prototype : null]) {
    if (!holder) continue;
    const desc = Object.getOwnPropertyDescriptor(holder, 'onmessage');
    if (!desc?.set || (desc.set as any).__wccPatched) continue;
    const originalSet = desc.set;
    const patchedSet = function (this: any, fn: any) {
      const wrapped =
        typeof fn === 'function'
          ? function (this: unknown, event: MessageEvent) {
              adopt(event?.data);
              return fn.call(this, event);
            }
          : fn;
      return originalSet.call(this, wrapped);
    };
    (patchedSet as any).__wccPatched = true;
    try {
      Object.defineProperty(holder, 'onmessage', { ...desc, set: patchedSet });
    } catch {
      /* ignore */
    }
  }
}

/** Media elements are the resource behind Chrome's per-frame WebMediaPlayer cap. */
function patchMediaElements(): void {
  if (typeof HTMLMediaElement === 'undefined') return;
  const proto = HTMLMediaElement.prototype;
  const remember = (el: HTMLMediaElement) => state.mediaElements.add(new WeakRef(el));

  for (const prop of ['src', 'srcObject'] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.set || (desc.set as any).__wccPatched) continue;
    const originalSet = desc.set;
    const patchedSet = function (this: HTMLMediaElement, value: any) {
      if (value) remember(this);
      return originalSet.call(this, value);
    };
    (patchedSet as any).__wccPatched = true;
    Object.defineProperty(proto, prop, { ...desc, set: patchedSet });
  }

  // load() catches elements whose source came from a <source> child or markup.
  patchMethod(proto, 'load', (self) => remember(self));
}

function mediaElementCensus(): MediaElementCensus {
  const byReadyState: Record<number, number> = {};
  let total = 0;
  let stalled = 0;

  for (const ref of [...state.mediaElements]) {
    const el = ref.deref();
    if (!el) {
      state.mediaElements.delete(ref);
      continue;
    }
    total++;
    byReadyState[el.readyState] = (byReadyState[el.readyState] ?? 0) + 1;
    // NETWORK_LOADING with nothing decoded: it asked for a player and never got
    // one. This is what a blocked WebMediaPlayer looks like from JS.
    if (el.readyState === 0 && el.networkState === 2) stalled++;
  }
  return { total, stalled, byReadyState };
}

/**
 * Live codec queue depth and configured count — busy versus wedged — and the
 * reconciliation that keeps a platform close from reading as a leak.
 *
 * A codec that fails is closed by the platform, not by JS: the spec's Close
 * algorithm sets `[[state]]` to "closed" *before* it invokes the error
 * callback, so no `close()` call ever reaches our patch. Left alone, that
 * codec stays counted live and, once collected, is filed as
 * `collectedUnclosed` — "definitively leaked" for a resource the platform
 * already reclaimed. `state === 'closed'` is the only honest signal that it
 * went, whoever closed it.
 */
function codecPressure(): { queued: number; configured: number } {
  let queued = 0;
  let configured = 0;
  for (const ref of [...state.codecs]) {
    const c = ref.deref();
    if (!c) {
      state.codecs.delete(ref);
      continue;
    }
    try {
      if (c.state === 'closed') {
        release(c, 'closedByPlatform');
        state.codecs.delete(ref);
        continue;
      }
      if (c.state === 'configured') configured++;
      queued += c.decodeQueueSize ?? c.encodeQueueSize ?? 0;
    } catch {
      /* closed mid-read */
    }
  }
  return { queued, configured };
}

function liveByType(): Partial<Record<TrackedType, number>> {
  const live: Record<string, number> = {};
  for (const e of state.liveEntries.values()) bump(live, e.type);
  return live;
}

/**
 * The ages of live objects, per type, oldest first — the exact input an
 * age-filtered verdict needs, which a count alone cannot provide.
 *
 * Capped, and capped from the OLD end on purpose. A verdict asks "how many are
 * at least this old", and an answer of "at least LIVE_AGES_CAP" settles that
 * question for any tolerance below the cap. Keeping the oldest therefore costs
 * nothing decidable while bounding a payload that would otherwise grow with
 * the size of the leak — which is exactly when it is already too big.
 */
function liveAgesByType(t: number): Partial<Record<TrackedType, number[]>> {
  const byType = new Map<TrackedType, number[]>();
  for (const e of state.liveEntries.values()) {
    const ages = byType.get(e.type);
    if (ages) ages.push(Math.round(t - e.at));
    else byType.set(e.type, [Math.round(t - e.at)]);
  }
  const out: Partial<Record<TrackedType, number[]>> = {};
  for (const [type, ages] of byType) {
    out[type] = ages.sort((a, b) => b - a).slice(0, LIVE_AGES_CAP);
  }
  return out;
}

function delta(current: Record<string, number>, previous: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(current)) {
    const d = v - (previous[k] ?? 0);
    if (d) out[k.split(':')[0]] = (out[k.split(':')[0]] ?? 0) + d;
  }
  return out;
}

function takeSample(): void {
  const pressure = codecPressure();
  state.timeline.push({
    t: Math.round(now() - state.installedAt),
    live: liveByType(),
    gained: delta(state.entered, state.prevEntered),
    lost: delta(state.left, state.prevLeft),
    activity: { ...state.activity, ...pressure },
    mediaElements: mediaElementCensus(),
  });
  state.prevEntered = { ...state.entered };
  state.prevLeft = { ...state.left };
  state.activity = zeroActivity();
  if (state.timeline.length > state.opts.keepSamples) state.timeline.shift();
}

/** Group live objects by allocation site — this is how a leak is found. */
function leakSites(): LeakSite[] {
  const groups = new Map<string, LeakSite>();
  const t = now();
  for (const e of state.liveEntries.values()) {
    const k = `${e.type}|${e.origin}|${e.stack}`;
    const existing = groups.get(k);
    if (existing) {
      existing.count++;
      existing.oldestAgeMs = Math.max(existing.oldestAgeMs, Math.round(t - e.at));
    } else {
      groups.set(k, {
        type: e.type,
        origin: e.origin,
        stack: e.stack,
        count: 1,
        oldestAgeMs: Math.round(t - e.at),
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.oldestAgeMs - a.oldestAgeMs);
}

/** Snapshot this context only. */
export function localCensus(): ContextCensus {
  // Before counting anything: a codec the platform closed is not live, and
  // saying so here rather than at the next sample tick keeps a census taken
  // straight after a decode error from reporting a leak that is not one.
  codecPressure();
  const t = now();
  const oldestLive: LiveObject[] = [...state.liveEntries.values()]
    .sort((a, b) => a.at - b.at)
    .slice(0, 10)
    .map((e) => ({
      type: e.type,
      origin: e.origin,
      stack: e.stack,
      ageMs: Math.round(t - e.at),
    }));

  return {
    context: state.context,
    uptimeMs: Math.round(t - state.installedAt),
    entered: { ...state.entered },
    left: { ...state.left },
    live: liveByType(),
    liveAges: liveAgesByType(t),
    liveAgesCap: LIVE_AGES_CAP,
    collectedUnclosed: { ...state.collectedUnclosed } as Partial<Record<TrackedType, number>>,
    closedUnseen: state.closedUnseen,
    overCloses: [...state.overCloses.values()].sort((a, b) => b.count - a.count),
    leakSites: leakSites(),
    oldestLive,
    mediaElements: mediaElementCensus(),
    timeline: [...state.timeline],
    problems: [...installProblems],
  };
}

/** The rolling timeline on its own. */
export function timeline(): Sample[] {
  return [...state.timeline];
}

/** Clear the counters without unpatching. Tests need this; nothing else should. */
export function resetCensus(): void {
  Object.assign(state, freshCounters());
  state.installedAt = now();
}

/** Install in the current context. Safe to call more than once. */
export function installCensus(options: InstallOptions = {}): void {
  if (options.context) state.context = options.context;
  if (state.installed) return;
  state.installed = true;
  state.installedAt = now();
  state.opts = { ...state.opts, ...stripUndefined(options) };

  // Each step is independent, and this runs in contexts we do not control. One
  // missing global must not cost us every other patch — a census that silently
  // installed nothing would report "no leaks" for an app that is leaking.
  for (const cls of TRACKED) safely(`patch ${cls}`, () => patchConstructor(cls));
  safely('patch postMessage', patchPostMessage);
  safely('patch incoming messages', patchIncomingMessages);
  safely('patch media elements', patchMediaElements);
  safely('start sampler', maybeStartSampler);

  g.__webcodecsCensus = Object.assign(() => localCensus(), {
    local: localCensus,
    timeline,
    reset: resetCensus,
    version: VERSION,
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A close() that threw, grouped by the line that called it. Grouped because
 * the thing doing it runs per frame: one site, one entry, a count beside it.
 */
function recordOverClose(self: unknown, err: unknown): void {
  const type = isTracked(self);
  if (!type) return;
  const stack = captureStack();
  const message = (err as Error)?.message ?? String(err);
  const k = `${type}\u0000${message}\u0000${stack}`;
  const found = state.overCloses.get(k);
  if (found) found.count++;
  else state.overCloses.set(k, { type, message, stack, count: 1 });
}

/** Record what could not be patched instead of aborting the whole install. */
export const installProblems: string[] = [];

function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    installProblems.push(`${what}: ${(e as Error)?.message ?? e}`);
  }
}

export const VERSION = '0.3.0';
