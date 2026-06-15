// advisor/advisor-mount.jsx — the controller + app-shell mount (advisor-panel).
//
// The ONE module entry.jsx imports. It pulls in its siblings (each self-registers
// on window), then mounts a small in-page control surface into its OWN container
// (#advisor-root) — it does NOT touch live-ocr-test.jsx or the converter panel.
//
// Responsibilities (the things AdvisorPanel deliberately does NOT do):
//   • own the AdvisorEvent bus + the stub that feeds it
//   • fire the audio cues on advice/stale transitions (zero-glance channel)
//   • open the Document-PiP window from a user gesture and portal the SAME
//     <AdvisorPanel> into it, so in-page preview and PiP share one React state.
//
// Source is the stub today; the live converter feed is a drop-in publish() at
// merge (see ADVISOR_PANEL_INTERFACE.md "WS-swappability").
import { createPortal } from 'react-dom'; // NOT on window.ReactDOM (that's react-dom/client)
import './advisor-event.js';
import './advisor-stub.js';
import './advisor-audio.js';
import './usePipWindow.js';
import './AdvisorPanel.jsx';

const React = window.React;
const ReactDOM = window.ReactDOM;
const AE = window.AdvisorEvent;
const h = React.createElement;

function AdvisorController() {
  const [event, setEvent] = React.useState(null);
  const [muted, setMutedState] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const refs = React.useRef(null);
  const pip = window.useAdvisorPip();

  if (!refs.current) {
    // the ONE shared bus: the live converter (driver.jsx) publishes here, and the
    // stub publishes here too — so this PiP host shows LIVE advice at merge
    // (ADVISOR_PANEL_INTERFACE.md "Bridging the live converter feed").
    const bus = AE.sharedBus();
    const audio = window.AdvisorAudio.createAudio();
    const stub = window.AdvisorStub.createStub(bus, { seed: 7 });
    refs.current = { bus, audio, stub };
  }
  const { bus, audio, stub } = refs.current;

  // subscribe once: fire audio on advice/stale, then publish to React state.
  React.useEffect(() => {
    const unsub = bus.subscribe((n) => {
      if (n.kind === 'advice') audio.advice();
      else if (n.kind === 'stale') audio.stale();
      setEvent(n);
    });
    return unsub;
  }, [bus, audio]);

  const toggleMute = React.useCallback(() => {
    setMutedState(audio.toggle());
  }, [audio]);

  const startStub = React.useCallback(() => {
    audio.unlock();            // this click is a user gesture — unlock audio
    if (!stub.running) { stub.start(); setRunning(true); }
  }, [audio, stub]);

  const stopStub = React.useCallback(() => {
    stub.stop(); setRunning(false);
  }, [stub]);

  const openPip = React.useCallback(async () => {
    audio.unlock();            // user gesture
    try { await pip.open({ width: 360, height: 200 }); }
    catch (e) { window.alert('Could not open advisor PiP: ' + (e && e.message || e)); }
  }, [audio, pip]);

  // ── in-page control surface ────────────────────────────────────────────
  const panelProps = { event, muted, onToggleMute: toggleMute };
  const wrap = {
    position: 'fixed', left: 8, bottom: 8, width: 380, zIndex: 2147482000,
    border: '1px solid #333', borderRadius: 8, background: '#111', color: '#ddd',
    font: '13px -apple-system, system-ui, sans-serif',
  };
  const barBtn = (label, onClick, on) => h('button', {
    onClick, style: {
      cursor: 'pointer', marginRight: 6, padding: '4px 8px', borderRadius: 4,
      border: '1px solid #2a2f36', background: on ? '#1f6feb' : 'transparent',
      color: on ? '#fff' : '#ddd', fontSize: 12,
    },
  }, label);

  const previewBox = { height: 200, borderTop: '1px solid #333', overflow: 'hidden' };

  return h('div', { style: wrap },
    h('div', { style: { display: 'flex', alignItems: 'center', padding: 8, gap: 4, flexWrap: 'wrap' } },
      h('strong', { style: { marginRight: 6, fontSize: 12 } }, 'Advisor'),
      running ? barBtn('Stop stub', stopStub, true) : barBtn('Start stub', startStub, false),
      barBtn(pip.isOpen ? 'PiP open ✓' : 'Open PiP', openPip, pip.isOpen),
      h('span', { style: { fontSize: 11, color: '#6b7177', marginLeft: 'auto' } },
        pip.supported ? ('source: ' + (running ? 'stub' : 'live')) : 'PiP unsupported')),
    // in-page preview (the same component the PiP shows)
    h('div', { style: previewBox }, h(window.AdvisorPanel, panelProps)),
    // PiP portal — same React state, separate OS window
    pip.container && createPortal(h(window.AdvisorPanel, panelProps), pip.container));
}

function mount() {
  if (document.getElementById('advisor-root')) return;
  const el = document.createElement('div');
  el.id = 'advisor-root';
  document.body.appendChild(el);
  ReactDOM.createRoot(el).render(h(AdvisorController));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
