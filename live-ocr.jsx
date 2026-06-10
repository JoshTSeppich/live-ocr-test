// live-ocr.jsx — real screen-capture + OCR pipeline.
//
// Flow: getDisplayMedia → hidden <video> → every N ms crop the bottom strip
// of the video (the "last 6 lines" of chat) into an OffscreenCanvas → hand
// it to a Tesseract worker → split the result on \n, dedupe against a recent
// set, regex-match each line against the poker grammar, fire onEvent for
// matches.
//
// Caveats this strips out for the prototype:
//  - No GPU capture (browser doesn't expose it).
//  - No per-line segmentation; the bottom strip + PSM 6 covers the use case.
//  - No font template matcher; Tesseract is "good enough" at 4 Hz.
// A production build would replace step 3 with a CRNN trained on the
// chat font running in onnxruntime-web; the rest of this file is unchanged.

// Card normalisation. Unicode suits should now appear in OCR thanks to the
// expanded whitelist, but Tesseract still mangles them sometimes — particularly
// when colour info is lost. This map handles both the canonical glyphs and the
// most common misreads observed in the chat. Tune as needed.
const SUIT_MAP = {
  '♠':'s', 's':'s', 'S':'s', 'T':'s',           // ♠ often misread as letter T
  '♥':'h', 'h':'h', 'H':'h',                     // ♥ rarely OCR'd at all
  '♦':'d', 'd':'d', 'D':'d', '9':'d', '4':'d',  // ♦ misread as 9 or 4
  '♣':'c', 'c':'c', 'C':'c', '6':'c', '8':'c',  // ♣ misread as 6 or 8
};
// Returns rank+'?' when suit is unknown — the grammar builder picks a
// concrete placeholder after seeing both cards (forces unique suits so the
// engine doesn't think we have a suited combo we don't).
function normalizeCard(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s.length) return null;
  const rank = s[0].toUpperCase();
  if (!'23456789TJQKA'.includes(rank)) return null;
  for (const ch of s.slice(1)) {
    const suit = SUIT_MAP[ch];
    if (suit) return rank + suit;
  }
  // Lenient: rank found, suit unknown. Mark with '?' so the builder can
  // disambiguate later. Engine.parseCard rejects '?', so callers must fix up.
  return rank + '?';
}
function resolveCard(card, suitsTaken) {
  if (!card) return null;
  if (!card.endsWith('?')) return card;
  // Pick a suit that isn't already taken on the same hand.
  for (const s of 'sdhc') {
    if (!suitsTaken.has(s)) { suitsTaken.add(s); return card[0] + s; }
  }
  return card[0] + 's';
}
window.normalizeCard = normalizeCard;
window.resolveCard = resolveCard;

