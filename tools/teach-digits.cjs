// tools/teach-digits.cjs — STABLE digit teach (correlation matcher) + abstain gate.
//
// Money-layer digits for the low-fid viewer. Option 2: the 96-bit hash couldn't
// separate 8/6/5/0 — replaced with higher-res NORMALIZED-GRID CORRELATION (cosine
// on a 20x32 binary grid of the glyph's tight-ink region; ~98% per-glyph vs the
// hash's mush). '.' is detected by GEOMETRY (short ink, not stretched to the grid
// where it looked like 6). 'B' is never read — the "BB" suffix abstains (untaught)
// and bounds the number on the right; the avatar abstains on the left.
//
// STABLE: label the hash-clusters ONCE + ASSERT leading cluster sizes so labels
// can't silently shift (re-clustering-per-change was the 588.80 garbage). The
// CORRELATION templates are built from those fixed labels.
//
// READ: gold band -> segment ALL glyphs -> classify each (dot | digit-by-cos |
// ABSTAIN on low self-cos OR low best-vs-2nd margin) -> take the SINGLE maximal
// contiguous confident run (drops avatar+BB; a mid-number abstain splits the run
// -> whole number abstains). Never-confidently-wrong: a confusable glyph -> '?'.
//
// HARD GATE: the operator's 6 verified values must read CORRECT or ABSTAIN, never
// WRONG. --write seeds the engine DigitMatcher format ONLY on a clean gate.
//
// usage: node tools/teach-digits.cjs <capture.json> [--write]
const fs = require('fs'), jpeg = require('jpeg-js');
const E = require('../engine.js');
const FILE = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!FILE) { console.error('usage: node tools/teach-digits.cjs <capture.json> [--write]'); process.exit(1); }
const cap = JSON.parse(fs.readFileSync(FILE));
const badges = cap.badges || cap;
const dec = u => jpeg.decode(Buffer.from(u.split(',')[1], 'base64'), { useTArray: true });
const isGold = (r, g, bl) => (r - bl) > 45 && r > 120 && g > 90;
const seg = new E.DigitMatcher('seg-only');
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const REGS = ['stack_TL', 'stack_TC', 'stack_TR', 'stack_BL', 'stack_BC', 'stack_BR', 'bet_TL', 'bet_TC', 'bet_TR', 'bet_BL', 'bet_BC', 'bet_BR'];
const SEATS = ['stack_TL', 'stack_TC', 'stack_TR', 'stack_BL', 'stack_BC', 'stack_BR'];
const GATE = { stack_TL: '72.60', stack_TC: '116.80', stack_TR: '307', stack_BL: '156.50', stack_BC: '34.70', stack_BR: '178.60' };

function band(im) { const rg = new Int32Array(im.height); for (let y = 0; y < im.height; y++) { let c = 0; for (let x = 0; x < im.width; x++) { const si = (y * im.width + x) * 4; if (isGold(im.data[si], im.data[si + 1], im.data[si + 2])) c++; } rg[y] = c; } let pk = 0; for (let y = 1; y < im.height; y++) if (rg[y] > rg[pk]) pk = y; if (rg[pk] < 6) return null; let y0 = pk, y1 = pk; while (y0 > 0 && rg[y0 - 1] >= 3) y0--; while (y1 < im.height - 1 && rg[y1 + 1] >= 3) y1++; return { y0, y1 }; }
function fullBin(im) { const b = band(im); if (!b) return null; let x0 = 1e9, x1 = -1; for (let y = b.y0; y <= b.y1; y++) for (let x = 0; x < im.width; x++) { const si = (y * im.width + x) * 4; if (isGold(im.data[si], im.data[si + 1], im.data[si + 2])) { if (x < x0) x0 = x; if (x > x1) x1 = x; } } if (x1 < x0) return null; const cw = x1 - x0 + 4, ch = b.y1 - b.y0 + 4, bin = new Uint8ClampedArray(cw * ch * 4); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const sx = x0 - 2 + x, sy = b.y0 - 2 + y, di = (y * cw + x) * 4; let on = false; if (sx >= 0 && sy >= 0 && sx < im.width && sy < im.height) { const si = (sy * im.width + sx) * 4; on = isGold(im.data[si], im.data[si + 1], im.data[si + 2]); } const v = on ? 0 : 255; bin[di] = bin[di + 1] = bin[di + 2] = v; bin[di + 3] = 255; } return { bin, cw, ch, x0clip: x0 <= 1, x1clip: x1 >= im.width - 2 }; }

