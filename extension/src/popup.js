const out = document.getElementById('out');
const modeLine = document.getElementById('mode');
const toggle = document.getElementById('toggle');

const tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

const ask = (msg) => chrome.runtime.sendMessage({ ...msg, tabId });

function render(result) {
  if (!result?.censuses?.length) {
    out.textContent =
      'No instrumented context answered.\n\n' +
      'The page may have loaded before the extension, or it may not use WebCodecs. ' +
      'Reload the tab, then snapshot again.';
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
  const { exact } = (await ask({ type: 'mode:status' })) ?? {};
  modeLine.textContent = exact
    ? 'Exact mode: workers instrumented before their first line.'
    : 'Patch mode: best effort. Workers started before the page script, or blocked by CSP, are missed.';
  toggle.textContent = exact ? 'Disable exact mode' : 'Enable exact mode';
  render(await ask({ type: 'census:get' }));
}

document.getElementById('refresh').addEventListener('click', refresh);

toggle.addEventListener('click', async () => {
  const { exact } = (await ask({ type: 'mode:status' })) ?? {};
  await ask({ type: exact ? 'mode:exact:off' : 'mode:exact:on' });
  if (!exact) {
    out.textContent = 'Exact mode on. Reload the tab so workers are caught at startup.';
    modeLine.textContent = '';
    toggle.textContent = 'Disable exact mode';
    return;
  }
  await refresh();
});

await refresh();
