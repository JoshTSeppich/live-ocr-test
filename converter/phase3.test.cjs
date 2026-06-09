// converter/phase3.test.cjs — Layer 3 assembler + seat mapping + hand-boundary
// detector + Layer 4 history. Run: node --test converter/phase3.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('./assembler.js');
const Seats = require('./seats.js');
const HB = require('./handBoundary.js');
const Hist = require('./history.js');

// ── confirmed-snapshot builders (Phase 2 push() output shape) ───────────────
const C = (value) => ({ value, status: 'read', confirmed: true, stable: true });
const EMPTY = { value: null, status: 'no-read', confirmed: false, stable: true };   // settled empty seat
const OCC = { value: null, status: 'occluded', confirmed: false, stable: true };    // covered plate
const UNCONF = (v) => ({ value: v, status: 'read', confirmed: false, stable: false }); // not yet settled
const cells = (codes, total) => ({
  value: Array.from({ length: total }, (_, i) =>
    i < codes.length ? { code: codes[i], status: 'read' } : { code: null, status: 'no-read' }),
  status: 'read', confirmed: true,
});

// All six seats occupied; flop; hero(BC) stack 50bb; villain TR has bet 3bb.
function snap(over) {
  over = over || {};
  const s = {
    stacks: { TL: C(100), TC: C(100), TR: C(100), BR: C(100), BC: C(50), BL: C(100) },
    bets: { TL: EMPTY, TC: EMPTY, TR: C(3), BR: EMPTY, BC: EMPTY, BL: EMPTY },
    pot: C(5),
    button: { value: 'TC', status: 'read', confirmed: true, stable: true },
    board: cells(['8h', 'Jd', '2d'], 5),
    heroHole: cells(['Ac', '2h'], 2),
  };
  for (const k of Object.keys(over)) {
    if (k.startsWith('stack_')) s.stacks[k.slice(6)] = over[k];
    else if (k.startsWith('bet_')) s.bets[k.slice(4)] = over[k];
    else s[k] = over[k];
  }
  return s;
}
const baseCtx = { heroBet: 0, BB_CHIPS: 100 };