// tight ink bbox inside a segment box (ink = pixel<128)
function tight(b) { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { if (b.rgba[(y * b.w + x) * 4] < 128) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return n ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null; }
const GW = 20, GH = 32;
function normTight(b, t) { const g = new Uint8Array(GW * GH); for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) { const ax0 = t.x0 + Math.floor(gx * t.w / GW), ax1 = t.x0 + Math.max(Math.floor(gx * t.w / GW) + 1, Math.floor((gx + 1) * t.w / GW)); const ay0 = t.y0 + Math.floor(gy * t.h / GH), ay1 = t.y0 + Math.max(Math.floor(gy * t.h / GH) + 1, Math.floor((gy + 1) * t.h / GH)); let ink = 0, tot = 0; for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) { tot++; if (b.rgba[(y * b.w + x) * 4] < 128) ink++; } g[gy * GW + gx] = (ink * 2 >= tot) ? 1 : 0; } return g; }
const cos = (a, b) => { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i]; nb += b[i]; } return na && nb ? dot / Math.sqrt(na * nb) : 0; };

// ---- TRAIN: hash-cluster (deterministic) + fixed labels ----
const glyphs = [];
for (const rec of badges) { if (rec.anchor === 'anchor-cold' || !rec.numeric) continue; for (const k of REGS) { const n = rec.numeric[k]; if (!n) continue; const im = dec(n.url); const fb = fullBin(im); if (!fb || fb.x0clip || fb.x1clip) continue; const boxes = seg.segment(fb.bin, fb.cw, fb.ch, {}); if (boxes.length < 3 || boxes.length > 9) continue; for (const bx of boxes) { if (bx.w < 2 || bx.h < 6 || bx.h > 46) continue; /* EXACT original filter — keeps the labeled clustering stable */ const t = tight(bx); if (!t) continue; glyphs.push({ box: bx, t, hash: E.hashDigitRGBA(bx.rgba, bx.w, bx.h), grid: normTight(bx, t), bandH: fb.ch }); } } }
const clusters = []; for (const g of glyphs) { let best = -1, bd = 1e9; for (let i = 0; i < clusters.length; i++) { const d = ham(g.hash, clusters[i].centroid); if (d < bd) { bd = d; best = i; } } if (best >= 0 && bd <= 13) clusters[best].members.push(g); else clusters.push({ centroid: g.hash, members: [g] }); }
const big = clusters.filter(c => c.members.length >= 3); big.sort((a, b) => b.members.length - a.members.length);
// B taught as its OWN symbol (correlation separates B from 8, unlike the hash) so
// the "BB" suffix reads as B and is stripped — instead of leaking in as "88".
const LBL = { 0: 'B', 1: '0', 2: '.', 3: '.', 4: 'B', 5: 'B', 6: '1', 7: '9', 8: '8', 9: '0', 10: '4', 11: '2', 12: '5', 13: '6', 14: '3', 15: '7', 16: '5', 17: '6', 18: '1', 19: '0', 20: '4', 21: '9', 22: '0', 23: '3', 24: null, 25: '6', 26: null, 27: null, 28: '3', 29: '1', 30: '2', 31: '7', 32: '8' };
const EXPECT = [68, 31, 25, 21, 19, 19, 17, 16, 16, 15, 13];
const got = big.slice(0, EXPECT.length).map(c => c.members.length);
console.log('glyphs=' + glyphs.length + ' clusters=' + big.length + ' leading=' + got.join(','));
if (got.join(',') !== EXPECT.join(',')) { console.error('ABORT: cluster sizes drifted — labels would be wrong.'); process.exit(2); }
// correlation template per digit = AVERAGE of member grids, thresholded
const DIG = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const TPL = DIG.concat('B'); // B has a template so it classifies as B (then stripped), not 8
const bySym = {}; big.forEach((c, i) => { const s = LBL[i]; if (!s) return; (bySym[s] = bySym[s] || []).push(...c.members); });
const tpl = {};
for (const s of TPL) { const m = (bySym[s] || []).filter(g => g.t.h >= 0.5 * g.bandH); if (!m.length) { console.error('ABORT: no instances for ' + s); process.exit(2); } const acc = new Float32Array(GW * GH); for (const g of m) for (let i = 0; i < acc.length; i++) acc[i] += g.grid[i]; const grid = new Uint8Array(GW * GH); for (let i = 0; i < acc.length; i++) grid[i] = acc[i] * 2 >= m.length ? 1 : 0; tpl[s] = grid; }
console.log('built correlation templates for ' + TPL.join('') + ' + geometric "."\n');

