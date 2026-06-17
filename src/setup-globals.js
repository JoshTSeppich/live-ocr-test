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
import stripTemplates from '../multi-sig-templates.strip.json';

window.React = React;
window.ReactDOM = ReactDOMClient; // exposes createRoot (the only API the app uses)
window.Tesseract = Tesseract;
window.PokerEngine = PokerEngine;
window.CaptureQueue = CaptureQueue;

// ── Seed the calibrated corner-strip card templates ───────────────────────
// MultiSignatureMatcher.match() loads its templates from localStorage
// 'multi-sig-templates' at construction. The suit-pip classifier (engine.js
// Component 4) and the rank/colour hashes are CALIBRATED to the 55×130 corner
// strip (docs/PIP_CROP_GEOMETRY.md). Any historically-taught FULL-CELL
// templates under that key would feed match() the wrong crop, so the live
// matcher must use the committed strip set (multi-sig-templates.strip.json,
// validated 698/698 by tools/validate-suit-corpus.mjs).
//
// Seeded here, before live-ocr-test.jsx / driver.jsx construct their matchers.
// Idempotent: a version marker means we replace stale full-cell templates ONCE
// (the first load after this ships) and then leave localStorage alone, so a
// later re-teach is not clobbered on every reload. Bump SEED_VERSION to force
// a re-seed if the strip set itself changes.
//
// NOTE: this seeds the READING templates only. The live card-READ crop path
// (cardCellsFromRegion / sliceCells) still slices full-height cells and does
// NOT yet produce the calibrated 55×130 strip — that slicer is the deferred
// follow-up. Until it lands, these strip templates are correct but the live
// crop fed to them is not; the corpus harness is the meaningful gate.
try {
  const KEY = 'multi-sig-templates';
  const MARK = 'multi-sig-templates:seed-version';
  const SEED_VERSION = 'strip-v1';
  if (typeof localStorage !== 'undefined'
      && localStorage.getItem(MARK) !== SEED_VERSION) {
    localStorage.setItem(KEY, JSON.stringify(stripTemplates));
    localStorage.setItem(MARK, SEED_VERSION);
  }
} catch (_) { /* private mode / quota — matcher falls back to whatever's there */ }
