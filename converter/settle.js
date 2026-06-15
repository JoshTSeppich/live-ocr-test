// converter/settle.js — Layer 2 of the converter: settle gate + per-field
// debounce (CONVERTER_BUILD_SPEC §2 Layer 2).
//
// THIS IS A FILTER, NEVER A SUM (§1, §2). It holds only the latest read per
// field plus a consecutive-agreement counter. It does NOT integrate deltas, does
// NOT infer events, does NOT accumulate. A value can be wrong one frame and right
// the next — that's the point; debouncing kills transient OCR flicker without
// ever turning a misread into permanent corruption.
//
// Two mechanisms, both pure and stateful across frames:
//   1. Settle gate (frame-level) — live 250 ms frames are NOT pre-settled, so we
//      run our own gate: a frame is "settled" once `settleN` consecutive frames
//      carry an identical stability key. The key is either supplied by the caller
//      (a pixel frame-to-frame diff / dHash — the better signal, wired in Phase
//      4) or derived here from the mandatory reads. Mid-animation/mid-deal frames
//      keep changing the key ⇒ never settle ⇒ skipped silently.
//   2. Per-field debounce — each field confirms only after `n` consecutive
//      identical 'read's. 'occluded'/'no-read' break the run and never confirm.
//
// N (`n` and `settleN`) is a §6 LIVE-VALIDATION item — confirm the values and
// that withhold-and-wait resolves fast enough at first bring-up. Defaults are
// conservative (2); override via opts.
//
// UMD: `window.PokerSettle` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerSettle = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Regions = (typeof require === 'function') ? require('./regions.js') : (root && root.PokerRegions);

  const DEFAULTS = { n: 2, settleN: 2, decimals: 2 };

  // Canonical comparable key for a numeric/seat field read. Two reads are "the
  // same" iff their keys match. Non-'read' statuses key to their status, so an
  // occluded frame never matches a read frame (it breaks the run).
  function fieldKey(f, decimals) {
    if (!f || f.status == null) return '@absent';
    if (f.status !== 'read') return '@' + f.status;
    const v = f.value;
    if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(decimals) : '@nan';
    if (v == null) return '@null';
    return 'v:' + String(v);
  }
  // Card array → stable signature ('_' for an unresolved/empty cell).
  function cardsKey(cells) {
    if (!cells) return '@absent';
    return cells.map((c) => (c && c.status === 'read' ? c.code : '_')).join('|');
  }

  class SettleDebouncer {
    constructor(opts) {
      opts = opts || {};
      this.n = opts.n != null ? opts.n : DEFAULTS.n;
      this.settleN = opts.settleN != null ? opts.settleN : DEFAULTS.settleN;
      this.decimals = opts.decimals != null ? opts.decimals : DEFAULTS.decimals;
      this._fields = new Map(); // id -> {value, status, key, count, confirmed}
      this._prevSettleKey = null;
      this._settleRun = 0;
    }

    // Clear all debounce history. Layer 3 calls this at a hand boundary so a new
    // hand's reads start fresh (they'd reset on value change anyway, but an
    // explicit reset avoids a stale run surviving an identical-looking value
    // across the boundary). This is a filter reset — no game state lives here.
    reset() {
      this._fields.clear();
      this._prevSettleKey = null;
      this._settleRun = 0;
    }

    // §3c mark-unstable-after-hero-acts: force-invalidate frame stability so a
    // fresh settleN-consecutive-stable sequence is required before ANY read is
    // trusted again. The converter calls this the instant hero's turn ends (hero
    // acted) — it kills OpenHoldem's double-act / stale-read failure mode (reading
    // the pre-action frame as if it were post-action). Same clearing as reset();
    // named for intent at the call site.
    markUnstable() { this.reset(); }

    // Record one field's read into its debounce slot; return the public view.
    _record(id, field, key) {
      const value = field ? field.value : null;
      const status = field ? (field.status || 'no-read') : 'no-read';
      const prev = this._fields.get(id);
      const count = prev && prev.key === key ? prev.count + 1 : 1;
      const stable = count >= this.n;        // value/status held N frames (any status)
      const confirmed = status === 'read' && stable; // a trusted READ value
      this._fields.set(id, { value, status, key, count, confirmed });
      // `stable` lets the assembler treat a settled no-read BET as a legit 0
      // (§0.5: an empty bet badge is no bet, not a failed read), while never
      // confirming it as a value.
      return { value, status, confirmed, stable, count };
    }

    // Composite key of the mandatory reads — identical to the previous frame ⇒
    // the table hasn't moved. Used when the caller supplies no pixel-diff key.
    _deriveSettleKey(obs) {
      const parts = [];
      for (const s of Regions.SEATS) {
        parts.push(fieldKey(obs.stacks[s], this.decimals));
        parts.push(fieldKey(obs.bets[s], this.decimals));
      }
      parts.push(fieldKey(obs.pot, this.decimals));
      parts.push(obs.button && obs.button.status === 'read'
        ? 'seat:' + obs.button.seat
        : '@' + (obs.button ? obs.button.status : 'absent'));
      if (obs.board) parts.push(cardsKey(obs.board));
      return parts.join('~');
    }

    // Feed one Layer-1 TableObservation. `pushOpts.stabilityKey`, if given,
    // drives the settle gate instead of the derived key (Phase 4 supplies a
    // pixel dHash here). Returns a confirmed/tagged view of the frame.
    push(obs, pushOpts) {
      pushOpts = pushOpts || {};
      const out = { stacks: {}, bets: {} };

      for (const s of Regions.SEATS) {
        out.stacks[s] = this._record(`stack_${s}`, obs.stacks[s], fieldKey(obs.stacks[s], this.decimals));
        out.bets[s] = this._record(`bet_${s}`, obs.bets[s], fieldKey(obs.bets[s], this.decimals));
      }
      out.pot = this._record('pot', obs.pot, fieldKey(obs.pot, this.decimals));
      // button carries its result in `.seat`; record the seat as the value so a
      // confirmed button exposes which seat the puck snapped to.
      const btn = obs.button || { status: 'no-read' };
      out.button = this._record('button',
        { value: btn.status === 'read' ? btn.seat : null, status: btn.status },
        btn.status === 'read' ? 'seat:' + btn.seat : '@' + btn.status);

      // cards (optional — geometry not yet in §0). Debounced as opaque
      // signatures; Layer 3 validates count/legality.
      out.board = obs.board
        ? this._record('board', { value: obs.board, status: 'read' }, 'board:' + cardsKey(obs.board))
        : this._record('board', { value: null, status: 'no-read' }, '@absent');
      out.heroHole = obs.heroHole
        ? this._record('heroHole', { value: obs.heroHole, status: 'read' }, 'hole:' + cardsKey(obs.heroHole))
        : this._record('heroHole', { value: null, status: 'no-read' }, '@absent');

      // turn debounced (a flicker must not fire a send); timer passes through
      // raw — it is a CONTINUOUSLY changing signal (a draining bar) and must not
      // be debounced (§0.9, used for escalation, not the snapshot).
      const turn = obs.turn || { heroToAct: false, status: 'no-read' };
      out.turn = this._record('turn',
        { value: !!turn.heroToAct, status: turn.status === 'read' ? 'read' : 'no-read' },
        turn.status === 'read' ? (turn.heroToAct ? 'turn:1' : 'turn:0') : '@no-read');
      out.timer = obs.timer || { fraction: 0, status: 'no-read' };

      // hero-bet validation read (cross-check only; debounced like any field)
      const hbo = obs.heroBetObserved || { value: null, status: 'no-read' };
      out.heroBetObserved = this._record('heroBetObserved', hbo, fieldKey(hbo, this.decimals));

      // frame settle gate
      const settleKey = pushOpts.stabilityKey != null ? String(pushOpts.stabilityKey) : this._deriveSettleKey(obs);
      if (this._prevSettleKey != null && settleKey === this._prevSettleKey) this._settleRun++;
      else this._settleRun = 1;
      this._prevSettleKey = settleKey;

      out.settled = this._settleRun >= this.settleN;
      out.settleRun = this._settleRun;
      out.heroToAct = out.turn.confirmed && out.turn.value === true;
      return out;
    }
  }

  // Convenience: are all listed fields confirmed in a push() result? Layer 3
  // uses this over its mandatory set. `getter(result, id)` resolves a field.
  function allConfirmed(result, fieldIds) {
    return fieldIds.every((id) => {
      const f = id.indexOf('.') >= 0
        ? id.split('.').reduce((o, k) => (o ? o[k] : null), result)
        : result[id];
      return f && f.confirmed === true;
    });
  }

  return { SettleDebouncer, allConfirmed, fieldKey, cardsKey, DEFAULTS };
});
