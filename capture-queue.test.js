// capture-queue.test.js — smoke tests for the capture queue.
// Run: node capture-queue.test.js
// Exits non-zero if any assertion fails.

const E = require('./engine.js');
const Q = require('./capture-queue.js');

let pass = 0, fail = 0;
const log = (msg) => process.stdout.write(msg + '\n');
function ok(label, cond, detail) {
  if (cond) { pass++; log('  PASS  ' + label); }
  else      { fail++; log('  FAIL  ' + label + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

function makeCellRgba(seed) {
  // 16x24 cell @ 4 bytes/px = 1536 bytes
  const w = 16, h = 24;
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i]     = (x * seed * 3) & 0xff;
      buf[i + 1] = (y * seed * 5) & 0xff;
      buf[i + 2] = ((x + y) * seed * 7) & 0xff;
      buf[i + 3] = 255;
    }
  }
  return { rgba: buf, w, h };
}

function baseRecord(seed) {
  const { rgba, w, h } = makeCellRgba(seed);
  return {
    ts: Date.now() + seed,
    regionId: 'my_Hand',
    cellIndex: 0,
    cellRgba: rgba.buffer.slice(0),
    cellW: w,
    cellH: h,
    sourceFrameJpeg: null,
    sourceFrameW: 1280,
    sourceFrameH: 720,
    bboxInSourceFrame: { x: 0, y: 0, w: 60, h: 80 },
    matcherConfidence: 0,
    matcherTopGuess: null,
    handId: null,
    street: null,
  };
}

// ─── computeBboxInSourceFrame — pure function, defined inline for testing ──
// (Same formula as the helper in live-ocr-test.jsx.)
function computeBboxInSourceFrame(region, i, n, frameW, frameH) {
  const cellPxW = (region.w * frameW) / n;
  return {
    x: region.x * frameW + i * cellPxW,
    y: region.y * frameH,
    w: cellPxW,
    h: region.h * frameH,
  };
}

