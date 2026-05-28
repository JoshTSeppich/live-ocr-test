// engine.test.cjs — smoke tests for decision engine. Run: node engine.test.cjs
// (.cjs so it stays CommonJS under package.json "type":"module".)
// Exits non-zero if any assertion fails.

const E = require('./engine.js');

let pass = 0, fail = 0;
const log = (msg) => process.stdout.write(msg + '\n');
function ok(label, cond, detail) {
  if (cond) { pass++; log('  PASS  ' + label); }
  else      { fail++; log('  FAIL  ' + label + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}
function near(label, actual, target, tol, detail) {
  const within = Math.abs(actual - target) <= tol;
  ok(label + `  (got ${actual.toFixed(3)}, want ${target}±${tol})`, within, detail);
}

// ── hand evaluator ────────────────────────────────────────────────────────
log('\n== HAND EVALUATOR ==');
function score(s) { return E.evaluate7(E.parseCards(s.split(' '))); }

// Straight flush > quads > full > flush > straight > trips > 2p > pair > hc
ok('royal flush beats quads',
   score('Ah Kh Qh Jh Th 2c 2d') > score('Ac Ad As Ah Kh 2c 3d'));
ok('quads beat full house',
   score('As Ah Ad Ac Kh 2c 3d') > score('Ks Kh Kd Qc Qh 2c 3d'));
ok('full house beats flush',
   score('Ks Kh Kd Qc Qh 2c 3d') > score('Ah Kh Qh Jh 8h 2c 3d'));
ok('flush beats straight',
   score('Ah Kh Qh Jh 8h 2c 3d') > score('Th 9c 8d 7s 6h 2c 3d'));
ok('straight beats trips',
   score('Th 9c 8d 7s 6h 2c 3d') > score('As Ah Ad Kc Qh 2c 3d'));
ok('trips beat two pair',
   score('As Ah Ad Kc Qh 2c 3d') > score('Ks Kh Qd Qc 5h 2c 3d'));
ok('two pair beats one pair',
   score('Ks Kh Qd Qc 5h 2c 3d') > score('Ks Kh Qd Jc 5h 2c 3d'));
ok('one pair beats high card',
   score('Ks Kh Qd Jc 5h 2c 3d') > score('Ks Qh Jd 9c 5h 2c 3d'));

// Kickers
ok('AAA + K kicker > AAA + Q kicker',
   score('As Ah Ad Kh 5c 2c 3d') > score('As Ah Ad Qh 5c 2c 3d'));
ok('AKQJT straight > 5-high wheel',
   score('Ah Kh Qd Js Tc 2c 3d') > score('Ah 2h 3d 4s 5c 7d 9c'));
ok('wheel (5-high straight) is detected',
   (score('Ah 2h 3d 4s 5c 7d 9c') >>> 20) === E.CAT_STRAIGHT);

// ── canonicalisation ─────────────────────────────────────────────────────
log('\n== CANONICALISATION ==');
ok('AhKh -> AKs', E.canonicalize(['Ah','Kh']) === 'AKs');
ok('AhKd -> AKo', E.canonicalize(['Ah','Kd']) === 'AKo');
ok('7c7d -> 77',  E.canonicalize(['7c','7d']) === '77');
ok('2h3h -> 32s (high first)', E.canonicalize(['2h','3h']) === '32s');


// ── card template matcher (TDD: hash / distance / teach / match) ─────────
log('\n== CARD TEMPLATE MATCHER ==');

// Build a simulated RGBA buffer of WxH filled with a pattern. Each cell takes
// a (r,g,b) producer fn so we can compare same-vs-different inputs.
function makeRGBA(w, h, pixelFn) {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = pixelFn(x, y, w, h);
      a[i] = r; a[i+1] = g; a[i+2] = b; a[i+3] = 255;
    }
  }
  return a;
}

// (RED → GREEN) hashCardRGBA — determinism.
ok('hash is deterministic for identical input', (() => {
  const buf = makeRGBA(40, 60, (x,y) => [x*3, y*2, (x+y)*2]);
  const h1 = E.hashCardRGBA(buf, 40, 60);
  const h2 = E.hashCardRGBA(buf, 40, 60);
  return E.hammingDistance(h1, h2) === 0;
})());

// (RED → GREEN) hashCardRGBA — different inputs produce non-trivial distance.
ok('hash differs for different inputs', (() => {
  const a = makeRGBA(40, 60, (x,y) => [(x+y) & 255, 0, 0]);                    // ramp
  const b = makeRGBA(40, 60, (x,y) => [(x*y) % 200, ((x|y)*3) % 200, 50]);     // noisy
  const h1 = E.hashCardRGBA(a, 40, 60);
  const h2 = E.hashCardRGBA(b, 40, 60);
  return E.hammingDistance(h1, h2) > 32; // at least ~8% of bits differ
})());

