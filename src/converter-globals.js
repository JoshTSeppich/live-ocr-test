// converter-globals.js — bundle the converter into the app and mount its UI.
//
// Imported LAST in entry.jsx, after setup-globals.js (window.React / ReactDOM /
// PokerEngine) and live-ocr.jsx (window.useLiveOCR). Each converter UMD module,
// when esbuild bundles it as CommonJS, runs its `root.PokerX = m` line with
// root === self === window, so every module self-registers on window. The two
// .jsx panels set window.ConverterPanel / window.CaptureHarnessPanel.
//
// We mount a small floating, tabbed panel into its OWN container (not the
// harness #root), so the converter UI sits alongside the existing app without
// touching live-ocr-test.jsx. The panels do not auto-start capture — each has a
// Start button (getDisplayMedia is user-gesture gated anyway).

import '../converter/regions.js';
import '../converter/seats.js';
import '../converter/observation.js';
import '../converter/frame.js';
import '../converter/settle.js';
import '../converter/handBoundary.js';
import '../converter/history.js';
import '../converter/assembler.js';
import '../converter/botLink.js';
import '../converter/escalate.js';
import '../converter/converter.js';
import '../converter/captureHarness.js';
import '../converter/driver.jsx';   // → window.ConverterPanel
import '../converter/harness.jsx';  // → window.CaptureHarnessPanel

const React = window.React;
const ReactDOM = window.ReactDOM;

function ConverterApp() {
  const [tab, setTab] = React.useState('advisor');
  const tabBtn = (id, label) => React.createElement('button',
    { onClick: () => setTab(id), style: { fontWeight: tab === id ? 700 : 400, marginRight: 6 } }, label);
  return React.createElement('div',
    { style: { position: 'fixed', right: 8, top: 8, width: 410, maxHeight: '92vh', overflow: 'auto', zIndex: 2147483000, border: '1px solid #333', borderRadius: 8, background: '#111' } },
    React.createElement('div', { style: { display: 'flex', padding: 8, borderBottom: '1px solid #333' } },
      tabBtn('advisor', 'Advisor'),
      tabBtn('harness', 'Capture Harness (§6)')),
    tab === 'advisor'
      ? React.createElement(window.ConverterPanel)
      : React.createElement(window.CaptureHarnessPanel));
}

function mount() {
  if (document.getElementById('converter-root')) return;
  const el = document.createElement('div');
  el.id = 'converter-root';
  document.body.appendChild(el);
  ReactDOM.createRoot(el).render(React.createElement(ConverterApp));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
