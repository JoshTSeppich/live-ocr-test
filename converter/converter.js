// converter/converter.js — the orchestrator. One per-frame pipeline tying every
// layer together (CONVERTER_BUILD_SPEC §2 + §4 + §5). Framework-agnostic and
// node-testable; the React driver just feeds it onFrame and renders its view.
//
//   getCrops → observeFrame (L1) → SettleDebouncer (L2) → assembleRequest (L3)
//            → botLink.send → advice ; boundary→reset ; escalate (§5).
//
// HERO BET (§0.10) in ADVISORY mode: the bot does not control hero, so it cannot
// "know" hero's action from its own keystroke. It derives hero's this-street
// commitment from hero's STACK DELTA (street-start hero stack − current),
// plus the blind hero posted preflop — NEVER from OCR of the BC bet badge (the
// large hero stack plate is far more reliable than the small bet badge). This
// derivation + the preflop-blind handling are LIVE-VALIDATION items.
//
// UMD: `window.PokerConverter` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerConverter = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Obs = req ? req('./observation.js') : (root && root.PokerObservation);
  const Frame = req ? req('./frame.js') : (root && root.PokerFrame);
  const Assembler = req ? req('./assembler.js') : (root && root.PokerAssembler);
  const Seats = req ? req('./seats.js') : (root && root.PokerSeats);

  function streetFromCount(n) {
    if (n === 0) return 0; if (n === 3) return 1; if (n === 4) return 2; if (n === 5) return 3;
    return null; // 1,2 = mid-deal/invalid
  }

  class Converter {
    constructor(deps) {
      deps = deps || {};
      this.debouncer = deps.debouncer;     // SettleDebouncer
      this.lifecycle = deps.lifecycle;     // HandLifecycle (resets debouncer + history)
      this.history = deps.history;         // ActionHistory (Layer 4)
      this.botLink = deps.botLink;         // BotLink
      this.escalator = deps.escalator;     // Escalator
      this.digitMatcher = deps.digitMatcher;
      this.cardMatcher = deps.cardMatcher;
      this.cfg = Object.assign({ BB_CHIPS: 100, potIncludesCurrentBets: false, sbRatio: 0.5 }, deps.cfg || {});

      this._heroBetBB = null;
      this._streetStartHeroStackBB = null;
      this._street = null;
      this._sentThisTurn = false;
      this._advice = null;
      this._prevHist = null;               // {bets,stacks} chips for Layer-4 deltas
      this.view = { state: 'idle', advice: null, warning: null, seatWarning: null, withheld: null };

      if (this.botLink) {
        this.botLink.onAdvice = (a) => { this._advice = a; };
      }
    }

    // Called by useLiveOCR's onFrame. Returns a result for tests/inspection.
    onFrame(getCrops, dims) {
      const built = Frame.buildFrame(getCrops, dims, {
        digitMatcher: this.digitMatcher, cardMatcher: this.cardMatcher, heroBet: this._heroBetBB,
      });
      const observe = Obs.observeFrame(built.frame, built.observeOpts);

      // hand boundary (§0.7) from the raw frame's over-determined signals → reset
      const bres = this.lifecycle.onSnapshot(this._boundarySnap(observe));
      if (bres.boundary) this._onNewHand();

      const confirmed = this.debouncer.push(observe);

      // street tracking (from confirmed board count) → reset street-start stack
      const boardCount = (confirmed.board && confirmed.board.confirmed && confirmed.board.value)
        ? confirmed.board.value.filter((c) => c && c.status === 'read').length : null;
      const street = boardCount == null ? this._street : streetFromCount(boardCount);
      if (street != null && street !== this._street) {
        this._street = street;
        this._streetStartHeroStackBB = null; // re-anchor on first confirmed stack below
        if (this.history && this.history.setStreet) this.history.setStreet(street);
      }

      // hero bet from stack delta (+ posted blind preflop) — never BC OCR (§0.10)
      const heroStackBB = (confirmed.stacks.BC && confirmed.stacks.BC.confirmed) ? confirmed.stacks.BC.value : null;
      if (this._streetStartHeroStackBB == null && heroStackBB != null) this._streetStartHeroStackBB = heroStackBB;
      this._heroBetBB = this._computeHeroBet(confirmed, heroStackBB);

      // assemble
      const ctx = {
        heroBet: this._heroBetBB,
        BB_CHIPS: this.cfg.BB_CHIPS,
        potIncludesCurrentBets: this.cfg.potIncludesCurrentBets,
        badgeSeats: observe._badgeSeats, // optional; driver may attach badge detection
        actionHistory: this.history ? this.history.get() : [],
      };
      const asm = Assembler.assembleRequest(confirmed, ctx);

      // seat-order self-check (top live-validation item) — surface a loud warning
      this.view.seatWarning = (asm.ok && asm.seatCheck && !asm.seatCheck.ok && !asm.seatCheck.inconclusive)
        ? asm.seatCheck.warning : null;

      // Layer-4 history derive (subordinate; safe-[] on any inconsistency)
      if (asm.ok && this.history) this._deriveHistory(asm, confirmed);

      // send: on hero's turn, once a clean snapshot exists, send once per turn
      let sent = false;
      if (confirmed.heroToAct) {
        if (asm.ok && !this._sentThisTurn && this.botLink) { this.botLink.send(asm.request); this._sentThisTurn = true; sent = true; }
      } else {
        this._sentThisTurn = false;
        this._advice = null;
      }

      // §5 wait/escalate
      const esc = this.escalator.update({
        heroToAct: confirmed.heroToAct,
        hasAdvice: !!this._advice,
        timerFraction: confirmed.timer ? confirmed.timer.fraction : null,
      });
      this.view.state = esc.state;
      this.view.advice = this._advice ? this._advice.advice : null;
      this.view.withheld = asm.ok ? null : asm.missing;
      this.view.warning = esc.state === 'escalate' ? "can't read state — decide manually" : null;

      return { state: esc.state, sent, request: asm.ok ? asm.request : null, withheld: asm.ok ? null : asm.missing, escalateReason: esc.reason };
    }

    _onNewHand() {
      // lifecycle already reset debouncer + history; clear our hand-scoped state.
      this._street = null;
      this._streetStartHeroStackBB = null;
      this._heroBetBB = null;
      this._sentThisTurn = false;
      this._advice = null;
      this._prevHist = null;
    }

    _computeHeroBet(confirmed, heroStackBB) {
      if (this._streetStartHeroStackBB == null || heroStackBB == null) return null;
      let bet = Math.max(0, this._streetStartHeroStackBB - heroStackBB);
      if (this._street === 0) bet += this._heroPostedBlindBB(confirmed); // preflop blind hero posted
      return bet;
    }

    _heroPostedBlindBB(confirmed) {
      const occ = this._occupied(confirmed);
      const btn = (confirmed.button && confirmed.button.confirmed) ? confirmed.button.value : null;
      if (!btn) return 0;
      const m = Seats.mapSeats(occ, btn);
      if (!m.ok) return 0;
      if (m.sbSeat === Seats.HERO_SEAT) return this.cfg.sbRatio;       // hero posted SB
      if (m.bbSeat === Seats.HERO_SEAT) return 1;                       // hero posted BB
      return 0;
    }

    _occupied(confirmed) {
      const out = [];
      for (const s of Object.keys(confirmed.stacks)) {
        const ss = confirmed.stacks[s];
        if (ss.status === 'read' && ss.confirmed) out.push(s);
      }
      return out;
    }

    _boundarySnap(observe) {
      // raw, over-determined §0.7 signals — robust even unconfirmed
      const stacks = {};
      for (const s of Object.keys(observe.stacks)) {
        const ss = observe.stacks[s];
        if (ss.status === 'read') stacks[s] = Math.round(ss.value * this.cfg.BB_CHIPS);
      }
      const boardCount = observe.board ? observe.board.filter((c) => c && c.status === 'read').length : 0;
      const potChips = (observe.pot && observe.pot.status === 'read') ? Math.round(observe.pot.value * this.cfg.BB_CHIPS) : null;
      const buttonSeat = (observe.button && observe.button.status === 'read') ? observe.button.seat : null;
      return { boardCount, potChips, buttonSeat, stacks };
    }

    _deriveHistory(asm, confirmed) {
      const bets = {}, stacks = {};
      for (const seat of asm.mapping.order) {
        const idx = asm.mapping.index[seat];
        bets[seat] = asm.request.current_bets[idx];
        stacks[seat] = asm.request.stacks[idx];
      }
      const curr = { bets, stacks };
      if (this._prevHist) this.history.observe(this._prevHist, curr, asm.mapping);
      this._prevHist = curr;
    }
  }

  return { Converter, streetFromCount };
});