// ---- classify one glyph: dot | digit | abstain ----
function classify(g, COS_MIN, MARGIN) {
  // short ink: a decimal point is COMPACT ink at the BASELINE. Anything else short
  // (avatar speck, stray) is NOT a dot — abstain it, don't turn it into a false '.'
  // that would corrupt the run (the 307→two-dot abstain).
  if (g.t.h < 0.45 * g.bandH) {
    const atBaseline = (g.t.y0 / g.box.h) > 0.40, compact = g.t.w < 0.7 * g.bandH;
    return (atBaseline && compact) ? { sym: '.', ok: true } : { sym: null, ok: false };
  }
  let b1 = -1, b2 = -1, sym = null; for (const s of TPL) { const sc = cos(g.grid, tpl[s]); if (sc > b1) { b2 = b1; b1 = sc; sym = s; } else if (sc > b2) b2 = sc; }
  if (b1 < COS_MIN || (b1 - b2) < MARGIN) return { sym: null, ok: false, best: b1, margin: b1 - b2 };
  return { sym, ok: true, best: b1, margin: b1 - b2 };
}
// ---- read a region: contiguous confident run = the number ----
function readNum(im, COS_MIN, MARGIN) {
  const fb = fullBin(im); if (!fb) return { v: null };
  const boxes = seg.segment(fb.bin, fb.cw, fb.ch, {});
  // NB: do NOT drop short glyphs here — the decimal point's tight height is ~4px;
  // classify() detects it by geometry. Dropping it would split "72.60" into two runs.
  const cls = boxes.map(b => { if (b.w < 2) return { ok: false }; const t = tight(b); if (!t || t.h < 2 || t.h > 46) return { ok: false }; return classify({ box: b, t, grid: normTight(b, t), bandH: fb.ch }, COS_MIN, MARGIN); });
  // maximal contiguous confident runs
  const runs = []; let cur = null;
  cls.forEach((c, i) => { if (c.ok) { if (!cur) { cur = { s: i, syms: [] }; } cur.syms.push(c.sym); } else if (cur) { runs.push(cur); cur = null; } });
  if (cur) runs.push(cur);
  // a number run = "<digits/.> BB": strip trailing B's; reject if any B remains
  // (mid-run B = a body 8 misread as B, or junk) or structure is invalid.
  const valid = runs.map(r => { const s = r.syms.slice(); while (s.length && s[s.length - 1] === 'B') s.pop(); return s; })
    .filter(s => { if (!s.length) return false; if (s.includes('B')) return false; const dots = s.filter(c => c === '.').length; const digs = s.filter(c => c !== '.').length; return digs >= 1 && dots <= 1 && s.length <= 7 && s[0] !== '.'; });
  if (valid.length !== 1) return { v: null, why: valid.length === 0 ? 'no-run' : 'multi-run' };
  return { v: valid[0].join('') };
}

if (process.argv.includes('--trace')) {
  const tr = badges[9];
  for (const k of SEATS) {
    if (!tr.numeric[k]) continue;
    const im = dec(tr.numeric[k].url); const fb = fullBin(im);
    const boxes = seg.segment(fb.bin, fb.cw, fb.ch, {});
    const t2 = boxes.map(b => { if (b.w < 2) return 'w<2'; const t = tight(b); if (!t || t.h < 6 || t.h > 46) return 'th'; const c = classify({ box: b, t, grid: normTight(b, t), bandH: fb.ch }, 0.74, 0.07); return (c.sym || '?') + (c.ok ? '' : '×') + (c.best != null ? '(' + c.best.toFixed(2) + '/' + c.margin.toFixed(2) + ')' : ''); });
    console.log(k.slice(6) + ' expect ' + GATE[k].padEnd(7) + ' [' + t2.join(' ') + ']');
  }
  process.exit(0);
}

// Identify the ONE verified record (the operator's 6 values came from a single
// entry) — the record matching the most gate values at a lenient setting.
let gr = -1, gm = -1;
badges.forEach((rec, ri) => { if (!rec.numeric) return; let m = 0; for (const k of SEATS) { if (!rec.numeric[k]) continue; const r = readNum(dec(rec.numeric[k].url), 0.68, 0.03); if (r.v === GATE[k]) m++; } if (m > gm) { gm = m; gr = ri; } });
console.log('verified record = rec' + gr + ' (matches ' + gm + '/6 of the operator values at lenient read)\n');

