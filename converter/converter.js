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

  const Obs = (typeof require === 'function') ? require('./observation.js') : (root && root.PokerObservation);
  const Frame = (typeof require === 'function') ? require('./frame.js') : (root && root.PokerFrame);
  const Assembler = (typeof require === 'function') ? require('./assembler.js') : (root && root.PokerAssembler);
  const Seats = (typeof require === 'function') ? require('./seats.js') : (root && root.PokerSeats);
  const TableView = (typeof require === 'function') ? require('./tableView.js') : (root && root.PokerTableView);

  function streetFromCount(n) {
    if (n === 0) return 0; if (n === 3) return 1; if (n === 4) return 2; if (n === 5) return 3;
    return null; // 1,2 = mid-deal/invalid
  }
  const STREET_NAME = ['preflop', 'flop', 'turn', 'river'];

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
      this.cfg = Object.assign({ BB_CHIPS: 100, potIncludesCurrentBets: false, sbRatio: 0.5, heroBetTolBB: 0.5 }, deps.cfg || {});

      this._heroBetBB = null;
      this._streetStartHeroStackBB = null;
      this._street = null;
      this._sentThisTurn = false;
      this._advice = null;
      this._declined = null;               // §3a/E: active decline (→ wait) or null
      this._brainDeclined = null;          // E: async brain decline (botLink.onError)
      this._prevHeroToAct = false;         // §3c: prior authoritative turn (edge detect)
      this._lastSentSeq = 0;               // E: seq of the most recent snapshot sent
      this._sentSig = null;                // E: signature of the last-sent snapshot
      this._prevHist = null;               // {bets,stacks} chips for Layer-4 deltas
      this._panelText = null;              // latest action-panel OCR text (check-vs-call)
      this.view = { state: 'idle', advice: null, warning: null, seatWarning: null, betWarning: null, callWarning: null, withheld: null, actionSet: null, stale: false, declined: null, table: null, snapshot: null };
      // Low-fid VIEWER (Josh's College Bot) — a display over the settled observation,
      // decoupled from the assembler's brain-gate. Never withholds; '?' for unread.
      this.tableView = (TableView && TableView.TableView) ? new TableView.TableView() : null;

      if (this.botLink) {
        // a parsed advice clears any standing brain-decline for this turn
        this.botLink.onAdvice = (a) => { this._advice = a; this._brainDeclined = null; };
        // a brain error/strict-block reply → a decline that surfaces as `wait`
        // (NO ADVICE — YOU DECIDE). Carries the rejected snapshot's seq if present.
        this.botLink.onError = (e) => { this._brainDeclined = { reason: 'brain-decline', error: e, seq: e && e.seq != null ? e.seq : null }; };
      }
    }

    // Stable signature of the salient request fields — drives "is this a NEW
    // snapshot?" (E: supersession / resend on change, not on every frame).
    _requestSig(req) {
      if (!req) return null;
      return JSON.stringify([req.stacks, req.current_bets, req.board, req.hero_hole,
        req.button_seat, req.hero_seat, req.pot_committed, req.to_call]);
    }

    // The driver feeds hero's action-panel OCR text here (from useLiveOCR's
    // existing Tesseract path) so the check-vs-call cross-check can read which
    // button is shown. One-frame-stale is fine for a validation check.
    setPanelText(text) { this._panelText = text; }

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
        // Seat-order self-check derives its blind seats inside assembleRequest from
        // this frame's confirmed reads (BB-anchored) — no dead _badgeSeats input.
        // blindLabels (net-new per-seat "SB"/"BB" OCR) would slot in here later.
        actionHistory: this.history ? this.history.get() : [],
      };
      const asm = Assembler.assembleRequest(confirmed, ctx);

      // seat-order self-check (top live-validation item) — surface a loud warning
      this.view.seatWarning = (asm.ok && asm.seatCheck && !asm.seatCheck.ok && !asm.seatCheck.inconclusive)
        ? asm.seatCheck.warning : null;

      // hero-bet ground-truth cross-check (§0.10): stack-delta heroBet vs the OCR
      // of hero's own bet badge. Validation only — never changes what we send.
      this.view.betWarning = this._heroBetCrossCheck(confirmed);

      // check-vs-call cross-check: validates the SIGN of to_call against which
      // button the client shows (CHECK ⇔ to_call==0, CALL ⇔ to_call>0), and
      // exercises ACTION_PANEL_RECT. Validation only.
      this.view.callWarning = asm.ok ? this._checkVsCall(asm.request.to_call) : null;

      // Layer-4 history derive (subordinate; safe-[] on any inconsistency)
      if (asm.ok && this.history) this._deriveHistory(asm, confirmed);

      // Turn authority (§3a / P4). "Any red" over-counts hero-turn ~40% (the Boost
      // Fast-Fold pre-button is a lone red FOLD). So the debounced red signal
      // (confirmed.heroToAct) is now only a CHEAP PRECONDITION; the action-button
      // PANEL is authoritative — we require the FULL action set (Fold + Check|Call
      // + Bet|Raise) parsed from the panel text fed via setPanelText().
      const redTurn = confirmed.heroToAct;
      const actionSet = redTurn ? Obs.classifyActionSet(this._panelText) : 'absent';
      // authoritative: only a full, parseable action set is hero's turn to act on.
      const heroToAct = redTurn && actionSet === 'full';
      // apparent turn but the panel is partial/garbled → WITHHOLD and let §5
      // escalate ("can't read table — decide"); never fire advice on it. Fast-Fold
      // / absent panels are benign (not hero's turn) and stay idle.
      const panelUnreadable = redTurn && actionSet === 'unparseable';
      this.view.actionSet = redTurn ? actionSet : null;

      // ── LOW-FID VIEWER (Josh's College Bot) — a display over the SETTLED
      // observation, NOT the assembler's gated request. It never withholds: shows
      // what reads, '?' for what it can't (hero-shy, button/Gate-D, occluded). Held
      // state (last-good per slot, hard reset on the §0.7 hand boundary) is separate
      // from the advice path entirely.
      if (this.tableView) {
        const thin = TableView.thinFromConfirmed(confirmed, {
          heroToAct,
          street: this._street != null ? STREET_NAME[this._street] : null,
          heroBet: this._heroBetBB,
        });
        this.view.snapshot = thin;                              // raw per-frame thin block
        this.view.table = this.tableView.update(thin, bres.boundary); // held display
      }
      // RICH thin full-state block for the append-only snapshot log (board /
      // state-machine / narration foundation). Tap on `confirmed` — additive, the
      // brain-request path above is untouched.
      this.view.block = TableView.blockFromConfirmed(confirmed, {
        heroToAct,
        street: this._street != null ? STREET_NAME[this._street] : null,
        heroBet: this._heroBetBB,
        video: (dims && dims.videoW) ? [dims.videoW, dims.videoH] : null,
      });

      // §3a: the rendered panel is AUTHORITATIVE for legal actions; our arithmetic
      // is a sanity cross-check. On a panel↔arithmetic disagreement (the check-vs-
      // call SIGN mismatch) we WITHHOLD rather than guess — a decline that surfaces
      // as `wait` (NO ADVICE — YOU DECIDE), not a fabricated send.
      const panelDisagree = asm.ok && heroToAct && !!this.view.callWarning;

      // send: on hero's turn (full action set, no panel disagreement), send each
      // DISTINCT clean snapshot once (by signature). A NEW snapshot (changed
      // signature) re-sends with a fresh seq — which makes any advice still shown
      // for the prior seq STALE until the new advice arrives. Advice is KEPT across
      // transient mid-turn withholds (it clears only when the turn ends, below), so
      // the supersession is detectable rather than silently dropped.
      let sent = false;
      const canSend = heroToAct && !panelDisagree;
      if (canSend && asm.ok && this.botLink) {
        const sig = this._requestSig(asm.request);
        if (sig !== this._sentSig) {
          this._lastSentSeq = this.botLink.send(asm.request);
          this._sentSig = sig;
          this._sentThisTurn = true;
          this._brainDeclined = null; // re-asked → clear any prior decline
          sent = true;
        }
      }
      if (!heroToAct) {
        // turn ended / not hero's turn → drop all per-turn state (no stale advice
        // survives into the next decision).
        this._sentThisTurn = false;
        this._sentSig = null;
        this._advice = null;
        this._brainDeclined = null;
      }

      // decline (→ `wait`): a §3a panel↔arithmetic disagreement, OR an async brain
      // decline / strict-block (botLink.onError) on what is still hero's turn.
      // Distinct from escalate (eyes can't read) — here we CAN read; the brain
      // declined or the panel contradicts us. NO ADVICE — YOU DECIDE.
      this._declined = panelDisagree
        ? { reason: 'panel-arith-disagreement' }
        : (heroToAct && this._brainDeclined ? this._brainDeclined : null);
      this.view.declined = this._declined;

      // stale (E, safety-critical): advice is shown for an OLDER snapshot than the
      // latest one sent — the table moved past the advised frame. Executing stale
      // advice is the worst failure of a tell-only tool, so the producer map lets
      // this supersede the advice.
      this.view.stale = !!(this._advice && Number.isFinite(this._advice.seq)
        && this._lastSentSeq > this._advice.seq);

      // §5 wait/escalate. Feed the escalator the authoritative turn (when we're not
      // declining) OR an unreadable-panel-during-apparent-turn (so it escalates
      // rather than silently idling). A §3a decline is NOT escalate — it stays out
      // of the escalator and is surfaced as `wait` downstream. Fast-Fold / absent
      // panels are benign and stay idle.
      const esc = this.escalator.update({
        heroToAct: (heroToAct && !panelDisagree) || panelUnreadable,
        hasAdvice: !!this._advice,
        timerFraction: confirmed.timer ? confirmed.timer.fraction : null,
      });
      this.view.state = esc.state;
      this.view.advice = this._advice ? this._advice.advice : null;
      this.view.withheld = asm.ok ? null : asm.missing;
      this.view.warning = esc.state === 'escalate' ? "can't read state — decide manually" : null;

      // §3c mark-unstable-after-hero-acts: the instant hero's turn ends (hero acted),
      // force the settle gate to re-settle so no pre-action frame is read as post-
      // action. Detected as the authoritative-turn true→false transition.
      if (this._prevHeroToAct && !heroToAct) this.debouncer.markUnstable();
      this._prevHeroToAct = heroToAct;

      return { state: esc.state, sent, request: asm.ok ? asm.request : null, withheld: asm.ok ? null : asm.missing, escalateReason: esc.reason, actionSet: this.view.actionSet, declined: this._declined, stale: this.view.stale, lastSeq: this._lastSentSeq };
    }

    _onNewHand() {
      // lifecycle already reset debouncer + history; clear our hand-scoped state.
      this._street = null;
      this._streetStartHeroStackBB = null;
      this._heroBetBB = null;
      this._sentThisTurn = false;
      this._advice = null;
      this._declined = null;
      this._brainDeclined = null;
      this._sentSig = null;
      this._prevHeroToAct = false;
      this._prevHist = null;
    }

    _computeHeroBet(confirmed, heroStackBB) {
      if (this._streetStartHeroStackBB == null || heroStackBB == null) return null;
      let bet = Math.max(0, this._streetStartHeroStackBB - heroStackBB);
      if (this._street === 0) bet += this._heroPostedBlindBB(confirmed); // preflop blind hero posted
      return bet;
    }

    // Cross-check the stack-delta heroBet against the OCR of hero's own bet badge
    // (§0.10 ground truth). Returns a warning string on drift, else null. Only
    // fires when BOTH are confident; the badge is NEVER the source — a misread
    // here raises a flag, it cannot corrupt the snapshot. to_call is the field
    // whose error is most costly, so this guards it.
    _heroBetCrossCheck(confirmed) {
      const obs = confirmed.heroBetObserved;
      if (!obs || this._heroBetBB == null) return null;
      let observedBB = null;
      if (obs.status === 'read' && obs.confirmed) observedBB = obs.value;
      else if (obs.status === 'no-read' && obs.stable) observedBB = 0; // settled-empty badge = no bet
      if (observedBB == null) return null; // inconclusive (occluded / unsettled) — don't warn
      const tol = this.cfg.heroBetTolBB;
      if (Math.abs(this._heroBetBB - observedBB) > tol) {
        return `⚠ HERO-BET DRIFT: stack-delta=${this._heroBetBB.toFixed(2)}bb vs bet-badge=${observedBB.toFixed(2)}bb `
          + `(>${tol}bb). to_call may be wrong — stack-delta is the source; the badge is the visible cross-check.`;
      }
      return null;
    }

    // Classify the action panel from its (Tesseract-mangled) OCR text. The
    // middle button is CHECK when to_call==0, CALL when to_call>0 — the only
    // independent witness to to_call's SIGN. Tolerant of OCR noise.
    _classifyPanel() {
      const t = (this._panelText || '').toLowerCase();
      if (!t) return 'unknown';
      const hasCall = /\bca[l1i]{1,2}\b|call/.test(t);
      const hasCheck = /\bch[e3]c?k\b|check|cheek/.test(t);
      if (hasCall && !hasCheck) return 'call';
      if (hasCheck && !hasCall) return 'check';
      return 'unknown'; // both or neither — inconclusive, don't warn
    }

    // Cross-check to_call's sign against the shown button. Validation only.
    _checkVsCall(toCallChips) {
      const cls = this._classifyPanel();
      if (cls === 'unknown') return null;
      if (toCallChips > 0 && cls === 'check') {
        return `⚠ TO_CALL/BUTTON MISMATCH: to_call=${toCallChips} (>0) but a CHECK button is shown — `
          + `to_call sign may be wrong (also check ACTION_PANEL_RECT).`;
      }
      if (toCallChips === 0 && cls === 'call') {
        return `⚠ TO_CALL/BUTTON MISMATCH: to_call=0 but a CALL button is shown — `
          + `to_call may be wrong (also check ACTION_PANEL_RECT).`;
      }
      return null;
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