// Tesseract returns `data.words = [{text, bbox:{x0,y0,x1,y1}, ...}, ...]`.
// For each rank-only word, sample the pixels in/around the bbox to determine
// suit color. Red dominant → '♥' (default for red), black dominant → '♠'
// (default for black). Inject the resolved suit into the running text so the
// downstream grammar sees a full "K♠" instead of a bare "K".
function injectColorSuits(data, ctx, scale) {
  let text = data && data.text || '';
  const words = (data && data.words) || [];
  if (!words.length || !text) return text;
  const inv = scale && scale !== 1 ? (1 / scale) : 1;
  for (const w of words) {
    if (!w || !w.text || !w.bbox) continue;
    const tok = w.text.trim();
    if (!tok || tok.length < 1 || tok.length > 3) continue;
    // First char must be a rank.
    if (!'23456789TJQKA'.includes(tok[0].toUpperCase())) continue;
    // Skip if already has a recognised unicode suit char.
    if (/[♠♥♦♣]/.test(tok)) continue;
    // Also skip if the trailing char is a real suit LETTER that SUIT_MAP
    // already handles cleanly (normalizeCard will resolve it).
    if (tok.length === 2 && /^[shdcSHDC]$/.test(tok[1])) continue;
    // Scale OCR bbox back to source-canvas coords for colour sampling.
    const srcBbox = inv === 1 ? w.bbox : {
      x0: w.bbox.x0 * inv, y0: w.bbox.y0 * inv,
      x1: w.bbox.x1 * inv, y1: w.bbox.y1 * inv,
    };
    const { colour, shape } = analyzeSuitGlyph(ctx, srcBbox);
    const suitChar = suitFrom(colour, shape);
    if (!suitChar) continue;
    // Replace JUST this token with rank+inferred-suit, dropping whatever the
    // misread trailing chars were. Anchor on whitespace boundaries.
    const re = new RegExp('(^|\\s)' + escRe(tok) + '(\\s|$)');
    text = text.replace(re, '$1' + tok[0].toUpperCase() + suitChar + '$2');
  }
  return text;
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Returns {colour, shape}. colour: 'red'|'black'|null. shape: max number of
// horizontal "ink runs" found in any row (1 = solid body, 2 = two lobes,
// 3 = three lobes). Used to map (colour, shape) -> {♠, ♥, ♦, ♣}.
function analyzeSuitGlyph(ctx, bbox) {
  const w = Math.max(2, bbox.x1 - bbox.x0);
  const h = Math.max(2, bbox.y1 - bbox.y0);
  // Suit glyph: right half of bbox, extended right to catch what Tesseract
  // excluded. (Suit symbols are often dropped from the rank word's bbox.)
  const sx = Math.max(0, Math.floor(bbox.x0 + w * 0.45));
  const sy = Math.max(0, Math.floor(bbox.y0));
  const sw = Math.max(1, Math.floor(w * 1.4));
  const sh = Math.max(1, h);
  try {
    const img = ctx.getImageData(sx, sy, sw, sh);
    const d = img.data;
    const W = img.width, H = img.height;
    let red = 0, light = 0;
    let maxRuns = 0;
    for (let row = 0; row < H; row++) {
      let runs = 0, prevInk = false;
      for (let col = 0; col < W; col++) {
        const i = (row * W + col) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const isRed   = r > 130 && g < 110 && b < 110;
        const isLight = r > 160 && g > 160 && b > 160;
        const isInk = isRed || isLight;
        if (isRed)   red++;
        if (isLight) light++;
        if (isInk && !prevInk) runs++;
        prevInk = isInk;
      }
      if (runs > maxRuns) maxRuns = runs;
    }
    if (red + light < 10) return { colour: null, shape: 0 };
    const colour = red > light * 1.2 ? 'red' : 'black';
    return { colour, shape: maxRuns };
  } catch (_) { return { colour: null, shape: 0 }; }
}

// (colour, shape) -> suit glyph. 3+ runs = club; 2 runs = heart;
// 1 run + red = diamond; 1 run + black = spade.
function suitFrom(colour, shape) {
  if (!colour) return null;
  if (shape >= 3) return '♣';
  if (shape === 2) return colour === 'red' ? '♥' : '♣';   // shape-2 black is rare; fall back to ♣
  // shape <= 1
  return colour === 'red' ? '♦' : '♠';
}
window.injectColorSuits = injectColorSuits;
window.analyzeSuitGlyph = analyzeSuitGlyph;

// Pull every card-looking token out of a text blob, normalised to "Rs"-form.
// Used for dedicated card regions (no surrounding chat grammar).
function extractCards(text) {
  if (!text) return [];
  const re = new RegExp(CARD_TOK, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const card = normalizeCard(m[0]);
    if (card) out.push(card);
  }
  return out;
}

// Extract "Pot: $X.XX" (or "$X" / "Pot $X") in dollars from board-region text.
function extractPotDollars(text) {
  if (!text) return null;
  const m = text.match(/Pot[:\s]*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? +m[1] : null;
}
window.extractCards = extractCards;
window.extractPotDollars = extractPotDollars;

// Two-line "Your cards / X Y" or "Dealing Flop : / X Y Z" blocks get merged
// before regex parsing so per-line grammar rules can match them.
function preprocessLines(text) {
  return (text || '')
    .replace(/(Your\s+cards?\s*:?)[\t ]*\n[\t ]*([^\n]+)/gi, '$1 $2')
    .replace(/(Dealing\s+(?:Flop|Turn|River)\s*:?)[\t ]*\n[\t ]*([^\n]+)/gi, '$1 $2');
}
window.preprocessOcrText = preprocessLines;

// Card token: rank + optional suit-or-misread character. Optional so we can
// still capture cards when the OCR dropped the suit entirely (e.g., "Q 84").
const CARD_TOK = '[2-9TJQKA][\\u2660\\u2665\\u2666\\u2663ScDhHsdcT4689]?';

function buildHeroCards(raw1, raw2) {
  const a = normalizeCard(raw1);
  const b = normalizeCard(raw2);
  if (!a || !b) return [a, b];
  const taken = new Set();
  if (!a.endsWith('?')) taken.add(a[1]);
  if (!b.endsWith('?')) taken.add(b[1]);
  return [resolveCard(a, taken), resolveCard(b, taken)];
}
function buildBoardCards(rawList) {
  const taken = new Set();
  const out = rawList.map(normalizeCard);
  out.forEach((c) => { if (c && !c.endsWith('?')) taken.add(c[1]); });
  return out.map((c) => resolveCard(c, taken));
}

const POKER_GRAMMAR = [
  // Hero hole cards — drives a fresh hand in the bot's GameState.
  { re: new RegExp('Your\\s+cards?\\s*:?\\s*(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')', 'i'),
    build: (m) => ({ kind: 'hero_cards', cards: buildHeroCards(m[1], m[2]), raw_cards: [m[1], m[2]] }) },
  // Board reveals
  // This client repeats the FULL updated board on each street, not just the
  // new card — Turn line shows 4 cards, River line shows 5.
  { re: new RegExp('Dealing\\s+Flop\\s*:?\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')', 'i'),
    build: (m) => ({ kind: 'board', street: 'flop',  cards: buildBoardCards([m[1], m[2], m[3]]), raw_cards: [m[1], m[2], m[3]] }) },
  { re: new RegExp('Dealing\\s+Turn\\s*:?\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')', 'i'),
    build: (m) => ({ kind: 'board', street: 'turn',  cards: buildBoardCards([m[1], m[2], m[3], m[4]]), raw_cards: [m[1], m[2], m[3], m[4]] }) },
  { re: new RegExp('Dealing\\s+River\\s*:?\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')\\s+(' + CARD_TOK + ')', 'i'),
    build: (m) => ({ kind: 'board', street: 'river', cards: buildBoardCards([m[1], m[2], m[3], m[4], m[5]]), raw_cards: [m[1], m[2], m[3], m[4], m[5]] }) },

  // The visible timestamp/dot prefix from the source UI varies wildly under
  // OCR ("(D)", "©", "[]" etc) — match it loosely, capture the meaningful tail.
  // Chat amounts are dollars-with-decimals (`$0.70`, `$1.76`). The bet/raise/
  // call/win patterns accept either integer or decimal. `amount` is parsed as
  // a Number, so 0.70 not 0.
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+folds\b/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'fold' }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+checks\b/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'check' }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+calls\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'call', amount: +m[3] }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+bets\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'bet', amount: +m[3] }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+raises\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'raise', amount: +m[3], target: +m[3] }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\s+wins\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'win', amount: +m[3] }) },
  // Blind posts. Some clients (Poker Coach AI here) phrase it as
  // "X skips Straddle and posts Big Blind $0.25 with dead $0.10" — allow
  // arbitrary words between the player name and "posts".
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\b.*?\bposts\s+(?:Small\s+Blind|SB)\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'sys', text: 'posts SB', amount: +m[3] }) },
  { re: /(?:\[(\d\d:\d\d:\d\d)\])?\s*\S{0,4}\s*([A-Za-z0-9 ]{3,18}?)\b.*?\bposts\s+(?:Big\s+Blind|BB)\s*\$?(\d+(?:\.\d+)?)/i,
    build: (m) => ({ ts: m[1], who: m[2].trim(), kind: 'sys', text: 'posts BB', amount: +m[3] }) },
  { re: /Hand\s*#(\d{5,})/i,
    build: (m) => ({ kind: 'sys', text: `Hand #${m[1]}` }) },
  { re: /Dealing\s+cards/i,
    build: () => ({ kind: 'sys', text: 'Dealing cards' }) },
];