(async function run() {
  // ─── CAPTURE QUEUE INIT + ENQUEUE + HEAD ───────────────────────────────
  log('\n== CAPTURE QUEUE: INIT + ENQUEUE + HEAD ==');
  Q._resetForTests();
  await Q.init({ adapter: 'memory' });
  await Q.clear();

  ok('head() returns null when empty', (await Q.head()) === null);
  ok('count() === 0 when empty', (await Q.count()) === 0);

  const id1 = await Q.enqueue(baseRecord(1));
  ok('enqueue returns numeric id (1)', id1 === 1);
  const h1 = await Q.head();
  ok('head() returns the only pending record', h1 && h1.id === id1);
  ok('head().status === pending', h1 && h1.status === 'pending');
  ok('head().labelHistory is empty array', h1 && Array.isArray(h1.labelHistory) && h1.labelHistory.length === 0);

  // ─── MARK LABELED ─────────────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: MARK LABELED ==');
  await Q.markLabeled(id1, 'Kh');
  const after = await Q.get(id1);
  ok('markLabeled sets status to labeled', after && after.status === 'labeled');
  ok('markLabeled appends labelHistory entry',
     after && after.labelHistory.length === 1 && after.labelHistory[0].card === 'Kh');
  ok('markLabeled entry action === label',
     after && after.labelHistory[0].action === 'label');
  ok('head() returns null after the only record is labeled',
     (await Q.head()) === null);

  // ─── MARK SKIPPED — re-queues at back ─────────────────────────────────
  log('\n== CAPTURE QUEUE: MARK SKIPPED ==');
  await Q.clear();
  const a = await Q.enqueue({ ...baseRecord(2), ts: 100 });
  const b = await Q.enqueue({ ...baseRecord(3), ts: 200 });
  const c = await Q.enqueue({ ...baseRecord(4), ts: 300 });
  ok('three records enqueued', (await Q.count('pending')) === 3);
  ok('head is the oldest (ts 100)', (await Q.head()).id === a);
  // Wait a hair so Date.now() in markSkipped reads a later ts.
  await new Promise(r => setTimeout(r, 2));
  await Q.markSkipped(a);
  const headAfterSkip = await Q.head();
  ok('after markSkipped, head is next-oldest (ts 200)',
     headAfterSkip && headAfterSkip.id === b, { headAfterSkip });
  const pending = await Q.list({ status: 'pending' });
  ok('skipped record moves to back of pending list',
     pending[pending.length - 1].id === a);

  // ─── UNDO LAST ────────────────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: UNDO LAST ==');
  await Q.clear();
  const r1 = await Q.enqueue({ ...baseRecord(5), ts: 10 });
  const r2 = await Q.enqueue({ ...baseRecord(6), ts: 20 });
  await Q.markLabeled(r1, 'Ah');
  await new Promise(r => setTimeout(r, 2));
  await Q.markLabeled(r2, 'Ks');
  const reverted = await Q.undoLast();
  ok('undoLast returns the reverted record', reverted && reverted.id === r2);
  ok('undoLast sets status back to pending', reverted.status === 'pending');
  ok('undoLast appends an undo entry to labelHistory',
     reverted.labelHistory[reverted.labelHistory.length - 1].action === 'undo');
  ok('head() now returns the un-undone newer record', (await Q.head()).id === r2);

  // ─── COUNT(status) ────────────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: COUNT BY STATUS ==');
  await Q.clear();
  await Q.enqueue(baseRecord(10));
  const trashId = await Q.enqueue(baseRecord(11));
  await Q.markTrashed(trashId);
  const labelId = await Q.enqueue(baseRecord(12));
  await Q.markLabeled(labelId, 'Qh');
  ok('count(pending) === 1', (await Q.count('pending')) === 1);
  ok('count(labeled) === 1', (await Q.count('labeled')) === 1);
  ok('count(trashed) === 1', (await Q.count('trashed')) === 1);
  ok('count() total === 3', (await Q.count()) === 3);

  // ─── isDuplicate ──────────────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: isDuplicate ==');
  await Q.clear();
  const dupBase = makeCellRgba(20);
  await Q.enqueue({
    ts: Date.now(),
    regionId: 'the_Board',
    cellIndex: 0,
    cellRgba: dupBase.rgba.buffer.slice(0),
    cellW: dupBase.w,
    cellH: dupBase.h,
    sourceFrameJpeg: null,
    sourceFrameW: 0, sourceFrameH: 0,
    bboxInSourceFrame: { x:0, y:0, w:0, h:0 },
    matcherConfidence: 0, matcherTopGuess: null,
    handId: null, street: null,
  });
  // Probe with the SAME bytes — hash distance is 0.
  const sameHash = E.hashCardRGBA(dupBase.rgba, dupBase.w, dupBase.h);
  ok('isDuplicate detects byte-identical hash', (await Q.isDuplicate(sameHash, 30)) === true);
  // Probe with a clearly different image (different seed).
  const distinct = makeCellRgba(99);
  const farHash  = E.hashCardRGBA(distinct.rgba, distinct.w, distinct.h);
  ok('isDuplicate rejects a clearly different hash',
     (await Q.isDuplicate(farHash, 5)) === false);

  // ─── dropIfMatcherKnowsNow ────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: dropIfMatcherKnowsNow ==');
  await Q.clear();
  const learned = makeCellRgba(50);
  const unlearned = makeCellRgba(77);
  const matcher = new E.MultiSignatureMatcher('test:queue-drop');
  matcher.clear();
  matcher.teach('Kh', learned.rgba, learned.w, learned.h);
  // Enqueue one record matching the taught template, one not.
  await Q.enqueue({
    ts: Date.now(),
    regionId: 'the_Board', cellIndex: 0,
    cellRgba: learned.rgba.buffer.slice(0),
    cellW: learned.w, cellH: learned.h,
    sourceFrameJpeg: null, sourceFrameW: 0, sourceFrameH: 0,
    bboxInSourceFrame: { x:0, y:0, w:0, h:0 },
    matcherConfidence: 0, matcherTopGuess: null,
    handId: null, street: null,
  });
  await Q.enqueue({
    ts: Date.now(),
    regionId: 'the_Board', cellIndex: 1,
    cellRgba: unlearned.rgba.buffer.slice(0),
    cellW: unlearned.w, cellH: unlearned.h,
    sourceFrameJpeg: null, sourceFrameW: 0, sourceFrameH: 0,
    bboxInSourceFrame: { x:0, y:0, w:0, h:0 },
    matcherConfidence: 0, matcherTopGuess: null,
    handId: null, street: null,
  });
  const before = await Q.count('pending');
  const dropResult = await Q.dropIfMatcherKnowsNow(matcher, 0.85);
  const after2 = await Q.count('pending');
  ok('dropIfMatcherKnowsNow drops 1 record', dropResult.dropped === 1, dropResult);
  ok('pending count drops from 2 to 1', before === 2 && after2 === 1);
  matcher.clear();

  // ─── QUEUE CAP 200 ────────────────────────────────────────────────────
  log('\n== CAPTURE QUEUE: PENDING CAP OF 200 ==');
  await Q.clear();
  for (let i = 0; i < 205; i++) {
    await Q.enqueue({ ...baseRecord(100 + i), ts: 1000 + i });
  }
  const pendingCount = await Q.count('pending');
  ok('after 205 enqueues, pending count clamped to 200', pendingCount === 200,
     { pendingCount });
  const all = await Q.list({ status: 'pending' });
  ok('oldest 5 dropped — earliest ts in queue is 1005',
     all[0] && all[0].ts === 1005,
     { firstTs: all[0] && all[0].ts });

  // ─── computeBboxInSourceFrame ─────────────────────────────────────────
  log('\n== computeBboxInSourceFrame ==');
  // 5-card the_Board region at the right half of a 1280x720 frame.
  const boardRegion = { x: 0.5, y: 0.4, w: 0.5, h: 0.15 };
  const bbox0 = computeBboxInSourceFrame(boardRegion, 0, 5, 1280, 720);
  // Each cell is 1280*0.5/5 = 128 px wide.
  ok('5-card cell 0 x === 640', bbox0.x === 640);
  ok('5-card cell width === 128', bbox0.w === 128);
  ok('5-card cell y === 288 (0.4 * 720)', bbox0.y === 288);
  ok('5-card cell height === 108 (0.15 * 720)', bbox0.h === 108);
  const bbox4 = computeBboxInSourceFrame(boardRegion, 4, 5, 1280, 720);
  ok('5-card cell 4 x === 640 + 4*128 = 1152', bbox4.x === 1152);

  // 2-card my_Hand region at bottom-center.
  const heroRegion = { x: 0.4, y: 0.8, w: 0.2, h: 0.15 };
  const bboxHero0 = computeBboxInSourceFrame(heroRegion, 0, 2, 1280, 720);
  const bboxHero1 = computeBboxInSourceFrame(heroRegion, 1, 2, 1280, 720);
  // Each cell is 1280*0.2/2 = 128 px wide.
  ok('2-card cell 0 x === 512 (0.4 * 1280)', bboxHero0.x === 512);
  ok('2-card cell 1 x === 640 (512 + 128)', bboxHero1.x === 640);
  ok('2-card cell width === 128', bboxHero0.w === 128);

  // Non-zero offsets, small region.
  const tinyRegion = { x: 0.1, y: 0.1, w: 0.4, h: 0.1 };
  const bboxTiny = computeBboxInSourceFrame(tinyRegion, 1, 4, 800, 600);
  // cellPxW = 800*0.4/4 = 80, x = 0.1*800 + 1*80 = 80 + 80 = 160
  ok('tiny region cell 1 x === 160', bboxTiny.x === 160);
  ok('tiny region cell w === 80', bboxTiny.w === 80);
  ok('tiny region y === 60 (0.1 * 600)', bboxTiny.y === 60);

  // ─── SUMMARY ──────────────────────────────────────────────────────────
  log('\n== SUMMARY ==');
  log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT ERROR:', e);
  process.exit(2);
});
