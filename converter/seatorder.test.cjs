// converter/seatorder.test.cjs — ACCEPTANCE GATE for the redesigned seat-order
// safety check (CC_SEATORDER_REDESIGN, ruling B: BB-anchored). The play-direction
// constant SEAT_ORDER_CW was verified 5/5 by the shadow session; this redesign
// swaps the gate's INPUT from the nonexistent "green blind badge" to the real
// blind signals (BB bet 1.0 / "BB" label as the ANCHOR, SB 0.5 corroborating),
// cross-checked against the detected button, and wires it so the gate runs live.
//
// Three required acceptance bands (per the brief):
//   1. 5/5 KNOWN-GOOD — the five STEP-1 frames PASS direction from the timeseries
//      BB reads + shadow buttons. shot_04060 passes on the BB anchor ALONE (its SB
//      0.5 never OCR'd) — the whole reason the anchor is the BB, not "two signals".
//   2. NEGATIVE — a BB that disagrees with the button raises the loud HARD STOP
//      (proves the gate isn't green merely because it never fires).
//   3. WITHHOLD — a no-anchor / non-blinds-only frame yields no check, no false
//      mismatch (a false hard-stop is its own failure).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const Seats = require('./seats.js');
const A = require('./assembler.js');

const BB_CHIPS = 100;
// Full 6-max occupancy at a Zoom hand start — the shadow's stated premise and the
// basis of the validation table's SB/BB (every seat dealt in). The seat-order
// check validates DIRECTION, not occupancy detection.
const ALL_SEATS = ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'];

// The five STEP-1 known-good frames (SHADOW_STEP1_FINDINGS §1): detected button +
// expected computed SB/BB. The check must compute these and PASS on all five.
const FRAMES = [
  { file: 'shot_00000_121232', btn: 'TR', expect: { sb: 'BR', bb: 'BC' } },
  { file: 'shot_01385_133139', btn: 'BR', expect: { sb: 'BC', bb: 'BL' } },
  { file: 'shot_04060_161808', btn: 'TC', expect: { sb: 'TR', bb: 'BR' } }, // SB(TR 0.5) unread → BB anchor alone
  { file: 'shot_04669_165426', btn: 'BR', expect: { sb: 'BC', bb: 'BL' } },
  { file: 'shot_02753_150446', btn: 'BC', expect: { sb: 'BL', bb: 'TL' } },
];

// Per-seat bet reads (BB) verbatim from the corpus 20260603_121222 timeseries
// (CC-B measured). Only the seats that actually OCR'd are present; note shot_04060
// carries the BB (1.0) only — its SB (0.5) did not read (the known CC-B weakness).
const EMBEDDED_BETS = {
  'shot_00000_121232': { BC: 1.0, BR: 0.5 },
  'shot_01385_133139': { BC: 0.5, BL: 1.0 },
  'shot_04060_161808': { BR: 1.0 },
  'shot_04669_165426': { BC: 0.5, BL: 1.0 },
  'shot_02753_150446': { TL: 1.0, BL: 0.5 },
};

// Prefer the REAL sibling-repo timeseries (keeps this driven by measured values);
// fall back to the embedded verbatim reads so the test is hermetic.
const TS_PATH = path.join(__dirname, '..', '..', 'poker-vision-analysis', 'output', 'probe_timeseries.json');
function frameReads(file) {
  try {
    if (fs.existsSync(TS_PATH)) {
      const rows = JSON.parse(fs.readFileSync(TS_PATH, 'utf8')).rows;
      const row = Array.isArray(rows) && rows.find((r) => r.file && r.file.startsWith(file));
      if (row) {
        const bets = {};
        for (const s of ALL_SEATS) if (row.bets && row.bets[s] != null) bets[s] = row.bets[s];
        return { bets, boardCount: row.board, potBB: row.pot, source: 'timeseries' };
      }
    }
  } catch (e) { /* fall through */ }
  return { bets: EMBEDDED_BETS[file], boardCount: 0, potBB: 1.5, source: 'embedded' };
}

// The converter surfaces a loud warning iff the check is a non-inconclusive
// failure (converter.js:120). MISMATCH surfaces; WITHHOLD/PASS do not.
const surfaces = (sc) => !!sc && !sc.ok && !sc.inconclusive;

