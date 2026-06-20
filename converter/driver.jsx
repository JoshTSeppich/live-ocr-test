// converter/driver.jsx — the browser wiring + display (CONVERTER_BUILD_SPEC §4,
// §5). Thin React glue: it owns no logic — it builds the converter pipeline,
// feeds useLiveOCR's onFrame into it, and renders the converter's view.
//
// NOT node-tested (DOM/React/getDisplayMedia). The logic it drives is covered by
// converter/*.test.cjs; this file is verified live at bring-up (Phase 5), where
// the seat-order self-check + the §6 items get confirmed before advice is
// trusted. It reads the UMD globals the bundle exposes (window.Poker*).
//
// Matchers come from window.PokerEngine and load their taught templates from
// localStorage (the existing teach UI populates them). With no templates the
// numeric/card reads return no-read and the converter simply withholds — safe.
/* global React, PokerEngine, PokerRegions, PokerSettle, PokerHandBoundary,
          PokerHistory, PokerEscalate, PokerBotLink, PokerConverter, useLiveOCR,
          AdvisorEvent, AdvisorPanel */

// Convert an {rgba,w,h} crop into an OffscreenCanvas a Tesseract worker can
// recognize. Used to hand the hero-nameplate band crop to the dedicated
// hero-anchor worker (which needs word bboxes, not the main loop's text path).
function rgbaToCanvas(rgba, w, h) {
  const data = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}
