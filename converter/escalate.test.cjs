// converter/escalate.test.cjs — §5 wait/escalate: silent-wait, advise, and
// escalate only when the clock is low, with the poll-counter as a timer-free floor.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Escalator } = require('./escalate.js');

test('not hero turn → idle, silent', () => {
  const e = new Escalator();
  assert.strictEqual(e.update({ heroToAct: false }).state, 'idle');
});

test('hero turn with advice → advising', () => {
  const e = new Escalator();
  assert.strictEqual(e.update({ heroToAct: true, hasAdvice: true, timerFraction: 0.9 }).state, 'advising');
});

test('hero turn, no read, comfortable clock → waiting (silent)', () => {
  const e = new Escalator({ maxPolls: 40 });
  const r = e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  assert.strictEqual(r.state, 'waiting');
});

test('timer low escalates early (reason timer-low)', () => {
  const e = new Escalator({ timerLowFrac: 0.25, maxPolls: 40 });
  const r = e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.2 });
  assert.strictEqual(r.state, 'escalate');
  assert.strictEqual(r.reason, 'timer-low');
});

test('poll-counter floor escalates even with NO timer reading (the guarantee)', () => {
  const e = new Escalator({ maxPolls: 3, timerLowFrac: 0.25 });
  let r;
  for (let i = 0; i < 3; i++) r = e.update({ heroToAct: true, hasAdvice: false, timerFraction: null });
  assert.strictEqual(r.state, 'escalate');
  assert.strictEqual(r.reason, 'poll-floor');
});

test('escalates on whichever fires first (timer before the poll floor)', () => {
  const e = new Escalator({ maxPolls: 100, timerLowFrac: 0.25 });
  e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 }); // waiting
  const r = e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.1 }); // timer drops
  assert.strictEqual(r.state, 'escalate');
  assert.strictEqual(r.reason, 'timer-low'); // fired well before poll 100
});

test('poll counter resets when the turn ends or advice arrives', () => {
  const e = new Escalator({ maxPolls: 3 });
  e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  assert.strictEqual(e.update({ heroToAct: false }).polls, 0); // turn ended → reset
  // a fresh turn starts the floor over
  const r = e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  assert.strictEqual(r.polls, 1);
});

test('advice mid-wait clears the escalation path', () => {
  const e = new Escalator({ maxPolls: 3 });
  e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  e.update({ heroToAct: true, hasAdvice: false, timerFraction: 0.9 });
  const r = e.update({ heroToAct: true, hasAdvice: true, timerFraction: 0.9 });
  assert.strictEqual(r.state, 'advising');
  assert.strictEqual(r.polls, 0);
});
