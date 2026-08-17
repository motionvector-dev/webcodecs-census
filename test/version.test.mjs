/**
 * Two version strings live in source rather than package.json, and both said
 * 0.1.0 through the 0.2.0 and 0.2.1 releases: every census payload carried a
 * wrong stamp, and the MCP server announced a wrong version on the wire.
 *
 * `scripts/version.mjs` rewrites them now. This is what catches it if that
 * rewrite ever silently stops matching.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { VERSION } from '../packages/core/dist/index.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const version = (p) => JSON.parse(read(p)).version;

describe('the version stamps track the packages', () => {
  test('the census stamps payloads with the core version', () => {
    assert.equal(VERSION, version('../packages/core/package.json'));
  });

  test('the MCP server announces its own version', () => {
    const src = read('../packages/mcp/src/index.ts');
    const found = src.match(/name: 'webcodecs-census', version: '([^']+)'/)?.[1];
    assert.ok(found, 'the MCP server no longer declares a version the way version.mjs rewrites it');
    assert.equal(found, version('../packages/mcp/package.json'));
  });

  test('all three packages are on one version', () => {
    const [core, cdp, mcp] = ['core', 'cdp', 'mcp'].map((p) =>
      version(`../packages/${p}/package.json`),
    );
    // -cdp and -mcp depend on an exact core version; out of step is unpublishable.
    assert.equal(cdp, core);
    assert.equal(mcp, core);
  });
});
