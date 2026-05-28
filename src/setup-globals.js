// setup-globals.js — wire npm dependencies onto `window` BEFORE any of the
// legacy source files run.
//
// The four legacy modules (engine.js, capture-queue.js, live-ocr.jsx,
// live-ocr-test.jsx) were written for the old CDN-script-tag world: they read
// React / ReactDOM / Tesseract as bare globals and pass data between each other
// via `window.PokerEngine` / `window.CaptureQueue` / `window.useLiveOCR`.
//
// Rather than rewrite all four to use ES imports, we keep that global contract
// and satisfy it from bundled npm packages. esbuild evaluates a module's
// imports before its body, and modules in the same bundle run in import order,
// so importing THIS file first in entry.jsx guarantees every global below is
// present before the legacy code executes.
//
// engine.js and capture-queue.js are UMD. The package is NOT "type": "module"
// (it must stay CommonJS so Session B's .cjs test runner can require()
// engine.js), so esbuild classifies these dependency-free .js files as
// CommonJS: their UMD `typeof module === 'object'` guard is true and they
// assign `module.exports = factory()` instead of touching window. We therefore
// import their default export and put it on window ourselves. (capture-queue
// reads window.PokerEngine lazily, so engine.js must be assigned first.)

import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as Tesseract from 'tesseract.js';
import PokerEngine from '../engine.js';
import CaptureQueue from '../capture-queue.js';

window.React = React;
window.ReactDOM = ReactDOMClient; // exposes createRoot (the only API the app uses)
window.Tesseract = Tesseract;
window.PokerEngine = PokerEngine;
window.CaptureQueue = CaptureQueue;
