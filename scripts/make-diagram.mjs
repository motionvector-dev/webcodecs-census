#!/usr/bin/env node
/**
 * Generates the two-phase injection diagram in light and dark variants.
 *
 * Two files rather than one with a CSS media query, because GitHub serves
 * README images through a proxy and the `<picture>` element is the only
 * approach that reliably follows the reader's theme.
 *
 * Generated rather than hand-drawn so the variants cannot drift apart.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const THEMES = {
  light: {
    bg: 'none',
    fg: '#1f2328',
    muted: '#59636e',
    line: '#d1d9e0',
    panel: '#f6f8fa',
    panelEdge: '#d1d9e0',
    good: '#1a7f37',
    bad: '#cf222e',
    accent: '#0969da',
    accentSoft: '#ddf4ff',
  },
  dark: {
    bg: 'none',
    fg: '#f0f6fc',
    muted: '#9198a1',
    line: '#3d444d',
    panel: '#151b23',
    panelEdge: '#3d444d',
    good: '#3fb950',
    bad: '#f85149',
    accent: '#4493f8',
    accentSoft: '#121d2f',
  },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

const W = 900;
const H = 430;

/** Globals present at each pause. The whole point of the diagram. */
const GLOBALS = [
  ['VideoFrame', true, true],
  ['AudioData', true, true],
  ['EncodedVideoChunk', true, true],
  ['VideoDecoder', false, true],
  ['VideoEncoder', false, true],
  ['AudioDecoder', false, true],
  ['setTimeout', false, true],
  ['setInterval', false, true],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function panel(t, x, y, w, h, title, subtitle, tone) {
  const edge = tone ?? t.panelEdge;
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
        fill="${t.panel}" stroke="${edge}" stroke-width="1.5"/>
  <text x="${x + 16}" y="${y + 26}" font-family="${FONT}" font-size="14"
        font-weight="600" fill="${t.fg}">${esc(title)}</text>
  <text x="${x + 16}" y="${y + 46}" font-family="${FONT}" font-size="12"
        fill="${t.muted}">${esc(subtitle)}</text>`;
}

function globalsList(t, x, y, index) {
  return GLOBALS.map(([name, atPause, atScript], i) => {
    const present = index === 0 ? atPause : atScript;
    const cy = y + i * 21;
    const mark = present
      ? `<path d="M${x} ${cy - 4} l4 4 l7 -8" fill="none" stroke="${t.good}" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M${x} ${cy - 7} l10 10 M${x + 10} ${cy - 7} l-10 10" fill="none"
              stroke="${t.bad}" stroke-width="2" stroke-linecap="round"/>`;
    return `${mark}
    <text x="${x + 20}" y="${cy + 4}" font-family="${MONO}" font-size="12.5"
          fill="${present ? t.fg : t.muted}">${esc(name)}</text>`;
  }).join('');
}

function svg(t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Two-phase injection: at the auto-attach pause a worker has frame types but no codecs or timers; at the beforeScriptExecution pause it has everything, still before the worker's own code runs.">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>

  <text x="0" y="18" font-family="${FONT}" font-size="15" font-weight="600" fill="${t.fg}">
    Getting instrumentation into a worker before its first line
  </text>
  <text x="0" y="38" font-family="${FONT}" font-size="12.5" fill="${t.muted}">
    A dedicated worker's global is only half built when Chrome first pauses it.
  </text>

  <!-- timeline -->
  <line x1="30" y1="72" x2="${W - 30}" y2="72" stroke="${t.line}" stroke-width="2"/>
  ${[
    [30, 'new Worker()'],
    [300, 'auto-attach pause'],
    [600, 'beforeScriptExecution'],
    [W - 30, 'worker code runs'],
  ]
    .map(([cx, label], i) => {
      const isPause = i === 1 || i === 2;
      return `
  <circle cx="${cx}" cy="72" r="${isPause ? 7 : 5}"
          fill="${isPause ? t.accent : t.muted}"/>
  <text x="${cx}" y="${i === 3 ? 60 : 56}" font-family="${FONT}" font-size="12"
        font-weight="${isPause ? 600 : 400}"
        fill="${isPause ? t.accent : t.muted}"
        text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${esc(label)}</text>`;
    })
    .join('')}

  ${panel(t, 170, 100, 260, 290, 'Phase 1 — too early', 'Target.setAutoAttach, waitForDebuggerOnStart', t.bad)}
  ${globalsList(t, 190, 165, 0)}
  <text x="190" y="360" font-family="${FONT}" font-size="11.5" fill="${t.bad}">
    Patch here and every codec is missed.
  </text>

  ${panel(t, 470, 100, 260, 290, 'Phase 2 — complete, still early', 'Debugger.setInstrumentationBreakpoint', t.good)}
  ${globalsList(t, 490, 165, 1)}
  <text x="490" y="360" font-family="${FONT}" font-size="11.5" fill="${t.good}">
    Inject here. Nothing has run yet.
  </text>

  <!-- resume arrow between the two -->
  <path d="M436 245 L462 245" stroke="${t.accent}" stroke-width="2" fill="none"
        marker-end="url(#arrow-${t.fg.replace('#', '')})"/>
  <defs>
    <marker id="arrow-${t.fg.replace('#', '')}" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${t.accent}"/>
    </marker>
  </defs>
  <text x="449" y="236" font-family="${FONT}" font-size="10.5" fill="${t.accent}"
        text-anchor="middle">resume</text>

  <rect x="760" y="100" width="140" height="290" rx="8" fill="${t.accentSoft}"
        stroke="${t.accent}" stroke-width="1"/>
  <text x="774" y="126" font-family="${FONT}" font-size="12.5" font-weight="600"
        fill="${t.fg}">Why it matters</text>
  ${[
    'Decoders usually',
    'live in workers.',
    '',
    'Page-level',
    'patching cannot',
    'reach them at all.',
    '',
    'Miss them and the',
    'tool reports "no',
    'leaks" for an app',
    'losing every frame.',
  ]
    .map(
      (line, i) =>
        `<text x="774" y="${152 + i * 17}" font-family="${FONT}" font-size="11.5" fill="${t.muted}">${esc(line)}</text>`,
    )
    .join('')}
</svg>
`;
}

mkdirSync('docs', { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(`docs/injection-${name}.svg`, svg(theme));
  console.log(`docs/injection-${name}.svg`);
}