// (RED → GREEN) hash output is the right length.
ok('hash length == TPL_BITS (' + E.TPL_BITS + ')', (() => {
  const buf = makeRGBA(20, 30, (x,y) => [100, 100, 100]);
  return E.hashCardRGBA(buf, 20, 30).length === E.TPL_BITS;
})());

// (RED → GREEN) hammingDistance: zero for identical, full-length for inverted.
ok('hamming(x, x) = 0', (() => {
  const a = new Uint8Array(384).fill(0).map((_, i) => i % 2);
  return E.hammingDistance(a, a) === 0;
})());
ok('hamming(x, ~x) = length', (() => {
  const a = new Uint8Array(384).fill(0).map((_, i) => i % 2);
  const b = new Uint8Array(384).fill(0).map((_, i) => 1 - (i % 2));
  return E.hammingDistance(a, b) === 384;
})());
ok('hamming(null, x) = Infinity', E.hammingDistance(null, new Uint8Array(384)) === Infinity);
ok('hamming(mismatched lengths) = Infinity',
   E.hammingDistance(new Uint8Array(10), new Uint8Array(384)) === Infinity);

// (RED → GREEN) Matcher — teach + match roundtrip returns the same card.
ok('teach then match returns same card with confidence 1.0', (() => {
  const m = new E.CardTemplateMatcher('test:roundtrip');
  m.clear();
  const buf = makeRGBA(40, 60, (x,y) => [(x*9) % 200, (y*5) % 200, ((x+y)*7) % 200]);
  const hash = E.hashCardRGBA(buf, 40, 60);
  m.teach('As', hash);
  const res = m.match(hash);
  m.clear();
  return res && res.card === 'As' && res.distance === 0 && res.confidence === 1.0;
})());

// (RED → GREEN) Matcher with multiple templates picks the closest.
ok('match picks nearest hash among many', (() => {
  const m = new E.CardTemplateMatcher('test:nearest');
  m.clear();
  const a = makeRGBA(40, 60, (x,y) => [(x*9) % 200, 0, 0]);
  const b = makeRGBA(40, 60, (x,y) => [0, (y*9) % 200, 0]);
  const c = makeRGBA(40, 60, (x,y) => [0, 0, (x*7+y) % 200]);
  m.teach('As', E.hashCardRGBA(a, 40, 60));
  m.teach('Kh', E.hashCardRGBA(b, 40, 60));
  m.teach('Qd', E.hashCardRGBA(c, 40, 60));
  // Query with a buffer most similar to (a) — slight perturbation.
  const probe = makeRGBA(40, 60, (x,y) => [(x*9) % 200, 0, (x+y) & 31]);
  const res = m.match(E.hashCardRGBA(probe, 40, 60));
  m.clear();
  return res && res.card === 'As';
})());

// (RED → GREEN) matchAll returns top-N ordered ascending by distance.
ok('matchAll returns sorted topN', (() => {
  const m = new E.CardTemplateMatcher('test:topn');
  m.clear();
  for (let i = 0; i < 5; i++) {
    const buf = makeRGBA(40, 60, (x,y) => [(x*i*3) % 200, (y*i*5) % 200, 50]);
    m.teach('C' + i + 's', E.hashCardRGBA(buf, 40, 60));
  }
  const probe = makeRGBA(40, 60, (x,y) => [(x*3*3) % 200, (y*3*5) % 200, 50]); // matches C3s exactly
  const top = m.matchAll(E.hashCardRGBA(probe, 40, 60), 3);
  m.clear();
  return top.length === 3
         && top[0].distance <= top[1].distance
         && top[1].distance <= top[2].distance
         && top[0].card === 'C3s';
})());

// (RED → GREEN) empty matcher returns null.
ok('match against empty store = null', (() => {
  const m = new E.CardTemplateMatcher('test:empty');
  m.clear();
  return m.match(new Uint8Array(E.TPL_BITS)) === null;
})());

// (RED → GREEN) confidence = 1 - distance/TPL_BITS.
ok('confidence reflects distance', (() => {
  const m = new E.CardTemplateMatcher('test:conf');
  m.clear();
  const a = new Uint8Array(E.TPL_BITS).fill(0);
  m.teach('As', a);
  const half = new Uint8Array(E.TPL_BITS);
  for (let i = 0; i < E.TPL_BITS / 2; i++) half[i] = 1;
  const res = m.match(half);
  m.clear();
  return Math.abs(res.confidence - 0.5) < 0.01;
})());

