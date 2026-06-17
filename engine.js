// engine.js — eyes-and-utilities library for the live-OCR digital twin.
// The decision-engine layer was removed. This module now exposes only the
// pieces the observation tool needs: a fast 7-card hand evaluator (for the
// twin's descriptive made-hand label), perceptual-hash card template matching
// (CardTemplateMatcher, MultiSignatureMatcher), hand-history persistence,
// and card-code normalization + template export/import helpers.
//
// Public surface (window.PokerEngine in browser, module.exports in Node):
//   parseCard / parseCards / cardToString
//   evaluate7(cards7)            // hand rank, higher = better
//   canonicalize(twoCards)       // -> 'AKs' | 'AKo' | 'TT'
//   MultiSignatureMatcher  CardTemplateMatcher
//   DigitMatcher (closed numeric/symbol set; 8×12 grid; recognizeNumeric)
//   HandHistoryRecorder
//   normalizeCard / parseCardList / regionIdForCardCount
//   serializeTemplates / deserializeTemplates

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {

// ─── card encoding ──────────────────────────────────────────────────────────
// Card = rank*4 + suit; rank 0=deuce..12=ace; suit 0=c,1=d,2=h,3=s.
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

function parseCard(s) {
  const r = RANKS.indexOf(s[0]);
  const u = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || u < 0) throw new Error('bad card: ' + s);
  return r * 4 + u;
}
function parseCards(arr) { return arr.map(parseCard); }
function cardToString(c) { return RANKS[c >> 2] + SUITS[c & 3]; }

// ─── 7-card hand evaluator ──────────────────────────────────────────────────
// Returns a number; higher = better. Categories packed in the top bits.
// Aimed at ~50 µs/eval in V8 — fast enough for Monte Carlo at 1k iters.
const CAT_HC = 0, CAT_PAIR = 1, CAT_2P = 2, CAT_TRIPS = 3, CAT_STRAIGHT = 4,
      CAT_FLUSH = 5, CAT_FULL = 6, CAT_QUADS = 7, CAT_SF = 8;

function straightHigh(mask) {
  // Wheel A-2-3-4-5 first (ace = bit 12)
  if ((mask & ((1 << 12) | 0b1111)) === ((1 << 12) | 0b1111)) return 3; // 5-high
  for (let high = 12; high >= 4; high--) {
    const need = 0b11111 << (high - 4);
    if ((mask & need) === need) return high;
  }
  return -1;
}

function evaluate7(cards) {
  const rc = [0,0,0,0,0,0,0,0,0,0,0,0,0];
  const sc = [0,0,0,0];
  const sm = [0,0,0,0];
  let rm = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], r = c >> 2, s = c & 3;
    rc[r]++; sc[s]++; sm[s] |= 1 << r; rm |= 1 << r;
  }

  // Straight flush
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) { flushSuit = s; break; }
  if (flushSuit >= 0) {
    const sfh = straightHigh(sm[flushSuit]);
    if (sfh >= 0) return (CAT_SF << 20) | sfh;
  }

  // Build ordered (rank desc within count desc) list
  const counts = [];
  for (let r = 12; r >= 0; r--) if (rc[r]) counts.push([r, rc[r]]);
  counts.sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  // Quads
  if (counts[0][1] === 4) {
    let kick = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i][0] > kick) kick = counts[i][0];
    return (CAT_QUADS << 20) | (counts[0][0] << 4) | kick;
  }

  // Full house (trips + any pair/trips)
  if (counts[0][1] === 3 && counts.length >= 2 && counts[1][1] >= 2) {
    return (CAT_FULL << 20) | (counts[0][0] << 4) | counts[1][0];
  }

  // Flush
  if (flushSuit >= 0) {
    let pack = 0, n = 0;
    for (let r = 12; r >= 0 && n < 5; r--) if (sm[flushSuit] & (1 << r)) { pack = (pack << 4) | r; n++; }
    return (CAT_FLUSH << 20) | pack;
  }

  // Straight
  const sh = straightHigh(rm);
  if (sh >= 0) return (CAT_STRAIGHT << 20) | sh;

  // Trips + two kickers
  if (counts[0][1] === 3) {
    const ks = [];
    for (let i = 1; i < counts.length && ks.length < 2; i++) ks.push(counts[i][0]);
    return (CAT_TRIPS << 20) | (counts[0][0] << 8) | (ks[0] << 4) | (ks[1] || 0);
  }

  // Two pair + kicker
  if (counts[0][1] === 2 && counts.length >= 2 && counts[1][1] === 2) {
    let kick = 0;
    for (let i = 2; i < counts.length; i++) if (counts[i][0] > kick) kick = counts[i][0];
    return (CAT_2P << 20) | (counts[0][0] << 8) | (counts[1][0] << 4) | kick;
  }

  // One pair + three kickers
  if (counts[0][1] === 2) {
    const ks = [];
    for (let i = 1; i < counts.length && ks.length < 3; i++) ks.push(counts[i][0]);
    return (CAT_PAIR << 20) | (counts[0][0] << 12) | (ks[0] << 8) | (ks[1] << 4) | ks[2];
  }

  // High card — top 5 ranks
  let pack = 0, n = 0;
  for (let r = 12; r >= 0 && n < 5; r--) if (rc[r]) { pack = (pack << 4) | r; n++; }
  return (CAT_HC << 20) | pack;
}

