#!/usr/bin/env node
// Part-2 corpus gate: exercise the LIVE per-card strip cropper (converter/
// frame.js sliceCells) over the native 2940×1846 corpus, the way the live path
// runs it — crop the BOARD_BOX / HERO_HOLE_BOX region from the frame, slice into
// per-card 55×130 corner strips, run the REAL match(), compare to truth. Also
// measures the CROP DELTA: slicer strip vs the calibration strip (validate-suit-
// corpus convention: board left=bbox_x+30, hero left=bbox_x, top=cardTop). NEW
// script; mutates nothing.
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

const PVA = '/Users/joshuatseppich/projects/poker-vision-analysis/output';
const board = JSON.parse(fs.readFileSync(path.join(PVA, 'board_cards.json')));
const hero = JSON.parse(fs.readFileSync(path.join(PVA, 'hero_hands.json')));
const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'multi-sig-templates.strip.json')));
localStorage.setItem('multi-sig-templates', JSON.stringify(tpl));
const matcher = new E.MultiSignatureMatcher();
const norm = (c) => c.replace('10', 'T');

const _cache = {};
function load(cap, f) { const k = cap + '/' + f; if (!_cache[k]) _cache[k] = PNG.sync.read(fs.readFileSync(path.join(cap, f))); return _cache[k]; }
// crop a w×h RGBA region {rgba,w,h} out of a decoded PNG at (x,y)
function cropRegion(png, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) { const s = ((y + yy) * png.width + x) * 4; out.set(png.data.subarray(s, s + w * 4), yy * w * 4); }
  return { rgba: out, w, h };
}
// calibration strip (validate-suit-corpus convention) for delta comparison
function calCardTop(png, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) { let b = 0; for (let xx = x; xx < x + w; xx++) { const i = (yy * png.width + xx) * 4; if ((png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 > 150) b++; } if (b > 0.5 * w) return yy; }
  return y;
}
function calStrip(png, left, top) {
  const W = 55, H = 130, out = new Uint8Array(W * H * 4);
  for (let yy = 0; yy < H; yy++) { const s = ((top + yy) * png.width + left) * 4; out.set(png.data.subarray(s, s + W * 4), yy * W * 4); }
  return { rgba: out, w: W, h: H };
}
function stripDelta(a, b) { // max + mean abs RGBA diff over identical-size strips
  if (a.w !== b.w || a.h !== b.h) return { max: 255, mean: 255, sizeMismatch: true };
  let max = 0, sum = 0; const n = a.rgba.length;
  for (let i = 0; i < n; i++) { const d = Math.abs(a.rgba[i] - b.rgba[i]); if (d > max) max = d; sum += d; }
  return { max, mean: +(sum / n).toFixed(3), sizeMismatch: false };
}

const SUITS = ['c', 'd', 'h', 's'];
const ink = (s) => (s === 'h' || s === 'd' ? 'red' : 'black');
function tally() { return { total: 0, rankOK: 0, colorOK: 0, suitConfOK: 0, suitConfWrong: 0, abstain: 0, noread: 0, rawRankOK: 0, rawColorOK: 0, deltaMax: 0, deltaMeanSum: 0, deltaN: 0, anchorOff: [], dimCount: 0, dimWouldWrong: 0, whiteTotal: 0, whiteRankOK: 0 }; }
const wrong = [];
function run(layout, frame, cap, cells, truths, bboxes, t) {
  for (let i = 0; i < truths.length; i++) {
    const strip = cells[i];
    t.total++;
    const truthRank = truths[i][0], truthSuit = truths[i][1];
    const m = matcher.match(strip.rgba, strip.w, strip.h);
    // ── DIM (showdown) cards: the read-path GUARD forces ABSTAIN (never confident),
    // so production confident-wrong on dim is 0 BY CONSTRUCTION. Diagnose what the
    // guard PREVENTS: how many would have been confident-wrong without it.
    if (strip.dim) {
      t.dimCount++;
      const confident = m && m.confidence != null && m.confidence >= 0.95;
      if (confident && m.suitConfident && m.suit !== truthSuit) t.dimWouldWrong++;
      continue;
    }
    // crop-delta vs calibration anchor (white cards only)
    const png = load(cap, frame);
    const [bx, by, , bh] = bboxes[i];
    const calLeft = layout === 'board' ? bx + 30 : bx;
    const calTop = calCardTop(png, calLeft, by, 55, bh);
    const d = stripDelta(strip, calStrip(png, calLeft, calTop));
    t.deltaMax = Math.max(t.deltaMax, d.max); t.deltaMeanSum += d.mean; t.deltaN++;
    if (d.max > 0) t.anchorOff.push({ frame, i, truth: truths[i], delta: d });
    if (m) { if (m.card[0] === truthRank) { t.rawRankOK++; } if (ink(m.suit) === ink(truthSuit)) t.rawColorOK++; }
    t.whiteTotal++; if (m && m.card[0] === truthRank) t.whiteRankOK++;
    if (!m || m.confidence == null || m.confidence < 0.85) { t.noread++; continue; }
    if (m.card[0] === truthRank) t.rankOK++;
    if (ink(m.suit) === ink(truthSuit)) t.colorOK++;
    if (m.suitConfident) { if (m.suit === truthSuit) t.suitConfOK++; else { t.suitConfWrong++; wrong.push({ truth: truths[i], got: m.card, layout, frame }); } }
    else t.abstain++;
  }
}

