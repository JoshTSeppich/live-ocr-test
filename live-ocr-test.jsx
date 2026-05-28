// live-ocr-test.jsx — diagnostic harness UI for useLiveOCR.
// Renders a "digital twin" of what the OCR / template-matching pipeline
// currently believes the table looks like, side-by-side with the live video
// feed for ground-truth verification. No decision logic; manual fire only.

// Streets we recognise in chat → tag postflop events so the tracker
// distinguishes preflop AF (= PFR%) from postflop AF.
function detectStreet(line) {
  const l = (line || '').toLowerCase();
  if (/\bflop\b/.test(l)) return 'flop';
  if (/\bturn\b/.test(l)) return 'turn';
  if (/\briver\b/.test(l)) return 'river';
  return null;
}

function fmtTs(ts) {
  if (ts) return ts;
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

const REGION_COLORS = ['#3dd1c7', '#ff9500', '#bb6bff', '#3df0a0'];
const MAX_REGIONS = 4;
const DEFAULT_REGIONS = [
  // Backward-compatible default: bottom 45%, full width — the original chat strip.
  { id: 'chat', name: 'chat', color: REGION_COLORS[0], x: 0, y: 0.55, w: 1, h: 0.45 },
];

function loadRegions() {
  try {
    const raw = localStorage.getItem('ocr-regions');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, MAX_REGIONS);
    }
  } catch (_) {}
  return DEFAULT_REGIONS;
}

// ─── twin state reducer ───────────────────────────────────────────────────
// Pure state derived from chat-grammar events. The only source of truth the
// DigitalTwinView reads. Re-rendered only on event arrival (NOT every OCR pass).

const INITIAL_TWIN = {
  handId: null,
  street: 'preflop',
  pot: 0,
  potFromOcr: false,
  board: [],
  heroCards: null,
  heroUsername: 'RoloDango',
  actionOnHero: false,
  actionHistory: [],
  seats: new Map(),
  activeSeatsThisHand: [],
};

function ensureSeat(state, name, isHero) {
  if (!name) return state;
  if (state.seats.has(name)) return state;
  const seats = new Map(state.seats);
  seats.set(name, { name, isHero: !!isHero, stack: null,
                    folded: false, isSB: false, isBB: false, isButton: false });
  return { ...state, seats };
}
function markSeat(state, name, patch) {
  if (!name || !state.seats.has(name)) return state;
  const seats = new Map(state.seats);
  seats.set(name, { ...seats.get(name), ...patch });
  return { ...state, seats };
}
function noteActive(state, name) {
  if (!name || state.activeSeatsThisHand.includes(name)) return state;
  return { ...state, activeSeatsThisHand: [...state.activeSeatsThisHand, name] };
}
function deriveButton(state) {
  const active = state.activeSeatsThisHand;
  if (active.length < 2) return state;
  const sbName = active.find((n) => state.seats.get(n)?.isSB);
  const bbName = active.find((n) => state.seats.get(n)?.isBB);
  if (!sbName || !bbName) return state;
  // Clear any prior isButton flags before re-marking.
  let next = { ...state, seats: new Map(state.seats) };
  for (const [k, v] of next.seats) if (v.isButton) next.seats.set(k, { ...v, isButton: false });
  let buttonName;
  if (active.length === 2) {
    buttonName = sbName; // heads-up convention
  } else {
    const sbIdx = active.indexOf(sbName);
    buttonName = active[(sbIdx - 1 + active.length) % active.length];
  }
  const s = next.seats.get(buttonName);
  if (s) next.seats.set(buttonName, { ...s, isButton: true });
  return next;
}
function streetFromBoard(n) {
  if (n >= 5) return 'river';
  if (n === 4) return 'turn';
  if (n === 3) return 'flop';
  return 'preflop';
}
function pushHistory(state, entry) {
  return { ...state, actionHistory: state.actionHistory.concat([entry]) };
}
function fmtAmount(n) {
  if (n == null) return '';
  const f = +n;
  if (Number.isInteger(f)) return `$${f}`;
  return `$${f.toFixed(2)}`;
}

// Parse a recognized numeric glyph string ("$3.20", "1,250", "116.4B") into a
// dollar Number. Strips currency/BB marks, treats comma as a thousands sep,
// keeps the decimal point. Returns null if nothing numeric is left. (BB
// conversion is deliberately NOT done here — it belongs at MOUTH_TABLE when
// bot_link.js is built, per ARCHITECTURE.md §6; the v1 emit path is dollars.)
function parseNumericText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[$B\s,]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Reduce an OCR'd ground-truth string to the closed digit/symbol alphabet, so
// it can be aligned 1:1 with segmented glyph boxes when teaching.
function cleanDigitGroundTruth(text) {
  return String(text || '').replace(/[^0-9.,$B]/g, '');
}
const SUIT_GLYPH = { h: '♥', d: '♦', c: '♣', s: '♠' };

function fmtBoardGlyphs(cards) {
  return cards.map((c) => c[0] + (SUIT_GLYPH[c[1]] || '?')).join(' ');
}

// Snapshot the user-visible <video> as JPEG. Returns {blob,w,h} or null.
// Called from handleEvent's capture branch; fire-and-forget.
async function snapshotSourceFrame(videoEl) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').drawImage(videoEl, 0, 0, w, h);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      return { blob, w, h };
    } catch (_) { /* fall through to <canvas> */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(
    (blob) => resolve(blob ? { blob, w, h } : null),
    'image/jpeg', 0.7));
}

// Compute the source-frame pixel-space bbox for cell `i` of a region split
// into `n` equal horizontal cells. region.x/y/w/h are 0..1 fractions.
function computeBboxInSourceFrame(region, i, n, frameW, frameH) {
  const cellPxW = (region.w * frameW) / n;
  return {
    x: region.x * frameW + i * cellPxW,
    y: region.y * frameH,
    w: cellPxW,
    h: region.h * frameH,
  };
}

function applyEventToTwin(state, parsed) {
  const ts = fmtTs(parsed.ts);
  const heroName = state.heroUsername;

  // sys: hand reset OR blind posts
  if (parsed.kind === 'sys') {
    const text = parsed.text || '';
    const handMatch = /Hand\s*#(\d+)/i.exec(text);
    const isHandStart = !!handMatch || /Dealing\s+cards/i.test(text);
    if (isHandStart) {
      const seats = new Map();
      for (const [k, v] of state.seats) {
        seats.set(k, { ...v, folded: false, isSB: false, isBB: false, isButton: false });
      }
      return {
        ...state,
        handId: handMatch ? handMatch[1] : null,
        pot: 0, potFromOcr: false,
        board: [], heroCards: null,
        actionHistory: [],
        activeSeatsThisHand: [],
        seats,
        street: 'preflop',
      };
    }
    // posts SB / posts BB
    if (parsed.who) {
      const isSB = /post.*(small|SB)/i.test(text);
      const isBB = /post.*(big|BB)/i.test(text);
      let next = ensureSeat(state, parsed.who, parsed.who === heroName);
      next = noteActive(next, parsed.who);
      if (isSB)      next = markSeat(next, parsed.who, { isSB: true });
      else if (isBB) next = markSeat(next, parsed.who, { isBB: true });
      next = deriveButton(next);
      const verb = isSB ? 'posts SB' : isBB ? 'posts BB' : 'sys';
      next = pushHistory(next, { ts, who: parsed.who, kind: 'sys', amount: parsed.amount || null,
        text: `[${ts}]  ${parsed.who}  ${verb}${parsed.amount ? ' ' + fmtAmount(parsed.amount) : ''}` });
      return next;
    }
    // generic sys event with no who — log only
    return pushHistory(state, { ts, who: null, kind: 'sys', amount: null,
      text: `[${ts}]  ${text || 'sys'}` });
  }

  // hero_cards
  if (parsed.kind === 'hero_cards' && parsed.cards) {
    let next = { ...state, heroCards: parsed.cards.slice() };
    next = ensureSeat(next, heroName, true);
    next = pushHistory(next, { ts, who: heroName, kind: 'sys', amount: null,
      text: `[${ts}]  *hero*  ${fmtBoardGlyphs(parsed.cards)}` });
    return next;
  }

  // board
  if (parsed.kind === 'board' && parsed.cards) {
    const cards = parsed.cards.slice();
    const street = streetFromBoard(cards.length);
    let next = { ...state, board: cards, street };
    const label = street === 'river' ? '*river*' : street === 'turn' ? '*turn*' : '*flop*';
    next = pushHistory(next, { ts, who: null, kind: 'board', amount: null,
      text: `[${ts}]  ${label}   ${fmtBoardGlyphs(cards)}` });
    return next;
  }

  // pot from OCR
  if (parsed.kind === 'pot' && parsed.dollars != null) {
    return { ...state, pot: +parsed.dollars, potFromOcr: true };
  }

  // chat actions: fold/check/call/bet/raise/win
  const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'win'];
  if (ACTIONS.includes(parsed.kind)) {
    const who = parsed.who;
    const isHero = who === heroName;
    let next = ensureSeat(state, who, isHero);
    next = noteActive(next, who);
    if (parsed.kind === 'fold') next = markSeat(next, who, { folded: true });
    if (!next.potFromOcr) {
      if (parsed.amount != null && (parsed.kind === 'call' || parsed.kind === 'bet' || parsed.kind === 'raise')) {
        next = { ...next, pot: +(next.pot + Number(parsed.amount)).toFixed(2) };
      }
    }
    let verb = parsed.kind;
    if (parsed.kind === 'raise' && parsed.target != null) verb = `raises to ${fmtAmount(parsed.target)}`;
    else if (parsed.kind === 'win')   verb = `wins ${fmtAmount(parsed.amount)}`;
    else if (parsed.amount != null)   verb = `${parsed.kind}s ${fmtAmount(parsed.amount)}`;
    else                              verb = `${parsed.kind}s`;
    next = pushHistory(next, { ts, who, kind: parsed.kind, amount: parsed.amount || null,
      text: `[${ts}]  ${who || '?'}  ${verb}` });
    return next;
  }

  return state;
}