// Binarize + invert in place (bright→black, dark→white) — same transform the main
// OCR loop uses, so white-on-dark plate text becomes dark-on-light for Tesseract.
function binarizeInvertCanvas(canvas, threshold) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i], d[i + 1], d[i + 2]) > threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}
// Tesseract.js v5 returns no top-level data.words — words are nested in the block
// tree (blocks→paragraphs→lines→words). Flatten them (falling back to data.words
// for older builds) so detectHero gets the {text,bbox} list it expects.
function flattenWords(data) {
  if (data && Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  if (data && Array.isArray(data.blocks)) {
    for (const b of data.blocks) for (const p of (b.paragraphs || [])) for (const l of (p.lines || [])) for (const w of (l.words || [])) out.push(w);
  }
  return out;
}

// ── Live card-readout (read-only debug panel) ───────────────────────────────
// Classifies one card-strip cell exactly as the pipeline does: same strip crop
// (PokerFrame.sliceCells), same matcher, same 0.85 confidence gate as
// observation.readCardCells. Returns a small display record per card.
const CARD_MIN_CONF = 0.85; // == observation.readCardCells default
const DIM_MIN_CONF = 0.95; // dim (showdown) cards: a white-calibrated match is untrustworthy, so demand
                           // a strict bar — a dim-vs-white mismatch stays moderate → no-read; a dim card
                           // matched to a future DIM template clears it. Never emits a confident read on dim.
const SUIT_GLYPH = { h: '♥', d: '♦', s: '♠', c: '♣' };
function fmtCardCode(code) {
  if (!code || code.length < 2) return { text: code || '?', red: false };
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  return { text: rank + (SUIT_GLYPH[suit] || suit), red: suit === 'h' || suit === 'd' };
}
function readCardCell(matcher, cell) {
  if (!cell) return { state: 'none' };
  if (cell.present === false) return { state: 'none' }; // is_present gate: empty slot, don't classify
  const m = matcher.match(cell.rgba, cell.w, cell.h);
  if (cell.dim) {
    // DIM (showdown) card: never trust a white-calibrated match → never confident.
    // suit ALWAYS abstains; rank only as a TENTATIVE abstain above a strict bar.
    if (!m || m.confidence == null || m.confidence < DIM_MIN_CONF) return { state: 'no-read', conf: m ? m.confidence : 0, guess: m ? m.card : null, dim: true };
    return { state: 'abstain', conf: m.confidence, code: m.card, dim: true };
  }
  if (!m || m.confidence == null || m.confidence < CARD_MIN_CONF) {
    return { state: 'no-read', conf: m ? m.confidence : 0, guess: m ? m.card : null };
  }
  // confident rank+colour; suit may still abstain (never a confident wrong suit)
  return { state: m.suitConfident ? 'read' : 'abstain', conf: m.confidence, code: m.card, alts: m.suitAlternatives };
}
// change-detect key (ignores confidence jitter) + compact record for the log
const cellRecKey = (r) => (r ? r.state + (r.code || '') : 'none');
const cellRec = (r) => (r ? { state: r.state, code: r.code || null, guess: r.guess || null, conf: r.conf != null ? +r.conf.toFixed(3) : null } : { state: 'none' });
// PNG data-URL of a strip cell, so each record entry keeps the actual picture
// the code was matched from (checkable later). Strips are small (≈55×130).
function stripToDataURL(cell) {
  if (!cell || !cell.rgba || !cell.w || !cell.h) return null;
  try {
    const data = cell.rgba instanceof Uint8ClampedArray ? cell.rgba : new Uint8ClampedArray(cell.rgba);
    const c = document.createElement('canvas'); c.width = cell.w; c.height = cell.h;
    c.getContext('2d').putImageData(new ImageData(data, cell.w, cell.h), 0, 0);
    return c.toDataURL('image/png');
  } catch (_) { return null; }
}
// one card record = code/conf/state + the crop image
const cellRecImg = (r, cell) => Object.assign(cellRec(r), { img: stripToDataURL(cell) });

// DIAGNOSTIC: crop a MARGIN-EXPANDED window around each anchored numeric region
// (stack/bet/pot) from a full-res frame snapshot, so the live number geometry can
// be re-measured + gold-filtered OFFLINE. The plates render WHITE name on top /
// GOLD number below, and the current boxes sit on the name — so we expand
// generously DOWNWARD to capture the gold number even when the box clips it. Each
// entry records `box` (the anchored region rect WITHIN the crop) so the box-vs-
// number offset is measurable. JPEG to keep the diagnostic log small.
function captureNumericCrops(getSnap, regions, fullW) {
  if (!getSnap || !regions) return null;
  const snap = getSnap(fullW || 2940); // full-res frame
  if (!snap || !snap.imageData) return null;
  const src = snap.imageData instanceof Uint8ClampedArray ? snap.imageData : new Uint8ClampedArray(snap.imageData);
  const out = {};
  for (const r of regions) {
    if (!(r.kind === 'stack' || r.kind === 'bet' || r.kind === 'pot')) continue;
    const bx = r.x * snap.w, by = r.y * snap.h, bw = r.w * snap.w, bh = r.h * snap.h;
    const mx = bw * 0.30, mTop = bh * 0.40, mBot = bh * 1.30; // gold number sits below the box
    const x0 = Math.max(0, Math.floor(bx - mx)), y0 = Math.max(0, Math.floor(by - mTop));
    const x1 = Math.min(snap.w, Math.ceil(bx + bw + mx)), y1 = Math.min(snap.h, Math.ceil(by + bh + mBot));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
    try {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const si = ((y0 + yy) * snap.w + (x0 + xx)) * 4, di = (yy * w + xx) * 4;
          img.data[di] = src[si]; img.data[di + 1] = src[si + 1]; img.data[di + 2] = src[si + 2]; img.data[di + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      out[r.id] = { url: cv.toDataURL('image/jpeg', 0.85), box: { x: Math.round(bx - x0), y: Math.round(by - y0), w: Math.round(bw), h: Math.round(bh) }, w, h };
    } catch (_) { /* skip this region */ }
  }
  return Object.keys(out).length ? out : null;
}
// Persist a capped tail to localStorage; crop images are heavy, so shrink the
// stored window on a quota error rather than failing.
const READS_KEY = 'card-reads-log';
function persistReads(log) {
  for (let n = Math.min(log.length, 120); ; n = Math.floor(n / 2)) {
    try { localStorage.setItem(READS_KEY, JSON.stringify(log.slice(-n))); return; }
    catch (_) { if (n <= 0) { try { localStorage.removeItem(READS_KEY); } catch (__) {} return; } }
  }
}
// THIN full-state snapshot log — small (no base64 crops), so the cap is generous.
const THIN_KEY = 'thin-snapshot-log';
function persistThin(log) {
  for (let n = Math.min(log.length, 3000); ; n = Math.floor(n / 2)) {
    try { localStorage.setItem(THIN_KEY, JSON.stringify(log.slice(-n))); return; }
    catch (_) { if (n <= 0) { try { localStorage.removeItem(THIN_KEY); } catch (__) {} return; } }
  }
}
// BADGE-CROP diagnostic log — margin-expanded numeric-region crops (heavy JPEGs),
// for offline geometry re-measure + gold-filter + digit teach. Small reload tail.
const BADGE_KEY = 'badge-crops-log';
function persistBadges(log) {
  for (let n = Math.min(log.length, 12); ; n = Math.floor(n / 2)) {
    try { localStorage.setItem(BADGE_KEY, JSON.stringify(log.slice(-n))); return; }
    catch (_) { if (n <= 0) { try { localStorage.removeItem(BADGE_KEY); } catch (__) {} return; } }
  }
}
// One card chip element for the live readout (read-only).
function cardChip(r, key) {
  r = r || { state: 'none' };
  const pct = r.conf != null ? Math.round(r.conf * 100) + '%' : '';
  const base = { width: 64, padding: '4px 2px', borderRadius: 5, textAlign: 'center',
    border: '1px solid #2a2a2a', background: '#161616', font: '13px ui-monospace, monospace' };
  let title, titleColor, sub;
  if (r.state === 'read') { const f = fmtCardCode(r.code); title = f.text; titleColor = f.red ? '#ff6b6b' : '#e8e8e8'; sub = pct; }
  else if (r.state === 'abstain') { const f = fmtCardCode(r.code); title = f.text + '?'; titleColor = '#e8c000'; sub = 'abstain ' + pct; }
  else if (r.state === 'no-read') {
    // show the below-gate TOP GUESS (dim) so a near-miss reads vs true garbage
    if (r.guess) { const f = fmtCardCode(r.guess); title = f.text + '?'; titleColor = f.red ? '#a55' : '#888'; sub = 'low ' + pct; }
    else { title = '—'; titleColor = '#666'; sub = 'no-read' + (pct ? ' ' + pct : ''); }
  }
  else { title = '·'; titleColor = '#444'; sub = ''; }
  return React.createElement('div', { key, style: base },
    React.createElement('div', { style: { fontSize: 16, fontWeight: 700, color: titleColor, lineHeight: '18px' } }, title),
    React.createElement('div', { style: { fontSize: 10, color: '#888' } }, sub));
}
// LOW-FID live table viewer (Josh's College Bot). Renders converter view.table —
// the held display over the settled observation; '?' for unread, never withheld.
function TableViewPanel(props) {
  const t = props.table;
  if (!t) return null;
  const h = React.createElement;
  const slot = (code, key) => {
    const q = !code || code === '?';
    const f = q ? null : fmtCardCode(code);
    return h('div', { key, style: { minWidth: 24, padding: '3px 5px', textAlign: 'center', border: '1px solid #2a2a2a', borderRadius: 4, background: '#161616', color: q ? '#555' : (f.red ? '#ff6b6b' : '#e8e8e8'), font: '700 14px ui-monospace,monospace' } }, q ? '?' : f.text);
  };
  const seat = (sid) => {
    const s = t.seats[sid] || {};
    const hero = sid === 'BC', btn = t.button === sid;
    const occl = s.stackStatus === 'occluded';
    const stackTxt = s.stack != null ? (+s.stack).toFixed(1) + 'bb' : (occl ? 'occl' : '?');
    const betTxt = (s.bet != null && s.bet > 0) ? (+s.bet).toFixed(1) + 'bb' : '';
    return h('div', { key: sid, style: { width: 96, padding: 4, border: '1px solid ' + (hero ? '#3a5' : '#2a2a2a'), borderRadius: 5, background: (hero && t.heroToAct) ? '#16301a' : '#141414', textAlign: 'center' } },
      h('div', { style: { fontSize: 10, color: hero ? '#6c9' : '#888' } }, sid + (btn ? ' Ⓓ' : '') + (hero ? ' (you)' : '')),
      h('div', { style: { fontSize: 13, color: occl ? '#c90' : '#ddd' } }, stackTxt),
      betTxt ? h('div', { style: { fontSize: 11, color: '#e8c000' } }, 'bet ' + betTxt) : null);
  };
  const row = (ids) => h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center' } }, ids.map(seat));
  return h('div', { style: { marginTop: 8, padding: 10, border: '1px solid #243524', borderRadius: 6, background: '#0c0f0c' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#8a8', fontSize: 12, marginBottom: 8 } },
      h('span', null, "Josh's College Bot — live table"),
      h('span', null, 'hand #' + t.hand + ' · ' + (t.street || '?') + (t.heroToAct ? ' · YOUR TURN' : ''))),
    row(['TL', 'TC', 'TR']),
    h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', margin: '10px 0' } },
      h('span', { style: { color: '#888', fontSize: 11, marginRight: 4 } }, 'board'),
      t.board.map((c, i) => slot(c, 'bd' + i)),
      h('span', { style: { color: '#8c8', fontSize: 12, marginLeft: 12 } }, 'pot ' + (t.pot != null ? (+t.pot).toFixed(1) + 'bb' : '?'))),
    row(['BL', 'BC', 'BR']),
    h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', marginTop: 8 } },
      h('span', { style: { color: '#888', fontSize: 11, marginRight: 4 } }, 'your hand'),
      t.hero.map((c, i) => slot(c, 'hh' + i))));
}
// Draw a {rgba,w,h} crop into a visible <canvas>, scaled to maxW. This shows the
// EXACT pixels the card matcher is fed — so you can see whether the region box is
// on the cards (anchored correctly) or sitting in the felt (misplaced).
function drawCrop(canvasEl, crop, maxW) {
  if (!canvasEl) return;
  const ctx = canvasEl.getContext('2d');
  if (!crop || !crop.rgba || !crop.w || !crop.h) { if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height); return; }
  const data = crop.rgba instanceof Uint8ClampedArray ? crop.rgba : new Uint8ClampedArray(crop.rgba);
  const off = new OffscreenCanvas(crop.w, crop.h);
  off.getContext('2d').putImageData(new ImageData(data, crop.w, crop.h), 0, 0);
  const scale = Math.min(1, maxW / crop.w);
  canvasEl.width = Math.max(1, Math.round(crop.w * scale));
  canvasEl.height = Math.max(1, Math.round(crop.h * scale));
  ctx.drawImage(off, 0, 0, canvasEl.width, canvasEl.height);
}

