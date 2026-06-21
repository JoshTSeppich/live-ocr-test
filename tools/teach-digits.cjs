// tools/teach-digits.cjs — STABLE digit-template teach + abstain-validated read-back.
//
// Money-layer digits for the low-fid viewer. Architecture (the lesson from the
// throwaway-script churn): LABEL THE CLUSTERS ONCE, then tune locate/threshold
// WITHOUT re-clustering — re-clustering per change reshuffles indices and poisons
// labels (the 588.80 garbage). So:
//   TRAIN  = original gold-locate → glyphs → deterministic cluster → FIXED verified
//            label map (asserted against expected cluster sizes so labels can't
//            silently shift) → teach 0-9 and '.' ONLY. We never teach 'B': the
//            suffix is always "BB", chopped by POSITION (last 2 glyph boxes), which
//            killed the B↔8 confusion.
//   READ   = rightmost gold RUN (drops left avatar/name bleed) → segment → drop the
//            trailing 2 boxes (BB) → match each remaining glyph; ABSTAIN (whole
//            number → null) if ANY glyph is below the per-glyph confidence floor.
//            Never-confidently-wrong: a confusable 8/0 shows '?' , never a wrong digit.
//
// HARD GATE: read-back must render the operator's verified values CORRECT or ABSTAIN,
// NEVER WRONG. Seeds nothing on its own — writes the template file only with --write,
// and only after you've read the gate output.
//
// usage: node tools/teach-digits.cjs <capture.json> [--conf 0.74] [--write]
const fs = require('fs'), jpeg = require('jpeg-js');
const E = require('../engine.js');
const _s = {}; globalThis.localStorage = { getItem: k => k in _s ? _s[k] : null, setItem: (k, v) => { _s[k] = String(v); }, removeItem: k => { delete _s[k]; } };

const FILE = process.argv[2];
const CONF = parseFloat((process.argv.find(a => a.startsWith('--conf=')) || '').split('=')[1] || (process.argv[process.argv.indexOf('--conf') + 1]) || '0.74');
const WRITE = process.argv.includes('--write');
if (!FILE) { console.error('usage: node tools/teach-digits.cjs <capture.json> [--conf 0.74] [--write]'); process.exit(1); }
const cap = JSON.parse(fs.readFileSync(FILE));
const badges = cap.badges || cap; // accept a capture or a bare badges array
const dec = u => jpeg.decode(Buffer.from(u.split(',')[1], 'base64'), { useTArray: true });
const isGold = (r, g, bl) => (r - bl) > 45 && r > 120 && g > 90;
const seg = new E.DigitMatcher('seg-only');
const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const REGS = ['stack_TL', 'stack_TC', 'stack_TR', 'stack_BL', 'stack_BC', 'stack_BR', 'bet_TL', 'bet_TC', 'bet_TR', 'bet_BL', 'bet_BC', 'bet_BR'];

