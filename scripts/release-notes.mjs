#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md, for a GitHub Release body.
 *
 * Hand-written notes beat generated ones — a commit list tells a reader what
 * changed, not whether it affects them — so the changelog is the source and
 * this only slices it.
 *
 *   node scripts/release-notes.mjs 0.2.0
 */

import { readFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const log = readFileSync('CHANGELOG.md', 'utf8');
const lines = log.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));

if (start === -1) {
  console.error(`No section for ${version} in CHANGELOG.md.`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => l.startsWith('## '));
const body = (end === -1 ? rest : rest.slice(0, end))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

if (!body) {
  console.error(`The ${version} section is empty.`);
  process.exit(1);
}

process.stdout.write(
  `${body}\n\n---\n\n` +
    '```bash\n' +
    `npm i -D @motionvector/webcodecs-census-cdp@${version}\n` +
    '```\n\n' +
    'Published with npm provenance from this repository.\n',
);
