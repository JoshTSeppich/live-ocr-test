// converter/harness.jsx — Phase 5 browser instrument (CONVERTER_BUILD_SPEC §6).
// The FIRST thing run against a real table at bring-up. It runs the live capture
// with the SETTLE GATE DISABLED — no debouncer, no assembling, no sending —
// and records EVERY 250 ms frame so the two live-only questions get answered:
//   §6.1 does the green timer bar read correctly across a FULL drain?
//   §6.2 how often do live frames land mid-animation, and how long are settled
//        runs (the debouncer N)?
//
// Per frame it logs { ts, frameHash (dHash of the table), timer fraction,
// heroToAct }. Hit "Download" after a few hands and feed the JSON's `summary`
// (midAnimationRate, settleRun, timerDrains) into the live-validation decisions.
//
// NOT node-tested (DOM); its analysis core is captureHarness.js (tested).
/* global React, PokerEngine, PokerRegions, PokerObservation, PokerFrame,
          PokerCaptureHarness, useLiveOCR */

function CaptureHarnessPanel() {
  const [stats, setStats] = React.useState({ frames: 0, timer: null, midRate: null, drains: 0 });
  const ref = React.useRef(null);

  if (!ref.current) {
    const recorder = new PokerCaptureHarness.CaptureRecorder();
    const digitMatcher = new PokerEngine.DigitMatcher();
    const cardMatcher = new PokerEngine.MultiSignatureMatcher();
    ref.current = { recorder, digitMatcher, cardMatcher, t0: null };
  }

  const onFrame = React.useCallback((getCrops, dims) => {
    const st = ref.current;
    if (st.t0 == null) st.t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const ts = (typeof performance !== 'undefined' ? performance.now() : 0) - st.t0;
    // Layer 1 only — NO debouncer (the whole point: settle gate OFF).
    const built = PokerFrame.buildFrame(getCrops, dims, { digitMatcher: st.digitMatcher, cardMatcher: st.cardMatcher });
    const obs = PokerObservation.observeFrame(built.frame, built.observeOpts);
    const table = getCrops('button_scan'); // large central crop = "did the table move?"
    const frameHash = table ? PokerCaptureHarness.dhashRgba(table.color) : '0'.repeat(64);
    const timer = obs.timer ? obs.timer.fraction : null;
    const heroToAct = obs.turn ? !!obs.turn.heroToAct : false;
    st.recorder.record({ ts, frameHash, timer, heroToAct });
    if (st.recorder.rows.length % 8 === 0) {
      const s = st.recorder.summary();
      setStats({ frames: s.frameCount, timer, midRate: s.midAnimationRate, drains: (s.timerDrains || []).length });
    }
  }, []);

  const { status, start, stop } = useLiveOCR({
    intervalMs: 250, regions: PokerRegions.captureRegions(),
    preprocess: true, binarizeThreshold: 128, onFrame,
  });

  const download = React.useCallback(() => {
    const st = ref.current;
    const payload = { capturedAt: new Date().toISOString(), rows: st.recorder.rows, summary: st.recorder.summary() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `converter-capture-${st.recorder.rows.length}frames.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const S = {
    panel: { font: '14px -apple-system, sans-serif', padding: 12, background: '#111', color: '#ddd' },
    row: { display: 'flex', gap: 16, alignItems: 'center', margin: '6px 0' },
    mut: { color: '#888' }, warn: { color: '#e8c000' },
  };
  return React.createElement('div', { style: S.panel },
    React.createElement('div', { style: { fontWeight: 700, marginBottom: 8 } },
      'Capture harness — settle gate OFF (§6 live instrument)'),
    React.createElement('div', { style: S.row },
      React.createElement('button', { onClick: status === 'running' ? stop : start },
        status === 'running' ? 'Stop' : 'Start'),
      React.createElement('button', { onClick: download, disabled: stats.frames === 0 }, 'Download JSON'),
    ),
    React.createElement('div', { style: S.row },
      React.createElement('span', { style: S.mut }, `frames: ${stats.frames}`),
      React.createElement('span', { style: S.mut }, `timer: ${stats.timer == null ? '—' : stats.timer.toFixed(2)}`),
      React.createElement('span', { style: S.mut }, `mid-anim rate: ${stats.midRate == null ? '—' : stats.midRate.toFixed(2)}`),
      React.createElement('span', { style: S.mut }, `hero-turn drains: ${stats.drains}`),
    ),
    React.createElement('div', { style: S.warn },
      'Run a few hands incl. several hero decisions, then Download. Check summary.timerDrains[].drained/monotonicFraction (§6.1) and summary.settleRun + midAnimationRate (§6.2).'),
  );
}

if (typeof window !== 'undefined') window.CaptureHarnessPanel = CaptureHarnessPanel;
