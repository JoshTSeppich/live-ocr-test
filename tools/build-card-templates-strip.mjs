#!/usr/bin/env node
// Stage B (strip session): hash the 52 corner-strip crops into the browser
// MultiSignatureMatcher format, then DUAL-validate.
//   1. write multi-sig-templates.strip.json  (52 keys, bare localStorage shape)
//   2. self-match (rank-1) + suit-discrimination sub-check
//   3. overlap validation: read REAR (occluded) hero cards from the corpus
// NEW script only; require()s engine.js, mutates no live code.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// stub localStorage BEFORE requiring engine.js so the matcher's _load() works
const _store = {};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};
const E = require(path.join(ROOT, 'engine.js'));
const { hashCardRGBA, hashCardEdge, hashCardColor, MultiSignatureMatcher } = E;

const STRIP_DIR = '/Users/joshuatseppich/projects/poker-vision-analysis/output/card_strips';
const HERO_JSON = '/Users/joshuatseppich/projects/poker-vision-analysis/output/hero_hands.json';
const OUT = path.join(ROOT, 'multi-sig-templates.strip.json');
const RANKS = '23456789TJQKA', SUITS = 'cdhs';
const CODES = [];
for (const r of RANKS) for (const s of SUITS) CODES.push(r + s);
const norm = (c) => c.replace('10', 'T');

function loadPNG(p) {
  const png = PNG.sync.read(fs.readFileSync(p));
  return { rgba: new Uint8Array(png.data), w: png.width, h: png.height };
}
// crop a w×h RGBA window out of a decoded full PNG
function cropFrom(png, x0, y0, cw, ch) {
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const sRow = ((y0 + y) * png.width + x0) * 4;
    out.set(png.data.subarray(sRow, sRow + cw * 4), y * cw * 4);
  }
  return { rgba: out, w: cw, h: ch };
}
// first row (within band) whose card-body cols are >50% bright — the white top
function heroCardTop(png, rx, ry, rw, rh) {
  for (let y = ry; y < ry + rh; y++) {
    let bright = 0;
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * png.width + x) * 4;
      if ((png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 > 150) bright++;
    }
    if (bright > 0.5 * rw) return y;
  }
  return ry;
}

// ── 1. hash strips → templates ────────────────────────────────────────────
const templates = {}, crops = {};
for (const code of CODES) {
  const c = loadPNG(path.join(STRIP_DIR, code + '.png'));
  crops[code] = c;
  templates[code] = {
    brightness: Array.from(hashCardRGBA(c.rgba, c.w, c.h)),
    edge: Array.from(hashCardEdge(c.rgba, c.w, c.h)),
    color: Array.from(hashCardColor(c.rgba, c.w, c.h)),
  };
}
fs.writeFileSync(OUT, JSON.stringify(templates));
console.log(`wrote ${OUT} (${Object.keys(templates).length} keys)`);

// build matcher from the JSON via the real load path
localStorage.setItem('multi-sig-templates', JSON.stringify(templates));
const matcher = new MultiSignatureMatcher();
console.log(`matcher.size = ${matcher.size}  (expect 52)`);

// ── 2a. self-match (rank-1) ───────────────────────────────────────────────
let selfPass = 0; const selfFail = [];
for (const code of CODES) {
  const { rgba, w, h } = crops[code];
  const res = matcher.match(rgba, w, h);
  if (res && res.card === code) selfPass++;
  else selfFail.push({ code, got: res && res.card, conf: res && +res.confidence.toFixed(3) });
}
console.log(`\nSELF-MATCH: ${selfPass}/52 rank-1` + (selfFail.length ? `  FAILURES: ${JSON.stringify(selfFail)}` : '  ✓'));

