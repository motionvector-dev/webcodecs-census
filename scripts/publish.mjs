#!/usr/bin/env node
/**
 * Publish the three packages, in dependency order, skipping any already on the
 * registry at this version.
 *
 * The skip is not politeness. A release that fails halfway — an expired token,
 * a rejected one-time password — leaves some packages published and some not,
 * and re-running used to abort on the first 403 "cannot publish over previously
 * published versions" without touching the ones that actually still needed
 * publishing. That happened. Now a re-run finishes the job.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// -cdp and -mcp pin an exact version of the core, so the core must resolve on
// the registry before they are pushed.
const ORDER = ['packages/core', 'packages/cdp', 'packages/mcp'];

const dryRun = process.argv.includes('--dry-run');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function publishedVersions(name) {
  try {
    return new Set(JSON.parse(run('npm', ['view', name, 'versions', '--json'])));
  } catch {
    return new Set(); // not published at all yet
  }
}

let published = 0;
let skipped = 0;

for (const dir of ORDER) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const { name, version } = pkg;

  if (publishedVersions(name).has(version)) {
    console.log(`  skip     ${name}@${version} — already on the registry`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  would publish ${name}@${version}`);
    continue;
  }

  console.log(`  publish  ${name}@${version}`);
  // Provenance is automatic under trusted publishing from GitHub Actions, so
  // no --provenance flag: passing it where OIDC is not in play only produces a
  // confusing failure.
  execFileSync('npm', ['publish', '-w', name, '--access', 'public'], { stdio: 'inherit' });
  published++;
}

console.log(`\n${published} published, ${skipped} already present.`);
