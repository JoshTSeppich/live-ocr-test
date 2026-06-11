// advisor/advisor-stub.js — the test harness AND the demo (STEP 2).
//
// An in-process emitter that drives an AdvisorEvent bus through the full panel
// lifecycle at realistic timing:
//   settling (1–3 s) → thinking (~200 ms) → advice | wait | escalate
//   with random stale flips, wait/escalate hands, and rapid-fire hands.
//
// The scenario ORDER is deterministic (a fixed script that exercises every
// contract item exactly once, then loops) so the STEP-4 evidence pass is
// reproducible; only the within-range jitter uses a seeded PRNG. Timer is
// injectable (browser setTimeout by default) so a test can run it fast.
//
// UMD: self-registers window.AdvisorStub; CommonJS-exportable for node.
(function (root, factory) {
  const m = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  root.AdvisorStub = m;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const BB = 100; // chips per big blind (display-edge conversion reference)

  // mulberry32 — tiny deterministic PRNG (no Math.random, reproducible demo).
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The deterministic script — every contract case appears here:
  //   all six action types · sizing present/absent · fallback_used on/off ·
  //   a stale flip · a brain-wait · an eyes-escalate · a rapid-fire pair.
  const SCENARIOS = [
    { tag: 'fold',            action: 'fold' },
    { tag: 'check',           action: 'check' },
    { tag: 'call',            action: 'call', amountChips: 2 * BB },
    { tag: 'bet',             action: 'bet',  sizing: { raiseToChips: 3 * BB, raiseByChips: 3 * BB, potPct: 50 } },
    { tag: 'raise',           action: 'raise', amountChips: 7.5 * BB, sizing: { raiseToChips: 7.5 * BB, raiseByChips: 5 * BB, potPct: 66 } },
    { tag: 'raise+fallback',  action: 'raise', fallbackUsed: true, amountChips: 9 * BB, sizing: { raiseToChips: 9 * BB, raiseByChips: 6 * BB, potPct: 75 } },
    { tag: 'allin',           action: 'allin', amountChips: 50 * BB },
    { tag: 'wait',            wait: true },
    { tag: 'escalate',        escalate: true },
    { tag: 'advice→stale',    action: 'raise', staleAfter: true, sizing: { raiseToChips: 4 * BB, raiseByChips: 2.5 * BB, potPct: 40 } },
    { tag: 'rapid-1',         action: 'call', amountChips: 1 * BB, rapid: true },
    { tag: 'rapid-2',         action: 'bet',  rapid: true, sizing: { raiseToChips: 2 * BB, raiseByChips: 2 * BB, potPct: 33 } },
  ];

  // Default timing (ms). Overridable for a fast deterministic test pass.
  const TIMING = {
    settleMin: 1000, settleMax: 3000, // settling window
    settleRapid: 350,                 // rapid-fire settling
    thinking: 200,                    // thinking before reply
    adviceHold: 2500,                 // how long advice stays before next hand
    blockHold: 2200,                  // wait/escalate hold
    staleDelay: 700,                  // advice → stale flip delay
    gap: 400,                         // between hands
  };

  // Create a stub bound to a bus. opts: { timer, clear, seed, timing, scenarios, loop, urgencyTick }
  function createStub(bus, opts) {
    opts = opts || {};
    const setT = opts.timer || ((fn, ms) => root.setTimeout(fn, ms));
    const clrT = opts.clear || ((id) => root.clearTimeout(id));
    const timing = Object.assign({}, TIMING, opts.timing || {});
    const scenarios = opts.scenarios || SCENARIOS;
    const loop = opts.loop !== false;
    const rand = rng(opts.seed != null ? opts.seed : 1);

    let seq = 0;
    let idx = 0;
    let timers = [];
    let running = false;
    let pollTimer = null;
    let pollCount = 0;
    let turnStart = 0;

    const at = (ms, fn) => { const id = setT(fn, ms); timers.push(id); return id; };
    const clearAll = () => { timers.forEach(clrT); timers = []; if (pollTimer) { clrT(pollTimer); pollTimer = null; } };

    // urgency proxy: a poll counter ticking since the action panel appeared.
    function startPolls() {
      pollCount = 0; turnStart = 0;
      const tick = () => {
        pollCount += 1; turnStart += 250;
        pollTimer = setT(tick, 250);
      };
      pollTimer = setT(tick, 250);
    }
    function urgency(timerFrac) {
      return { polls: pollCount, elapsedMs: turnStart, timerFrac: timerFrac == null ? null : timerFrac };
    }
    function stopPolls() { if (pollTimer) { clrT(pollTimer); pollTimer = null; } }

    function emit(evt) { try { bus.publish(evt); } catch (e) { if (root.console) root.console.warn('[stub] bad event', e, evt); } }

    function runHand() {
      if (!running) return;
      const sc = scenarios[idx % scenarios.length];
      const snapSeq = ++seq;
      const settleMs = sc.rapid
        ? timing.settleRapid
        : Math.round(timing.settleMin + rand() * (timing.settleMax - timing.settleMin));

      // 1) settling — frame not stable yet. start the urgency poll counter.
      startPolls();
      emit({ kind: 'settling', seq: snapSeq, bbChips: BB, urgency: urgency(0.95) });

      // 2) thinking — snapshot sent, awaiting brain.
      at(settleMs, () => {
        if (!running) return;
        emit({ kind: 'thinking', seq: snapSeq, bbChips: BB, urgency: urgency(0.7) });

        // 3) outcome.
        at(timing.thinking, () => {
          if (!running) return;
          if (sc.wait) {
            emit({ kind: 'wait', seq: snapSeq, bbChips: BB, urgency: urgency(0.5) });
          } else if (sc.escalate) {
            emit({ kind: 'escalate', seq: snapSeq, bbChips: BB, urgency: urgency(0.12) });
          } else {
            emit({
              kind: 'advice', seq: snapSeq, action: sc.action,
              amountChips: sc.amountChips != null ? sc.amountChips : null,
              sizing: sc.sizing || null,
              fallbackUsed: !!sc.fallbackUsed,
              bbChips: BB, urgency: urgency(0.6),
            });
            // 3b) optional stale flip: a NEWER snapshot supersedes this advice.
            if (sc.staleAfter) {
              at(timing.staleDelay, () => {
                if (!running) return;
                emit({ kind: 'stale', seq: snapSeq + 1, bbChips: BB, urgency: urgency(0.3) });
                seq = snapSeq + 1;
              });
            }
          }
          stopPolls();

          // 4) next hand.
          const hold = (sc.wait || sc.escalate) ? timing.blockHold
                     : sc.staleAfter ? timing.staleDelay + timing.blockHold
                     : timing.adviceHold;
          at(hold + timing.gap, () => {
            idx += 1;
            if (idx >= scenarios.length && !loop) { running = false; return; }
            runHand();
          });
        });
      });
    }

    return {
      start() { if (running) return; running = true; idx = 0; seq = 0; runHand(); },
      stop() { running = false; clearAll(); stopPolls(); },
      get running() { return running; },
      get scenarios() { return scenarios; },
      get currentSeq() { return seq; },
    };
  }

  return { createStub, SCENARIOS, TIMING, BB };
});
