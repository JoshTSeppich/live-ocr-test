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
//     computed SB/BB seats against the seats actually wearing the green blind
//     badges (detectable on the live feed). It MUST be run first at bring-up and
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

  // REAL live self-check (run FIRST at bring-up). Compare the seats the mapping
  // computed as SB/BB against the seats observed wearing green blind badges.
  // Disagreement ⇒ the seat order / play direction is wrong ⇒ DO NOT trust advice.
  //   computed   : a mapSeats() result (ok:true)
  //   badgeSeats : iterable of screen labels detected wearing a green blind badge
  // Returns { ok, warning, expected:[sb,bb], observed:[...] }. ok:false carries a
  // loud, operator-facing warning string the converter must surface.
  function checkSeatOrder(computed, badgeSeats) {
    const observed = [...new Set(badgeSeats)].sort();
    if (!computed || !computed.ok) {
      return { ok: false, warning: 'SEAT-ORDER CHECK: no valid seat mapping to verify', expected: null, observed };
    }
    const expected = [computed.sbSeat, computed.bbSeat].sort();
    // Need both badges visible to verify; absent ⇒ inconclusive, not pass.
    if (observed.length < 2) {
      return { ok: false, inconclusive: true,
        warning: `SEAT-ORDER CHECK INCONCLUSIVE: expected blind badges on ${expected.join(',')}, but observed badges on ${observed.length ? observed.join(',') : 'none'} — cannot confirm play direction`,
        expected, observed };
    }
    const match = expected.length === observed.length && expected.every((s, i) => s === observed[i]);
    if (match) return { ok: true, warning: null, expected, observed };
    return { ok: false,
      warning: `⚠ SEAT-ORDER MISMATCH: converter computed SB/BB on ${expected.join(',')} but blind badges are on ${observed.join(',')}. Seat order / play direction is likely WRONG — advice is NOT trustworthy until this is resolved (check SEAT_ORDER_CW direction).`,
      expected, observed };
  }

  return { SEAT_ORDER_CW, HERO_SEAT, mapSeats, checkSeatOrder };
});