// ─── hand canonicalisation ─────────────────────────────────────────────────
function canonicalize(twoCards) {
  // twoCards: ['Ah','Kd'] OR [int, int]
  const a = typeof twoCards[0] === 'string' ? parseCard(twoCards[0]) : twoCards[0];
  const b = typeof twoCards[1] === 'string' ? parseCard(twoCards[1]) : twoCards[1];
  const r1 = a >> 2, r2 = b >> 2;
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const suited = (a & 3) === (b & 3);
  if (hi === lo) return RANKS[hi] + RANKS[hi];
  return RANKS[hi] + RANKS[lo] + (suited ? 's' : 'o');
}

function popcount(n) { let c = 0; while (n) { n &= n - 1; c++; } return c; }

// ─── card template matcher ─────────────────────────────────────────────────
// Perceptual-hash based identifier for visual cards. The matcher is taught
// by the OCR pipeline: when the CHAT confidently parses "Your cards X Y",
// the my_Hand region's pixels at that moment are captured + labelled as X
// and Y. Subsequent passes match new captures by Hamming distance.
//
// Hash: downsample the card image to a 16x24 grid; per cell, compute mean
// brightness (HSV V channel — same as our binarization pipeline so red ink
// is preserved); threshold at the image's overall mean → 1-bit per cell.
// Two cards with the same rank + suit produce the same hash up to small noise.

const TPL_W = 16;
const TPL_H = 24;
const TPL_BITS = TPL_W * TPL_H;

function hashCardRGBA(rgba, w, h) {
  const vals = new Float32Array(TPL_BITS);
  let sum = 0;
  for (let ty = 0; ty < TPL_H; ty++) {
    for (let tx = 0; tx < TPL_W; tx++) {
      const sx0 = Math.floor(tx * w / TPL_W);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / TPL_W));
      const sy0 = Math.floor(ty * h / TPL_H);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / TPL_H));
      let s = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * w + x) * 4;
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          s += (r > g ? (r > b ? r : b) : (g > b ? g : b)); // max(r,g,b) — V channel
          n++;
        }
      }
      const v = n ? s / n : 0;
      vals[ty * TPL_W + tx] = v;
      sum += v;
    }
  }
  const mean = sum / TPL_BITS;
  const out = new Uint8Array(TPL_BITS);
  for (let i = 0; i < TPL_BITS; i++) out[i] = vals[i] > mean ? 1 : 0;
  return out;
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

class CardTemplateMatcher {
  constructor(storageKey) {
    this.key = storageKey || 'card-templates';
    this.templates = new Map(); // 'As' -> Uint8Array(TPL_BITS)
    this._load();
  }
  _load() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length === TPL_BITS) {
          this.templates.set(k, new Uint8Array(v));
        }
      }
    } catch (_) {}
  }
  _save() {
    if (typeof localStorage === 'undefined') return;
    const obj = {};
    for (const [k, v] of this.templates) obj[k] = Array.from(v);
    try { localStorage.setItem(this.key, JSON.stringify(obj)); } catch (_) {}
  }
  teach(card, hash) {
    if (!card || !hash || hash.length !== TPL_BITS) return false;
    this.templates.set(card, hash);
    this._save();
    return true;
  }
  match(hash) {
    if (!hash) return null;
    let best = null, bestDist = Infinity;
    for (const [card, t] of this.templates) {
      const d = hammingDistance(hash, t);
      if (d < bestDist) { bestDist = d; best = card; }
    }
    if (best == null) return null;
    return { card: best, distance: bestDist, confidence: 1 - bestDist / TPL_BITS };
  }
  matchAll(hash, topN) {
    topN = topN || 3;
    const out = [];
    for (const [card, t] of this.templates) {
      out.push({ card, distance: hammingDistance(hash, t) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, topN).map((x) => ({ ...x, confidence: 1 - x.distance / TPL_BITS }));
  }
  clear() { this.templates.clear(); this._save(); }
  forget(card) { this.templates.delete(card); this._save(); }
  get size() { return this.templates.size; }
  list() { return [...this.templates.keys()].sort(); }
}

// ─── additional perceptual hashes ─────────────────────────────────────────
// Brightness hash (default) captures broad luminance pattern. Two more
// orthogonal signatures let us combine into a more discriminating match.

// hashCardEdge — per-cell mean gradient magnitude, mean-thresholded to 1 bit.
// Two cards with similar brightness but different edge structure (e.g., "A"
// vs "4" at the same scale) will diverge here.
function hashCardEdge(rgba, w, h) {
  const cells = new Float32Array(TPL_BITS);
  for (let ty = 0; ty < TPL_H; ty++) {
    for (let tx = 0; tx < TPL_W; tx++) {
      const sx0 = Math.floor(tx * w / TPL_W);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / TPL_W));
      const sy0 = Math.floor(ty * h / TPL_H);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / TPL_H));
      let sum = 0, n = 0;
      for (let y = sy0; y < sy1 - 1; y++) {
        for (let x = sx0; x < sx1 - 1; x++) {
          const i = (y * w + x) * 4;
          const iR = (y * w + (x + 1)) * 4;
          const iD = ((y + 1) * w + x) * 4;
          const lum = rgba[i] > rgba[i+1] ? (rgba[i] > rgba[i+2] ? rgba[i] : rgba[i+2]) : (rgba[i+1] > rgba[i+2] ? rgba[i+1] : rgba[i+2]);
          const lR  = rgba[iR] > rgba[iR+1] ? (rgba[iR] > rgba[iR+2] ? rgba[iR] : rgba[iR+2]) : (rgba[iR+1] > rgba[iR+2] ? rgba[iR+1] : rgba[iR+2]);
          const lD  = rgba[iD] > rgba[iD+1] ? (rgba[iD] > rgba[iD+2] ? rgba[iD] : rgba[iD+2]) : (rgba[iD+1] > rgba[iD+2] ? rgba[iD+1] : rgba[iD+2]);
          sum += Math.abs(lum - lR) + Math.abs(lum - lD);
          n++;
        }
      }
      cells[ty * TPL_W + tx] = n ? sum / n : 0;
    }
  }
  let total = 0;
  for (let i = 0; i < TPL_BITS; i++) total += cells[i];
  const mean = total / TPL_BITS;
  const out = new Uint8Array(TPL_BITS);
  for (let i = 0; i < TPL_BITS; i++) out[i] = cells[i] > mean ? 1 : 0;
  return out;
}

