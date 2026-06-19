#!/usr/bin/env node
// PART 1 — capture + label live card strips, then re-teach MULTI-INSTANCE rank
// templates from the LIVE client (the corpus templates are overfit to one capture
// and misread the live render). JSON-fed (the card-reads download already carries
// full board/hero region crops); whole-line labeling ("2s 9d 5c 6s"); the
// sequential detector (frame.js) slices each region into correctly-framed strips.
//
// Usage:
//   node tools/teach-from-live.mjs extract <reads.json> [outDir]
//       → slices every entry, writes a numbered contact sheet (board + hero) and a
//         labels skeleton you fill in. Look at the sheet, type the board/hero line
//         per tile index.
//   node tools/teach-from-live.mjs teach <reads.json> <labels.json> [liveTplFile]
//       → teaches each labeled strip as a NEW INSTANCE (suffixed key code#N) into
//         the live template file (accumulates across rounds), then reports coverage
//         (per rank×colour and per code) + what's still missing.
//
// Hard rules: NEVER teach from a matcher guess — labels are human-typed only.
// Multi-instance is REQUIRED (one instance per card just moves the overfit).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const _store = {};
globalThis.localStorage = { getItem: (k) => (k in _store ? _store[k] : null), setItem: (k, v) => { _store[k] = String(v); }, removeItem: (k) => { delete _store[k]; } };
const E = require(path.join(ROOT, 'engine.js'));
const R = require(path.join(ROOT, 'converter/regions.js'));
const F = require(path.join(ROOT, 'converter/frame.js'));

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['c', 'd', 'h', 's'];
const ALL_CODES = []; for (const r of RANKS) for (const s of SUITS) ALL_CODES.push(r + s);
const norm = (c) => (c || '').trim().replace(/^10/, 'T').replace(/10$/, 'T');
const colorOf = (code) => (code[1] === 'h' || code[1] === 'd' ? 'red' : 'black');

function decodeDataURL(durl) {
  if (!durl || typeof durl !== 'string') return null;
  const i = durl.indexOf(','); if (i < 0) return null;
  const p = PNG.sync.read(Buffer.from(durl.slice(i + 1), 'base64'));
  return { rgba: p.data, w: p.width, h: p.height };
}
function loadEntries(jsonPath) {
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return Array.isArray(j) ? j : (j.log || j.records || []);
}
// slice an entry's board/hero region crops into present strips (the live framing)
function sliceEntry(e) {
  const out = { board: [], hero: [] };
  if (e.boardRegion) { const c = decodeDataURL(e.boardRegion); if (c) out.board = F.sliceCells(c, R.BOARD_CELLS, { layout: 'board' }).filter((s) => s && s.present); out.boardCrop = c; }
  if (e.heroRegion) { const c = decodeDataURL(e.heroRegion); if (c) out.hero = F.sliceCells(c, R.HERO_HOLE_CELLS, { layout: 'hero' }).filter((s) => s && s.present); out.heroCrop = c; }
  return out;
}

// ─── tiny 3×5 digit font so each contact-sheet tile is self-labeled ──────────
const FONT = { 0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'], 6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'] };
function drawText(png, str, x0, y0, scale, rgb) {
  let cx = x0;
  for (const ch of String(str)) {
    const g = FONT[ch]; if (!g) { cx += 4 * scale; continue; }
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === '1') {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = cx + c * scale + dx, y = y0 + r * scale + dy;
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
        const i = (y * png.width + x) * 4; png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
      }
    }
    cx += 4 * scale;
  }
}
function blit(dst, src, ox, oy, scale) {
  for (let y = 0; y < src.h * scale; y++) for (let x = 0; x < src.w * scale; x++) {
    const sx = (x / scale) | 0, sy = (y / scale) | 0;
    const s = (sy * src.w + sx) * 4, d = ((oy + y) * dst.width + (ox + x)) * 4;
    if (d < 0 || d + 3 >= dst.data.length) continue;
    dst.data[d] = src.rgba[s]; dst.data[d + 1] = src.rgba[s + 1]; dst.data[d + 2] = src.rgba[s + 2]; dst.data[d + 3] = 255;
  }
}

