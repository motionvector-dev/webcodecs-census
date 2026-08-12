/**
 * Getting the census into every context of a page, including its workers.
 *
 * Page-level monkey-patching — how every other web-graphics inspector works —
 * cannot reach a dedicated worker the page created, and a WebCodecs decoder
 * almost always lives in one. Two Chrome behaviours make it reachable here:
 *
 *   Page.addScriptToEvaluateOnNewDocument runs before any page script, on every
 *   navigation, which a `document_start` content script does not guarantee.
 *
 *   Target.setAutoAttach with waitForDebuggerOnStart pauses each new worker
 *   before its first line, so an object allocated on line 1 is still counted.
 *
 * There is a trap in the second one. At the auto-attach pause a dedicated
 * worker's global is only half built: VideoFrame, AudioData, ImageBitmap and
 * EncodedVideoChunk exist, but all four codec constructors and every timer
 * function are still undefined (measured on Chrome 151). Patching there
 * silently misses every VideoDecoder — which is most of what this tool is for.
 *
 * So we resume into a second, later pause: a `beforeScriptExecution`
 * instrumentation breakpoint. That fires with the global fully populated and
 * still before the worker's own script runs, which is the only moment that is
 * both complete and early enough.
 *
 * Auto-attach is not recursive, so every attached target arms it again for its
 * own children; that is what reaches nested workers.
 */

import { CdpClient, findPageTarget } from './client';

export interface AttachOptions {
  /** DevTools HTTP endpoint, e.g. `http://127.0.0.1:9222`. */
  browserURL?: string;
  /** Or a page target's WebSocket URL directly. */
  webSocketDebuggerUrl?: string;
  /** Choose among page targets when several are open. */
  matchUrl?: string | RegExp;
  /** Override the injected source. Defaults to the built census shim. */
  shimSource?: string;
  /** Passed to installCensus inside each context. */
  install?: { sampleIntervalMs?: number | false; keepSamples?: number; stackDepth?: number };
  onContext?: (info: { type: string; url: string; sessionId: string | null }) => void;
  onError?: (e: Error) => void;
}

export interface AttachedContext {
  sessionId: string | null; // null is the page's own session
  type: string;
  url: string;
}

const WORKER_TYPES = /worker/i;

export class CensusSession {
  #client: CdpClient;
  #contexts = new Map<string, AttachedContext>();
  #shim: string;
  #onError: (e: Error) => void;
  #onContext: AttachOptions['onContext'];
  #detachListener: (() => void) | null = null;
  /** Workers resumed toward the instrumentation breakpoint, awaiting injection. */
  #pendingInjection = new Map<string, { type: string; url: string }>();

  private constructor(client: CdpClient, shim: string, onError: (e: Error) => void) {
    this.#client = client;
    this.#shim = shim;
    this.#onError = onError;
  }