// ── assembler: happy path ───────────────────────────────────────────────────
test('assembleRequest: full valid GameStateRequest with correct chips + math', () => {
  const r = A.assembleRequest(snap(), baseCtx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  const q = r.request;
  assert.strictEqual(q.schema_version, 1);
  assert.strictEqual(q.game_type, 'cash');
  assert.strictEqual(q.table_size, 6);
  assert.deepStrictEqual(q.blinds, { sb: 50, bb: 100 });
  // clockwise order [TL,TC,TR,BR,BC,BL] → hero BC index 4, button TC index 1
  assert.strictEqual(q.hero_seat, 4);
  assert.strictEqual(q.button_seat, 1);
  assert.deepStrictEqual(q.stacks, [10000, 10000, 10000, 10000, 5000, 10000]);
  assert.deepStrictEqual(q.current_bets, [0, 0, 300, 0, 0, 0]); // only TR(idx2) bet 3bb
  assert.deepStrictEqual(q.hero_hole, ['Ac', '2h']);
  assert.deepStrictEqual(q.board, ['8h', 'Jd', '2d']);
  assert.strictEqual(q.to_call, 300);            // maxBet 300 - hero 0
  assert.strictEqual(q.min_raise, 400);          // maxBet 300 + bb 100
  assert.strictEqual(q.max_raise, 5000);         // heroBet 0 + heroStack 5000
  assert.strictEqual(q.pot_committed, 800);      // pot 500 + Σbets 300
  assert.deepStrictEqual(q.action_history, []);
  // ints only
  for (const v of [...q.stacks, ...q.current_bets, q.pot_committed, q.to_call, q.min_raise, q.max_raise])
    assert.ok(Number.isInteger(v), `non-int ${v}`);
});

test('assembleRequest: pot already-includes-bets flag skips the add', () => {
  const r = A.assembleRequest(snap(), Object.assign({}, baseCtx, { potIncludesCurrentBets: true }));
  assert.strictEqual(r.request.pot_committed, 500); // pot 500, no add
});

test('assembleRequest: hero bet comes from known action, never BC OCR (§0.10)', () => {
  // plant a misleading BC bet read; heroBet=2 must win
  const r = A.assembleRequest(snap({ bet_BC: C(99) }), Object.assign({}, baseCtx, { heroBet: 2 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.current_bets[r.request.hero_seat], 200); // 2bb, not 99bb
});

// ── assembler: withhold on ANY unconfirmed mandatory field ──────────────────
test('withhold: an occluded stack (occupied, covered) withholds the whole snapshot', () => {
  const r = A.assembleRequest(snap({ stack_TL: OCC }), baseCtx);
  assert.strictEqual(r.ok, false);
  assert.ok(r.withheld);
  assert.ok(r.missing.some((m) => m.startsWith('stack_TL')));
});
test('withhold: unconfirmed (unsettled) stack withholds', () => {
  const r = A.assembleRequest(snap({ stack_TR: UNCONF(100) }), baseCtx);
  assert.strictEqual(r.ok, false);
});
test('withhold: pot unconfirmed', () => {
  assert.strictEqual(A.assembleRequest(snap({ pot: UNCONF(5) }), baseCtx).ok, false);
});
test('withhold: hero bet unknown (never fabricated)', () => {
  const r = A.assembleRequest(snap(), { BB_CHIPS: 100 }); // no heroBet
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('hero-bet-unknown'));
});
test('withhold: button unconfirmed', () => {
  const r = A.assembleRequest(snap({ button: { value: 'TC', status: 'read', confirmed: false, stable: false } }), baseCtx);
  assert.strictEqual(r.ok, false);
});
test('withhold: invalid board count (2 cards) never assembles partial', () => {
  const r = A.assembleRequest(snap({ board: cells(['8h', 'Jd'], 5) }), baseCtx);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.some((m) => m.startsWith('board-count')));
});
test('withhold: hole not exactly 2', () => {
  const r = A.assembleRequest(snap({ heroHole: cells(['Ac'], 2) }), baseCtx);
  assert.strictEqual(r.ok, false);
});
test('withhold: occluded villain bet (cannot determine commit)', () => {
  const r = A.assembleRequest(snap({ bet_TR: OCC }), baseCtx);
  assert.strictEqual(r.ok, false);
});

// ── occupancy: empty seat excluded; preflop board=0 ok ──────────────────────
test('empty seat (settled no-read stack) is excluded; table_size shrinks', () => {
  const r = A.assembleRequest(snap({ stack_TR: EMPTY, bet_TR: EMPTY }), baseCtx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.table_size, 5);   // TR gone
  assert.strictEqual(r.request.stacks.length, 5);
  assert.strictEqual(r.request.current_bets.length, 5);
});
test('preflop board (0 cards) assembles', () => {
  const r = A.assembleRequest(snap({ board: cells([], 5) }), baseCtx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.request.board, []);
});

// ── seats: mapping + the live self-check ────────────────────────────────────
test('mapSeats: clockwise indices, SB=button+1, BB=button+2', () => {
  const m = Seats.mapSeats(['TL', 'TC', 'TR', 'BR', 'BC', 'BL'], 'TC');
  assert.deepStrictEqual(m.order, ['TL', 'TC', 'TR', 'BR', 'BC', 'BL']);
  assert.strictEqual(m.button_seat, 1);
  assert.strictEqual(m.hero_seat, 4);
  assert.strictEqual(m.sbSeat, 'TR'); // button+1 clockwise
  assert.strictEqual(m.bbSeat, 'BR'); // button+2
});
test('mapSeats: hero not occupied → not ok (withhold)', () => {
  assert.strictEqual(Seats.mapSeats(['TL', 'TC'], 'TL').ok, false);
});
test('checkSeatOrder: badges on computed SB/BB → ok', () => {
  const m = Seats.mapSeats(['TL', 'TC', 'TR', 'BR', 'BC', 'BL'], 'TC');
  const c = Seats.checkSeatOrder(m, ['TR', 'BR']);
  assert.strictEqual(c.ok, true);
});
test('checkSeatOrder: badges on the WRONG seats → loud warning', () => {
  const m = Seats.mapSeats(['TL', 'TC', 'TR', 'BR', 'BC', 'BL'], 'TC');
  const c = Seats.checkSeatOrder(m, ['BL', 'TL']); // not TR,BR
  assert.strictEqual(c.ok, false);
  assert.match(c.warning, /SEAT-ORDER MISMATCH/);
});
test('checkSeatOrder: one badge visible → inconclusive (not a pass)', () => {
  const m = Seats.mapSeats(['TL', 'TC', 'TR', 'BR', 'BC', 'BL'], 'TC');
  const c = Seats.checkSeatOrder(m, ['TR']);
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.inconclusive, true);
});
test('assembleRequest threads the seat-check when badgeSeats provided', () => {
  const r = A.assembleRequest(snap(), Object.assign({}, baseCtx, { badgeSeats: ['TR', 'BR'] }));
  assert.strictEqual(r.seatCheck.ok, true);
});