// hashCardColor — per-cell, 1 if red-dominant else 0. Discriminates ♥♦ vs ♠♣
// pixel-by-pixel; works directly with rendered card art.
function hashCardColor(rgba, w, h) {
  const out = new Uint8Array(TPL_BITS);
  for (let ty = 0; ty < TPL_H; ty++) {
    for (let tx = 0; tx < TPL_W; tx++) {
      const sx0 = Math.floor(tx * w / TPL_W);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / TPL_W));
      const sy0 = Math.floor(ty * h / TPL_H);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / TPL_H));
      let red = 0, light = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * w + x) * 4;
          const r = rgba[i], g = rgba[i+1], b = rgba[i+2];
          if (r > 130 && g < 110 && b < 110) red++;
          else if (r > 160 && g > 160 && b > 160) light++;
        }
      }
      out[ty * TPL_W + tx] = red > light ? 1 : 0;
    }
  }
  return out;
}

// ─── suit-pip shape classifier (Component 4) ──────────────────────────────
// The 16×24 card hash under-resolves the tiny corner suit pip, so same-color
// pairs confuse (♥↔♦, ♠↔♣ — color/brightness/edge hashes are near-identical;
// only the pip shape differs). Silhouette template overlap CANNOT separate the
// pip at this scale (a normalized club and spade overlap ~0.9), so this reads
// it by SHAPE FEATURES, mirroring poker-vision-analysis card_reader's hero
// corner-pip method. Calibrated against every clean card instance in the
// capture corpus (board + occluded hero rears + fronts, 704 instances):
//   ♥ vs ♦  — top-band width of the pip bbox: heart's two lobes span the full
//             width (≥0.89 measured), a diamond tapers to a point (≤0.30).
//   ♣ vs ♠  — max horizontal ink-segments across the mid band: a club's three
//             lobes give 3 runs, a spade is solid (1 run).
// It NEVER guesses confidently: outside the measured-safe bands it ABSTAINS
// (suit:null), so a same-color read is either correct or an explicit 2-way.
//
// PIP-CROP GEOMETRY CONTRACT — the rgba,w,h the caller must feed is the card's
// left-corner strip, anchored at the card's white top-left corner, same
// proportions the templates use (≈55w × 130h). The pip sits in the lower band;
// this reads rows [PIP_Y0_FRAC·h .. h] across the full width. See
// docs/PIP_CROP_GEOMETRY.md for the exact rows/cols/anchor the live region
// must satisfy.
const PIP_Y0_FRAC = 0.569;        // pip band start (= 74/130 of the strip height)
const PIP_TOPBAND = 0.22;         // top fraction of the pip bbox measured for ♥/♦
const PIP_HEART_MIN = 0.75;       // top-width ≥ → heart   (corpus hearts ≥ 0.89)
const PIP_DIAMOND_MAX = 0.45;     // top-width ≤ → diamond (corpus diamonds ≤ 0.30)
const PIP_MID0 = 0.30, PIP_MID1 = 0.70; // mid band for the ♣/♠ run count
const PIP_CLUB_MINRUNS = 3;       // ≥ → club (3 lobes); == 1 → spade; else abstain
const PIP_MIN_INK = 15;           // fewer ink px than this → no pip → abstain

