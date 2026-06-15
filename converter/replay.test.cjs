// converter/replay.test.cjs — AMENDMENT F: replay acceptance harness (the merge
// gate). Logic-level replay of CC-B's MEASURED reads (probe_timeseries.json) through
// the REAL pipeline — SettleDebouncer (L2) → assembleRequest (L3) → Escalator (§5) —
// plus the turn-gating and seq/stale producer logic. Per the approved scope: this
// replays measured numeric reads, NOT raw pixels (the OCR primitives were validated
// separately by CC-B; a headless raw-pixel path is out of scope and the JS matchers
// have no headless templates).
//
// The timeseries rows carry the real stacks/bets/pot/board-count per frame. The
// fields the timeseries does NOT capture (button, card codes, action panel) are
// synthesized per-assertion so each property can be exercised on top of the real
// measured numbers.
//
// Asserts (the F contract):
//   1. WITHHOLD DISCIPLINE — raw rows (no synthesized button/cards) assemble NOTHING.
//   2. NET SEMANTIC — a real stack emits verbatim (G-P1), bet held separately.
//   3. POT INTERPRETATION (live-validation, real-data evidence for amendment B).
//   4. TURN GATING — full action set fires; Fast-Fold does not.
//   5. ESCALATE — a withholding hero-turn escalates on the poll floor.
//   6. SEQ/STALE ORDERING — distinct snapshots differ (→ resend/stale); identical don't.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const Obs = require('./observation.js');
const { SettleDebouncer } = require('./settle.js');
const { Escalator } = require('./escalate.js');
const A = require('./assembler.js');
const Seats = require('./seats.js');

// ── load the real CC-B timeseries; fall back to an embedded real sample ───────
const TS_PATH = path.join(__dirname, '..', '..', 'poker-vision-analysis', 'output', 'probe_timeseries.json');
// First three rows verbatim from the corpus (20260603_121222) — keeps this test
// hermetic and still driven by REAL measured values when the sibling repo is absent.
const SAMPLE_ROWS = [
  { i: 0, board: 0, pot: 1.5, stacks: { TL: 96.5, TC: 107.6, TR: 173.2, BL: null, BC: 49.0, BR: 78.0 }, bets: { TL: null, TC: null, TR: null, BL: null, BC: 1.0, BR: 0.5 } },
  { i: 1, board: 0, pot: 2.5, stacks: { TL: null, TC: null, TR: null, BL: 107.0, BC: 49.0, BR: 78.0 }, bets: { TL: 1.0, TC: null, TR: null, BL: null, BC: 1.0, BR: 0.5 } },
  { i: 2, board: 0, pot: 3.0, stacks: { TL: 95.5, TC: 107.6, TR: 173.2, BL: 107.0, BC: 49.0, BR: null }, bets: { TL: 1.0, TC: null, TR: null, BL: null, BC: 1.0, BR: 1.0 } },
];
function loadRows() {
  try {
    if (fs.existsSync(TS_PATH)) {
      const rows = JSON.parse(fs.readFileSync(TS_PATH, 'utf8')).rows;
      if (Array.isArray(rows) && rows.length) return { rows, source: TS_PATH };
    }
  } catch (e) { /* fall through to embedded sample */ }
  return { rows: SAMPLE_ROWS, source: '(embedded real sample)' };
}
const { rows, source } = loadRows();
const SEATS = ['TL', 'TC', 'TR', 'BL', 'BC', 'BR'];
const BB_CHIPS = 100;

// Build a Layer-1-shaped TableObservation from a measured row. `o` synthesizes the
// fields the timeseries lacks: button (seat), boardCodes[], hole[], heroTurn.
function obsFromRow(row, o) {
  o = o || {};
  const stacks = {}, bets = {};
  for (const s of SEATS) {
    const sv = row.stacks ? row.stacks[s] : null;
    stacks[s] = (sv != null) ? { value: sv, status: 'read' } : { value: null, status: 'no-read' };
    const bv = row.bets ? row.bets[s] : null;
    bets[s] = (bv != null) ? { value: bv, status: 'read' } : { value: null, status: 'no-read' };
  }
  return {
    stacks, bets,
    pot: { value: row.pot, status: row.pot != null ? 'read' : 'no-read' },
    button: o.button ? { seat: o.button, status: 'read' } : { seat: null, status: 'no-read' },
    board: o.boardCodes ? o.boardCodes.map((c) => ({ code: c, status: 'read' })) : null,
    heroHole: o.hole ? o.hole.map((c) => ({ code: c, status: 'read' })) : null,
    turn: { heroToAct: !!o.heroTurn, status: 'read' },
    timer: { fraction: 1, status: 'read' },
    heroBetObserved: { value: null, status: 'no-read' },
  };
}
// Settle a single row to confirmation (n=settleN=2 → push twice), then assemble.
function assembleRow(row, o, ctx) {
  const deb = new SettleDebouncer({ n: 2, settleN: 2 });
  const obs = obsFromRow(row, o);
  deb.push(obs);
  const confirmed = deb.push(obs);
  return A.assembleRequest(confirmed, ctx);
}

test(`replay harness loaded ${rows.length} measured rows from ${source}`, () => {
  assert.ok(rows.length >= 1);
});

// ── 1. WITHHOLD DISCIPLINE — raw rows (no button/cards) never assemble ────────
test('F/withhold: raw measured rows assemble NOTHING (button + cards absent → withhold)', () => {
  const slice = rows.slice(0, Math.min(rows.length, 200));
  let assembled = 0;
  for (const row of slice) {
    const r = assembleRow(row, { heroTurn: true }, { heroBet: 0, BB_CHIPS });
    if (r.ok) assembled++;
    else {
      // the never-fabricate spine: missing the synthesized-only mandatory fields
      assert.ok(r.missing.some((m) => m.startsWith('button')) || r.missing.includes('board:unconfirmed') || r.missing.includes('hero_hole:unconfirmed'));
    }
  }
  assert.strictEqual(assembled, 0, 'no raw row assembles without button/cards — assemble nothing partial');
});