function parsePokerLine(line) {
  for (const p of POKER_GRAMMAR) {
    const m = line.match(p.re);
    if (m) {
      const out = p.build(m);
      out.raw = line;
      return out;
    }
  }
  return null;
}

// Preprocess a canvas in-place: brightness threshold + inversion so the
// chat's coloured-text-on-dark becomes Tesseract-friendly black-text-on-white.
// We use MAX(R,G,B) — the HSV "Value" channel — instead of luminance because
// pure red (255,0,0) has luminance ~76 (below most thresholds), which would
// drop heart/diamond suits entirely. Max(255,0,0) = 255, so red text survives.
function binarizeInvert(ctx, w, h, threshold) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const v = (r > g ? (r > b ? r : b) : (g > b ? g : b)) > threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

// ── ROI hash-skip cache (Component 2) ───────────────────────────────────────
// Numeric/turn regions whose pixels are byte-identical pass-to-pass don't need
// re-recognition. We detect that with a 64-bit difference hash (dHash) of the
// BINARIZED ocr canvas (not the colour source — colour drift shouldn't force a
// re-read). Only regions whose NAME matches this pattern are skip-eligible;
// chat is never skipped (its content matters line-by-line, every pass).
const SKIP_ELIGIBLE = /pot|stack|bet|to_?call|turn/i;