// Connected-component-clean the pip ink in the lower strip band, returning the
// bbox-cropped binary mask of just the pip: drop blobs touching the band's top
// edge (the rank glyph's bottom bleeds in there) and blobs < 18% of the largest
// survivor (anti-alias specks), then crop to the surviving ink's bounding box.
function _pipMask(rgba, w, h, color) {
  const y0 = Math.floor(PIP_Y0_FRAC * h), bw = w, bh = h - y0;
  if (bh < 8 || bw < 4) return null;
  const ink = new Uint8Array(bw * bh);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const i = ((y0 + yy) * w + xx) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      let on;
      if (color === 'red') on = (r - (g + b) / 2 > 38) && (r > 110);
      else { const lum = (r + g + b) / 3; on = lum < 140 && Math.abs(r - g) < 28 && Math.abs(g - b) < 32; }
      if (on) ink[yy * bw + xx] = 1;
    }
  }
  // 4-connected labelling (iterative flood fill)
  const lab = new Int32Array(bw * bh);
  const comps = []; // {size, touchesTop}
  const stack = [];
  for (let p = 0; p < bw * bh; p++) {
    if (!ink[p] || lab[p]) continue;
    const id = comps.length + 1;
    let size = 0, touchesTop = false;
    stack.push(p); lab[p] = id;
    while (stack.length) {
      const q = stack.pop(); size++;
      const qy = (q / bw) | 0, qx = q - qy * bw;
      if (qy === 0) touchesTop = true;
      if (qx > 0 && ink[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack.push(q - 1); }
      if (qx < bw - 1 && ink[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack.push(q + 1); }
      if (qy > 0 && ink[q - bw] && !lab[q - bw]) { lab[q - bw] = id; stack.push(q - bw); }
      if (qy < bh - 1 && ink[q + bw] && !lab[q + bw]) { lab[q + bw] = id; stack.push(q + bw); }
    }
    comps.push({ size, touchesTop });
  }
  let maxSurv = 0;
  for (let c = 0; c < comps.length; c++) if (!comps[c].touchesTop && comps[c].size > maxSurv) maxSurv = comps[c].size;
  if (maxSurv < PIP_MIN_INK) return null;
  // keep mask, bbox
  let x0 = bw, x1 = -1, y0b = bh, y1b = -1, count = 0;
  const keep = new Uint8Array(bw * bh);
  for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
    const id = lab[yy * bw + xx];
    if (!id) continue;
    const c = comps[id - 1];
    if (c.touchesTop || c.size <= 0.18 * maxSurv) continue;
    keep[yy * bw + xx] = 1; count++;
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0b) y0b = yy; if (yy > y1b) y1b = yy;
  }
  if (count < PIP_MIN_INK || x1 < x0 || y1b < y0b) return null;
  const mw = x1 - x0 + 1, mh = y1b - y0b + 1;
  const mask = new Uint8Array(mw * mh);
  for (let yy = 0; yy < mh; yy++) for (let xx = 0; xx < mw; xx++) mask[yy * mw + xx] = keep[(y0b + yy) * bw + (x0 + xx)];
  return { mask, mw, mh };
}

// Classify a card's suit from its corner pip, constrained to the two suits of
// the (already-reliable) ink color. Returns {suit, margin} or {suit:null} to
// ABSTAIN. margin is the normalized distance past the decision band (a 2-way
// "♥ or ♦" output, never a confident wrong suit).
function readSuitFromPip(rgba, w, h, color) {
  const pm = _pipMask(rgba, w, h, color);
  if (!pm) return { suit: null, margin: 0 };
  const { mask, mw, mh } = pm;
  if (color === 'red') {
    const tb = Math.max(1, Math.floor(PIP_TOPBAND * mh));
    let cols = 0;
    for (let xx = 0; xx < mw; xx++) {
      let any = 0;
      for (let yy = 0; yy < tb; yy++) if (mask[yy * mw + xx]) { any = 1; break; }
      cols += any;
    }
    const topw = cols / mw;
    if (topw >= PIP_HEART_MIN) return { suit: 'h', margin: topw - PIP_HEART_MIN };
    if (topw <= PIP_DIAMOND_MAX) return { suit: 'd', margin: PIP_DIAMOND_MAX - topw };
    return { suit: null, margin: 0 };
  }
  // black: max contiguous ink runs across the mid band (club lobes → 3, spade → 1)
  const m0 = Math.floor(PIP_MID0 * mh), m1 = Math.max(m0 + 1, Math.floor(PIP_MID1 * mh));
  let maxRuns = 0;
  for (let yy = m0; yy < m1; yy++) {
    let runs = 0, prev = 0;
    for (let xx = 0; xx < mw; xx++) { const v = mask[yy * mw + xx]; if (v && !prev) runs++; prev = v; }
    if (runs > maxRuns) maxRuns = runs;
  }
  if (maxRuns >= PIP_CLUB_MINRUNS) return { suit: 'c', margin: maxRuns - PIP_CLUB_MINRUNS };
  if (maxRuns === 1) return { suit: 's', margin: 1 };
  return { suit: null, margin: 0 };
}