// ── envelope + reply parsing ────────────────────────────────────────────────
test('buildEnvelope: {seq, request} only (optionals omitted)', () => {
  const env = A.buildEnvelope(7, { schema_version: 1 });
  assert.deepStrictEqual(Object.keys(env).sort(), ['request', 'seq']);
  assert.strictEqual(env.seq, 7);
});
test('parseReply: success branches on "response" (ZoomAdvice)', () => {
  const p = A.parseReply({ seq: 7, response: { advice: 'BOT SAYS: RAISE 75', action: 'raise', amount: 75, abstract_action: 'RAISE_2_5X', fallback_used: 'exact', opponent_id: 'zoom-villain-0' } });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.kind, 'advice');
  assert.strictEqual(p.advice, 'BOT SAYS: RAISE 75');
  assert.strictEqual(p.amount, 75);
});
test('parseReply: error branch carries error + details', () => {
  const p = A.parseReply({ seq: 7, error: 'validation_error', details: { errors: [] } });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.kind, 'error');
  assert.strictEqual(p.error, 'validation_error');
});
test('parseReply: neither response nor error → malformed', () => {
  assert.strictEqual(A.parseReply({ seq: 1 }).kind, 'malformed');
  assert.strictEqual(A.parseReply(null).ok, false);
});

// ── hand-boundary detector (§0.7) ───────────────────────────────────────────
const SNAP = (boardCount, potChips, buttonSeat, stacks) => ({ boardCount, potChips, buttonSeat, stacks });
test('boundary: board→0 + button moved + stacks jumped (all 3) fires', () => {
  const prev = SNAP(5, 1200, 'TC', { TL: 9000, TC: 8000, TR: 7000, BC: 5000 });
  const curr = SNAP(0, 150, 'TR', { TL: 10000, TC: 10000, TR: 9000, BC: 6000 });
  const r = HB.detectBoundary(prev, curr);
  assert.strictEqual(r.boundary, true);
  assert.strictEqual(r.count, 3);
});
test('boundary: ≥2 signals (board→0 + button moved) fires even if stacks steady', () => {
  const prev = SNAP(3, 800, 'TC', { TL: 9000, BC: 5000 });
  const curr = SNAP(0, 150, 'TR', { TL: 9000, BC: 5000 });
  const r = HB.detectBoundary(prev, curr);
  assert.strictEqual(r.boundary, true);
  assert.ok(r.count >= 2);
});
test('NO mid-hand false fire: pot grows, board gains a card, button fixed', () => {
  const prev = SNAP(3, 400, 'TC', { TL: 9000, TC: 8000, TR: 7000, BC: 5000 });
  const curr = SNAP(4, 1000, 'TC', { TL: 9000, TC: 8000, TR: 6400, BC: 5000 }); // one bettor
  const r = HB.detectBoundary(prev, curr);
  assert.strictEqual(r.boundary, false);
});
test('lifecycle resets debouncer + history on boundary, not mid-hand', () => {
  let dReset = 0, hReset = 0;
  const lc = new HB.HandLifecycle({ debouncer: { reset: () => dReset++ }, history: { reset: () => hReset++ } });
  lc.onSnapshot(SNAP(3, 400, 'TC', { TL: 9000, BC: 5000 }));      // first, no prev
  lc.onSnapshot(SNAP(4, 900, 'TC', { TL: 9000, BC: 5000 }));      // mid-hand
  assert.strictEqual(dReset, 0);
  lc.onSnapshot(SNAP(0, 150, 'TR', { TL: 10000, BC: 6000 }));     // boundary
  assert.strictEqual(dReset, 1);
  assert.strictEqual(hReset, 1);
});

