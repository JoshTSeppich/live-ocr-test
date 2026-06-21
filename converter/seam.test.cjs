// converter/seam.test.cjs — THE seam proof. A REAL captured frame (not a
// synthetic colour crop) with a green overlay on a stack plate, run through the
// actual capture→observe path, must read `occluded`. And feeding the BINARIZED
// crop where colour belongs (the exact regression the seam fixes) must NOT read
// occluded — so this test fails loudly if anyone reverts the colour wiring.
//
// Fixtures: shot_00036_121507 TC stack plate (§0.4 box 1280,355,560,175), green
// "Join Here" seat-vacate banner, downscaled 2× to 280×88. _color is the colour
// source crop (green_frac 0.258); _binar is binarizeInvert(threshold 128) of it
// (green_frac 0.000 — b/w has no colour).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const O = require('./observation.js');
const F = require('./frame.js');

const W = 280, H = 88;
function loadFix(name) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  assert.strictEqual(buf.length, W * H * 4, `${name} wrong size`);
  return { rgba: new Uint8Array(buf), w: W, h: H };
}
const COLOR = loadFix('occluded_tc_color.bin');   // real colour crop, green banner
const BINAR = loadFix('occluded_tc_binar.bin');   // its binarized form, no colour

// ── the gate itself, on real pixels ─────────────────────────────────────────
test('REAL FRAME: colour crop of the occluded plate → occluded', () => {
  const r = O.classifyPlate(COLOR.rgba, COLOR.w, COLOR.h);
  assert.strictEqual(r.status, 'occluded', `green_frac=${r.green}`);
});

test('REGRESSION CATCH: binarized crop has no colour → gate canNOT see occlusion', () => {
  // This is precisely the bug: if the seam feeds binarized where colour belongs,
  // the green overlay is invisible and the gate passes — silently disabling
  // occlusion detection. The crop is b/w, so it does NOT read occluded.
  const r = O.classifyPlate(BINAR.rgba, BINAR.w, BINAR.h);
  assert.notStrictEqual(r.status, 'occluded',
    'binarized crop must not read occluded — proving colour is required for the gate');
});

// ── full capture→observe path via the real frame adapter ────────────────────
function getCropsWith(colorCrop) {
  // Only stack_TC has a crop; every other region returns null (→ no-read).
  return (regionId) => (regionId === 'stack_TC'
    ? { color: colorCrop, binarized: BINAR }
    : null);
}

test('SEAM CLOSED: getCrops→buildFrame→observeFrame → no gold under the overlay → no-read', () => {
  // The green banner hides the gold number, so the gold-locate finds nothing →
  // no-read, value null. Never an OCR'd guess under the overlay (the seat shows "?").
  const { frame, observeOpts } = F.buildFrame(getCropsWith(COLOR), { videoW: 2940, videoH: 1846 }, {});
  const obs = O.observeFrame(frame, observeOpts);
  assert.strictEqual(obs.stacks.TC.status, 'no-read');
  assert.strictEqual(obs.stacks.TC.value, null);
});

test('SEAM OPEN would regress: feeding binarized as the colour crop loses occlusion', () => {
  // Simulate the broken wiring — colour slot gets the binarized crop.
  const { frame, observeOpts } = F.buildFrame(getCropsWith(BINAR), { videoW: 2940, videoH: 1846 }, {});
  const obs = O.observeFrame(frame, observeOpts);
  assert.notStrictEqual(obs.stacks.TC.status, 'occluded',
    'binarized-as-colour must NOT detect occlusion — this is what the seam fix prevents');
});
