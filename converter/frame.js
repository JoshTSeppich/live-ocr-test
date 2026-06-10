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

  // Slice a {rgba,w,h} crop into n even vertical cells (engine cardCellsFromRegion
  // style: floor(w/n), last cell gets the remainder).
  function sliceCells(crop, n) {
    if (!crop || n < 1) return null;
    const cw = Math.floor(crop.w / n);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const sx = i * cw;
      const sw = i === n - 1 ? crop.w - sx : cw;
      const out = new Uint8Array(sw * crop.h * 4);
      for (let y = 0; y < crop.h; y++) {
        const srcStart = (y * crop.w + sx) * 4;
        const dstStart = y * sw * 4;
        for (let j = 0; j < sw * 4; j++) out[dstStart + j] = crop.rgba[srcStart + j];
      }
      cells.push({ rgba: out, w: sw, h: crop.h });
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
      getCardCells: (id, n) => sliceCells(colorOf(id), n),
    };
    const observeOpts = scaledButtonOpts(dims.videoW, dims.videoH);
    return { frame, observeOpts };
  }

  return { buildFrame, sliceCells, scaledButtonOpts };
});