// ── 1. 5/5 KNOWN-GOOD ────────────────────────────────────────────────────────
for (const f of FRAMES) {
  test(`5/5 known-good: ${f.file} (BTN ${f.btn}) → BB anchor ${f.expect.bb}, PASS`, () => {
    const reads = frameReads(f.file);
    const mapping = Seats.mapSeats(ALL_SEATS, f.btn);
    assert.strictEqual(mapping.ok, true);
    // computed direction matches the shadow's expected SB/BB
    assert.strictEqual(mapping.sbSeat, f.expect.sb, 'computed SB');
    assert.strictEqual(mapping.bbSeat, f.expect.bb, 'computed BB');

    const blindSeats = Seats.deriveBlindSeats({ boardCount: reads.boardCount, potBB: reads.potBB, bets: reads.bets });
    assert.strictEqual(blindSeats.blindsOnly, true, 'confident blinds-only start');
    assert.strictEqual(blindSeats.bb, f.expect.bb, 'BB anchor observed on the right seat');

    const c = Seats.checkSeatOrder(mapping, blindSeats);
    assert.strictEqual(c.ok, true, `expected PASS, got ${JSON.stringify(c)}`);
    assert.strictEqual(c.expected.bb, f.expect.bb);
    assert.strictEqual(c.expected.sb, f.expect.sb);
    assert.ok(!surfaces(c), 'a PASS must not raise the hard stop');
  });
}

test('5/5: shot_04060 specifically passes on the BB anchor ALONE (SB unread)', () => {
  const reads = frameReads('shot_04060_161808');
  const blindSeats = Seats.deriveBlindSeats({ boardCount: reads.boardCount, potBB: reads.potBB, bets: reads.bets });
  assert.strictEqual(blindSeats.bb, 'BR');
  assert.strictEqual(blindSeats.sb, null, 'SB (0.5 on TR) did not read — anchor carries it alone');
  const c = Seats.checkSeatOrder(Seats.mapSeats(ALL_SEATS, 'TC'), blindSeats);
  assert.strictEqual(c.ok, true);
});

// ── 2. NEGATIVE — a disagreeing BB anchor raises the HARD STOP ────────────────
test('negative: observed BB disagrees with the button → loud MISMATCH (logic)', () => {
  const mapping = Seats.mapSeats(ALL_SEATS, 'TR'); // BTN TR → computed BB = BC
  const c = Seats.checkSeatOrder(mapping, { sb: null, bb: 'TL' }); // observed BB on TL ≠ BC
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.mismatch, true);
  assert.ok(!c.inconclusive, 'a true play-direction error is NOT inconclusive');
  assert.match(c.warning, /SEAT-ORDER MISMATCH/);
  assert.ok(surfaces(c), 'the mismatch MUST surface as the loud hard stop');
});

test('negative: end-to-end through assembleRequest — derived BB on the wrong seat fires', () => {
  // A confident blinds-only snapshot whose button (TR ⇒ computed BB on BC) is
  // inconsistent with the observed BB blind (read 1.0 on TL): the "play direction
  // wrong" case. The deriver picks BB=TL from the bets; the check hard-stops.
  const snap = confirmedBlindsOnly({ button: 'TR', bets: { TL: 1.0, BR: 0.5 } });
  const r = A.assembleRequest(snap, { heroBet: 0, BB_CHIPS });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.blindSeats.bb, 'TL', 'deriver anchored BB on the 1.0 seat');
  assert.strictEqual(r.seatCheck.mismatch, true);
  assert.ok(surfaces(r.seatCheck), 'the assembler-derived check raises the hard stop live');
});

// ── 3. WITHHOLD — no false mismatch on ambiguous / non-blinds-only frames ─────
test('withhold: blinds-only but no BB anchor read → inconclusive, no mismatch', () => {
  const blindSeats = Seats.deriveBlindSeats({ boardCount: 0, potBB: 1.5, bets: { BR: 0.5 } }); // only SB read
  assert.strictEqual(blindSeats.bb, null, 'no confident BB anchor');
  assert.strictEqual(blindSeats.blindsOnly, true);
  const c = Seats.checkSeatOrder(Seats.mapSeats(ALL_SEATS, 'TC'), blindSeats);
  assert.strictEqual(c.inconclusive, true);
  assert.ok(!c.mismatch);
  assert.ok(!surfaces(c), 'a missing read must not raise a false hard stop');
});

