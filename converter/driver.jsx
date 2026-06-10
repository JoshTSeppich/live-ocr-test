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
          PokerHistory, PokerEscalate, PokerBotLink, PokerConverter, useLiveOCR */

function ConverterPanel({ url = 'ws://127.0.0.1:8766' }) {
  const [view, setView] = React.useState({ state: 'idle', advice: null, warning: null, seatWarning: null });
  const [linkStatus, setLinkStatus] = React.useState('idle');
  const convRef = React.useRef(null);

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
    conv.onFrame(getCrops, dims);
    // copy the converter's view into React state (cheap shallow object)
    setView({ state: conv.view.state, advice: conv.view.advice, warning: conv.view.warning, seatWarning: conv.view.seatWarning });
  }, []);

  const { status, start, stop } = useLiveOCR({
    intervalMs: 250,
    regions: PokerRegions.captureRegions(),
    preprocess: true,
    binarizeThreshold: 128,
    onFrame,
  });

  React.useEffect(() => () => { try { convRef.current && convRef.current.botLink.close(); } catch (e) {} }, []);

  // ── display (inline styles — self-contained, no build wiring) ──────────────
  const advising = view.state === 'advising' && view.advice;
  const escalating = view.state === 'escalate';
  const S = {
    panel: { font: '14px -apple-system, sans-serif', padding: 12, background: '#111', color: '#ddd' },
    controls: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 },
    advice: { fontSize: 28, fontWeight: 700, color: '#7CFC9A', padding: '10px 0' },
    escalate: { fontSize: 20, fontWeight: 700, color: '#fff', background: '#a11', padding: 10, borderRadius: 6 },
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
      // the advice — the whole point
      advising && React.createElement('div', { style: S.advice }, view.advice),
      // the ONLY visible error case (§5): clock low + no clean read
      escalating && React.createElement('div', { style: S.escalate },
        view.warning || "can't read state — decide manually"),
      // the seat-order self-check warning (top live-validation item) — loud
      view.seatWarning && React.createElement('div', { style: S.seatwarn }, view.seatWarning),
    )
  );
}

if (typeof window !== 'undefined') window.ConverterPanel = ConverterPanel;