// ─── multi-signature matcher ──────────────────────────────────────────────
// Wraps CardTemplateMatcher's hash storage with three signatures. Match uses
// a weighted Hamming distance: brightness 50%, color 30%, edge 20%. Catches
// confusions that any single hash misses (e.g., A♥ vs A♦ — brightness hash
// near-identical, color hash near-identical, but edge hash differs). The suit
// is then refined by the dedicated pip classifier (Component 4), which abstains
// rather than ever return a confident wrong same-color suit.
class MultiSignatureMatcher {
  constructor(storageKey) {
    this.key = storageKey || 'multi-sig-templates';
    this.templates = new Map(); // 'As' -> {brightness, edge, color}
    this._load();
  }
  _load() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (v && v.brightness && v.edge && v.color) {
          this.templates.set(k, {
            brightness: new Uint8Array(v.brightness),
            edge: new Uint8Array(v.edge),
            color: new Uint8Array(v.color),
          });
        }
      }
    } catch (_) {}
  }
  _save() {
    if (typeof localStorage === 'undefined') return;
    const obj = {};
    for (const [k, v] of this.templates) {
      obj[k] = {
        brightness: Array.from(v.brightness),
        edge: Array.from(v.edge),
        color: Array.from(v.color),
      };
    }
    try { localStorage.setItem(this.key, JSON.stringify(obj)); } catch (_) {}
  }
  teach(card, rgba, w, h) {
    if (!card || !rgba) return false;
    this.templates.set(card, {
      brightness: hashCardRGBA(rgba, w, h),
      edge: hashCardEdge(rgba, w, h),
      color: hashCardColor(rgba, w, h),
    });
    this._save();
    return true;
  }
  match(rgba, w, h) {
    if (this.templates.size === 0) return null;
    const probe = {
      brightness: hashCardRGBA(rgba, w, h),
      edge: hashCardEdge(rgba, w, h),
      color: hashCardColor(rgba, w, h),
    };
    let best = null, bestDist = Infinity;
    for (const [card, sig] of this.templates) {
      const dB = hammingDistance(probe.brightness, sig.brightness);
      const dC = hammingDistance(probe.color,      sig.color);
      const dE = hammingDistance(probe.edge,       sig.edge);
      const combined = 0.5 * dB + 0.3 * dC + 0.2 * dE;
      if (combined < bestDist) { bestDist = combined; best = card; }
    }
    if (!best) return null;
    // Rank + red/black colour from the hash are reliable; the corner pip is what
    // the card hash under-resolves, so refine the suit with Component 4. When it
    // abstains we keep the hash's suit but flag it unconfident with the 2-way
    // alternatives — never a silent confident guess on a same-colour pair.
    const rank = best[0];
    const color = (best[1] === 'h' || best[1] === 'd') ? 'red' : 'black';
    const ps = readSuitFromPip(rgba, w, h, color);
    let card = best, suitConfident = true, suitAlternatives = null;
    if (ps && ps.suit) card = rank + ps.suit;
    else { suitConfident = false; suitAlternatives = color === 'red' ? ['h', 'd'] : ['s', 'c']; }
    return {
      card, distance: bestDist, confidence: 1 - bestDist / TPL_BITS,
      suit: card[1], suitConfident, suitAlternatives, suitMargin: ps ? ps.margin : 0,
    };
  }
  clear() { this.templates.clear(); this._save(); }
  forget(card) { this.templates.delete(card); this._save(); }
  get size() { return this.templates.size; }
  list() { return [...this.templates.keys()].sort(); }
}

// ─── digit matcher (Component 1) ──────────────────────────────────────────
// A second hash-based matcher, specialized for the closed numeric/symbol set
// that fixed-font poker readouts use: digits, decimal/grouping marks, the
// dollar sign, and the BB suffix. It mirrors MultiSignatureMatcher's three-
// signature weighted-Hamming design (MATCHER_SPEC §3) but is tuned for narrow
// glyphs: an 8×12 grid (vs the card matcher's 16×24) and a higher confidence
// bar (≥0.85 vs cards' ≥0.75 — digits are simpler, so we can demand more).
//
// It does NOT replace Tesseract. recognizeNumeric() is a fast pre-Tesseract
// path for numeric fields; on any below-threshold glyph it returns text=null
// and the caller falls back to the 250ms Tesseract loop.

const DIGIT_W = 8;
const DIGIT_H = 12;
const DIGIT_BITS = DIGIT_W * DIGIT_H; // 96
const DIGIT_CONF_THRESHOLD = 0.85;
const DIGIT_SYMBOLS = '0123456789.,$B';

// max(R,G,B) — the HSV "Value" channel — at byte index i. Same channel the
// card hashes use; survives pure-red ink that luminance would drop.
function _maxV(rgba, i) {
  const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
  return r > g ? (r > b ? r : b) : (g > b ? g : b);
}

// Grid-parameterized versions of the three card hashes. The card hash
// functions hardcode TPL_W/TPL_H; these take the grid size so the digit
// matcher can run them at 8×12. The algorithms are identical to
// hashCardRGBA / hashCardEdge / hashCardColor — only the grid differs — so
// digit and card recognition share their proven behavior without the card
// path being touched.
function _gridBrightnessHash(rgba, w, h, gw, gh) {
  const bits = gw * gh;
  const vals = new Float32Array(bits);
  let sum = 0;
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      const sx0 = Math.floor(tx * w / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / gw));
      const sy0 = Math.floor(ty * h / gh);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / gh));
      let s = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          s += _maxV(rgba, (y * w + x) * 4);
          n++;
        }
      }
      const v = n ? s / n : 0;
      vals[ty * gw + tx] = v;
      sum += v;
    }
  }
  const mean = sum / bits;
  const out = new Uint8Array(bits);
  for (let i = 0; i < bits; i++) out[i] = vals[i] > mean ? 1 : 0;
  return out;
}

function _gridEdgeHash(rgba, w, h, gw, gh) {
  const bits = gw * gh;
  const cells = new Float32Array(bits);
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      const sx0 = Math.floor(tx * w / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / gw));
      const sy0 = Math.floor(ty * h / gh);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / gh));
      let acc = 0, n = 0;
      for (let y = sy0; y < sy1 - 1; y++) {
        for (let x = sx0; x < sx1 - 1; x++) {
          const lum = _maxV(rgba, (y * w + x) * 4);
          const lR  = _maxV(rgba, (y * w + (x + 1)) * 4);
          const lD  = _maxV(rgba, ((y + 1) * w + x) * 4);
          acc += Math.abs(lum - lR) + Math.abs(lum - lD);
          n++;
        }
      }
      cells[ty * gw + tx] = n ? acc / n : 0;
    }
  }
  let total = 0;
  for (let i = 0; i < bits; i++) total += cells[i];
  const mean = total / bits;
  const out = new Uint8Array(bits);
  for (let i = 0; i < bits; i++) out[i] = cells[i] > mean ? 1 : 0;
  return out;
}

