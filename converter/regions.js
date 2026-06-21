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
    TL: { x: 649, y: 569, w: 287, h: 81 },
    TC: { x: 1384, y: 327, w: 287, h: 81 },
    TR: { x: 2125, y: 561, w: 287, h: 81 },
    BL: { x: 640, y: 1166, w: 287, h: 81 },
    BC: { x: 1384, y: 1476, w: 287, h: 81 },
    BR: { x: 2153, y: 1130, w: 287, h: 81 },
  };

  // §0.5 — bet-chip badges. Left edges already pushed right to clear the
  // printed chip-denomination icon; the BC left edge especially. If a residual
  // icon sliver appears on a live feed, nudge that seat's x right and RE-MEASURE.
  const BET_BOXES = {
    TL: { x: 827, y: 728, w: 230, h: 74 },
    TC: { x: 1436, y: 496, w: 253, h: 74 },
    TR: { x: 1792, y: 566, w: 230, h: 74 },
    BL: { x: 873, y: 1116, w: 230, h: 74 },
    BC: { x: 1424, y: 1178, w: 230, h: 74 },
    BR: { x: 1792, y: 1093, w: 230, h: 74 },
  };

  // §0.6 — pot readout ("Pot: N.NN BB").
  const POT_BOX = box(1361, 542, 322, 81);

  // Card regions — RE-MEASURED 2026-06-17 from the capture corpus, at native
  // 2940×1846 (= REF_FRAME). These rects feed the per-card STRIP cropper
  // (docs/PIP_CROP_GEOMETRY.md): the live path crops each card's 55×130 corner
  // strip (rank + corner pip), anchored at the white-body left + the white top
  // found by scanning DOWN from the box's y. So each box's x/y is chosen to be
  // the strip ANCHOR + scan-start, not a loose bounding rect.
  //
  // PROVENANCE (measured from real card pixels; reconciled to the detector
  // bboxes in poker-vision-analysis/output/{board_cards,hero_hands}.json):
  //   BOARD — capture 20260523_181823, 40 five-card frames. 5 cards, detector
  //     bbox_x 1023→1690 (last right edge 1886), pitch 167 (range 166–167).
  //     White body-left = bbox_x + RANK_MARGIN(30) ⇒ first body 1053. White TOP
  //     = bbox_y(765) + 24 = 789 (exact across all 40). Strip 130 tall ⇒ bottom
  //     919. So BOARD_BOX = (x=1053 body-left, y=765 scan-start [24px of felt
  //     headroom above the white top], w=835=5×pitch [even-slicing → 5 cells of
  //     167, each cell-left landing on a card body-left ±1px], h=200 [covers the
  //     789→919 strip + margin]).
  //   HERO — capture 20260524_224749, 22 two-card hands. Hole cards OVERLAP:
  //     the REAR card is occluded to a 55px exposed sliver at bbox_x 1360; the
  //     FRONT card starts at 1415 (= rear_x + 55, exact) and runs to 1580. White
  //     TOP = bbox_y(1235) + 6 = 1241 (exact across all 44 cards). So
  //     HERO_HOLE_BOX = (x=1360 rear exposed-left, y=1235 scan-start, w=220
  //     [bounds rear+front to 1580], h=160 [covers the 1241→1371 strip; card
  //     bottom 1378]). NOTE: this pair is NOT evenly sliceable — the overlap
  //     slicer anchors the REAR strip at box-left and the FRONT strip at
  //     box-left + 55·(pitch/167); HERO_HOLE_CELLS stays 2 as the card COUNT.
  //   Both captures are full 2940×1846 (verified by PNG read); the table scales
  //   proportionally without reflow (ADR_hero_anchor_regions), so the two
  //   sessions share one px reference, and these boxes place consistently with
  //   the numeric region boxes (pot above board; hole above the BC stack).
  // y/h EXTENDED UP (was 765/200) to give the in-region card-top detector
  // (frame.js _detectCardTop) upward scan room: at off-reference scales the anchor
  // lands the box low, so the card top can be ABOVE the old box top — the window
  // must bracket it. Top (635) stays below the pot (POT_BOX ends y=623) at both REF
  // and live, so the detector's felt→white scan won't latch onto the pot.
  const BOARD_BOX = box(1053, 635, 835, 330);   // 5 cells of 167; detector finds card top within
  const BOARD_CELLS = 5;
  // y/h EXTENDED UP (was 1235/160) so the detector has scan room above the hole
  // cards (the anchor lands the box on the nameplate live; cards are above it).
  // The detector scans top-down and finds the card top BEFORE the nameplate below.
  const HERO_HOLE_BOX = box(1360, 1105, 220, 290); // overlapped pair; rear @left, front @left+55; detector finds tops
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
  const BUTTON_SCAN_RECT = box(792, 387, 1355, 1209); // 680..2260 × 520..1320

  // §0.9 — hero action-timer: a green depleting horizontal bar. NO numeric
  // clock exists. "Time left" = green fill-fraction across this rect.
  // x 1255..1675 (full ≈ 420 px), y 1519..1532.
  const TIMER_RECT = box(523, 1271, 368, 22);

  // Turn indicator: the hero action-button panel (Fold/Check/Call/Bet/Raise) at
  // the bottom. P4 (PROBE_FINDINGS_20260610) MEASURED this box — the prior
  // estimate (2300,1620,600,170) was materially wrong (real panel starts further
  // left and is ~2× wider). action_reader.py's (1700,1685,1240,161) nearly matches
  // and cross-checks. Turn authority is the FULL action set parsed from this panel
  // (observation.classifyActionSet), NOT "any red" — see observation.turnIndicator.
  const ACTION_PANEL_RECT = box(1929, 1705, 1011, 139); // P4-measured

  // Single source of truth for the region set. Both the static (cold-start)
  // captureRegions() and the hero-anchored computeAnchoredRegions() iterate
  // this list, so they can never drift in membership/order, and all geometry
  // stays in the box literals above. ORDER MATTERS (stack/bet interleaved per
  // seat, then pot/board/hole/button/timer/panel) — downstream consumers and
  // the prior captureRegions() output depend on it.
  // The gold NUMBER lands up to ~0.9·w off its plate box and varies per seat /
  // per hand (fast-fold), so the numeric crop is WIDENED to the validated capture
  // window (side 0.90·w, top/bottom 1.30·h). The gold-locate then finds the number
  // wherever it sits; gold-vs-white + the contiguous-run logic drop the name/avatar.
  // Seats are ~735px apart (REF) vs a ~400px window half-width → no neighbour bleed.
  function widenNum(b) {
    const mx = Math.round(0.90 * b.w), my = Math.round(1.30 * b.h);
    return box(Math.max(0, b.x - mx), Math.max(0, b.y - my), b.w + 2 * mx, b.h + 2 * my);
  }
  const REGION_DEFS = [];
  for (const s of SEATS) {
    REGION_DEFS.push({ id: `stack_${s}`, name: `stack_${s}`, seat: s, kind: 'stack', box: widenNum(STACK_BOXES[s]) });
    REGION_DEFS.push({ id: `bet_${s}`, name: `bet_${s}`, seat: s, kind: 'bet', box: widenNum(BET_BOXES[s]) });
  }
  REGION_DEFS.push({ id: 'pot', name: 'pot', kind: 'pot', box: widenNum(POT_BOX) });
  REGION_DEFS.push({ id: 'board', name: 'board', kind: 'cards', cells: BOARD_CELLS, box: BOARD_BOX });
  REGION_DEFS.push({ id: 'hero_hole', name: 'hero_hole', kind: 'cards', cells: HERO_HOLE_CELLS, box: HERO_HOLE_BOX });
  REGION_DEFS.push({ id: 'button_scan', name: 'button_scan', kind: 'button', box: BUTTON_SCAN_RECT });
  REGION_DEFS.push({ id: 'timer', name: 'timer', kind: 'timer', box: TIMER_RECT });
  REGION_DEFS.push({ id: 'action_panel', name: 'action_panel', kind: 'turn', box: ACTION_PANEL_RECT });

  // Build a descriptor in the exact shape the pipeline consumes
  // ({id, name, seat?, kind, cells?, x, y, w, h}), attaching seat/cells only
  // when the def carries them (preserves the historical object shape/order).
  function describe(def, frc) {
    const d = { id: def.id, name: def.name };
    if (def.seat != null) d.seat = def.seat;
    d.kind = def.kind;
    if (def.cells != null) d.cells = def.cells;
    return Object.assign(d, frc);
  }

  // Region descriptors for the useLiveOCR capture hook. `name` matters: the
  // existing fast-path router (live-ocr-test.jsx recognizeFast) routes by name
  // matching /pot|stack|bet|to_?call/, and SKIP_ELIGIBLE hash-skips numeric
  // regions. So stack/bet/pot names below light up the DigitMatcher fast path.
  //
  // This is the STATIC, fraction-of-REF_FRAME placement — correct only when the
  // live capture matches REF_FRAME's geometry. It is the cold-start guess; for
  // resolution-independent placement use computeAnchoredRegions() (below), which
  // re-derives geometry from the detected hero plate each frame.
  function captureRegions() {
    return REGION_DEFS.map((def) => describe(def, frac(def.box)));
  }

  // ───────────────────────────────────────────────────────────────────────
  // HERO-ANCHORED GEOMETRY — resolution-independent region placement.
  //
  // The BetOnline capture resolution VARIES between and within sessions
  // (observed 2940×1558, 2932×1364, 2932×1054, 2696×1912 …). Fraction-of-frame
  // regions fail because the aspect ratio changes with height. A three-height
  // probe established that THE TABLE SCALES PROPORTIONALLY, and that the hero
  // nameplate ("RoloDango", bottom-center, seat BC) has invariant fractional
  // geometry. So hero's measured position + text-height fully determine the
  // table's origin and scale on any frame: anchor every region to hero.
  //
  // The box literals above are authored in px on a 2940×1846 frame (REF_FRAME).
  // Each region is stored as an OFFSET (in REF_FRAME px) of its center from the
  // hero name-text center (REF_HERO), then re-placed each frame from the live
  // hero detection.

  const REF_FRAME = { w: FRAME_W, h: FRAME_H }; // 2940×1846 — frame the box literals are authored in

  // MEASURED INVARIANTS (constant across capture heights). The text-height
  // fraction is the SCALE GAUGE — geometry is keyed off this fraction, never a
  // raw pixel height, so scale holds across resolutions.
  const HERO_TEXTH_FRAC = 0.0276; // hero name-text height / frame height  (SCALE GAUGE)
  const HERO_CY_FRAC    = 0.740;  // hero name-text vertical center / frame height
  const HERO_CX_FRAC    = 0.521;  // hero name-text horizontal center / frame width
                                  // (drifts slightly with aspect → at runtime anchor x to the
                                  //  DETECTED hero cx, never to this constant)

  // REF_HERO expressed in REF_FRAME (1846) px. cx uses frame width (unchanged
  // at 2940 across the probe heights); cy/textH are DERIVED from the invariant
  // fractions so the 0.0276 gauge remains the single source of truth and textH
  // is never a magic pixel constant. (= {cx:1532, cy:1366, textH:50.95}.)
  const REF_HERO = {
    cx: Math.round(HERO_CX_FRAC * REF_FRAME.w),
    cy: Math.round(HERO_CY_FRAC * REF_FRAME.h),
    textH: HERO_TEXTH_FRAC * REF_FRAME.h,
  };

  // Coarse search band (fractions of the frame) where the hero plate lives —
  // lower-center. The loop-owner OCRs THIS band and feeds matched words to
  // detectHero(); regions.js does not capture pixels itself.
  const HERO_SEARCH_BAND = { x: 0.30, y: 0.62, w: 0.40, h: 0.34 }; // x 0.30–0.70, y 0.62–0.96

  // Offset of a box's CENTER from REF_HERO, in REF_FRAME px.
  function offsetOf(b) {
    return { dx: (b.x + b.w / 2) - REF_HERO.cx, dy: (b.y + b.h / 2) - REF_HERO.cy, w: b.w, h: b.h };
  }

  // Last successful transform, reused on detection misses (~30% of frames the
  // hero plate is occluded by the action overlay or mid-animation).
  let _lastAnchor = null; // {originX, originY, scale, k, frameH}
  function resetAnchorCache() { _lastAnchor = null; }

  // detectHero — turn OCR words from the search band into hero {cx, cy, textH}
  // in FULL-FRAME px. Matches /rol/i (OCR may return "RoloDango", "RoloDan",
  // "Redan" …) and takes the LONGEST hit. `words` are Tesseract-style
  // [{text, bbox:{x0,y0,x1,y1}}] in band-local px; the loop-owner passes the
  // band's frame-px origin and the OCR downscale factor (bandScale: local px ÷
  // bandScale = frame px) so local coords map back to full-frame. Returns null
  // on no match — never throws.
  function detectHero(words, opts) {
    opts = opts || {};
    const ox = opts.bandOriginX || 0;
    const oy = opts.bandOriginY || 0;
    const sc = opts.bandScale || 1;
    let best = null;
    for (const w of (words || [])) {
      const t = ((w && w.text) || '').trim();
      if (!/rol/i.test(t)) continue;
      const bb = (w && w.bbox) || {};
      const lw = bb.x1 - bb.x0;
      const lh = bb.y1 - bb.y0;
      if (!(lw > 0) || !(lh > 0)) continue;
      if (!best || t.length > best.len) {
        best = {
          len: t.length, text: t,
          cx: ox + ((bb.x0 + bb.x1) / 2) / sc,
          cy: oy + ((bb.y0 + bb.y1) / 2) / sc,
          textH: lh / sc,
        };
      }
    }
    return best ? { cx: best.cx, cy: best.cy, textH: best.textH, text: best.text } : null;
  }

  // Place one REF_FRAME-px box via a hero transform, return {x,y,w,h} as
  // fractions of the current frame.
  function placeFrac(b, anchor, vw, vh) {
    const off = offsetOf(b);
    const liveCx = anchor.originX + off.dx * anchor.k;
    const liveCy = anchor.originY + off.dy * anchor.k;
    const liveW = off.w * anchor.k;
    const liveH = off.h * anchor.k;
    return { x: (liveCx - liveW / 2) / vw, y: (liveCy - liveH / 2) / vh, w: liveW / vw, h: liveH / vh };
  }

  // computeAnchoredRegions — the resolution-independent placement the loop-owner
  // calls per frame. PURE w.r.t. its inputs (aside from the last-good cache).
  //   heroDetection : {cx, cy, textH} in full-frame px (from detectHero), or null
  //   frameW,frameH : current capture dimensions in px
  // Returns { regions:[…same descriptor shape as captureRegions()…], status,
  //           anchor:{originX,originY,scale}|null }. Three states:
  //   'anchor-live'   — hero found this frame
  //   'anchor-cached' — miss; reusing the last good transform
  //   'anchor-cold'   — no detection ever; REF fractions (== captureRegions())
  function computeAnchoredRegions(heroDetection, frameW, frameH) {
    const vw = frameW || REF_FRAME.w;
    const vh = frameH || REF_FRAME.h;
    let anchor, status;
    if (heroDetection && heroDetection.textH > 0) {
      // Scale off the INVARIANT fraction gauge (robust across resolutions):
      //   scale = (detected_textH / current_frame_h) / HERO_TEXTH_FRAC
      // Offsets are REF_FRAME(1846)-px, so rescale to live-px with
      //   k = scale · current_frame_h / REF_FRAME.h
      // which reduces exactly to detected_textH / REF_HERO.textH (frame_h
      // cancels) — kept in the gauge form so 0.0276 stays the source of truth.
      const scale = (heroDetection.textH / vh) / HERO_TEXTH_FRAC;
      const k = scale * vh / REF_FRAME.h;
      anchor = { originX: heroDetection.cx, originY: heroDetection.cy, scale, k, frameH: vh };
      _lastAnchor = anchor;
      status = 'anchor-live';
    } else if (_lastAnchor) {
      anchor = _lastAnchor;
      status = 'anchor-cached';
    } else {
      return { regions: captureRegions(), status: 'anchor-cold', anchor: null };
    }
    const regions = REGION_DEFS.map((def) => describe(def, placeFrac(def.box, anchor, vw, vh)));
    return { regions, status, anchor: { originX: anchor.originX, originY: anchor.originY, scale: anchor.scale } };
  }

  return {
    FRAME_W, FRAME_H, SEATS, HERO_SEAT, HERO_INDEX,
    STACK_BOXES, BET_BOXES, POT_BOX, BUTTON_SLOTS, BUTTON_SCAN_RECT,
    TIMER_RECT, ACTION_PANEL_RECT,
    BOARD_BOX, BOARD_CELLS, HERO_HOLE_BOX, HERO_HOLE_CELLS,
    frac, box, captureRegions,
    // hero-anchored geometry:
    REF_FRAME, REF_HERO, HERO_TEXTH_FRAC, HERO_CY_FRAC, HERO_CX_FRAC,
    HERO_SEARCH_BAND, REGION_DEFS, offsetOf, detectHero,
    computeAnchoredRegions, resetAnchorCache,
  };
});