function LiveOCRTest() {
  const [interval, setIntervalMs] = React.useState(300);
  const [regions, setRegions] = React.useState(loadRegions);
  const [preprocess, setPreprocess] = React.useState(true);
  const [binarizeThreshold, setBinarizeThreshold] = React.useState(128);
  const [ocrMaxWidth, setOcrMaxWidth] = React.useState(1800);
  const [events, setEvents] = React.useState([]);
  const [framesProcessed, setFramesProcessed] = React.useState(0);
  const startTimeRef = React.useRef(null);

  // Persist region edits across reloads.
  React.useEffect(() => {
    try { localStorage.setItem('ocr-regions', JSON.stringify(regions)); } catch (_) {}
  }, [regions]);

  // ── Twin state — what the OCR believes the table looks like ───────────
  const [twin, setTwin] = React.useState(INITIAL_TWIN);
  const setHeroUsername = React.useCallback((name) => {
    setTwin((s) => ({ ...s, heroUsername: name }));
  }, []);

  // Turn-detector regex (drives twin.actionOnHero).
  const [turnPattern, setTurnPattern] = React.useState(
    '\\b(fold|check|call|raise|bet|all[\\s-]?in)\\b');

  // Daemon URL config — surfaced in ManualFirePanel.
  const [daemonUrl, setDaemonUrl] = React.useState('http://127.0.0.1:9001');

  // Card template matcher (untouched chat-OCR auto-teach pipeline).
  const matcherRef = React.useRef(null);
  if (!matcherRef.current && typeof window !== 'undefined' && window.PokerEngine) {
    matcherRef.current = new window.PokerEngine.MultiSignatureMatcher();
  }
  const [templateCount, setTemplateCount] = React.useState(() =>
    matcherRef.current ? matcherRef.current.size : 0);
  const [teachAttempts, setTeachAttempts] = React.useState(0);
  const [lastTeachAt, setLastTeachAt] = React.useState(0);

  // Digit/symbol matcher — fast pre-Tesseract path for numeric readouts.
  // Separate from the card matcher; persists under its own localStorage key.
  const digitMatcherRef = React.useRef(null);
  if (!digitMatcherRef.current && typeof window !== 'undefined' && window.PokerEngine
      && window.PokerEngine.DigitMatcher) {
    digitMatcherRef.current = new window.PokerEngine.DigitMatcher();
  }
  // Teach-time pixels per symbol (in-memory), so the smoke test can re-match a
  // symbol against the exact glyph it was taught from. Not persisted.
  const digitTeachPixelsRef = React.useRef(new Map());
  const [digitCount, setDigitCount] = React.useState(() =>
    digitMatcherRef.current ? digitMatcherRef.current.size : 0);
  // Per-region last-emitted numeric value — suppresses re-emitting an unchanged
  // reading every pass (anti-aliasing jitter the dHash didn't absorb).
  const digitLastEmitRef = React.useRef(new Map());

  // Hand history — persists chat-grammar events to localStorage.
  const historyRef = React.useRef(null);
  if (!historyRef.current && typeof window !== 'undefined' && window.PokerEngine) {
    historyRef.current = new window.PokerEngine.HandHistoryRecorder();
  }

  // Toast for new templates learned (kept).
  const reached52Ref = React.useRef(templateCount >= 52);
  const prevTemplateCountRef = React.useRef(templateCount);
  const [learnedToast, setLearnedToast] = React.useState(null);
  React.useEffect(() => {
    const prev = prevTemplateCountRef.current;
    if (templateCount > prev) {
      const delta = templateCount - prev;
      const toastId = Date.now();
      setLearnedToast({ delta, total: templateCount, id: toastId });
      const t = setTimeout(() => {
        setLearnedToast((cur) => (cur && cur.id === toastId) ? null : cur);
      }, 3500);
      prevTemplateCountRef.current = templateCount;
      return () => clearTimeout(t);
    }
    prevTemplateCountRef.current = templateCount;
  }, [templateCount]);
  React.useEffect(() => {
    if (templateCount >= 52 && !reached52Ref.current) {
      reached52Ref.current = true;
      console.log('%c[TEMPLATES] ALL 52 CARDS CAPTURED', 'color:#3df0a0;font-weight:700;font-size:14px');
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Card templates complete', {
            body: 'All 52 cards captured. OCR no longer needed for card recognition.',
          });
        }
      } catch (_) {}
    }
  }, [templateCount]);

  // ── Capture queue infrastructure ────────────────────────────────────
  // videoElRef gives snapshotSourceFrame a hook into the visible <video>.
  const videoElRef = React.useRef(null);
  // Mirror twin.handId / twin.street into a ref so handleEvent's capture
  // closure can stamp records without bloating handleEvent's deps array.
  const twinSnapshotRef = React.useRef({ handId: null, street: null });
  React.useEffect(() => {
    twinSnapshotRef.current = { handId: twin.handId, street: twin.street };
  }, [twin.handId, twin.street]);
  // Bumped after each enqueue / label action → TeachZone re-fetches head.
  const [queueTick, setQueueTick] = React.useState(0);
  // Modal/popover toggles for the new footer buttons.
  const [showRawOcr,   setShowRawOcr]   = React.useState(false);
  const [showEvents,   setShowEvents]   = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  // Footer missing-chip filter → TeachZone narrows to captures matching topGuess.
  const [filterCard, setFilterCard] = React.useState(null);
  // Transient toast (used both for "+N learned" and "N auto-resolved").
  const [transientToast, setTransientToast] = React.useState(null);
  const showToast = React.useCallback((text, durationMs = 2800) => {
    const id = Date.now() + Math.random();
    setTransientToast({ id, text });
    setTimeout(() => {
      setTransientToast((cur) => (cur && cur.id === id) ? null : cur);
    }, durationMs);
  }, []);
  // Init CaptureQueue once on mount.
  React.useEffect(() => {
    if (typeof window !== 'undefined' && window.CaptureQueue) {
      window.CaptureQueue.init().catch((e) =>
        console.warn('[capture-queue] init failed:', e));
    }
  }, []);

  const handleEvent = React.useCallback((parsed) => {
    setEvents((prev) => prev.concat([{
      id: `${Date.now()}-${Math.random()}`,
      ts: fmtTs(parsed.ts),
      ...parsed,
    }]).slice(-200));

    // ── Turn-region detector → twin.actionOnHero ────────────────────────
    if (parsed.region === 'turn' || parsed.regionName === 'turn') {
      const text = (parsed.text || parsed.rawLine || '').toLowerCase();
      try {
        const re = new RegExp(turnPattern, 'i');
        const isOn = re.test(text);
        setTwin((s) => s.actionOnHero === isOn ? s : { ...s, actionOnHero: isOn });
      } catch (_) { /* invalid regex — ignore */ }
    }

    // ── Card template TEACH from chat ground truth ──────────────────────
    // (UNCHANGED from the chat-OCR auto-teach pipeline — verbatim.)
    const fromCardsRegion = /hand|board/i.test(parsed.regionName || '');
    const allSuitsReal = parsed.raw_cards && parsed.raw_cards.every((rc) => /[♠♥♦♣]/.test(rc));

    if (parsed.kind === 'hero_cards' && parsed.cards && parsed.cards.length === 2
        && !fromCardsRegion && allSuitsReal) {
      const handRegion = regions.find((r) => /hand/i.test(r.name || ''));
      if (handRegion && matcherRef.current) {
        const cells = cardCellsFromRegion(handRegion.id, 2);
        if (cells && cells.length === 2) {
          let taught = 0;
          for (let i = 0; i < 2; i++) {
            const card = parsed.cards[i];
            if (!card || card.length < 2 || !/[shdc]/.test(card[1])) continue;
            if (matcherRef.current.teach(card, cells[i].imageData, cells[i].w, cells[i].h)) taught++;
          }
          if (taught) {
            setTemplateCount(matcherRef.current.size);
            setTeachAttempts((n) => n + taught);
            setLastTeachAt(Date.now());
          }
        }
      }
    }
    if (parsed.kind === 'board' && parsed.cards && parsed.cards.length >= 3
        && !fromCardsRegion && allSuitsReal) {
      const boardRegion = regions.find((r) => /board/i.test(r.name || ''));
      if (boardRegion && matcherRef.current) {
        const n = parsed.cards.length;
        const cells = cardCellsFromRegion(boardRegion.id, n);
        if (cells && cells.length === n) {
          let taught = 0;
          for (let i = 0; i < n; i++) {
            const card = parsed.cards[i];
            if (!card || card.length < 2 || !/[shdc]/.test(card[1])) continue;
            if (matcherRef.current.teach(card, cells[i].imageData, cells[i].w, cells[i].h)) taught++;
          }
          if (taught) {
            setTemplateCount(matcherRef.current.size);
            setTeachAttempts((n) => n + taught);
            setLastTeachAt(Date.now());
          }
        }
      }
    }

    // ── Card template MATCH from my_Hand region ─────────────────────────
    if (parsed.kind === 'hero_cards' && parsed.region && /hand/i.test(parsed.regionName || '')
        && matcherRef.current && matcherRef.current.size > 0) {
      const cells = cardCellsFromRegion(parsed.region, 2);
      if (cells && cells.length === 2) {
        const matches = cells.map((c) => matcherRef.current.match(c.imageData, c.w, c.h));
        const allConfident = matches.every((m) => m && m.confidence >= 0.75);
        if (allConfident) {
          parsed.cards = matches.map((m) => m.card);
          parsed.fromTemplate = true;
          parsed.templateConfidence = matches.reduce((acc, m) => Math.min(acc, m.confidence), 1);
        }
      }
    }
    if (parsed.kind === 'board' && parsed.region && /board/i.test(parsed.regionName || '')
        && parsed.cards && parsed.cards.length >= 3
        && matcherRef.current && matcherRef.current.size > 0) {
      const n = parsed.cards.length;
      const cells = cardCellsFromRegion(parsed.region, n);
      if (cells && cells.length === n) {
        const matches = cells.map((c) => matcherRef.current.match(c.imageData, c.w, c.h));
        const allConfident = matches.every((m) => m && m.confidence >= 0.75);
        if (allConfident) {
          parsed.cards = matches.map((m) => m.card);
          parsed.fromTemplate = true;
          parsed.templateConfidence = matches.reduce((acc, m) => Math.min(acc, m.confidence), 1);
        }
      }
    }
    if ((parsed.kind === 'hero_cards' || parsed.kind === 'board') && !fromCardsRegion && allSuitsReal) {
      parsed.fromTemplate = true;
      parsed.templateConfidence = 1;
    }

    // ── Capture queue (background; fire-and-forget) ────────────────────
    // Any time a card region emits cards, enqueue cells the matcher doesn't
    // already recognize at ≥ 0.75 confidence so the TeachZone can ask the
    // user to label them. Never blocks the OCR loop.
    if ((parsed.region === 'my_Hand' || parsed.region === 'the_Board')
        && matcherRef.current
        && typeof window !== 'undefined' && window.CaptureQueue && window.PokerEngine) {
      const region = regions.find((r) => r.id === parsed.region);
      if (region) {
        const expectedCount = parsed.region === 'my_Hand'
          ? 2
          : (parsed.cards && parsed.cards.length) || 3;
        const cells = cardCellsFromRegion(parsed.region, expectedCount);
        if (cells && cells.length === expectedCount) {
          const snapTwin = twinSnapshotRef.current;
          (async () => {
            try {
              const snap = await snapshotSourceFrame(videoElRef.current);
              if (!snap) return;
              let added = 0;
              for (let i = 0; i < cells.length; i++) {
                const cell = cells[i];
                const m = matcherRef.current.match(cell.imageData, cell.w, cell.h);
                const conf = m ? m.confidence : 0;
                if (conf >= 0.75) continue;
                const probe = window.PokerEngine.hashCardRGBA(
                  cell.imageData, cell.w, cell.h);
                if (await window.CaptureQueue.isDuplicate(probe, 30)) continue;
                await window.CaptureQueue.enqueue({
                  ts: Date.now(),
                  regionId: parsed.region,
                  cellIndex: i,
                  cellRgba: cell.imageData.buffer.slice(0),
                  cellW: cell.w,
                  cellH: cell.h,
                  sourceFrameJpeg: snap.blob,
                  sourceFrameW: snap.w,
                  sourceFrameH: snap.h,
                  bboxInSourceFrame: computeBboxInSourceFrame(
                    region, i, expectedCount, snap.w, snap.h),
                  matcherConfidence: conf,
                  matcherTopGuess: m ? m.card : null,
                  handId: snapTwin.handId,
                  street: snapTwin.street,
                });
                added++;
              }
              if (added > 0) setQueueTick((t) => t + 1);
            } catch (err) {
              console.warn('[capture-queue] enqueue failed:', err);
            }
          })();
        }
      }
    }

    // ── Twin state mutation ────────────────────────────────────────────
    setTwin((s) => applyEventToTwin(s, parsed));

    // ── Hand history persistence (chat-grammar events only) ────────────
    const hist = historyRef.current;
    if (hist) {
      if (parsed.kind === 'sys' && /Hand\s*#/i.test(parsed.text || '')) {
        try { hist.endHand(); } catch (_) {}
        hist.startHand({ id: Date.now() });
      }
      if (parsed.kind === 'hero_cards' && parsed.cards) hist.setHeroCards(parsed.cards);
      if (parsed.kind === 'board' && parsed.cards) hist.setBoard(parsed.cards);
      if (hist.current) hist.recordEvent({
        kind: parsed.kind, who: parsed.who, amount: parsed.amount,
        cards: parsed.cards, text: parsed.text,
      });
    }
  }, [turnPattern, regions]);

  // ── Fast-path recognizer router (Component 3) ─────────────────────────────
  // Invoked by useLiveOCR's loop in Phase 2, BEFORE Tesseract, once per region.
  // Returns null to fall through to Tesseract, or { event, text } to handle the
  // region this pass (the loop emits `event`, caches `text`, skips Tesseract).
  //   - Only regions named like a numeric field are eligible. `turn` is NOT
  //     here (it's button text, not digits; it stays on the Tesseract path).
  //   - Pixels are pulled lazily via getPx() so ineligible regions cost nothing.
  //   - pot → {kind:'pot', dollars} (v1 shape at live-ocr.jsx:512 → reducer:215).
  //     stack/bet/to_call have no v1 consumer and kind:'bet' would collide with
  //     the chat-action reducer, so they emit the existing {kind:'region_text'}.
  //   - Unchanged readings re-emit nothing (event:null) but still skip Tesseract.
  const recognizeFast = React.useCallback((region, getPx) => {
    const dm = digitMatcherRef.current;
    if (!dm || dm.size === 0) return null;               // nothing taught → Tesseract
    const name = region.name || '';
    if (!/pot|stack|bet|to_?call/i.test(name)) return null;
    const px = getPx();
    if (!px) return null;
    const res = dm.recognizeNumeric(px.rgba, px.w, px.h);
    if (res.text == null || res.unmatched !== 0) return null; // low confidence → Tesseract

    const changed = digitLastEmitRef.current.get(region.id) !== res.text;
    digitLastEmitRef.current.set(region.id, res.text);
    if (!changed) return { event: null, text: res.text };  // same value → skip re-emit

    if (/pot/i.test(name)) {
      const dollars = parseNumericText(res.text);
      if (dollars == null) return null;                    // unparseable → Tesseract
      return { event: { kind: 'pot', dollars }, text: res.text };
    }
    return { event: { kind: 'region_text', text: res.text }, text: res.text };
  }, []);

  const { status, error, latency, regionText, regionLatency, videoSize, stream,
          lastSkipped, fastPathHits, start, stop, getRegionPixels, getRegionOcrPixels } =
    useLiveOCR({ intervalMs: interval, regions, onEvent: handleEvent,
                 preprocess, binarizeThreshold, ocrMaxWidth, recognizeFast });

  // Helper: slice a region's pixels into N evenly-spaced card cells.
  const cardCellsFromRegion = React.useCallback((regionId, n) => {
    const px = getRegionPixels && getRegionPixels(regionId);
    if (!px) return null;
    const cellW = Math.floor(px.w / n);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const sx0 = i * cellW;
      const sw = (i === n - 1) ? (px.w - sx0) : cellW;
      const cellData = new Uint8Array(sw * px.h * 4);
      for (let y = 0; y < px.h; y++) {
        const srcStart = (y * px.w + sx0) * 4;
        const dstStart = y * sw * 4;
        for (let j = 0; j < sw * 4; j++) cellData[dstStart + j] = px.imageData[srcStart + j];
      }
      cells.push({ imageData: cellData, w: sw, h: px.h });
    }
    return cells;
  }, [getRegionPixels]);

  // ── Digit teach (Component 3) ─────────────────────────────────────────────
  // Teach the pot region's glyphs against a verified ground-truth string. Reads
  // the BINARIZED pot canvas (the same representation DigitMatcher matches on),
  // segments it, and labels box[i] = groundTruth[i]. We refuse to teach unless
  // the box count equals the ground-truth length — that guard is what stops a
  // mismatched string from poisoning templates. The pixel read is race-safe:
  // JS is single-threaded, so a click can't land mid-Phase-1; the ocr canvas
  // always holds a complete, coherent frame (the two-phase invariant holds).
  const teachDigits = React.useCallback((groundTruth) => {
    const dm = digitMatcherRef.current;
    if (!dm) return { ok: false, msg: 'digit matcher unavailable' };
    const potRegion = regions.find((r) => /pot/i.test(r.name || ''));
    if (!potRegion) return { ok: false, msg: 'draw a region named like "pot" first' };
    const gt = cleanDigitGroundTruth(groundTruth);
    if (!gt) return { ok: false, msg: 'ground truth has no teachable symbols (0-9 . , $ B)' };
    const px = getRegionOcrPixels && getRegionOcrPixels(potRegion.id);
    if (!px) return { ok: false, msg: 'pot region not captured yet — connect the feed' };
    const boxes = dm.segment(px.imageData, px.w, px.h);
    if (boxes.length !== gt.length) {
      return { ok: false, msg: `segmented ${boxes.length} glyph(s) but "${gt}" has ${gt.length} — tighten the region or fix the string` };
    }
    let taught = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (dm.teach(gt[i], boxes[i].rgba, boxes[i].w, boxes[i].h)) {
        digitTeachPixelsRef.current.set(gt[i], { rgba: boxes[i].rgba, w: boxes[i].w, h: boxes[i].h });
        taught++;
      }
    }
    setDigitCount(dm.size);
    return { ok: true, msg: `taught ${taught} glyph(s) from "${gt}" (${dm.size}/14 learned)`, taught };
  }, [regions, getRegionOcrPixels]);

  // ── Digit smoke test (Component 3) ────────────────────────────────────────
  // Re-match each taught symbol against the exact glyph it was taught from;
  // expect symbol identity at confidence ≥ 0.99. A high-confidence match to a
  // DIFFERENT symbol is a collision — the "needs a 4th hash" signal (8↔0, 3↔8,
  // 5↔S). Pixels are in-memory only, so symbols taught in a prior session (lost
  // on reload) are reported as un-testable rather than failing.
  const smokeDigits = React.useCallback(() => {
    const dm = digitMatcherRef.current;
    if (!dm || dm.size === 0) return { ok: false, lines: ['no digits taught yet'] };
    const lines = [];
    let ok = true;
    for (const s of dm.list()) {
      const px = digitTeachPixelsRef.current.get(s);
      if (!px) { lines.push(`  ${s}  no pixels this session (reload clears them)`); continue; }
      const m = dm.match(px.rgba, px.w, px.h);
      const conf = m ? m.confidence : 0;
      const collision = m && m.symbol !== s && conf >= 0.85;
      const pass = m && m.symbol === s && conf >= 0.99;
      if (!pass) ok = false;
      lines.push(`  ${s} → ${m ? m.symbol : '∅'} @ ${conf.toFixed(3)}  ${pass ? '✓' : collision ? '✗ COLLISION' : '✗ low'}`);
    }
    return { ok, lines };
  }, []);

  // Frames-processed counter.
  React.useEffect(() => {
    if (latency != null && status === 'running') {
      setFramesProcessed((n) => n + 1);
      if (!startTimeRef.current) startTimeRef.current = performance.now();
    }
  }, [latency, status]);

  const elapsed = startTimeRef.current ? (performance.now() - startTimeRef.current) / 1000 : 0;
  const fps = framesProcessed && elapsed ? (framesProcessed / elapsed) : 0;

  const handleStart = async () => {
    setEvents([]);
    setFramesProcessed(0);
    startTimeRef.current = null;
    await start();
  };

  return (
    <div className="lot">
      <header className="lot-bar">
        <div className="lot-title">
          <div className="lot-title-mark" />
          <div>
            <div className="lot-title-text">PIXELPOKER · LIVE OCR TEST</div>
            <div className="lot-title-sub">digital twin — observation only, manual fire</div>
          </div>
        </div>
        <div className="lot-stats">
          <Stat label="STATUS"   value={status.toUpperCase()}
                tone={status === 'running' ? 'good' : status === 'error' ? 'bad' : status === 'connecting' ? 'warn' : null} />
          <Stat label="OCR LATENCY" value={latency != null ? `${latency} ms` : '—'} />
          <Stat label="OCR FPS"     value={fps ? fps.toFixed(2) : '—'} />
          <Stat label="FRAMES"      value={framesProcessed} />
          <Stat label="PARSED"      value={events.length} />
          <Stat label="VIDEO"       value={videoSize ? `${videoSize.w}×${videoSize.h}` : '—'} />
          <Stat label="CARDS"
                value={`${templateCount}/52${templateCount >= 52 ? ' ✓' : ''}`}
                tone={templateCount >= 52 ? 'good' : templateCount >= 26 ? 'warn' : null} />
        </div>
        <div className="lot-bar-r">
          {status !== 'running' && (
            <button className="lot-btn" onClick={handleStart} disabled={status === 'connecting'}>
              {status === 'connecting' ? 'CONNECTING…' : '▶ CONNECT FEED'}
            </button>
          )}
          {status === 'running' && (
            <button className="lot-btn lot-btn-danger" onClick={stop}>■ DISCONNECT</button>
          )}
          <a className="lot-link" href="Bot Operator Console.html">← OPERATOR CONSOLE</a>
        </div>
      </header>

      <main className="lot-grid lot-grid-unified">
        <RegionToolbar regions={regions} setRegions={setRegions} />

        <div className="lot-row lot-row-top">
          <VideoPreview status={status} error={error} videoSize={videoSize}
                        stream={stream}
                        regions={regions} setRegions={setRegions}
                        regionLatency={regionLatency} interval={interval}
                        onInterval={setIntervalMs}
                        preprocess={preprocess} setPreprocess={setPreprocess}
                        binarizeThreshold={binarizeThreshold} setBinarizeThreshold={setBinarizeThreshold}
                        ocrMaxWidth={ocrMaxWidth} setOcrMaxWidth={setOcrMaxWidth}
                        videoElRef={videoElRef} />
          <DigitalTwinView twin={twin} setHeroUsername={setHeroUsername} />
        </div>

        <ManualFirePanel daemonUrl={daemonUrl} setDaemonUrl={setDaemonUrl}
                         actionOnHero={twin.actionOnHero}
                         pot={twin.pot} potFromOcr={twin.potFromOcr} />

        <TeachZone matcher={matcherRef.current}
                   setTemplateCount={setTemplateCount}
                   queueTick={queueTick}
                   filterCard={filterCard}
                   onAutoResolved={(n) =>
                     showToast(`${n} captures auto-resolved — matcher is learning.`)} />

        <Footer matcher={matcherRef.current}
                templateCount={templateCount}
                filterCard={filterCard} setFilterCard={setFilterCard}
                queueTick={queueTick}
                onRawOcr={() => setShowRawOcr(true)}
                onEvents={() => setShowEvents(true)}
                onSettings={() => setShowSettings(true)} />
      </main>

      {showSettings && (
        <SettingsPopover onClose={() => setShowSettings(false)}
                         interval={interval} setIntervalMs={setIntervalMs}
                         preprocess={preprocess} setPreprocess={setPreprocess}
                         binarizeThreshold={binarizeThreshold} setBinarizeThreshold={setBinarizeThreshold}
                         ocrMaxWidth={ocrMaxWidth} setOcrMaxWidth={setOcrMaxWidth}
                         turnPattern={turnPattern} setTurnPattern={setTurnPattern}
                         matcher={matcherRef.current}
                         templateCount={templateCount} setTemplateCount={setTemplateCount}
                         teachAttempts={teachAttempts} lastTeachAt={lastTeachAt}
                         digitMatcher={digitMatcherRef.current}
                         digitCount={digitCount} setDigitCount={setDigitCount}
                         potPrefill={(() => {
                           const pr = regions.find((r) => /pot/i.test(r.name || ''));
                           const t = pr ? (regionText[pr.id] || '') : '';
                           return cleanDigitGroundTruth(t.split('\n')[0]);
                         })()}
                         onTeachDigits={teachDigits} onSmokeDigits={smokeDigits} />
      )}
      {showRawOcr && (
        <RawOcrModal regionText={regionText} regions={regions}
                     onClose={() => setShowRawOcr(false)} />
      )}
      {showEvents && (
        <EventsModal events={events} onClose={() => setShowEvents(false)} />
      )}

      {learnedToast && (
        <div key={learnedToast.id} className="lot-toast">
          <div className="lot-toast-main">
            +{learnedToast.delta} card{learnedToast.delta === 1 ? '' : 's'} learned
          </div>
          <div className="lot-toast-sub">
            templates {learnedToast.total}/52 · {52 - learnedToast.total} to go
          </div>
        </div>
      )}
      {transientToast && (
        <div key={transientToast.id} className="lot-toast lot-toast-info">
          <div className="lot-toast-main">{transientToast.text}</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="lot-stat">
      <div className="lot-stat-l">{label}</div>
      <div className={"lot-stat-v " + (tone ? "lot-stat-" + tone : "")}>{value}</div>
    </div>
  );
}

function VideoPreview({ status, error, videoSize, stream, regions, setRegions,
                        regionLatency, interval, onInterval,
                        preprocess, setPreprocess,
                        binarizeThreshold, setBinarizeThreshold,
                        ocrMaxWidth, setOcrMaxWidth,
                        videoElRef }) {
  const videoRef = React.useRef(null);
  const bodyRef  = React.useRef(null);
  const [dragBox, setDragBox] = React.useState(null);

  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (status === 'running' && stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [status, stream]);

  // Compute the actual rendered video rect inside the body (object-fit: contain
  // letterboxes/pillarboxes). Coords come back as 0..1 fractions of the video.
  const evToFrac = (e) => {
    const v = videoRef.current;
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height));
    return { x, y };
  };

  const onMouseDown = (e) => {
    if (status !== 'running') return;
    if (regions.length >= MAX_REGIONS) return;
    const p = evToFrac(e); if (!p) return;
    setDragBox({ x: p.x, y: p.y, x2: p.x, y2: p.y });
  };
  const onMouseMove = (e) => {
    if (!dragBox) return;
    const p = evToFrac(e); if (!p) return;
    setDragBox({ ...dragBox, x2: p.x, y2: p.y });
  };
  const onMouseUp = () => {
    if (!dragBox) { return; }
    const minX = Math.min(dragBox.x, dragBox.x2);
    const minY = Math.min(dragBox.y, dragBox.y2);
    const w = Math.abs(dragBox.x2 - dragBox.x);
    const h = Math.abs(dragBox.y2 - dragBox.y);
    setDragBox(null);
    if (w < 0.02 || h < 0.02) return; // ignore stray clicks
    if (regions.length >= MAX_REGIONS) return;
    const nextIdx = regions.length;
    setRegions([...regions, {
      id: 'r' + Date.now(),
      name: nextIdx === 0 ? 'chat' : nextIdx === 1 ? 'turn' : 'extra',
      color: REGION_COLORS[nextIdx % 3],
      x: +minX.toFixed(3), y: +minY.toFixed(3),
      w: +w.toFixed(3), h: +h.toFixed(3),
    }]);
  };

  return (
    <section className="lot-panel lot-video">
      <header className="lot-panel-h">
        <div className="lot-panel-title">Captured Feed</div>
        <div className="lot-panel-meta">
          {status === 'running' && videoSize
            ? `${videoSize.w}×${videoSize.h} · ${regions.length} region${regions.length === 1 ? '' : 's'}`
            : 'idle'}
        </div>
      </header>

      {error && (
        <div className="lot-error">
          <div className="lot-error-l">CAPTURE ERROR</div>
          {error}
        </div>
      )}

      {status === 'idle' && !error && (
        <div className="lot-help">
          <b>What this does:</b> captures a window/tab/screen via <code>getDisplayMedia()</code>,
          runs Tesseract on up to 3 OCR regions every <code>{interval}ms</code>,
          deduplicates lines, regex-matches the poker grammar, and emits tagged events.
          <br/><br/>
          <b>To test:</b> click <kbd>▶ CONNECT FEED</kbd>, pick the window with the chat,
          then <b>click+drag on the video</b> to draw an OCR region. Add up to 3 — one for chat,
          one for the action area, one extra. Edit coords below.
        </div>
      )}

      <div className="lot-video-body" ref={bodyRef}
           onMouseDown={onMouseDown}
           onMouseMove={onMouseMove}
           onMouseUp={onMouseUp}
           onMouseLeave={onMouseUp}
           style={{ cursor: status === 'running' && regions.length < 3 ? 'crosshair' : 'default', userSelect: 'none' }}>
        {status === 'running' ? (
          <>
            <video ref={(el) => {
                     videoRef.current = el;
                     if (videoElRef) videoElRef.current = el;
                   }} muted playsInline autoPlay />
            {regions.map((r) => (
              <div key={r.id} className="lot-video-region" style={{
                top: `${r.y * 100}%`, left: `${r.x * 100}%`,
                width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                borderColor: r.color,
                boxShadow: `0 0 0 1px ${r.color} inset, 0 0 12px -4px ${r.color}`,
              }}>
                <div className="lot-video-region-tag" style={{ background: r.color }}>{r.name}</div>
              </div>
            ))}
            {dragBox && (
              <div className="lot-video-region lot-video-region-draft" style={{
                left:  `${Math.min(dragBox.x, dragBox.x2) * 100}%`,
                top:   `${Math.min(dragBox.y, dragBox.y2) * 100}%`,
                width: `${Math.abs(dragBox.x2 - dragBox.x) * 100}%`,
                height:`${Math.abs(dragBox.y2 - dragBox.y) * 100}%`,
              }} />
            )}
            <div className="lot-video-overlay">FEED LIVE</div>
          </>
        ) : (
          <div className="lot-video-empty">
            no feed connected<br/>
            <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
              click CONNECT FEED, then pick the window with your chat log
            </span>
          </div>
        )}
      </div>

      <div className="lot-controls">
        <div className="lot-control" style={{ minWidth: 140 }}>
          <div className="lot-control-l">OCR INTERVAL</div>
          <input type="range" min="100" max="1500" step="50"
                 value={interval} onChange={(e) => onInterval(+e.target.value)} />
          <div className="lot-control-v">{interval} ms</div>
        </div>
        <div className="lot-control" style={{ minWidth: 140 }}>
          <div className="lot-control-l">
            <label className="lot-gs-check" style={{ gap: 4 }}>
              <input type="checkbox" checked={preprocess}
                     onChange={(e) => setPreprocess(e.target.checked)} />
              <span>PREPROCESS (invert+binarize)</span>
            </label>
          </div>
          <input type="range" min="60" max="200" step="2"
                 value={binarizeThreshold}
                 onChange={(e) => setBinarizeThreshold(+e.target.value)}
                 disabled={!preprocess} />
          <div className="lot-control-v">threshold {binarizeThreshold}</div>
        </div>
        <div className="lot-control" style={{ minWidth: 140 }}>
          <div className="lot-control-l">OCR MAX WIDTH</div>
          <input type="range" min="400" max="3500" step="100"
                 value={ocrMaxWidth}
                 onChange={(e) => setOcrMaxWidth(+e.target.value)} />
          <div className="lot-control-v">{ocrMaxWidth} px</div>
        </div>
        <RegionsEditor regions={regions} setRegions={setRegions} regionLatency={regionLatency} />
      </div>
    </section>
  );
}

