// converter/observation.test.cjs — Phase 1 Layer-1 reader tests.
// Run: node --test converter/   (or: node --test converter/observation.test.cjs)
// Pure-pixel fixtures: assert correct reads AND correct occluded/no-read tagging
// on overlay cases (CONVERTER_BUILD_SPEC PHASE 1). No browser, no canvas.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const O = require('./observation.js');
const R = require('./regions.js');
const Engine = require('../engine.js');

// ── pixel fixture helpers ──────────────────────────────────────────────────
const DARK = [45, 45, 45];        // felt / plate background
const WHITE = [230, 230, 230];    // plate text ink (§0.4 white-on-dark)
const GREEN = [89, 188, 93];      // blind badge / timer (measured meanRGB)
const YELLOW = [202, 158, 64];    // puck (measured meanRGB)
const RED = [220, 45, 45];        // action buttons

function makeCrop(w, h, fill) {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = fill[0]; rgba[p * 4 + 1] = fill[1]; rgba[p * 4 + 2] = fill[2]; rgba[p * 4 + 3] = 255;
  }
  return { rgba, w, h };
}
function setPx(crop, x, y, c) {
  const i = (y * crop.w + x) * 4;
  crop.rgba[i] = c[0]; crop.rgba[i + 1] = c[1]; crop.rgba[i + 2] = c[2]; crop.rgba[i + 3] = 255;
}
// scatter `frac` of pixels with color c across a crop (deterministic)
function scatter(crop, c, frac) {
  const n = crop.w * crop.h, target = Math.floor(n * frac);
  let step = Math.max(1, Math.floor(n / Math.max(1, target)));
  let painted = 0;
  for (let p = 0; p < n && painted < target; p += step) {
    const i = p * 4; crop.rgba[i] = c[0]; crop.rgba[i + 1] = c[1]; crop.rgba[i + 2] = c[2];
    painted++;
  }
  return crop;
}
// filled disc of color c, radius r at (cx,cy)
function disc(crop, cx, cy, r, c) {
  for (let y = Math.max(0, cy - r); y <= Math.min(crop.h - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(crop.w - 1, cx + r); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(crop, x, y, c);
  return crop;
}
function rect(crop, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(crop, x, y, c);
  return crop;
}

// Build a binarized numeric strip (light bg, dark glyphs in gapped columns) and
// teach a DigitMatcher against the ground-truth symbols, then return both — so
// recognizeNumeric round-trips to the taught text (each box matches its own
// template at distance ~0). Each glyph gets a deterministic distinct pattern.
function buildTaughtStrip(symbols) {
  const CELL = 14, INNER = 10, GAP = 4, H = 22;
  const W = symbols.length * CELL + GAP;
  const strip = makeCrop(W, H, [255, 255, 255]); // light background
  symbols.forEach((sym, g) => {
    const x0 = GAP + g * CELL;
    const seed = sym.charCodeAt(0);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < INNER; x++)
        if (((x * 7 + y * 13 + seed) % 11) < 5) setPx(strip, x0 + x, y, [0, 0, 0]); // dark ink
  });
  const dm = new Engine.DigitMatcher('test:strip');
  dm.clear();
  const boxes = dm.segment(strip.rgba, strip.w, strip.h);
  assert.strictEqual(boxes.length, symbols.length,
    `segmented ${boxes.length} glyphs, expected ${symbols.length}`);
  boxes.forEach((b, i) => dm.teach(symbols[i], b.rgba, b.w, b.h));
  return { dm, strip };
}

// ── classifyPlate (occlusion gate) ──────────────────────────────────────────
test('classifyPlate: white-on-dark plate → read', () => {
  const c = makeCrop(60, 24, DARK);
  scatter(c, WHITE, 0.05); // ~5% white ink, like a clean stack plate
  assert.strictEqual(O.classifyPlate(c.rgba, c.w, c.h).status, 'read');
});
test('classifyPlate: green badge overlay → occluded (never reach OCR)', () => {
  const c = makeCrop(60, 24, DARK);
  scatter(c, WHITE, 0.05);
  scatter(c, GREEN, 0.20); // badge intrusion well above 0.12
  const res = O.classifyPlate(c.rgba, c.w, c.h);
  assert.strictEqual(res.status, 'occluded');
  assert.strictEqual(res.reason, 'green-overlay');
});
test('classifyPlate: empty/covered plate (no white ink) → no-read', () => {
  const c = makeCrop(60, 24, DARK); // no white at all
  assert.strictEqual(O.classifyPlate(c.rgba, c.w, c.h).status, 'no-read');
});
test('classifyPlate: clean plate just under green threshold stays read', () => {
  const c = makeCrop(60, 24, DARK);
  scatter(c, WHITE, 0.05);
  scatter(c, GREEN, 0.06); // ~clean p90, below 0.12
  assert.strictEqual(O.classifyPlate(c.rgba, c.w, c.h).status, 'read');
});

// ── parseBB ─────────────────────────────────────────────────────────────────
test('parseBB: variants', () => {
  assert.strictEqual(O.parseBB('95.50 BB'), 95.5);
  assert.strictEqual(O.parseBB('5 BB'), 5);
  assert.strictEqual(O.parseBB('1,234.5 BB'), 1234.5);
  assert.strictEqual(O.parseBB('107.60BB'), 107.6);
  assert.strictEqual(O.parseBB('2.90'), 2.9);
  assert.strictEqual(O.parseBB('garbage'), null);
  assert.strictEqual(O.parseBB(null), null);
});

// ── readNumericBadge ─────────────────────────────────────────────────────────
test('readNumericBadge: occluded color crop is withheld, matcher untouched', () => {
  const { dm } = buildTaughtStrip(['5', '.', '4', '0']);
  const color = makeCrop(60, 24, DARK); scatter(color, GREEN, 0.20);
  const binar = makeCrop(60, 24, [255, 255, 255]); // irrelevant; gate stops first
  const res = O.readNumericBadge(color, binar, dm);
  assert.strictEqual(res.status, 'occluded');
  assert.strictEqual(res.value, null);
});
test('readNumericBadge: clean plate reads the taught strip value', () => {
  const { dm, strip } = buildTaughtStrip(['5', '.', '4', '0']);
  const color = makeCrop(60, 24, DARK); scatter(color, WHITE, 0.05);
  const res = O.readNumericBadge(color, strip, dm);
  assert.strictEqual(res.status, 'read');
  assert.strictEqual(res.value, 5.4);
});
test('readNumericBadge: clean plate but no templates → no-read', () => {
  const dm = new Engine.DigitMatcher('test:empty'); dm.clear();
  const color = makeCrop(60, 24, DARK); scatter(color, WHITE, 0.05);
  const binar = makeCrop(60, 24, [255, 255, 255]);
  const res = O.readNumericBadge(color, binar, dm);
  assert.strictEqual(res.status, 'no-read');
});

// ── detectButton (blob clustering + distance gate) ───────────────────────────
const TEST_SLOTS = { A: { x: 100, y: 75 }, B: { x: 260, y: 75 } };
test('detectButton: disc near a slot → that seat', () => {
  const c = makeCrop(360, 150, DARK);
  disc(c, 100, 75, 16, YELLOW); // size ≈ π·16² ≈ 800, aspect ≈ 1
  const res = O.detectButton(c.rgba, c.w, c.h, TEST_SLOTS);
  assert.strictEqual(res.status, 'read');
  assert.strictEqual(res.seat, 'A');
  assert.ok(res.distance < 5);
});
test('detectButton: disc far from every slot → distance-gate no-read', () => {
  const c = makeCrop(360, 150, DARK);
  disc(c, 320, 140, 16, YELLOW); // ~ (220,65) from slot A → >120
  const res = O.detectButton(c.rgba, c.w, c.h, { A: { x: 60, y: 40 } });
  assert.strictEqual(res.status, 'no-read');
  assert.strictEqual(res.reason, 'distance-gate');
});
test('detectButton: oversized yellow region rejected (banner, not puck)', () => {
  const c = makeCrop(360, 150, DARK);
  rect(c, 40, 20, 90, 90, YELLOW); // size 8100 > 4000
  const res = O.detectButton(c.rgba, c.w, c.h, TEST_SLOTS);
  assert.strictEqual(res.status, 'no-read');
});
test('detectButton: thin yellow bar rejected on aspect', () => {
  const c = makeCrop(360, 150, DARK);
  rect(c, 80, 70, 70, 8, YELLOW); // aspect 8.75 > 1.7
  const res = O.detectButton(c.rgba, c.w, c.h, TEST_SLOTS);
  assert.strictEqual(res.status, 'no-read');
});
test('detectButton: disc beats a far oversized banner (largest disc-like + gate)', () => {
  const c = makeCrop(360, 150, DARK);
  rect(c, 250, 10, 100, 100, YELLOW); // banner, oversized → not disc-like
  disc(c, 100, 75, 16, YELLOW);       // real puck near slot A
  const res = O.detectButton(c.rgba, c.w, c.h, TEST_SLOTS);
  assert.strictEqual(res.status, 'read');
  assert.strictEqual(res.seat, 'A');
});

// ── timerFraction ─────────────────────────────────────────────────────────
test('timerFraction: full green bar ≈ 1.0', () => {
  const c = makeCrop(420, 13, GREEN);
  assert.ok(O.timerFraction(c.rgba, c.w, c.h).fraction > 0.98);
});
test('timerFraction: left half green ≈ 0.5', () => {
  const c = makeCrop(420, 13, DARK);
  rect(c, 0, 0, 210, 13, GREEN);
  const f = O.timerFraction(c.rgba, c.w, c.h).fraction;
  assert.ok(Math.abs(f - 0.5) < 0.02, `got ${f}`);
});
test('timerFraction: empty bar = 0', () => {
  const c = makeCrop(420, 13, DARK);
  assert.strictEqual(O.timerFraction(c.rgba, c.w, c.h).fraction, 0);
});

// ── turnIndicator ────────────────────────────────────────────────────────
test('turnIndicator: red action buttons → heroToAct', () => {
  const c = makeCrop(120, 60, DARK);
  rect(c, 10, 10, 60, 30, RED);
  assert.strictEqual(O.turnIndicator(c.rgba, c.w, c.h).heroToAct, true);
});
test('turnIndicator: no buttons → not hero turn', () => {
  const c = makeCrop(120, 60, DARK);
  assert.strictEqual(O.turnIndicator(c.rgba, c.w, c.h).heroToAct, false);
});

// ── observeFrame (assembler) ─────────────────────────────────────────────────
function fakeFrame(over) {
  const { dm, strip } = buildTaughtStrip(['5', '.', '4', '0']); // reads 5.4
  const cleanColor = makeCrop(60, 24, DARK); scatter(cleanColor, WHITE, 0.05);
  const base = {
    digitMatcher: dm,
    color: {}, binar: {},
    heroBet: 2.5,
    getColor(id) { return this.color[id] || null; },
    getBinarized(id) { return this.binar[id] || null; },
  };
  // every stack + non-hero bet reads 5.4; pot too
  for (const s of R.SEATS) {
    base.color[`stack_${s}`] = cleanColor; base.binar[`stack_${s}`] = strip;
    base.color[`bet_${s}`] = cleanColor; base.binar[`bet_${s}`] = strip;
  }
  base.color['pot'] = cleanColor; base.binar['pot'] = strip;
  // button: disc at the TR slot, in button_scan-local coords
  const btn = makeCrop(R.BUTTON_SCAN_RECT.w, R.BUTTON_SCAN_RECT.h, DARK);
  disc(btn, R.BUTTON_SLOTS.TR.x - R.BUTTON_SCAN_RECT.x, R.BUTTON_SLOTS.TR.y - R.BUTTON_SCAN_RECT.y, 16, YELLOW);
  base.color['button_scan'] = btn;
  // timer full; action panel with red → hero to act
  base.color['timer'] = makeCrop(420, 13, GREEN);
  const ap = makeCrop(120, 60, DARK); rect(ap, 10, 10, 60, 30, RED);
  base.color['action_panel'] = ap;
  return Object.assign(base, over || {});
}

test('observeFrame: assembles tagged reads for every field', () => {
  const f = fakeFrame();
  const obs = O.observeFrame(f);
  for (const s of R.SEATS) assert.strictEqual(obs.stacks[s].status, 'read', `stack ${s}`);
  assert.strictEqual(obs.stacks.TL.value, 5.4);
  assert.strictEqual(obs.pot.value, 5.4);
  assert.strictEqual(obs.button.seat, 'TR');
  assert.strictEqual(obs.button.status, 'read');
  assert.ok(obs.timer.fraction > 0.98);
  assert.strictEqual(obs.turn.heroToAct, true);
});

test('observeFrame: hero (BC) bet comes from known action, NOT OCR (§0.10)', () => {
  // BC bet crop is present and WOULD read 5.4, but heroBet=2.5 must win.
  const f = fakeFrame({ heroBet: 2.5 });
  const obs = O.observeFrame(f);
  assert.strictEqual(obs.bets.BC.value, 2.5);
  assert.strictEqual(obs.bets.BC.source, 'hero-action');
  // a villain bet still reads from OCR
  assert.strictEqual(obs.bets.TL.value, 5.4);
});

test('observeFrame: unknown hero action → BC bet withheld (no fabrication)', () => {
  const f = fakeFrame({ heroBet: null });
  const obs = O.observeFrame(f);
  assert.strictEqual(obs.bets.BC.status, 'no-read');
  assert.strictEqual(obs.bets.BC.value, null);
});

test('observeFrame: occluded stack tags occluded, others still read', () => {
  const f = fakeFrame();
  const occ = makeCrop(60, 24, DARK); scatter(occ, WHITE, 0.05); scatter(occ, GREEN, 0.20);
  f.color['stack_TL'] = occ; // green badge over TL plate
  const obs = O.observeFrame(f);
  assert.strictEqual(obs.stacks.TL.status, 'occluded');
  assert.strictEqual(obs.stacks.TL.value, null);
  assert.strictEqual(obs.stacks.TR.status, 'read'); // complementary plate fine
});

test('observeFrame: missing crops → no-read, never a crash', () => {
  const f = fakeFrame();
  f.color = {}; f.binar = {}; // strip every crop
  const obs = O.observeFrame(f);
  assert.strictEqual(obs.stacks.TL.status, 'no-read');
  assert.strictEqual(obs.button.status, 'no-read');
  assert.strictEqual(obs.timer.status, 'no-read');
});