  static async attach(options: AttachOptions): Promise<CensusSession> {
    const shim = options.shimSource ?? (await loadShim());
    const bootstrap = wrapShim(shim, options.install);

    let wsUrl = options.webSocketDebuggerUrl;
    let pageUrl = '';
    if (!wsUrl) {
      if (!options.browserURL) {
        throw new Error('attach needs either browserURL or webSocketDebuggerUrl');
      }
      const matcher = toMatcher(options.matchUrl);
      const target = await findPageTarget(options.browserURL, matcher);
      wsUrl = target.webSocketDebuggerUrl;
      pageUrl = target.url;
    }

    const client = await CdpClient.connect(wsUrl!);
    const session = new CensusSession(client, bootstrap, options.onError ?? (() => {}));
    session.#contexts.set('page', { sessionId: null, type: 'page', url: pageUrl });

    session.#onContext = options.onContext;
    session.#detachListener = client.on((msg) => {
      if (msg.method === 'Target.attachedToTarget') {
        void session.#onAttached(msg.params);
      } else if (msg.method === 'Debugger.paused' && msg.sessionId) {
        void session.#onScriptPause(msg.sessionId, msg.params);
      } else if (msg.method === 'Target.detachedFromTarget') {
        session.#contexts.delete(msg.params.sessionId);
        session.#pendingInjection.delete(msg.params.sessionId);
      }
    });

    // Order matters: arm auto-attach and register the document script before
    // anything navigates, or a worker can start unobserved.
    await session.#arm(undefined);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });

    // The page may already be loaded, in which case the document script has not
    // run for it. Installing again is a no-op by design.
    await client.trySend('Runtime.evaluate', { expression: bootstrap, awaitPromise: false });

    options.onContext?.({ type: 'page', url: pageUrl, sessionId: null });
    return session;
  }

  async #arm(sessionId: string | undefined): Promise<void> {
    await this.#client.trySend(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
  }

  async #onAttached(params: any): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    const isWorker = WORKER_TYPES.test(targetInfo.type);
    let deferredToScriptPause = false;

    try {
      if (isWorker) {
        this.#contexts.set(sessionId, { sessionId, type: targetInfo.type, url: targetInfo.url });
        await this.#client.trySend('Runtime.enable', {}, sessionId);

        // Prefer the later, complete pause. Only if the Debugger domain is
        // unavailable do we settle for the half-built global here, which can
        // still catch frame allocations even though it will miss codecs.
        const armed = await this.#armScriptPause(sessionId);
        if (armed) {
          this.#pendingInjection.set(sessionId, { type: targetInfo.type, url: targetInfo.url });
          deferredToScriptPause = true;
        } else {
          await this.#inject(sessionId, targetInfo);
        }
      } else if (targetInfo.type === 'iframe') {
        await this.#client.trySend(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: this.#shim },
          sessionId,
        );
      }

      // Reach this target's own children — auto-attach does not recurse.
      await this.#arm(sessionId);
    } catch (e) {
      this.#onError(e as Error);
      deferredToScriptPause = false;
    } finally {
      // Always release the target, even if injection failed. Leaving a worker
      // paused would hang the page under test, which is far worse than a gap in
      // the census. When deferring, this resume is what carries execution
      // forward to the instrumentation breakpoint.
      if (waitingForDebugger) {
        await this.#client.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);
      }
      if (!deferredToScriptPause && this.#pendingInjection.has(sessionId)) {
        this.#pendingInjection.delete(sessionId);
      }
    }
  }

  async #armScriptPause(sessionId: string): Promise<boolean> {
    const enabled = await this.#client.trySend('Debugger.enable', {}, sessionId);
    if (enabled === null) return false;
    const bp = await this.#client.trySend(
      'Debugger.setInstrumentationBreakpoint',
      { instrumentation: 'beforeScriptExecution' },
      sessionId,
    );
    if (bp === null) {
      await this.#client.trySend('Debugger.disable', {}, sessionId);
      return false;
    }
    return true;
  }

  /**
   * The complete-global moment. Inject once, then get out of the way — leaving
   * the breakpoint armed would pause on every subsequent script the worker
   * loads and stall the app under test.
   */
  async #onScriptPause(sessionId: string, params: any): Promise<void> {
    const target = this.#pendingInjection.get(sessionId);
    if (!target) return; // not ours, or already injected
    this.#pendingInjection.delete(sessionId);

    try {
      if (params?.reason && params.reason !== 'instrumentation') {
        // Someone else's breakpoint; do not hijack it.
        return;
      }
      await this.#inject(sessionId, target);
    } catch (e) {
      this.#onError(e as Error);
    } finally {
      await this.#client.trySend('Debugger.resume', {}, sessionId);
      await this.#client.trySend('Debugger.disable', {}, sessionId);
    }
  }

  async #inject(sessionId: string, target: { type: string; url: string }): Promise<void> {
    const result: any = await this.#client.trySend(
      'Runtime.evaluate',
      { expression: this.#shim, awaitPromise: false },
      sessionId,
    );
    if (result?.exceptionDetails) {
      this.#onError(
        new Error(
          `census failed to install in ${target.type} ${target.url}: ` +
            (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text),
        ),
      );
      return;
    }
    this.#onContext?.({ type: target.type, url: target.url, sessionId });
  }

  /** Every context currently instrumented. */
  contexts(): AttachedContext[] {
    return [...this.#contexts.values()];
  }

  /**
   * Snapshot every context. Each is queried on its own session, so no
   * cross-context message channel is needed and a wedged worker cannot stop the
   * others from reporting.
   */
  async census(): Promise<any[]> {
    const out: any[] = [];
    for (const ctx of this.#contexts.values()) {
      const result = await this.#client.trySend(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify(typeof __webcodecsCensus === "function" ? __webcodecsCensus.local() : null)',
          returnByValue: true,
          timeout: 2000,
        },
        ctx.sessionId ?? undefined,
      );
      const raw = result?.result?.value;
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed) out.push({ ...parsed, targetUrl: ctx.url, targetType: ctx.type });
      } catch {
        /* a context that died mid-read */
      }
    }
    return out;
  }

  /** Run an expression in one context, or the page by default. */
  async evaluate<T = unknown>(expression: string, sessionId?: string): Promise<T | null> {
    const result = await this.#client.trySend(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return (result?.result?.value ?? null) as T | null;
  }

  async navigate(url: string): Promise<void> {
    await this.#client.send('Page.navigate', { url });
  }

  /**
   * Serve a remote URL from somewhere else. Useful for pinning a large media
   * asset to a local copy so a run is fast and repeatable without editing the
   * application under test.
   */
  async redirect(rules: { from: string | RegExp; to: string }[]): Promise<void> {
    await this.#client.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    this.#client.on(async (msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      const hit = rules.find((r) =>
        typeof r.from === 'string' ? request.url.includes(r.from) : r.from.test(request.url),
      );
      if (hit) {
        await this.#client.trySend('Fetch.continueRequest', { requestId, url: hit.to });
      } else {
        await this.#client.trySend('Fetch.continueRequest', { requestId });
      }
    });
  }

  detach(): void {
    this.#detachListener?.();
    this.#client.close();
  }
}

function toMatcher(matchUrl?: string | RegExp) {
  if (!matchUrl) return undefined;
  const re = typeof matchUrl === 'string' ? null : matchUrl;
  return (t: any) => (re ? re.test(t.url) : String(t.url).includes(matchUrl as string));
}

/**
 * Hand the shim its options and keep a failure from breaking the page. This
 * runs in contexts we do not control, so it must never throw: a context without
 * WebCodecs is a normal outcome, not an error.
 */
function wrapShim(shim: string, install?: AttachOptions['install']): string {
  return `(() => { try {
  globalThis.__webcodecsCensusOptions = ${JSON.stringify(install ?? {})};
${shim}
} catch (e) { console.warn('[webcodecs-census] install failed:', e && e.message); } })();`;
}

async function loadShim(): Promise<string> {
  const { SHIM_SOURCE } = await import('@unfoundbox/webcodecs-census/shim');
  return SHIM_SOURCE as string;
}

export async function attach(options: AttachOptions): Promise<CensusSession> {
  return CensusSession.attach(options);
}
