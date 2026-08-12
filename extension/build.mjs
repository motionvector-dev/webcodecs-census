// Assemble the unpacked extension from the built core.

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';

const CORE = '../packages/core/dist';

await mkdir('dist/src', { recursive: true });
await mkdir('dist/icons', { recursive: true });

// Patch mode injects the build that also rewrites `new Worker(...)`.
const withWorkers = await readFile(`${CORE}/shim.workers.js`, 'utf8');
await writeFile('dist/src/shim.global.js', withWorkers);

// Exact mode injects the plain census: CDP reaches workers on its own, so the
// Worker rewrite would be redundant and would change `self.location` for no gain.
const plain = await readFile(`${CORE}/shim.global.js`, 'utf8');
await writeFile(
  'dist/src/shim-source.js',
  `export const SHIM_SOURCE = ${JSON.stringify(plain)};\n`,
);

for (const f of ['manifest.json']) await cp(f, `dist/${f}`);
for (const f of ['background.js', 'content.js', 'popup.html', 'popup.js']) {
  await cp(`src/${f}`, `dist/src/${f}`);
}
await cp('icons', 'dist/icons', { recursive: true }).catch(() => {});

console.log('extension built into extension/dist — load it unpacked from there');
