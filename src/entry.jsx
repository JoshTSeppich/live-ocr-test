// entry.jsx — the single bundle entry point. esbuild compiles this into
// dist/app.js (+ dist/app.css from the CSS import below).
//
// Import order is load-bearing: it is the execution order of the legacy code.
//   1. styles-entry.css  — collected into dist/app.css (no JS side effects)
//   2. setup-globals.js  — puts React / ReactDOM / Tesseract / PokerEngine /
//                          CaptureQueue on window
//   3. live-ocr.jsx      — defines window.useLiveOCR & friends (needs React)
//   4. live-ocr-test.jsx — the React UI; calls ReactDOM.createRoot(...) at its
//                          end, mounting the app into <div id="root">
//   5. converter-globals.js — bundles the converter modules (each self-registers
//                          on window) and mounts the floating Advisor / Capture-
//                          Harness panel. Last, so window.useLiveOCR + PokerEngine
//                          are already present.
import './styles-entry.css';
import './setup-globals.js';
import '../live-ocr.jsx';
import '../live-ocr-test.jsx';
import './converter-globals.js';
import '../advisor/advisor-mount.jsx';
