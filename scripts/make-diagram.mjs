#!/usr/bin/env node
/**
 * The injection sequence, as a sequence diagram.
 *
 * Deliberately not a picture of a table: which globals exist at each pause is
 * already a markdown table in the README, where it is searchable, diffable and
 * readable by a screen reader. What prose handles badly is the control handoff
 * — that you resume out of one pause directly into a second one — so that is
 * what this draws and all it draws.
 *
 * Two files rather than a CSS media query, because GitHub proxies README images
 * and `<picture>` is the only thing that reliably follows the reader's theme.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const THEME = {
  light: {
    fg: '#1f2328',
    muted: '#59636e',
    faint: '#8c959f',
    rule: '#8c959f',
    accent: '#0969da',
    band: '#fff1e5',
    bandEdge: '#ffb77c',
    bandText: '#9a6700',
    ok: '#1a7f37',
    okBand: '#dafbe1',
    okEdge: '#4ac26b',
  },
  dark: {
    fg: '#f0f6fc',
    muted: '#9198a1',
    faint: '#7d8590',
    rule: '#6e7681',
    accent: '#4493f8',
    band: '#2b1a10',
    bandEdge: '#7d4e24',
    bandText: '#e0a53f',
    ok: '#3fb950',
    okBand: '#0f2417',
    okEdge: '#2b6a37',
  },
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

const W = 880;
const H = 552;

// Three lifelines. Chrome sits in the middle because every message crosses it.
const LANES = [
  { x: 118, label: 'census driver', sub: 'your process' },
  { x: 440, label: 'Chrome', sub: 'DevTools Protocol' },
  { x: 762, label: 'worker', sub: 'global scope' },
];

const TOP = 78; // where lifelines begin
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function arrow(t, fromLane, toLane, y, label, opts = {}) {
  const x1 = LANES[fromLane].x;
  const x2 = LANES[toLane].x;
  const dir = x2 > x1 ? 1 : -1;
  const pad = 6 * dir;
  const dash = opts.dashed ? ' stroke-dasharray="5 4"' : '';
  const colour = opts.colour ?? t.fg;
  return `
  <line x1="${x1 + pad}" y1="${y}" x2="${x2 - pad}" y2="${y}" stroke="${colour}"
        stroke-width="1.5"${dash} marker-end="url(#head-${opts.marker ?? 'fg'})"/>
  <text x="${(x1 + x2) / 2}" y="${y - 7}" font-family="${MONO}" font-size="11"
        fill="${colour}" text-anchor="middle">${esc(label)}</text>`;
}

/**
 * A self-call on one lifeline: something Chrome or the worker does alone.
 * Notes on the rightmost lane draw inward, or the label runs off the canvas.
 */
function selfNote(t, lane, y, label, side = 'right') {
  const x = LANES[lane].x;
  const d = side === 'right' ? 1 : -1;
  const loop = `M${x} ${y - 9} h${26 * d} a5 5 0 0 1 ${5 * d} 5 v8 a5 5 0 0 1 ${-5 * d} 5 h${-26 * d}`;
  return `
  <path d="${loop}" fill="none" stroke="${t.muted}" stroke-width="1.3"
        marker-end="url(#head-muted)"/>
  <text x="${x + 40 * d}" y="${y + 5}" font-family="${SANS}" font-size="11.5"
        fill="${t.muted}" text-anchor="${side === 'right' ? 'start' : 'end'}">${esc(label)}</text>`;
}

