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

// A real hero turn shows the FULL action panel (Fold + Check/Call + Bet/Raise).
// Turn authority is now this panel text (§3a / P4), not the red pixel alone — so
// every send-path scene must present it. The Fast-Fold pre-button shows "...Any".
const FULL_PANEL = 'Fold  Call 5.60  Raise 11.20'; // a facing-bet (CALL) spot
const CHECK_PANEL = 'Fold  Check  Raise 2.00';      // a check spot (to_call==0)
const FASTFOLD_PANEL = 'Fold  Call Any  Raise Any';

test('settles then sends one assembled request on hero turn', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText(FULL_PANEL);
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
  cv.setPanelText(FULL_PANEL);
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
  cv.setPanelText(CHECK_PANEL); // hero is BB with the option → to_call==0 → CHECK shown
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

// ── check-vs-call cross-check (validates to_call SIGN + ACTION_PANEL_RECT) ───
test('check-vs-call: CALL shown agrees with to_call>0 → no warning', () => {
  const { cv } = makeConverter();
  cv.setPanelText('Fold  Call 2.50  Raise');
  assert.strictEqual(cv._checkVsCall(300), null);
});
test('check-vs-call: CHECK shown agrees with to_call==0 → no warning', () => {
  const { cv } = makeConverter();
  cv.setPanelText('Fold  Check  Bet');
  assert.strictEqual(cv._checkVsCall(0), null);
});
test('check-vs-call: CHECK shown but to_call>0 → mismatch warning (wrong sign)', () => {
  const { cv } = makeConverter();
  cv.setPanelText('Fold  Check  Bet');
  assert.match(cv._checkVsCall(300), /TO_CALL\/BUTTON MISMATCH/);
});
test('check-vs-call: CALL shown but to_call==0 → mismatch warning', () => {
  const { cv } = makeConverter();
  cv.setPanelText('Fold  Call 2.50  Raise');
  assert.match(cv._checkVsCall(0), /TO_CALL\/BUTTON MISMATCH/);
});
test('check-vs-call: tolerant of OCR noise on the button word', () => {
  const { cv } = makeConverter();
  cv.setPanelText('FoId  Cail 2.50  Raise'); // l→i mangling
  assert.strictEqual(cv._checkVsCall(300), null, 'still reads as call');
});
test('check-vs-call: no/garbage panel text → unknown → no warning (inconclusive)', () => {
  const { cv } = makeConverter();
  assert.strictEqual(cv._checkVsCall(300), null);   // never set
  cv.setPanelText('xxxxx');
  assert.strictEqual(cv._checkVsCall(300), null);
  cv.setPanelText('Fold Call Check'); // both present → inconclusive
  assert.strictEqual(cv._checkVsCall(300), null);
});

test('escalates on the poll-counter floor when stuck withholding on hero turn', () => {
  const { cv } = makeConverter({ esc: { maxPolls: 3 } });
  cv.setPanelText(FULL_PANEL); // confirmed hero turn (full action set)…
  // …but the board never resolves (mid-deal counts) → never assembles
  const bad = scene(Object.assign({}, baseScene, { board: ['8h', 'Jd'] })); // 2 cards = invalid count
  let r;
  for (let i = 0; i < 4; i++) r = cv.onFrame(bad, {});
  assert.strictEqual(r.state, 'escalate');
  assert.strictEqual(r.escalateReason, 'poll-floor');
});

// ── C/P4: turn authority = full action set, not "any red" ────────────────────
test('C/P4: Fast-Fold pre-button (red, but "...Any" pre-selectors) is NOT hero turn → no send, idle', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText(FASTFOLD_PANEL);
  const g = scene(baseScene); // heroTurn:true → red pixels present
  let r = cv.onFrame(g, {}); r = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 0, 'a red Fast-Fold pre-button must not fire a send (the ~40% over-count)');
  assert.strictEqual(r.actionSet, 'fastfold');
  assert.strictEqual(r.state, 'idle');
});

test('C/P4: full action set (red + Fold/Call/Raise) → send', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText(FULL_PANEL);
  const g = scene(baseScene);
  cv.onFrame(g, {}); const r = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(r.actionSet, 'full');
});

