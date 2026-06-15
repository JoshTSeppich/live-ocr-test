// converter/seats.js — seat-index mapping for the brain contract.
//
// THE HIGHEST-CONSEQUENCE ASSUMPTION IN THE CONVERTER. The brain derives every
// player's position purely from seat indices via `(hero_seat - sb_seat) %
// table_size`, with `sb_seat = (button_seat + 1) % table_size` (3+ handed). That
// arithmetic is correct ONLY if seat indices run in the true clockwise DIRECTION
// OF PLAY. Get the direction backwards and position is silently inverted on
// EVERY hand — confidently-wrong advice with no visible error. So:
//
//   • SEAT_ORDER_CW below is a CONFIG CONSTANT (measured from §0.8 slot geometry:
//     angles around the table center give the cyclic order TL→TC→TR→BR→BC→BL).
//   • checkSeatOrder() is a REAL live self-check (NOT cosmetic): it compares the
//     computed SB/BB seats against the OBSERVED blind seats read off the table.
//     The ANCHOR is the BB blind (1.0 BB = the reliably-read amount, and/or an
//     explicit "BB" text label): a confidently-read BB at button+2 disambiguates
//     clockwise from counter-clockwise on its own, so it fully answers the
//     play-direction question. The SB (0.5 BB) is genuine CORROBORATION, not a
//     second independent requirement (0.5 reads less reliably — a known weakness).
//     The original spec keyed this off "green blind badges," which DO NOT EXIST in
//     this client (the green "B" icons mark active/dealt-in, on every live seat).
//     See SHADOW_STEP1_FINDINGS.md §4 / CC_SEATORDER_REDESIGN. It MUST be run and
//     its warning surfaced loudly before any advice is trusted. This is the TOP
//     live-validation item — above the §6 list.
//
// Fast-fold note: each hand is a new table, so occupancy and the button-vs-hero
// relationship change every hand. This mapping is rebuilt per snapshot from the
// current occupied set — absolute-first, nothing persists across hands.
//
// UMD: `window.PokerSeats` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerSeats = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Clockwise order of the six screen positions = direction of play. Measured
  // from slot geometry (atan2 around center 1510,967): TL 170°, TC 95°, TR 13°,
  // BR -23°, BC -53°, BL -160° → clockwise (decreasing angle) is:
  const SEAT_ORDER_CW = ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'];
  const HERO_SEAT = 'BC';

  // Build the brain's seat arrays from the set of OCCUPIED screen seats + the
  // button's screen seat. Occupied seats are indexed 0..table_size-1 in clockwise
  // play order (so button+1 = SB, button+2 = BB, as the brain assumes).
  //
  //   occupied : iterable of seat labels currently holding a player (must include
  //              HERO_SEAT; an empty seat is one whose stack reads no-read).
  //   buttonSeat : screen label the puck snapped to.
  // Returns { ok, order, index, table_size, hero_seat, button_seat, sbSeat,
  //   bbSeat } or { ok:false, reason } if the inputs are inconsistent (caller
  //   then WITHHOLDS — never assembles a guessed mapping).
  function mapSeats(occupied, buttonSeat) {
    const occ = new Set(occupied);
    if (!occ.has(HERO_SEAT)) return { ok: false, reason: 'hero-seat-not-occupied' };
    if (!buttonSeat || !occ.has(buttonSeat)) return { ok: false, reason: 'button-seat-not-occupied' };
    const order = SEAT_ORDER_CW.filter((s) => occ.has(s));
    const n = order.length;
    if (n < 2) return { ok: false, reason: 'too-few-seats' };
    const index = {};
    order.forEach((s, i) => { index[s] = i; });
    const button_seat = index[buttonSeat];
    const hero_seat = index[HERO_SEAT];
    // SB/BB physical labels — for the live self-check, not sent to the brain.
    const sbSeat = n === 2 ? order[button_seat] : order[(button_seat + 1) % n];
    const bbSeat = n === 2 ? order[(button_seat + 1) % n] : order[(button_seat + 2) % n];
    return { ok: true, order, index, table_size: n, hero_seat, button_seat, sbSeat, bbSeat };
  }

  // Derive the OBSERVED blind seats from this frame's confirmed reads, for the
  // seat-order self-check. BB-ANCHORED (CC_SEATORDER_REDESIGN ruling B): the BB
  // (1.0 BB and/or a "BB" text label) is the anchor; the SB (0.5 BB / "SB" label)
  // corroborates only. Runs ONLY at a confident blinds-only hand start (empty
  // board + pot ~1.5) — otherwise it returns no anchor and the gate WITHHOLDS
  // (never a false mismatch on a noisy/mid-hand frame).
  //   reads.boardCount : confirmed board-card count (0 ⇒ preflop)
  //   reads.potBB      : confirmed pot readout in BB
  //   reads.bets       : { seat: betBB|null } per occupied seat (hero's posted
  //                      blind included — it is a legit blind signal preflop)
  //   reads.labels     : { seat: 'SB'|'BB' } — NET-NEW per-seat label OCR, the
  //                      PREFERRED anchor once it exists; today it is null and the
  //                      gate ships on bets+button. Slots in here with no redesign.
  //   opts             : { potTargetBB=1.5, potTolBB=0.3, sbBB=0.5, bbBB=1.0,
  //                        betTolBB=0.1 }
  // Returns { sb, bb, blindsOnly, source, reason }. bb===null ⇒ no anchor.
  function deriveBlindSeats(reads, opts) {
    reads = reads || {}; opts = opts || {};
    const potTarget = opts.potTargetBB != null ? opts.potTargetBB : 1.5;
    const potTol    = opts.potTolBB    != null ? opts.potTolBB    : 0.3;
    const sbBB      = opts.sbBB        != null ? opts.sbBB        : 0.5;
    const bbBB      = opts.bbBB        != null ? opts.bbBB        : 1.0;
    const betTol    = opts.betTolBB    != null ? opts.betTolBB    : 0.1;
    const out = { sb: null, bb: null, blindsOnly: false, source: null, reason: null };

    // Blinds-only guard: empty board + pot ~1.5. Anything else ⇒ no check.
    if (reads.boardCount !== 0) { out.reason = 'board-not-empty'; return out; }
    if (reads.potBB == null || Math.abs(reads.potBB - potTarget) > potTol) {
      out.reason = 'pot-not-blinds-only'; return out;
    }
    out.blindsOnly = true;

    // The unique seat whose bet matches a target amount (null if absent OR if two
    // seats both match — ambiguous reads never anchor anything).
    const uniqueBet = (target) => {
      const bets = reads.bets || {};
      let hit = null, many = false;
      for (const s of Object.keys(bets)) {
        const v = bets[s];
        if (v != null && Math.abs(v - target) <= betTol) { if (hit == null) hit = s; else many = true; }
      }
      return many ? null : hit;
    };
    const uniqueLabel = (want) => {
      const labels = reads.labels || {};
      let hit = null, many = false;
      for (const s of Object.keys(labels)) {
        if (String(labels[s]).toUpperCase() === want) { if (hit == null) hit = s; else many = true; }
      }
      return many ? null : hit;
    };

    // BB anchor: prefer the explicit label (future), else the 1.0 bet (today).
    const bbLabel = uniqueLabel('BB'), bbBet = uniqueBet(bbBB);
    if (bbLabel && bbBet && bbLabel !== bbBet) {
      out.bb = null; out.reason = 'anchor-label-bet-disagree'; // noisy ⇒ no anchor
    } else {
      out.bb = bbLabel || bbBet;
      out.source = bbLabel ? 'labels' : (bbBet ? 'bets' : null);
    }
    // SB corroboration: same precedence, never required, never forces a mismatch.
    const sbLabel = uniqueLabel('SB'), sbBet = uniqueBet(sbBB);
    out.sb = (sbLabel && sbBet && sbLabel !== sbBet) ? null : (sbLabel || sbBet);
    return out;
  }

  // REAL live self-check (run at hand start). BB-ANCHORED (CC_SEATORDER_REDESIGN
  // ruling B). Compare the mapping's computed SB/BB against the observed blind
  // seats. The BB anchor carries the play-direction answer; the SB corroborates.
  //   computed   : a mapSeats() result (ok:true)
  //   blindSeats : { sb, bb } observed blind seats (deriveBlindSeats() output, or
  //                an explicit injection — e.g. future label OCR or a test)
  // Returns { ok, warning, expected:{sb,bb}, observed }. Three outcomes:
  //   • PASS      (ok:true)               — BB anchor == button+2 (and SB agrees
  //                                         or is absent).
  //   • MISMATCH  (ok:false, mismatch)    — confident BB anchor DISAGREES with the
  //                                         button ⇒ play direction likely wrong ⇒
  //                                         loud HARD STOP (the one safety event).
  //   • WITHHOLD  (ok:false, inconclusive)— no confident BB anchor (or not a
  //                                         blinds-only frame), OR the anchor agrees
  //                                         but the SB corroboration disagrees
  //                                         (noisy SB). No check, NOT a mismatch —
  //                                         a false hard-stop is its own failure.
  function checkSeatOrder(computed, blindSeats) {
    const observed = blindSeats || {};
    if (!computed || !computed.ok) {
      return { ok: false, inconclusive: true, warning: 'SEAT-ORDER CHECK: no valid seat mapping to verify', expected: null, observed };
    }
    const expected = { sb: computed.sbSeat, bb: computed.bbSeat };
    // WITHHOLD: no confident BB anchor present (or not a blinds-only start).
    if (!observed.bb) {
      return { ok: false, inconclusive: true,
        warning: `SEAT-ORDER CHECK INCONCLUSIVE: no confident BB anchor at a blinds-only start (computed SB/BB = ${expected.sb}/${expected.bb}) — cannot confirm play direction`,
        expected, observed };
    }
    // MISMATCH (HARD STOP): the confident BB anchor disagrees with the button.
    if (observed.bb !== expected.bb) {
      return { ok: false, mismatch: true,
        warning: `⚠ SEAT-ORDER MISMATCH: converter computed the BB blind on ${expected.bb} (SB ${expected.sb}) but the observed BB blind is on ${observed.bb}. Seat order / play direction is likely WRONG — advice is NOT trustworthy until this is resolved (check SEAT_ORDER_CW direction).`,
        expected, observed };
    }
    // Anchor agrees. If SB corroboration is present it must AGREE too, else
    // WITHHOLD (noisy SB must not pass silently, but must not raise a false stop).
    if (observed.sb && observed.sb !== expected.sb) {
      return { ok: false, inconclusive: true,
        warning: `SEAT-ORDER CHECK INCONCLUSIVE: BB anchor on ${observed.bb} agrees with the button, but the observed SB (${observed.sb}) disagrees with computed SB (${expected.sb}) — corroboration noisy, withholding`,
        expected, observed };
    }
    return { ok: true, warning: null, expected, observed };
  }

  return { SEAT_ORDER_CW, HERO_SEAT, mapSeats, deriveBlindSeats, checkSeatOrder };
});
