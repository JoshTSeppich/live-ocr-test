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

function ConverterPanel({ url = 'ws://127.0.0.1:8766' }) {
  const [view, setView] = React.useState({ state: 'idle', advisorEvent: null, seatWarning: null, betWarning: null, callWarning: null });
  const [linkStatus, setLinkStatus] = React.useState('idle');
  const convRef = React.useRef(null);
  const regionTextRef = React.useRef({}); // latest per-region OCR text (for check-vs-call)
  const pollRef = React.useRef(0);        // urgency proxy: frames since hero's turn began

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
    convRef.current = { conv, botLink };
  }

  // Feed every captured frame into the converter, then publish its view.
  const onFrame = React.useCallback((getCrops, dims) => {
    const { conv } = convRef.current;
    // feed the latest action-panel OCR text (from Tesseract path) for check-vs-call
    conv.setPanelText(regionTextRef.current && regionTextRef.current.action_panel || null);
    const res = conv.onFrame(getCrops, dims); // res.request = the assembled snapshot
    // urgency proxy: count frames since hero's turn opened (resets between turns)
    pollRef.current = conv.view.state === 'idle' ? 0 : pollRef.current + 1;
    // map the live converter state + parsed brain reply → the advisor's event shape
    let advisorEvent = null;
    try {
      advisorEvent = AdvisorEvent.normalize(AdvisorEvent.fromConverter({
        view: conv.view, advice: conv._advice, request: res && res.request,
        sentThisTurn: conv._sentThisTurn, polls: pollRef.current,
        bbChips: conv.cfg && conv.cfg.BB_CHIPS,
      }));
    } catch (e) { advisorEvent = null; } // never let a display map crash capture
    setView({ state: conv.view.state, advisorEvent, seatWarning: conv.view.seatWarning, betWarning: conv.view.betWarning, callWarning: conv.view.callWarning });
  }, []);

  const { status, start, stop, regionText } = useLiveOCR({
    intervalMs: 250,
    regions: PokerRegions.captureRegions(),
    preprocess: true,
    binarizeThreshold: 128,
    onFrame,
  });
  regionTextRef.current = regionText; // keep the ref fresh for onFrame's closure

  React.useEffect(() => () => { try { convRef.current && convRef.current.botLink.close(); } catch (e) {} }, []);

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
  };
  return (
    React.createElement('div', { style: S.panel },
      React.createElement('div', { style: S.controls },
        React.createElement('button', { onClick: status === 'running' ? stop : start },
          status === 'running' ? 'Stop' : 'Start'),
        React.createElement('span', { style: S.mut }, `brain: ${linkStatus}`),
        React.createElement('span', { style: S.mut }, `state: ${view.state}`),
      ),
      // the advice — the whole point — rendered by the shared contract panel
      React.createElement('div', { style: S.advisorHost },
        React.createElement(AdvisorPanel, { event: view.advisorEvent, muted: false, onToggleMute: () => {} })),
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
