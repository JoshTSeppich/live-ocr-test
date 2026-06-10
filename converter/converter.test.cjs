// converter/converter.test.cjs — orchestrator policy, driven end-to-end through
// onFrame with synthetic-but-complete crops (taught digit alphabet + card
// templates). Proves: settle→assemble→send on hero's turn; withhold when
// unsettled; hero bet from STACK DELTA (not BC OCR); escalate on the poll floor.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');
const Reg = require('./regions.js');
const { SettleDebouncer } = require('./settle.js');
const { HandLifecycle } = require('./handBoundary.js');
const { ActionHistory } = require('./history.js');
const { Escalator } = require('./escalate.js');
const { Converter } = require('./converter.js');

// ── synthetic pixel helpers ─────────────────────────────────────────────────
function crop(w, h, fill) {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { rgba[p * 4] = fill[0]; rgba[p * 4 + 1] = fill[1]; rgba[p * 4 + 2] = fill[2]; rgba[p * 4 + 3] = 255; }
  return { rgba, w, h };
}
function setPx(c, x, y, col) { const i = (y * c.w + x) * 4; c.rgba[i] = col[0]; c.rgba[i + 1] = col[1]; c.rgba[i + 2] = col[2]; }
function scatter(c, col, frac) { const n = c.w * c.h, step = Math.max(1, Math.floor(1 / frac)); for (let p = 0; p < n; p += step) { const i = p * 4; c.rgba[i] = col[0]; c.rgba[i + 1] = col[1]; c.rgba[i + 2] = col[2]; } }
function disc(c, cx, cy, r, col) { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < c.w && y < c.h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(c, x, y, col); }
function rect(c, x0, y0, w, h, col) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(c, x, y, col); }
const DARK = [45, 45, 45], WHITE = [230, 230, 230], GREEN = [89, 188, 93], YELLOW = [202, 158, 64], RED = [220, 45, 45];

// a clean stack/bet/pot COLOR plate (passes the occlusion gate as 'read')
function plate() { const c = crop(60, 24, DARK); scatter(c, WHITE, 0.05); return c; }

// digit glyph alphabet: distinct binarized pattern per char; teach + render strips
function glyph(ch) { const w = 10, h = 20, c = crop(w, h, [255, 255, 255]); const seed = ch.charCodeAt(0); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x * 7 + y * 13 + seed) % 11) < 5) setPx(c, x, y, [0, 0, 0]); return c; }
function teachDigits(dm) { for (const ch of '0123456789.') dm.teach(ch, glyph(ch).rgba, 10, 20); }
function strip(value) { // binarized strip of `value` chars with light gaps
  const G = 4, CW = 10, H = 22, chars = [...String(value)], W = G + chars.length * (CW + G), s = crop(W, H, [255, 255, 255]);
  chars.forEach((ch, i) => { const g = glyph(ch); const x0 = G + i * (CW + G); for (let y = 0; y < 20; y++) for (let x = 0; x < CW; x++) { const si = (y * 10 + x) * 4; if (g.rgba[si] === 0) setPx(s, x0 + x, y + 1, [0, 0, 0]); } });
  return s;
}
// card crop: a UNIQUE bright horizontal band per code (band height = its index),
// so cards are maximally separable and empty felt (no band) is far from all.
const CODE_INDEX = { '8h': 0, 'Jd': 1, '2d': 2, 'As': 3, 'Kd': 4 };
function cardCrop(code) {
  const c = crop(40, 60, DARK); const i = CODE_INDEX[code]; // ~50% fill, very distinct from empty felt
  if (i === 0) rect(c, 0, 0, 40, 30, WHITE);
  else if (i === 1) rect(c, 0, 30, 40, 30, WHITE);
  else if (i === 2) rect(c, 0, 0, 20, 60, WHITE);
  else if (i === 3) rect(c, 20, 0, 20, 60, WHITE);
  else for (let y = 0; y < 60; y++) for (let x = 0; x < 40; x++) if (((x >> 3) + (y >> 3)) % 2 === 0) setPx(c, x, y, WHITE);
  return c;
}
function teachCards(cm, codes) { for (const code of codes) cm.teach(code, cardCrop(code).rgba, 40, 60); }
function rowOf(codes, total) { const W = 40 * total, c = crop(W, 60, DARK); codes.forEach((code, i) => { const cc = cardCrop(code); for (let y = 0; y < 60; y++) for (let x = 0; x < 40; x++) { const si = (y * 40 + x) * 4; setPx(c, i * 40 + x, y, [cc.rgba[si], cc.rgba[si + 1], cc.rgba[si + 2]]); } }); return c; }

