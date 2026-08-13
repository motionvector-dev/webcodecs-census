#!/usr/bin/env node
/**
 * Move all three packages to one version, together.
 *
 * They are released in lockstep because -cdp and -mcp depend on an *exact*
 * version of the core. Bumping one by hand publishes a package whose dependency
 * does not exist yet — which fails as a 404 that reads like the scope is wrong.
 *
 *   node scripts/version.mjs 0.2.0
 *   node scripts/version.mjs patch|minor|major
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PACKAGES = ['packages/core', 'packages/cdp', 'packages/mcp'];
const CORE = '@motionvector/webcodecs-census';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

const current = read('packages/core/package.json').version;
const arg = process.argv[2];

if (!arg) {
  console.error(`Current version is ${current}.\n\nUsage: node scripts/version.mjs <version|patch|minor|major>`);
  process.exit(1);
}

function bump(version, kind) {
  const [maj, min, pat] = version.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  return null;
}

const next = bump(current, arg) ?? arg;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error(`"${next}" is not a semver version.`);
  process.exit(1);
}
if (next === current) {
  console.error(`Already at ${current}.`);
  process.exit(1);
}

// Refuse to version a dirty tree: the tag would not describe what was released.
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty && !process.env.ALLOW_DIRTY) {
  console.error(`Working tree is not clean:\n${dirty}\n\nCommit first, or set ALLOW_DIRTY=1.`);
  process.exit(1);
}

for (const dir of PACKAGES) {
  const path = `${dir}/package.json`;
  const pkg = read(path);
  pkg.version = next;
  // Keep the cross-dependency exact and in step, or the published tree is broken.
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith('@motionvector/')) pkg[field][name] = next;
    }
  }
  write(path, pkg);
  console.log(`  ${pkg.name} -> ${next}`);
}

// Promote the Unreleased section rather than inventing notes: the release body
// is generated from this file, so an empty section is a release with no notes.
const CHANGELOG = 'CHANGELOG.md';
let log = readFileSync(CHANGELOG, 'utf8');
const today = new Date().toISOString().slice(0, 10);

// Match the next *version* heading specifically. `##` alone also matches the
// `### Added` subheading inside a populated section, which reads as empty.
const unreleasedIsEmpty = /## \[Unreleased\]\s*\n+\s*## \[/.test(log);

if (!unreleasedIsEmpty) {
  log = log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${today}`);
  log = log.replace(
    /\[Unreleased\]: (.*)compare\/v(.*)\.\.\.HEAD/,
    `[Unreleased]: $1compare/v${next}...HEAD\n[${next}]: $1compare/v$2...v${next}`,
  );
  writeFileSync(CHANGELOG, log);
  console.log(`  CHANGELOG.md -> [${next}] dated ${today}`);
} else {
  console.warn('  CHANGELOG.md has an empty Unreleased section — the release will have no notes.');
}

console.log(`\nNext:\n  git commit -am "release: v${next}"\n  git tag v${next}\n  git push origin main --tags\n\nThe tag triggers the release workflow, which tests then publishes.`);