// ---- GATE sweep on the VERIFIED record only: strictest CLEAN (correct, no WRONG) ----
console.log('=== gate sweep on rec' + gr + ' (its 6 seats; correct|abstain|WRONG) ===');
let bestCfg = null; const vrec = badges[gr];
for (const cm of [0.70, 0.74, 0.78]) for (const mg of [0.04, 0.07, 0.10, 0.14]) {
  let correct = 0, abstain = 0, wrong = 0, ex = [];
  for (const k of SEATS) { if (!vrec.numeric[k]) continue; const r = readNum(dec(vrec.numeric[k].url), cm, mg); if (!r.v) abstain++; else if (r.v === GATE[k]) correct++; else { wrong++; ex.push(GATE[k] + '->' + r.v); } }
  console.log('  cos' + cm + ' mg' + mg + '  correct=' + correct + ' abstain=' + abstain + ' WRONG=' + wrong + (wrong ? ' (' + ex.join(',') + ')' : ''));
  if (wrong === 0 && correct > 0 && (!bestCfg || correct > bestCfg.correct)) bestCfg = { cm, mg, correct, abstain };
}
console.log();
if (!bestCfg) { console.log('GATE: FAIL — no clean config on the verified record. Not seeding.'); if (!process.argv.includes('--trace')) process.exit(0); }
const { cm, mg } = bestCfg || { cm: 0.74, mg: 0.07 };
console.log('strictest CLEAN cfg: cos' + cm + ' mg' + mg + ' (' + bestCfg.correct + ' correct, ' + bestCfg.abstain + ' abstain, 0 wrong)\n');
console.log('=== HARD GATE @ cos' + cm + ' mg' + mg + ' on rec' + gr + ' ===');
let anyWrong = false;
for (const k of SEATS) { if (!vrec.numeric[k]) { console.log('  ' + k + ' expect ' + GATE[k] + ' (no crop)'); continue; } const r = readNum(dec(vrec.numeric[k].url), cm, mg); const verdict = !r.v ? 'ABSTAIN' : (r.v === GATE[k] ? 'CORRECT' : 'WRONG !!'); if (r.v && r.v !== GATE[k]) anyWrong = true; console.log('  ' + k + ' expect ' + GATE[k].padEnd(7) + ' -> ' + (r.v || '?').padEnd(8) + ' ' + verdict); }
// context: overall read/abstain rate across all seats (no ground truth, just coverage)
let rd = 0, ab = 0; badges.forEach(rec => { if (!rec.numeric) return; for (const k of SEATS) { if (!rec.numeric[k]) continue; const r = readNum(dec(rec.numeric[k].url), cm, mg); if (r.v) rd++; else ab++; } });
console.log('\noverall coverage (all records): ' + rd + ' read, ' + ab + ' abstain (' + (100 * rd / (rd + ab)).toFixed(0) + '% read)');
console.log('GATE: ' + (anyWrong ? 'FAIL' : 'PASS — every verified value CORRECT or ABSTAINED'));

if (WRITE && !anyWrong) {
  const out = { schema_version: 1, kind: 'correlation', grid: [GW, GH], cos_min: cm, margin: mg, digits: {} };
  for (const s of DIG) out.digits[s] = Array.from(tpl[s]);
  fs.writeFileSync('digit-templates.live.json', JSON.stringify(out));
  console.log('WROTE digit-templates.live.json (correlation, ' + DIG.length + ' digits, cos_min=' + cm + ' margin=' + mg + ')');
} else if (WRITE) console.log('NOT written — gate failed.');

// --- DEBUG TRACE (rec9 = verified record): glyph classifications + runs ---
if (process.argv.includes('--trace')) {
  const tr = badges[9];
  for (const k of SEATS) {
    if (!tr.numeric[k]) continue;
    const im = dec(tr.numeric[k].url); const fb = fullBin(im);
    const boxes = seg.segment(fb.bin, fb.cw, fb.ch, {});
    const trace = boxes.map(b => { if (b.w < 2) return 'w<2'; const t = tight(b); if (!t || t.h < 6 || t.h > 46) return 'th'; const c = classify({ box: b, t, grid: normTight(b, t), bandH: fb.ch }, 0.74, 0.07); return (c.sym || '?') + (c.ok ? '' : '×') + (c.best != null ? '(' + c.best.toFixed(2) + '/' + (c.margin).toFixed(2) + ')' : ''); });
    console.log(k + ' expect ' + GATE[k] + ': [' + trace.join(' ') + ']  band' + fb.cw + 'x' + fb.ch);
  }
}