test('withhold: non-blinds-only frame (flop on board) → no check', () => {
  const blindSeats = Seats.deriveBlindSeats({ boardCount: 3, potBB: 12.0, bets: { TR: 3.0 } });
  assert.strictEqual(blindSeats.blindsOnly, false);
  assert.strictEqual(blindSeats.reason, 'board-not-empty');
  assert.strictEqual(blindSeats.bb, null);
  const c = Seats.checkSeatOrder(Seats.mapSeats(ALL_SEATS, 'TC'), blindSeats);
  assert.strictEqual(c.inconclusive, true);
  assert.ok(!surfaces(c));
});

test('withhold: end-to-end — a flop snapshot assembles but the check withholds', () => {
  const snap = confirmedBlindsOnly({ button: 'TC', bets: { TR: 3.0 }, board: ['8h', 'Jd', '2d'], pot: 12.0 });
  const r = A.assembleRequest(snap, { heroBet: 0, BB_CHIPS });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.seatCheck.inconclusive, true);
  assert.ok(!surfaces(r.seatCheck), 'mid-hand frames never raise the seat-order stop');
});

test('withhold: ambiguous — two seats read 1.0 → no anchor (no false pass/mismatch)', () => {
  const blindSeats = Seats.deriveBlindSeats({ boardCount: 0, potBB: 1.5, bets: { TL: 1.0, BR: 1.0 } });
  assert.strictEqual(blindSeats.bb, null, 'two BB candidates ⇒ ambiguous ⇒ no anchor');
});

// ── deriveBlindSeats unit coverage (the input swap itself) ─────────────────────
test('deriveBlindSeats: both blinds read → sb/bb from bets', () => {
  const b = Seats.deriveBlindSeats({ boardCount: 0, potBB: 1.5, bets: { BC: 1.0, BR: 0.5 } });
  assert.deepStrictEqual({ sb: b.sb, bb: b.bb, source: b.source, blindsOnly: b.blindsOnly },
    { sb: 'BR', bb: 'BC', source: 'bets', blindsOnly: true });
});

test('deriveBlindSeats: pot not ~1.5 → not a blinds-only start', () => {
  const b = Seats.deriveBlindSeats({ boardCount: 0, potBB: 4.5, bets: { BC: 1.0, BR: 0.5 } });
  assert.strictEqual(b.blindsOnly, false);
  assert.strictEqual(b.reason, 'pot-not-blinds-only');
  assert.strictEqual(b.bb, null);
});

test('deriveBlindSeats: explicit "BB"/"SB" LABELS are the preferred anchor (future)', () => {
  // labels present + agree with bets → label-sourced; proves the slot works today.
  const b = Seats.deriveBlindSeats({ boardCount: 0, potBB: 1.5, bets: { BC: 1.0, BR: 0.5 },
    labels: { BC: 'BB', BR: 'SB' } });
  assert.strictEqual(b.bb, 'BC');
  assert.strictEqual(b.sb, 'BR');
  assert.strictEqual(b.source, 'labels');
});

test('deriveBlindSeats: label vs bet disagree on the anchor → withhold the anchor', () => {
  const b = Seats.deriveBlindSeats({ boardCount: 0, potBB: 1.5, bets: { BC: 1.0 }, labels: { BR: 'BB' } });
  assert.strictEqual(b.bb, null, 'conflicting anchor signals ⇒ no anchor (no false mismatch)');
  assert.strictEqual(b.reason, 'anchor-label-bet-disagree');
});

// ── a confirmed-snapshot builder for the end-to-end assembler paths ───────────
// Mirrors the SettleDebouncer.push() output shape (phase3 builders). A blinds-only
// hand start: empty board by default, all six seats occupied, hero(BC) stack read.
function confirmedBlindsOnly(o) {
  o = o || {};
  const C = (value) => ({ value, status: 'read', confirmed: true, stable: true });
  const EMPTY = { value: null, status: 'no-read', confirmed: false, stable: true };
  const cells = (codes, total) => ({
    value: Array.from({ length: total }, (_, i) =>
      i < codes.length ? { code: codes[i], status: 'read' } : { code: null, status: 'no-read' }),
    status: 'read', confirmed: true,
  });
  const bets = {};
  for (const s of ALL_SEATS) bets[s] = (o.bets && o.bets[s] != null) ? C(o.bets[s]) : EMPTY;
  return {
    stacks: { TL: C(100), TC: C(100), TR: C(100), BR: C(100), BC: C(50), BL: C(100) },
    bets,
    pot: C(o.pot != null ? o.pot : 1.5),
    button: { value: o.button || 'TR', status: 'read', confirmed: true, stable: true },
    board: cells(o.board || [], 5),
    heroHole: cells(['Ac', '2h'], 2),
  };
}
