// converter/escalate.js — the wait/escalate rule (CONVERTER_BUILD_SPEC §5).
//
// The ONLY place the converter ever shows the human an error, and only as a last
// resort. The rule:
//   • Not hero's turn, or no clean read but plenty of clock → WAIT SILENTLY. The
//     normal case; resolves in a fraction of a second at 250 ms. No UI noise.
//   • Hero's turn + a clean assembled snapshot (advice in hand) → ADVISE.
//   • Hero's turn + no clean read + the action clock is LOW → ESCALATE: a visible
//     "can't read state — decide manually". Better an honest hand-off than
//     silence-until-autofold or a fabricated snapshot.
//
// Escalation source priority (§5): the poll-counter is the GUARANTEED FLOOR — it
// needs zero timer pixels, so it fires even if the green bar can't be read. The
// green-bar fraction makes escalation *accurate* (earlier when the clock is
// genuinely low) but is LIVE-UNVALIDATED (§0.9/§6), so it must NEVER be the only
// trigger. Escalate on whichever fires FIRST.
//
// `timerLowFrac` and `maxPolls` are §6 LIVE-VALIDATION items — confirm at first
// bring-up that the poll floor fires before autofold and calibrate the bar
// threshold across its real drain.
//
// UMD: `window.PokerEscalate` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerEscalate = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    timerLowFrac: 0.25,  // green bar at/below this fraction ⇒ clock low (refines)
    maxPolls: 40,        // ~10 s at 250 ms — the GUARANTEED floor (timer-free)
  };

  // States: 'idle' (not hero's turn) | 'advising' (clean read, advice shown) |
  //         'waiting' (hero's turn, no read, clock OK — silent) |
  //         'escalate' (hero's turn, no read, clock low — show "decide manually").
  class Escalator {
    constructor(opts) {
      opts = opts || {};
      this.timerLowFrac = opts.timerLowFrac != null ? opts.timerLowFrac : DEFAULTS.timerLowFrac;
      this.maxPolls = opts.maxPolls != null ? opts.maxPolls : DEFAULTS.maxPolls;
      this._polls = 0;
    }
    reset() { this._polls = 0; }

    // Called once per frame.
    //   heroToAct     : debounced/confirmed turn signal
    //   hasAdvice     : a clean snapshot was assembled+answered this turn
    //   timerFraction : green-bar fill 0..1, or null if unreadable
    // Returns { state, reason, polls }.
    update({ heroToAct, hasAdvice, timerFraction }) {
      if (!heroToAct) { this._polls = 0; return { state: 'idle', reason: null, polls: 0 }; }
      if (hasAdvice) { this._polls = 0; return { state: 'advising', reason: null, polls: 0 }; }

      // hero's turn, still no clean read → on the clock
      this._polls += 1;
      const pollFloor = this._polls >= this.maxPolls;                       // guaranteed, timer-free
      const timerLow = timerFraction != null && timerFraction <= this.timerLowFrac; // refines (unvalidated)
      if (pollFloor || timerLow) {
        return { state: 'escalate', reason: pollFloor ? 'poll-floor' : 'timer-low', polls: this._polls };
      }
      return { state: 'waiting', reason: null, polls: this._polls };
    }
  }

  return { Escalator, DEFAULTS };
});
