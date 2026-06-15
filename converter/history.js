// converter/history.js — Layer 4: DISPOSABLE, hand-scoped action_history
// (CONVERTER_BUILD_SPEC §2 Layer 4, §1).
//
// This layer is SUBORDINATE and its failure is silent and harmless. It derives
// action_history best-effort from confirmed bet/stack deltas, BUT:
//   • [] is ALWAYS the safe fallback. On ANY inconsistency the whole hand's
//     history is dropped to [] — never emit a malformed or guessed entry.
//   • It must NEVER block or corrupt the mandatory fields. The assembler treats
//     its output as optional and re-validates it anyway.
//   • RESET to [] at every hand boundary (HandLifecycle calls reset()).
//
// Derivation: a seat whose this-street bet rises by Δ while its stack falls by ~Δ
// took an action of size Δ. type from the bet's relation to the prior max bet:
//   prior max 0 + new bet  → bet ; new bet > prior max → raise ;
//   new bet == prior max    → call ; stack hit 0 → all-in.
// Checks (Δ=0) and folds are NOT derived (indistinguishable from "hasn't acted"
// on frame deltas) — omitting them is safe; the brain runs without them.
//
// amount = Δ = chips committed BY THAT ACTION (not cumulative), per the contract.
//
// UMD: `window.PokerHistory` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerHistory = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ActionHistory {
    constructor(opts) {
      // §3b reconciliation tolerance: ±0.02 BB (= 2 chips at the canonical
      // BB_CHIPS=100). Chico's BB display rounds to 2 decimals, so exact equality
      // here rejects good frames. The stack/bet-delta reconciliation below uses
      // this band, not exact equality.
      this.tol = (opts && opts.tol != null) ? opts.tol : 2;
      this.reset();
    }
    reset() { this.entries = []; this._valid = true; this.street = 0; }
    setStreet(s) {
      if (Number.isInteger(s) && s >= 0 && s <= 3) this.street = s;
    }

    // Feed a confirmed transition. prev/curr: { bets:{seat:chips}, stacks:
    // {seat:chips} } over the SAME occupied seats; mapping: seats.mapSeats()
    // result (brain indices). Appends derived entries; poisons to [] on any
    // inconsistency. Hero's own actions are known elsewhere — we still derive
    // villains here; hero entries are harmless if consistent.
    observe(prev, curr, mapping) {
      if (!this._valid) return;
      if (!prev || !curr || !mapping || !mapping.ok) return; // nothing to compare yet
      const prevBets = prev.bets || {}, currBets = curr.bets || {};
      const prevStacks = prev.stacks || {}, currStacks = curr.stacks || {};
      const priorMax = Object.values(prevBets).reduce((a, b) => (b > a ? b : a), 0);

      for (const seat of Object.keys(currBets)) {
        const pb = prevBets[seat], cb = currBets[seat];
        if (pb == null || cb == null) continue;
        const dBet = cb - pb;
        if (dBet <= 0) continue;                       // no commit this frame (or street reset)
        const ps = prevStacks[seat], cs = currStacks[seat];
        if (ps == null || cs == null) { this._poison(); return; }
        if (Math.abs((cs - ps) + dBet) > this.tol) { this._poison(); return; } // stack/bet mismatch
        const idx = mapping.index[seat];
        if (idx == null) { this._poison(); return; }

        let type;
        if (cs === 0) type = 'all-in';
        else if (priorMax === 0) type = 'bet';
        else if (cb > priorMax) type = 'raise';
        else if (cb === priorMax) type = 'call';
        else { this._poison(); return; }               // cb < priorMax with a positive delta — incoherent

        this.entries.push({ seat: idx, street: this.street, type, amount: dBet });
      }
    }

    _poison() { this._valid = false; this.entries = []; }

    // Always returns a brain-valid list: the derived entries, or [] if poisoned.
    get() { return this._valid ? this.entries.slice() : []; }
  }

  return { ActionHistory };
});