function _gridColorHash(rgba, w, h, gw, gh) {
  const bits = gw * gh;
  const out = new Uint8Array(bits);
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      const sx0 = Math.floor(tx * w / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * w / gw));
      const sy0 = Math.floor(ty * h / gh);
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * h / gh));
      let red = 0, light = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * w + x) * 4;
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          if (r > 130 && g < 110 && b < 110) red++;
          else if (r > 160 && g > 160 && b > 160) light++;
        }
      }
      out[ty * gw + tx] = red > light ? 1 : 0;
    }
  }
  return out;
}

function hashDigitRGBA(rgba, w, h)  { return _gridBrightnessHash(rgba, w, h, DIGIT_W, DIGIT_H); }
function hashDigitEdge(rgba, w, h)  { return _gridEdgeHash(rgba, w, h, DIGIT_W, DIGIT_H); }
function hashDigitColor(rgba, w, h) { return _gridColorHash(rgba, w, h, DIGIT_W, DIGIT_H); }

// Copy a column band [x0, x1) (full height) of an RGBA buffer into a new,
// tightly-packed RGBA buffer. Used to hand each segmented glyph to match().
function _cropColumns(rgba, w, h, x0, x1) {
  const cw = x1 - x0;
  const out = new Uint8Array(cw * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (y * w + (x0 + x)) * 4;
      const di = (y * cw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

class DigitMatcher {
  constructor(storageKey) {
    this.key = storageKey || 'pp-digit-templates-v1';
    this.threshold = DIGIT_CONF_THRESHOLD;
    this.templates = new Map(); // symbol -> {brightness, edge, color}
    this._load();
  }
  _load() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const entries = parsed && parsed.symbols ? parsed.symbols : parsed;
      for (const [k, v] of Object.entries(entries || {})) {
        if (v && v.brightness && v.edge && v.color) {
          this.templates.set(k, {
            brightness: new Uint8Array(v.brightness),
            edge: new Uint8Array(v.edge),
            color: new Uint8Array(v.color),
          });
        }
      }
    } catch (_) {}
  }
  _save() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this.key, this.serialize()); } catch (_) {}
  }
  teach(symbol, rgba, w, h) {
    if (!symbol || !rgba) return false;
    this.templates.set(symbol, {
      brightness: hashDigitRGBA(rgba, w, h),
      edge: hashDigitEdge(rgba, w, h),
      color: hashDigitColor(rgba, w, h),
    });
    this._save();
    return true;
  }
  match(rgba, w, h) {
    if (this.templates.size === 0) return null;
    const probe = {
      brightness: hashDigitRGBA(rgba, w, h),
      edge: hashDigitEdge(rgba, w, h),
      color: hashDigitColor(rgba, w, h),
    };
    let best = null, bestDist = Infinity;
    for (const [symbol, sig] of this.templates) {
      const dB = hammingDistance(probe.brightness, sig.brightness);
      const dC = hammingDistance(probe.color,      sig.color);
      const dE = hammingDistance(probe.edge,       sig.edge);
      const combined = 0.5 * dB + 0.3 * dC + 0.2 * dE;
      if (combined < bestDist) { bestDist = combined; best = symbol; }
    }
    return best == null ? null
      : { symbol: best, distance: bestDist, confidence: 1 - bestDist / DIGIT_BITS };
  }
  clear() { this.templates.clear(); this._save(); }
  forget(symbol) { this.templates.delete(symbol); this._save(); }
  get size() { return this.templates.size; }
  list() { return [...this.templates.keys()].sort(); }

  // Read a multi-symbol numeric strip. Segments the ROI into glyph columns by
  // vertical dark-pixel projection on the binarized input, then match()es each
  // box. Returns { text, confidence, unmatched, boxes }:
  //   - confidence: the minimum confidence across boxes (0 if none)
  //   - unmatched:  count of boxes below this.threshold (or with no match)
  //   - text:       the concatenated symbols, or null if unmatched > 0 (or no
  //                 box found) — null is the caller's signal to fall back to
  //                 Tesseract.
  // opts: { threshold, inkThreshold, minColInkFrac, minBoxWidth }.
  // Segment a numeric strip into glyph boxes by vertical dark-pixel projection
  // on the binarized input. Returns [{ x0, x1, rgba, w, h }] — each box's pixels
  // cropped out, ready for match() or teach(). Shared by recognizeNumeric (to
  // read) and the teach UI (to label each box against a ground-truth string).
  segment(rgba, w, h, opts) {
    opts = opts || {};
    const inkThreshold = opts.inkThreshold != null ? opts.inkThreshold : 128;
    const minColInkFrac = opts.minColInkFrac != null ? opts.minColInkFrac : 0.04;
    const minBoxWidth = opts.minBoxWidth != null ? opts.minBoxWidth : 2;

    // A column is "ink" when enough of its pixels are dark (V channel below
    // inkThreshold — binarized text is dark on a light field).
    const minInk = Math.max(1, Math.floor(minColInkFrac * h));
    const colInk = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let y = 0; y < h; y++) if (_maxV(rgba, (y * w + x) * 4) < inkThreshold) c++;
      colInk[x] = c;
    }

    // Runs of ink columns are glyph boxes; blank columns are gaps.
    const boxes = [];
    let start = -1;
    const flush = (x0, x1) => {
      if (x1 - x0 < minBoxWidth) return;
      boxes.push({ x0, x1, rgba: _cropColumns(rgba, w, h, x0, x1), w: x1 - x0, h });
    };
    for (let x = 0; x < w; x++) {
      const isInk = colInk[x] >= minInk;
      if (isInk && start < 0) start = x;
      else if (!isInk && start >= 0) { flush(start, x); start = -1; }
    }
    if (start >= 0) flush(start, w);
    return boxes;
  }

  recognizeNumeric(rgba, w, h, opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : this.threshold;
    const segBoxes = this.segment(rgba, w, h, opts);

    const boxes = [];
    let minConf = Infinity, unmatched = 0;
    for (const b of segBoxes) {
      const res = this.match(b.rgba, b.w, b.h);
      const conf = res ? res.confidence : 0;
      const symbol = res && conf >= threshold ? res.symbol : null;
      if (symbol == null) unmatched++;
      if (conf < minConf) minConf = conf;
      boxes.push({ x0: b.x0, x1: b.x1, symbol: res ? res.symbol : null, confidence: conf });
    }

    if (boxes.length === 0) return { text: null, confidence: 0, unmatched: 0, boxes };
    const text = unmatched > 0 ? null : boxes.map((b) => b.symbol).join('');
    return { text, confidence: minConf === Infinity ? 0 : minConf, unmatched, boxes };
  }

  // schema v1: { schema_version, captured_at, grid:[w,h], bits, symbols }.
  // symbols is keyed by symbol; each value has brightness/edge/color as plain
  // number arrays of length DIGIT_BITS (96) containing only 0/1.
  serialize() {
    const symbols = {};
    for (const [k, v] of this.templates) {
      symbols[k] = {
        brightness: Array.from(v.brightness),
        edge: Array.from(v.edge),
        color: Array.from(v.color),
      };
    }
    return JSON.stringify({
      schema_version: 1,
      captured_at: new Date().toISOString(),
      grid: [DIGIT_W, DIGIT_H],
      bits: DIGIT_BITS,
      template_count: this.templates.size,
      symbols,
    });
  }
  // Replace this matcher's templates from a serialized blob (JSON string or the
  // parsed object). Strict: throws on a bad schema, unknown symbol, wrong-length
  // signature, or non-binary value — a corrupt blob is worse than an empty one.
  deserialize(payload) {
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!obj || typeof obj !== 'object') throw new Error('invalid digit template blob');
    if (obj.schema_version !== 1) {
      throw new Error('schema_version must be 1, got ' + obj.schema_version);
    }
    const symbols = obj.symbols;
    if (!symbols || typeof symbols !== 'object') {
      throw new Error('symbols field missing or not an object');
    }
    const next = new Map();
    for (const [sym, v] of Object.entries(symbols)) {
      if (DIGIT_SYMBOLS.indexOf(sym) < 0) throw new Error('unknown digit symbol: ' + sym);
      if (!v || typeof v !== 'object') throw new Error('invalid template at ' + sym + ': not an object');
      for (const field of ['brightness', 'edge', 'color']) {
        const arr = v[field];
        if (!Array.isArray(arr)) throw new Error('invalid template at ' + sym + ': ' + field + ' not array');
        if (arr.length !== DIGIT_BITS) {
          throw new Error('invalid template at ' + sym + ': ' + field + ' length ' + arr.length + ' (expected ' + DIGIT_BITS + ')');
        }
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] !== 0 && arr[i] !== 1) {
            throw new Error('invalid template at ' + sym + ': ' + field + '[' + i + '] = ' + arr[i] + ' (must be 0 or 1)');
          }
        }
      }
      next.set(sym, {
        brightness: new Uint8Array(v.brightness),
        edge: new Uint8Array(v.edge),
        color: new Uint8Array(v.color),
      });
    }
    this.templates = next;
    this._save();
    return { total: next.size };
  }
}

