/**
 * Which origins the user has asked to instrument.
 *
 * Nothing is instrumented until someone opts a site in. An earlier version
 * declared content scripts on <all_urls>, which patched the WebCodecs globals
 * and exposed the census API in the main world of every page the user visited,
 * for a tool you only ever need on one app. That is the wrong default however
 * useful the tool is.
 *
 * Patch mode has to run at document_start to see anything allocated during
 * startup, so opting in registers a real content script for that origin rather
 * than injecting on click — injecting when the popup opens would arrive long
 * after the app had built its decoders.
 */

const KEY = 'instrumentedOrigins';

export async function listSites() {
  const { [KEY]: sites } = await chrome.storage.local.get(KEY);
  return sites ?? [];
}

const idFor = (origin) => `census:${origin}`;
const idsFor = (origin) => [idFor(origin), `${idFor(origin)}:bridge`];

/** Register a document_start content script for one origin, and remember it. */
export async function enableSite(origin) {
  const pattern = `${origin}/*`;
  const sites = await listSites();
  if (!sites.includes(origin)) {
    await chrome.storage.local.set({ [KEY]: [...sites, origin] });
  }
  await registerFor(origin, pattern);
}

export async function disableSite(origin) {
  const sites = await listSites();
  await chrome.storage.local.set({ [KEY]: sites.filter((s) => s !== origin) });
  await chrome.scripting.unregisterContentScripts({ ids: idsFor(origin) }).catch(() => {});
  // Hand the host permission back; keeping it would be holding access we no
  // longer use.
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
}

async function registerFor(origin, pattern) {
  const id = idFor(origin);
  await chrome.scripting.unregisterContentScripts({ ids: idsFor(origin) }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [pattern],
      // The census must be in the page's own world, and early. A dynamically
      // inserted <script src> would not block the parser, so the page's module
      // scripts would run first and everything they allocate would be missed.
      js: ['src/shim.global.js'],
      world: 'MAIN',
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
    {
      id: `${id}:bridge`,
      matches: [pattern],
      js: ['src/content.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
}

/**
 * Reconcile on startup. A stored origin whose permission was revoked from
 * Chrome's own settings must not stay registered, or the extension keeps
 * running somewhere the user has said no to.
 */
export async function reconcile() {
  const sites = await listSites();
  const kept = [];
  for (const origin of sites) {
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (granted) {
      kept.push(origin);
      await registerFor(origin, `${origin}/*`).catch(() => {});
    } else {
      await chrome.scripting.unregisterContentScripts({ ids: idsFor(origin) }).catch(() => {});
    }
  }
  if (kept.length !== sites.length) await chrome.storage.local.set({ [KEY]: kept });
}
