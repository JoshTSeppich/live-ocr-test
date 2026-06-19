// converter/frame.js — the SEAM glue. Turns the capture loop's per-frame
// `getCrops(regionId) → {color, binarized}` (from useLiveOCR's onFrame) into the
// `frame` accessor that observation.observeFrame consumes.
//
// THE WHOLE POINT (the seam the design depends on): occlusion gating, the button
// blob, and the timer bar read the COLOR source crop; only the numeric digit
// matcher reads the binarized crop. Wiring binarized where colour belongs
// silently disables green/yellow detection and reopens the blind-chip-as-stack
// failure. So getColor → color, getBinarized → binarized, card cells slice the
// COLOR crop.
//
// Resolution: §0.8 button slots are native 2940×1846 pixels. The live capture
// may differ, so we scale the slots / scan offset / blob-size window by the
// actual video dimensions. Occlusion/timer/cards operate on the crop directly
// (fractional regions) and need no scaling; only the button blob does.
//
// UMD: `window.PokerFrame` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerFrame = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Regions = (typeof require === 'function') ? require('./regions.js') : (root && root.PokerRegions);

  // ─── per-card CORNER-STRIP cropping (docs/PIP_CROP_GEOMETRY.md) ──────────────
  // The suit-pip classifier (engine.js Component 4) and the rank/colour hashes
  // are CALIBRATED to one crop: a card's 55×130 left-corner strip (rank + corner
  // pip), anchored at the WHITE-BODY LEFT and the WHITE TOP, at native pitch 167.
  // So the live path must feed match() THAT strip, not a full-height cell. This
  // replaces the old even-slice (which fed full cards — wrong input for the pip
  // classifier). Strip size scales with the card pitch at the live resolution
  // (strip_w = 55/167·pitch, strip_h = 130/167·pitch); the matcher's hash
  // normalises size, but native is exact 55×130 (= the template source).
  const STRIP_W_NATIVE = 55, STRIP_H_NATIVE = 130, PITCH_NATIVE = 167;

  // ─── in-region card-top DETECTOR thresholds (MEASURED from corpus, Stage 1) ──
  // A board card is felt (lum~75, brightFrac≈0) → a SHARP, SUSTAINED white block
  // (lum~240, brightFrac≈0.9-1.0). The detector finds that felt→white card edge
  // and crops the calibrated strip from it — self-correcting the anchor's Y, which
  // lands low at off-reference scales. These reject clutter (pot/chips/badges) that
  // the upward-extended search window passes over: a chip/glyph is NOT felt→a
  // full-width solid-white block sustained for CARD_TOP_BORDER rows.
  const CARD_TOP_WHITE_FRAC = 0.80;   // "solid white" row: ≥80% of strip-width cols bright (measured card top ≈0.91-1.0)
  const CARD_TOP_DARK_FRAC  = 0.25;   // "felt/dark" row: ≤25% bright (measured felt ≈0.00) — must sit just above the edge
  const CARD_TOP_BORDER_FRAC = 0.07;  // TUNABLE clutter-rejector: solid-white top-border run, as a fraction of strip height
                                      // (~9px at native 130). Longer = stricter (rejects more clutter, risks thin cards).
  const CARD_TOP_FELT_GAP = 3;        // rows above the candidate top that must read felt (the sharp card edge)

  // Detect a card's TOP row within cols [xL,xR) of `crop`: the first felt→solid-
  // white card edge with a sustained white top-border. Returns the row, or -1 if
  // no card signature is found (felt / clutter only) → is_present = false.
  function _detectCardTop(crop, xL, xR, sh) {
    xR = Math.min(xR, crop.w);
    const border = Math.max(2, Math.round(CARD_TOP_BORDER_FRAC * sh));
    for (let y = 1; y < crop.h - border; y++) {
      if (_rowBright(crop, xL, xR, y) < CARD_TOP_WHITE_FRAC) continue;                 // not solid white
      if (_rowBright(crop, xL, xR, Math.max(0, y - CARD_TOP_FELT_GAP)) > CARD_TOP_DARK_FRAC) continue; // no felt above → mid-card/chip
      let solid = true;                                                               // sustained white border?
      for (let k = 0; k < border; k++) if (_rowBright(crop, xL, xR, y + k) < CARD_TOP_WHITE_FRAC) { solid = false; break; }
      if (solid) return y;
    }
    return -1;
  }

  const _lum = (rgba, w, x, y) => { const i = (y * w + x) * 4; return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; };
  // fraction of rows in [y0,y1) at column x that are bright (lum > 150)
  function _colBright(crop, x, y0, y1) {
    let n = 0, tot = 0;
    for (let y = y0; y < y1; y++) { tot++; if (_lum(crop.rgba, crop.w, x, y) > 150) n++; }
    return tot ? n / tot : 0;
  }
  // fraction of cols in [x0,x1) at row y that are bright
  function _rowBright(crop, x0, x1, y) {
    let n = 0, tot = 0;
    for (let x = x0; x < x1; x++) { tot++; if (_lum(crop.rgba, crop.w, x, y) > 150) n++; }
    return tot ? n / tot : 0;
  }
  // First column (scanning right from xFrom, bounded by xTo) whose vertical
  // brightness over the crop exceeds 0.4 — the card's white-body LEFT edge.
  // (The felt→white transition; the rank glyph sits inset, so the very-left card
  // column is solid white margin. Adjacent board cards abut, so we never scan
  // LEFT of the cell start — that would latch onto the previous card's tail.)
  function _whiteLeft(crop, xFrom, xTo) {
    for (let x = xFrom; x < xTo; x++) if (_colBright(crop, x, 0, crop.h) > 0.4) return x;
    return xFrom;
  }
  // First row whose brightness across [xL, xR) exceeds 0.5 — the white TOP edge
  // (cardTop scan; felt above the card is dark). Mirrors the calibration scan.
  function _whiteTop(crop, xL, xR) {
    for (let y = 0; y < crop.h; y++) if (_rowBright(crop, xL, Math.min(xR, crop.w), y) > 0.5) return y;
    return 0;
  }
  // Copy an sw×sh RGBA strip from (sx,sy); rows/cols past the crop are zero-padded.
  function _cropStrip(crop, sx, sy, sw, sh) {
    const out = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const cy = sy + y; if (cy < 0 || cy >= crop.h) continue;
      for (let x = 0; x < sw; x++) {
        const cx = sx + x; if (cx < 0 || cx >= crop.w) continue;
        const s = (cy * crop.w + cx) * 4, d = (y * sw + x) * 4;
        out[d] = crop.rgba[s]; out[d + 1] = crop.rgba[s + 1]; out[d + 2] = crop.rgba[s + 2]; out[d + 3] = crop.rgba[s + 3];
      }
    }
    return { rgba: out, w: sw, h: sh };
  }
  // One card's strip: find white-left in [xFrom,xTo), white-top over the strip
  // columns, crop sw×sh. Returns {rgba,w,h}.
  function _cardStrip(crop, xFrom, xTo, sw, sh) {
    const wl = _whiteLeft(crop, xFrom, xTo);
    const wt = _whiteTop(crop, wl, wl + sw);
    return _cropStrip(crop, wl, wt, sw, sh);
  }

  // Slice a card-region {rgba,w,h} crop into n per-card 55×130-proportioned corner
  // strips for match(). opts.layout:
  //   'board' (default) — n non-overlapping cards; even cells, white-left + cardTop
  //                       scan within each cell (cells abut → no left margin).
  //   'hero'            — 2 OVERLAPPED hole cards; the REAR card is occluded to a
  //                       ~strip-wide exposed sliver at the region's left, the
  //                       FRONT card begins one strip-width to its right (front_x −
  //                       rear_x == exposed width, measured). Anchor rear on its
  //                       exposed left corner, front on its own left corner.
  function sliceCells(crop, n, opts) {
    if (!crop || n < 1) return null;
    opts = opts || {};
    const layout = opts.layout || 'board';
    const nativeW = layout === 'hero' ? Regions.HERO_HOLE_BOX.w : Regions.BOARD_BOX.w;
    const f = nativeW ? crop.w / nativeW : 1;           // live/native scale of this region
    const sw = Math.max(1, Math.round(STRIP_W_NATIVE * f));
    const sh = Math.max(1, Math.round(STRIP_H_NATIVE * f));

    if (layout === 'hero') {
      // Overlapped pair. rear exposed at the region's left corner; front begins one
      // exposed-width (== strip width, measured front_x−rear_x==55) to its right.
      // Detect each card's TOP (felt→white) so it lands on the rank corner, not the
      // nameplate below; is_present gates a missing/occluded card → no classify.
      const rl = _whiteLeft(crop, 0, crop.w);
      const fl = rl + sw;
      const mk = (x) => {
        const top = _detectCardTop(crop, x, x + sw, sh);
        return top >= 0
          ? Object.assign(_cropStrip(crop, x, top, sw, sh), { present: true })
          : Object.assign(_cropStrip(crop, x, 0, sw, sh), { present: false });
      };
      return [mk(rl), mk(fl)];
    }

    // Board cards sit at FIXED, evenly-pitched slots (residual ≤1px from a uniform
    // grid), so the slot left = cell left = the card's body-left (calibration
    // anchor). The VERTICAL is the problem: the anchor lands low at off-reference
    // scales, so we DETECT each card's true top (felt→white edge) within the cell
    // and crop the strip from there. is_present gates open slots (no card found).
    const cellW = crop.w / n;
    const cells = [];
    for (let i = 0; i < n; i++) {
      const cellL = Math.round(i * cellW);
      const top = _detectCardTop(crop, cellL, cellL + sw, sh);
      if (top < 0) {                                   // no card signature → absent slot
        cells.push(Object.assign(_cropStrip(crop, cellL, 0, sw, sh), { present: false }));
      } else {
        cells.push(Object.assign(_cropStrip(crop, cellL, top, sw, sh), { present: true }));
      }
    }
    return cells;
  }

  // Button-blob params scaled from native 2940×1846 to the live video size.
  function scaledButtonOpts(videoW, videoH) {
    const sx = videoW ? videoW / Regions.FRAME_W : 1;
    const sy = videoH ? videoH / Regions.FRAME_H : 1;
    if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return {}; // native — use defaults
    const slots = {};
    for (const s of Object.keys(Regions.BUTTON_SLOTS)) {
      slots[s] = { x: Regions.BUTTON_SLOTS[s].x * sx, y: Regions.BUTTON_SLOTS[s].y * sy };
    }
    const area = sx * sy;
    return {
      buttonSlots: slots,
      offsetX: Regions.BUTTON_SCAN_RECT.x * sx,
      offsetY: Regions.BUTTON_SCAN_RECT.y * sy,
      buttonMinSize: 150 * area,
      buttonMaxSize: 4000 * area,
      buttonMaxDist: 120 * Math.max(sx, sy),
    };
  }

  // Build the observeFrame `frame` accessor from getCrops + per-snapshot context.
  //   getCrops : (regionId) => {color:{rgba,w,h}, binarized:{rgba,w,h}} | null
  //   dims     : { videoW, videoH } from onFrame (for button scaling)
  //   deps     : { digitMatcher, cardMatcher, heroBet }
  // Returns { frame, observeOpts } — pass both to observeFrame(frame, observeOpts).
  function buildFrame(getCrops, dims, deps) {
    deps = deps || {};
    dims = dims || {};
    const colorOf = (id) => { const c = getCrops(id); return c ? c.color : null; };
    const binOf = (id) => { const c = getCrops(id); return c ? c.binarized : null; };
    const frame = {
      digitMatcher: deps.digitMatcher,
      cardMatcher: deps.cardMatcher,
      heroBet: deps.heroBet,
      getColor: colorOf,
      getBinarized: binOf,
      getCardCells: (id, n) => sliceCells(colorOf(id), n, { layout: id === 'hero_hole' ? 'hero' : 'board' }),
    };
    const observeOpts = scaledButtonOpts(dims.videoW, dims.videoH);
    return { frame, observeOpts };
  }

  return { buildFrame, sliceCells, scaledButtonOpts };
});
