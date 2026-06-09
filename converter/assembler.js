// converter/assembler.js — Layer 3: assemble a complete GameStateRequest from
// confirmed reads, build the ZoomObservation envelope, and parse the reply
// (CONVERTER_BUILD_SPEC §2 Layer 3, §3, §4; brain contract per memory +
// INTEGRATION_CONTRACT.md, verified).
//
// ABSOLUTE-FIRST, NEVER FABRICATE (§1): if ANY mandatory field is not confirmed
// this frame, assemble NOTHING — return a withhold with the missing reasons. A
// withheld snapshot is recoverable; a guessed one yields wrong advice. The brain
// is `extra="forbid", frozen=True` and rejects bad input anyway.
//
// Units (§3): the wire is integer CHIPS. BB_CHIPS = 100 (bb=100, sb=50). No
// float ever reaches the wire.
//
// UMD: `window.PokerAssembler` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerAssembler = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Seats = req ? req('./seats.js') : (root && root.PokerSeats);
  const Regions = req ? req('./regions.js') : (root && root.PokerRegions);

  const DEFAULTS = {
    BB_CHIPS: 100,                 // §3: 1 BB = 100 chips → 1.5 BB = 150
    potIncludesCurrentBets: false, // see ctx; default: middle pot excludes the
                                   // front-of-seat bets, so add them (verified
                                   // direction; live-confirm via a sweep jump)
  };

  function toChips(bb, BB_CHIPS) { return Math.round(bb * BB_CHIPS); }

  // Pull the read codes from a confirmed card field's cells, in order.
  function cardCodes(cellField) {
    if (!cellField || !cellField.value) return null;
    return cellField.value.filter((c) => c && c.status === 'read').map((c) => c.code);
  }

  // Assemble. `confirmed` is a SettleDebouncer.push() result. `ctx`:
  //   heroBet            : hero's KNOWN committed bet THIS STREET in BB (§0.10);
  //                        null ⇒ withhold (never OCR hero's own bet)
  //   BB_CHIPS, potIncludesCurrentBets
  //   badgeSeats         : seats observed wearing a green blind badge (optional;
  //                        drives the seat-order self-check)
  //   actionHistory      : pre-validated Layer-4 entries (optional; else [])
  // Returns { ok:true, request, mapping, seatCheck } or
  //          { ok:false, withheld:true, missing:[...] }.
  function assembleRequest(confirmed, ctx) {
    ctx = ctx || {};
    const BB_CHIPS = ctx.BB_CHIPS != null ? ctx.BB_CHIPS : DEFAULTS.BB_CHIPS;
    const potIncl = ctx.potIncludesCurrentBets != null ? ctx.potIncludesCurrentBets : DEFAULTS.potIncludesCurrentBets;
    const missing = [];

    // 1. Occupancy + per-seat stacks. read+confirmed ⇒ occupied/readable;
    //    stable no-read ⇒ empty seat (excluded); anything else ⇒ withhold.
    const occupied = [];
    const stackChips = {};
    for (const seat of Regions.SEATS) {
      const ss = confirmed.stacks[seat] || { status: 'no-read' };
      if (ss.status === 'read' && ss.confirmed) {
        occupied.push(seat);
        stackChips[seat] = toChips(ss.value, BB_CHIPS);
      } else if (ss.status === 'no-read' && ss.stable) {
        // genuinely empty seat — skip
      } else {
        missing.push(`stack_${seat}:${ss.status}${ss.confirmed ? '' : ':unconfirmed'}`);
      }
    }
    if (!occupied.includes(Seats.HERO_SEAT)) missing.push('hero-stack-unconfirmed');

    // 2. Button → seat label.
    const btn = confirmed.button || { status: 'no-read' };
    let buttonSeat = null;
    if (btn.status === 'read' && btn.confirmed) buttonSeat = btn.value;
    else missing.push(`button:${btn.status}${btn.confirmed ? '' : ':unconfirmed'}`);

    // 3. Hero bet — from KNOWN action, never OCR (§0.10).
    if (ctx.heroBet == null) missing.push('hero-bet-unknown');

    // 4. Pot.
    const pot = confirmed.pot || { status: 'no-read' };
    if (!(pot.status === 'read' && pot.confirmed)) missing.push(`pot:${pot.status}${pot.confirmed ? '' : ':unconfirmed'}`);

    // 5. Cards — board count ∈ {0,3,4,5}; hero hole exactly 2.
    const boardField = confirmed.board || {};
    const holeField = confirmed.heroHole || {};
    if (!boardField.confirmed) missing.push('board:unconfirmed');
    if (!holeField.confirmed) missing.push('hero_hole:unconfirmed');
    const board = cardCodes(boardField);
    const hole = cardCodes(holeField);
    if (boardField.confirmed && !(board && [0, 3, 4, 5].includes(board.length))) {
      missing.push(`board-count:${board ? board.length : 'null'}`);
    }
    if (holeField.confirmed && !(hole && hole.length === 2)) {
      missing.push(`hero_hole-count:${hole ? hole.length : 'null'}`);
    }

    // 6. Per-occupied-seat bets (hero from known action; villains from OCR;
    //    a settled no-read bet badge = no bet = 0 per §0.5).
    const betChips = {};
    for (const seat of occupied) {
      if (seat === Seats.HERO_SEAT) { betChips[seat] = toChips(ctx.heroBet || 0, BB_CHIPS); continue; }
      const bs = confirmed.bets[seat] || { status: 'no-read' };
      if (bs.status === 'read' && bs.confirmed) betChips[seat] = toChips(bs.value, BB_CHIPS);
      else if (bs.status === 'no-read' && bs.stable) betChips[seat] = 0;
      else missing.push(`bet_${seat}:${bs.status}${bs.confirmed ? '' : ':unconfirmed'}`);
    }

    // WITHHOLD if anything mandatory is missing — assemble nothing partial.
    if (missing.length) return { ok: false, withheld: true, missing };

    // 7. Seat-index mapping (clockwise play order). Inconsistency ⇒ withhold.
    const mapping = Seats.mapSeats(occupied, buttonSeat);
    if (!mapping.ok) return { ok: false, withheld: true, missing: [`seat-map:${mapping.reason}`] };

    // 8. Build the brain-ordered arrays.
    const stacks = mapping.order.map((s) => stackChips[s]);
    const current_bets = mapping.order.map((s) => betChips[s]);
    const heroBetChips = current_bets[mapping.hero_seat];
    const heroStackChips = stacks[mapping.hero_seat];
    const maxBet = current_bets.reduce((a, b) => (b > a ? b : a), 0);

    const sbChips = Math.round(0.5 * BB_CHIPS);
    const bbChips = BB_CHIPS;
    const potRead = toChips(pot.value, BB_CHIPS);
    const betsSum = current_bets.reduce((a, b) => a + b, 0);
    const pot_committed = potIncl ? potRead : potRead + betsSum;

    const to_call = Math.max(0, maxBet - heroBetChips);
    // min_raise (TOTAL "raise to" amount, per contract G.1: maxBet + last raise
    // increment; we approximate the increment as bb — exact requires last-raise
    // tracking, which action_history could refine. Flagged live-validation).
    const max_raise = heroBetChips + heroStackChips;          // all-in total
    let min_raise = maxBet + bbChips;
    if (min_raise > max_raise) min_raise = 0;                  // raise gate closed

    const request = {
      schema_version: 1,
      game_type: 'cash',
      table_size: mapping.table_size,
      blinds: { sb: sbChips, bb: bbChips },
      ante: 0,
      hero_seat: mapping.hero_seat,
      button_seat: mapping.button_seat,
      hero_hole: hole,
      board: board,
      stacks: stacks,
      current_bets: current_bets,
      pot_committed: pot_committed,
      to_call: to_call,
      min_raise: min_raise,
      max_raise: max_raise,
      action_history: validateActionHistory(ctx.actionHistory, mapping.table_size),
    };

    const seatCheck = ctx.badgeSeats ? Seats.checkSeatOrder(mapping, ctx.badgeSeats) : null;
    return { ok: true, request, mapping, seatCheck };
  }

  // action_history is DISPOSABLE and OPTIONAL (§1, §2 Layer 4). Validate every
  // entry; on ANY malformed entry, fall back to [] — never send a bad entry.
  const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise', 'all-in'];
  function validateActionHistory(entries, tableSize) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const out = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') return [];
      const seatOk = Number.isInteger(e.seat) && e.seat >= 0 && e.seat < tableSize;
      const streetOk = Number.isInteger(e.street) && e.street >= 0 && e.street <= 3;
      const typeOk = ACTION_TYPES.includes(e.type);
      const amtOk = Number.isInteger(e.amount) && e.amount >= 0;
      if (!(seatOk && streetOk && typeOk && amtOk)) return []; // one bad entry ⇒ disposable, drop all
      out.push({ seat: e.seat, street: e.street, type: e.type, amount: e.amount });
    }
    return out;
  }

  // ─── wire: ZoomObservation envelope + reply parse (verified contract) ───────
  // 8766 ingests {seq, request} (ZoomObservation; opponent_id/revealed_holes
  // optional — we omit them). Reply is nested under "response" (ZoomAdvice) on
  // success, or carries "error"+"details" on failure. Branch on which is present.
  function buildEnvelope(seq, request) {
    return { seq, request };
  }

  function parseReply(msg) {
    if (msg == null || typeof msg !== 'object') {
      return { ok: false, kind: 'malformed', seq: null, error: 'reply-not-object' };
    }
    if (msg.error != null) {
      return { ok: false, kind: 'error', seq: msg.seq != null ? msg.seq : null, error: msg.error, details: msg.details };
    }
    if (msg.response != null && typeof msg.response === 'object') {
      const r = msg.response;
      return {
        ok: true, kind: 'advice', seq: msg.seq != null ? msg.seq : null,
        advice: r.advice, action: r.action, amount: r.amount,
        abstractAction: r.abstract_action, fallbackUsed: r.fallback_used,
        opponentId: r.opponent_id, response: r,
      };
    }
    return { ok: false, kind: 'malformed', seq: msg.seq != null ? msg.seq : null, error: 'no-response-or-error' };
  }

  return { DEFAULTS, toChips, assembleRequest, validateActionHistory, buildEnvelope, parseReply };
});
