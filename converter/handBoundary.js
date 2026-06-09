// converter/handBoundary.js — hand-boundary detection (§0.7) + the lifecycle
// hook that resets Layer 2 (debouncer) and Layer 4 (action_history) at every
// boundary (CONVERTER_BUILD_SPEC §2 Layer 4, §0.7).
//
// §0.7 is OVER-DETERMINED — five redundant absolute signals fire together at
// every boundary with ZERO mid-hand false fires. We require ≥2 of the primary
// three to agree:
//   S1  board count → 0   OR   pot collapses to ~1.5 BB (= SB+BB)
//   S2  ≥2 stacks jumped
//   S3  button moved one seat
// Mid-hand, none of S1/S3 can fire (pot only grows, board only gains cards,
// button is fixed); S2 alone can fire when players bet, but one signal is not a
// boundary. At a real boundary (fast-fold: a whole new table) all three fire.
//
// UMD: `window.PokerHandBoundary` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerHandBoundary = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    BB_CHIPS: 100,
    potResetMaxBB: 1.6,   // pot at/below this (BB) counts as "reset to blinds"
    stackJumpBB: 0.5,     // a per-seat stack change above this (BB) is a "jump"
    minSignals: 2,        // ≥2 of the primary three ⇒ boundary
  };

  // A snapshot for boundary comparison:
  //   { boardCount:int, potChips:int|null, buttonSeat:str|null,
  //     stacks: {seat: chips} }   (only confirmed-read seats present)
  // Compare `curr` to `prev`. Returns { boundary, signals, count }.
  function detectBoundary(prev, curr, opts) {
    opts = opts || {};
    const BB = opts.BB_CHIPS != null ? opts.BB_CHIPS : DEFAULTS.BB_CHIPS;
    const potResetMax = (opts.potResetMaxBB != null ? opts.potResetMaxBB : DEFAULTS.potResetMaxBB) * BB;
    const jump = (opts.stackJumpBB != null ? opts.stackJumpBB : DEFAULTS.stackJumpBB) * BB;
    const minSignals = opts.minSignals != null ? opts.minSignals : DEFAULTS.minSignals;

    if (!prev) return { boundary: false, signals: {}, count: 0, reason: 'no-prev' };

    const boardReset = prev.boardCount > 0 && curr.boardCount === 0;
    const potReset = prev.potChips != null && curr.potChips != null
      && prev.potChips > potResetMax && curr.potChips <= potResetMax;
    const S1 = boardReset || potReset;

    let jumped = 0;
    for (const seat of Object.keys(curr.stacks || {})) {
      if (prev.stacks && prev.stacks[seat] != null && curr.stacks[seat] != null) {
        if (Math.abs(curr.stacks[seat] - prev.stacks[seat]) > jump) jumped++;
      }
    }
    const S2 = jumped >= 2;

    const S3 = prev.buttonSeat != null && curr.buttonSeat != null
      && prev.buttonSeat !== curr.buttonSeat;

    // Confirming (fast-fold roster swap): the occupied set changed.
    const prevSeats = Object.keys(prev.stacks || {}).sort().join(',');
    const currSeats = Object.keys(curr.stacks || {}).sort().join(',');
    const rosterSwap = prevSeats !== currSeats;

    const signals = { boardReset, potReset, S1, twoStacksJumped: S2, buttonMoved: S3, rosterSwap, jumped };
    const count = (S1 ? 1 : 0) + (S2 ? 1 : 0) + (S3 ? 1 : 0);
    return { boundary: count >= minSignals, signals, count };
  }

  // Lifecycle: feed each settled snapshot; on a detected boundary it resets the
  // debouncer (Layer 2) and the history (Layer 4) so nothing carries across
  // hands. Holds only the previous snapshot for comparison — no game state.
  class HandLifecycle {
    constructor(deps, opts) {
      this.debouncer = deps && deps.debouncer;   // SettleDebouncer
      this.history = deps && deps.history;        // ActionHistory (Layer 4)
      this.opts = opts || {};
      this._prev = null;
    }
    // Returns the boundary result; callers may inspect it. Side effect: resets
    // Layer 2 + Layer 4 on a boundary BEFORE this frame's reads are trusted.
    onSnapshot(snapshot) {
      const res = detectBoundary(this._prev, snapshot, this.opts);
      if (res.boundary) {
        if (this.debouncer && this.debouncer.reset) this.debouncer.reset();
        if (this.history && this.history.reset) this.history.reset();
      }
      this._prev = snapshot;
      return res;
    }
    reset() { this._prev = null; }
  }

  return { DEFAULTS, detectBoundary, HandLifecycle };
});
