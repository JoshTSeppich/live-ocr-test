// inject-sri.mjs — stamp Subresource Integrity hashes into the HTML.
//
// Runs after build.mjs. Computes SHA-384 of dist/app.js and dist/app.css and
// rewrites the two asset tags in the HTML so the browser refuses to run/apply
// them if the bytes don't match. Each tag is regenerated in full from a fixed
// template keyed by a trailing marker comment, so re-running is idempotent —
// no accumulation, no dependence on the previous integrity value.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = resolve(root, 'Live OCR Test.html'); // filename keeps its space (see commit msg)

function sri(relPath) {
  const buf = readFileSync(resolve(root, relPath));
  return 'sha384-' + createHash('sha384').update(buf).digest('base64');
}

// marker comment -> the exact tag line to emit (integrity filled in below)
const tags = {
  'SRI:app.css': (hash) =>
    `  <link rel="stylesheet" href="dist/app.css" integrity="${hash}" crossorigin="anonymous"><!-- SRI:app.css -->`,
  'SRI:app.js': (hash) =>
    `  <script defer src="dist/app.js" integrity="${hash}" crossorigin="anonymous"></script><!-- SRI:app.js -->`,
};

const hashes = { 'SRI:app.css': sri('dist/app.css'), 'SRI:app.js': sri('dist/app.js') };

let html = readFileSync(HTML, 'utf8');
for (const [marker, makeTag] of Object.entries(tags)) {
  // Replace the entire line that ends with this marker comment.
  const lineRe = new RegExp(`^.*<!-- ${marker} -->.*$`, 'm');
  if (!lineRe.test(html)) {
    throw new Error(`marker "${marker}" not found in ${HTML} — cannot inject SRI`);
  }
  html = html.replace(lineRe, makeTag(hashes[marker]));
}

writeFileSync(HTML, html);
console.log('[inject-sri] stamped:');
for (const [marker, hash] of Object.entries(hashes)) console.log(`  ${marker}  ${hash}`);
