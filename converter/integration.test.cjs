// converter/integration.test.cjs — Layer 1 output → real Layer 2 debouncer →
// Layer 3 assembler. Confirms the inter-layer shapes actually compose end to end.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('./settle.js');
const A = require('./assembler.js');

// A Layer-1 TableObservation (observeFrame output shape), all seats occupied,
// flop, hero(BC) stack 50bb, villain TR bet 3bb.
function tableObs() {
  const rd = (v) => ({ value: v, status: 'read' });
  const nor = { value: null, status: 'no-read' };
  const cell = (code) => ({ code, status: 'read' });
  return {
    stacks: { TL: rd(100), TC: rd(100), TR: rd(100), BR: rd(100), BC: rd(50), BL: rd(100) },
    bets: { TL: nor, TC: nor, TR: rd(3), BR: nor, BC: { value: 0, status: 'read', source: 'hero-action' }, BL: nor },
    pot: rd(5),
    button: { seat: 'TC', status: 'read' },
    board: [cell('8h'), cell('Jd'), cell('2d'), { code: null, status: 'no-read' }, { code: null, status: 'no-read' }],
    heroHole: [cell('Ac'), cell('2h')],
    timer: { fraction: 1, status: 'read' },
    turn: { heroToAct: true, status: 'read' },
  };
}

test('end-to-end: Layer1 obs → SettleDebouncer(n=2) → assembleRequest', () => {
  const deb = new S.SettleDebouncer({ n: 2, settleN: 2 });
  const obs = tableObs();
  let confirmed = deb.push(obs);
  // first frame: nothing confirmed yet → assembler withholds
  assert.strictEqual(A.assembleRequest(confirmed, { heroBet: 0 }).ok, false);
  // second identical frame: confirmed → assembler produces a valid request
  confirmed = deb.push(obs);
  assert.strictEqual(confirmed.settled, true);
  assert.strictEqual(confirmed.heroToAct, true);
  const r = A.assembleRequest(confirmed, { heroBet: 0, blindSeats: { sb: 'TR', bb: 'BR' } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.missing));
  assert.strictEqual(r.request.table_size, 6);
  assert.deepStrictEqual(r.request.board, ['8h', 'Jd', '2d']);
  assert.deepStrictEqual(r.request.hero_hole, ['Ac', '2h']);
  assert.deepStrictEqual(r.request.current_bets, [0, 0, 300, 0, 0, 0]);
  assert.strictEqual(r.request.pot_committed, 800);
  assert.strictEqual(r.seatCheck.ok, true);
  // envelope round-trips
  const env = A.buildEnvelope(1, r.request);
  assert.deepStrictEqual(Object.keys(env).sort(), ['request', 'seq']);
});
