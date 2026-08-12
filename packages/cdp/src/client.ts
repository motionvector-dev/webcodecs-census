/**
 * A minimal flat-session Chrome DevTools Protocol client.
 *
 * Deliberately dependency-free: it runs on the WebSocket built into Node 22 and
 * exists only to carry the handful of commands the injector needs. Anything
 * larger would pull in a browser-automation stack that users of this tool
 * already have.
 */

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  sessionId?: string;
  result?: any;
  error?: { code: number; message: string };
}

export type Unsubscribe = () => void;

export class CdpClient {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(m: CdpMessage) => void>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => this.#dispatch(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(new Error('CDP connection closed'));
      }
      this.#pending.clear();
    };
  }

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not open a CDP socket at ${webSocketDebuggerUrl}`));
      };
    });
    return new CdpClient(ws);
  }

  #dispatch(msg: CdpMessage): void {
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id)!;
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of this.#listeners) {
      try {
        fn(msg);
      } catch {
        /* a listener must not break the socket */
      }
    }
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#nextId++;
    const payload: CdpMessage = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /**
   * Commands that races can legitimately lose — a worker that finished while a
   * command was in flight leaves no session to answer.
   */
  async trySend<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T | null> {
    try {
      return await this.send<T>(method, params, sessionId);
    } catch {
      return null;
    }
  }

  on(fn: (m: CdpMessage) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** Resolve a page target's socket from a `--remote-debugging-port` endpoint. */
export async function findPageTarget(
  origin: string,
  match?: (t: any) => boolean,
): Promise<{ webSocketDebuggerUrl: string; url: string; id: string }> {
  const res = await fetch(new URL('/json/list', origin));
  if (!res.ok) throw new Error(`${origin} is not a DevTools endpoint (HTTP ${res.status})`);
  const targets = (await res.json()) as any[];
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const chosen = match ? pages.find(match) : pages[0];
  if (!chosen) {
    throw new Error(
      `No matching page target at ${origin}. Saw: ${targets.map((t) => `${t.type} ${t.url}`).join(', ') || 'nothing'}`,
    );
  }
  return chosen;
}