function band(t, y, h, title, chips, verdict, tone) {
  const bg = tone === 'ok' ? t.okBand : t.band;
  const edge = tone === 'ok' ? t.okEdge : t.bandEdge;
  const ink = tone === 'ok' ? t.ok : t.bandText;
  const chipRow = chips
    .map(([name, present], i) => {
      const cx = 596 + i * 0; // laid out vertically to stay legible
      void cx;
      return `<text x="596" y="${y + 34 + i * 15}" font-family="${MONO}" font-size="11.5"
             fill="${present ? ink : t.muted}">${present ? '✓' : '✕'} ${esc(name)}</text>`;
    })
    .join('');
  return `
  <rect x="576" y="${y}" width="290" height="${h}" rx="6" fill="${bg}" stroke="${edge}"
        stroke-width="1"/>
  <text x="596" y="${y + 18}" font-family="${SANS}" font-size="11.5" font-weight="600"
        fill="${ink}">${esc(title)}</text>
  ${chipRow}
  <text x="596" y="${y + h - 10}" font-family="${SANS}" font-size="11" font-weight="600"
        fill="${ink}">${esc(verdict)}</text>`;
}

function svg(t) {
  const lifelines = LANES.map(
    (l, i) => `
  <text x="${l.x}" y="34" font-family="${SANS}" font-size="12.5" font-weight="600"
        fill="${t.fg}" text-anchor="middle">${esc(l.label)}</text>
  <text x="${l.x}" y="50" font-family="${SANS}" font-size="11.5"
        fill="${t.muted}" text-anchor="middle">${esc(l.sub)}</text>
  <line x1="${l.x}" y1="${i === 2 ? 140 : TOP}" x2="${l.x}" y2="${H - 26}" stroke="${t.faint}"
        stroke-width="1.75" stroke-dasharray="5 4"/>`,
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Sequence diagram. The driver arms auto-attach; Chrome pauses the new worker before its first line, but the worker global is incomplete there — codecs and timers do not exist yet. The driver sets a beforeScriptExecution breakpoint and resumes, landing in a second pause where the global is complete and the worker's own code still has not run. The census is evaluated there, then execution resumes.">
  <defs>
    <marker id="head-fg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${t.fg}"/>
    </marker>
    <marker id="head-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${t.muted}"/>
    </marker>
    <marker id="head-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${t.accent}"/>
    </marker>
    <marker id="head-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="${t.ok}"/>
    </marker>
  </defs>

  <text x="0" y="16" font-family="${SANS}" font-size="14" font-weight="600" fill="${t.fg}">
    Reaching a worker before its first line takes two pauses, not one
  </text>

  ${lifelines}

  ${arrow(t, 0, 1, 100, 'Target.setAutoAttach { waitForDebuggerOnStart }')}
  ${selfNote(t, 1, 130, 'page calls new Worker()')}

  ${band(t, 158, 96, 'Pause 1 — global is half built', [
    ['VideoFrame', true],
    ['VideoDecoder', false],
    ['setTimeout', false],
  ], 'Patch here → every codec missed', 'warn')}
  ${arrow(t, 1, 0, 176, 'attachedToTarget', { dashed: true })}

  ${arrow(t, 0, 1, 274, 'Debugger.setInstrumentationBreakpoint')}
  ${arrow(t, 0, 1, 306, 'Runtime.runIfWaitingForDebugger', { colour: t.accent, marker: 'accent' })}

  ${band(t, 330, 96, 'Pause 2 — global is complete', [
    ['VideoFrame', true],
    ['VideoDecoder', true],
    ['setTimeout', true],
  ], 'Inject here → nothing has run yet', 'ok')}
  ${arrow(t, 1, 0, 348, 'Debugger.paused (instrumentation)', { dashed: true })}

  ${arrow(t, 0, 1, 448, 'Runtime.evaluate(census)', { colour: t.ok, marker: 'ok' })}
  ${arrow(t, 1, 2, 476, 'evaluated in the worker context', { colour: t.ok, marker: 'ok' })}
  ${arrow(t, 0, 1, 508, 'Debugger.resume', { colour: t.accent, marker: 'accent' })}
  ${selfNote(t, 2, 536, "worker's own first line runs", 'left')}
</svg>
`;
}

mkdirSync('docs', { recursive: true });
for (const [name, t] of Object.entries(THEME)) {
  writeFileSync(`docs/injection-${name}.svg`, svg(t));
  console.log(`docs/injection-${name}.svg`);
}
