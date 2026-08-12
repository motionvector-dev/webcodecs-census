// Two artefacts from one source:
//   dist/index.js        ESM, for apps and tests that import the census
//   dist/shim.global.js  a self-installing IIFE, for injection into a context
//                        we do not control (a page's main world, or a worker
//                        paused before its first line)
//
// The IIFE carries a sourceURL marker so the census can filter its own frames
// out of an allocation stack, and so it is identifiable in a debugger.

import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';

const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
};

await mkdir('dist', { recursive: true });

await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
});

// The injectable build installs itself on load; nothing can call an export.
const iife = await build({
  ...shared,
  format: 'iife',
  stdin: {
    // Options are handed over on a global, because an injected IIFE has no
    // callable export and the injector must be able to set the sample rate.
    contents:
      `import { installCensus } from './src/census';\n` +
      `installCensus((globalThis as any).__webcodecsCensusOptions ?? {});\n`,
    resolveDir: '.',
    loader: 'ts',
  },
  write: false,
  outfile: 'dist/shim.global.js',
  footer: { js: '//# sourceURL=webcodecs-census-shim.js' },
});

const code = iife.outputFiles[0].text;
await writeFile('dist/shim.global.js', code);

// Also expose it as a JS module exporting the source text, so the extension and
// the CDP driver can import it without reading from disk at runtime.
await writeFile(
  'dist/shim.js',
  `export const SHIM_SOURCE = ${JSON.stringify(code)};\nexport default SHIM_SOURCE;\n`,
);
await writeFile(
  'dist/shim.d.ts',
  '/** The census, bundled as a self-installing IIFE for injection. */\n' +
    'export declare const SHIM_SOURCE: string;\nexport default SHIM_SOURCE;\n',
);

// A second injectable build for the extension's no-debugger mode: the census
// plus the Worker-constructor rewrite, which only makes sense when nothing is
// injecting into workers for us.
const withWorkers = await build({
  ...shared,
  format: 'iife',
  // Workers get the plain census. Inlining it here means the extension ships
  // one file and needs no second network fetch from inside a blob worker.
  define: { __PLAIN_SHIM__: JSON.stringify(code) },
  stdin: {
    contents:
      `import { installCensus } from './src/census';\n` +
      `import { installWorkerPatch } from './src/workerPatch';\n` +
      `import { respondToCollectRequests } from './src/pageBridge';\n` +
      `declare const __PLAIN_SHIM__: string;\n` +
      `installCensus((globalThis as any).__webcodecsCensusOptions ?? {});\n` +
      `installWorkerPatch(__PLAIN_SHIM__);\n` +
      `respondToCollectRequests();\n`,
    resolveDir: '.',
    loader: 'ts',
  },
  write: false,
  outfile: 'dist/shim.workers.js',
  footer: { js: '//# sourceURL=webcodecs-census-shim.js' },
});
await writeFile('dist/shim.workers.js', withWorkers.outputFiles[0].text);

console.log(
  `built shim: ${(code.length / 1024).toFixed(1)} kB, ` +
    `with worker patch: ${(withWorkers.outputFiles[0].text.length / 1024).toFixed(1)} kB`,
);