test('C/P4: unparseable panel during apparent turn → withhold (no send) + escalate', () => {
  const { cv, sent } = makeConverter({ esc: { maxPolls: 3 } });
  cv.setPanelText('R8!se C#ll'); // garbled — neither a full set nor a Fast-Fold
  const g = scene(baseScene);    // clean table read, but the panel can't be read
  let r; for (let i = 0; i < 4; i++) r = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 0, 'never fire advice on an unreadable panel');
  assert.strictEqual(r.actionSet, 'unparseable');
  assert.strictEqual(r.state, 'escalate');
});

test('C/P4: ACTION_PANEL_RECT corrected to the P4-measured bbox', () => {
  assert.deepStrictEqual(
    { x: Reg.ACTION_PANEL_RECT.x, y: Reg.ACTION_PANEL_RECT.y, w: Reg.ACTION_PANEL_RECT.w, h: Reg.ACTION_PANEL_RECT.h },
    { x: 1744, y: 1690, w: 1178, h: 144 });
});

// ── D/3a: button panel is authoritative — withhold on panel↔arithmetic disagreement ──
test('D/3a: CHECK shown but to_call>0 → withhold (no send) + decline (→ wait), not a guessed send', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText('Fold  Check  Bet 5.00'); // full action set, but middle button is CHECK…
  const g = scene(baseScene);               // …while TR has bet 3 → to_call>0 (a CALL spot)
  let r = cv.onFrame(g, {}); r = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 0, 'panel contradicts arithmetic → never guess a send');
  assert.strictEqual(r.actionSet, 'full');
  assert.ok(r.declined && /disagree/.test(r.declined.reason), 'surfaces a decline for the wait map');
});
test('D/3a: panel agrees (CALL shown, to_call>0) → sends normally', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText('Fold  Call 3.00  Raise 6.00');
  const g = scene(baseScene);
  cv.onFrame(g, {}); const r = cv.onFrame(g, {});
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(r.declined, null);
});

// ── D/3c: mark-unstable after hero acts (turn-end forces a fresh settle) ──────
test('D/3c: hero turn ending (hero acted) force-re-settles the gate', () => {
  const { cv } = makeConverter();
  let unstable = 0;
  const orig = cv.debouncer.markUnstable.bind(cv.debouncer);
  cv.debouncer.markUnstable = () => { unstable++; orig(); };
  cv.setPanelText(FULL_PANEL);
  const onTurn = scene(baseScene);
  cv.onFrame(onTurn, {}); cv.onFrame(onTurn, {});          // settle → authoritative hero turn
  const offTurn = scene(Object.assign({}, baseScene, { heroTurn: false })); // hero acted → red gone
  cv.onFrame(offTurn, {});
  assert.ok(unstable >= 1, 'markUnstable fired on the turn-end (true→false) transition');
});

// ── E: stale (a fresh snapshot supersedes shown advice) — safety-critical ─────
test('E: a fresh snapshot (table moved) supersedes shown advice → stale, newer seq', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText(FULL_PANEL);
  const g1 = scene(baseScene);
  cv.onFrame(g1, {}); cv.onFrame(g1, {});      // settle → send seq 1
  assert.strictEqual(sent.length, 1);
  cv._advice = { advice: 'RAISE', action: 'raise', amount: 600, seq: 1 }; // brain replied for seq 1
  let r = cv.onFrame(g1, {});
  assert.strictEqual(r.stale, false, 'same snapshot, advice current → not stale');
  // the table moves (villain re-bets) → a NEW distinct snapshot → re-send seq 2
  const g2 = scene(Object.assign({}, baseScene, { betTR: 7 }));
  r = cv.onFrame(g2, {}); r = cv.onFrame(g2, {});
  assert.strictEqual(sent.length, 2, 'new snapshot re-sent');
  assert.strictEqual(r.stale, true, 'advice(seq1) superseded by seq2 → stale');
  assert.ok(r.lastSeq > 1, 'stale carries the newer seq');
});

// ── E: wait (brain declined / strict-block via botLink.onError) ──────────────
test('E: a brain decline (onError) on hero turn → decline (→ wait), no advice shown', () => {
  const { cv, sent } = makeConverter();
  cv.setPanelText(FULL_PANEL);
  const g = scene(baseScene);
  cv.onFrame(g, {}); cv.onFrame(g, {});         // settle → send seq 1
  assert.strictEqual(sent.length, 1);
  cv.botLink.onError({ kind: 'error', error: 'strict_block', seq: 1 }); // brain rejects
  const r = cv.onFrame(g, {});
  assert.ok(r.declined && r.declined.reason === 'brain-decline', 'surfaces a brain decline for the wait map');
  assert.strictEqual(r.stale, false);
});
