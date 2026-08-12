/**
 * Patch mode: no debugger, no banner, works alongside DevTools.
 *
 * The census itself is a separate `world: "MAIN"` content script, declared in
 * the manifest so Chrome runs it at document_start. Injecting a <script src>
 * tag from here instead would be too late: a dynamically inserted script does
 * not block the parser, so the page's own module scripts run first and the
 * census misses everything they allocate.
 *
 * Chrome still does not promise a MAIN-world content script beats a page's
 * *inline* scripts, and this mode cannot see a worker that started before it.
 * Exact mode (chrome.debugger) has neither gap; this file only bridges
 * messages between the page world and the extension.
 */

(() => {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__webcodecsCensus !== 'reply') return;
    chrome.runtime.sendMessage({ type: 'census:reply', payload: event.data.payload }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'census:collect') return;
    const id = Math.random().toString(36).slice(2);
    const onReply = (event) => {
      if (event.source !== window || event.data?.__webcodecsCensus !== 'reply') return;
      if (event.data.id !== id) return;
      window.removeEventListener('message', onReply);
      sendResponse(event.data.payload);
    };
    window.addEventListener('message', onReply);
    window.postMessage({ __webcodecsCensus: 'collect', id }, '*');
    setTimeout(() => {
      window.removeEventListener('message', onReply);
      sendResponse(null);
    }, 1500);
    return true; // async response
  });
})();
