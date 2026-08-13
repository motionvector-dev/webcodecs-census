/**
 * Reaching workers without a debugger attached.
 *
 * This is the best-effort half of the tool, used when the exact CDP path is not
 * available. It rewrites `new Worker(url)` to point at a small blob that loads
 * the census first and the real worker second.
 *
 * It is genuinely weaker than the CDP path, and the honest limits are:
 *
 *   - A page whose CSP omits `blob:` from worker-src/script-src cannot create a
 *     blob worker at all. We detect the throw and fall back to the original URL,
 *     so the app keeps working and the worker simply goes uninstrumented.
 *   - `self.location` inside the worker becomes the blob URL, so a worker that
 *     builds paths from `self.location` will resolve them differently. Workers
 *     using `import.meta.url` are unaffected.
 *   - A worker already running before this patch installs is never covered.
 *
 * Anything reported as uninstrumented is recorded, not swallowed: a census that
 * quietly missed a worker would report "no leaks" for a leaking app.
 */

const g = globalThis as any;
const PATCH_KEY = Symbol.for('motionvector.webcodecs-census.worker-patch');

export interface WorkerPatchState {
  wrapped: number;
  skipped: { url: string; reason: string }[];
}

export function installWorkerPatch(shimSource: string): WorkerPatchState {
  if (g[PATCH_KEY]) return g[PATCH_KEY];
  const state: WorkerPatchState = { wrapped: 0, skipped: [] };
  g[PATCH_KEY] = state;

  if (typeof Worker !== 'function' || typeof URL?.createObjectURL !== 'function') {
    state.skipped.push({ url: '*', reason: 'no Worker or blob URL support here' });
    return state;
  }

  const OriginalWorker = Worker;
  let shimUrl: string | null = null;
  const shimBlobUrl = () => {
    shimUrl ??= URL.createObjectURL(new Blob([shimSource], { type: 'text/javascript' }));
    return shimUrl;
  };

  g.Worker = new Proxy(OriginalWorker, {
    construct(target, args: any[], newTarget) {
      const [scriptUrl, options] = args;
      try {
        const absolute = new URL(String(scriptUrl), location.href).href;
        const isModule = options?.type === 'module';
        const loader = isModule
          ? `import ${JSON.stringify(shimBlobUrl())};\nimport ${JSON.stringify(absolute)};\n`
          : `importScripts(${JSON.stringify(shimBlobUrl())});\nimportScripts(${JSON.stringify(absolute)});\n`;
        const loaderUrl = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));

        const worker = Reflect.construct(target, [loaderUrl, options], newTarget);
        state.wrapped++;
        return worker;
      } catch (e) {
        // Most often a CSP that forbids blob: workers. Never break the app for
        // the sake of instrumenting it.
        state.skipped.push({
          url: String(scriptUrl),
          reason: (e as Error)?.message ?? 'unknown',
        });
        return Reflect.construct(target, args, newTarget);
      }
    },
  });

  return state;
}

/** What the patch could not cover, for reporting alongside a census. */
export function workerPatchState(): WorkerPatchState | null {
  return g[PATCH_KEY] ?? null;
}