// ── 2b. suit-discrimination sub-check ─────────────────────────────────────
// For each card, rank ALL templates by the matcher's combined distance and
// confirm self is #1 AND report the nearest neighbour + whether the closest
// SAME-RANK sibling (the suit-collision risk) is safely behind self.
function combinedDistTo(probe, code) {
  // replicate match()'s weighting against one stored template
  const t = matcher.templates.get(code);
  const ham = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] !== b[i] ? 1 : 0; return d; };
  const pB = hashCardRGBA(probe.rgba, probe.w, probe.h);
  const pC = hashCardColor(probe.rgba, probe.w, probe.h);
  const pE = hashCardEdge(probe.rgba, probe.w, probe.h);
  return 0.5 * ham(pB, t.brightness) + 0.3 * ham(pC, t.color) + 0.2 * ham(pE, t.edge);
}
let suitOK = 0; const suitFlags = [];
for (const code of CODES) {
  const probe = crops[code];
  const ranked = CODES.map((c) => ({ c, d: combinedDistTo(probe, c) })).sort((a, b) => a.d - b.d);
  const self = ranked.find((r) => r.c === code);
  const nn = ranked[0];
  const sameRank = ranked.filter((r) => r.c[0] === code[0] && r.c !== code)[0]; // nearest sibling suit
  const margin = sameRank.d - self.d;          // how far the nearest wrong-suit sibling sits behind self
  if (nn.c === code) suitOK++;
  // flag if a same-rank sibling is rank-1 (suit collision) or margin razor-thin
  if (nn.c !== code || margin <= 0) suitFlags.push({ code, nn: nn.c, sibling: sameRank.c, margin: +margin.toFixed(1) });
}
console.log(`SUIT SUB-CHECK: ${suitOK}/52 nearest-neighbour is self` +
  (suitFlags.length ? `  SUIT COLLISIONS: ${JSON.stringify(suitFlags)}` : '  ✓ (no same-suit-rank collisions)'));
// also surface the 5 tightest same-rank-sibling margins (closest calls)
const margins = CODES.map((code) => {
  const probe = crops[code];
  const self = combinedDistTo(probe, code);
  const sib = Math.min(...CODES.filter((c) => c[0] === code[0] && c !== code).map((c) => combinedDistTo(probe, c)));
  return { code, margin: +(sib - self).toFixed(1) };
}).sort((a, b) => a.margin - b.margin);
console.log('  tightest same-rank-sibling margins (suit safety):', JSON.stringify(margins.slice(0, 6)));

// ── 3. OVERLAP VALIDATION — read REAR (occluded) hero cards ────────────────
const hero = JSON.parse(fs.readFileSync(HERO_JSON));
const HCAP = hero.capture_dir;
let rearPass = 0, frontPass = 0, n = 0; const rearFails = [];
for (const hand of hero.hands) {
  const cs = hand.cards;
  if (cs.length !== 2) continue;
  const ri = cs[0].bbox[2] < cs[1].bbox[2] ? 0 : 1, fi = 1 - ri;
  const rear = cs[ri], front = cs[fi];
  const png = PNG.sync.read(fs.readFileSync(path.join(HCAP, hand.frame)));
  // REAR: exposed strip = its 55px bbox, anchored at measured card top
  const [rx, ry, rw, rh] = rear.bbox;
  const rTop = heroCardTop(png, rx, ry, rw, rh);
  const rStrip = cropFrom(png, rx, rTop, 55, 130);
  const rRes = matcher.match(rStrip.rgba, rStrip.w, rStrip.h);
  const rCode = norm(rear.card), ok = rRes && rRes.card === rCode;
  if (ok) rearPass++; else rearFails.push({ frame: hand.frame, truth: rCode, got: rRes && rRes.card, conf: rRes && +rRes.confidence.toFixed(3) });
  // FRONT (fully visible): left 55px strip of the top card
  const [fx, fy, fw, fh] = front.bbox;
  const fTop = heroCardTop(png, fx, fy, 55, fh);
  const fStrip = cropFrom(png, fx, fTop, 55, 130);
  const fRes = matcher.match(fStrip.rgba, fStrip.w, fStrip.h);
  if (fRes && fRes.card === norm(front.card)) frontPass++;
  n++;
}
console.log(`\nOVERLAP VALIDATION over ${n} hero frames:`);
console.log(`  REAR  (occluded) read correctly: ${rearPass}/${n}` + (rearFails.length ? '' : '  ✓'));
console.log(`  FRONT (visible)  read correctly: ${frontPass}/${n}`);
if (rearFails.length) console.log('  REAR failures:', JSON.stringify(rearFails, null, 1));
