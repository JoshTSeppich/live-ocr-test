// converter/captureHarness.test.cjs — Phase 5 instrument analysis: the frame
// hash, mid-animation rate, settle-run distribution, and the §6.1 timer-drain
// summary that live bring-up depends on.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('./captureHarness.js');

function crop(w, h, fill) {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { rgba[p * 4] = fill; rgba[p * 4 + 1] = fill; rgba[p * 4 + 2] = fill; rgba[p * 4 + 3] = 255; }
  return { rgba, w, h };
}

test('dhashRgba: 64 bits, identical crop → identical hash, distance 0', () => {
  const a = crop(40, 30, 100);
  const ha = H.dhashRgba(a), hb = H.dhashRgba(crop(40, 30, 100));
  assert.strictEqual(ha.length, 64);
  assert.strictEqual(H.hammingBits(ha, hb), 0);
});

test('dhashRgba: a changed crop differs', () => {
  const a = crop(40, 30, 50); // flat → all "0" bits
  // DECREASING gradient (left brighter than right) → "1" bits → differs from flat
  const b = crop(40, 30, 50);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const i = (y * 40 + x) * 4; const v = (40 - x) * 6; b.rgba[i] = b.rgba[i + 1] = b.rgba[i + 2] = v; }
  assert.ok(H.hammingBits(H.dhashRgba(a), H.dhashRgba(b)) > 0);
});

// helper: a frame hash that is "still" (S) or "moved" (M) relative to a base
const STILL = '0'.repeat(64);
const MOVED = '1'.repeat(64);

test('mid-animation rate: all-still stream → 0; alternating → high', () => {
  const r = new H.CaptureRecorder({ diffThreshold: 3 });
  for (let i = 0; i < 5; i++) r.record({ ts: i * 250, frameHash: STILL, timer: 1, heroToAct: false });
  assert.strictEqual(r.summary().midAnimationRate, 0);

  const r2 = new H.CaptureRecorder({ diffThreshold: 3 });
  for (let i = 0; i < 6; i++) r2.record({ ts: i * 250, frameHash: i % 2 ? MOVED : STILL, timer: 1, heroToAct: false });
  assert.strictEqual(r2.summary().midAnimationRate, 1, 'every transition moved');
});

test('settle-run distribution: long still runs → high median run length', () => {
  const r = new H.CaptureRecorder({ diffThreshold: 3 });
  // 3 still, move, 4 still, move, 2 still
  const seq = [STILL, STILL, STILL, MOVED, STILL, STILL, STILL, STILL, MOVED, STILL, STILL];
  seq.forEach((h, i) => r.record({ ts: i * 250, frameHash: h, timer: 1, heroToAct: false }));
  const s = r.summary();
  // still-stretches 3 and 4 (the settled periods), plus each lone MOVED frame is
  // its own run of 1 → runLengths [3,1,4,1,2]
  assert.strictEqual(s.settleRun.histogram['3'], 1);
  assert.strictEqual(s.settleRun.histogram['4'], 1);
  assert.strictEqual(s.settleRun.histogram['1'], 2, 'the two mid-animation frames');
  assert.strictEqual(s.settleRun.median, 2);
});

test('timer drain (§6.1): a hero turn where the bar falls 1.0→0.2 is flagged drained + monotonic', () => {
  const r = new H.CaptureRecorder();
  const fr = [1.0, 0.8, 0.6, 0.4, 0.2];
  fr.forEach((t, i) => r.record({ ts: i * 250, frameHash: STILL, timer: t, heroToAct: true }));
  const s = r.summary();
  assert.strictEqual(s.timerDrains.length, 1);
  const d = s.timerDrains[0];
  assert.strictEqual(d.drained, true);
  assert.ok(d.monotonicFraction > 0.99, 'a clean monotonic drain');
  assert.strictEqual(d.firstTimer, 1.0);
  assert.strictEqual(d.lastTimer, 0.2);
});

test('timer drain: a bar STUCK at full (the recording artifact) is NOT flagged drained', () => {
  const r = new H.CaptureRecorder();
  [1.0, 1.0, 1.0, 1.0].forEach((t, i) => r.record({ ts: i * 250, frameHash: STILL, timer: t, heroToAct: true }));
  const d = r.summary().timerDrains[0];
  assert.strictEqual(d.drained, false, 'never fell → cannot validate the drain from this');
});

test('separate hero turns → separate drain segments', () => {
  const r = new H.CaptureRecorder();
  const rows = [
    { t: 1.0, hero: true }, { t: 0.5, hero: true },
    { t: null, hero: false },
    { t: 0.9, hero: true }, { t: 0.3, hero: true },
  ];
  rows.forEach((row, i) => r.record({ ts: i * 250, frameHash: STILL, timer: row.t, heroToAct: row.hero }));
  assert.strictEqual(r.summary().timerDrains.length, 2);
});

test('empty recorder summarizes safely', () => {
  assert.strictEqual(new H.CaptureRecorder().summary().frameCount, 0);
});
