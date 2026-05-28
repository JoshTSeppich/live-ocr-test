# PixelPoker — EYES_SPEC

The perception contract for the table body. Specifies exactly what the eyes observe, what they emit, what they don't do, and how they fail.

**Read first:** `ARCHITECTURE.md`.

---

## 1. Scope

The eyes have one job: turn pixels into structured events. Outbound only. They never:

- Maintain hand state (that's the brain's job).
- Decide actions (also the brain).
- Infer anything beyond unit conversion (BB normalization, card-code canonicalization).
- Listen for anything from the brain.
- Touch the daemon or the keystroke path.

If something can't be observed cleanly, the eyes either emit an "unknown" variant of the event (e.g. `cards_unknown`) or stay silent. They never guess.

---

## 2. The seven instincts

Each instinct recognizes one thing, returns a structured value, and goes away.

### 2.1 `card` — template match on a card-shaped cell

- **Input:** RGBA pixel buffer of a card-cell crop.
- **Process:** `MultiSignatureMatcher.match()` — three 384-bit hashes (brightness, color, edge), weighted Hamming distance.
- **Output:** `{card: 'As', confidence: 0.92}` or `null` if no match has `confidence ≥ 0.75`.
- **Latency:** ~250 µs per cell.
- **Failure mode:** below threshold → `null` → emit `cards_unknown` event (not `cards`).
- **Reference:** `MATCHER_SPEC.md` for full algorithm.

### 2.2 `name` — Tesseract on a name plate

- **Input:** name-plate sub-region of a seat plate, full-resolution color crop.
- **Process:** Tesseract LSTM with PSM 6, name-character whitelist.
- **Output:** `{name: 'pinata77'}` or `{name: null, raw: 'g4r8a9e'}` if the OCR confidence is low or the result fails plausibility (e.g. <2 chars, all whitespace).
- **Edge case:** opponent anonymization shows `*****`. Detect via character-class check (more than 60% asterisks → emit `{name: null, anonymized: true}`).
- **Edge case:** empty seats show `OPEN SEAT`. Detect via exact string match → emit `{seat_open: true}`.

### 2.3 `stack` — Tesseract + regex on a dollar/BB readout

- **Input:** stack-readout sub-region of a seat plate.
- **Process:** Tesseract LSTM with digit-and-decimal-and-currency whitelist, then regex match.
- **Output:** `{stack_bb: 116.4}` or `null` if no regex match.
- **Normalization:** dollar amounts converted to BB using `currentBigBlind` (see §4). Never emit dollars on the wire; the brain only sees BB.
- **Debouncing:** require two consecutive identical reads ~80 ms apart before emitting. Mid-animation reads return zero or garbage.
- **Empirical:** offline pipeline achieves 100% precision / 78% recall on stacks. The 22% no-emit is the conservative null-instead-of-guess behavior.

### 2.4 `pot` — Tesseract + regex on the pot area

- **Input:** pot-area region (above community cards).
- **Process:** Same pipeline as stack OCR.
- **Output:** `{pot_bb: 14.0}` or `null`.
- **Tracking discipline:** the eyes do NOT maintain a running pot model. The brain reconciles OCR'd pot against the action stream. The eyes emit whatever the OCR returns.
- **Empirical:** 100% precision on visible pots in the offline validation.

### 2.5 `turn indicator` — regex on the action button row

- **Input:** OCR text of the action button area.
- **Process:** regex `/FOLD|CHECK|CALL|RAISE|BET|ALLIN/i`.
- **Output:** boolean `actionOnHero`. Emit `{actionOnHero: true}` when matched, `{actionOnHero: false}` when not.
- **Cadence:** emitted every OCR pass (4 Hz at default interval). The brain debounces on its side.
- **Why on every pass:** silent-state recovery. If a packet drops, the next pass will re-establish state.
- **Empirical:** 100% on the offline validation sample.

### 2.6 `chat line` — 19 ordered grammar rules

- **Input:** OCR text of the chat region, after `preprocessLines()` merges multi-line patterns.
- **Process:** `POKER_GRAMMAR` (in `live-ocr.jsx`) — 19 rules, first match wins.
- **Output:** one of 16 event kinds (see PROTOCOL.md). Examples:
  - `Your cards: As Kd` → `{kind: 'hero_cards', cards: ['As','Kd']}`
  - `Dealing Flop: 7h 8c 9d` → `{kind: 'board', street: 'flop', cards: [...]}`
  - `pinata77 raises $1.50` → `{kind: 'raise', who: 'pinata77', amount_bb: ..., target_bb: ...}`
- **Dedup:** by line hash. Same line in two consecutive frames emits once.
- **Failure mode:** no rule matches → no event. The chat line is silently dropped from the stream.

### 2.7 `suit recovery` — pixel heuristic for the suit glyph

Triggered when Tesseract returns a card-shaped token (rank + ambiguous suit-position) but the suit glyph was dropped or misread.

