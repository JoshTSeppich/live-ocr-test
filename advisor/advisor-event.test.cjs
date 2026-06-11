// advisor/advisor-event.test.cjs — the display-seam contract: normalize/validate,
// BB conversion at the edge, the pub/sub bus, and the converter→AdvisorEvent
// adapter (the production mapping). Parity with the converter's node tests.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const AE = require('./advisor-event.js');

test('toBB converts chips→BB at the display edge, guards bad inputs', () => {
  assert.equal(AE.toBB(750, 100), 7.5);
  assert.equal(AE.toBB(250, 100), 2.5);
  assert.equal(AE.toBB(null, 100), null);
  assert.equal(AE.toBB(100, 0), null);
  assert.equal(AE.toBB(100, null), null);
});

test('normalize accepts a valid advice and fills defaults', () => {
  const n = AE.normalize({ kind: 'advice', seq: 5, action: 'raise', amountChips: 750, bbChips: 100,
    sizing: { raiseToChips: 750, raiseByChips: 500, potPct: 66 } });
  assert.equal(n.kind, 'advice');
  assert.equal(n.verb, 'RAISE');
  assert.equal(n.fallbackUsed, false);
  assert.deepEqual(n.urgency, { polls: 0, elapsedMs: 0, timerFrac: null });
  assert.equal(n.sizing.raiseByChips, 500);
});

test('normalize throws on bad kind / non-finite seq / bad advice action', () => {
  assert.throws(() => AE.normalize({ kind: 'nope', seq: 1 }), /bad kind/);
  assert.throws(() => AE.normalize({ kind: 'advice', seq: NaN, action: 'fold' }), /seq/);
  assert.throws(() => AE.normalize({ kind: 'advice', seq: 1, action: 'jump' }), /valid action/);
});

test('normalize drops sizing for non bet/raise actions', () => {
  const n = AE.normalize({ kind: 'advice', seq: 1, action: 'call', amountChips: 200,
    sizing: { raiseToChips: 999 } });
  assert.equal(n.sizing, null);
  assert.equal(n.amountChips, 200);
});

test('createBus normalizes on publish and isolates a throwing subscriber', () => {
  const bus = AE.createBus();
  const got = [];
  bus.subscribe(() => { throw new Error('bad subscriber'); });
  bus.subscribe((n) => got.push(n));
  const ret = bus.publish({ kind: 'wait', seq: 9 });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'wait');
  assert.equal(ret.seq, 9);
});

test('mapAction normalizes the brain vocabulary (+ variants) to the 6 actions', () => {
  assert.equal(AE.mapAction('fold'), 'fold');
  assert.equal(AE.mapAction('foldview'), 'fold');
  assert.equal(AE.mapAction('CHECK'), 'check');
  assert.equal(AE.mapAction('all-in'), 'allin');
  assert.equal(AE.mapAction('all_in'), 'allin');
  assert.equal(AE.mapAction('double'), 'raise');
  assert.equal(AE.mapAction('weird'), null);
  // falls back to abstractAction when the primary is unknown
  assert.equal(AE.mapAction('weird', 'raise'), 'raise');
});

// ── the production adapter ────────────────────────────────────────────────
const REQUEST = { hero_seat: 1, current_bets: [50, 100, 0], pot_committed: 600, max_raise: 5000, to_call: 50 };

test('fromConverter: idle / waiting / sent map to settling vs thinking', () => {
  assert.equal(AE.fromConverter({ view: { state: 'idle' } }).kind, 'settling');
  assert.equal(AE.fromConverter({ view: { state: 'waiting' }, sentThisTurn: false }).kind, 'settling');
  assert.equal(AE.fromConverter({ view: { state: 'waiting' }, sentThisTurn: true }).kind, 'thinking');
});

test('fromConverter: escalate maps to escalate (eyes failed)', () => {
  assert.equal(AE.fromConverter({ view: { state: 'escalate' } }).kind, 'escalate');
});

test('fromConverter: advising raise derives the three sizing forms in chips', () => {
  const e = AE.fromConverter({
    view: { state: 'advising' },
    advice: { action: 'raise', amount: 400, fallbackUsed: false, seq: 12 },
    request: REQUEST, bbChips: 100, polls: 4, timerFrac: 0.6,
  });
  assert.equal(e.kind, 'advice');
  assert.equal(e.action, 'raise');
  assert.equal(e.seq, 12);
  assert.equal(e.sizing.raiseToChips, 400);
  assert.equal(e.sizing.raiseByChips, 300);   // 400 - hero current_bets[1]=100
  assert.equal(e.sizing.potPct, 67);          // round(400/600*100)
  assert.equal(e.urgency.polls, 4);
  // round-trips through normalize cleanly
  assert.doesNotThrow(() => AE.normalize(e));
});

test('fromConverter: a raise-to >= all-in total is reclassified all-in', () => {
  const e = AE.fromConverter({
    view: { state: 'advising' },
    advice: { action: 'raise', amount: 5000, seq: 3 },
    request: REQUEST,
  });
  assert.equal(e.action, 'allin');
});

test('fromConverter: fallback_used flows through', () => {
  const e = AE.fromConverter({
    view: { state: 'advising' },
    advice: { action: 'bet', amount: 300, fallbackUsed: true, seq: 7 },
    request: REQUEST,
  });
  assert.equal(e.fallbackUsed, true);
  assert.equal(e.kind, 'advice');
});

test('fromConverter: an unparseable advised action degrades to WAIT, never a fake verb', () => {
  const e = AE.fromConverter({
    view: { state: 'advising' },
    advice: { action: 'sklansky-bucket-9', seq: 4 },
    request: REQUEST,
  });
  assert.equal(e.kind, 'wait');
});