// ---- gold band (shared) ----
function band(im) {
  const rg = new Int32Array(im.height);
  for (let y = 0; y < im.height; y++) { let c = 0; for (let x = 0; x < im.width; x++) { const si = (y * im.width + x) * 4; if (isGold(im.data[si], im.data[si + 1], im.data[si + 2])) c++; } rg[y] = c; }
  let pk = 0; for (let y = 1; y < im.height; y++) if (rg[y] > rg[pk]) pk = y; if (rg[pk] < 6) return null;
  let y0 = pk, y1 = pk; while (y0 > 0 && rg[y0 - 1] >= 3) y0--; while (y1 < im.height - 1 && rg[y1 + 1] >= 3) y1++;
  return { y0, y1 };
}
// TRAIN locate: full gold x-extent in the band (matches the clustering we labeled).
function locateTrain(im) {
  const b = band(im); if (!b) return null;
  let x0 = 1e9, x1 = -1; for (let y = b.y0; y <= b.y1; y++) for (let x = 0; x < im.width; x++) { const si = (y * im.width + x) * 4; if (isGold(im.data[si], im.data[si + 1], im.data[si + 2])) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
  return x1 < x0 ? null : { x0, y0: b.y0, x1, y1: b.y1, w: x1 - x0, h: b.y1 - b.y0, clip: x0 <= 1 || x1 >= im.width - 2 };
}
// READ locate: RIGHTMOST run (split on column-gaps >= 26) → drops left avatar bleed.
function locateRead(im) {
  const b = band(im); if (!b) return null;
  const cg = new Int32Array(im.width);
  for (let x = 0; x < im.width; x++) { let c = 0; for (let y = b.y0; y <= b.y1; y++) { const si = (y * im.width + x) * 4; if (isGold(im.data[si], im.data[si + 1], im.data[si + 2])) c++; } cg[x] = c; }
  const runs = []; let s = -1, last = -1;
  for (let x = 0; x < im.width; x++) { if (cg[x] >= 1) { if (s < 0) s = x; last = x; } else if (s >= 0 && x - last >= 26) { runs.push([s, last]); s = -1; } }
  if (s >= 0) runs.push([s, last]);
  if (!runs.length) return null; const r = runs[runs.length - 1];
  return { x0: r[0], y0: b.y0, x1: r[1], y1: b.y1, w: r[1] - r[0], h: b.y1 - b.y0, clip: r[0] <= 1 || r[1] >= im.width - 2 };
}
function boxesOf(im, loc) {
  const cw = loc.w + 4, ch = loc.h + 4, bin = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const sx = loc.x0 - 2 + x, sy = loc.y0 - 2 + y, di = (y * cw + x) * 4; let on = false; if (sx >= 0 && sy >= 0 && sx < im.width && sy < im.height) { const si = (sy * im.width + sx) * 4; on = isGold(im.data[si], im.data[si + 1], im.data[si + 2]); } const v = on ? 0 : 255; bin[di] = bin[di + 1] = bin[di + 2] = v; bin[di + 3] = 255; }
  return seg.segment(bin, cw, ch, {});
}

// ---- TRAIN: cluster (deterministic) ----
const glyphs = [];
for (const rec of badges) { if (rec.anchor === 'anchor-cold' || !rec.numeric) continue; for (const k of REGS) { const n = rec.numeric[k]; if (!n) continue; const im = dec(n.url); const loc = locateTrain(im); if (!loc || loc.clip || loc.w < 30 || loc.w / Math.max(1, loc.h) < 1.4) continue; const boxes = boxesOf(im, loc); if (boxes.length < 3 || boxes.length > 9) continue; for (const bx of boxes) { if (bx.w < 2 || bx.h < 6 || bx.h > 46) continue; glyphs.push({ box: bx, hash: E.hashDigitRGBA(bx.rgba, bx.w, bx.h) }); } } }
const clusters = []; const TH = 13;
for (const g of glyphs) { let best = -1, bd = 1e9; for (let i = 0; i < clusters.length; i++) { const d = ham(g.hash, clusters[i].centroid); if (d < bd) { bd = d; best = i; } } if (best >= 0 && bd <= TH) clusters[best].members.push(g); else clusters.push({ centroid: g.hash, members: [g] }); }
const big = clusters.filter(c => c.members.length >= 3); big.sort((a, b) => b.members.length - a.members.length);

// FIXED verified label map (read once from the cluster grid; D/F/L/B → null).
const LBL = { 0: null/*B*/, 1: '0', 2: '.', 3: '.', 4: null/*B*/, 5: null/*B*/, 6: '1', 7: '9', 8: '8', 9: '0', 10: '4', 11: '2', 12: '5', 13: '6', 14: '3', 15: '7', 16: '5', 17: '6', 18: '1', 19: '0', 20: '4', 21: '9', 22: '0', 23: '3', 24: null/*D*/, 25: '6', 26: null/*F*/, 27: null/*L*/, 28: '3', 29: '1', 30: '2', 31: '7', 32: '8' };
// SAFETY: the labels are tied to cluster ORDER, so assert the leading sizes match
// what we labeled. If the clustering drifts, ABORT rather than teach wrong labels.
const EXPECT = [68, 31, 25, 21, 19, 19, 17, 16, 16, 15, 13];
const got = big.slice(0, EXPECT.length).map(c => c.members.length);
console.log('glyphs=' + glyphs.length + ' clusters=' + big.length + ' leading sizes=' + got.join(','));
if (got.join(',') !== EXPECT.join(',')) { console.error('ABORT: cluster sizes drifted from the labeled set (' + EXPECT.join(',') + ') — labels would be wrong. Re-label before teaching.'); process.exit(2); }

