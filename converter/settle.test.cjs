// converter/settle.test.cjs — Phase 2 Layer-2 settle gate + debounce tests.
// Run: node --test converter/settle.test.cjs
// Asserts the FILTER properties: N-consecutive confirmation, flicker reset,
// occlusion breaks confirmation, the settle gate (derived + external key),
// mid-animation never settles, and the never-sums invariant.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('./settle.js');
const R = require('./regions.js');

// Build a Layer-1-shaped TableObservation. `over` patches individual fields,
// e.g. obs({ 'stack_TL': occ, pot: {value:1.5,status:'read'} }).
function read(v) { return { value: v, status: 'read' }; }
const OCC = { value: null, status: 'occluded' };
const NOR = { value: null, status: 'no-read' };
function obs(over) {
  over = over || {};
  const o = { stacks: {}, bets: {}, pot: read(5.4),
    button: { seat: 'TR', status: 'read' },
    timer: { fraction: 1, status: 'read' },
    turn: { heroToAct: true, status: 'read' } };
  for (const s of R.SEATS) {
    o.stacks[s] = over[`stack_${s}`] || read(100);
    o.bets[s] = over[`bet_${s}`] || read(0);
  }
  if (over.pot) o.pot = over.pot;
  if (over.button) o.button = over.button;
  if (over.timer) o.timer = over.timer;
  if (over.turn) o.turn = over.turn;
  if (over.board) o.board = over.board;
  if (over.heroHole) o.heroHole = over.heroHole;
  return o;
}

test('field confirms only after N consecutive identical reads', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  let r = d.push(obs({ pot: read(5.4) }));
  assert.strictEqual(r.pot.confirmed, false, 'first read not yet confirmed');
  assert.strictEqual(r.pot.value, 5.4);
  r = d.push(obs({ pot: read(5.4) }));
  assert.strictEqual(r.pot.confirmed, true, 'second identical read confirms');
});

test('N=3 needs three identical reads', () => {
  const d = new S.SettleDebouncer({ n: 3 });
  assert.strictEqual(d.push(obs({ pot: read(2) })).pot.confirmed, false);
  assert.strictEqual(d.push(obs({ pot: read(2) })).pot.confirmed, false);
  assert.strictEqual(d.push(obs({ pot: read(2) })).pot.confirmed, true);
});

test('value change resets the run (absolute, never summed)', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  d.push(obs({ pot: read(5.4) }));
  let r = d.push(obs({ pot: read(5.4) }));
  assert.strictEqual(r.pot.confirmed, true);
  r = d.push(obs({ pot: read(6.0) }));            // changed
  assert.strictEqual(r.pot.confirmed, false, 'change un-confirms');
  assert.strictEqual(r.pot.value, 6.0, 'reports the LATEST read, not a sum');
  r = d.push(obs({ pot: read(6.0) }));
  assert.strictEqual(r.pot.confirmed, true);
  assert.strictEqual(r.pot.value, 6.0);
});

test('never sums: a wandering stack reports latest value, never accumulation', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  const seq = [100, 95.5, 95.5, 88, 88, 88];
  let last;
  for (const v of seq) last = d.push(obs({ stack_TL: read(v) })).stacks.TL;
  assert.strictEqual(last.value, 88);             // not 100+95.5+...
  assert.ok(last.value < 101);
});

test('occlusion breaks confirmation and is never confirmed', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  d.push(obs({ stack_TL: read(95.5) }));
  let r = d.push(obs({ stack_TL: read(95.5) }));
  assert.strictEqual(r.stacks.TL.confirmed, true);
  r = d.push(obs({ stack_TL: OCC }));             // badge slides over the plate
  assert.strictEqual(r.stacks.TL.confirmed, false);
  assert.strictEqual(r.stacks.TL.status, 'occluded');
  assert.strictEqual(r.stacks.TL.value, null, 'no value while occluded');
  // re-confirm requires N clean reads again
  assert.strictEqual(d.push(obs({ stack_TL: read(95.5) })).stacks.TL.confirmed, false);
  assert.strictEqual(d.push(obs({ stack_TL: read(95.5) })).stacks.TL.confirmed, true);
});

