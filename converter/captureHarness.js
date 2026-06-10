// converter/captureHarness.js — Phase 5: the live-bring-up INSTRUMENT
// (CONVERTER_BUILD_SPEC §5/§6). NOT just another phase — this is the FIRST thing
// run against a real table, with the settle gate DISABLED, recording EVERY
// 250 ms frame so the two questions a settled-frame recording cannot answer get
// answered live:
//
//   §6.1 GREEN-BAR FULL DRAIN — does timerFraction read correctly as the bar
//        actually drains (1.0 → 0), or only near-full? Drives the §5 escalation
//        threshold and tells us whether to trust the bar at all.
//   §6.2 LIVE SETTLE-N — how often do live frames land mid-animation vs settled,
//        and how many consecutive frames agree once settled (the debouncer N).
//
// This file is the PURE, testable analysis core: a perceptual frame hash, a
// recorder that logs per-frame {ts, frameHash, timer, heroToAct}, and a summary
// that computes the mid-animation rate, the settle-run distribution, and the
// per-hero-turn timer-drain trajectories. The browser harness (harness.jsx)
// computes the hash from the live crop and feeds record(); analysis runs here.
//
// UMD: `window.PokerCaptureHarness` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerCaptureHarness = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 64-bit perceptual hash of an RGBA crop (dHash): downsample to 9×8 grayscale,
  // compare each pixel to its right neighbor → 64 bits as a '0'/'1' string. A
  // matcher-independent "did the table move?" signal for the settle measurement.
  function dhashRgba(crop, gw, gh) {
    gw = gw || 9; gh = gh || 8;
    const { rgba, w, h } = crop;
    const g = new Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / gw));
        const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / gh));
        const i = (sy * w + sx) * 4;
        g[y * gw + x] = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]); // V channel
      }
    }
    let bits = '';
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw - 1; x++) bits += g[y * gw + x] > g[y * gw + x + 1] ? '1' : '0';
    return bits; // length (gw-1)*gh = 64
  }

  function hammingBits(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  class CaptureRecorder {
    constructor(opts) {
      opts = opts || {};
      this.diffThreshold = opts.diffThreshold != null ? opts.diffThreshold : 3; // ≤ ⇒ "same frame"
      this.rows = [];
    }
    // row: { ts:ms, frameHash:string, timer:number|null, heroToAct:bool }
    record(row) {
      this.rows.push({
        ts: row.ts, frameHash: row.frameHash,
        timer: row.timer != null ? row.timer : null,
        heroToAct: !!row.heroToAct,
      });
    }
    clear() { this.rows = []; }

    summary(opts) {
      opts = opts || {};
      const thr = opts.diffThreshold != null ? opts.diffThreshold : this.diffThreshold;
      const rows = this.rows;
      const n = rows.length;
      if (n === 0) return { frameCount: 0 };

      // frame-to-frame movement → mid-animation rate + settle runs
      let changes = 0;
      const runLengths = [];
      let run = 1;
      for (let i = 1; i < n; i++) {
        const moved = hammingBits(rows[i].frameHash, rows[i - 1].frameHash) > thr;
        if (moved) { changes++; runLengths.push(run); run = 1; } else { run++; }
      }
      runLengths.push(run);
      const transitions = n - 1;
      const midAnimationRate = transitions > 0 ? changes / transitions : 0;

      // settle-run distribution (consecutive frames that stayed still)
      const sorted = runLengths.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor((sorted.length - 1) / 2)];
      const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
      const runHistogram = {};
      for (const L of runLengths) runHistogram[L] = (runHistogram[L] || 0) + 1;

      // per-hero-turn timer drains (§6.1): each maximal heroToAct run → trajectory
      const timerDrains = [];
      let seg = null;
      for (let i = 0; i < n; i++) {
        if (rows[i].heroToAct) {
          if (!seg) seg = [];
          seg.push({ ts: rows[i].ts, timer: rows[i].timer });
        } else if (seg) { timerDrains.push(summarizeDrain(seg)); seg = null; }
      }
      if (seg) timerDrains.push(summarizeDrain(seg));

      return {
        frameCount: n,
        durationMs: rows[n - 1].ts - rows[0].ts,
        midAnimationRate,
        settleRun: { median, p90, histogram: runHistogram },
        timerDrains,
      };
    }
  }

  // A drain trajectory: does the bar fall ~monotonically from near-full toward 0?
  function summarizeDrain(samples) {
    const vals = samples.map((s) => s.timer).filter((v) => v != null);
    let firstTimer = vals.length ? vals[0] : null;
    let lastTimer = vals.length ? vals[vals.length - 1] : null;
    let min = null, max = null, nonIncreasingSteps = 0, steps = 0;
    for (let i = 0; i < vals.length; i++) {
      min = min == null ? vals[i] : Math.min(min, vals[i]);
      max = max == null ? vals[i] : Math.max(max, vals[i]);
      if (i > 0) { steps++; if (vals[i] <= vals[i - 1] + 0.02) nonIncreasingSteps++; }
    }
    return {
      samples: samples.length, readSamples: vals.length,
      startMs: samples[0].ts, endMs: samples[samples.length - 1].ts,
      durationMs: samples[samples.length - 1].ts - samples[0].ts,
      firstTimer, lastTimer, minTimer: min, maxTimer: max,
      monotonicFraction: steps > 0 ? nonIncreasingSteps / steps : null, // ~1.0 = clean drain
      drained: firstTimer != null && lastTimer != null && (firstTimer - lastTimer) > 0.2, // bar visibly fell
    };
  }

  return { dhashRgba, hammingBits, CaptureRecorder, summarizeDrain };
});