const bySym = {}; big.forEach((c, i) => { const s = LBL[i]; if (!s) return; (bySym[s] = bySym[s] || []).push(...c.members); });
const dm = new E.DigitMatcher('pp-digit-templates-v1'); dm.clear();
for (const s of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.']) { const m = bySym[s] || []; if (!m.length) { console.error('ABORT: no instances for ' + s); process.exit(2); } let bm = m[0], bs = 1e18; for (const a of m) { let sum = 0; for (const b of m) sum += ham(a.hash, b.hash); if (sum < bs) { bs = sum; bm = a; } } dm.teach(s, bm.box.rgba, bm.box.w, bm.box.h); }
console.log('taught ' + dm.size + ' symbols: ' + dm.list().join(' ') + ' (NO B — BB chopped by position)\n');

// ---- READ path: MARGIN-based abstain (best vs 2nd-best distance) ----
// The hash confidence is flat (wrong glyphs score high), so abstain on a small
// margin between the best and runner-up symbol — that's what flags a confusable
// 8/6/5/0. A glyph reads only if it's both close to its best AND clearly closer to
// it than to any other symbol; otherwise the WHOLE number abstains (→ '?').
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.'];
function matchMargin(rgba, w, h) {
  const pb = E.hashDigitRGBA(rgba, w, h), pe = E.hashDigitEdge(rgba, w, h), pc = E.hashDigitColor(rgba, w, h);
  let b1 = 1e9, b2 = 1e9, sym = null;
  for (const s of DIGITS) { const t = dm.templates.get(s); if (!t) continue; const d = 0.5 * ham(pb, t.brightness) + 0.3 * ham(pc, t.color) + 0.2 * ham(pe, t.edge); if (d < b1) { b2 = b1; b1 = d; sym = s; } else if (d < b2) b2 = d; }
  return { sym, best: b1, margin: b2 - b1 };
}
let MAXD = 18, MARGIN = 6; // tuned by the sweep below
function readNum(im) { const loc = locateRead(im); if (!loc || loc.clip) return { v: null, why: 'clip' }; const boxes = boxesOf(im, loc); if (boxes.length < 3) return { v: null, why: 'short' }; const body = boxes.slice(0, boxes.length - 2); let out = ''; for (const b of body) { if (b.w < 2 || b.h < 6) return { v: null, why: 'noise' }; const r = matchMargin(b.rgba, b.w, b.h); if (r.best > MAXD || r.margin < MARGIN) return { v: null, why: 'abstain' }; out += r.sym; } return { v: out }; }

// ---- VALIDATION: per-record per-seat read-back + the operator's 6-value gate ----
const SEATS = ['stack_TL', 'stack_TC', 'stack_TR', 'stack_BL', 'stack_BC', 'stack_BR'];
const GATE = { stack_TL: '72.60', stack_TC: '116.80', stack_TR: '307', stack_BL: '156.50', stack_BC: '34.70', stack_BR: '178.60' };

// SWEEP (MAXD, MARGIN) for the strictest setting that reads SOMETHING while the
// 6-value gate stays clean (correct-or-abstain, never wrong) across ALL records.
console.log('=== margin/maxdist sweep — gate across ALL records (correct|abstain|WRONG) ===');
let bestCfg = null;
for (const md of [22, 18, 15, 12]) for (const mg of [3, 5, 7, 10]) {
  MAXD = md; MARGIN = mg; let correct = 0, abstain = 0, wrong = 0, wrongEx = [];
  badges.forEach(rec => { if (!rec.numeric) return; for (const k of SEATS) { if (!GATE[k] || !rec.numeric[k]) continue; const r = readNum(dec(rec.numeric[k].url)); if (!r.v) abstain++; else if (r.v === GATE[k]) correct++; else { wrong++; if (wrongEx.length < 2) wrongEx.push(GATE[k] + '→' + r.v); } } });
  const tag = 'md' + md + ' mg' + mg;
  console.log('  ' + tag.padEnd(9) + ' correct=' + correct + ' abstain=' + abstain + ' WRONG=' + wrong + (wrong ? ' (' + wrongEx.join(',') + ')' : ''));
  if (wrong === 0 && correct > 0 && (!bestCfg || correct > bestCfg.correct)) bestCfg = { md, mg, correct, abstain };
}
if (bestCfg) { MAXD = bestCfg.md; MARGIN = bestCfg.mg; console.log('\nstrictest clean cfg: md' + bestCfg.md + ' mg' + bestCfg.mg + ' → ' + bestCfg.correct + ' correct, ' + bestCfg.abstain + ' abstain, 0 wrong'); }
else { MAXD = 12; MARGIN = 10; console.log('\nNO clean cfg found at any sweep point — gate cannot pass with this matcher.'); }

console.log('\nper-record stack read-back (md=' + MAXD + ' mg=' + MARGIN + ', "?"=abstain):');
let totRead = 0, totAbs = 0;
badges.forEach((rec, ri) => { if (rec.anchor === 'anchor-cold' || !rec.numeric) return; const row = SEATS.map(k => { if (!rec.numeric[k]) return k.slice(6) + ':-'; const r = readNum(dec(rec.numeric[k].url)); if (r.v) totRead++; else if (r.why === 'abstain') totAbs++; return k.slice(6) + ':' + (r.v || '?'); }); console.log('  rec' + String(ri).padStart(2) + '  ' + row.join('  ')); });
console.log('\nread ' + totRead + ', abstain ' + totAbs);

// 6-value gate: find any record whose seats match the verified values; assert no WRONG
console.log('\n=== HARD GATE: operator-verified values (CORRECT or ABSTAIN, never WRONG) ===');
let gateRecord = null, bestMatch = -1;
badges.forEach((rec, ri) => { if (!rec.numeric) return; let m = 0; for (const k of SEATS) { if (!rec.numeric[k]) continue; const r = readNum(dec(rec.numeric[k].url)); if (r.v === GATE[k]) m++; } if (m > bestMatch) { bestMatch = m; gateRecord = ri; } });
let anyWrong = false;
if (gateRecord != null) {
  const rec = badges[gateRecord];
  console.log('best-matching record: rec' + gateRecord + ' (matched ' + bestMatch + '/6 exactly)');
  for (const k of SEATS) { if (!rec.numeric[k]) { console.log('  ' + k + ' expect ' + GATE[k] + ' → (no crop)'); continue; } const r = readNum(dec(rec.numeric[k].url)); const verdict = !r.v ? 'ABSTAIN (ok)' : (r.v === GATE[k] ? 'CORRECT' : 'WRONG !!'); if (r.v && r.v !== GATE[k]) anyWrong = true; console.log('  ' + k + ' expect ' + GATE[k].padEnd(7) + ' → ' + (r.v || '?').padEnd(8) + ' ' + verdict); }
}
console.log('\nGATE RESULT: ' + (anyWrong ? 'FAIL — a verified value read WRONG (do not seed)' : 'PASS — every verified value read CORRECT or ABSTAINED'));
if (WRITE && !anyWrong) { fs.writeFileSync('multi-sig-templates.digits.live.json', dm.serialize()); console.log('WROTE multi-sig-templates.digits.live.json'); }
else if (WRITE) console.log('NOT written — gate failed.');
