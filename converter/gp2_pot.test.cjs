// converter/gp2_pot.test.cjs — G-P2 preflop pot double-count PIN (live-validation).
//
// THE RISK (spotted in STEP 0): assembler.js computes
//     pot_committed = potIncludesCurrentBets ? potRead : potRead + Σ(current_bets)
// with the default potIncludesCurrentBets:false (it ADDS the front-of-seat bets).
// If the displayed "Pot: N.NN BB" ALREADY includes the posted blinds / live bets,
// adding Σ(current_bets) double-counts — a one-field error of exactly the class
// G-P1 just dodged, one field over.
//
// WHY IT'S UNRESOLVED: CC-B P3 was INCONCLUSIVE on pot timing/composition, and
// P2 observed pot = 1.5 BB at hand start *while the blinds also render as bet
// badges* — which HINTS the readout may be inclusive, but does not prove it.
// We therefore DO NOT flip the default on a guess (guessing wrong reintroduces
// the double-count). Instead we PIN the §G.1-correct pot_committed (= 150 chips
// = 1.5 BB at a blinds-only hand start) under BOTH interpretations, leave the
// assembler default unchanged, and flag the flip as a FIRST-LIVE-FRAME confirm.
//
// LIVE-VALIDATION ITEM: at first bring-up, read one blinds-only hand-start frame
// and check whether the pot readout shows 1.5 (inclusive → set
// potIncludesCurrentBets:true) or 0.0 (middle-pot-only → keep the default false).
//
// Run: node --test converter/gp2_pot.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('./assembler.js');

const C = (value) => ({ value, status: 'read', confirmed: true, stable: true });
const EMPTY = { value: null, status: 'no-read', confirmed: false, stable: true };
const cells = (codes, total) => ({
  value: Array.from({ length: total }, (_, i) =>
    i < codes.length ? { code: codes[i], status: 'read' } : { code: null, status: 'no-read' }),
  status: 'read', confirmed: true,
});

// Blinds-only preflop hand start. button TC(idx1) → SB=TR(idx2), BB=BR(idx3).
// SB 0.5 + BB 1.0 = 1.5 BB = 150 chips committed; NET stacks already deduct them.
// `potBB` parameterizes the two readout interpretations.
function handStart(potBB) {
  return {
    stacks: { TL: C(100), TC: C(100), TR: C(99.5), BR: C(99), BC: C(100), BL: C(100) },
    bets:   { TL: EMPTY, TC: EMPTY, TR: C(0.5), BR: C(1.0), BC: EMPTY, BL: EMPTY },
    pot: C(potBB),
    button: { value: 'TC', status: 'read', confirmed: true, stable: true },
    board: cells([], 5),
    heroHole: cells(['Ac', 'Kh'], 2),
  };
}
const CORRECT_POT_COMMITTED = 150; // §G.1: 1.5 BB of blinds at a blinds-only start

// ── Interpretation 1: readout is MIDDLE-POT-ONLY (chips swept to center) ───────
// Preflop nothing is swept yet → readout 0.0. The assembler DEFAULT (add Σbets)
// yields the correct 150.
test('G-P2 pot — middle-pot-only readout (0.0): default config gives the correct 150', () => {
  const r = A.assembleRequest(handStart(0), { heroBet: 0, BB_CHIPS: 100 }); // default potIncludesCurrentBets:false
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.request.pot_committed, CORRECT_POT_COMMITTED,
    'middle-pot-only + default(add Σbets) → 0 + 150 = 150 ✓');
});

// ── Interpretation 2: readout is INCLUSIVE (already counts the blinds) ─────────
// Readout shows 1.5 BB. The CORRECT config is potIncludesCurrentBets:true.
test('G-P2 pot — inclusive readout (1.5): potIncludesCurrentBets:true gives the correct 150', () => {
  const r = A.assembleRequest(handStart(1.5), { heroBet: 0, BB_CHIPS: 100, potIncludesCurrentBets: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.request.pot_committed, CORRECT_POT_COMMITTED,
    'inclusive readout + potIncludesCurrentBets:true → 150 (no add) ✓');
});

// ── The hazard, pinned so it can't sneak back: inclusive readout under the ─────
// DEFAULT config double-counts to 300. This is what we MUST avoid live — if the
// readout proves inclusive, flip the default; do NOT ship this 300.
test('G-P2 pot — HAZARD: inclusive readout under the default double-counts to 300 (must not ship)', () => {
  const r = A.assembleRequest(handStart(1.5), { heroBet: 0, BB_CHIPS: 100 }); // default false → adds Σbets
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.request.pot_committed, 300,
    'documents the double-count: inclusive readout(150) + Σbets(150) = 300 — the failure to catch at first live frame');
});