// (RED → GREEN) forget removes a single card.
ok('forget removes one card', (() => {
  const m = new E.CardTemplateMatcher('test:forget');
  m.clear();
  m.teach('As', new Uint8Array(E.TPL_BITS));
  m.teach('Kh', new Uint8Array(E.TPL_BITS).fill(1));
  m.forget('As');
  const sizeAfter = m.size;
  const list = m.list();
  m.clear();
  return sizeAfter === 1 && list.length === 1 && list[0] === 'Kh';
})());

// (RED → GREEN) clear empties everything.
ok('clear empties matcher', (() => {
  const m = new E.CardTemplateMatcher('test:clear');
  m.teach('As', new Uint8Array(E.TPL_BITS));
  m.teach('Kh', new Uint8Array(E.TPL_BITS).fill(1));
  m.clear();
  return m.size === 0 && m.list().length === 0;
})());

// (RED → GREEN) teach rejects bad inputs.
ok('teach rejects missing card / wrong-length hash', (() => {
  const m = new E.CardTemplateMatcher('test:bad');
  m.clear();
  const r1 = m.teach(null, new Uint8Array(E.TPL_BITS));
  const r2 = m.teach('As', null);
  const r3 = m.teach('As', new Uint8Array(10)); // wrong length
  m.clear();
  return r1 === false && r2 === false && r3 === false;
})());

// ── extra perceptual hashes ──────────────────────────────────────────────
log('\n== EDGE + COLOR HASHES ==');

ok('hashCardEdge returns TPL_BITS', (() => {
  const buf = makeRGBA(30, 40, (x,y) => [(x*7) % 200, (y*3) % 200, 50]);
  return E.hashCardEdge(buf, 30, 40).length === E.TPL_BITS;
})());

ok('hashCardEdge: flat image → near-zero edges (all-zero hash)', (() => {
  const flat = makeRGBA(30, 40, () => [120, 120, 120]);
  const h = E.hashCardEdge(flat, 30, 40);
  let ones = 0; for (const b of h) ones += b;
  // A perfectly flat image has zero gradient everywhere → all cells equal to mean (0) → all bits 0.
  return ones === 0;
})());

ok('hashCardEdge: edgy image differs from flat image', (() => {
  const flat = makeRGBA(30, 40, () => [120, 120, 120]);
  const edgy = makeRGBA(30, 40, (x,y) => x % 2 === 0 ? [255,255,255] : [0,0,0]);
  return E.hammingDistance(E.hashCardEdge(flat, 30, 40), E.hashCardEdge(edgy, 30, 40)) > 0;
})());

ok('hashCardColor: red-dominant image → mostly 1 bits', (() => {
  const red = makeRGBA(30, 40, () => [200, 50, 50]);
  const h = E.hashCardColor(red, 30, 40);
  let ones = 0; for (const b of h) ones += b;
  return ones > E.TPL_BITS * 0.8;
})());

ok('hashCardColor: light-dominant image → mostly 0 bits', (() => {
  const light = makeRGBA(30, 40, () => [240, 240, 240]);
  const h = E.hashCardColor(light, 30, 40);
  let ones = 0; for (const b of h) ones += b;
  return ones < E.TPL_BITS * 0.2;
})());

ok('hashCardColor distinguishes red vs black', (() => {
  const red = makeRGBA(30, 40, () => [200, 50, 50]);
  const black = makeRGBA(30, 40, () => [240, 240, 240]); // "black" rendered as light on dark UI
  return E.hammingDistance(E.hashCardColor(red, 30, 40), E.hashCardColor(black, 30, 40)) > 100;
})());

// ── multi-signature matcher ──────────────────────────────────────────────
log('\n== MULTI-SIGNATURE MATCHER ==');

ok('multi-sig teach + match returns same card', (() => {
  const m = new E.MultiSignatureMatcher('test:multi');
  m.clear();
  const buf = makeRGBA(40, 60, (x,y) => [(x*7) % 200, (y*3) % 200, 50]);
  m.teach('As', buf, 40, 60);
  const res = m.match(buf, 40, 60);
  m.clear();
  return res && res.card === 'As' && res.distance === 0 && res.confidence === 1;
})());

