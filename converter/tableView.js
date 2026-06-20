// converter/tableView.js — LOW-FIDELITY live table viewer ("Josh's College Bot").
//
// A VIEWER over the converter's settled per-frame observation — explicitly NOT the
// assembler's brain-gated GameStateRequest. The advice path WITHHOLDS when a
// mandatory field is missing (hero-shy, button/Gate-D, occluded stack); a DISPLAY
// must not. It shows what reads and '?' for what it can't. Partial truth, honestly
// shown, is the low-fid contract — never fabricate, but never withhold either.
//
// Two pieces:
//   thinFromConfirmed(confirmed, extra) — pull the display fields out of a settled
//     observation as a thin per-frame block (codes/values + status; NO base64 crops,
//     which is what bloats the teaching record). This is the consumable stream.
//   class TableView — folds the thin stream into a held display: LAST-GOOD per slot
//     within a hand (a card read on the flop stays shown if a later frame fails to
//     read it), '?' for never-read, and a HARD RESET on a hand boundary (passed in;
//     the converter derives it from §0.7 board→0 / pot≈1.5 / button-move — works
//     without the button, so the viewer's reset isn't gated on Gate-D).
//
// UMD: `window.PokerTableView` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerTableView = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Regions = (typeof require === 'function') ? require('./regions.js') : (root && root.PokerRegions);
  const SEATS = (Regions && Regions.SEATS) || ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'];
  const HERO_SEAT = (Regions && Regions.HERO_SEAT) || 'BC';

  // A confirmed card field → ['Kd','9h','?'] (read code, or '?' for a present-but-
  // unread cell). Absent/empty cells are dropped (length = cards actually there).
  function cardCodes(f) {
    if (!f || !f.value) return [];
    return f.value
      .filter((c) => c && c.status !== 'absent' && c.status !== 'none')
      .map((c) => (c && c.status === 'read' && c.code) ? c.code : '?');
  }
  const numRead = (x) => (x && x.status === 'read') ? x.value : null;

  // Thin per-frame snapshot from a SETTLED observation (`confirmed`). `extra` carries
  // the converter's already-computed authoritative bits (heroToAct, street, heroBet).
  function thinFromConfirmed(confirmed, extra) {
    confirmed = confirmed || {};
    extra = extra || {};
    const seats = {};
    for (const seat of SEATS) {
      const st = confirmed.stacks ? confirmed.stacks[seat] : null;
      const isHero = seat === HERO_SEAT;
      // hero bet is the KNOWN action (never OCR §0.10), passed via extra.heroBet
      const bt = isHero ? null : (confirmed.bets ? confirmed.bets[seat] : null);
      seats[seat] = {
        stack: numRead(st),
        stackStatus: st ? st.status : 'no-read',
        bet: isHero ? (extra.heroBet != null ? extra.heroBet : null) : numRead(bt),
        betStatus: isHero ? (extra.heroBet != null ? 'read' : 'no-read') : (bt ? bt.status : 'no-read'),
      };
    }
    return {
      board: cardCodes(confirmed.board),
      hero: cardCodes(confirmed.heroHole),
      pot: numRead(confirmed.pot),
      seats,
      button: (confirmed.button && confirmed.button.status === 'read') ? confirmed.button.seat : null,
      heroToAct: !!extra.heroToAct,
      street: extra.street != null ? extra.street : null,
    };
  }

  // RICH thin full-state block (one per settled frame) — the append-only log the
  // board / state-machine / narration consumes. Every field is "what was read this
  // frame", TAGGED: unread → null / state:'no-read'|'absent' / 'occluded', NEVER
  // guessed. NO base64 crops (that's the fat card log). Copies the converter's
  // already-settled reads (`confirmed`) + already-computed bits (`extra`) — no
  // re-OCR, no recompute, and entirely decoupled from the assembler's brain-gate.
  function blockFromConfirmed(confirmed, extra) {
    confirmed = confirmed || {};
    extra = extra || {};
    const cardCell = (c) => ({
      code: (c && c.status === 'read' && c.code) ? c.code : null,
      state: c ? c.status : 'none',
      conf: (c && c.confidence != null) ? +Number(c.confidence).toFixed(3) : null,
    });
    const cards = (f) => (f && f.value)
      ? f.value.filter((c) => c && c.status !== 'absent' && c.status !== 'none').map(cardCell)
      : [];
    const seatBlock = (seat) => {
      const st = confirmed.stacks ? confirmed.stacks[seat] : null;
      const isHero = seat === HERO_SEAT;
      const bt = isHero ? null : (confirmed.bets ? confirmed.bets[seat] : null);
      let state = 'unknown', stack = null;
      if (st && st.status === 'read') { state = 'active'; stack = st.value; }
      else if (st && st.status === 'occluded') { state = 'occluded'; stack = 'occluded'; }
      else if (st && st.status === 'no-read' && st.stable) { state = 'empty'; }
      // folded/allin are NOT derivable from the stack read alone → left 'unknown'.
      return {
        id: seat,
        name: null, // no name-OCR wired yet → null (never fabricated)
        stack,
        bet: isHero
          ? (extra.heroBet != null ? extra.heroBet : null)
          : ((bt && bt.status === 'read') ? bt.value : null),
        state,
      };
    };
    return {
      video: extra.video || null,
      street: extra.street != null ? extra.street : null,
      board: cards(confirmed.board),
      hero: cards(confirmed.heroHole),
      pot: (confirmed.pot && confirmed.pot.status === 'read') ? confirmed.pot.value : null,
      seats: SEATS.map(seatBlock),
      button: (confirmed.button && confirmed.button.status === 'read') ? confirmed.button.seat : null,
      toAct: extra.heroToAct ? HERO_SEAT : null, // villain to-act not derivable outside the assembler → null
      heroTurn: !!extra.heroToAct,
      timer: (confirmed.timer && confirmed.timer.status !== 'no-read' && confirmed.timer.fraction != null)
        ? +Number(confirmed.timer.fraction).toFixed(3) : null,
    };
  }

  // Holds the display state across frames. Feed update(thin, boundary) each frame.
  class TableView {
    constructor() { this.handCount = 0; this.reset(); }
    reset() {
      this.board = [null, null, null, null, null]; // last-good code per board slot
      this.hero = [null, null];
      this.pot = null;
      this.seats = {};                              // seat -> {stack,bet,stackStatus,betStatus}
      this.button = null;                           // null ⇒ '?' (Gate-D / unread)
      this.heroToAct = false;
      this.street = null;
    }
    update(thin, boundary) {
      if (boundary) { this.handCount++; this.reset(); }
      thin = thin || {};
      // CARDS: hold last-good per slot (a read card persists through a missed frame).
      (thin.board || []).forEach((c, i) => { if (c && c !== '?' && i < 5) this.board[i] = c; });
      (thin.hero || []).forEach((c, i) => { if (c && c !== '?' && i < 2) this.hero[i] = c; });
      if (thin.pot != null) this.pot = thin.pot;
      // SEATS: hold last-good stack/bet; always carry the freshest status so the
      // render can flag occluded/no-read without losing the last value.
      for (const seat of SEATS) {
        const s = thin.seats && thin.seats[seat];
        if (!s) continue;
        const cur = this.seats[seat] || {};
        if (s.stack != null) cur.stack = s.stack;
        if (s.bet != null) cur.bet = s.bet;
        cur.stackStatus = s.stackStatus;
        cur.betStatus = s.betStatus;
        this.seats[seat] = cur;
      }
      if (thin.button != null) this.button = thin.button;
      this.heroToAct = !!thin.heroToAct;
      if (thin.street != null) this.street = thin.street;
      return this.view();
    }
    // The display block. '?' for never-read card slots; null pot/button = unknown.
    view() {
      return {
        hand: this.handCount,
        street: this.street,
        board: this.board.map((c) => c || '?'),
        hero: this.hero.map((c) => c || '?'),
        pot: this.pot,
        button: this.button,
        heroToAct: this.heroToAct,
        seats: Object.assign({}, this.seats),
      };
    }
  }

  return { SEATS, HERO_SEAT, cardCodes, thinFromConfirmed, blockFromConfirmed, TableView };
});