- **Input:** small bbox to the right of the rank glyph, in the full-color source canvas.
- **Process:** `analyzeSuitGlyph(ctx, bbox)` returns `{colour, shape}`.
  - `colour`: red vs light pixel count, 1.2× ratio threshold.
  - `shape`: max horizontal "ink runs" in any row of the suit area.
- **Mapping** (`suitFrom`):

  | shape | colour | suit |
  |---|---|---|
  | ≥ 3 | any | ♣ |
  | = 2 | red | ♥ |
  | = 2 | black | ♣ (fallback) |
  | ≤ 1 | red | ♦ |
  | ≤ 1 | black | ♠ |

- **Failure mode:** if both colour detection and shape detection are ambiguous → leave the suit as `?` placeholder. The grammar's `resolveCard()` then assigns a suit not already taken in this hand (so the brain never sees a `?` but the resolved suit is guaranteed unique).
- **Known confusion:** ♥/♣ at shape-2 black is deliberately hardcoded to fall back to ♣. This is a one-direction band-aid for noisy small bboxes.

---

## 3. The two-phase per-frame loop

This is the load-bearing detail that prevents wrong-card teaches.

**Phase 1 — draw every region's source + preprocessed canvas from the SAME video frame.** All regions get their pixels captured before any OCR runs.

**Phase 2 — OCR each region sequentially and emit events.**

**Why two phases:** the older single-phase loop (`draw → OCR → emit` per region in order) had a silent bug. When the chat region emitted a `hero_cards` event, the teach handler reached into the `my_Hand` source canvas — but `my_Hand` hadn't been drawn yet that pass, so pixels were from the *previous* frame, often the previous hand. Templates got taught with wrong-card pixels under correct labels. The two-phase loop guarantees all source canvases hold same-frame pixels before any handler runs.

If you suspect bad teaches from before this fix, **clear templates via the 🃏 Templates collapsible's CLEAR ALL button** and re-bootstrap.

Each region gets two `OffscreenCanvas`es stored in `canvasMapRef`:
- `source` — full-resolution color crop (used for color-based suit detection)
- `ocr` — downscaled to `ocrMaxWidth` (default 1200 px) and optionally binarized + inverted.

---

## 4. BB normalization — the eyes-local invariant

Every monetary value on the wire is in **big blinds**, never dollars. The eyes do this conversion before emitting; the brain only ever sees BB.

**How `currentBigBlind` is derived (eyes-local state, not on the wire):**

1. The chat emits a blind-post event: `pinata77 posts Big Blind $0.25`.
2. The eyes parse the dollar amount and update `currentBigBlind = 0.25` (until the next hand boundary or a new BB post overrides).
3. All subsequent monetary events in this hand are converted: `amount_bb = amount_dollars / currentBigBlind`.

**Edge cases:**
- Straddles, dead blinds, posted-blind-out-of-position: the grammar's flexible blind-post rule captures these (`X (any-text) posts (Small|Big) Blind $N`). The Small Blind post is informational; the Big Blind post sets the reference.
- Mid-hand stake changes don't happen in NLHE. If they appeared to, it's an OCR error.
- If no BB has been posted (start of session, before any hand), the eyes do not emit monetary events. They wait.

**Why this lives in the eyes, not the brain:** the brain shouldn't have to know what the stake is. The schema is BB-denominated. Moving the conversion into the eyes makes the brain pure: same `GameStateRequest` shape works at any stake.

---

## 5. Event vocabulary

The eyes can emit 16 event kinds. The full schema lives in `PROTOCOL.md`. Brief catalog:

| Kind | Source instinct | Carries |
|---|---|---|
| `hero_cards` | chat / cards | `cards: [code, code]` |
| `board` | chat / cards | `street, cards: [...]` (full board each street) |
| `fold` | chat | `who` |
| `check` | chat | `who` |
| `call` | chat | `who, amount_bb` |
| `bet` | chat | `who, amount_bb` |
| `raise` | chat | `who, amount_bb, target_bb` |
| `win` | chat | `who, amount_bb` |
| `post_blind` | chat | `who, kind: 'small'|'big', amount_bb` |
| `sys` | chat | `text` (hand boundary markers) |
| `cards_unknown` | cards | `region, top_guesses` |
| `seat_state` | name / stack | `seat, name, stack_bb, in_hand, sit_out, anonymized` |
| `actionOnHero` | turn indicator | `value: bool` |
| `pot` | pot | `pot_bb` |
| `dealer_position` | (offline-derived; live integration pending) | `seat_index` |
| `showdown` | chat | `who, cards` |

**Not yet emitted:**
- `bet_amount_verified` (post-action OCR confirmation) — INTERPRETER_v2 territory.
- `tournament_event` (blind level change, eliminate) — irrelevant for cash play target.

---

## 6. Region naming

Region routing is by **substring match on `region.name`** in `live-ocr-test.jsx`. Names matter; renaming `my_Hand` to `cards` will break the teach pipeline silently.