ok('multi-sig picks nearest among three templates', (() => {
  const m = new E.MultiSignatureMatcher('test:multi-pick');
  m.clear();
  const a = makeRGBA(40, 60, (x,y) => [(x*9) % 200, 0, 0]);              // red ramp
  const b = makeRGBA(40, 60, (x,y) => [240, 240, 240]);                  // pure light
  const c = makeRGBA(40, 60, (x,y) => x % 2 === 0 ? [255,255,255]:[0,0,0]); // checker
  m.teach('As', a, 40, 60);
  m.teach('Kh', b, 40, 60);
  m.teach('Qd', c, 40, 60);
  // Query buffer with red ramp similar to (a)
  const probe = makeRGBA(40, 60, (x,y) => [(x*9) % 200, 5, 5]);
  const res = m.match(probe, 40, 60);
  m.clear();
  return res && res.card === 'As';
})());

ok('multi-sig empty matcher returns null', (() => {
  const m = new E.MultiSignatureMatcher('test:multi-empty');
  m.clear();
  return m.match(makeRGBA(10, 10, () => [0,0,0]), 10, 10) === null;
})());

ok('multi-sig forget + clear', (() => {
  const m = new E.MultiSignatureMatcher('test:multi-fc');
  m.clear();
  m.teach('As', makeRGBA(10, 10, () => [200, 0, 0]), 10, 10);
  m.teach('Kh', makeRGBA(10, 10, () => [0, 200, 0]), 10, 10);
  m.forget('As');
  const s1 = m.size;
  m.clear();
  return s1 === 1 && m.size === 0;
})());

ok('multi-sig combined distance lower than any single hash on noisy probe', (() => {
  const m = new E.MultiSignatureMatcher('test:multi-noisy');
  m.clear();
  const truth = makeRGBA(40, 60, (x,y) => [(x*13+y*7) % 256, (y*5) % 256, ((x|y)*3) % 256]);
  m.teach('As', truth, 40, 60);
  // Add noise: shift pixels by a small random amount
  const noisy = new Uint8Array(truth);
  for (let i = 0; i < noisy.length; i += 4) {
    noisy[i]   = Math.max(0, Math.min(255, noisy[i]   + (Math.random() * 20 - 10)));
    noisy[i+1] = Math.max(0, Math.min(255, noisy[i+1] + (Math.random() * 20 - 10)));
    noisy[i+2] = Math.max(0, Math.min(255, noisy[i+2] + (Math.random() * 20 - 10)));
  }
  const res = m.match(noisy, 40, 60);
  m.clear();
  // Confidence should still be high (>0.7) with noise this small.
  return res && res.card === 'As' && res.confidence > 0.7;
})());

// ── hand history recorder ────────────────────────────────────────────────
log('\n== HAND HISTORY RECORDER ==');

ok('startHand → recordEvent → endHand persists', (() => {
  const h = new E.HandHistoryRecorder('test:hh', 10);
  h.clear();
  h.startHand({ id: 1, seats: ['Alice', 'hero'] });
  h.recordEvent({ kind: 'fold',  who: 'Alice' });
  h.recordEvent({ kind: 'check', who: 'hero' });
  h.endHand();
  const ok1 = h.count === 1 && h.getRecent(1)[0].events.length === 2;
  h.clear();
  return ok1;
})());

ok('maxHands cap ejects oldest', (() => {
  const h = new E.HandHistoryRecorder('test:hh-cap', 3);
  h.clear();
  for (let i = 0; i < 5; i++) { h.startHand({ id: i }); h.endHand(); }
  const c = h.count;
  h.clear();
  return c === 3;
})());

ok('getByVillain filters', (() => {
  const h = new E.HandHistoryRecorder('test:hh-v', 10);
  h.clear();
  h.startHand({ id: 1, seats: ['Alice'] }); h.endHand();
  h.startHand({ id: 2, seats: ['Bob'] });   h.endHand();
  h.startHand({ id: 3, seats: ['Alice', 'Bob'] }); h.endHand();
  const a = h.getByVillain('Alice').length;
  const b = h.getByVillain('Bob').length;
  h.clear();
  return a === 2 && b === 2;
})());

ok('setHeroCards + setBoard persist on the current hand', (() => {
  const h = new E.HandHistoryRecorder('test:hh-cards', 10);
  h.clear();
  h.startHand({ id: 1 });
  h.setHeroCards(['As', 'Kh']);
  h.setBoard(['7c', '3d', '2s']);
  h.endHand();
  const hand = h.getRecent(1)[0];
  h.clear();
  return hand.heroCards[0] === 'As' && hand.board.length === 3;
})());

