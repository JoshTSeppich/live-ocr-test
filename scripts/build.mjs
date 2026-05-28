// build.mjs — deterministic, offline bundle step.
//
//   node scripts/build.mjs            one-shot build
//   node scripts/build.mjs --watch    rebuild on change (dev)
//
// esbuild resolves everything from node_modules + the local source tree, so
// there is no network access at build time. Output is byte-deterministic for a
// fixed esbuild version + inputs: no timestamps or hashes are injected here
// (SRI hashing happens afterward in inject-sri.mjs).

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/entry.jsx')],
  outfile: resolve(root, 'dist/app.js'), // CSS emitted alongside as dist/app.css
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  // Classic JSX runtime: the legacy .jsx files reference a bare `React` global
  // (set up in setup-globals.js), matching React.createElement output.
  jsx: 'transform',
  loader: {
    // Inline bundled fonts directly into dist/app.css — no sidecar files.
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
  },
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching for changes…');
} else {
  await esbuild.build(options);
  console.log('[build] wrote dist/app.js + dist/app.css');
}
