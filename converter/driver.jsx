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

// ── Live card-readout (read-only debug panel) ───────────────────────────────
// Classifies one card-strip cell exactly as the pipeline does: same strip crop
// (PokerFrame.sliceCells), same matcher, same 0.85 confidence gate as
// observation.readCardCells. Returns a small display record per card.
const CARD_MIN_CONF = 0.85; // == observation.readCardCells default
const SUIT_GLYPH = { h: '♥', d: '♦', s: '♠', c: '♣' };
function fmtCardCode(code) {
  if (!code || code.length < 2) return { text: code || '?', red: false };
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  return { text: rank + (SUIT_GLYPH[suit] || suit), red: suit === 'h' || suit === 'd' };
}
function readCardCell(matcher, cell) {
  if (!cell) return { state: 'none' };
  const m = matcher.match(cell.rgba, cell.w, cell.h);
  if (!m || m.confidence == null || m.confidence < CARD_MIN_CONF) {
    return { state: 'no-read', conf: m ? m.confidence : 0, guess: m ? m.card : null };
  }
  // confident rank+colour; suit may still abstain (never a confident wrong suit)
  return { state: m.suitConfident ? 'read' : 'abstain', conf: m.confidence, code: m.card, alts: m.suitAlternatives };
}
// change-detect key (ignores confidence jitter) + compact record for the log
const cellRecKey = (r) => (r ? r.state + (r.code || '') : 'none');
const cellRec = (r) => (r ? { state: r.state, code: r.code || null, conf: r.conf != null ? +r.conf.toFixed(3) : null } : { state: 'none' });
// One card chip element for the live readout (read-only).
function cardChip(r, key) {
  r = r || { state: 'none' };
  const pct = r.conf != null ? Math.round(r.conf * 100) + '%' : '';
  const base = { width: 64, padding: '4px 2px', borderRadius: 5, textAlign: 'center',
    border: '1px solid #2a2a2a', background: '#161616', font: '13px ui-monospace, monospace' };
  let title, titleColor, sub;
  if (r.state === 'read') { const f = fmtCardCode(r.code); title = f.text; titleColor = f.red ? '#ff6b6b' : '#e8e8e8'; sub = pct; }
  else if (r.state === 'abstain') { const f = fmtCardCode(r.code); title = f.text + '?'; titleColor = '#e8c000'; sub = 'abstain ' + pct; }
  else if (r.state === 'no-read') { title = '—'; titleColor = '#666'; sub = 'no-read' + (pct ? ' ' + pct : ''); }
  else { title = '·'; titleColor = '#444'; sub = ''; }
  return React.createElement('div', { key, style: base },
    React.createElement('div', { style: { fontSize: 16, fontWeight: 700, color: titleColor, lineHeight: '18px' } }, title),
    React.createElement('div', { style: { fontSize: 10, color: '#888' } }, sub));
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
  const heroBusyRef = React.useRef(false);  // at most one band OCR in flight
  const heroDetRef = React.useRef(null);    // { det, fresh } — latest hero detection

  // Live card-readout: what the card pipeline matches each frame (read-only).
  const [cardReads, setCardReads] = React.useState({
    board: [null, null, null, null, null], hero: [null, null],
  });
  // Visible previews of the actual board/hero crops fed to the matcher (so a
  // misplaced region box is obvious — felt instead of cards).
  const boardCanvasRef = React.useRef(null);
  const heroCanvasRef = React.useRef(null);
  // Rolling record of card reads (appended only when the read CHANGES, not every
  // frame), downloadable as JSON for inspection.
  const cardLogRef = React.useRef([]);
  const lastLogKeyRef = React.useRef('');
  const [recordCount, setRecordCount] = React.useState(0);

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
        try { canvas = rgbaToCanvas(band.color.rgba, band.color.w, band.color.h); }
        catch (_) { heroBusyRef.current = false; }
        if (canvas) {
          hw.recognize(canvas, {}, { blocks: true })
            .then(({ data }) => {
              const det = PokerRegions.detectHero((data && data.words) || [],
                { bandOriginX, bandOriginY, bandScale: 1 });
              if (det) heroDetRef.current = { det, fresh: true };
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
      setRegions(placed.regions.concat(heroBandRegion));
      if (placed.status !== anchorStatusRef.current) {
        anchorStatusRef.current = placed.status;
        setAnchorStatus(placed.status);
      }
    }

    // feed the latest action-panel OCR text (from Tesseract path) for check-vs-call
    conv.setPanelText(regionTextRef.current && regionTextRef.current.action_panel || null);
    const res = conv.onFrame(getCrops, dims); // res.request = the assembled snapshot

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
        // record on CHANGE (not every frame): a clean timeline of what matched
        const key = boardReads.map(cellRecKey).join(',') + '|' + heroReads.map(cellRecKey).join(',') + '|' + anchorStatusRef.current;
        if (key !== lastLogKeyRef.current) {
          lastLogKeyRef.current = key;
          const log = cardLogRef.current;
          log.push({ t: Date.now(), anchor: anchorStatusRef.current, video: (vw && vh) ? [vw, vh] : null,
            board: boardReads.map(cellRec), hero: heroReads.map(cellRec) });
          if (log.length > 5000) log.shift();
          setRecordCount(log.length);
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
    setView({ state: conv.view.state, advisorEvent, seatWarning: conv.view.seatWarning, betWarning: conv.view.betWarning, callWarning: conv.view.callWarning });
  }, [heroBandRegion]);

  const { status, start, stop, regionText, videoSize } = useLiveOCR({
    intervalMs: 250,
    regions,                          // hero-anchored; updated each frame by onFrame
    preprocess: true,
    binarizeThreshold: 128,
    onFrame,
  });
  regionTextRef.current = regionText; // keep the ref fresh for onFrame's closure

  // Dedicated hero-band OCR worker: lives only while capturing. On stop/unmount
  // it terminates and the anchor cache resets, so the next share re-detects from
  // a clean cold start instead of inheriting a stale transform.
  React.useEffect(() => {
    if (status !== 'running') return undefined;
    let disposed = false;
    (async () => {
      try {
        const w = await window.Tesseract.createWorker('eng', 1, {
          langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
        });
        await w.setParameters({ tessedit_pageseg_mode: '6' });
        if (disposed) { try { await w.terminate(); } catch (_) {} return; }
        heroWorkerRef.current = w;
      } catch (e) { console.warn('[hero-anchor] worker init failed:', e); }
    })();
    return () => {
      disposed = true;
      const w = heroWorkerRef.current; heroWorkerRef.current = null;
      if (w) { try { w.terminate(); } catch (_) {} }
      heroBusyRef.current = false;
      heroDetRef.current = null;
      anchorStatusRef.current = 'anchor-cold';
      try { PokerRegions.resetAnchorCache(); } catch (_) {}
      setAnchorStatus('anchor-cold');
      setRegions(PokerRegions.captureRegions().concat(heroBandRegion));
    };
  }, [status, heroBandRegion]);

  React.useEffect(() => () => { try { convRef.current && convRef.current.botLink.close(); } catch (e) {} }, []);

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
    cardLogRef.current = []; lastLogKeyRef.current = ''; setRecordCount(0);
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
      // the advice — the whole point — rendered by the shared contract panel
      React.createElement('div', { style: S.advisorHost },
        React.createElement(AdvisorPanel, { event: view.advisorEvent, muted: false, onToggleMute: () => {} })),
      // live card-readout (read-only): what the card pipeline matches each frame
      React.createElement('div', { style: S.cards },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: '#aaa', fontSize: 12 } },
          React.createElement('span', null, 'card readout (live)'),
          React.createElement('span', { style: { color: '#666' } }, `rec: ${recordCount}`),
          React.createElement('button', { onClick: downloadReads, disabled: recordCount === 0, style: { fontSize: 11 } }, 'Download JSON'),
          React.createElement('button', { onClick: clearReads, disabled: recordCount === 0, style: { fontSize: 11 } }, 'Clear')),
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
            React.createElement('canvas', { ref: heroCanvasRef, style: { display: 'block', marginTop: 4, border: '1px solid #2a2a2a', background: '#000' } })))),
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