// dHash64 — downsample `srcCanvas` (w×h) to 9×8 grayscale into the reusable
// `scratch` canvas, then compare each pixel to its right neighbor: 8 diffs per
// row × 8 rows = 64 bits. (The prompt calls this an "8×8 dHash"; the 9th column
// exists only so every row yields 8 horizontal comparisons — canonical dHash.)
function dHash64(srcCanvas, w, h, scratch) {
  const DW = 9, DH = 8;
  const tctx = scratch.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(srcCanvas, 0, 0, w, h, 0, 0, DW, DH);
  const d = tctx.getImageData(0, 0, DW, DH).data;
  const out = new Uint8Array(64);
  let bit = 0;
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW - 1; x++) {
      const i = (y * DW + x) * 4;
      const j = (y * DW + (x + 1)) * 4;
      // Grayscale via max(R,G,B) — the same V channel binarizeInvert thresholds
      // on. On a binarized canvas R=G=B already, so this is exact.
      const gi = d[i] > d[i+1] ? (d[i] > d[i+2] ? d[i] : d[i+2]) : (d[i+1] > d[i+2] ? d[i+1] : d[i+2]);
      const gj = d[j] > d[j+1] ? (d[j] > d[j+2] ? d[j] : d[j+2]) : (d[j+1] > d[j+2] ? d[j+1] : d[j+2]);
      out[bit++] = gi > gj ? 1 : 0;
    }
  }
  return out;
}