Canonical region names:

| Name pattern | Purpose | Parser path |
|---|---|---|
| `chat` | full chat panel | full POKER_GRAMMAR; teaches templates from ground truth |
| `the_Board` | community cards + pot | card extraction + pot regex; template match override |
| `my_Hand` | hero's hole cards | card extraction; template match override |
| `turn` | action button row | regex match → `actionOnHero` |
| `seat_N_*` | per-seat regions | (offline pipeline; not yet live) |

`MAX_REGIONS = 4` in v1. The v2 design surfaces per-seat regions explicitly; the offline pipeline at `~/projects/poker-vision-analysis/` produces 8 seat bounding boxes per frame.

---

## 7. What the eyes don't do — explicit non-goals

These are not bugs, they are design choices:

1. **No hand-state accumulation.** Each event is independent. If you ever feel like adding "the eyes track the current betting round," stop — that's the brain's job.
2. **No inference.** If the OCR says "K 2" with no suits, the eyes emit `K?` and `2?`; the grammar resolves to suits that don't collide. The eyes don't guess "probably K♠ because we just saw K♥ in the chat."
3. **No template averaging.** Re-teaching a card **overwrites** the previous template. There is no rolling-average pipeline. The matcher stores one capture per card.
4. **No fire confirmation.** The eyes don't re-OCR the action button area after a fire to confirm the keystroke landed. The next frame's `actionOnHero` going false is the implicit confirmation.
5. **No per-seat turn detection in v1.** Only "is it hero's turn." Per-seat turn (timer rings) was scoped offline and not yet integrated.
6. **No persistent state across reconnects.** When the WebSocket comes back up, the eyes do not replay buffered events. They start fresh.

---

## 8. Failure modes and how each is handled

| Failure | Detection | Response |
|---|---|---|
| Tesseract returns garbage on a known-good region | confidence below per-task threshold | emit `null` value or no event; no guessing |
| Region pixels are mid-animation | two-read debounce disagrees | wait, retry next pass |
| Card template confidence < 0.75 | matcher returns null for that cell | emit `cards_unknown` with top guesses |
| OCR loop FPS drops below 1 fps | header status indicator | user adjusts `ocrMaxWidth` or region sizes |
| Chat region misses the bottom of the panel | events stop emitting | redraw region |
| `currentBigBlind` unset (no BB post seen) | internal state check | suppress monetary events until a BB is posted |
| Color-suit recovery ambiguous | shape and colour both null | leave `?` placeholder; `resolveCard()` assigns unique |

---

## 9. The eyes' public API (v2 sketch)

```js
class Eyes {
  // wiring
  static onEvent(callback)                    // subscribe to outbound events
  static start({stream, regions, intervalMs}) // begin observing
  static stop()                               // clean shutdown of capture + worker

  // state inspection (no side effects)
  static getCurrentBigBlind()                 // returns the eyes' BB reference value
  static getTemplateCoverage()                // returns {learned: N, total: 52}
  static getLastOCRDurationMs()               // diagnostic for the UI status header
}
```

The eyes are stateless from the brain's perspective. Internally they hold `currentBigBlind`, the matcher, and the canvas refs — all of which are reset by `stop()`.

---

## 10. Latency budget — eyes specifically

| Stage | Budget at default settings |
|---|---|
| Frame capture (getDisplayMedia → canvas) | 5 ms |
| Preprocess (binarize+invert, downscale) | 5 ms |
| Tesseract on chat region | 200 ms |
| Tesseract on other regions (combined) | 40 ms |
| Template matcher (per cell × N cells) | 2 ms |
| Grammar (19 rules × N lines) | 1 ms |
| Color-suit recovery (when triggered) | 2 ms |
| **Total per pass** | **~255 ms** |

This matches the default 250 ms interval; the loop is at the edge of keeping up. Raising `ocrMaxWidth` above 1200 px breaks it.

---

## 11. Operational sanity checks

Before each session:

- **OCR loop FPS** ≥ 3 fps visible in the status header.
- **Template coverage** visible in 🃏 Templates. If < 30/52, strict mode will block decisions.
- **Drop a known hand through the chat region** — verify events parse correctly in the Events panel before going live.
- **`currentBigBlind`** has a value (post-first-BB).

---

## 12. What ships in v2

The v2 rebuild:

1. **Preserves** the matcher, grammar, color-suit recovery, Tesseract config, and template I/O helpers unchanged.
2. **Rewrites** the OCR loop wrapper, the React shell, and the event dispatch.
3. **Adds** the WebSocket client (`bot_link.js`), the GameStateRequest builder, and the action translator.
4. **Adds** the Twin and the manual teach UI.
5. **Deletes** the local `engine.js` decision logic (the brain replaces it).

Nothing in this spec changes the substance of what the eyes do. The spec exists to make the contract explicit so the rebuild ships clean.