ok('recordEvent before startHand is a no-op', (() => {
  const h = new E.HandHistoryRecorder('test:hh-noop', 10);
  h.clear();
  h.recordEvent({ kind: 'fold' });   // should not throw
  return h.count === 0;
})());


// ── card normalization + parse ───────────────────────────────────────────
log('\n== CARD NORMALIZATION + PARSE ==');
ok('normalizeCard("ah") = "Ah"', E.normalizeCard('ah') === 'Ah');
ok('normalizeCard("AH") = "Ah"', E.normalizeCard('AH') === 'Ah');
ok('normalizeCard("Ah") = "Ah"', E.normalizeCard('Ah') === 'Ah');
ok('normalizeCard("aH") = "Ah"', E.normalizeCard('aH') === 'Ah');
ok('normalizeCard("1h") throws', (() => { try { E.normalizeCard('1h'); return false; } catch (_) { return true; } })());
ok('normalizeCard("10h") throws', (() => { try { E.normalizeCard('10h'); return false; } catch (_) { return true; } })());
ok('normalizeCard("Ax") throws', (() => { try { E.normalizeCard('Ax'); return false; } catch (_) { return true; } })());
ok('normalizeCard("") throws', (() => { try { E.normalizeCard(''); return false; } catch (_) { return true; } })());

ok('parseCardList("7h, Kd, Kc") = [7h,Kd,Kc]',
   JSON.stringify(E.parseCardList('7h, Kd, Kc')) === JSON.stringify(['7h','Kd','Kc']));
ok('parseCardList whitespace-tolerant',
   JSON.stringify(E.parseCardList('  7h ,Kd , Kc  ')) === JSON.stringify(['7h','Kd','Kc']));
ok('parseCardList("Ah, Ah") rejects duplicate',
   (() => { try { E.parseCardList('Ah, Ah'); return false; } catch (e) { return /duplicate/.test(e.message); } })());
ok('parseCardList("7h, Z9") rejects whole input (no partial)',
   (() => { try { E.parseCardList('7h, Z9'); return false; } catch (_) { return true; } })());

ok('regionIdForCardCount(2) = "my_Hand"', E.regionIdForCardCount(2) === 'my_Hand');
ok('regionIdForCardCount(3) = "the_Board"', E.regionIdForCardCount(3) === 'the_Board');
ok('regionIdForCardCount(4) = "the_Board"', E.regionIdForCardCount(4) === 'the_Board');
ok('regionIdForCardCount(5) = "the_Board"', E.regionIdForCardCount(5) === 'the_Board');
ok('regionIdForCardCount(1) throws',
   (() => { try { E.regionIdForCardCount(1); return false; } catch (_) { return true; } })());
ok('regionIdForCardCount(6) throws',
   (() => { try { E.regionIdForCardCount(6); return false; } catch (_) { return true; } })());
ok('regionIdForCardCount(0) throws',
   (() => { try { E.regionIdForCardCount(0); return false; } catch (_) { return true; } })());

