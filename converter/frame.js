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
  // a card is a TALL bright body (rank ink only dips it); clutter (badges/text/
  // chips in the extended search window) is short → reject it by the body check.
  const CARD_BODY_FRAC = 0.70;        // how far below the top to verify (fraction of strip height) — a card is TALL
  const CARD_BODY_FRAC_BRIGHT = 0.40; // a "still on the card" row: ≥40% of the run cols bright (rank-ink dip tolerated)
  const CARD_BODY_MIN = 0.80;         // ≥80% of those rows must be card-bright (short banners/badges fail)
  // ── showdown-DIM handling (two-pass) ──────────────────────────────────────
  // At showdown the client GRAYS cards not in the winning hand (board AND villain
  // hole cards), body lum ~120-150 vs white ~240. The PRIMARY pass uses the
  // absolute white bar below (untouched — keeps the 93.9%/0-FP/0-wrong baseline). A
  // SECOND pass then fills only the GAPS the primary left, at a RELATIVE bar, and
  // keeps only genuinely-DIM cards. Any dim card is then forced to ABSTAIN in the
  // read path (engine never trusts a white-calibrated match on a dim render) — so
  // even imperfect dim detection can't produce a confident-wrong read.
  const BRIGHT_WHITE = 150;           // absolute white-body bar (the primary pass — measured corpus white ≈240, felt ≈75)
  const FELT_BAND_FRAC = 0.12;        // top band of a region used to estimate local felt (sits above the cards)
  const BRIGHT_MARGIN = 30;           // RELATIVE bar = feltLevel + this (catches dim bodies ≥ felt+~40 while excluding felt)
  const DIM_BODY_GAP = 110;           // a card is DIM if its body brightness exceeds felt by LESS than this
                                      // (measured: dim body ≈ felt+69, white ≈ felt+150 → 110 splits them at any dim level)

  // Longest run of consecutive bright (lum>150) columns at row y within [xL,xR).
  // The card's white top border is a long run; a chip/glyph/text is a short one.
  function _brightRun(crop, xL, xR, y, th) {
    th = th == null ? BRIGHT_WHITE : th;
    let run = 0, runStart = -1, bestLen = 0, bestStart = -1;
    for (let x = xL; x < xR; x++) {
      if (_lum(crop.rgba, crop.w, x, y) > th) { if (run === 0) runStart = x; run++; if (run > bestLen) { bestLen = run; bestStart = runStart; } }
      else run = 0;
    }
    return { start: bestStart, len: bestLen };
  }
  // Detect a card's TOP-LEFT CORNER within cols [xL,xR) of `crop`: the first row
  // with a CARD-WIDTH white run (top border), felt just above, the run SUSTAINED
  // for the border depth. The run's start = the white-body LEFT edge (calibration
  // anchor); the row = the white TOP. Returns {left,top} or null if no card
  // signature (felt/clutter only) → is_present=false. Self-corrects BOTH axes: the
  // anchor can be off in x (live card pitch/width drift) as well as y.
  function _detectCardCorner(crop, xL, xR, sw, sh, th) {
    th = th == null ? BRIGHT_WHITE : th;
    xR = Math.min(xR, crop.w);
    const border = Math.max(2, Math.round(CARD_TOP_BORDER_FRAC * sh));
    const minRun = Math.max(3, Math.round(sw * 0.8)); // a card top spans ≥ a strip width; a chip/glyph does not
    const bodyRows = Math.max(border + 1, Math.round(sh * CARD_BODY_FRAC)); // a card is TALL; clutter is short
    for (let y = 1; y < crop.h - border; y++) {
      const r = _brightRun(crop, xL, xR, y, th);
      if (r.len < minRun) continue;                                                   // no card-width white run
      const rL = r.start, rR = rL + minRun;
      if (_rowBright(crop, rL, rR, Math.max(0, y - CARD_TOP_FELT_GAP), th) > CARD_TOP_DARK_FRAC) continue; // no felt above → mid-card/chip
      let solid = true;                                                               // sustained white border under the run?
      for (let k = 0; k < border; k++) if (_rowBright(crop, rL, rR, y + k, th) < CARD_TOP_WHITE_FRAC) { solid = false; break; }
      if (!solid) continue;
      // CARD-BODY check: a card stays mostly bright for ~its height below the top
      // (rank ink only dips it); short clutter (badges/text/chips) hits felt fast.
      // Measure over the FULL card-width run (mostly white) — NOT the left strip
      // band, which holds the rank glyph and would penalise ink-heavy ranks (5,10…).
      const bR = Math.min(rL + r.len, xR);
      let body = 0, rows = 0;
      for (let k = 0; k < bodyRows && y + k < crop.h; k++) { rows++; if (_rowBright(crop, rL, bR, y + k, th) > CARD_BODY_FRAC_BRIGHT) body++; }
      if (!rows || body / rows < CARD_BODY_MIN) continue;
      // LEFT = the white-body edge measured a few rows BELOW the top, past the
      // rounded top-left corner (where the edge is straight). The top row's bright
      // run can start a few px in (the corner), which would shift the strip; the
      // straight-edge row gives the true body-left (== calibration anchor).
      const lrow = Math.min(crop.h - 1, y + border);
      let left = xL;
      for (let x = xL; x < xR; x++) { if (_lum(crop.rgba, crop.w, x, lrow) > th) { left = x; break; } }
      // right = end of the card-width top run (its right edge), for advancing the
      // sequential board scan past this card to find the next one.
      return { left, top: y, right: rL + r.len };
    }
    return null;
  }
  // One left→right sweep at threshold `th`, up to `max` corners, advancing past each.
  function _sweep(crop, sw, sh, max, th) {
    const found = [];
    let x = 0;
    while (x < crop.w - Math.round(sw * 0.5) && found.length < max) {
      const c = _detectCardCorner(crop, x, crop.w, sw, sh, th);
      if (!c) break;
      found.push(c);
      x = Math.max(c.left + sw, c.right) + 2; // past this card, then look for the next
    }
    return found;
  }
  // TWO-PASS board detection. PRIMARY: precise white-card sweep at the absolute bar
  // (untouched baseline). SECOND: only if cards are missing, sweep at the RELATIVE
  // bar and keep corners that (a) don't overlap a primary card and (b) are genuinely
  // DIM — tagging them {dim:true} so the read path forces them to abstain. Best-
  // effort: any dim card the second pass finds is safe (abstains); ones it misses
  // just no-read. The primary path is never altered, so the baseline can't regress.
  function _detectBoardCards(crop, sw, sh, max) {
    const primary = _sweep(crop, sw, sh, max, BRIGHT_WHITE);
    const felt = _feltLevel(crop), dimTh = felt + BRIGHT_MARGIN;
    // Re-flag any primary card whose body is actually DIM (a showdown card whose
    // body grazes the white bar can be caught by the primary). Flagging it → the
    // read path abstains, so a borderline dim card never reads against white
    // templates. The primary DETECTION (count/framing) is unchanged — only the tag.
    for (const c of primary) if (_cardIsDim(crop, c, sw, sh, felt)) c.dim = true;
    if (primary.length >= max) return primary;
    // SECOND pass: scan only the GAPS the primary left (before/between/after its
    // cards), each bounded — so a dim card whose top sits lower than a neighbouring
    // white card isn't skipped (the y-first detector would otherwise jump to the
    // white card). Keep only genuinely-dim finds; tag {dim:true} → read path abstains.
    const sorted = primary.slice().sort((a, b) => a.left - b.left);
    const bounds = []; let prev = 0;
    for (const c of sorted) { bounds.push([prev, c.left]); prev = c.right; }
    bounds.push([prev, crop.w]);
    const dim = [];
    for (const [gL, gR] of bounds) {
      if (gR - gL < Math.round(sw * 0.8)) continue;                  // gap too small for a card
      let x = gL;
      while (x < gR - Math.round(sw * 0.5) && primary.length + dim.length < max) {
        const c = _detectCardCorner(crop, x, gR, sw, sh, dimTh);
        if (!c) break;
        if (_cardIsDim(crop, c, sw, sh, felt)) { c.dim = true; dim.push(c); }
        x = Math.max(c.left + sw, c.right) + 2;
      }
    }
    // Primary (white) cards are real reads and must NEVER be dropped by the cap — a
    // spurious dim find must not displace a true card. Keep all primary, then fill
    // remaining slots with dim, then order by position.
    const out = primary.slice();
    for (const d of dim) { if (out.length >= max) break; out.push(d); }
    return out.sort((a, b) => a.left - b.left);
  }

  const _lum = (rgba, w, x, y) => { const i = (y * w + x) * 4; return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; };
  // fraction of rows in [y0,y1) at column x that are bright (lum > 150)
  function _colBright(crop, x, y0, y1) {
    let n = 0, tot = 0;
    for (let y = y0; y < y1; y++) { tot++; if (_lum(crop.rgba, crop.w, x, y) > 150) n++; }
    return tot ? n / tot : 0;
  }
  // fraction of cols in [x0,x1) at row y that are bright
  function _rowBright(crop, x0, x1, y, th) {
    th = th == null ? BRIGHT_WHITE : th;
    let n = 0, tot = 0;
    for (let x = x0; x < x1; x++) { tot++; if (_lum(crop.rgba, crop.w, x, y) > th) n++; }
    return tot ? n / tot : 0;
  }
  // Local felt level: median luminance of the region's top band (above the cards),
  // stable whether or not cards are dimmed — the basis for the RELATIVE dim bar.
  function _feltLevel(crop) {
    const band = Math.max(4, Math.round(crop.h * FELT_BAND_FRAC));
    const vals = [];
    for (let y = 0; y < band; y++) for (let x = 0; x < crop.w; x += 2) vals.push(_lum(crop.rgba, crop.w, x, y));
    if (!vals.length) return 80;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }
  // Is the card at corner c DIM (showdown-grayed)? Median of the bright body pixels
  // in its top-strip region; dim if that body barely exceeds felt (measured: dim
  // body ≈ felt+69, white ≈ felt+150). Adapts to any dim level (relative to felt).
  function _cardIsDim(crop, c, sw, sh, felt) {
    const x1 = Math.min(c.left + sw, crop.w), y1 = Math.min(c.top + sh, crop.h);
    const v = [];
    for (let y = c.top; y < y1; y++) for (let x = c.left; x < x1; x++) { const L = _lum(crop.rgba, crop.w, x, y); if (L > felt + BRIGHT_MARGIN) v.push(L); }
    if (!v.length) return true;
    v.sort((a, b) => a - b);
    return (v[v.length >> 1] - felt) < DIM_BODY_GAP;
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

    const absent = (x) => Object.assign(_cropStrip(crop, x, 0, sw, sh), { present: false });

    if (layout === 'hero') {
      // Overlapped pair. Detect the rear card's exposed TOP-LEFT corner anywhere in
      // the region; the front begins one exposed-width (== strip width, measured
      // front_x−rear_x==55) to its right — detect the front's own corner there too.
      // The corner detector lands on the rank corner (not the nameplate below) and
      // self-corrects x/y; is_present gates a missing/occluded card → no classify.
      const rc = _detectCardCorner(crop, 0, crop.w, sw, sh);
      if (!rc) return [absent(0), absent(sw)];
      const fl = rc.left + sw;
      const fc = _detectCardCorner(crop, fl, crop.w, sw, sh);
      const rear = Object.assign(_cropStrip(crop, rc.left, rc.top, sw, sh), { present: true });
      const front = fc
        ? Object.assign(_cropStrip(crop, fc.left, fc.top, sw, sh), { present: true })
        : absent(fl);
      return [rear, front];
    }

    // Board: DETECT the cards by scanning the whole region left→right, rather than
    // trusting a fixed even-cell grid. The anchor is off in both axes at off-
    // reference scales, AND the live table centres/spreads the board by card count
    // (flop/turn/river), so the real pitch ≠ the anchored cell width — a fixed grid
    // straddles card edges and the rank slides out of the strip. Sequential corner
    // detection lands on each card wherever it sits; trailing slots → absent.
    const found = _detectBoardCards(crop, sw, sh, n);
    const cells = [];
    for (let i = 0; i < n; i++) {
      cells.push(found[i]
        ? Object.assign(_cropStrip(crop, found[i].left, found[i].top, sw, sh), { present: true, dim: !!found[i].dim, x: found[i].left })
        : absent(Math.round(i * crop.w / n)));
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
