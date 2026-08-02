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
// Every HTML page that loads the shared bundle must be re-stamped, or its SRI goes
// stale on the next build and the browser blocks the (now-mismatched) script.
//   Live OCR Test.html — the full legacy harness (filename keeps its space)
//   table.html         — the clean, table-only page (same bundle, hides the rest)
const HTML_FILES = ['Live OCR Test.html', 'table.html'];

// Return both the SRI (base64 sha384) and a short hex cache-bust token, derived
// from the file bytes — so a rebuilt bundle gets a NEW url (?v=…) the browser
// must fetch fresh. A plain reload can no longer serve a stale app.js.
function digest(relPath) {
  const buf = readFileSync(resolve(root, relPath));
  return {
    sri: 'sha384-' + createHash('sha384').update(buf).digest('base64'),
    bust: createHash('sha1').update(buf).digest('hex').slice(0, 12),
  };
}

// marker comment -> the exact tag line to emit (integrity + cache-bust filled below)
const tags = {
  'SRI:app.css': (h) =>
    `  <link rel="stylesheet" href="dist/app.css?v=${h.bust}" integrity="${h.sri}" crossorigin="anonymous"><!-- SRI:app.css -->`,
  'SRI:app.js': (h) =>
    `  <script defer src="dist/app.js?v=${h.bust}" integrity="${h.sri}" crossorigin="anonymous"></script><!-- SRI:app.js -->`,
};

const hashes = { 'SRI:app.css': digest('dist/app.css'), 'SRI:app.js': digest('dist/app.js') };

for (const file of HTML_FILES) {
  const path = resolve(root, file);
  let html = readFileSync(path, 'utf8');
  for (const [marker, makeTag] of Object.entries(tags)) {
    const lineRe = new RegExp(`^.*<!-- ${marker} -->.*$`, 'm');
    if (!lineRe.test(html)) {
      throw new Error(`marker "${marker}" not found in ${file} — cannot inject SRI`);
    }
    html = html.replace(lineRe, makeTag(hashes[marker]));
  }
  writeFileSync(path, html);
}
console.log('[inject-sri] stamped ' + HTML_FILES.join(', ') + ':');
for (const [marker, h] of Object.entries(hashes)) console.log(`  ${marker}  ${h.sri}  ?v=${h.bust}`);