// Build getCrops for a scenario. stacks: {seat:bbValue}, betTR, pot, board[], hole[], button, timerFrac, heroTurn.
function scene(sc) {
  return (id) => {
    const C = (color, bin) => ({ color, binarized: bin || strip(0) });
    if (id.startsWith('stack_')) { const seat = id.slice(6); return sc.stacks[seat] != null ? C(plate(), strip(sc.stacks[seat])) : null; }
    if (id === 'bet_TR') return sc.betTR != null ? C(plate(), strip(sc.betTR)) : null;
    if (id.startsWith('bet_')) return null; // no bet badge → no-read → 0
    if (id === 'pot') return C(plate(), strip(sc.pot));
    if (id === 'button_scan') { const c = crop(Reg.BUTTON_SCAN_RECT.w, Reg.BUTTON_SCAN_RECT.h, DARK); const s = Reg.BUTTON_SLOTS[sc.button]; disc(c, s.x - Reg.BUTTON_SCAN_RECT.x, s.y - Reg.BUTTON_SCAN_RECT.y, 16, YELLOW); return C(c); }
    if (id === 'timer') return C(crop(420, 13, sc.timerFrac >= 0.99 ? GREEN : DARK)); // simple full/empty
    if (id === 'action_panel') { const c = crop(120, 60, DARK); if (sc.heroTurn) rect(c, 10, 10, 60, 30, RED); return C(c); }
    if (id === 'board') return C(rowOf(sc.board, 5));
    if (id === 'hero_hole') return C(rowOf(sc.hole, 2));
    return null;
  };
}

function makeConverter(extra) {
  const dm = new E.DigitMatcher('cv:d'); dm.clear(); teachDigits(dm);
  const cm = new E.MultiSignatureMatcher('cv:c'); teachCards(cm, ['8h', 'Jd', '2d', 'As', 'Kd']);
  const debouncer = new SettleDebouncer({ n: 2, settleN: 2 });
  const history = new ActionHistory();
  const lifecycle = new HandLifecycle({ debouncer, history });
  const sent = [];
  const botLink = { send: (req) => { sent.push(req); return sent.length; }, onAdvice: null };
  const escalator = new Escalator(Object.assign({ maxPolls: 3 }, extra && extra.esc));
  const cv = new Converter({ debouncer, lifecycle, history, botLink, escalator, digitMatcher: dm, cardMatcher: cm });
  return { cv, sent, botLink };
}

const baseScene = { stacks: { TL: 100, TC: 100, TR: 100, BR: 100, BC: 50, BL: 100 }, betTR: 3, pot: 5, board: ['8h', 'Jd', '2d'], hole: ['As', 'Kd'], button: 'TC', timerFrac: 1, heroTurn: true };

test('settles then sends one assembled request on hero turn', () => {
  const { cv, sent } = makeConverter();
  const g = scene(baseScene);
  let r = cv.onFrame(g, { videoW: 2940, videoH: 1846 });
  assert.strictEqual(r.sent, false, 'first frame not yet settled');
  r = cv.onFrame(g, { videoW: 2940, videoH: 1846 });
  assert.strictEqual(r.sent, true, 'second identical frame settles → send');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].table_size, 6);
  assert.deepStrictEqual(sent[0].board, ['8h', 'Jd', '2d']);
  assert.deepStrictEqual(sent[0].hero_hole, ['As', 'Kd']);
});