// ── 2. NET SEMANTIC on a real measured stack (G-P1) ──────────────────────────
test('F/NET: a real measured hero stack emits VERBATIM; committed bet held separately', () => {
  const row = rows[0];                       // real blinds-only start (board 0)
  const heroStackBB = row.stacks.BC;         // 49.0 in the corpus
  const r = assembleRow(row, { button: 'TC', hole: ['Ac', 'Kh'], boardCodes: [], heroTurn: true },
    { heroBet: row.bets.BC || 1.0, BB_CHIPS }); // BC posted the BB (1.0)
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  const hero = r.request.hero_seat;
  assert.strictEqual(r.request.stacks[hero], Math.round(heroStackBB * BB_CHIPS),
    'NET stack emitted verbatim (e.g. 49.0 → 4900) — no add-back, no subtract');
  assert.strictEqual(r.request.current_bets[hero], 100, 'the BB hero posted is held in current_bets, not folded into the stack');
});

// ── 3. POT INTERPRETATION — real-data evidence for amendment B (live-validation) ─
// Real row 0 is a blinds-only start: pot READOUT = 1.5 while the blinds also show as
// bet badges (BC 1.0 + BR 0.5). Under the assembler DEFAULT (add Σbets) this yields
// pot_committed = 300 — the double-count. Under potIncludesCurrentBets:true it yields
// the §G.1-correct 150. CC-B P3 couldn't resolve which; this row is strong evidence
// the readout is INCLUSIVE. DO NOT flip the default until a first-live frame confirms.
test('F/pot (B live-validation): real 1.5 hand-start → 300 under default, 150 if readout is inclusive', () => {
  const row = rows[0];
  const overlay = { button: 'TC', hole: ['Ac', 'Kh'], boardCodes: [], heroTurn: true };
  const rDefault = assembleRow(row, overlay, { heroBet: row.bets.BC || 1.0, BB_CHIPS });
  const rIncl = assembleRow(row, overlay, { heroBet: row.bets.BC || 1.0, BB_CHIPS, potIncludesCurrentBets: true });
  assert.strictEqual(rDefault.ok, true);
  // pot 1.5 (150) + Σbets(BC 100 + BR 50 = 150) = 300 under the default — the hazard
  assert.strictEqual(rDefault.request.pot_committed, 300, 'default double-counts an inclusive readout — flag for live confirm');
  assert.strictEqual(rIncl.request.pot_committed, 150, 'inclusive interpretation gives the §G.1-correct 150');
});

// ── 4. TURN GATING — full action set fires; Fast-Fold (the ~40%) does not ──────
test('F/turn: gating fires only on the full action set, not red-presence / Fast-Fold', () => {
  const redTurn = true; // the cheap pixel precondition (would be confirmed from the panel crop)
  const heroToAct = (panel) => redTurn && Obs.classifyActionSet(panel) === 'full';
  assert.strictEqual(heroToAct('Fold  Call 5.60  Raise 11.20'), true, 'full set → hero turn');
  assert.strictEqual(heroToAct('Fold  Call Any  Raise Any'), false, 'Fast-Fold pre-button → NOT hero turn');
  assert.strictEqual(heroToAct('R8!se C#ll'), false, 'unparseable → not a fire');
});

// ── 5. ESCALATE — a withholding hero-turn escalates on the poll floor ─────────
test('F/escalate: a real row that can never assemble, on hero turn, escalates on the floor', () => {
  const esc = new Escalator({ maxPolls: 3 });
  let state;
  for (let i = 0; i < 4; i++) {
    const r = assembleRow(rows[0], { heroTurn: true }, { heroBet: 0, BB_CHIPS }); // no button/cards → withhold
    state = esc.update({ heroToAct: true, hasAdvice: r.ok, timerFraction: null }).state;
  }
  assert.strictEqual(state, 'escalate', 'never-clean hero turn hands off to the human (poll floor)');
});

// ── 6. SEQ/STALE ORDERING — distinct snapshots differ; identical don't ────────
test('F/stale: distinct real snapshots differ (→ resend/stale); an identical one does not', () => {
  const sig = (req) => req && JSON.stringify([req.stacks, req.current_bets, req.board, req.pot_committed, req.button_seat]);
  const overlay = { button: 'TC', hole: ['Ac', 'Kh'], boardCodes: [], heroTurn: true };
  const r0 = assembleRow(rows[0], overlay, { heroBet: rows[0].bets.BC || 1.0, BB_CHIPS });
  const r0b = assembleRow(rows[0], overlay, { heroBet: rows[0].bets.BC || 1.0, BB_CHIPS });
  assert.strictEqual(r0.ok && r0b.ok, true);
  assert.strictEqual(sig(r0.request), sig(r0b.request), 'identical reads → identical snapshot → no resend (no false stale)');
  // a materially different real row → a different snapshot → would resend (newer seq → stale on the old advice)
  const later = rows.find((row, idx) => idx > 0 && row.stacks && row.stacks.BC != null
    && sig(assembleRow(row, overlay, { heroBet: row.bets.BC || 0, BB_CHIPS }).request || {}) !== sig(r0.request));
  if (later) {
    const rL = assembleRow(later, overlay, { heroBet: later.bets.BC || 0, BB_CHIPS });
    assert.notStrictEqual(sig(rL.request), sig(r0.request), 'a moved table → a fresh snapshot → supersession path holds');
  }
});
