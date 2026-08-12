/**
 * Exact mode.
 *
 * Same mechanism as the CDP package, driven through chrome.debugger so it works
 * on a tab the user is already looking at. Two pauses per worker:
 *
 *   1. auto-attach pause — too early to patch codecs (VideoDecoder and the
 *      timer functions do not exist yet in a dedicated worker at that point)
 *   2. beforeScriptExecution — everything exists, still before the worker's
 *      own first line. This is where the census goes in.
 *
 * Costs a "debugging this browser" banner and cannot share a tab with an open
 * DevTools window. Patch mode exists for when that trade is not worth it.
 */

import { SHIM_SOURCE } from './shim-source.js';

const attached = new Map(); // tabId -> { workers: Map<sessionId, info>, pending: Map }

const bootstrap = (options) => `(() => { try {
  globalThis.__webcodecsCensusOptions = ${JSON.stringify(options ?? {})};
${SHIM_SOURCE}
} catch (e) { console.warn('[webcodecs-census] install failed:', e && e.message); } })();`;

async function send(target, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch {
    return null;
  }
}

export async function enableExactMode(tabId, options = {}) {
  if (attached.has(tabId)) return attached.get(tabId);

  await chrome.debugger.attach({ tabId }, '1.3');
  const state = { workers: new Map(), pending: new Map(), options };
  attached.set(tabId, state);

  const source = bootstrap(options);
  await send({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await send({ tabId }, 'Page.enable');
  await send({ tabId }, 'Runtime.enable');
  await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source });
  await send({ tabId }, 'Runtime.evaluate', { expression: source });

  return state;
}

export async function disableExactMode(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const state = attached.get(source.tabId);
  if (!state) return;
  const shim = bootstrap(state.options);

  if (method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    if (!/worker/i.test(targetInfo.type)) return;

    state.workers.set(sessionId, { type: targetInfo.type, url: targetInfo.url });
    await send({ tabId: source.tabId, sessionId }, 'Runtime.enable');

    const enabled = await send({ tabId: source.tabId, sessionId }, 'Debugger.enable');
    const bp = enabled
      ? await send({ tabId: source.tabId, sessionId }, 'Debugger.setInstrumentationBreakpoint', {
          instrumentation: 'beforeScriptExecution',
        })
      : null;

    if (bp) {
      state.pending.set(sessionId, targetInfo);
    } else {
      // No Debugger domain: patch what exists now and record the shortfall.
      await send({ tabId: source.tabId, sessionId }, 'Runtime.evaluate', { expression: shim });
    }

    // Always resume, even on failure — a paused worker hangs the page.
    if (waitingForDebugger) {
      await send({ tabId: source.tabId, sessionId }, 'Runtime.runIfWaitingForDebugger');
    }
    // Auto-attach does not recurse; arm this target for its own children.
    await send({ tabId: source.tabId, sessionId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    return;
  }

  if (method === 'Debugger.paused') {
    const sessionId = source.sessionId;
    if (!sessionId || !state.pending.has(sessionId)) return;
    if (params?.reason && params.reason !== 'instrumentation') return;
    state.pending.delete(sessionId);

    await send({ tabId: source.tabId, sessionId }, 'Runtime.evaluate', { expression: shim });
    await send({ tabId: source.tabId, sessionId }, 'Debugger.resume');
    await send({ tabId: source.tabId, sessionId }, 'Debugger.disable');
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

/** Query every instrumented context in a tab. */
async function collectExact(tabId) {
  const state = attached.get(tabId);
  if (!state) return null;

  const expression =
    'JSON.stringify(typeof __webcodecsCensus === "function" ? __webcodecsCensus.local() : null)';
  const out = [];

  const page = await send({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true });
  if (page?.result?.value) out.push(JSON.parse(page.result.value));

  for (const [sessionId, info] of state.workers) {
    const res = await send({ tabId, sessionId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (res?.result?.value) {
      const parsed = JSON.parse(res.result.value);
      if (parsed) out.push({ ...parsed, targetUrl: info.url, targetType: info.type });
    }
  }
  return { censuses: out, mode: 'exact' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = msg?.tabId ?? sender.tab?.id;
    switch (msg?.type) {
      case 'mode:exact:on':
        await enableExactMode(tabId, msg.options);
        sendResponse({ ok: true });
        break;
      case 'mode:exact:off':
        await disableExactMode(tabId);
        sendResponse({ ok: true });
        break;
      case 'census:get':
        if (attached.has(tabId)) {
          sendResponse(await collectExact(tabId));
        } else {
          sendResponse(await chrome.tabs.sendMessage(tabId, { type: 'census:collect' }).catch(() => null));
        }
        break;
      case 'mode:status':
        sendResponse({ exact: attached.has(tabId) });
        break;
      default:
        sendResponse(null);
    }
  })();
  return true;
});