// ─── hand history recorder ────────────────────────────────────────────────
// Captures every parsed hand to localStorage with full event sequence.
// Bounded sliding window (default 200 hands). Queryable by villain.
class HandHistoryRecorder {
  constructor(storageKey, maxHands) {
    this.key = storageKey || 'hand-history';
    this.maxHands = maxHands || 200;
    this.hands = this._load();
    this.current = null;
  }
  _load() {
    if (typeof localStorage === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (_) { return []; }
  }
  _save() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this.key, JSON.stringify(this.hands)); } catch (_) {}
  }
  startHand(meta) {
    this.current = {
      id: (meta && meta.id) || Date.now(),
      startedAt: Date.now(),
      seats: ((meta && meta.seats) || []).slice(),
      heroCards: null,
      board: [],
      events: [],
    };
  }
  recordEvent(ev) {
    if (!this.current || !ev) return;
    this.current.events.push({ t: Date.now() - this.current.startedAt, ...ev });
  }
  setHeroCards(cards) { if (this.current) this.current.heroCards = cards ? cards.slice() : null; }
  setBoard(cards)     { if (this.current) this.current.board     = cards ? cards.slice() : []; }
  endHand() {
    if (!this.current) return;
    this.hands.push(this.current);
    while (this.hands.length > this.maxHands) this.hands.shift();
    this._save();
    this.current = null;
  }
  getRecent(n) { return this.hands.slice(-Math.max(1, n || 1)); }
  getByVillain(name) { return this.hands.filter((h) => h.seats.includes(name)); }
  clear() { this.hands = []; this.current = null; this._save(); }
  get count() { return this.hands.length; }
}