test('no-read never confirms', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  d.push(obs({ pot: NOR }));
  const r = d.push(obs({ pot: NOR }));
  assert.strictEqual(r.pot.confirmed, false, 'two no-reads still not a confirmed value');
});

test('settle gate: identical frames settle after settleN', () => {
  const d = new S.SettleDebouncer({ settleN: 2 });
  let r = d.push(obs());
  assert.strictEqual(r.settled, false, 'one frame is not settled');
  r = d.push(obs());
  assert.strictEqual(r.settled, true, 'two identical frames → settled');
});

test('settle gate: a changed frame is not settled', () => {
  const d = new S.SettleDebouncer({ settleN: 2 });
  d.push(obs());
  d.push(obs());
  const r = d.push(obs({ pot: read(9.9) }));      // table moved
  assert.strictEqual(r.settled, false);
});

test('mid-animation (every frame differs) never settles, never confirms', () => {
  const d = new S.SettleDebouncer({ n: 2, settleN: 2 });
  let r;
  for (let i = 0; i < 6; i++) r = d.push(obs({ pot: read(i * 1.0) })); // pot changes each frame
  assert.strictEqual(r.settled, false);
  assert.strictEqual(r.pot.confirmed, false);
});

test('external stabilityKey overrides the derived key', () => {
  const d = new S.SettleDebouncer({ settleN: 2 });
  // reads differ every frame, but the pixel-diff key says "stable"
  d.push(obs({ pot: read(1) }), { stabilityKey: 'K' });
  const r = d.push(obs({ pot: read(2) }), { stabilityKey: 'K' });
  assert.strictEqual(r.settled, true, 'same pixel key twice → settled despite read change');
  const r2 = d.push(obs({ pot: read(3) }), { stabilityKey: 'DIFFERENT' });
  assert.strictEqual(r2.settled, false);
});

test('turn is debounced: a flicker does not immediately set heroToAct', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  let r = d.push(obs({ turn: { heroToAct: true, status: 'read' } }));
  assert.strictEqual(r.heroToAct, false, 'single turn frame not yet confirmed');
  r = d.push(obs({ turn: { heroToAct: true, status: 'read' } }));
  assert.strictEqual(r.heroToAct, true, 'stable turn confirms');
});

test('timer passes through un-debounced (continuous signal)', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  const r = d.push(obs({ timer: { fraction: 0.42, status: 'read' } }));
  assert.strictEqual(r.timer.fraction, 0.42, 'timer is not filtered');
});

test('button confirms by seat and resets when the puck moves', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  d.push(obs({ button: { seat: 'TR', status: 'read' } }));
  let r = d.push(obs({ button: { seat: 'TR', status: 'read' } }));
  assert.strictEqual(r.button.confirmed, true);
  assert.strictEqual(r.button.value, 'TR'); // confirmed button exposes the seat
  r = d.push(obs({ button: { seat: 'BR', status: 'read' } })); // moved one seat
  assert.strictEqual(r.button.confirmed, false);
});

test('allConfirmed over the mandatory set', () => {
  const d = new S.SettleDebouncer({ n: 1 }); // confirm on first read for brevity
  const r = d.push(obs());
  const mandatory = ['pot', 'button', 'stacks.TL', 'stacks.BC', 'bets.TR'];
  assert.strictEqual(S.allConfirmed(r, mandatory), true);
});

test('reset() clears debounce + settle history', () => {
  const d = new S.SettleDebouncer({ n: 2, settleN: 2 });
  d.push(obs({ pot: read(5.4) }));
  d.push(obs({ pot: read(5.4) }));
  d.reset();
  const r = d.push(obs({ pot: read(5.4) }));
  assert.strictEqual(r.pot.confirmed, false, 'post-reset first read is unconfirmed again');
  assert.strictEqual(r.settled, false);
});

test('hero bet from known action confirms like any stable read', () => {
  const d = new S.SettleDebouncer({ n: 2 });
  const heroBet = { value: 2.5, status: 'read', source: 'hero-action' };
  d.push(obs({ bet_BC: heroBet }));
  const r = d.push(obs({ bet_BC: heroBet }));
  assert.strictEqual(r.bets.BC.confirmed, true);
  assert.strictEqual(r.bets.BC.value, 2.5);
});
