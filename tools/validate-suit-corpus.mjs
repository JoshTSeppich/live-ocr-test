#!/usr/bin/env node
// Exhaustive suit validation: runs the REAL engine.js match() (rank from the
// strip templates + suit from Component 4's pip classifier) over EVERY clean
// card instance in the capture corpus — board cells, occluded hero rears, and
// hero fronts — and reports the confusion matrix + the bar: ZERO confident
// same-colour suit errors. NEW script; requires engine.js, mutates nothing.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const _store = {};
globalThis.localStorage = { getItem: (k) => (k in _store ? _store[k] : null), setItem: (k, v) => { _store[k] = String(v); }, removeItem: (k) => { delete _store[k]; } };
const E = require(path.join(ROOT, 'engine.js'));

const PVA = '/Users/joshuatseppich/projects/poker-vision-analysis/output';
const board = JSON.parse(fs.readFileSync(path.join(PVA, 'board_cards.json')));
const hero = JSON.parse(fs.readFileSync(path.join(PVA, 'hero_hands.json')));
const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'multi-sig-templates.strip.json')));
localStorage.setItem('multi-sig-templates', JSON.stringify(tpl));
const matcher = new E.MultiSignatureMatcher();
const norm = (c) => c.replace('10', 'T');
const RANK_MARGIN = 30;

const _cache = {};
function load(cap, f) {
  const k = cap + '/' + f;
  if (!_cache[k]) _cache[k] = PNG.sync.read(fs.readFileSync(path.join(cap, f)));
  return _cache[k];
}
function cardTop(png, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    let bright = 0;
    for (let xx = x; xx < x + w; xx++) { const i = (yy * png.width + xx) * 4; if ((png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 > 150) bright++; }
    if (bright > 0.5 * w) return yy;
  }
  return y;
}
function cropStrip(png, left, top) {
  const W = 55, H = 130, out = new Uint8Array(W * H * 4);
  for (let yy = 0; yy < H; yy++) { const s = ((top + yy) * png.width + left) * 4; out.set(png.data.subarray(s, s + W * 4), yy * W * 4); }
  return { rgba: out, w: W, h: H };
}

const inst = [];
for (const fr of board.boards) for (const c of fr.cards) {
  const code = norm(c.card); const [bx, by, , bh] = c.bbox; const bodyL = bx + RANK_MARGIN;
  inst.push({ code, layout: 'board', cap: board.capture_dir, frame: fr.frame, left: bodyL, by, bh });
}
for (const hd of hero.hands) {
  if (hd.cards.length !== 2) continue;
  const ri = hd.cards[0].bbox[2] < hd.cards[1].bbox[2] ? 0 : 1;
  [[ri, 'rear'], [1 - ri, 'front']].forEach(([idx, layout]) => {
    const c = hd.cards[idx]; const [x, y, , h] = c.bbox;
    inst.push({ code: norm(c.card), layout, cap: hero.capture_dir, frame: hd.frame, left: x, by: y, bh: h });
  });
}

const SUITS = ['c', 'd', 'h', 's'];
const conf = {}; for (const a of SUITS) { conf[a] = {}; for (const b of SUITS) conf[a][b] = 0; }
let rankOK = 0, colorOK = 0, suitConfOK = 0, suitConfWrong = 0, abstain = 0, total = 0;
const confidentWrong = [], sameColorAbstainByLayout = {};
const ink = (s) => (s === 'h' || s === 'd' ? 'red' : 'black');
for (const it of inst) {
  const png = load(it.cap, it.frame);
  const top = cardTop(png, it.left, it.by, 55, it.bh);
  const { rgba, w, h } = cropStrip(png, it.left, top);
  const res = matcher.match(rgba, w, h);
  total++;
  if (!res) { abstain++; continue; }
  const truthRank = it.code[0], truthSuit = it.code[1];
  if (res.card[0] === truthRank) rankOK++;
  if (ink(res.card[1]) === ink(truthSuit)) colorOK++;
  if (res.suitConfident) {
    conf[truthSuit][res.suit] = (conf[truthSuit][res.suit] || 0) + 1;
    if (res.suit === truthSuit) suitConfOK++;
    else { suitConfWrong++; confidentWrong.push({ truth: it.code, got: res.card, layout: it.layout, frame: it.frame, margin: res.suitMargin }); }
  } else {
    abstain++;
    sameColorAbstainByLayout[it.layout] = (sameColorAbstainByLayout[it.layout] || 0) + 1;
  }
}

console.log(`instances: ${total}  (board ${inst.filter(i => i.layout === 'board').length}, rear ${inst.filter(i => i.layout === 'rear').length}, front ${inst.filter(i => i.layout === 'front').length})`);
console.log(`rank correct:  ${rankOK}/${total} (${(100 * rankOK / total).toFixed(1)}%)`);
console.log(`color correct: ${colorOK}/${total} (${(100 * colorOK / total).toFixed(1)}%)`);
console.log(`\nSUIT confusion matrix (rows = truth, cols = confident prediction; abstains excluded):`);
console.log('      ' + SUITS.map((s) => '  ' + s).join(''));
for (const t of SUITS) console.log(`  ${t}  ` + SUITS.map((p) => String(conf[t][p]).padStart(3)).join(''));
console.log(`\nconfident suit reads: ${suitConfOK + suitConfWrong}  correct ${suitConfOK}  WRONG ${suitConfWrong}`);
console.log(`abstain (2-way) total: ${abstain}  rate ${(100 * abstain / total).toFixed(1)}%  by layout: ${JSON.stringify(sameColorAbstainByLayout)}`);
console.log(`\n*** BAR: zero confident same-colour suit errors -> ${suitConfWrong === 0 ? 'PASS ✓' : 'FAIL ✗'} ***`);
if (confidentWrong.length) console.log('CONFIDENT WRONG:', JSON.stringify(confidentWrong.slice(0, 20), null, 1));