// ─── card-code normalization + template export/import helpers ───────────
// Pure, additive helpers. None of MultiSignatureMatcher's internals are
// touched. Used by the manual-teach UI and engine.test.js roundtrip tests.

const CARD_RE = /^[2-9TJQKA][hdcs]$/;

function normalizeCard(s) {
  if (typeof s !== 'string') throw new Error('invalid card: ' + s);
  const trimmed = s.trim();
  if (trimmed.length !== 2) throw new Error('invalid card: ' + s);
  const norm = trimmed[0].toUpperCase() + trimmed[1].toLowerCase();
  if (!CARD_RE.test(norm)) throw new Error('invalid card: ' + s);
  return norm;
}

function parseCardList(s) {
  if (typeof s !== 'string') throw new Error('invalid input');
  const pieces = s.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const out = [];
  const seen = new Set();
  for (const p of pieces) {
    const card = normalizeCard(p);
    if (seen.has(card)) throw new Error('duplicate card in input: ' + card);
    seen.add(card);
    out.push(card);
  }
  return out;
}

function regionIdForCardCount(n) {
  if (n === 2) return 'my_Hand';
  if (n === 3 || n === 4 || n === 5) return 'the_Board';
  throw new Error('need 2 (hero) or 3-5 (board) cards, got ' + n);
}

// Schema v1: { schema_version, captured_at, template_count, templates }.
// Templates is an object keyed by card code; each value has brightness/edge/
// color as plain number arrays of length TPL_BITS (384) containing only 0/1.
function serializeTemplates(matcher) {
  const templates = {};
  for (const [k, v] of matcher.templates) {
    templates[k] = {
      brightness: Array.from(v.brightness),
      edge: Array.from(v.edge),
      color: Array.from(v.color),
    };
  }
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    template_count: matcher.templates.size,
    templates,
  };
}

function _validateImportedTemplates(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid template file');
  if (payload.schema_version !== 1) {
    throw new Error('schema_version must be 1, got ' + payload.schema_version);
  }
  if (!payload.templates || typeof payload.templates !== 'object') {
    throw new Error('templates field missing or not an object');
  }
  const validated = [];
  for (const [rawKey, v] of Object.entries(payload.templates)) {
    let code;
    try { code = normalizeCard(rawKey); }
    catch (_) { throw new Error('invalid template at ' + rawKey + ': bad card code'); }
    if (!v || typeof v !== 'object') throw new Error('invalid template at ' + code + ': not an object');
    for (const field of ['brightness', 'edge', 'color']) {
      const arr = v[field];
      if (!Array.isArray(arr)) throw new Error('invalid template at ' + code + ': ' + field + ' not array');
      if (arr.length !== TPL_BITS) {
        throw new Error('invalid template at ' + code + ': ' + field + ' length ' + arr.length + ' (expected ' + TPL_BITS + ')');
      }
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== 0 && arr[i] !== 1) {
          throw new Error('invalid template at ' + code + ': ' + field + '[' + i + '] = ' + arr[i] + ' (must be 0 or 1)');
        }
      }
    }
    validated.push({ code, brightness: v.brightness, edge: v.edge, color: v.color });
  }
  return validated;
}

function deserializeTemplates(matcher, payload, strategy) {
  if (strategy !== 'merge' && strategy !== 'replace') {
    throw new Error('strategy must be "merge" or "replace", got ' + strategy);
  }
  const validated = _validateImportedTemplates(payload);
  if (strategy === 'replace') matcher.templates.clear();
  let added = 0, skipped = 0;
  for (const v of validated) {
    if (strategy === 'merge' && matcher.templates.has(v.code)) {
      skipped++;
      continue;
    }
    matcher.templates.set(v.code, {
      brightness: new Uint8Array(v.brightness),
      edge: new Uint8Array(v.edge),
      color: new Uint8Array(v.color),
    });
    added++;
  }
  matcher._save();
  return { added, skipped, total: validated.length };
}

return {
  // Constants
  RANKS, SUITS, CAT_HC, CAT_PAIR, CAT_2P, CAT_TRIPS, CAT_STRAIGHT, CAT_FLUSH, CAT_FULL, CAT_QUADS, CAT_SF,
  // Card utils
  parseCard, parseCards, cardToString,
  // Hand evaluation
  evaluate7, canonicalize,
  // Card template matcher + auxiliary perceptual hashes + multi-sig matcher
  CardTemplateMatcher, hashCardRGBA, hashCardEdge, hashCardColor,
  hammingDistance, TPL_W, TPL_H, TPL_BITS,
  MultiSignatureMatcher,
  // Suit-pip shape classifier (Component 4) — same-colour ♥/♦, ♠/♣ tiebreak
  readSuitFromPip,
  // Digit/symbol matcher + its hashes + grid constants (Component 1)
  DigitMatcher, hashDigitRGBA, hashDigitEdge, hashDigitColor,
  DIGIT_W, DIGIT_H, DIGIT_BITS, DIGIT_CONF_THRESHOLD, DIGIT_SYMBOLS,
  // Card-code helpers + template export/import (additive)
  normalizeCard, parseCardList, regionIdForCardCount,
  serializeTemplates, deserializeTemplates,
  // Hand history
  HandHistoryRecorder,
};
}));