function RegionsEditor({ regions, setRegions, regionLatency }) {
  const update = (id, patch) => setRegions(regions.map(r => r.id === id ? { ...r, ...patch } : r));
  const remove = (id) => setRegions(regions.filter(r => r.id !== id));
  const nextColor = () => REGION_COLORS[regions.length % REGION_COLORS.length];
  const addDefault = () => {
    if (regions.length >= MAX_REGIONS) return;
    const idx = regions.length;
    setRegions([...regions, {
      id: 'r' + Date.now(),
      name: idx === 0 ? 'chat' : idx === 1 ? 'the_Board' : idx === 2 ? 'my_Hand' : 'turn',
      color: nextColor(),
      x: 0.2, y: 0.2, w: 0.4, h: 0.2,
    }]);
  };
  const addTurnPreset = () => {
    if (regions.length >= MAX_REGIONS) return;
    // Poker Coach AI's action buttons render bottom-centre. Defaults cover
    // ~the Fold/Check/Bet|Call/Raise row; nudge in the sliders if off.
    setRegions([...regions, {
      id: 'turn' + Date.now(),
      name: 'turn',
      color: nextColor(),
      x: 0.30, y: 0.86, w: 0.45, h: 0.12,
    }]);
  };
  const hasTurn = regions.some((r) => /turn/i.test(r.name || ''));

  return (
    <div className="lot-regions">
      <div className="lot-regions-h">
        <span className="lot-regions-title">OCR REGIONS ({regions.length}/{MAX_REGIONS})</span>
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={addDefault} disabled={regions.length >= MAX_REGIONS}>
          + ADD
        </button>
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={addTurnPreset}
                disabled={regions.length >= MAX_REGIONS || hasTurn}
                title="drops a region pre-positioned over the action buttons">
          + TURN ZONE
        </button>
        <span className="lot-regions-hint">click+drag on the video to draw</span>
      </div>
      <div className="lot-regions-list">
        {regions.length === 0 && <div className="lot-regions-empty">— no regions; drag on the video, or click ADD —</div>}
        {regions.map(r => {
          const ms = regionLatency?.[r.id];
          return (
            <div key={r.id} className="lot-region-card">
              <div className="lot-region-row">
                <span className="lot-region-swatch" style={{ background: r.color }} />
                <input className="lot-region-name" value={r.name}
                       onChange={(e) => update(r.id, { name: e.target.value })} />
                <span className="lot-region-ms">{ms != null ? `${ms}ms` : '—'}</span>
                <button className="lot-btn lot-btn-tiny lot-btn-x" onClick={() => remove(r.id)} title="remove">×</button>
              </div>
              <div className="lot-region-sliders">
                <RegionSlider label="X" value={r.x} min={0} max={1} step={0.01}
                              onChange={(v) => update(r.id, { x: Math.min(1 - r.w, v) })} />
                <RegionSlider label="Y" value={r.y} min={0} max={1} step={0.01}
                              onChange={(v) => update(r.id, { y: Math.min(1 - r.h, v) })} />
                <RegionSlider label="W" value={r.w} min={0.02} max={1} step={0.01}
                              onChange={(v) => update(r.id, { w: Math.min(1 - r.x, v) })} />
                <RegionSlider label="H" value={r.h} min={0.02} max={1} step={0.01}
                              onChange={(v) => update(r.id, { h: Math.min(1 - r.y, v) })} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegionSlider({ label, value, min, max, step, onChange }) {
  return (
    <div className="lot-region-slider">
      <span className="lot-region-slider-l">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(+e.target.value)} />
      <span className="lot-region-slider-v">{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

function RawOCRPanel({ regionText, regions }) {
  const tail = 6;
  const hasAny = regions.some((r) => regionText && regionText[r.id]);
  return (
    <section className="lot-panel">
      <header className="lot-panel-h">
        <div className="lot-panel-title">Raw OCR Output</div>
        <div className="lot-panel-meta">{regions.length} region{regions.length === 1 ? '' : 's'} · last {tail} lines highlighted</div>
      </header>
      <div className="lot-raw-body">
        {!hasAny && <div className="raw-empty">— waiting for first frame —</div>}
        {regions.map((r) => {
          const text = (regionText && regionText[r.id]) || '';
          const lines = text.split('\n');
          return (
            <div key={r.id} className="lot-raw-section">
              <div className="lot-raw-section-h" style={{ color: r.color, borderColor: r.color }}>
                {r.name}
              </div>
              {!text && <div className="raw-empty">— no output yet —</div>}
              {lines.map((l, i) => {
                const isTail = i >= lines.length - tail && l.trim();
                return isTail
                  ? <div key={i} className="lot-raw-tail" style={{ borderLeftColor: r.color }}>{l || ' '}</div>
                  : <div key={i}>{l || ' '}</div>;
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EventsPanel({ events }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);
  return (
    <section className="lot-panel">
      <header className="lot-panel-h">
        <div className="lot-panel-title">Parsed Events</div>
        <div className="lot-panel-meta">{events.length}</div>
      </header>
      <div className="lot-events-body" ref={ref}>
        {events.length === 0 && (
          <div className="lot-events-empty">— no events parsed yet —</div>
        )}
        {events.map((e) => (
          <div key={e.id} className="lot-event">
            <span className="lot-event-ts">{e.ts}</span>
            <span className={"lot-event-kind k-" + e.kind}>{e.kind.toUpperCase()}</span>
            <span className="lot-event-who">{e.who || e.text || '—'}</span>
            <span className="lot-event-amt">{e.amount != null ? `$${e.amount}` : e.target != null ? `→$${e.target}` : ''}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
function SmokeTestRow() {
  const [result, setResult] = React.useState(null);
  const run = () => setResult(runMatcherSmokeTest());
  return (
    <div className="lot-smoke">
      <div className="lot-smoke-bar">
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={run}>
          ▶ RUN SMOKE TEST
        </button>
        {result && (
          <span className={'lot-smoke-badge ' + (result.ok ? 'lot-gs-ok' : 'lot-gs-bad')}>
            {result.ok ? '● ALL PASS' : '✗ FAIL'}
          </span>
        )}
      </div>
      {result && (
        <pre className="lot-smoke-out">{result.lines.join('\n')}</pre>
      )}
    </div>
  );
}
// SmokeTest — exercises the matcher chain end-to-end with synthetic RGBA
// so Josh can verify wiring without playing real hands. Uses a throwaway
// matcher (separate localStorage key) so live templates are untouched.
function runMatcherSmokeTest() {
  const E = window.PokerEngine;
  if (!E) return { ok: false, lines: ['PokerEngine not loaded — script tag missing?'] };
  const lines = [];
  const w = 40, h = 60;
  const checks = [];

  // Build two distinguishable RGBA buffers.
  function buildBuf(seed) {
    const buf = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        buf[i]   = (x * seed * 3) % 256;
        buf[i+1] = (y * seed * 5) % 256;
        buf[i+2] = ((x + y) * seed * 7) % 256;
        buf[i+3] = 255;
      }
    }
    return buf;
  }

  try {
    const m = new E.MultiSignatureMatcher('smoketest:matcher');
    m.clear();
    const bufAh = buildBuf(3);
    const bufKc = buildBuf(11);

    const taught1 = m.teach('Ah', bufAh, w, h);
    checks.push({ name: "teach('Ah', bufAh)", pass: taught1 === true });
    const taught2 = m.teach('Kc', bufKc, w, h);
    checks.push({ name: "teach('Kc', bufKc)", pass: taught2 === true });
    checks.push({ name: 'matcher.size === 2', pass: m.size === 2 });

    const m1 = m.match(bufAh, w, h);
    checks.push({ name: "match(bufAh) → 'Ah'",       pass: m1 && m1.card === 'Ah' });
    checks.push({ name: 'match(bufAh) distance == 0', pass: m1 && m1.distance === 0 });
    checks.push({ name: 'match(bufAh) conf == 1',     pass: m1 && m1.confidence === 1 });

    const m2 = m.match(bufKc, w, h);
    checks.push({ name: "match(bufKc) → 'Kc'", pass: m2 && m2.card === 'Kc' });

    // Cross-match: a third buffer should pick the closer of the two.
    const bufClose = buildBuf(3.05); // slightly perturbed from bufAh
    const m3 = m.match(bufClose, w, h);
    checks.push({ name: "match(perturbed bufAh) → 'Ah'", pass: m3 && m3.card === 'Ah' });

    m.clear();
    checks.push({ name: 'clear() empties matcher', pass: m.size === 0 });
    // History quick check
    const h2 = new E.HandHistoryRecorder('smoketest:hist', 5);
    h2.clear();
    h2.startHand({ id: 1, seats: ['V'] });
    h2.recordEvent({ kind: 'fold', who: 'V' });
    h2.endHand();
    checks.push({ name: 'history.startHand/record/end persists', pass: h2.count === 1 });
    h2.clear();
  } catch (e) {
    checks.push({ name: 'NO EXCEPTIONS', pass: false, err: e.message });
  }

  const liveSize = (typeof window !== 'undefined' && window.PokerEngine)
    ? (new E.MultiSignatureMatcher()).size
    : 0;
  lines.push(`MATCHER WIRING SMOKE TEST`);
  lines.push('─'.repeat(34));
  for (const c of checks) lines.push(`  ${c.pass ? '✓' : '✗'}  ${c.name}${c.err ? '  · ' + c.err : ''}`);
  lines.push('');
  lines.push(`Live matcher (current templates): ${liveSize}/52`);
  lines.push(`All checks ${checks.every(c => c.pass) ? 'PASSED' : 'FAILED'}`);
  const ok = checks.every(c => c.pass);
  return { ok, lines };
}

// ───────────────────────────────────────────────────────────────────────────
// Templates collapsible — count, learned/missing pills, smoke test, clear all.
// ───────────────────────────────────────────────────────────────────────────
const DIGIT_SYMBOLS = '0123456789.,$B';

// 💲 Digits subsection — fast-path numeric template library. Teach the pot
// region's glyphs from a verified ground-truth string, smoke-test taught
// symbols against themselves, and clear.
function DigitsSubsection({ digitMatcher, digitCount, setDigitCount, potPrefill, onTeach, onSmoke }) {
  const [gt, setGt] = React.useState('');
  const [teachMsg, setTeachMsg] = React.useState(null);
  const [smoke, setSmoke] = React.useState(null);
  React.useEffect(() => { if (potPrefill && !gt) setGt(potPrefill); }, [potPrefill]); // prefill once
  const learned = new Set(digitMatcher ? digitMatcher.list() : []);
  const doTeach = () => { setSmoke(null); setTeachMsg(onTeach(gt)); };
  const doSmoke = () => { setTeachMsg(null); setSmoke(onSmoke()); };
  return (
    <details className="lot-cp-section" open={digitCount > 0 && digitCount < 14}>
      <summary>💲 Digits &middot; {digitCount}/14{digitCount >= 14 ? ' ✓ complete' : ''}</summary>
      <div className="lot-cp-section-body">
        <div className="lot-tpl-missing">
          {DIGIT_SYMBOLS.split('').map((s) => (
            <span key={s}
                  className={'lot-tpl-pill ' + (learned.has(s) ? 'lot-tpl-learned lot-tpl-black' : '')}
                  title={learned.has(s) ? 'taught' : 'untaught'}>
              {s === ' ' ? '␣' : s}
            </span>
          ))}
        </div>
        <div className="lot-gs-status">
          <span className="lot-gs-dim">ground truth (what the pot region shows): </span>
          <input className="lot-input lot-input-tiny" value={gt}
                 onChange={(e) => setGt(e.target.value)}
                 placeholder="$3.20" spellCheck={false} style={{ width: '7em' }} />
          <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                  onClick={doTeach} disabled={!gt}>TEACH POT GLYPHS</button>
        </div>
        {teachMsg && (
          <div className={'lot-gs-status ' + (teachMsg.ok ? 'lot-gs-ok' : 'lot-gs-bad')}>
            {teachMsg.ok ? '● ' : '⚠ '}{teachMsg.msg}
          </div>
        )}
        <div className="lot-smoke-bar">
          <button className="lot-btn lot-btn-tiny" onClick={doSmoke} disabled={digitCount === 0}>
            ▶ SMOKE TEST
          </button>
          {smoke && (
            <span className={'lot-smoke-badge ' + (smoke.ok ? 'lot-gs-ok' : 'lot-gs-bad')}>
              {smoke.ok ? 'PASS' : 'CHECK'}
            </span>
          )}
          {digitMatcher && digitCount > 0 && (
            <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                    onClick={() => { digitMatcher.clear(); setDigitCount(0); setSmoke(null); setTeachMsg(null); }}>
              CLEAR DIGITS
            </button>
          )}
        </div>
        {smoke && <pre className="lot-smoke-out">{smoke.lines.join('\n')}</pre>}
        {digitCount === 0 && (
          <div className="lot-gs-status lot-gs-dim">
            — teach the 14 symbols from a few pot reads; until then the fast path falls through to Tesseract —
          </div>
        )}
      </div>
    </details>
  );
}

function TemplatesPanel({ matcher, templateCount, setTemplateCount, teachAttempts, lastTeachAt,
                          digitMatcher, digitCount, setDigitCount, potPrefill, onTeachDigits, onSmokeDigits }) {
  const all = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') all.push(r + s);
  const learned = new Set(matcher ? matcher.list() : []);
  const missing = all.filter((c) => !learned.has(c));
  return (
    <details className="lot-cp-section" open={templateCount > 0 && templateCount < 52}>
      <summary>🃏 Templates &middot; {templateCount}/52{templateCount >= 52 ? ' ✓ complete' : ''}</summary>
      <div className="lot-cp-section-body">
        <div className="lot-gs-status">
          <span className="lot-gs-dim">teach activity: </span>
          <b style={{ color: 'var(--fg)' }}>{teachAttempts}</b>
          <span className="lot-gs-dim"> total{lastTeachAt ? ' · last ' + Math.round((Date.now() - lastTeachAt) / 1000) + 's ago' : ' · never'}</span>
        </div>
        <SmokeTestRow />
        <div className="lot-gs-status">
          {templateCount >= 52
            ? <span className="lot-gs-ok">● ALL 52 LEARNED · OCR no longer needed for cards</span>
            : templateCount > 0
            ? <span className="lot-gs-ok">● {templateCount}/52 learned, {missing.length} to go</span>
            : <span className="lot-gs-dim">— taught from board + hero cards whenever chat parses real suits —</span>}
        </div>
        {templateCount > 0 && (
          <div className="lot-tpl-missing">
            <span className="lot-tpl-missing-l" style={{ color: 'var(--good)' }}>LEARNED ({templateCount}):</span>
            {[...learned].sort((a, b) => {
              const rOrder = '23456789TJQKA';
              const sOrder = 'shdc';
              return (rOrder.indexOf(a[0]) - rOrder.indexOf(b[0]))
                  || (sOrder.indexOf(a[1]) - sOrder.indexOf(b[1]));
            }).map((c) => {
              const isRed = c[1] === 'h' || c[1] === 'd';
              return <span key={c} className={'lot-tpl-pill lot-tpl-learned ' + (isRed ? 'lot-tpl-red' : 'lot-tpl-black')}>{c[0]}{ {s:'♠',h:'♥',d:'♦',c:'♣'}[c[1]] }</span>;
            })}
          </div>
        )}
        {missing.length > 0 && missing.length < 52 && (
          <div className="lot-tpl-missing">
            <span className="lot-tpl-missing-l">MISSING ({missing.length}):</span>
            {missing.map((c) => {
              const isRed = c[1] === 'h' || c[1] === 'd';
              return <span key={c} className={'lot-tpl-pill ' + (isRed ? 'lot-tpl-red' : 'lot-tpl-black')}>{c[0]}{ {s:'♠',h:'♥',d:'♦',c:'♣'}[c[1]] }</span>;
            })}
          </div>
        )}
        {matcher && templateCount > 0 && (
          <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                  onClick={() => { matcher.clear(); setTemplateCount(0); }}>
            CLEAR ALL
          </button>
        )}
        <DigitsSubsection digitMatcher={digitMatcher} digitCount={digitCount}
                          setDigitCount={setDigitCount} potPrefill={potPrefill}
                          onTeach={onTeachDigits} onSmoke={onSmokeDigits} />
      </div>
    </details>
  );
}


// ───────────────────────────────────────────────────────────────────────────
// Digital twin — descriptive render of what the OCR pipeline believes the
// table looks like. Strictly observation; no decision text anywhere.
// ───────────────────────────────────────────────────────────────────────────

function CardFace({ card }) {
  if (!card) return null;
  const rank = card[0];
  const suit = card[1];
  const glyph = SUIT_GLYPH[suit] || '?';
  const isRed = suit === 'h' || suit === 'd';
  return (
    <div className={'lot-card-face ' + (isRed ? 'lot-card-face-red' : 'lot-card-face-black')}>
      <div className="lot-card-corner lot-card-corner-tl">{rank}{glyph}</div>
      <div className="lot-card-center">{glyph}</div>
      <div className="lot-card-corner lot-card-corner-br">{rank}{glyph}</div>
    </div>
  );
}
function CardSlab({ variant }) {
  // variant: 'down' | 'empty'
  return <div className={'lot-card-slab lot-card-slab-' + (variant || 'down')} />;
}

function handLabelFromEval(heroCards, board) {
  if (!heroCards || heroCards.length !== 2) return null;
  if (board.length < 3) return null;
  const E = window.PokerEngine;
  if (!E) return null;
  try {
    const all = E.parseCards([...heroCards, ...board]);
    const score = E.evaluate7(all);
    const cat = score >>> 20;
    if (cat === E.CAT_SF)       return 'Straight flush';
    if (cat === E.CAT_QUADS)    return 'Quads';
    if (cat === E.CAT_FULL)     return 'Full house';
    if (cat === E.CAT_FLUSH)    return 'Flush';
    if (cat === E.CAT_STRAIGHT) return 'Straight';
    if (cat === E.CAT_TRIPS)    return 'Three of a kind';
    if (cat === E.CAT_2P)       return 'Two pair';
    if (cat === E.CAT_PAIR)     return 'Pair';
    return 'High card';
  } catch (_) {
    return null;
  }
}

function SeatTile({ seat, heroCards, actionOnHero }) {
  const isCurrent = seat.isHero && actionOnHero;
  let cls = 'lot-twin-seat';
  if (seat.isHero)  cls += ' lot-twin-seat-hero';
  if (seat.folded)  cls += ' lot-twin-seat-folded';
  if (isCurrent)    cls += ' lot-twin-seat-current';
  const cards = seat.isHero && heroCards && heroCards.length === 2
    ? heroCards
    : null;
  return (
    <div className={cls}>
      <div className="lot-twin-seat-head">
        <span className="lot-twin-seat-name">{seat.name || '—'}</span>
        {seat.isButton && <span className="lot-twin-seat-btn">D</span>}
        {seat.isSB     && <span className="lot-twin-seat-blind">SB</span>}
        {seat.isBB     && <span className="lot-twin-seat-blind">BB</span>}
      </div>
      <div className="lot-twin-seat-cards">
        {cards
          ? cards.map((c, i) => <CardFace key={i} card={c} />)
          : <><CardSlab variant="down" /><CardSlab variant="down" /></>}
      </div>
      <div className="lot-twin-seat-stack">{seat.stack != null ? '$' + seat.stack : '—'}</div>
    </div>
  );
}

function DigitalTwinView({ twin, setHeroUsername }) {
  const historyRef = React.useRef(null);
  React.useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [twin.actionHistory.length]);

  const handLabel = React.useMemo(
    () => handLabelFromEval(twin.heroCards, twin.board),
    [twin.heroCards, twin.board]
  );
  const canonical = React.useMemo(() => {
    if (!twin.heroCards || twin.heroCards.length !== 2) return null;
    const E = window.PokerEngine;
    if (!E) return null;
    try { return E.canonicalize(twin.heroCards); } catch (_) { return null; }
  }, [twin.heroCards]);

  const street = (twin.street || 'preflop').toUpperCase();
  const boardSlots = [];
  for (let i = 0; i < 5; i++) {
    boardSlots.push(twin.board[i] || null);
  }
  const seatList = [...twin.seats.values()];
  const buttonKnown = seatList.some((s) => s.isButton);

  return (
    <section className="lot-panel lot-twin-root">
      <header className="lot-panel-h">
        <div className="lot-panel-title">Digital Twin</div>
        <div className="lot-panel-meta">{twin.handId ? 'Hand #' + twin.handId : 'no hand'}</div>
      </header>
      <div className="lot-twin-body">
        <div className="lot-twin-header">
          <label className="lot-twin-hero-l">hero:</label>
          <input className="lot-twin-hero-input" type="text" value={twin.heroUsername}
                 onChange={(e) => setHeroUsername(e.target.value)} />
          {!buttonKnown && <span className="lot-twin-btn-unknown">(button: ?)</span>}
        </div>

        <div className="lot-twin-pot">
          {twin.pot > 0 ? '$' + twin.pot.toFixed(2) : '—'}
          <span className="lot-twin-pot-src">{twin.pot > 0 ? (twin.potFromOcr ? '(ocr)' : '(estimated)') : ''}</span>
        </div>

        <div className="lot-twin-board">
          {boardSlots.map((c, i) => c
            ? <CardFace key={i} card={c} />
            : <CardSlab key={i} variant="empty" />
          )}
        </div>

        <div className="lot-twin-street">{street}</div>

        <div className="lot-twin-hand-label">
          {handLabel
            ? <><span className="lot-twin-hand-label-main">{handLabel}</span>{canonical && <span className="lot-twin-hand-label-sub"> &middot; {canonical}</span>}</>
            : canonical
            ? <span className="lot-twin-hand-label-sub">{canonical}</span>
            : <span className="lot-twin-hand-label-empty">— hero cards not seen yet —</span>}
        </div>

        <div className="lot-twin-seats">
          {seatList.length === 0
            ? <span className="lot-gs-dim">— no seats observed yet —</span>
            : seatList.map((s) => (
                <SeatTile key={s.name} seat={s}
                          heroCards={twin.heroCards}
                          actionOnHero={twin.actionOnHero} />
              ))
          }
        </div>

        <div className="lot-twin-history" ref={historyRef}>
          {twin.actionHistory.length === 0
            ? <div className="lot-gs-dim">— no events this hand —</div>
            : twin.actionHistory.slice(-20).map((e, i) => (
                <div key={i} className={'lot-twin-history-row lot-twin-history-verb-' + e.kind}>
                  {e.text}
                </div>
              ))
          }
        </div>
      </div>
    </section>
  );
}


// ───────────────────────────────────────────────────────────────────────────
// Manual fire panel — button row + slider ticks + daemon status badge.
// No coupling to twin.actionOnHero. No auto-fire. No dedup state.
// ───────────────────────────────────────────────────────────────────────────
const FIRE_PRIMARY = [
  { action: 'fold',  label: 'FOLD',         variant: 'fold'  },
  { action: 'call',  label: 'CHECK / CALL', variant: 'call'  },
  { action: 'raise', label: 'BET / RAISE',  variant: 'raise' },
];
const FIRE_SECONDARY = [
  { action: 'double',   label: 'DOUBLE'   },
  { action: 'foldview', label: 'FOLDVIEW' },
  { action: 'allin',    label: 'ALL-IN'   },
];

function ManualFirePanel({ daemonUrl, setDaemonUrl, actionOnHero, pot, potFromOcr }) {
  const [sliderTicks, setSliderTicks] = React.useState(0);
  const [health, setHealth] = React.useState(null);
  const [last, setLast] = React.useState(null);
  const [secondaryOpen, setSecondaryOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const r = await fetch(daemonUrl + '/health');
        const j = await r.json();
        if (alive) setHealth({ ok: !!j.ok, dryRun: !!j.dryRun, ts: Date.now(), raw: j });
      } catch (_) {
        if (alive) setHealth({ ok: false, error: 'unreachable', ts: Date.now() });
      }
    };
    ping();
    const id = setInterval(ping, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [daemonUrl]);

  // Close secondary popover on outside click or Escape.
  const secRef = React.useRef(null);
  React.useEffect(() => {
    if (!secondaryOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setSecondaryOpen(false); };
    const onDown = (e) => {
      if (secRef.current && !secRef.current.contains(e.target)) setSecondaryOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(t);
    };
  }, [secondaryOpen]);

  const fire = async (action) => {
    const sentTicks = parseInt(sliderTicks, 10) || 0;
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
    try {
      const r = await fetch(daemonUrl + '/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sliderTicks: sentTicks, label: 'manual' }),
      });
      let body = null;
      try { body = await r.json(); } catch (_) { body = { ok: false }; }
      setLast({ action, sliderTicks: sentTicks, status: r.status,
        reason: body && (body.error || body.reason),
        ok: r.status === 200, time });
    } catch (e) {
      setLast({ action, sliderTicks: sentTicks, status: 0, reason: e.message, ok: false, time });
    }
    setSecondaryOpen(false);
  };

  const daemonOk = !!(health && health.ok);
  const daemonDot = health ? (daemonOk ? '●' : '✗') : '○';
  const daemonClass = health ? (daemonOk ? 'lot-fire-status-ok' : 'lot-fire-status-bad') : 'lot-gs-dim';
  const buttonsEnabled = daemonOk; // buttons still clickable when not actionOnHero;
                                   // dim is purely visual per spec.

  return (
    <section className="lot-panel lot-fire-root"
             data-action-on={actionOnHero ? 'true' : 'false'}>
      <div className="lot-fire-body">
        <div className="lot-fire-row lot-fire-row-status">
          {actionOnHero
            ? <span className="lot-fire-pill-turn">⚡ YOUR TURN</span>
            : <span className="lot-fire-pill-idle">MANUAL FIRE</span>}
          <span className={daemonClass} style={{ fontFamily: 'var(--mono)' }}>
            {daemonDot} daemon: {daemonOk ? (health.dryRun ? 'connected (dry-run)' : 'connected') : (health ? (health.error || 'down') : 'checking…')}
          </span>
          {actionOnHero && pot > 0 && (
            <span className="lot-gs-dim" style={{ fontFamily: 'var(--mono)' }}>
              pot ${pot.toFixed(2)} {potFromOcr ? '(ocr)' : '(estimated)'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <label className="lot-fire-l">daemon URL</label>
          <input className="lot-fire-url" type="text" value={daemonUrl}
                 onChange={(e) => setDaemonUrl(e.target.value)} />
          <label className="lot-fire-l">slider</label>
          <input className="lot-fire-ticks" type="number" min="-50" max="50" value={sliderTicks}
                 onChange={(e) => setSliderTicks(e.target.value)} />
        </div>
        <div className="lot-fire-row lot-fire-buttons">
          {FIRE_PRIMARY.map((b) => (
            <button key={b.action}
                    className={'lot-btn lot-btn-fire lot-fire-btn-' + b.variant}
                    disabled={!buttonsEnabled}
                    onClick={() => fire(b.action)}
                    title={`POST /act ${b.action}`}>
              {b.label}
            </button>
          ))}
          <div className="lot-fire-secondary-wrap" ref={secRef}>
            <button className="lot-btn lot-btn-secondary"
                    disabled={!buttonsEnabled}
                    onClick={() => setSecondaryOpen((v) => !v)}
                    title="more actions">···</button>
            {secondaryOpen && (
              <div className="lot-fire-secondary-popover">
                {FIRE_SECONDARY.map((b) => (
                  <button key={b.action}
                          className="lot-btn lot-btn-secondary lot-btn-tiny"
                          disabled={!buttonsEnabled}
                          onClick={() => fire(b.action)}>
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {last && (
            <div className={'lot-fire-last ' + (last.ok ? 'lot-gs-ok' : 'lot-gs-bad')}>
              last: {last.action.toUpperCase()} slider={last.sliderTicks} → {last.status} {last.ok ? 'ok' : (last.reason || 'failed')} ({last.time})
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Template backup — additive UI for download/upload of MultiSignatureMatcher
// templates. Wraps PokerEngine.serializeTemplates / deserializeTemplates.
// ───────────────────────────────────────────────────────────────────────────
function TemplateBackupSection({ matcher, templateCount, setTemplateCount }) {
  const fileInputRef = React.useRef(null);
  const [strategy, setStrategy] = React.useState('merge');
  const [status, setStatus] = React.useState(null); // {kind:'ok'|'err', text:string}

  const handleDownload = () => {
    if (!matcher || !window.PokerEngine) return;
    try {
      const payload = window.PokerEngine.serializeTemplates(matcher);
      const json = JSON.stringify(payload);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      a.href = url;
      a.download = `multi-sig-templates-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus({ kind: 'ok', text: `Downloaded ${payload.template_count} templates.` });
    } catch (e) {
      setStatus({ kind: 'err', text: 'Download failed: ' + e.message });
    }
  };

  const handleUploadClick = () => {
    if (!matcher) return;
    fileInputRef.current && fileInputRef.current.click();
  };

  const handleFileChosen = async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    let text, payload;
    try { text = await file.text(); }
    catch (err) { setStatus({ kind: 'err', text: 'Read failed: ' + err.message }); input.value = ''; return; }
    try { payload = JSON.parse(text); }
    catch (_) { setStatus({ kind: 'err', text: 'Invalid template file (not valid JSON).' }); input.value = ''; return; }

    const fileCount = (payload && payload.templates && typeof payload.templates === 'object')
      ? Object.keys(payload.templates).length : '?';

    if (strategy === 'replace') {
      const ok = window.confirm(
        `Replace all ${matcher.size} current templates with ${fileCount} from the file?\n\nThis cannot be undone.`
      );
      if (!ok) { input.value = ''; setStatus({ kind: 'ok', text: 'Import cancelled.' }); return; }
    }

    try {
      const res = window.PokerEngine.deserializeTemplates(matcher, payload, strategy);
      setTemplateCount(matcher.size);
      if (strategy === 'merge') {
        setStatus({ kind: 'ok', text: `Merge complete: ${res.added} added, ${res.skipped} skipped (already present). Now ${matcher.size} total.` });
      } else {
        setStatus({ kind: 'ok', text: `Replace complete: ${res.added} templates loaded. Now ${matcher.size} total.` });
      }
    } catch (err) {
      // Detect localStorage quota — _save() inside deserializeTemplates swallows quota errors,
      // but if our explicit check fails we surface it.
      const isQuota = /quota|exceed/i.test(err.message || '');
      if (isQuota) {
        setStatus({ kind: 'err', text: 'Save failed: localStorage quota likely exceeded. Templates loaded in memory but won\'t persist after refresh.' });
        setTemplateCount(matcher.size);
      } else {
        setStatus({ kind: 'err', text: 'File contains invalid template: ' + err.message });
      }
    } finally {
      input.value = '';
    }
  };

  return (
    <details className="lot-cp-section">
      <summary>💾 Template backup &middot; export/import JSON</summary>
      <div className="lot-cp-section-body">
        <div className="lot-backup-row">
          <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                  disabled={!matcher || templateCount === 0}
                  onClick={handleDownload}>
            DOWNLOAD TEMPLATES
          </button>
          <span className="lot-gs-dim">strategy:</span>
          <select className="lot-backup-select" value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}>
            <option value="merge">Merge (add new, keep existing)</option>
            <option value="replace">Replace all</option>
          </select>
          <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                  disabled={!matcher}
                  onClick={handleUploadClick}>
            UPLOAD TEMPLATES
          </button>
          <input ref={fileInputRef} type="file" accept="application/json"
                 style={{ display: 'none' }} onChange={handleFileChosen} />
        </div>
        {status && (
          <div className={status.kind === 'ok' ? 'lot-gs-ok' : 'lot-gs-bad'}
               style={{ fontSize: '11px', fontFamily: 'var(--mono)' }}>
            {status.text}
          </div>
        )}
        <div className="lot-gs-dim" style={{ fontSize: '10.5px' }}>
          Download saves your learned card templates as a JSON file you can restore later.
          Upload &mdash; "Merge" adds only new cards, "Replace all" overwrites everything.
        </div>
      </div>
    </details>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// TeachZone — single capture at a time. Cell + source frame + label input.
// Pulls head from CaptureQueue, calls matcher.teach on submit, then advances.
// ───────────────────────────────────────────────────────────────────────────
function TeachZone({ matcher, setTemplateCount, queueTick, filterCard, onAutoResolved }) {
  const [current, setCurrent] = React.useState(null);
  const [recent,  setRecent]  = React.useState([]);
  const [labelInput, setLabelInput] = React.useState('');
  const [labelError, setLabelError] = React.useState(null);
  const [relabelTarget, setRelabelTarget] = React.useState(null);
  const cellCanvasRef  = React.useRef(null);
  const frameCanvasRef = React.useRef(null);
  const inputRef = React.useRef(null);

  // Fetch head + recent on mount and whenever queueTick or filterCard changes.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (!window.CaptureQueue) return;
      try {
        let next;
        if (filterCard) {
          const matches = await window.CaptureQueue.list({
            status: 'pending', topGuess: filterCard, limit: 1 });
          next = matches[0] || null;
        } else {
          next = await window.CaptureQueue.head();
        }
        const rec = await window.CaptureQueue.recent(4);
        if (alive) {
          setCurrent(next);
          setRecent(rec);
          setLabelError(null);
        }
      } catch (e) {
        console.warn('[teach-zone] head fetch failed:', e);
      }
    })();
    return () => { alive = false; };
  }, [queueTick, filterCard]);

  // Paint the captured cell into its canvas at native res (CSS scales 4x).
  React.useEffect(() => {
    const canvas = cellCanvasRef.current;
    if (!canvas) return;
    if (!current) { canvas.width = 1; canvas.height = 1; return; }
    canvas.width = current.cellW;
    canvas.height = current.cellH;
    const ctx = canvas.getContext('2d');
    const bytes = new Uint8ClampedArray(current.cellRgba);
    ctx.putImageData(new ImageData(bytes, current.cellW, current.cellH), 0, 0);
  }, [current]);

  // Paint the source-frame JPEG + orange bbox overlay.
  React.useEffect(() => {
    const canvas = frameCanvasRef.current;
    if (!canvas || !current || !current.sourceFrameJpeg) return;
    let cancelled = false;
    (async () => {
      try {
        const bmp = await createImageBitmap(current.sourceFrameJpeg);
        if (cancelled) return;
        canvas.width  = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const b = current.bboxInSourceFrame;
        if (b) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#ff9500';
          ctx.shadowColor = 'rgba(255,149,0,0.6)';
          ctx.shadowBlur = 8;
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
      } catch (e) {
        console.warn('[teach-zone] source frame paint failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [current]);

  // Autofocus the input whenever we advance to a new capture.
  React.useEffect(() => {
    if (current && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [current && current.id]);

  const reload = React.useCallback(async () => {
    if (!window.CaptureQueue) return;
    let next;
    if (filterCard) {
      const matches = await window.CaptureQueue.list({
        status: 'pending', topGuess: filterCard, limit: 1 });
      next = matches[0] || null;
    } else {
      next = await window.CaptureQueue.head();
    }
    const rec = await window.CaptureQueue.recent(4);
    setCurrent(next);
    setRecent(rec);
  }, [filterCard]);

  const submitLabel = async () => {
    if (!current || !matcher) return;
    let card;
    try {
      card = window.PokerEngine.normalizeCard(labelInput.trim());
    } catch (e) {
      setLabelError(e.message);
      return;
    }
    setLabelError(null);
    try {
      matcher.teach(card, new Uint8Array(current.cellRgba), current.cellW, current.cellH);
      setTemplateCount(matcher.size);
      await window.CaptureQueue.markLabeled(current.id, card);
      const { dropped } = await window.CaptureQueue.dropIfMatcherKnowsNow(matcher, 0.85);
      if (dropped > 0 && onAutoResolved) onAutoResolved(dropped);
      setLabelInput('');
      await reload();
    } catch (e) {
      console.warn('[teach-zone] label failed:', e);
      setLabelError(e.message || 'label failed');
    }
  };

  const handleBack = async () => {
    if (!window.CaptureQueue) return;
    const reverted = await window.CaptureQueue.undoLast();
    if (!reverted) return;
    const lastLabel = (reverted.labelHistory || [])
      .filter((e) => e.action === 'label')
      .pop();
    if (lastLabel && lastLabel.card && matcher) {
      matcher.forget(lastLabel.card);
      setTemplateCount(matcher.size);
    }
    setLabelInput('');
    setLabelError(null);
    await reload();
  };

  const handleSkip = async () => {
    if (!current || !window.CaptureQueue) return;
    await window.CaptureQueue.markSkipped(current.id);
    await reload();
  };

  const handleTrash = async () => {
    if (!current || !window.CaptureQueue) return;
    await window.CaptureQueue.markTrashed(current.id);
    await reload();
  };

  const capturedTs = current ? new Date(current.ts).toTimeString().slice(0, 8) : '';
  const hasLabeled = recent.some((r) => r.status === 'labeled');

  return (
    <section className="lot-panel lot-teach-zone-panel">
      <header className="lot-panel-h">
        <div className="lot-panel-title">Teach Zone</div>
        <div className="lot-panel-meta">
          {filterCard
            ? <>filter: <b style={{ color: 'var(--warn)' }}>{filterCard}</b></>
            : current ? `pending ${current.regionId} · slot ${current.cellIndex}` : 'queue empty'}
        </div>
      </header>
      <div className="lot-teach-zone">
        <div className="lot-teach-cell-col">
          <div className="lot-teach-zone-l">what the matcher sees</div>
          <div className="lot-teach-cell-wrap">
            {current
              ? <canvas ref={cellCanvasRef} className="lot-teach-cell-canvas" />
              : <div className="lot-teach-empty">queue empty — play a hand or draw the my_Hand / the_Board regions to start capturing</div>}
          </div>
          {current && (
            <div className="lot-teach-cell-caption">
              captured {capturedTs} · {current.regionId} · slot {current.cellIndex}
              {current.matcherTopGuess && (
                <span className="lot-gs-dim">
                  {' '}· matcher guess: {current.matcherTopGuess}
                  {' '}({Math.round((current.matcherConfidence || 0) * 100)}%)
                </span>
              )}
            </div>
          )}
        </div>

        <div className="lot-teach-source-col">
          <div className="lot-teach-zone-l">source frame · {capturedTs || '—'}</div>
          <div className="lot-teach-source-wrap">
            {current && current.sourceFrameJpeg
              ? <canvas ref={frameCanvasRef} className="lot-teach-source-canvas" />
              : <div className="lot-teach-empty">no source frame</div>}
          </div>
          {current && (
            <div className="lot-teach-source-caption">
              orange-outlined card is the one being labeled
            </div>
          )}
        </div>

        <div className="lot-teach-label-col">
          <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                  disabled={!hasLabeled}
                  onClick={handleBack}>
            ← BACK · undo last
          </button>
          <div className="lot-teach-zone-l">label</div>
          <input ref={inputRef}
                 className="lot-teach-label-input"
                 type="text"
                 value={labelInput}
                 disabled={!current}
                 placeholder="Kh"
                 onChange={(e) => { setLabelInput(e.target.value); setLabelError(null); }}
                 onKeyDown={(e) => { if (e.key === 'Enter') submitLabel(); }} />
          {labelError && <div className="lot-gs-bad lot-teach-label-error">{labelError}</div>}
          <button className="lot-btn lot-btn-fire lot-btn-tiny"
                  disabled={!current}
                  onClick={submitLabel}>
            LABEL → NEXT
          </button>
          <div className="lot-teach-row-actions">
            <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                    disabled={!current} onClick={handleSkip}>SKIP</button>
            <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                    disabled={!current} onClick={handleTrash}>TRASH</button>
          </div>
          {recent.length > 0 && (
            <>
              <div className="lot-teach-zone-l">recent — click to fix</div>
              <ul className="lot-teach-recent">
                {recent.map((r, idx) => {
                  const last = (r.labelHistory || [])
                    .filter((e) => e.action === 'label' || e.action === 'relabel').pop();
                  const card = last && last.card;
                  const isRed = card && (card[1] === 'h' || card[1] === 'd');
                  const tStr = new Date(last ? last.ts : r.ts).toTimeString().slice(0, 8);
                  return (
                    <li key={r.id}
                        className={'lot-teach-recent-row' + (idx === 0 ? ' lot-teach-recent-row-newest' : '')}
                        onClick={() => idx === 0 ? handleBack() : setRelabelTarget(r)}>
                      <span className={'lot-tpl-pill ' + (isRed ? 'lot-tpl-red' : 'lot-tpl-black')}>
                        {card ? card[0] + (SUIT_GLYPH[card[1]] || '?') : '—'}
                      </span>
                      <span className="lot-gs-dim">{tStr}</span>
                      {idx === 0 && <span className="lot-teach-undo-hint">UNDO ↺</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      {relabelTarget && (
        <RelabelBanner record={relabelTarget}
                       matcher={matcher}
                       setTemplateCount={setTemplateCount}
                       onClose={() => setRelabelTarget(null)}
                       onCommit={async () => { setRelabelTarget(null); await reload(); }} />
      )}
    </section>
  );
}

function RelabelBanner({ record, matcher, setTemplateCount, onClose, onCommit }) {
  const lastLabel = (record.labelHistory || [])
    .filter((e) => e.action === 'label' || e.action === 'relabel').pop();
  const oldCard = lastLabel ? lastLabel.card : null;
  const [input, setInput] = React.useState(oldCard || '');
  const [err,   setErr]   = React.useState(null);
  const tStr = lastLabel ? new Date(lastLabel.ts).toTimeString().slice(0, 8) : '?';

  const handleRelabel = async () => {
    let newCard;
    try { newCard = window.PokerEngine.normalizeCard(input.trim()); }
    catch (e) { setErr(e.message); return; }
    try {
      if (oldCard && matcher) matcher.forget(oldCard);
      if (matcher) matcher.teach(newCard, new Uint8Array(record.cellRgba), record.cellW, record.cellH);
      if (setTemplateCount && matcher) setTemplateCount(matcher.size);
      await window.CaptureQueue.markLabeled(record.id, newCard);
      onCommit();
    } catch (e) {
      setErr(e.message || 'relabel failed');
    }
  };

  const handleForget = async () => {
    try {
      if (oldCard && matcher) {
        matcher.forget(oldCard);
        if (setTemplateCount) setTemplateCount(matcher.size);
      }
      await window.CaptureQueue.markSkipped(record.id);
      onClose();
      if (onCommit) onCommit();
    } catch (e) {
      setErr(e.message || 'forget failed');
    }
  };

  return (
    <div className="lot-teach-relabel">
      <div className="lot-teach-relabel-head">
        <span className="lot-teach-relabel-mark">⚠</span>
        <span>RELABEL <b>{oldCard || '?'}</b></span>
        <span className="lot-gs-dim">
          labeled {tStr} · template will be overwritten when you submit
        </span>
      </div>
      <div className="lot-teach-relabel-body">
        <input className="lot-teach-label-input"
               type="text" value={input}
               onChange={(e) => { setInput(e.target.value); setErr(null); }}
               onKeyDown={(e) => { if (e.key === 'Enter') handleRelabel(); }} />
        {err && <span className="lot-gs-bad">{err}</span>}
        <button className="lot-btn lot-btn-fire    lot-btn-tiny" onClick={handleRelabel}>RELABEL</button>
        <button className="lot-btn lot-btn-danger  lot-btn-tiny" onClick={handleForget}>FORGET</button>
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={onClose}>CANCEL</button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// SettingsPopover — OCR sliders, turn-regex, templates + backup, all in one
// anchored panel triggered from the footer.
// ───────────────────────────────────────────────────────────────────────────
function SettingsPopover({
  onClose,
  interval, setIntervalMs,
  preprocess, setPreprocess,
  binarizeThreshold, setBinarizeThreshold,
  ocrMaxWidth, setOcrMaxWidth,
  turnPattern, setTurnPattern,
  matcher, templateCount, setTemplateCount,
  teachAttempts, lastTeachAt,
  digitMatcher, digitCount, setDigitCount, potPrefill, onTeachDigits, onSmokeDigits,
}) {
  // Close on Escape or outside-click.
  const rootRef = React.useRef(null);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Defer outside-click attach to avoid the same click that opened the popover.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  return (
    <div className="lot-popover lot-popover-settings" ref={rootRef}>
      <div className="lot-popover-h">
        <span className="lot-popover-title">SETTINGS</span>
        <button className="lot-popover-close" onClick={onClose}>×</button>
      </div>
      <div className="lot-popover-body">
        <div className="lot-settings-row">
          <div className="lot-settings-l">OCR interval</div>
          <input type="range" min="100" max="1500" step="50"
                 value={interval} onChange={(e) => setIntervalMs(+e.target.value)} />
          <div className="lot-settings-v">{interval} ms</div>
        </div>
        <div className="lot-settings-row">
          <label className="lot-gs-check" style={{ gap: 4 }}>
            <input type="checkbox" checked={preprocess}
                   onChange={(e) => setPreprocess(e.target.checked)} />
            <span>PREPROCESS (invert+binarize)</span>
          </label>
        </div>
        <div className="lot-settings-row">
          <div className="lot-settings-l">binarize threshold</div>
          <input type="range" min="60" max="200" step="2"
                 value={binarizeThreshold}
                 onChange={(e) => setBinarizeThreshold(+e.target.value)}
                 disabled={!preprocess} />
          <div className="lot-settings-v">{binarizeThreshold}</div>
        </div>
        <div className="lot-settings-row">
          <div className="lot-settings-l">OCR max width</div>
          <input type="range" min="400" max="3500" step="100"
                 value={ocrMaxWidth}
                 onChange={(e) => setOcrMaxWidth(+e.target.value)} />
          <div className="lot-settings-v">{ocrMaxWidth} px</div>
        </div>
        <div className="lot-settings-row lot-settings-row-stack">
          <div className="lot-settings-l">turn detector regex</div>
          <input className="lot-settings-input" type="text" value={turnPattern}
                 onChange={(e) => setTurnPattern(e.target.value)} />
        </div>

        <TemplatesPanel matcher={matcher}
                        templateCount={templateCount}
                        setTemplateCount={setTemplateCount}
                        teachAttempts={teachAttempts}
                        lastTeachAt={lastTeachAt}
                        digitMatcher={digitMatcher}
                        digitCount={digitCount}
                        setDigitCount={setDigitCount}
                        potPrefill={potPrefill}
                        onTeachDigits={onTeachDigits}
                        onSmokeDigits={onSmokeDigits} />
        <TemplateBackupSection matcher={matcher}
                               templateCount={templateCount}
                               setTemplateCount={setTemplateCount} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Slide-up modals for RAW OCR + EVENTS panels.
// ───────────────────────────────────────────────────────────────────────────
function ModalShell({ title, onClose, children }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lot-modal-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="lot-modal lot-modal-bottom">
        <div className="lot-modal-h">
          <span className="lot-modal-title">{title}</span>
          <button className="lot-popover-close" onClick={onClose}>×</button>
        </div>
        <div className="lot-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}
function RawOcrModal({ regionText, regions, onClose }) {
  return (
    <ModalShell title="RAW OCR OUTPUT" onClose={onClose}>
      <RawOCRPanel regionText={regionText} regions={regions} />
    </ModalShell>
  );
}
function EventsModal({ events, onClose }) {
  return (
    <ModalShell title="PARSED EVENTS" onClose={onClose}>
      <EventsPanel events={events} />
    </ModalShell>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// RegionToolbar — compact strip above the live feed for region add / preset.
// Full region editing (per-region sliders, naming) remains accessible by
// expanding the existing RegionsEditor inside VideoPreview's controls area.
// ───────────────────────────────────────────────────────────────────────────
function RegionToolbar({ regions, setRegions }) {
  const nextColor = () => REGION_COLORS[regions.length % REGION_COLORS.length];
  const addDefault = () => {
    if (regions.length >= MAX_REGIONS) return;
    const idx = regions.length;
    setRegions([...regions, {
      id: 'r' + Date.now(),
      name: idx === 0 ? 'chat' : idx === 1 ? 'the_Board' : idx === 2 ? 'my_Hand' : 'turn',
      color: nextColor(),
      x: 0.2, y: 0.2, w: 0.4, h: 0.2,
    }]);
  };
  const addTurnPreset = () => {
    if (regions.length >= MAX_REGIONS) return;
    setRegions([...regions, {
      id: 'turn' + Date.now(),
      name: 'turn',
      color: nextColor(),
      x: 0.30, y: 0.86, w: 0.45, h: 0.12,
    }]);
  };
  const hasTurn = regions.some((r) => /turn/i.test(r.name || ''));
  return (
    <div className="lot-region-toolbar">
      <span className="lot-region-toolbar-l">OCR REGIONS ({regions.length}/{MAX_REGIONS})</span>
      <button className="lot-btn lot-btn-secondary lot-btn-tiny"
              onClick={addDefault} disabled={regions.length >= MAX_REGIONS}>
        + ADD
      </button>
      <button className="lot-btn lot-btn-secondary lot-btn-tiny"
              onClick={addTurnPreset}
              disabled={regions.length >= MAX_REGIONS || hasTurn}
              title="drops a region pre-positioned over the action buttons">
        + TURN ZONE
      </button>
      <span className="lot-region-toolbar-hint">drag on the live feed to draw · edit in Settings</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Footer — capture-mode label, missing-card chips, RAW OCR / EVENTS /
// SETTINGS buttons.
// ───────────────────────────────────────────────────────────────────────────
const ALL_CARDS = (() => {
  const out = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') out.push(r + s);
  return out;
})();
function Footer({ matcher, templateCount, filterCard, setFilterCard,
                  queueTick, onRawOcr, onEvents, onSettings }) {
  const learned = matcher ? new Set(matcher.list()) : new Set();
  const missing = ALL_CARDS.filter((c) => !learned.has(c));
  const VIS = 8;
  const shown = missing.slice(0, VIS);
  const more  = Math.max(0, missing.length - VIS);
  const [pendingCount, setPendingCount] = React.useState(0);
  React.useEffect(() => {
    if (!window.CaptureQueue) return;
    let alive = true;
    window.CaptureQueue.count('pending')
      .then((n) => { if (alive) setPendingCount(n); })
      .catch(() => {});
    return () => { alive = false; };
  }, [queueTick]);
  return (
    <div className="lot-footer">
      <div className="lot-footer-l">
        <span className="lot-gs-dim">capture mode</span>
        <b style={{ color: 'var(--fg)' }}>auto</b>
        <span className="lot-gs-dim"> · queue {pendingCount} pending</span>
        {missing.length > 0 && (
          <>
            <span className="lot-gs-dim" style={{ marginLeft: 8 }}>missing</span>
            {shown.map((c) => {
              const isRed = c[1] === 'h' || c[1] === 'd';
              const isActive = filterCard === c;
              return (
                <span key={c}
                      className={'lot-missing-chip ' + (isRed ? 'lot-tpl-red' : '')
                                 + (isActive ? ' lot-missing-chip-active' : '')}
                      onClick={() => setFilterCard(isActive ? null : c)}>
                  {c[0]}{SUIT_GLYPH[c[1]] || '?'}
                </span>
              );
            })}
            {more > 0 && <span className="lot-gs-dim">+{more} more</span>}
            {filterCard && (
              <button className="lot-btn lot-btn-secondary lot-btn-tiny"
                      onClick={() => setFilterCard(null)}>clear filter</button>
            )}
          </>
        )}
      </div>
      <div className="lot-footer-r">
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={onRawOcr}>RAW OCR</button>
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={onEvents}>EVENTS</button>
        <button className="lot-btn lot-btn-secondary lot-btn-tiny" onClick={onSettings}>SETTINGS</button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<LiveOCRTest />);