// Bundle fixtures that import real dependencies, so the browser can load them
// without a module server or an import map.
//
// The mediabunny fixture is the interesting one: it proves the census sees
// codecs created inside a library's own abstractions, not just the ones an
// application constructs itself.

import { build } from 'esbuild';

await build({
  entryPoints: ['test/fixtures/mediabunny-worker.src.js'],
  outfile: 'test/fixtures/mediabunny-worker.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
});

console.log('fixtures bundled: mediabunny-worker.js');