test('does not re-send within the same turn', () => {
  const { cv, sent } = makeConverter();
  const g = scene(baseScene);
  cv.onFrame(g, {}); cv.onFrame(g, {}); cv.onFrame(g, {});
  assert.strictEqual(sent.length, 1, 'one send per turn');
});

test('not hero turn → no send, idle', () => {
  const { cv, sent } = makeConverter();
  const g = scene(Object.assign({}, baseScene, { heroTurn: false }));
  const r1 = cv.onFrame(g, {}); const r2 = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(r2.state, 'idle');
});

test('hero bet from stack delta + posted blind, never BC OCR (§0.10)', () => {
  // Preflop, button=TR → SB=BR, BB=BC(hero). Hero stack shows post-blind value.
  // heroBet = (street-start − current = 0) + the 1bb blind hero posted = 100 chips,
  // derived from the hero STACK + seat mapping — never from the BC bet badge.
  const { cv, sent } = makeConverter();
  const sc = Object.assign({}, baseScene, { board: [], button: 'TR', betTR: null });
  const g = scene(sc);
  cv.onFrame(g, {}); cv.onFrame(g, {});
  const q = sent[sent.length - 1];
  assert.ok(q, 'a request was sent');
  assert.strictEqual(q.current_bets[q.hero_seat], 100, 'hero (BB) committed the 1bb blind, derived not OCR');
});

// ── hero-bet ground-truth cross-check (§0.10) ───────────────────────────────
const RD = (v) => ({ value: v, status: 'read', confirmed: true, stable: true });
const NRstable = { value: null, status: 'no-read', confirmed: false, stable: true };
const OCCl = { value: null, status: 'occluded', confirmed: false, stable: true };

test('hero-bet cross-check: stack-delta agrees with the bet badge → no warning', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = 2.3;
  assert.strictEqual(cv._heroBetCrossCheck({ heroBetObserved: RD(2.3) }), null);
});

test('hero-bet cross-check: drift (the 2.30→12.30 trap) → loud warning', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = 2.3;
  const w = cv._heroBetCrossCheck({ heroBetObserved: RD(12.3) });
  assert.match(w, /HERO-BET DRIFT/);
  assert.match(w, /stack-delta=2.30bb vs bet-badge=12.30bb/);
});

test('hero-bet cross-check: settled-empty badge reads as 0 (agrees when heroBet 0)', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = 0;
  assert.strictEqual(cv._heroBetCrossCheck({ heroBetObserved: NRstable }), null);
});

test('hero-bet cross-check: empty badge but nonzero stack-delta → warning', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = 3;
  assert.match(cv._heroBetCrossCheck({ heroBetObserved: NRstable }), /HERO-BET DRIFT/);
});

test('hero-bet cross-check: inconclusive (occluded/unconfirmed badge) → no warning', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = 2.3;
  assert.strictEqual(cv._heroBetCrossCheck({ heroBetObserved: OCCl }), null);
  assert.strictEqual(cv._heroBetCrossCheck({ heroBetObserved: { value: 9, status: 'read', confirmed: false, stable: false } }), null);
});

test('hero-bet cross-check: no heroBet yet → no warning', () => {
  const { cv } = makeConverter();
  cv._heroBetBB = null;
  assert.strictEqual(cv._heroBetCrossCheck({ heroBetObserved: RD(5) }), null);
});

test('escalates on the poll-counter floor when stuck withholding on hero turn', () => {
  const { cv } = makeConverter({ esc: { maxPolls: 3 } });
  // hero turn but board never resolves (mid-deal counts) → never assembles
  const bad = scene(Object.assign({}, baseScene, { board: ['8h', 'Jd'] })); // 2 cards = invalid count
  let r;
  for (let i = 0; i < 4; i++) r = cv.onFrame(bad, {});
  assert.strictEqual(r.state, 'escalate');
  assert.strictEqual(r.escalateReason, 'poll-floor');
});