// Hamming distance between two 64-bit dHashes. Distance 0 == identical pixels.
function hamming64(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// useLiveOCR — owns the stream + worker lifecycle. Accepts an array of
// `regions`, each {id, name, x, y, w, h} as fractions of the video. Each
// region is OCR'd sequentially per pass and emits events tagged with region.id.
// `preprocess` controls the binarize+invert pipeline; `ocrMaxWidth` caps the
// processed image width (the source canvas always keeps full resolution).
function useLiveOCR({ intervalMs = 250, regions = [], onEvent,
                       preprocess = true, ocrMaxWidth = 1200, binarizeThreshold = 128,
                       recognizeFast, onFrame }) {
  const [status, setStatus] = React.useState('idle'); // idle|connecting|running|error
  const [error, setError]   = React.useState(null);
  const [latency, setLatency] = React.useState(null);          // sum across regions, last pass
  const [regionText, setRegionText]       = React.useState({}); // {id: latest text}
  const [regionLatency, setRegionLatency] = React.useState({}); // {id: ms}
  const [videoSize, setVideoSize] = React.useState(null);
  const [stream, setStream] = React.useState(null);
  const [lastSkipped, setLastSkipped] = React.useState(0);     // cumulative ROI hash-skips
  const [fastPathHits, setFastPathHits] = React.useState(0);   // cumulative DigitMatcher fast-path hits

  const streamRef = React.useRef(null);
  const videoRef  = React.useRef(null);
  const workerRef = React.useRef(null);
  const canvasMapRef = React.useRef(new Map()); // region.id -> OffscreenCanvas
  const seenMapRef   = React.useRef(new Map()); // region.id -> Set<dedupe key>
  const lastHashRef  = React.useRef(new Map()); // region.id -> Uint8Array(64) dHash
  const lastTextRef  = React.useRef(new Map()); // region.id -> last OCR text (reused on skip)
  const regionGeomRef = React.useRef(new Map()); // region.id -> bbox sig (invalidates cache on move)
  const dhashScratchRef = React.useRef(null);   // reusable 9×8 downsample canvas
  const cancelRef = React.useRef(false);

  // Held in refs so the recognize loop reads fresh values without re-binding.
  const onEventRef = React.useRef(onEvent);
  onEventRef.current = onEvent;
  const intervalRef = React.useRef(intervalMs);
  intervalRef.current = intervalMs;
  const regionsRef = React.useRef(regions);
  regionsRef.current = regions;
  const recognizeFastRef = React.useRef(recognizeFast);
  recognizeFastRef.current = recognizeFast;
  // onFrame: a whole-frame consumer (the converter) that needs BOTH the colour
  // source crop and the binarized ocr crop per region from the SAME frame. The
  // per-region recognizeFast path only exposes the binarized crop, which has no
  // colour — feeding it to the converter's occlusion gate would silently disable
  // green-badge detection. onFrame fires once per frame after PHASE 1.
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;
  const preprocessRef = React.useRef(preprocess);
  preprocessRef.current = preprocess;
  const ocrMaxWidthRef = React.useRef(ocrMaxWidth);
  ocrMaxWidthRef.current = ocrMaxWidth;
  const thresholdRef = React.useRef(binarizeThreshold);
  thresholdRef.current = binarizeThreshold;

  const start = React.useCallback(async () => {
    setStatus('connecting'); setError(null);
    try {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract.js not loaded');
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 }, audio: false,
      });
      streamRef.current = stream;
      setStream(stream);
      // When the user revokes share, the track ends — bail cleanly.
      stream.getVideoTracks()[0].addEventListener('ended', () => stop());

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      videoRef.current = video;
      setVideoSize({ w: video.videoWidth, h: video.videoHeight });

      // Use the high-accuracy LSTM model from tessdata_best — ~2x more accurate
      // on small/anti-aliased text than the default "fast" model at the cost
      // of a ~one-time 10MB download (cached in IndexedDB after first load).
      // OEM=1 = LSTM only (no legacy heuristics).
      const worker = await Tesseract.createWorker('eng', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // "Assume a single uniform block of text"
        tessedit_char_whitelist:
          '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$.:#[]()- ♠♥♦♣',
        user_defined_dpi: '300',           // tells the LSTM the text is high-res
        preserve_interword_spaces: '1',    // keeps whitespace intact in output
      });
      workerRef.current = worker;

      cancelRef.current = false;
      setStatus('running');
      loop();
    } catch (e) {
      setError(e.message || String(e));
      setStatus('error');
      stop();
    }
  }, []);

  const stop = React.useCallback(() => {
    cancelRef.current = true;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { workerRef.current?.terminate(); } catch (_) {}
    streamRef.current = null;
    videoRef.current = null;
    workerRef.current = null;
    canvasMapRef.current = new Map();
    seenMapRef.current = new Map();
    lastHashRef.current = new Map();
    lastTextRef.current = new Map();
    regionGeomRef.current = new Map();
    setStream(null);
    setStatus('idle');
    setLatency(null);
    setRegionText({});
    setRegionLatency({});
    setVideoSize(null);
    setLastSkipped(0);
    setFastPathHits(0);
  }, []);

  const loop = async () => {
    while (!cancelRef.current) {
      const video = videoRef.current;
      const worker = workerRef.current;
      if (!video || !worker) break;

      const vw = video.videoWidth, vh = video.videoHeight;
      const regs = regionsRef.current || [];
      if (vw && vh && regs.length) {
        let totalMs = 0;
        let skipped = 0;
        let fastHits = 0;
        const latencyPatch = {};
        const textPatch = {};
        if (!dhashScratchRef.current) dhashScratchRef.current = new OffscreenCanvas(9, 8);

        // ── PHASE 1: draw all source + preprocessed canvases from the SAME
        // video frame, BEFORE any (slow) OCR pass runs. This guarantees that
        // when an event from region A triggers handleEvent and that handler
        // reaches into region B's source canvas (e.g. chat → my_Hand teach),
        // region B's pixels are from the current frame, not the previous one.
        const prepared = [];
        for (const region of regs) {
          if (cancelRef.current) break;
          // Invalidate the hash-skip cache if this region's bbox changed (a
          // move or resize keeps the same id but the pixels are now different,
          // so a stale hash must not be reused as a skip → stale text).
          const geomSig = `${region.x},${region.y},${region.w},${region.h}`;
          if (regionGeomRef.current.get(region.id) !== geomSig) {
            regionGeomRef.current.set(region.id, geomSig);
            lastHashRef.current.delete(region.id);
            lastTextRef.current.delete(region.id);
          }
          const rx = Math.min(1, Math.max(0, region.x || 0));
          const ry = Math.min(1, Math.max(0, region.y || 0));
          const rw = Math.min(1 - rx, Math.max(0.01, region.w || 0));
          const rh = Math.min(1 - ry, Math.max(0.01, region.h || 0));
          const cropX = Math.floor(vw * rx);
          const cropY = Math.floor(vh * ry);
          const cropW = Math.max(1, Math.floor(vw * rw));
          const cropH = Math.max(1, Math.floor(vh * rh));
          const maxW = Math.max(50, ocrMaxWidthRef.current || 1200);
          const targetW = Math.min(cropW, maxW);
          const targetH = Math.max(1, Math.floor(cropH * (targetW / cropW)));
          const scale = targetW / cropW;
          let pair = canvasMapRef.current.get(region.id);
          if (!pair || pair.source.width !== cropW || pair.source.height !== cropH
              || pair.ocr.width !== targetW || pair.ocr.height !== targetH) {
            pair = {
              source: new OffscreenCanvas(cropW, cropH),
              ocr:    new OffscreenCanvas(targetW, targetH),
              scale,
            };
            canvasMapRef.current.set(region.id, pair);
          }
          const srcCtx = pair.source.getContext('2d', { willReadFrequently: true });
          srcCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          const ocrCtx = pair.ocr.getContext('2d', { willReadFrequently: true });
          ocrCtx.drawImage(pair.source, 0, 0, cropW, cropH, 0, 0, targetW, targetH);
          if (preprocessRef.current) {
            binarizeInvert(ocrCtx, targetW, targetH, thresholdRef.current || 128);
          }
          prepared.push({ region, pair, srcCtx, scale });
        }

        // ── onFrame: hand the whole frame to a converter-style consumer BEFORE
        // PHASE 2. getCrops(regionId) returns the colour SOURCE crop and the
        // binarized OCR crop together, same-frame. Colour is needed for the
        // occlusion gate / button blob / timer bar; binarized for the digit
        // matcher. Additive — does not affect the OCR path below.
        if (onFrameRef.current) {
          const pairById = new Map(prepared.map((p) => [p.region.id, p.pair]));
          const getCrops = (regionId) => {
            const pair = pairById.get(regionId);
            if (!pair) return null;
            const sctx = pair.source.getContext('2d', { willReadFrequently: true });
            const simg = sctx.getImageData(0, 0, pair.source.width, pair.source.height);
            const octx = pair.ocr.getContext('2d', { willReadFrequently: true });
            const oimg = octx.getImageData(0, 0, pair.ocr.width, pair.ocr.height);
            return {
              color: { rgba: simg.data, w: pair.source.width, h: pair.source.height },
              binarized: { rgba: oimg.data, w: pair.ocr.width, h: pair.ocr.height },
            };
          };
          try { onFrameRef.current(getCrops, { videoW: vw, videoH: vh }); }
          catch (e) { /* a converter fault must never break the capture loop */ }
        }

        // ── PHASE 2: OCR each region + emit events. By now all source
        // canvases hold same-frame pixels, so any cross-region pixel read
        // from inside an event handler sees a coherent snapshot.
        for (const { region, pair, srcCtx, scale } of prepared) {
          if (cancelRef.current) break;

          // ── ROI hash-skip (Component 2) ──────────────────────────────────
          // For skip-eligible (numeric/turn) regions, dHash the binarized ocr
          // canvas. If it's byte-identical to the last SUCCESSFULLY recognized
          // frame (Hamming distance 0), the pixels didn't change — skip the
          // recognizer entirely this pass and reuse the last emitted value.
          // Chat and card regions never skip. `roiHash` is paired with the
          // cached text on success below, so the two never drift apart.
          let roiHash = null;
          if (SKIP_ELIGIBLE.test(region.name || '')) {
            roiHash = dHash64(pair.ocr, pair.ocr.width, pair.ocr.height, dhashScratchRef.current);
            const prev = lastHashRef.current.get(region.id);
            if (prev && hamming64(roiHash, prev) === 0) {
              skipped++;
              const cachedText = lastTextRef.current.get(region.id);
              if (cachedText != null) textPatch[region.id] = cachedText;
              latencyPatch[region.id] = 0;
              continue;
            }
          }

          // ── Fast-path recognizer router (Component 3) ─────────────────────
          // BEFORE Tesseract, per region. The router (in live-ocr-test.jsx)
          // decides eligibility by region name and runs DigitMatcher on the
          // binarized ocr canvas. It pulls pixels lazily via the thunk so
          // non-eligible regions cost nothing. A truthy result means the region
          // is handled this pass: emit its event (if any), record the hit, pair
          // the dHash + text with the cache so the next static frame skips, and
          // skip Tesseract entirely.
          if (recognizeFastRef.current) {
            const tf0 = performance.now();
            const fast = recognizeFastRef.current(region, () => {
              const c = pair.ocr.getContext('2d', { willReadFrequently: true });
              const im = c.getImageData(0, 0, pair.ocr.width, pair.ocr.height);
              return { rgba: im.data, w: pair.ocr.width, h: pair.ocr.height };
            });
            if (fast) {
              fastHits++;
              if (fast.event) {
                onEventRef.current?.({ ...fast.event, region: region.id, regionName: region.name });
              }
              if (fast.text != null) {
                textPatch[region.id] = fast.text;
                lastTextRef.current.set(region.id, fast.text);
                if (roiHash) lastHashRef.current.set(region.id, roiHash);
              }
              latencyPatch[region.id] = Math.round(performance.now() - tf0);
              continue;
            }
          }

          const t0 = performance.now();
          try {
            const { data } = await worker.recognize(pair.ocr);
            if (cancelRef.current) break;
            const ms = Math.round(performance.now() - t0);
            totalMs += ms;
            latencyPatch[region.id] = ms;

            // ── Color-based suit recovery ─────────────────────────────────
            // Sample colours from the ORIGINAL (colour) source canvas; bboxes
            // come back in OCR-canvas coords, so we pass `scale` for the
            // helper to convert them back.
            const correctedText = injectColorSuits(data, srcCtx, scale);
            textPatch[region.id] = correctedText;
            // Pair the cached text with the hash of the frame it came from, so a
            // future skip reuses a value that actually matches those pixels.
            lastTextRef.current.set(region.id, correctedText);
            if (roiHash) lastHashRef.current.set(region.id, roiHash);

            // Per-region dedupe.
            let seen = seenMapRef.current.get(region.id);
            if (!seen) { seen = new Set(); seenMapRef.current.set(region.id, seen); }

            const merged = preprocessLines(correctedText);
            const lines = merged
              .split('\n').map((l) => l.trim()).filter((l) => l.length >= 2);
            const tail = lines.slice(-8);
            for (const line of tail) {
              const key = line.toLowerCase().replace(/\s+/g, ' ');
              if (seen.has(key)) continue;
              seen.add(key);
              if (seen.size > 300) {
                const keep = [...seen].slice(-150);
                seenMapRef.current.set(region.id, new Set(keep));
              }
              const parsed = parsePokerLine(line);
              if (parsed) {
                onEventRef.current?.({ ...parsed, region: region.id, regionName: region.name, rawLine: line });
              } else {
                // Emit unmatched lines too — useful for small regions that
                // contain non-grammar text like "Your turn" or button labels.
                onEventRef.current?.({ kind: 'region_text', text: line, region: region.id, regionName: region.name, rawLine: line });
              }
            }

            // ── Region-specific extraction (visual hand/board readouts) ──
            // For regions explicitly named after the hand or board, pull cards
            // and pot directly. These are cleaner sources than chat parsing.
            const nm = (region.name || '').toLowerCase();
            const isHandRegion  = /hand/.test(nm);
            const isBoardRegion = /board/.test(nm);
            if (isHandRegion || isBoardRegion) {
              const rawCards = extractCards(correctedText);
              // Resolve any "?" suits — share a taken-set so two unknown-suit
              // cards in the same hand get DIFFERENT placeholder suits (don't
              // accidentally claim a suited combo).
              const taken = new Set();
              rawCards.forEach((c) => { if (c && !c.endsWith('?')) taken.add(c[1]); });
              const cards = rawCards.map((c) => resolveCard(c, taken)).filter(Boolean);
              const sigKey = 'region-cards:' + cards.join('|');
              if (cards.length && !seen.has(sigKey)) {
                seen.add(sigKey);
                if (isHandRegion && cards.length >= 2) {
                  onEventRef.current?.({
                    kind: 'hero_cards',
                    cards: cards.slice(0, 2),
                    raw_cards: rawCards.slice(0, 2),
                    region: region.id, regionName: region.name,
                  });
                }
                if (isBoardRegion && cards.length >= 3) {
                  const street = cards.length >= 5 ? 'river' : cards.length === 4 ? 'turn' : 'flop';
                  onEventRef.current?.({
                    kind: 'board',
                    street,
                    cards: cards.slice(0, 5),
                    raw_cards: rawCards.slice(0, 5),
                    region: region.id, regionName: region.name,
                  });
                }
              }
              if (isBoardRegion) {
                const pot = extractPotDollars(correctedText);
                if (pot != null) {
                  const potSig = 'pot:' + pot.toFixed(2);
                  if (!seen.has(potSig)) {
                    seen.add(potSig);
                    onEventRef.current?.({
                      kind: 'pot', dollars: pot,
                      region: region.id, regionName: region.name,
                    });
                  }
                }
              }
            }
          } catch (e) {
            if (!cancelRef.current) console.warn('OCR pass failed on region', region.id, e);
          }
        }

        if (!cancelRef.current) {
          setLatency(totalMs);
          setRegionLatency((prev) => ({ ...prev, ...latencyPatch }));
          setRegionText((prev) => ({ ...prev, ...textPatch }));
          if (skipped) setLastSkipped((prev) => prev + skipped);
          if (fastHits) setFastPathHits((prev) => prev + fastHits);
        }
      }
      await new Promise((r) => setTimeout(r, intervalRef.current));
    }
  };

  // Clean up on unmount.
  React.useEffect(() => () => stop(), [stop]);

  // Read pixel data for a region's source canvas. Returns
  // { imageData, w, h } or null if not available.
  const getRegionPixels = React.useCallback((regionId) => {
    const pair = canvasMapRef.current.get(regionId);
    if (!pair || !pair.source) return null;
    const w = pair.source.width, h = pair.source.height;
    try {
      const ctx = pair.source.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, w, h);
      return { imageData: img.data, w, h };
    } catch (_) { return null; }
  }, []);

  // Read the BINARIZED ocr canvas for a region (what DigitMatcher matches on),
  // as opposed to getRegionPixels' full-colour source. Same-frame within a pass
  // because Phase 1 binarizes every region's ocr canvas before Phase 2 runs.
  const getRegionOcrPixels = React.useCallback((regionId) => {
    const pair = canvasMapRef.current.get(regionId);
    if (!pair || !pair.ocr) return null;
    const w = pair.ocr.width, h = pair.ocr.height;
    try {
      const ctx = pair.ocr.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, w, h);
      return { imageData: img.data, w, h };
    } catch (_) { return null; }
  }, []);

  return { status, error, latency, regionText, regionLatency, videoSize, stream,
           lastSkipped, fastPathHits, start, stop, getRegionPixels, getRegionOcrPixels };
}

window.useLiveOCR = useLiveOCR;
window.parsePokerLine = parsePokerLine;
