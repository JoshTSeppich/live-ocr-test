// converter/gp1_net.test.cjs — G-P1 NET-semantic PIN (safety-critical).
//
// CC-B proved the DISPLAYED stack is NET (already chips-behind). The live brain
// (converter → ws://127.0.0.1:8766 → frozen runtime adapter) consumes `stacks`
// AS chips-behind and NEVER subtracts current_bets/blinds itself.
// INTEGRATION_CONTRACT §G.1 is explicit: "stacks are CHIPS-BEHIND ... the blinds
// are deducted from their stacks and held in current_bets ... do NOT report gross
// stacks." So the assembler must emit the read NET value VERBATIM (as chips), with
// the committed bet held SEPARATELY in current_bets — no add-back, no subtract.
//
// This file LOCKS that semantic so a future refactor cannot silently flip it:
//   • adding the bet back (→ "gross") double-counts one field over;
//   • subtracting it (→ the dispatch's feared double-subtract) is wrong too.
//
// PROVENANCE: the "the brain presumes GROSS and subtracts" premise traced to the
// DEAD 8765 event-stream brain_bridge.py (ADR-0009-retired) — NOT the converter's
// 8766 path. PROBE_FINDINGS_20260610.md item 1 is corrected; §H.5's blocking
// gross/net question resolves to NET (see assembler.js note).
//
// Run: node --test converter/gp1_net.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('./assembler.js');

// confirmed-snapshot builders (Phase-2 push() output shape; mirror phase3.test.cjs)
const C = (value) => ({ value, status: 'read', confirmed: true, stable: true });
const EMPTY = { value: null, status: 'no-read', confirmed: false, stable: true };
const cells = (codes, total) => ({
  value: Array.from({ length: total }, (_, i) =>
    i < codes.length ? { code: codes[i], status: 'read' } : { code: null, status: 'no-read' }),
  status: 'read', confirmed: true,
});

// ── the headline pin: a NET hero stack emits verbatim, bet held separately ────
// Hero (BC) shows a NET stack of 86.0 BB and has committed 1.0 BB this street.
// NET means the 86.0 ALREADY excludes the 1.0 — chips-behind is 86.0. The brain
// wants chips-behind, so emit 8600. NOT 8500 (subtract) and NOT 8700 (add-back).
test('G-P1: NET hero stack emits verbatim (8600); committed bet held separately (100)', () => {
  const snap = {
    stacks: { TL: C(100), TC: C(100), TR: C(100), BR: C(100), BC: C(86), BL: C(100) },
    bets:   { TL: EMPTY, TC: EMPTY, TR: EMPTY, BR: EMPTY, BC: EMPTY, BL: EMPTY },
    pot: C(0),
    button: { value: 'TC', status: 'read', confirmed: true, stable: true },
    board: cells(['8h', 'Jd', '2d'], 5), // flop — heroBet is this-street committed
    heroHole: cells(['Ac', '2h'], 2),
  };
  const r = A.assembleRequest(snap, { heroBet: 1.0, BB_CHIPS: 100 });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  const q = r.request;
  const hero = q.hero_seat;
  assert.strictEqual(q.stacks[hero], 8600,
    'NET stack must emit verbatim — not 8500 (subtract) nor 8700 (add-back to gross)');
  assert.strictEqual(q.current_bets[hero], 100,
    'the committed bet lives in current_bets, NOT folded into / out of the stack');
});

// ── §G.1 preflop mirror: SB/BB villains report NET stacks + blinds in bets ────
// 1 BB = 100 chips. Scales §G.1's stacks=[…,995,990,…] current_bets=[…,5,10,…].
// SB villain: NET 99.5 (9950) wearing a 0.5 badge; BB villain: NET 99.0 (9900)
// wearing a 1.0 badge. The blind is BOTH deducted from the stack (NET, already in
// the displayed value) AND present in current_bets — the brain never subtracts.
test('G-P1/§G.1: preflop blinds — SB/BB villains NET stacks, blinds held in current_bets', () => {
  const snap = {
    stacks: { TL: C(100), TC: C(100), TR: C(99.5), BR: C(99), BC: C(100), BL: C(100) },
    bets:   { TL: EMPTY, TC: EMPTY, TR: C(0.5), BR: C(1.0), BC: EMPTY, BL: EMPTY },
    pot: C(0), // middle pot empty preflop; blinds are front-of-seat bets (see B for the readout-inclusivity pin)
    button: { value: 'TC', status: 'read', confirmed: true, stable: true },
    board: cells([], 5), // preflop
    heroHole: cells(['Ac', 'Kh'], 2),
  };
  const r = A.assembleRequest(snap, { heroBet: 0, BB_CHIPS: 100 });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  const q = r.request;
  // clockwise order [TL,TC,TR,BR,BC,BL]; button TC(idx1) → SB=TR(idx2), BB=BR(idx3)
  assert.strictEqual(q.stacks[2], 9950, 'SB villain NET stack emitted verbatim (blind already deducted in the read)');
  assert.strictEqual(q.current_bets[2], 50, 'SB blind also held in current_bets — both, never subtracted');
  assert.strictEqual(q.stacks[3], 9900, 'BB villain NET stack emitted verbatim');
  assert.strictEqual(q.current_bets[3], 100, 'BB blind also held in current_bets');
  // pot_committed includes the blinds (via Σcurrent_bets) with an empty middle pot.
  assert.strictEqual(q.pot_committed, 150, 'preflop pot_committed = 1.5 BB (blinds) with middle pot 0');
});