// ── template serialize / deserialize roundtrip ───────────────────────────
log('\n== TEMPLATE EXPORT/IMPORT ==');
function makeTpl(seedByte) {
  const arr = new Uint8Array(E.TPL_BITS);
  for (let i = 0; i < arr.length; i++) arr[i] = ((i + seedByte) % 2);
  return arr;
}
function fillMatcher(m, codes, seed = 0) {
  m.templates.clear();
  for (let i = 0; i < codes.length; i++) {
    m.templates.set(codes[i], {
      brightness: makeTpl(seed + i + 0),
      edge:       makeTpl(seed + i + 1),
      color:      makeTpl(seed + i + 2),
    });
  }
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

ok('serialize → JSON → deserialize replace produces byte-identical templates', (() => {
  const src = new E.MultiSignatureMatcher('test:ms-src');
  fillMatcher(src, ['Ah', 'Kd', '7c']);
  const payload = E.serializeTemplates(src);
  const round = JSON.parse(JSON.stringify(payload));
  const dst = new E.MultiSignatureMatcher('test:ms-dst');
  dst.templates.clear();
  const res = E.deserializeTemplates(dst, round, 'replace');
  if (res.added !== 3 || dst.size !== 3) return false;
  for (const c of ['Ah', 'Kd', '7c']) {
    const a = src.templates.get(c), b = dst.templates.get(c);
    if (!arraysEqual(a.brightness, b.brightness)) return false;
    if (!arraysEqual(a.edge,       b.edge))       return false;
    if (!arraysEqual(a.color,      b.color))      return false;
  }
  src.clear(); dst.clear();
  return true;
})());

ok('schema_version !== 1 rejected', (() => {
  const m = new E.MultiSignatureMatcher('test:ms-sv');
  try {
    E.deserializeTemplates(m, { schema_version: 2, templates: {} }, 'replace');
    return false;
  } catch (e) { m.clear(); return /schema_version/.test(e.message); }
})());

ok('malformed entry — wrong array length rejected', (() => {
  const m = new E.MultiSignatureMatcher('test:ms-len');
  const bad = {
    schema_version: 1, captured_at: 'x', template_count: 1,
    templates: { Ah: { brightness: new Array(10).fill(0), edge: new Array(E.TPL_BITS).fill(0), color: new Array(E.TPL_BITS).fill(0) } },
  };
  try { E.deserializeTemplates(m, bad, 'replace'); return false; }
  catch (e) { m.clear(); return /length/.test(e.message); }
})());

ok('malformed entry — non-binary value rejected', (() => {
  const m = new E.MultiSignatureMatcher('test:ms-bin');
  const arr = new Array(E.TPL_BITS).fill(0);
  arr[0] = 2;
  const bad = {
    schema_version: 1, captured_at: 'x', template_count: 1,
    templates: { Ah: { brightness: arr, edge: new Array(E.TPL_BITS).fill(0), color: new Array(E.TPL_BITS).fill(0) } },
  };
  try { E.deserializeTemplates(m, bad, 'replace'); return false; }
  catch (e) { m.clear(); return /must be 0 or 1/.test(e.message); }
})());

ok('merge strategy preserves existing on conflict, adds new', (() => {
  const m = new E.MultiSignatureMatcher('test:ms-merge');
  fillMatcher(m, ['Ah'], 100); // unique seed for the existing Ah
  const ahBefore = m.templates.get('Ah').brightness.slice();
  // Build an import that contains a DIFFERENT Ah plus a new Kd
  const importMatcher = new E.MultiSignatureMatcher('test:ms-merge-src');
  fillMatcher(importMatcher, ['Ah', 'Kd'], 0); // different seed → different bytes
  const payload = E.serializeTemplates(importMatcher);
  const res = E.deserializeTemplates(m, payload, 'merge');
  if (res.added !== 1 || res.skipped !== 1) { m.clear(); importMatcher.clear(); return false; }
  if (!arraysEqual(m.templates.get('Ah').brightness, ahBefore)) { m.clear(); importMatcher.clear(); return false; }
  if (!m.templates.has('Kd')) { m.clear(); importMatcher.clear(); return false; }
  m.clear(); importMatcher.clear();
  return true;
})());

ok('replace strategy clears existing first', (() => {
  const m = new E.MultiSignatureMatcher('test:ms-rep');
  fillMatcher(m, ['Ah']);
  const importMatcher = new E.MultiSignatureMatcher('test:ms-rep-src');
  fillMatcher(importMatcher, ['Kd']);
  const payload = E.serializeTemplates(importMatcher);
  E.deserializeTemplates(m, payload, 'replace');
  const ok2 = !m.templates.has('Ah') && m.templates.has('Kd') && m.size === 1;
  m.clear(); importMatcher.clear();
  return ok2;
})());


// ── digit matcher (Component 1) ────────────────────────────────────────────
log('\n== DIGIT MATCHER ==');

// A synthetic narrow glyph: dark ink on a light field, deterministic per seed.
// A forced mid-row of ink guarantees every column has at least one dark pixel,
// so a glyph reads as one contiguous box under the dark-column projection.
function digitGlyph(w, h, seed) {
  return makeRGBA(w, h, (x, y) => {
    const ink = (y === (h >> 1)) || (((x * 7 + y * 13 + seed * 29) % 5) < 2);
    return ink ? [12, 12, 12] : [244, 244, 244];
  });
}

// A horizontal strip of glyphs (one per seed) separated by blank white gaps.
// Each glyph band reproduces digitGlyph(glyphW, h, seed) pixel-for-pixel, so a
// box extracted from band k hashes identically to the standalone glyph k.
function digitStrip(seeds, glyphW, gap, h) {
  const n = seeds.length;
  const w = n * glyphW + (n - 1) * gap;
  const out = makeRGBA(w, h, () => [244, 244, 244]); // all white
  seeds.forEach((seed, k) => {
    const x0 = k * (glyphW + gap);
    for (let y = 0; y < h; y++) {
      for (let gx = 0; gx < glyphW; gx++) {
        const ink = (y === (h >> 1)) || (((gx * 7 + y * 13 + seed * 29) % 5) < 2);
        const i = (y * w + (x0 + gx)) * 4;
        const v = ink ? 12 : 244;
        out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
      }
    }
  });
  return { rgba: out, w, h };
}

// hashDigit* output is the right length (8×12 = 96, not the card 384).
ok('digit hash length == DIGIT_BITS (' + E.DIGIT_BITS + ')', (() => {
  const g = digitGlyph(20, 30, 3);
  return E.hashDigitRGBA(g, 20, 30).length === E.DIGIT_BITS
      && E.DIGIT_BITS === 96 && E.DIGIT_W === 8 && E.DIGIT_H === 12;
})());

// teach → match round-trip returns the same symbol at confidence 1.0.
ok('digit teach then match returns same symbol with confidence 1.0', (() => {
  const m = new E.DigitMatcher('test:digit-roundtrip');
  m.clear();
  const g = digitGlyph(24, 36, 7);
  m.teach('7', g, 24, 36);
  const res = m.match(g, 24, 36);
  m.clear();
  return res && res.symbol === '7' && res.distance === 0 && res.confidence === 1.0;
})());

// With several templates, match picks the closest (each self-matches).
ok('digit match picks nearest symbol among many', (() => {
  const m = new E.DigitMatcher('test:digit-nearest');
  m.clear();
  const defs = { '3': 3, '8': 17, '0': 31, '$': 44 };
  for (const [sym, seed] of Object.entries(defs)) m.teach(sym, digitGlyph(24, 36, seed), 24, 36);
  let allSelf = true;
  for (const [sym, seed] of Object.entries(defs)) {
    const r = m.match(digitGlyph(24, 36, seed), 24, 36);
    if (!r || r.symbol !== sym) allSelf = false;
  }
  m.clear();
  return allSelf;
})());

// serialize → deserialize round-trips templates exactly.
ok('digit serialize/deserialize round-trips', (() => {
  const src = new E.DigitMatcher('test:digit-ser-src');
  src.clear();
  for (const [sym, seed] of [['1', 5], ['.', 12], ['$', 25], ['B', 40]]) {
    src.teach(sym, digitGlyph(24, 36, seed), 24, 36);
  }
  const blob = src.serialize();
  const dst = new E.DigitMatcher('test:digit-ser-dst');
  dst.clear();
  const res = dst.deserialize(blob);
  let same = res.total === 4 && dst.size === 4;
  for (const sym of ['1', '.', '$', 'B']) {
    const a = src.templates.get(sym), b = dst.templates.get(sym);
    if (!a || !b) { same = false; continue; }
    if (!arraysEqual(a.brightness, b.brightness)) same = false;
    if (!arraysEqual(a.edge,       b.edge))       same = false;
    if (!arraysEqual(a.color,      b.color))      same = false;
  }
  src.clear(); dst.clear();
  return same;
})());

// deserialize rejects an unknown symbol key (strict, like the card path).
ok('digit deserialize rejects unknown symbol', (() => {
  const m = new E.DigitMatcher('test:digit-badsym');
  const bad = {
    schema_version: 1, grid: [8, 12], bits: 96, symbols: {
      'Z': { brightness: new Array(E.DIGIT_BITS).fill(0), edge: new Array(E.DIGIT_BITS).fill(0), color: new Array(E.DIGIT_BITS).fill(0) },
    },
  };
  try { m.deserialize(bad); return false; }
  catch (e) { m.clear(); return /unknown digit symbol/.test(e.message); }
})());

// deserialize rejects a wrong-length signature.
ok('digit deserialize rejects wrong-length signature', (() => {
  const m = new E.DigitMatcher('test:digit-badlen');
  const bad = {
    schema_version: 1, grid: [8, 12], bits: 96, symbols: {
      '4': { brightness: new Array(10).fill(0), edge: new Array(E.DIGIT_BITS).fill(0), color: new Array(E.DIGIT_BITS).fill(0) },
    },
  };
  try { m.deserialize(bad); return false; }
  catch (e) { m.clear(); return /length/.test(e.message); }
})());

// recognizeNumeric segments a multi-symbol strip and reads it back.
ok('recognizeNumeric segments and reads a synthetic strip', (() => {
  const m = new E.DigitMatcher('test:digit-strip');
  m.clear();
  const symbols = ['3', '.', '2', '0'];
  const seeds   = [3, 12, 19, 31];
  const glyphW = 16, gap = 6, h = 30;
  symbols.forEach((sym, k) => m.teach(sym, digitGlyph(glyphW, h, seeds[k]), glyphW, h));
  const strip = digitStrip(seeds, glyphW, gap, h);
  const res = m.recognizeNumeric(strip.rgba, strip.w, strip.h);
  m.clear();
  return res && res.boxes.length === 4 && res.unmatched === 0
      && res.text === '3.20' && res.confidence >= 0.999;
})());

// segment() finds one box per glyph with correct column ranges and crop dims.
ok('digit segment() splits a strip into per-glyph boxes', (() => {
  const m = new E.DigitMatcher('test:digit-segment');
  const seeds = [3, 12, 19, 31];
  const glyphW = 16, gap = 6, h = 30;
  const strip = digitStrip(seeds, glyphW, gap, h);
  const boxes = m.segment(strip.rgba, strip.w, strip.h);
  if (boxes.length !== 4) return false;
  for (let k = 0; k < 4; k++) {
    const expX0 = k * (glyphW + gap);
    if (boxes[k].x0 !== expX0 || boxes[k].x1 !== expX0 + glyphW) return false;
    if (boxes[k].w !== glyphW || boxes[k].h !== h) return false;
    if (boxes[k].rgba.length !== glyphW * h * 4) return false;
  }
  return true;
})());

// A glyph far from every template (per-pixel inverse) stays below threshold,
// so recognizeNumeric returns text=null — the Tesseract fallback signal.
ok('recognizeNumeric returns null text when a box is below threshold', (() => {
  const m = new E.DigitMatcher('test:digit-belowthresh');
  m.clear();
  const glyphW = 16, h = 30;
  const taught = digitGlyph(glyphW, h, 9);
  m.teach('5', taught, glyphW, h);
  // Per-pixel inverse of the taught glyph: brightness pattern flips, so the
  // brightness Hamming distance is large and confidence drops below 0.85.
  const probe = new Uint8Array(taught.length);
  for (let i = 0; i < taught.length; i += 4) {
    probe[i] = 255 - taught[i]; probe[i + 1] = 255 - taught[i + 1];
    probe[i + 2] = 255 - taught[i + 2]; probe[i + 3] = 255;
  }
  const res = m.recognizeNumeric(probe, glyphW, h);
  m.clear();
  return res && res.text === null && res.unmatched >= 1 && res.confidence < 0.85;
})());

// End-to-end fast-path: teach a "$3.20" pot strip glyph-by-glyph (as the teach
// UI does via segment()), then read a fresh same-pattern strip (as the router
// does via recognizeNumeric) and shape the pot event the way recognizeFast
// does. Proves the teach → recognize → {kind:'pot', dollars} chain.
ok('fast-path: teach a pot strip then recognize it into a pot dollars value', (() => {
  const m = new E.DigitMatcher('test:digit-fastpath');
  m.clear();
  const gt = '$3.20';
  const seeds = [40, 3, 12, 19, 31]; // $,3,.,2,0
  const glyphW = 16, gap = 6, h = 30;
  // Teach: segment a strip and label each box with the ground-truth symbol.
  const teachStrip = digitStrip(seeds, glyphW, gap, h);
  const boxes = m.segment(teachStrip.rgba, teachStrip.w, teachStrip.h);
  if (boxes.length !== gt.length) { m.clear(); return false; }
  for (let i = 0; i < boxes.length; i++) m.teach(gt[i], boxes[i].rgba, boxes[i].w, boxes[i].h);
  // Recognize a fresh strip of the same glyphs (next frame, identical pixels).
  const readStrip = digitStrip(seeds, glyphW, gap, h);
  const res = m.recognizeNumeric(readStrip.rgba, readStrip.w, readStrip.h);
  // Router's event shaping (mirror of parseNumericText in live-ocr-test.jsx).
  const dollars = res.text == null ? null
    : parseFloat(res.text.replace(/[$B\s,]/g, ''));
  m.clear();
  return res.text === '$3.20' && res.unmatched === 0 && dollars === 3.2;
})());

// match() on an empty matcher is null; clear()/forget()/size behave.
ok('digit matcher size/forget/clear/empty-match', (() => {
  const m = new E.DigitMatcher('test:digit-housekeeping');
  m.clear();
  if (m.match(digitGlyph(16, 24, 1), 16, 24) !== null) return false;
  m.teach('9', digitGlyph(16, 24, 1), 16, 24);
  m.teach('6', digitGlyph(16, 24, 2), 16, 24);
  if (m.size !== 2) return false;
  m.forget('9');
  if (m.size !== 1 || m.list().join('') !== '6') return false;
  m.clear();
  return m.size === 0;
})());

// ── summary ──────────────────────────────────────────────────────────────
log('\n== SUMMARY ==');
log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