function cmd_extract(jsonPath, outDir) {
  outDir = outDir || '/tmp/teach-live';
  fs.mkdirSync(outDir, { recursive: true });
  const entries = loadEntries(jsonPath);
  const tiles = []; // {idx, crop, n} for entries that yield ≥1 board card
  const labels = {};
  entries.forEach((e, idx) => {
    const sl = sliceEntry(e);
    if (sl.board.length || sl.hero.length) {
      tiles.push({ idx, boardCrop: sl.boardCrop, heroCrop: sl.heroCrop, nb: sl.board.length, nh: sl.hero.length });
      labels[idx] = { board: '', hero: '' };
    }
  });
  if (!tiles.length) { console.log('no entries with card regions (need a newer JSON that has boardRegion/heroRegion).'); return; }
  // contact sheet: one row per tile = [index] [board region] [hero region], scaled
  const SC = 1, PAD = 6, LBLW = 40;
  const rowH = Math.max(...tiles.map((t) => Math.max(t.boardCrop ? t.boardCrop.h : 0, t.heroCrop ? t.heroCrop.h : 0))) * SC + PAD;
  const bW = Math.max(...tiles.map((t) => (t.boardCrop ? t.boardCrop.w : 0))) * SC;
  const hW = Math.max(...tiles.map((t) => (t.heroCrop ? t.heroCrop.w : 0))) * SC;
  const W = LBLW + bW + PAD + hW + PAD, H = rowH * tiles.length;
  const sheet = new PNG({ width: W, height: H }); sheet.data.fill(30);
  tiles.forEach((t, row) => {
    const oy = row * rowH + 2;
    drawText(sheet, t.idx, 2, oy + 4, 4, [255, 230, 0]);
    if (t.boardCrop) blit(sheet, t.boardCrop, LBLW, oy, SC);
    if (t.heroCrop) blit(sheet, t.heroCrop, LBLW + bW + PAD, oy, SC);
  });
  const sheetPath = path.join(outDir, 'contact-sheet.png');
  fs.writeFileSync(sheetPath, PNG.sync.write(sheet));
  const labelsPath = path.join(outDir, 'labels.json');
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 1));
  console.log(`tiles: ${tiles.length}  (entries with cards)`);
  console.log(`  yellow number = entry index; left = board region, right = hero region`);
  console.log(`contact sheet : ${sheetPath}`);
  console.log(`labels skeleton: ${labelsPath}  (fill board/hero per index, e.g. "2s 9d 5c 6s")`);
  tiles.forEach((t) => console.log(`  idx ${t.idx}: board ${t.nb} card(s), hero ${t.nh} card(s)`));
}

function loadLiveTpl(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function nextKey(tpl, code) { let n = 0; while (tpl[`${code}#${n}`]) n++; return `${code}#${n}`; }

function cmd_teach(jsonPath, labelsPath, tplFile) {
  tplFile = tplFile || path.join(ROOT, 'multi-sig-templates.live.json');
  const entries = loadEntries(jsonPath);
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const tpl = loadLiveTpl(tplFile);
  const cm = new E.MultiSignatureMatcher('teach-scratch'); // scratch; we hash directly
  let taughtB = 0, taughtH = 0, skipped = [];
  for (const [idxStr, lab] of Object.entries(labels)) {
    const idx = +idxStr, e = entries[idx]; if (!e) continue;
    const sl = sliceEntry(e);
    for (const grp of ['board', 'hero']) {
      const line = (lab[grp] || '').trim(); if (!line) continue;
      const codes = line.split(/\s+/).map(norm).filter(Boolean);
      const strips = sl[grp];
      if (codes.length !== strips.length) { skipped.push(`idx ${idx} ${grp}: ${codes.length} labels vs ${strips.length} strips — SKIP`); continue; }
      codes.forEach((code, i) => {
        if (!ALL_CODES.includes(code)) { skipped.push(`idx ${idx} ${grp} #${i}: bad code "${code}" — SKIP`); return; }
        const s = strips[i];
        const sig = { brightness: Array.from(E.hashCardRGBA(s.rgba, s.w, s.h)), edge: Array.from(E.hashCardEdge(s.rgba, s.w, s.h)), color: Array.from(E.hashCardColor(s.rgba, s.w, s.h)) };
        tpl[nextKey(tpl, code)] = sig;
        if (grp === 'board') taughtB++; else taughtH++;
      });
    }
  }
  fs.writeFileSync(tplFile, JSON.stringify(tpl));
  console.log(`taught ${taughtB} board + ${taughtH} hero live instances → ${tplFile}`);
  if (skipped.length) { console.log('SKIPPED:'); skipped.forEach((s) => console.log('  ' + s)); }
  reportCoverage(tpl);
}

function reportCoverage(tpl) {
  const perCode = {}; for (const c of ALL_CODES) perCode[c] = 0;
  for (const k of Object.keys(tpl)) { const code = k.split('#')[0]; if (code in perCode) perCode[code]++; }
  // rank×colour (the functional unit: rank from code, red/black from colour hash)
  const rc = {}; for (const r of RANKS) for (const col of ['red', 'black']) rc[r + ':' + col] = 0;
  for (const c of ALL_CODES) rc[c[0] + ':' + colorOf(c)] += perCode[c];
  const rcCovered = Object.values(rc).filter((n) => n > 0).length;
  const rcMulti = Object.values(rc).filter((n) => n >= 3).length;
  const codesCovered = ALL_CODES.filter((c) => perCode[c] > 0).length;
  console.log('\n── COVERAGE ──');
  console.log(`rank×colour (functional, 26): ${rcCovered}/26 with ≥1,  ${rcMulti}/26 with ≥3 (multi-instance target)`);
  console.log(`codes (52): ${codesCovered}/52 with ≥1 live instance`);
  const missRC = Object.entries(rc).filter(([, n]) => n === 0).map(([k]) => k);
  const thinRC = Object.entries(rc).filter(([, n]) => n > 0 && n < 3).map(([k, n]) => `${k}(${n})`);
  if (missRC.length) console.log(`MISSING rank×colour: ${missRC.join(', ')}`);
  if (thinRC.length) console.log(`THIN (<3) rank×colour: ${thinRC.join(', ')}`);
  if (!missRC.length && !thinRC.length) console.log('all 26 rank×colours have ≥3 live instances ✓');
}

const [, , cmd, a, b, c] = process.argv;
if (cmd === 'extract' && a) cmd_extract(a, b);
else if (cmd === 'teach' && a && b) cmd_teach(a, b, c);
else { console.log('usage:\n  teach-from-live.mjs extract <reads.json> [outDir]\n  teach-from-live.mjs teach <reads.json> <labels.json> [liveTplFile]'); process.exit(1); }