function ConverterPanel({ url = 'ws://127.0.0.1:8766' }) {
  const [view, setView] = React.useState({ state: 'idle', advisorEvent: null, seatWarning: null, betWarning: null, callWarning: null });
  const [linkStatus, setLinkStatus] = React.useState('idle');
  const convRef = React.useRef(null);
  const regionTextRef = React.useRef({}); // latest per-region OCR text (for check-vs-call)
  const pollRef = React.useRef(0);        // urgency proxy: frames since hero's turn began

  // ── Hero-anchored, resolution-independent regions (ADR_hero_anchor_regions) ─
  // Capture resolution varies between/within sessions, so fraction-of-frame
  // placement drifts. A dedicated 2nd Tesseract worker reads the hero nameplate
  // band each frame; detectHero + computeAnchoredRegions re-place EVERY region
  // from the live hero plate, with a last-good fallback for the ~30% of frames
  // the plate is occluded. The useLiveOCR loop is UNTOUCHED — it just consumes
  // whatever `regions` we hand it (which we update per frame from onFrame).
  const heroBandRegion = React.useMemo(() => ({
    id: 'hero_band', name: 'hero_band', kind: 'anchor', ...PokerRegions.HERO_SEARCH_BAND,
  }), []);
  const [regions, setRegions] = React.useState(
    () => PokerRegions.captureRegions().concat(heroBandRegion));
  const [anchorStatus, setAnchorStatus] = React.useState('anchor-cold');
  const anchorStatusRef = React.useRef('anchor-cold');
  const heroWorkerRef = React.useRef(null); // dedicated band OCR worker (word bboxes)
  const heroWorkerInitRef = React.useRef(false); // worker creation kicked off?
  const heroBusyRef = React.useRef(false);  // at most one band OCR in flight
  const heroDetRef = React.useRef(null);    // { det, fresh } — latest hero detection

  // Live card-readout: what the card pipeline matches each frame (read-only).
  const [cardReads, setCardReads] = React.useState({
    board: [null, null, null, null, null], hero: [null, null],
  });
  // Hero-anchor diagnostics: did the band worker start, what did it OCR, did it match?
  const [heroDbg, setHeroDbg] = React.useState({ ready: false, ocr: '', matched: null });
  const heroDbgRef = React.useRef({ ready: false, ocr: '', matched: null });
  // Calibration overlay: the whole frame with the region boxes drawn on it, so a
  // box that's off the cards is visible at a glance (and measurable).
  const frameSnapRef = React.useRef(null);   // getFrameSnapshot, set after useLiveOCR
  const overlayCanvasRef = React.useRef(null);
  // Live calibration NUDGE (REF px) for the board / hero card boxes — adjust until
  // the boxes sit on the cards and they read; persisted so it survives reloads.
  const NUDGE_KEY = 'card-box-nudge';
  const [nudge, setNudge] = React.useState(() => {
    try { return Object.assign({ bdx: 0, bdy: 0, hdx: 0, hdy: 0 }, JSON.parse(localStorage.getItem(NUDGE_KEY) || '{}')); }
    catch (_) { return { bdx: 0, bdy: 0, hdx: 0, hdy: 0 }; }
  });
  const nudgeRef = React.useRef(nudge);
  nudgeRef.current = nudge;
  const bumpNudge = React.useCallback((k, d) => setNudge((n) => {
    const next = { ...n, [k]: (n[k] || 0) + d };
    try { localStorage.setItem(NUDGE_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }), []);
  // Visible previews of the actual board/hero crops fed to the matcher (so a
  // misplaced region box is obvious — felt instead of cards).
  const boardCanvasRef = React.useRef(null);
  const heroCanvasRef = React.useRef(null);
  // Rolling record of card reads (appended only when the read CHANGES, not every
  // frame), downloadable as JSON for inspection.
  const cardLogRef = React.useRef([]);
  const lastLogKeyRef = React.useRef('');
  const [recordCount, setRecordCount] = React.useState(0);
  // thin full-state snapshot ring (one block per frame; codes-or-'?', no crops)
  const thinLogRef = React.useRef([]);
  const [thinCount, setThinCount] = React.useState(0);
  // badge-crop diagnostic ring (margin-expanded numeric crops for digit-teach prep)
  const placedRef = React.useRef(null);            // this frame's anchored regions
  const badgeLogRef = React.useRef([]);
  const [badgeCount, setBadgeCount] = React.useState(0);

  // Build the pipeline once.
  if (!convRef.current) {
    const debouncer = new PokerSettle.SettleDebouncer({ n: 2, settleN: 2 });
    const history = new PokerHistory.ActionHistory();
    const lifecycle = new PokerHandBoundary.HandLifecycle({ debouncer, history });
    const escalator = new PokerEscalate.Escalator();
    const botLink = new PokerBotLink.BotLink({
      url,
      onStatus: (s) => setLinkStatus(s),
      onError: (e) => { /* brain-side rejection — log, keep running */ console.warn('[brain error]', e); },
    });
    const digitMatcher = new PokerEngine.DigitMatcher();         // loads localStorage templates
    const cardMatcher = new PokerEngine.MultiSignatureMatcher(); // loads localStorage templates
    const conv = new PokerConverter.Converter({
      debouncer, lifecycle, history, botLink, escalator, digitMatcher, cardMatcher,
    });
    botLink.connect();
    convRef.current = { conv, botLink, cardMatcher };
  }

  // Feed every captured frame into the converter, then publish its view.
  const onFrame = React.useCallback((getCrops, dims) => {
    const { conv } = convRef.current;
    const vw = dims && dims.videoW, vh = dims && dims.videoH;

    // ── Lazily create the dedicated hero-band OCR worker ONCE, here in the loop
    // (NOT in a useEffect — an effect's cleanup could fire before createWorker
    // resolves and discard the worker, which left the anchor permanently cold).
    // By the time onFrame runs, useLiveOCR's main worker is already up.
    if (!heroWorkerRef.current && !heroWorkerInitRef.current && typeof window !== 'undefined' && window.Tesseract) {
      heroWorkerInitRef.current = true;
      (async () => {
        try {
          const w = await window.Tesseract.createWorker('eng', 1, { langPath: 'https://tessdata.projectnaptha.com/4.0.0_best' });
          await w.setParameters({ tessedit_pageseg_mode: '6' });
          heroWorkerRef.current = w;
          const dbg = { ...heroDbgRef.current, ready: true };
          heroDbgRef.current = dbg; setHeroDbg(dbg);
        } catch (e) {
          console.warn('[hero-anchor] worker init failed:', e);
          heroWorkerInitRef.current = false; // allow a retry on a later frame
          const dbg = { ready: false, ocr: 'INIT FAILED: ' + (e && e.message || e), matched: null };
          heroDbgRef.current = dbg; setHeroDbg(dbg);
        }
      })();
    }

    // ── Hero-anchor: kick an async band OCR when the dedicated worker is free.
    // The band crop is full-resolution (useLiveOCR's source crop is NOT
    // downsampled), so band-local px map to frame px at scale 1, offset by the
    // band's frame-px origin. The OCR is async + throttled (one in flight), so
    // it never blocks the capture loop; its result updates the anchor.
    const hw = heroWorkerRef.current;
    if (hw && !heroBusyRef.current && vw && vh) {
      const band = getCrops('hero_band');
      if (band && band.color) {
        heroBusyRef.current = true;
        const bandOriginX = Math.floor(vw * heroBandRegion.x);
        const bandOriginY = Math.floor(vh * heroBandRegion.y);
        let canvas = null;
        try { canvas = rgbaToCanvas(band.color.rgba, band.color.w, band.color.h); binarizeInvertCanvas(canvas, 128); }
        catch (_) { heroBusyRef.current = false; }
        if (canvas) {
          hw.recognize(canvas, {}, { blocks: true, text: true })
            .then(({ data }) => {
              const det = PokerRegions.detectHero(flattenWords(data),
                { bandOriginX, bandOriginY, bandScale: 1 });
              if (det) heroDetRef.current = { det, fresh: true };
              // diagnostics: raw band OCR text, the match, and the DETECTED plate
              // position (full-frame px) so a card-box offset error is measurable.
              const dbg = { ready: true, ocr: ((data && data.text) || '').replace(/\s+/g, ' ').trim().slice(0, 60), matched: det ? det.text : null,
                plate: det ? { cx: Math.round(det.cx), cy: Math.round(det.cy), textH: Math.round(det.textH) } : null };
              heroDbgRef.current = dbg; setHeroDbg(dbg);
            })
            .catch(() => { /* OCR hiccup — keep the last-good anchor */ })
            .finally(() => { heroBusyRef.current = false; });
        }
      }
    }

    // ── Re-place every region from the latest detection. A FRESH detection this
    // frame → 'anchor-live'; otherwise pass null so computeAnchoredRegions
    // reuses its last-good transform ('anchor-cached'), or the static REF
    // placement before any detection lands ('anchor-cold'). hero_band is
    // re-appended so we keep getting its crop next frame.
    if (vw && vh) {
      const pending = heroDetRef.current;
      const det = pending && pending.fresh ? pending.det : null;
      if (pending) pending.fresh = false;
      const placed = PokerRegions.computeAnchoredRegions(det, vw, vh);
      // anchor scale (REF px → live px): from the detected plate text height
      const k = (heroDbgRef.current.plate && heroDbgRef.current.plate.textH)
        ? (heroDbgRef.current.plate.textH / PokerRegions.REF_HERO.textH)
        : (vh / PokerRegions.REF_FRAME.h);
      // apply the live calibration nudge (REF px) to the board / hero card boxes
      const nf = nudgeRef.current;
      const shift = (r, dx, dy) => ({ ...r, x: r.x + (dx * k) / vw, y: r.y + (dy * k) / vh });
      const adj = placed.regions.map((r) =>
        r.id === 'board' ? shift(r, nf.bdx, nf.bdy)
        : r.id === 'hero_hole' ? shift(r, nf.hdx, nf.hdy) : r);
      setRegions(adj.concat(heroBandRegion));
      placedRef.current = adj; // anchored regions this frame → badge-crop diagnostic
      if (placed.status !== anchorStatusRef.current) {
        anchorStatusRef.current = placed.status;
        setAnchorStatus(placed.status);
      }

      // ── Calibration overlay: draw the whole frame + the (nudged) region boxes,
      // so a box sitting off the cards is obvious (and the offset is measurable).
      try {
        const snap = frameSnapRef.current && frameSnapRef.current(480);
        const cv = overlayCanvasRef.current;
        if (snap && cv) {
          if (cv.width !== snap.w || cv.height !== snap.h) { cv.width = snap.w; cv.height = snap.h; }
          const ctx = cv.getContext('2d');
          const data = snap.imageData instanceof Uint8ClampedArray ? snap.imageData : new Uint8ClampedArray(snap.imageData);
          ctx.putImageData(new ImageData(data, snap.w, snap.h), 0, 0);
          const colors = { board: '#3df0a0', hero_hole: '#ff6b6b', hero_band: '#55aaff' };
          ctx.lineWidth = 1.5; ctx.font = '9px monospace';
          for (const r of adj.concat(heroBandRegion)) {
            const c = colors[r.id]; if (!c) continue;
            const x = r.x * snap.w, y = r.y * snap.h, w = r.w * snap.w, h = r.h * snap.h;
            ctx.strokeStyle = c; ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = c; ctx.fillText(r.id, x + 1, Math.max(8, y - 1));
          }
        }
      } catch (_) { /* overlay must never break capture */ }
    }

    // feed the latest action-panel OCR text (from Tesseract path) for check-vs-call
    conv.setPanelText(regionTextRef.current && regionTextRef.current.action_panel || null);
    const res = conv.onFrame(getCrops, dims); // res.request = the assembled snapshot

    // ── THIN full-state snapshot log: append one block per frame (codes-or-'?',
    // seat/stack/bet/pot/turn/button-or-null) for the board / state-machine /
    // narration. Additive tap on the converter's view.block — NOT the brain request.
    try {
      if (conv.view.block) {
        const tlog = thinLogRef.current;
        tlog.push(Object.assign({ t: Date.now() }, conv.view.block));
        if (tlog.length > 5000) tlog.shift();
        persistThin(tlog);
        setThinCount(tlog.length);
      }
    } catch (e) { /* a log tap must never break capture */ }

    // ── Live card-readout (read-only): classify each board/hero strip exactly as
    // the pipeline does — same cropper, same matcher, same 0.85 gate — so the
    // panel shows what the card pipeline matches this frame.
    try {
      const PF = typeof window !== 'undefined' && window.PokerFrame;
      const cm = convRef.current.cardMatcher;
      if (PF && PF.sliceCells && cm) {
        const bc = getCrops('board'), hc = getCrops('hero_hole');
        const bCells = bc && bc.color ? PF.sliceCells(bc.color, 5, { layout: 'board' }) : null;
        const hCells = hc && hc.color ? PF.sliceCells(hc.color, 2, { layout: 'hero' }) : null;
        const boardReads = Array.from({ length: 5 }, (_, i) => bCells && bCells[i] ? readCardCell(cm, bCells[i]) : { state: 'none' });
        const heroReads = Array.from({ length: 2 }, (_, i) => hCells && hCells[i] ? readCardCell(cm, hCells[i]) : { state: 'none' });
        setCardReads({ board: boardReads, hero: heroReads });
        // mirror the exact crops the matcher saw (reveals box misplacement)
        drawCrop(boardCanvasRef.current, bc && bc.color, 360);
        drawCrop(heroCanvasRef.current, hc && hc.color, 150);
        // record on CARD change (not anchor flips, which would spam): a clean
        // timeline of what matched, each entry keeping the crop images.
        const key = boardReads.map(cellRecKey).join(',') + '|' + heroReads.map(cellRecKey).join(',');
        if (key !== lastLogKeyRef.current) {
          lastLogKeyRef.current = key;
          const log = cardLogRef.current;
          log.push({ t: Date.now(), anchor: anchorStatusRef.current, video: (vw && vh) ? [vw, vh] : null,
            heroDetect: { ...heroDbgRef.current },
            board: boardReads.map((r, i) => cellRecImg(r, bCells && bCells[i])),
            hero: heroReads.map((r, i) => cellRecImg(r, hCells && hCells[i])),
            // full region crops so the slicer can be re-run offline on the real frame
            boardRegion: stripToDataURL(bc && bc.color), heroRegion: stripToDataURL(hc && hc.color) });
          if (log.length > 250) log.shift();  // full-region crops are heavy — cap memory
          persistReads(log);                  // survive reloads (capped tail)
          setRecordCount(log.length);

          // DIAGNOSTIC: on the same card-change trigger (mid-hand → badges populated),
          // capture margin-expanded numeric crops for the digit-teach prep. Separate
          // heavy ring so the card log stays usable; capped tight.
          try {
            const numeric = captureNumericCrops(frameSnapRef.current, placedRef.current, vw);
            if (numeric) {
              const blog = badgeLogRef.current;
              blog.push({ t: Date.now(), video: (vw && vh) ? [vw, vh] : null, anchor: anchorStatusRef.current, numeric });
              if (blog.length > 60) blog.shift();
              persistBadges(blog);
              setBadgeCount(blog.length);
            }
          } catch (e) { /* badge diagnostic must never break capture */ }
        }
      }
    } catch (e) { /* a debug panel must never break capture */ }
    // urgency proxy: count frames since hero's turn opened (resets between turns)
    pollRef.current = conv.view.state === 'idle' ? 0 : pollRef.current + 1;
    // map the live converter state + parsed brain reply → the advisor's event shape
    let advisorEvent = null;
    try {
      advisorEvent = AdvisorEvent.normalize(AdvisorEvent.fromConverter({
        view: conv.view, advice: conv._advice, request: res && res.request,
        sentThisTurn: conv._sentThisTurn, polls: pollRef.current,
        bbChips: conv.cfg && conv.cfg.BB_CHIPS,
        // amendment E producer signals (stale supersession + brain/panel decline)
        stale: conv.view.stale, declined: conv.view.declined, lastSeq: conv._lastSentSeq,
      }));
      // live→PiP bridge: publish onto the ONE shared bus the always-on-top PiP
      // host (advisor-mount.jsx) subscribes to, so the human sees LIVE advice.
      if (advisorEvent) AdvisorEvent.sharedBus().publish(advisorEvent);
    } catch (e) { advisorEvent = null; } // never let a display map crash capture
    setView({ state: conv.view.state, advisorEvent, seatWarning: conv.view.seatWarning, betWarning: conv.view.betWarning, callWarning: conv.view.callWarning, table: conv.view.table });
  }, [heroBandRegion]);

  const { status, start, stop, regionText, videoSize, getFrameSnapshot } = useLiveOCR({
    intervalMs: 250,
    regions,                          // hero-anchored; updated each frame by onFrame
    preprocess: true,
    binarizeThreshold: 128,
    onFrame,
  });
  regionTextRef.current = regionText; // keep the ref fresh for onFrame's closure
  frameSnapRef.current = getFrameSnapshot; // for the calibration overlay in onFrame

  // Hero-band worker TEARDOWN only (creation is lazy, in onFrame). When capture
  // isn't running, terminate the worker + reset the anchor cache so the next
  // share re-detects from a clean cold start. No create/dispose race here.
  React.useEffect(() => {
    if (status === 'running') return undefined;
    const w = heroWorkerRef.current; heroWorkerRef.current = null;
    if (w) { try { w.terminate(); } catch (_) {} }
    heroWorkerInitRef.current = false;
    heroBusyRef.current = false;
    heroDetRef.current = null;
    anchorStatusRef.current = 'anchor-cold';
    try { PokerRegions.resetAnchorCache(); } catch (_) {}
    setAnchorStatus('anchor-cold');
    setHeroDbg({ ready: false, ocr: '', matched: null });
    setRegions(PokerRegions.captureRegions().concat(heroBandRegion));
    return undefined;
  }, [status, heroBandRegion]);

  React.useEffect(() => () => { try { convRef.current && convRef.current.botLink.close(); } catch (e) {} }, []);

  // Restore a previously-persisted card-read record (survives reloads).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(READS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) { cardLogRef.current = arr; setRecordCount(arr.length); }
      }
    } catch (_) { /* corrupt/absent — start fresh */ }
  }, []);

  // Download / clear the card-read record.
  const downloadReads = React.useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(cardLogRef.current, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'card-reads-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) { console.warn('[card-reads] download failed:', e); }
  }, []);
  const clearReads = React.useCallback(() => {
    cardLogRef.current = []; lastLogKeyRef.current = '';
    try { localStorage.removeItem(READS_KEY); } catch (_) {}
    setRecordCount(0);
  }, []);

  // Restore + download/clear the THIN snapshot log (parallel to the fat card log).
  React.useEffect(() => {
    try { const raw = localStorage.getItem(THIN_KEY); if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) { thinLogRef.current = arr; setThinCount(arr.length); } } } catch (_) {}
  }, []);
  const downloadThin = React.useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(thinLogRef.current, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'thin-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) { console.warn('[thin-snapshot] download failed:', e); }
  }, []);
  const clearThin = React.useCallback(() => {
    thinLogRef.current = [];
    try { localStorage.removeItem(THIN_KEY); } catch (_) {}
    setThinCount(0);
  }, []);

  // Restore + download/clear the BADGE-CROP diagnostic log (digit-teach prep).
  React.useEffect(() => {
    try { const raw = localStorage.getItem(BADGE_KEY); if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) { badgeLogRef.current = arr; setBadgeCount(arr.length); } } } catch (_) {}
  }, []);
  const downloadBadges = React.useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(badgeLogRef.current, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'badge-crops-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) { console.warn('[badge-crops] download failed:', e); }
  }, []);
  const clearBadges = React.useCallback(() => {
    badgeLogRef.current = [];
    try { localStorage.removeItem(BADGE_KEY); } catch (_) {}
    setBadgeCount(0);
  }, []);
  // QoL: ONE download pairing the thin stream + the badge crops from the same
  // capture — so a failed numeric parse (thin) can be cross-checked against the
  // actual crop (badges). The fat card-reads JSON stays separate.
  const downloadCapture = React.useCallback(() => {
    try {
      const payload = { capturedAt: new Date().toISOString(), thin: thinLogRef.current, badges: badgeLogRef.current };
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    } catch (e) { console.warn('[capture] download failed:', e); }
  }, []);

  // ── display (inline styles — self-contained, no build wiring) ──────────────
  // The advice/escalate readout is now the shared <AdvisorPanel> (the contract
  // display, items 1–9), fed by the live converter→AdvisorEvent adapter above.
  // The dev cross-check warnings below are live-validation guards, not advice —
  // they belong to this converter tab, not the always-on-top panel.
  const S = {
    panel: { font: '14px -apple-system, sans-serif', padding: 12, background: '#111', color: '#ddd' },
    controls: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 },
    advisorHost: { height: 200, marginBottom: 8, border: '1px solid #222', borderRadius: 6, overflow: 'hidden' },
    seatwarn: { fontSize: 13, color: '#111', background: '#e8c000', padding: 8, borderRadius: 6, marginTop: 8 },
    mut: { color: '#888' },
    cards: { marginTop: 8, padding: 8, border: '1px solid #222', borderRadius: 6, background: '#0d0d0d' },
    cardsRow: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 },
    cardsLabel: { width: 44, color: '#888', fontSize: 12 },
  };
  return (
    React.createElement('div', { style: S.panel },
      React.createElement('div', { style: S.controls },
        React.createElement('button', { onClick: status === 'running' ? stop : start },
          status === 'running' ? 'Stop' : 'Start'),
        React.createElement('span', { style: S.mut }, `brain: ${linkStatus}`),
        React.createElement('span', { style: S.mut }, `state: ${view.state}`),
        React.createElement('span', { style: S.mut }, `anchor: ${anchorStatus}`),
        React.createElement('span', { style: S.mut }, `video: ${videoSize ? videoSize.w + '×' + videoSize.h : '—'}`),
      ),
      // hero-anchor detection diagnostics — why the anchor is/isn't engaging
      React.createElement('div', { style: { ...S.mut, fontSize: 12, marginBottom: 6 } },
        `hero-detect: worker ${heroDbg.ready ? 'ready' : 'NOT ready'} · ocr "${heroDbg.ocr || ''}" · match ${heroDbg.matched || '—'}`),
      // the advice — the whole point — rendered by the shared contract panel
      React.createElement('div', { style: S.advisorHost },
        React.createElement(AdvisorPanel, { event: view.advisorEvent, muted: false, onToggleMute: () => {} })),
      // LOW-FID live table viewer (Josh's College Bot) — what the table reads now
      React.createElement(TableViewPanel, { table: view.table }),
      // live card-readout (read-only): what the card pipeline matches each frame
      React.createElement('div', { style: S.cards },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: '#aaa', fontSize: 12 } },
          React.createElement('span', null, 'card readout (live)'),
          React.createElement('span', { style: { color: '#666' } }, `rec: ${recordCount}`),
          React.createElement('button', { onClick: downloadReads, disabled: recordCount === 0, style: { fontSize: 11 } }, 'Download JSON'),
          React.createElement('button', { onClick: clearReads, disabled: recordCount === 0, style: { fontSize: 11 } }, 'Clear'),
          React.createElement('span', { style: { color: '#666', marginLeft: 10 } }, `thin: ${thinCount}`),
          React.createElement('button', { onClick: downloadThin, disabled: thinCount === 0, style: { fontSize: 11 } }, 'Download thin'),
          React.createElement('button', { onClick: clearThin, disabled: thinCount === 0, style: { fontSize: 11 } }, 'Clear thin'),
          React.createElement('span', { style: { color: '#666', marginLeft: 10 } }, `badges: ${badgeCount}`),
          React.createElement('button', { onClick: downloadBadges, disabled: badgeCount === 0, style: { fontSize: 11 } }, 'Download badges'),
          React.createElement('button', { onClick: clearBadges, disabled: badgeCount === 0, style: { fontSize: 11 } }, 'Clear badges'),
          React.createElement('button', { onClick: downloadCapture, disabled: thinCount === 0 && badgeCount === 0, style: { fontSize: 11, marginLeft: 10, fontWeight: 700 } }, 'Download capture (thin+badges)')),
        React.createElement('div', { style: S.cardsRow },
          React.createElement('span', { style: S.cardsLabel }, 'board'),
          ...cardReads.board.map((r, i) => cardChip(r, 'b' + i))),
        React.createElement('div', { style: S.cardsRow },
          React.createElement('span', { style: S.cardsLabel }, 'hero'),
          ...cardReads.hero.map((r, i) => cardChip(r, 'h' + i))),
        // the actual crops the matcher is fed — if these aren't ON the cards, the
        // region box is misplaced (anchor/resolution), not a matcher problem
        React.createElement('div', { style: { ...S.cardsRow, alignItems: 'flex-start' } },
          React.createElement('span', { style: S.cardsLabel }, 'crop'),
          React.createElement('div', null,
            React.createElement('canvas', { ref: boardCanvasRef, style: { display: 'block', border: '1px solid #2a2a2a', background: '#000' } }),
            React.createElement('canvas', { ref: heroCanvasRef, style: { display: 'block', marginTop: 4, border: '1px solid #2a2a2a', background: '#000' } }))),
        // NUDGE controls: move the board(green)/hero(red) boxes until they sit on
        // the cards and the reads light up. Values persist; tell me the numbers.
        (() => {
          const nb = (label, key, d) => React.createElement('button', { onClick: () => bumpNudge(key, d), style: { fontSize: 12, padding: '1px 6px', marginRight: 2 } }, label);
          const grp = (name, kx, ky) => React.createElement('span', { style: { marginRight: 12, whiteSpace: 'nowrap' } },
            React.createElement('span', { style: { color: '#888', marginRight: 4 } }, name + ':'),
            nb('↑', ky, -10), nb('↓', ky, 10), nb('←', kx, -10), nb('→', kx, 10));
          return React.createElement('div', { style: { ...S.cardsRow, flexWrap: 'wrap' } },
            React.createElement('span', { style: S.cardsLabel }, 'nudge'),
            grp('board', 'bdx', 'bdy'), grp('hero', 'hdx', 'hdy'),
            React.createElement('span', { style: { color: '#666', fontSize: 11 } },
              `board(${nudge.bdx},${nudge.bdy}) hero(${nudge.hdx},${nudge.hdy})`));
        })(),
        // CALIBRATION OVERLAY: the whole table with the region boxes drawn on it.
        // board (green) should sit on the board cards' top-left corners; hero (red)
        // on the hole cards; band (blue) on the nameplate. Off = box misplaced.
        React.createElement('div', { style: { ...S.cardsRow, alignItems: 'flex-start' } },
          React.createElement('span', { style: S.cardsLabel }, 'overlay'),
          React.createElement('canvas', { ref: overlayCanvasRef, style: { display: 'block', border: '1px solid #2a2a2a', background: '#000', maxWidth: '100%' } }))),
      // the seat-order self-check warning (top live-validation item) — loud
      view.seatWarning && React.createElement('div', { style: S.seatwarn }, view.seatWarning),
      // hero-bet stack-delta vs bet-badge drift (to_call ground-truth check)
      view.betWarning && React.createElement('div', { style: S.seatwarn }, view.betWarning),
      // to_call sign vs the shown Check/Call button (validates ACTION_PANEL_RECT)
      view.callWarning && React.createElement('div', { style: S.seatwarn }, view.callWarning),
    )
  );
}

if (typeof window !== 'undefined') window.ConverterPanel = ConverterPanel;