// ── BOARD: crop the (extended) BOARD_BOX, slice 5; the DETECTOR finds each card's
// top + sets present. Cards snap to FIXED slots (1023+k·167). We score both the
// is_present gate (TP/FP/FN — FP = a chip/clutter mistaken for a card) and the
// read quality on present cards. ──
const FIRST_SLOT_X = 1023, PITCH = 167;
const tb = tally();
const presence = { TP: 0, FP: 0, FN: 0, TN: 0, fp: [], fn: [] };
for (const fr of board.boards) {
  const png = load(board.capture_dir, fr.frame);
  const bb = R.BOARD_BOX;
  const crop = cropRegion(png, bb.x, bb.y, bb.w, bb.h);
  const cells = F.sliceCells(crop, R.BOARD_CELLS, { layout: 'board' });
  // Match each detected card to the nearest truth card by FRAME x (body-left), as
  // production does — each card reads independently. This isolates an FP (no nearby
  // truth) instead of letting it shift the whole sequence (which would mis-blame the
  // real cards). detected.x is region-local; +BOARD_BOX.x → frame; truth body-left
  // = bbox_x+30.
  const detected = cells.filter((c) => c && c.present).map((c) => ({ c, fx: bb.x + c.x }));
  const truth = [...fr.cards].sort((a, b) => a.bbox[0] - b.bbox[0]);
  const usedT = new Set();
  for (const d of detected) {
    let bestT = -1, bestDist = 1e9;
    for (let k = 0; k < truth.length; k++) { if (usedT.has(k)) continue; const dist = Math.abs(d.fx - (truth[k].bbox[0] + 30)); if (dist < bestDist) { bestDist = dist; bestT = k; } }
    if (bestT >= 0 && bestDist <= 80) { usedT.add(bestT); presence.TP++; run('board', fr.frame, board.capture_dir, [d.c], [norm(truth[bestT].card)], [truth[bestT].bbox], tb); }
    else { presence.FP++; if (presence.fp.length < 12) presence.fp.push(fr.frame + ' @' + d.fx + (d.c.dim ? ' dim' : '')); }
  }
  for (let k = 0; k < truth.length; k++) if (!usedT.has(k)) { presence.FN++; if (presence.fn.length < 12) presence.fn.push(fr.frame + ' ' + truth[k].card); }
  presence.TN += Math.max(0, R.BOARD_CELLS - Math.max(detected.length, truth.length));
}
// ── HERO: crop HERO_HOLE_BOX, slice 2 (overlap), match rear+front ──
const th = tally();
for (const hd of hero.hands) {
  if (hd.cards.length !== 2) continue;
  const png = load(hero.capture_dir, hd.frame);
  const hb = R.HERO_HOLE_BOX;
  const crop = cropRegion(png, hb.x, hb.y, hb.w, hb.h);
  const cells = F.sliceCells(crop, R.HERO_HOLE_CELLS, { layout: 'hero' });
  const ri = hd.cards[0].bbox[2] < hd.cards[1].bbox[2] ? 0 : 1;
  const order = [hd.cards[ri], hd.cards[1 - ri]]; // [rear, front] == [strip0, strip1]
  run('hero', hd.frame, hero.capture_dir, cells, order.map((c) => norm(c.card)), order.map((c) => c.bbox), th);
}

function report(name, t) {
  const reads = t.suitConfOK + t.suitConfWrong;
  console.log(`\n=== ${name} (${t.total} card instances; ${t.whiteTotal} white + ${t.dimCount} dim) ===`);
  console.log(`  WHITE (non-showdown) rank: ${t.whiteRankOK}/${t.whiteTotal} (${(100 * t.whiteRankOK / Math.max(t.whiteTotal, 1)).toFixed(1)}%)  ← must hold the 93.9% baseline`);
  console.log(`  GATED (live @0.85, white): rank ${t.rankOK}/${t.whiteTotal} (${(100 * t.rankOK / Math.max(t.whiteTotal, 1)).toFixed(1)}%)`);
  console.log(`  suit confident (white): ${reads}  correct ${t.suitConfOK}  WRONG ${t.suitConfWrong}   abstain ${t.abstain}   no-read ${t.noread}`);
  console.log(`  DIM (showdown): ${t.dimCount} detected → ALL abstain via guard (0 confident).  guard prevented ${t.dimWouldWrong} would-be confident-wrong`);
  console.log(`  CROP DELTA vs calibration (white): max ${t.deltaMax}  mean ${(t.deltaMeanSum / Math.max(t.deltaN, 1)).toFixed(3)}  (differ: ${t.anchorOff.length}/${t.deltaN})`);
}
report('BOARD', tb);
console.log(`  is_present gate: TP ${presence.TP}  FP ${presence.FP} (chip/clutter read as card)  FN ${presence.FN} (card missed)  TN ${presence.TN} (empty slot OK)`);
if (presence.fp.length) console.log('    FP (chip mistaken for card):', JSON.stringify(presence.fp));
if (presence.fn.length) console.log('    FN (card missed):', JSON.stringify(presence.fn));
report('HERO', th);
const totalWrong = tb.suitConfWrong + th.suitConfWrong; // dim is guarded → abstain → 0 in production
console.log(`\n*** BAR: zero confident-wrong in production -> ${totalWrong === 0 ? 'PASS ✓' : 'FAIL ✗'}  (white suit-wrong ${totalWrong}; dim guarded, prevented ${tb.dimWouldWrong + th.dimWouldWrong}) ***`);
if (wrong.length) console.log('CONFIDENT WRONG:', JSON.stringify(wrong.slice(0, 20), null, 1));
// show a couple of nonzero deltas if any
const sample = [...tb.anchorOff, ...th.anchorOff].slice(0, 6);
if (sample.length) console.log('\nnonzero crop-delta samples:', JSON.stringify(sample, null, 1));
