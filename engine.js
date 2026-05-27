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

// ─── multi-signature matcher ──────────────────────────────────────────────
// Wraps CardTemplateMatcher's hash storage with three signatures. Match uses
// a weighted Hamming distance: brightness 50%, color 30%, edge 20%. Catches
// confusions that any single hash misses (e.g., A♥ vs A♦ — brightness hash
// near-identical, color hash near-identical, but edge hash differs).
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
    return best ? { card: best, distance: bestDist, confidence: 1 - bestDist / TPL_BITS } : null;
  }
  clear() { this.templates.clear(); this._save(); }
  forget(card) { this.templates.delete(card); this._save(); }
  get size() { return this.templates.size; }
  list() { return [...this.templates.keys()].sort(); }
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
  // Card-code helpers + template export/import (additive)
  normalizeCard, parseCardList, regionIdForCardCount,
  serializeTemplates, deserializeTemplates,
  // Hand history
  HandHistoryRecorder,
};
}));
