// converter/regions.js — fixed table geometry for the BetOnline Boost 6-max
// converter. ALL coordinates are the §0 probe-measured pixels at the native
// capture resolution 2940×1846 (CONVERTER_BUILD_SPEC §0.4/0.5/0.6/0.8/0.9).
// DO NOT re-derive these — they are measured ground truth. If something looks
// off on a live feed, RE-MEASURE against a fresh capture; never hand-tweak by
// guess (SPEC HARD RULE: measure from real pixels).
//
// Seat layout is FIXED. Six labels, hero is ALWAYS BC (bottom-center).
// Order is canonical and used as the seat index everywhere downstream.
//
// UMD: `window.PokerRegions` in the browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerRegions = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRAME_W = 2940;
  const FRAME_H = 1846;

  // Canonical seat order. Hero is BC (index 4).
  const SEATS = ['TL', 'TC', 'TR', 'BL', 'BC', 'BR'];
  const HERO_SEAT = 'BC';
  const HERO_INDEX = SEATS.indexOf(HERO_SEAT);

  // Box = {x, y, w, h} in native px. Helper to fractionalize for useLiveOCR
  // (the capture hook takes regions as fractions of the video frame).
  function frac(box) {
    return { x: box.x / FRAME_W, y: box.y / FRAME_H, w: box.w / FRAME_W, h: box.h / FRAME_H };
  }
  function box(x, y, w, h) { return { x, y, w, h }; }

  // §0.4 — stack readout plates (white "N.NN BB" on dark).
  const STACK_BOXES = {
    TL: box(560, 600, 490, 190), TC: box(1280, 355, 560, 175), TR: box(2290, 600, 490, 190),
    BL: box(490, 1095, 490, 175), BC: box(1380, 1450, 360, 75), BR: box(2250, 1095, 490, 175),
  };

  // §0.5 — bet-chip badges. Left edges already pushed right to clear the
  // printed chip-denomination icon; the BC left edge especially. If a residual
  // icon sliver appears on a live feed, nudge that seat's x right and RE-MEASURE.
  const BET_BOXES = {
    TL: box(862, 608, 245, 70), TC: box(1430, 585, 240, 70), TR: box(2000, 590, 240, 70),
    BL: box(858, 1110, 250, 70), BC: box(1485, 1148, 215, 65), BR: box(1862, 1110, 250, 70),
  };

  // §0.6 — pot readout ("Pot: N.NN BB").
  const POT_BOX = box(1280, 628, 370, 62);

  // Card regions. §0 referenced the card pipeline (MultiSignatureMatcher) but
  // never captured the rects — these were MEASURED the same way as the stack/bet
  // boxes (card-face connected components @ 20260603_121222), validated on real
  // pixels: a 5-card river frame fixes the board at x=1053→1721, pitch ~167,
  // y=789, h=230; the matcher round-trips + cross-frame-matches all cells at
  // confidence 1.0, and empty flop cells fall to ~0.75 (< the 0.85 threshold),
  // so board card COUNT drives street correctly. Slice each into N even cells
  // (engine cardCellsFromRegion style: width / N).
  const BOARD_BOX = box(1053, 789, 835, 230);   // 5 cells of 167 px
  const BOARD_CELLS = 5;
  const HERO_HOLE_BOX = box(1359, 1238, 222, 158); // 2 cells of 111 px
  const HERO_HOLE_CELLS = 2;

  // §0.8 — button-puck slot anchors (puck CENTERS, not boxes). The puck is
  // located by blob-clustering (see observation.detectButton), then snapped to
  // the nearest of these six with a distance gate.
  const BUTTON_SLOTS = {
    TL: { x: 743, y: 825 }, TC: { x: 1471, y: 565 }, TR: { x: 2181, y: 816 },
    BL: { x: 946, y: 1170 }, BC: { x: 1727, y: 1254 }, BR: { x: 1990, y: 1170 },
  };
  // A single rectangle enclosing all six slots (+margin) — the crop the puck
  // blob scan runs over, so the search is local, not whole-frame. Centroids
  // found here are crop-local; add {x,y} back to map into frame coords.
  const BUTTON_SCAN_RECT = box(680, 520, 1580, 800); // 680..2260 × 520..1320

  // §0.9 — hero action-timer: a green depleting horizontal bar. NO numeric
  // clock exists. "Time left" = green fill-fraction across this rect.
  // x 1255..1675 (full ≈ 420 px), y 1519..1532.
  const TIMER_RECT = box(1255, 1519, 420, 13);

  // Turn indicator: the hero action-button panel (Fold/Call/Raise) at bottom
  // right. §0 did NOT measure this box (the four probes never bounded it), so
  // these coords are LIVE-UNVALIDATED — a starting estimate from the reference
  // frame, to be confirmed/re-measured at first live bring-up. The detector
  // (observation.turnIndicator) is the contract; the rect is calibration.
  const ACTION_PANEL_RECT = box(2300, 1620, 600, 170); // LIVE-UNVALIDATED

  // Region descriptors for the useLiveOCR capture hook. `name` matters: the
  // existing fast-path router (live-ocr-test.jsx recognizeFast) routes by name
  // matching /pot|stack|bet|to_?call/, and SKIP_ELIGIBLE hash-skips numeric
  // regions. So stack/bet/pot names below light up the DigitMatcher fast path.
  function captureRegions() {
    const out = [];
    for (const s of SEATS) {
      out.push({ id: `stack_${s}`, name: `stack_${s}`, seat: s, kind: 'stack', ...frac(STACK_BOXES[s]) });
      out.push({ id: `bet_${s}`, name: `bet_${s}`, seat: s, kind: 'bet', ...frac(BET_BOXES[s]) });
    }
    out.push({ id: 'pot', name: 'pot', kind: 'pot', ...frac(POT_BOX) });
    out.push({ id: 'board', name: 'board', kind: 'cards', cells: BOARD_CELLS, ...frac(BOARD_BOX) });
    out.push({ id: 'hero_hole', name: 'hero_hole', kind: 'cards', cells: HERO_HOLE_CELLS, ...frac(HERO_HOLE_BOX) });
    out.push({ id: 'button_scan', name: 'button_scan', kind: 'button', ...frac(BUTTON_SCAN_RECT) });
    out.push({ id: 'timer', name: 'timer', kind: 'timer', ...frac(TIMER_RECT) });
    out.push({ id: 'action_panel', name: 'action_panel', kind: 'turn', ...frac(ACTION_PANEL_RECT) });
    return out;
  }

  return {
    FRAME_W, FRAME_H, SEATS, HERO_SEAT, HERO_INDEX,
    STACK_BOXES, BET_BOXES, POT_BOX, BUTTON_SLOTS, BUTTON_SCAN_RECT,
    TIMER_RECT, ACTION_PANEL_RECT,
    BOARD_BOX, BOARD_CELLS, HERO_HOLE_BOX, HERO_HOLE_CELLS,
    frac, box, captureRegions,
  };
});
