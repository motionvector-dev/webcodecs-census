const out = document.getElementById('out');
const modeLine = document.getElementById('mode');
const toggle = document.getElementById('toggle');
const siteBtn = document.getElementById('site');

const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const tabId = tab?.id;
const origin = (() => {
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
})();

const ask = (msg) => chrome.runtime.sendMessage({ ...msg, tabId, origin });

function render(result) {
  if (!result?.censuses?.length) {
    out.textContent =
      'No instrumented context answered.\n\n' +
      'Either this site is not enabled, or the page loaded before it was. ' +
      'Enable the site, then reload the tab.';
    return;
  }

  const lines = [];
  let totalLive = 0;

  for (const c of result.censuses) {
    const live = Object.entries(c.live ?? {}).filter(([, n]) => n);
    totalLive += live.reduce((s, [, n]) => s + n, 0);
    lines.push(
      `${c.context}${c.targetUrl ? ` — ${c.targetUrl.split('/').pop()}` : ''}` +
        `  (${Math.round((c.uptimeMs ?? 0) / 1000)}s)`,
    );
    lines.push(live.length ? '  live: ' + live.map(([t, n]) => `${t}=${n}`).join('  ') : '  live: nothing');

    const media = c.mediaElements;
    if (media?.total) {
      lines.push(`  media elements: ${media.total} (${media.stalled} stalled at readyState 0)`);
    }
    for (const gc of Object.entries(c.collectedUnclosed ?? {})) {
      lines.push(`  LEAKED: ${gc[1]} ${gc[0]} garbage collected without close()`);
    }
    for (const site of (c.leakSites ?? []).slice(0, 3)) {
      lines.push(`  ${site.count}x ${site.type} (${site.origin}, oldest ${site.oldestAgeMs}ms)`);
      for (const l of String(site.stack).split('\n').slice(0, 2)) lines.push(`      ${l.trim()}`);
    }
    if (c.problems?.length) lines.push(`  not instrumented: ${c.problems.join('; ')}`);
    lines.push('');
  }

  if (result.mode === 'patch') {
    lines.push(
      `patch mode: ${result.workersWrapped ?? 0} worker(s) wrapped` +
        (result.workersSkipped?.length ? `, ${result.workersSkipped.length} skipped` : ''),
    );
    for (const s of result.workersSkipped ?? []) lines.push(`  skipped ${s.url}: ${s.reason}`);
  }

  lines.push(`total live tracked objects: ${totalLive}`);
  out.textContent = lines.join('\n');
}

async function refresh() {
  const status = (await ask({ type: 'mode:status' })) ?? {};

  if (!origin) {
    siteBtn.disabled = true;
    siteBtn.textContent = 'Not a web page';
    modeLine.textContent = 'This extension only works on http and https pages.';
    out.textContent = '';
    return;
  }

  siteBtn.disabled = false;
  siteBtn.textContent = status.enabled ? `Disable on ${hostOf(origin)}` : `Enable on ${hostOf(origin)}`;
  toggle.textContent = status.exact ? 'Disable exact mode' : 'Enable exact mode';

  modeLine.textContent = status.exact
    ? 'Exact mode: workers instrumented before their first line.'
    : status.enabled
      ? 'Patch mode: best effort. Workers started before the page script, or blocked by CSP, are missed.'
      : 'Not instrumenting this site. Nothing is patched until you enable it.';

  render(await ask({ type: 'census:get' }));
}

const hostOf = (o) => {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
};

document.getElementById('refresh').addEventListener('click', refresh);

siteBtn.addEventListener('click', async () => {
  const status = (await ask({ type: 'mode:status' })) ?? {};
  if (status.enabled) {
    await ask({ type: 'site:disable' });
    out.textContent = `Stopped instrumenting ${hostOf(origin)} and gave the permission back.`;
    await refresh();
    return;
  }

  // Must be requested from a user gesture in an extension page, so it happens
  // here rather than in the service worker.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    out.textContent = 'Permission declined, so nothing was changed.';
    return;
  }
  await ask({ type: 'site:enable' });
  out.textContent = `Instrumenting ${hostOf(origin)}. Reload the tab so the census is in place before the app starts.`;
  await refresh();
});

toggle.addEventListener('click', async () => {
  const status = (await ask({ type: 'mode:status' })) ?? {};
  await ask({ type: status.exact ? 'mode:exact:off' : 'mode:exact:on' });
  if (!status.exact) {
    out.textContent = 'Exact mode on. Reload the tab so workers are caught at startup.';
    modeLine.textContent = '';
    toggle.textContent = 'Disable exact mode';
    return;
  }
  await refresh();
});

await refresh();
