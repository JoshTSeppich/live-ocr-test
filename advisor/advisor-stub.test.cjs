// advisor/advisor-stub.test.cjs — the demo/test emitter drives the FULL panel
// lifecycle. A virtual clock runs the (loop-disabled) script to quiescence and
// we assert it exercises every contract case the STEP-4 evidence shows.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Stub = require('./advisor-stub.js');
const AE = require('./advisor-event.js');

// Deterministic virtual clock: a min-heap-ish queue advanced to empty.
function makeClock() {
  let now = 0, id = 0;
  const q = new Map();
  const timer = (fn, ms) => { const i = ++id; q.set(i, { t: now + ms, fn }); return i; };
  const clear = (i) => q.delete(i);
  function runAll(maxSteps = 200000) {
    let steps = 0;
    while (q.size && steps++ < maxSteps) {
      let ek = null, et = Infinity;
      for (const [k, v] of q) if (v.t < et) { et = v.t; ek = k; }
      const { fn } = q.get(ek); q.delete(ek); now = et; fn();
    }
    if (steps >= maxSteps) throw new Error('clock did not quiesce');
  }
  return { timer, clear, runAll };
}

function runScript() {
  const clock = makeClock();
  const bus = AE.createBus();
  const events = [];
  bus.subscribe((n) => events.push(n));
  const stub = Stub.createStub(bus, { timer: clock.timer, clear: clock.clear, loop: false, seed: 3 });
  stub.start();
  clock.runAll();
  return events;
}

test('a hand opens with settling → thinking before any outcome', () => {
  const ev = runScript();
  assert.equal(ev[0].kind, 'settling');
  assert.equal(ev[1].kind, 'thinking');
  assert.ok(['advice', 'wait', 'escalate'].includes(ev[2].kind));
});

test('the script exercises all six action verbs', () => {
  const actions = new Set(runScript().filter((e) => e.kind === 'advice').map((e) => e.action));
  for (const a of ['fold', 'check', 'call', 'bet', 'raise', 'allin']) {
    assert.ok(actions.has(a), `missing action ${a}`);
  }
});

test('the script emits wait, escalate, and a stale flip', () => {
  const kinds = new Set(runScript().map((e) => e.kind));
  assert.ok(kinds.has('wait'), 'no wait');
  assert.ok(kinds.has('escalate'), 'no escalate');
  assert.ok(kinds.has('stale'), 'no stale');
});

test('at least one advice carries fallback_used and one carries 3-form sizing', () => {
  const ev = runScript();
  assert.ok(ev.some((e) => e.kind === 'advice' && e.fallbackUsed), 'no fallback advice');
  assert.ok(ev.some((e) => e.kind === 'advice' && e.sizing
    && e.sizing.raiseToChips != null && e.sizing.raiseByChips != null && e.sizing.potPct != null),
    'no fully-sized advice');
});

test('a stale flip carries a strictly newer seq than the advice it supersedes', () => {
  const ev = runScript();
  const staleIdx = ev.findIndex((e) => e.kind === 'stale');
  assert.ok(staleIdx > 0);
  // the advice immediately preceding the stale event has a lower seq
  const priorAdvice = ev.slice(0, staleIdx).reverse().find((e) => e.kind === 'advice');
  assert.ok(priorAdvice && ev[staleIdx].seq > priorAdvice.seq);
});
