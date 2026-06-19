// converter/observation.js — Layer 1 of the converter: per-frame STATELESS
// observation with confidence tags (CONVERTER_BUILD_SPEC §2 Layer 1, §1).
//
// Every function here is pure: it takes RGBA pixel buffers (Uint8ClampedArray /
// Uint8Array, 4 bytes/px) + geometry and returns a tagged read. No canvas, no
// React, no DOM, no time — so the whole layer runs under `node --test` against
// fixture crops. The browser capture loop (live-ocr.jsx useLiveOCR) feeds real
// crops in; tests feed synthetic ones. Same code path.
//
// THE SPINE (§1): absolute-first, never fabricate. Each read is tagged:
//   'read'      — confident direct read of THIS frame
//   'occluded'  — a color/pixel overlay (blind badge / timer) covers the plate;
//                 we refuse to OCR-and-guess
//   'no-read'   — nothing legible (empty seat, mid-animation, covered)
// The assembler only trusts a field when it is 'read'. 'occluded'/'no-read'
// withhold — never substitute a guess.
//
// Color masks + thresholds below are MEASURED from the §0 reference capture
// 20260603_121222 (2940×1846), not invented. Calibration notes inline. They are
// the documented defaults; every consumer may override via opts for live re-cal.
//
// UMD: `window.PokerObservation` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerObservation = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  // engine.js for DigitMatcher/MultiSignatureMatcher; regions.js for slots.
  const Engine = (typeof require === 'function') ? require('../engine.js') : (root && root.PokerEngine);
  const Regions = (typeof require === 'function') ? require('./regions.js') : (root && root.PokerRegions);

  // ─── measured color masks (per-pixel predicates over rgba at offset i) ─────
  // Yellow/gold puck (§0.8). Validated: fires on the puck disc, and on the gold
  // jackpot banner — which is why the puck needs blob-clustering + a distance
  // gate, NOT a global yellow median. meanRGB on the puck ≈ [202,158,64].
  function isYellow(rgba, i) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    return r > 150 && g > 120 && b < 110 && (r - b) > 70 && (g - b) > 40;
  }
  // Green: blind (SB/BB) badge AND the depleting action-timer bar. Timer bar
  // meanRGB ≈ [89,188,93]. Same mask serves both — both are "green dominant".
  function isGreen(rgba, i) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    return g > 90 && (g - r) > 25 && (g - b) > 25;
  }
  // White text (§0.4: plate text is white-on-dark, NOT olive). Presence of
  // white ink is how we tell "legible number here" from "empty/covered plate".
  function isWhiteText(rgba, i) {
    return rgba[i] > 150 && rgba[i + 1] > 150 && rgba[i + 2] > 150;
  }

  function fracMatching(rgba, w, h, pred) {
    const n = w * h;
    if (n === 0) return 0;
    let c = 0;
    for (let p = 0; p < n; p++) if (pred(rgba, p * 4)) c++;
    return c / n;
  }

  // Measured calibration constants (see /tmp scan over 80 frames × 6 plates):
  //   clean stack plates: green_frac median 0.000, p90 ≤ 0.066, max 0.069;
  //   genuine badge intrusion: ≥ 0.10 (one TC case 0.252). 0.12 separates.
  //   white-text frac: clean median 0.04–0.07; empty/covered ≈ 0.000.
  const DEFAULTS = {
    occlusionGreenFrac: 0.12, // green ≥ this ⇒ overlay covers the plate ⇒ occluded
    noReadWhiteFrac: 0.01,    // white text < this ⇒ nothing legible ⇒ no-read
    buttonMinSize: 150,       // §0.8 disc blob size window (px)
    buttonMaxSize: 4000,
    buttonMinAspect: 0.6,     // §0.8 aspect window (w/h)
    buttonMaxAspect: 1.7,
    buttonMaxDist: 120,       // distance gate: slots are ~400px apart; puck landed 1px,
                              //   jackpot star 526px — 120 is a wide, safe cut.
    timerColGreenFrac: 0.3,   // a bar column counts as "filled" at ≥30% green px
  };

  // ─── occlusion gate: a COLOR test BEFORE any OCR (§2 Layer 1, HARD RULE) ────
  // Classify a plate crop's readability from pixels alone. This is what stops
  // the dangerous "read the posted-blind 0.50 chip as a stack" failure: a green
  // badge over the plate trips `occluded` and we never reach the digit reader.
  function classifyPlate(rgba, w, h, opts) {
    opts = opts || {};
    const greenT = opts.occlusionGreenFrac != null ? opts.occlusionGreenFrac : DEFAULTS.occlusionGreenFrac;
    const whiteT = opts.noReadWhiteFrac != null ? opts.noReadWhiteFrac : DEFAULTS.noReadWhiteFrac;
    const green = fracMatching(rgba, w, h, isGreen);
    if (green >= greenT) return { status: 'occluded', green, reason: 'green-overlay' };
    const white = fracMatching(rgba, w, h, isWhiteText);
    if (white < whiteT) return { status: 'no-read', white, reason: 'no-legible-text' };
    return { status: 'read', green, white };
  }

  // ─── numeric value parse: "N.NN BB" / "N BB" → Number(BB) ──────────────────
  // Tolerant of comma thousands separators and a trailing/embedded B/BB. Returns
  // null on anything it can't anchor to a number — null ⇒ no-read, never a guess.
  function parseBB(text) {
    if (text == null) return null;
    const cleaned = String(text).replace(/,/g, '').replace(/[Bb]{1,2}\s*$/,'').trim();
    const m = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
  }

  // ─── numeric badge reader (stacks §0.4, bets §0.5, pot §0.6) ───────────────
  // Gate on COLOR first (occlusion/no-read), then read the BINARIZED crop with
  // the template DigitMatcher. Returns { value:Number|null, raw, status }.
  //   colorPx    : {rgba,w,h} from the color SOURCE crop  → occlusion gate
  //   binarPx    : {rgba,w,h} from the BINARIZED crop      → DigitMatcher
  //   digitMatcher: engine DigitMatcher (or null → can't read → no-read)
  // A 'read' status with value===null means the gate passed but the matcher was
  // not confident — still withheld (the caller treats it as not-confirmed).
  function readNumericBadge(colorPx, binarPx, digitMatcher, opts) {
    const cls = classifyPlate(colorPx.rgba, colorPx.w, colorPx.h, opts);
    if (cls.status !== 'read') return { value: null, raw: null, status: cls.status, detail: cls };
    if (!digitMatcher || digitMatcher.size === 0) {
      return { value: null, raw: null, status: 'no-read', reason: 'no-templates' };
    }
    const res = digitMatcher.recognizeNumeric(binarPx.rgba, binarPx.w, binarPx.h, opts);
    if (res.text == null || res.unmatched !== 0) {
      return { value: null, raw: res.text, status: 'no-read', reason: 'low-confidence', confidence: res.confidence };
    }
    const value = parseBB(res.text);
    if (value == null) return { value: null, raw: res.text, status: 'no-read', reason: 'unparseable' };
    return { value, raw: res.text, status: 'read', confidence: res.confidence };
  }

  // ─── button puck: connected-component blob clustering (§0.8) ───────────────
  // Mask yellow → 4-connected label → keep disc-like blobs (size + aspect) →
  // largest such blob → centroid → nearest slot, REJECTED if past the distance
  // gate. `offset` maps crop-local centroids into frame coords for slot match.
  // Caller must only invoke this on SETTLED frames (§0.8 guard (a)); that is a
  // Layer-2 concern, not enforced here.
  function detectButton(rgba, w, h, slots, opts) {
    opts = opts || {};
    const minSize = opts.buttonMinSize != null ? opts.buttonMinSize : DEFAULTS.buttonMinSize;
    const maxSize = opts.buttonMaxSize != null ? opts.buttonMaxSize : DEFAULTS.buttonMaxSize;
    const minAsp = opts.buttonMinAspect != null ? opts.buttonMinAspect : DEFAULTS.buttonMinAspect;
    const maxAsp = opts.buttonMaxAspect != null ? opts.buttonMaxAspect : DEFAULTS.buttonMaxAspect;
    const maxDist = opts.buttonMaxDist != null ? opts.buttonMaxDist : DEFAULTS.buttonMaxDist;
    const ox = opts.offsetX || 0, oy = opts.offsetY || 0;

    // 4-connected flood-fill labeling over the yellow mask. We track only the
    // aggregate per blob (count, bbox, centroid sums) — no per-pixel storage.
    const seen = new Uint8Array(w * h);
    const stack = [];
    let best = null; // {size, cx, cy, aspect}
    for (let y0 = 0; y0 < h; y0++) {
      for (let x0 = 0; x0 < w; x0++) {
        const start = y0 * w + x0;
        if (seen[start] || !isYellow(rgba, start * 4)) continue;
        // flood
        seen[start] = 1; stack.length = 0; stack.push(start);
        let size = 0, sumX = 0, sumY = 0, minX = x0, maxX = x0, minY = y0, maxY = y0;
        while (stack.length) {
          const idx = stack.pop();
          const x = idx % w, y = (idx / w) | 0;
          size++; sumX += x; sumY += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x > 0)     { const n = idx - 1; if (!seen[n] && isYellow(rgba, n * 4)) { seen[n] = 1; stack.push(n); } }
          if (x < w - 1) { const n = idx + 1; if (!seen[n] && isYellow(rgba, n * 4)) { seen[n] = 1; stack.push(n); } }
          if (y > 0)     { const n = idx - w; if (!seen[n] && isYellow(rgba, n * 4)) { seen[n] = 1; stack.push(n); } }
          if (y < h - 1) { const n = idx + w; if (!seen[n] && isYellow(rgba, n * 4)) { seen[n] = 1; stack.push(n); } }
        }
        if (size < minSize || size > maxSize) continue;
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const aspect = bw / bh;
        if (aspect < minAsp || aspect > maxAsp) continue;
        if (!best || size > best.size) {
          best = { size, cx: sumX / size + ox, cy: sumY / size + oy, aspect };
        }
      }
    }
    if (!best) return { seat: null, status: 'no-read', reason: 'no-disc-blob' };

    // nearest slot + distance gate
    let nearest = null, nd = Infinity;
    for (const s of Object.keys(slots)) {
      const dx = slots[s].x - best.cx, dy = slots[s].y - best.cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nd) { nd = d; nearest = s; }
    }
    if (nd > maxDist) {
      return { seat: null, status: 'no-read', reason: 'distance-gate', distance: nd, centroid: { x: best.cx, y: best.cy } };
    }
    return { seat: nearest, status: 'read', distance: nd, centroid: { x: best.cx, y: best.cy }, size: best.size };
  }

  // ─── timer-bar fill fraction (§0.9) ────────────────────────────────────────
  // Fraction of bar columns that are "filled" (≥ timerColGreenFrac green px).
  // There is NO numeric clock; this is the only "time left" signal, and it is
  // LIVE-UNVALIDATED across the full drain (§0.9/§6) — ship it, don't trust it
  // alone; Layer-2/escalation pairs it with a poll-counter floor.
  function timerFraction(rgba, w, h, opts) {
    opts = opts || {};
    const colT = opts.timerColGreenFrac != null ? opts.timerColGreenFrac : DEFAULTS.timerColGreenFrac;
    if (w === 0 || h === 0) return { fraction: 0, status: 'no-read' };
    let filled = 0;
    for (let x = 0; x < w; x++) {
      let g = 0;
      for (let y = 0; y < h; y++) if (isGreen(rgba, (y * w + x) * 4)) g++;
      if (g / h >= colT) filled++;
    }
    return { fraction: filled / w, status: 'read', filledCols: filled, totalCols: w };
  }

  // ─── turn indicator (§0.7 / §2 / §3a) ──────────────────────────────────────
  // The panel's red buttons are a CHEAP PRECONDITION ("something actionable is up")
  // — NOT the authority. P4 proved "any red" over-counts hero-turn by ~40%: the
  // Boost Fast-Fold pre-button is a lone red FOLD shown while waiting. Hero's turn
  // is decided by the FULL action set parsed from the panel text — see
  // classifyActionSet below; the converter ANDs that with this red signal.
  function isRedButton(rgba, i) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    return r > 150 && (r - g) > 60 && (r - b) > 60;
  }
  function turnIndicator(rgba, w, h, opts) {
    opts = opts || {};
    const redT = opts.turnRedFrac != null ? opts.turnRedFrac : 0.04;
    const red = fracMatching(rgba, w, h, isRedButton);
    return { heroToAct: red >= redT, redFrac: red, status: 'read' };
  }

  // Authoritative hero-turn classifier from the OCR'd action-panel text (§3a:
  // the rendered button panel is authoritative for legal actions). P4: hero's
  // turn requires the FULL action set (Fold + Check|Call + Bet|Raise). The
  // Fast-Fold pre-button shows a lone red FOLD with gray "Call Any"/"Raise Any"
  // auto-action selectors; the real panel shows enabled Check/Call + Bet/Raise
  // with printed amounts. Returns one of:
  //   'absent'      — no panel text → cannot confirm a turn (benign)
  //   'fastfold'    — Fast-Fold pre-button ("...Any" selectors, or a lone Fold) →
  //                   NOT hero's turn (this is the ~40% the red signal over-counts)
  //   'full'        — Fold + (Check|Call) + (Bet|Raise) → hero's turn to act
  //   'unparseable' — text present but a partial/garbled action panel → WITHHOLD
  //                   (do not fire advice on an unreadable panel; let §5 escalate)
  // LIVE-VALIDATION: exact button strings/order confirm at bring-up; the token
  // matchers are deliberately OCR-noise tolerant and tunable here.
  function classifyActionSet(panelText) {
    const t = String(panelText == null ? '' : panelText).toLowerCase();
    if (!t.replace(/[^a-z0-9]/g, '')) return 'absent';
    const has = (re) => re.test(t);
    const fastMarker = has(/fast/) || has(/\bany\b/);          // Fast-Fold auto-selectors
    const hasFold = has(/fold/) || has(/fo[l1i]d/);
    const hasCheck = has(/check/) || has(/cheek/) || has(/ch[e3]ck/);
    const hasCall = has(/call/) || has(/cail/) || has(/ca[l1]{2}/);
    const hasBet = has(/\bbet\b/) || has(/\bbe[t7]\b/);
    const hasRaise = has(/raise/) || has(/ra[i1l]se/);
    const hasMiddle = hasCheck || hasCall;                     // Check OR Call
    const hasAggro = hasBet || hasRaise;                       // Bet OR Raise
    if (fastMarker) return 'fastfold';
    if (hasFold && hasMiddle && hasAggro) return 'full';
    if (hasFold && !hasMiddle && !hasAggro) return 'fastfold'; // lone-Fold pre-button
    return 'unparseable';                                      // partial/garbled → withhold
  }

  // ─── card cells → codes (§0.6, via engine MultiSignatureMatcher) ───────────
  // `cells` = [{rgba,w,h}] sliced from a card region (board or hero hole), one
  // per card position. Returns [{ code|null, status }]. A cell that the matcher
  // can't confidently resolve is 'no-read' — the assembler withholds rather than
  // inventing a card. Board card COUNT (non-null reads) drives street.
  function readCardCells(cells, cardMatcher, opts) {
    opts = opts || {};
    const minConf = opts.cardMinConfidence != null ? opts.cardMinConfidence : 0.85; // MATCHER_SPEC threshold
    if (!cells || !cardMatcher) return [];
    return cells.map((c) => {
      // is_present gate: the detector flagged this slot empty (no card signature) —
      // do NOT feed the crop to the classifier; report absent.
      if (c && c.present === false) return { code: null, status: 'absent', confidence: 0 };
      const m = cardMatcher.match(c.rgba, c.w, c.h);
      if (!m || m.confidence == null || m.confidence < minConf) {
        return { code: null, status: 'no-read', confidence: m ? m.confidence : 0 };
      }
      return { code: m.card != null ? m.card : m.code, status: 'read', confidence: m.confidence };
    });
  }

  // ─── per-frame assembler → TableObservation ────────────────────────────────
  // Composes the readers over one frame's crops into a single confidence-tagged
  // observation. PURE: `frame` supplies crops; no canvas here.
  //   frame.getColor(regionId)     -> {rgba,w,h} | null   (color source crop)
  //   frame.getBinarized(regionId) -> {rgba,w,h} | null   (binarized crop)
  //   frame.getCardCells(regionId,n)-> [{rgba,w,h}] | null (optional, cards)
  //   frame.digitMatcher, frame.cardMatcher                (engine instances)
  //   frame.heroBet  : hero's KNOWN committed bet this street (BB) — §0.10,
  //                    NEVER OCR'd from the BC bet badge.
  // Returns { stacks, bets, pot, button, timer, turn, board, heroHole } where
  // each leaf carries {value|code|..., status}. The assembler does NOT decide
  // completeness — Layer 3 does. It only reports what each plate yielded.
  function observeFrame(frame, opts) {
    opts = opts || {};
    const R = Regions;
    const obs = { stacks: {}, bets: {}, board: null, heroHole: null };

    for (const seat of R.SEATS) {
      // stacks
      const sc = frame.getColor(`stack_${seat}`), sb = frame.getBinarized(`stack_${seat}`);
      obs.stacks[seat] = (sc && sb)
        ? readNumericBadge(sc, sb, frame.digitMatcher, opts)
        : { value: null, status: 'no-read', reason: 'no-crop' };

      // bets — hero (BC) NEVER from OCR (§0.10); sourced from known action.
      if (seat === R.HERO_SEAT) {
        obs.bets[seat] = (frame.heroBet != null)
          ? { value: frame.heroBet, status: 'read', source: 'hero-action' }
          : { value: null, status: 'no-read', reason: 'hero-action-unknown', source: 'hero-action' };
      } else {
        const bc = frame.getColor(`bet_${seat}`), bb = frame.getBinarized(`bet_${seat}`);
        obs.bets[seat] = (bc && bb)
          ? readNumericBadge(bc, bb, frame.digitMatcher, opts)
          : { value: null, status: 'no-read', reason: 'no-crop' };
      }
    }

    // pot
    const pc = frame.getColor('pot'), pb = frame.getBinarized('pot');
    obs.pot = (pc && pb)
      ? readNumericBadge(pc, pb, frame.digitMatcher, opts)
      : { value: null, status: 'no-read', reason: 'no-crop' };

    // button
    const btn = frame.getColor('button_scan');
    // opts.buttonSlots / offset / size let the frame adapter pass live-resolution
    // -scaled values (§0.8 slots are native 2940×1846); default to native.
    obs.button = btn
      ? detectButton(btn.rgba, btn.w, btn.h, opts.buttonSlots || R.BUTTON_SLOTS,
          Object.assign({ offsetX: R.BUTTON_SCAN_RECT.x, offsetY: R.BUTTON_SCAN_RECT.y }, opts))
      : { seat: null, status: 'no-read', reason: 'no-crop' };

    // hero-bet VALIDATION read (§0.10 cross-check, NOT the source). We OCR hero's
    // own bet badge purely so the orchestrator can compare it against the
    // stack-delta heroBet and warn on drift. A misread here cannot corrupt the
    // snapshot — current_bets[hero] still comes from frame.heroBet — it only
    // raises a flag. This is the visible ground truth for the costliest field.
    const hbc = frame.getColor(`bet_${R.HERO_SEAT}`), hbb = frame.getBinarized(`bet_${R.HERO_SEAT}`);
    obs.heroBetObserved = (hbc && hbb)
      ? readNumericBadge(hbc, hbb, frame.digitMatcher, opts)
      : { value: null, status: 'no-read', reason: 'no-crop' };

    // timer
    const tm = frame.getColor('timer');
    obs.timer = tm ? timerFraction(tm.rgba, tm.w, tm.h, opts) : { fraction: 0, status: 'no-read', reason: 'no-crop' };

    // turn
    const tp = frame.getColor('action_panel');
    obs.turn = tp ? turnIndicator(tp.rgba, tp.w, tp.h, opts) : { heroToAct: false, status: 'no-read', reason: 'no-crop' };

    // cards (optional — geometry not in §0; wired in a later phase)
    if (frame.getCardCells && frame.cardMatcher) {
      const boardCells = frame.getCardCells('board', 5);
      const holeCells = frame.getCardCells('hero_hole', 2);
      obs.board = boardCells ? readCardCells(boardCells, frame.cardMatcher, opts) : null;
      obs.heroHole = holeCells ? readCardCells(holeCells, frame.cardMatcher, opts) : null;
    }

    return obs;
  }

  return {
    DEFAULTS,
    isYellow, isGreen, isWhiteText, isRedButton, fracMatching,
    classifyPlate, parseBB, readNumericBadge,
    detectButton, timerFraction, turnIndicator, classifyActionSet, readCardCells,
    observeFrame,
    _engineLoaded: !!Engine, _regionsLoaded: !!Regions,
  };
});