// ── Layer 4 history: derive-or-[] ───────────────────────────────────────────
const map6 = Seats.mapSeats(['TL', 'TC', 'TR', 'BR', 'BC', 'BL'], 'TC');
test('history: a clean bet derives one valid entry', () => {
  const h = new Hist.ActionHistory();
  h.setStreet(1);
  const prev = { bets: { TR: 0 }, stacks: { TR: 10000 } };
  const curr = { bets: { TR: 300 }, stacks: { TR: 9700 } }; // bet 3bb, stack drop 300
  h.observe(prev, curr, map6);
  assert.deepStrictEqual(h.get(), [{ seat: 2, street: 1, type: 'bet', amount: 300 }]);
});
test('history: raise vs call classified from prior max', () => {
  const h = new Hist.ActionHistory();
  const prev = { bets: { TR: 300, BR: 0, BL: 0 }, stacks: { TR: 9700, BR: 10000, BL: 10000 } };
  const curr = { bets: { TR: 300, BR: 900, BL: 300 }, stacks: { TR: 9700, BR: 9100, BL: 9700 } };
  h.observe(prev, curr, map6);
  const e = h.get();
  assert.deepStrictEqual(e.find((x) => x.seat === 3), { seat: 3, street: 0, type: 'raise', amount: 900 });
  assert.deepStrictEqual(e.find((x) => x.seat === 5), { seat: 5, street: 0, type: 'call', amount: 300 });
});
test('history: all-in when stack hits 0', () => {
  const h = new Hist.ActionHistory();
  const prev = { bets: { TR: 0 }, stacks: { TR: 4000 } };
  const curr = { bets: { TR: 4000 }, stacks: { TR: 0 } };
  h.observe(prev, curr, map6);
  assert.strictEqual(h.get()[0].type, 'all-in');
});
test('history: stack/bet mismatch poisons to [] (never a bad entry)', () => {
  const h = new Hist.ActionHistory();
  const prev = { bets: { TR: 0 }, stacks: { TR: 10000 } };
  const curr = { bets: { TR: 300 }, stacks: { TR: 9900 } }; // bet +300 but stack only -100
  h.observe(prev, curr, map6);
  assert.deepStrictEqual(h.get(), []);
});
test('history: reset clears entries and un-poisons', () => {
  const h = new Hist.ActionHistory();
  h.observe({ bets: { TR: 0 }, stacks: { TR: 100 } }, { bets: { TR: 300 }, stacks: { TR: 50 } }, map6); // poison
  assert.deepStrictEqual(h.get(), []);
  h.reset();
  h.observe({ bets: { TR: 0 }, stacks: { TR: 10000 } }, { bets: { TR: 300 }, stacks: { TR: 9700 } }, map6);
  assert.strictEqual(h.get().length, 1);
});
test('validateActionHistory: a malformed entry drops the whole list to []', () => {
  assert.deepStrictEqual(A.validateActionHistory([{ seat: 0, street: 0, type: 'bet', amount: 100 }, { seat: 1, street: 0, type: 'nope', amount: 5 }], 6), []);
  assert.strictEqual(A.validateActionHistory([{ seat: 0, street: 0, type: 'bet', amount: 100 }], 6).length, 1);
});
