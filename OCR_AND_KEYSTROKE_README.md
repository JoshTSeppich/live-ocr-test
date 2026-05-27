# PixelPoker — OCR, Template Matching, and Keystroke Pipeline

This README covers **only** the three subsystems you asked about:
1. The OCR pipeline (how we read the poker table)
2. Template matching (how we recover when OCR fails)
3. The keystroke daemon + auto-focus (how we send actions back to the game)

It is intentionally narrow — the decision engine, opponent profiler, hand history, and bet-sizing tracker are out of scope here.

---

## Context

- **Target:** BetOnline poker (`poker.betonline.ag`) in Chrome. 8-max NLHE at $0.10/$0.25. Anonymized table (`Anonym 1`, `Anonym 5`, ...). Hero's chat handle is `RoloDango`.
- **Constraints:** Competition rules forbid browser extensions / page scripts. So we observe via screen capture (`getDisplayMedia`) and act via OS-level keystrokes. Both BetOnline's standard keyboard shortcuts work (Cmd+Left = fold, Cmd+Down = check/call, Cmd+Right = bet/raise, Ctrl+0 = all-in, Ctrl+'+'/'−' = slider ticks).
- **Project root:** `~/projects/live-ocr-test/`
- **Files relevant to this README:**
  - `Live OCR Test.html` — entry point (loads React via CDN, Babel standalone, Tesseract.js v5)
  - `live-ocr.jsx` — `useLiveOCR` hook + chat grammar + perceptual hashes + matcher classes
  - `live-ocr-test.jsx` — handler wiring (the React component that consumes `useLiveOCR` and fires teaches/matches/decisions)
  - `daemon.js` — Node HTTP server on `:9001` that delivers keystrokes
- **Serve locally:** `cd ~/projects/live-ocr-test && python3 -m http.server 8000` — `localhost` is a secure context, required for `getDisplayMedia`.

---

## 1. OCR Pipeline

### 1.1 Region model

The user draws up to **4 rectangular regions** on the captured video by click-and-drag. Each region has `{id, name, color, x, y, w, h}` where coordinates are fractions of the video. Persisted to `localStorage['ocr-regions']`. Names are semantically meaningful — the OCR loop checks `region.name` for the substrings `chat`, `hand`, `board`, `turn` to decide what kind of parsing to apply.

A typical setup:
- `chat` — covers the chat panel; runs the full poker grammar
- `the_Board` — covers the community cards + pot; runs card extraction + pot regex
- `my_Hand` — covers the hero's hole cards; runs card extraction
- `turn` — covers the action button row (`Fold | Check | Bet`); triggers `actionOnHero = true` when matched

### 1.2 Per-frame two-phase loop

The OCR loop is in `live-ocr.jsx` inside `useLiveOCR`'s `loop()` function. Critical detail: it runs in **two phases per pass**:

```js
// PHASE 1 — draw EVERY region's source + preprocessed canvas from the SAME video frame
for (const region of regs) {
  // ... compute crop geometry, allocate OffscreenCanvas pair (source + ocr), draw video → source, draw source → ocr (with downscale), binarizeInvert(ocr) ...
  prepared.push({ region, pair, srcCtx, scale });
}

// PHASE 2 — OCR each region sequentially + emit events
for (const { region, pair, srcCtx, scale } of prepared) {
  const { data } = await worker.recognize(pair.ocr);
  // ... color-suit recovery, dedupe, grammar parse, region-specific extraction, emit ...
}
```

**Why two phases:** previously the loop was single-phase (`draw → OCR → emit` per region in order). When the chat region's OCR completed and emitted a `hero_cards` event, the teach handler in `live-ocr-test.jsx` would reach into the `my_Hand` region's source canvas — **but my_Hand hadn't been drawn yet this pass**, so the pixels were from the PREVIOUS frame (often the previous hand). Result: templates got taught with stale pixels under the current hand's labels. The two-phase fix guarantees all source canvases hold same-frame pixels before any event handler runs.

This was a silent data corruption bug. Templates taught before the fix may have wrong-card pixels under correct labels. The fix is in `live-ocr.jsx` around the `loop()` function. If you suspect old bad teaches, the user can click **CLEAR ALL** in the 🃏 Templates collapsible to start fresh.

### 1.3 Per-region preprocessing

Each region gets **two OffscreenCanvases** stored in `canvasMapRef`:
- `source` — full-resolution color crop (used for color-based suit detection)
- `ocr` — downscaled-to-`ocrMaxWidth` (default 1800px) + optionally binarized

The binarize step is in `binarizeInvert(ctx, w, h, threshold)`. Important: it thresholds on `max(R,G,B)` (the HSV "Value" channel), **not luminance**. Reason: pure red (255,0,0) has luminance ~76, below most thresholds, so a naive luminance threshold drops heart/diamond suits entirely. `max(R,G,B)` = 255 for red, so it survives. The output is inverted (light pixels → black ink, dark pixels → white background) because Tesseract was trained on dark-on-light scans.

User-tunable controls (all in `live-ocr-test.jsx` `VideoPreview`):
- **OCR INTERVAL** (100–1500 ms): pause between passes
- **PREPROCESS** (toggle): enable binarize+invert
- **threshold** (60–200): luminance cutoff for ink vs background
- **OCR MAX WIDTH** (400–3500 px): caps OCR canvas width (source always full-res)

### 1.4 Tesseract config

We use Tesseract.js v5 with `eng_best.traineddata` (the high-accuracy LSTM, ~10MB one-time download cached in IndexedDB), OEM=1 (LSTM only, no legacy heuristics), and these `setParameters`:

```js
{
  tessedit_pageseg_mode: '6',  // "Assume a single uniform block of text"
  tessedit_char_whitelist:
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$.:#[]()- ♠♥♦♣',
  user_defined_dpi: '300',
  preserve_interword_spaces: '1',
}
```

The `♠♥♦♣` in the whitelist tells Tesseract those are valid output characters; without them they get dropped silently.

### 1.5 Color-based suit recovery

Even with the whitelist, Tesseract often misreads or drops suit glyphs at small sizes. After the OCR returns, `injectColorSuits(data, srcCtx, scale)` walks each word's bounding box and, for any word that looks like a rank-only token (1–3 chars starting with `[2-9TJQKA]` with no real unicode suit), samples the pixels just to the right of the rank on the **source canvas** (full color). It uses two helpers:

```js
analyzeSuitGlyph(ctx, bbox)  // returns {colour: 'red'|'black'|null, shape: 1|2|3}
  - colour: count "red" pixels (R>130, G<110, B<110) vs "light" pixels (R>160, G>160, B>160)
  - shape:  max number of horizontal "ink runs" in any row of the suit area
```

Then `suitFrom(colour, shape)`:
- `shape ≥ 3` → ♣ (club's three-lobe top)
- `shape === 2` → ♥ (heart's two-lobe top with V-cut)
- `shape ≤ 1 + red` → ♦
- `shape ≤ 1 + black` → ♠

This recovery patches the OCR text in place before the grammar runs. So a Tesseract output of `K 2` (suits dropped) becomes `K♠ 2♥` (or whatever the colors actually were) before downstream parsing.

**Limitation:** color sampling needs the source canvas to have the actual pixels. The bbox coords come back in OCR-canvas coords; the helper scales them back via `inv = 1/scale`. If the bboxes are very small or misaligned, shape detection becomes noisy and ♥/♣ can confuse.

### 1.6 Chat grammar

`POKER_GRAMMAR` in `live-ocr.jsx` is an ordered list of `{re, build}` rules. Patterns matter:
- `Your\s+cards?` + cards → `kind: 'hero_cards'`, populates `cards` via `buildHeroCards` (which assigns placeholder suits to any `'?'` and forces them unique)
- `Dealing Flop|Turn|River` + N cards → `kind: 'board'` with `street` and full board cards. BetOnline repeats the whole updated board each street (turn line = 4 cards, river line = 5).
- `X folds|checks|calls|bets|raises $N` → action events with `who` + `amount` (decimals supported)
- `X (any-text) posts (Small|Big) Blind $N` — flexible match because BetOnline uses `"RoloDango skips Straddle and posts Big Blind $0.25 with dead $0.10"`-style strings
- `Hand #NNNNN`, `Dealing cards` → system events

Two pre-processing steps before grammar:
- `preprocessLines(text)` — merges two-line patterns: `Your cards\nA♠ 5♦` becomes one line `Your cards A♠ 5♦` so the regex matches
- `extractCards(text)` for hand/board regions — pulls every `[2-9TJQKA][♠♥♦♣shdcT4689]?` match out of the text and normalizes to `Rs` form

### 1.7 Known failure modes

- **Coloured-on-dark anti-aliasing at small sizes:** Tesseract's accuracy degrades sharply below ~16px tall characters even with preprocessing. Card-art glyphs in the chat are right at that boundary.
- **Anonymized usernames** (`Anonym 5`): the action-by-name grammar still works, but `who` fields collide across hands when seat order changes.
- **Coupon collector for templates:** with 52 unique cards and ~5 cards revealed per hand, you need 30–40 hands to expect full coverage.
- **OCR interval too high → missed events:** chat scrolls fast on multi-way pots; if `intervalMs` is 800+, lines can scroll past before they're captured.

---

## 2. Template Matching

### 2.1 Why

Tesseract is fundamentally weak at game-UI card art (rendered glyphs, anti-aliasing, color text). The chat-OCR pipeline above only gets us partway. The template matcher is the safety net: once we've **seen** a card-image labeled correctly (via chat ground truth), we can identify the same card-image again by pixel-pattern hash, bypassing OCR entirely for that card.

### 2.2 Hash design

Three perceptual hashes, all 384 bits each (16×24 grid):

| Hash | Function | Captures |
|---|---|---|
| `hashCardRGBA` | per-cell brightness (max R,G,B), mean-thresholded | overall luminance pattern |
| `hashCardEdge` | per-cell mean gradient magnitude, mean-thresholded | edge structure (catches A↔4 shape confusions) |
| `hashCardColor` | per-cell red-dominance vs light-dominance | suit color (catches ♥↔♠) |

All three are in `engine.js`. Each takes raw RGBA pixel data + width + height and returns a `Uint8Array(384)`. They're deterministic and fast (~µs per hash).

### 2.3 MultiSignatureMatcher

In `engine.js`. The class stores `{brightness, edge, color}` per template, persists to `localStorage['multi-sig-templates']`. Match uses **weighted Hamming distance** across all three signatures:

```js
combined = 0.5 * hammingDistance(probe.brightness, sig.brightness)
         + 0.3 * hammingDistance(probe.color,      sig.color)
         + 0.2 * hammingDistance(probe.edge,       sig.edge);
```

`match(rgba, w, h) → { card, distance, confidence }` where `confidence = 1 - distance/384`. We require **confidence ≥ 0.75** before we trust a match enough to override OCR.

### 2.4 Teach pipeline (bootstrap from chat ground truth)

In `live-ocr-test.jsx`'s `handleEvent`. Teach fires when:
- The event came from the chat region (not the hand/board region — chicken-and-egg)
- The event's `raw_cards` ALL contain real unicode suits (`♠♥♦♣`, not lowercase letters or `?` placeholders)

For each card, `cardCellsFromRegion(handRegion.id, 2)` splits the my_Hand region's source canvas into 2 horizontal cells (or 3/4/5 cells for board) and `matcher.teach(card, cellRGBA, w, h)` stores all three hashes labeled with the chat-confirmed card identity. `teach()` overwrites, so re-teaches refine but don't grow the count.

The two-phase OCR loop (§1.2) is critical here: the my_Hand and the_Board source canvases must be from the **same frame** as the chat region's OCR pixels, otherwise teaches store wrong pixels under correct labels.

### 2.5 Match path (override OCR)

When the my_Hand or the_Board region produces a `hero_cards` / `board` event (via region-specific extraction in §1.6), the handler:
1. Splits the region into cells
2. Hashes each cell
3. Matches each against the template store
4. If **all** matches return `confidence ≥ 0.75`, **overrides the parsed event's `cards`** with the matched cards
5. Sets `parsed.fromTemplate = true` so strict mode knows the cards are template-verified

### 2.6 Strict mode

`engine.decide()` accepts `state.strictMode`. When true, the engine refuses to act (`returns {action:'wait', reason:'strict: ...'}`) unless `state.heroFromTemplate` is true AND (if there's a board) `state.boardFromTemplate` is true. This is the safety stone: the bot never plays a hand it isn't sure of.

UI toggle in the **⏱ Auto-mode settings** collapsible.

### 2.7 Known failure modes

- **Card-cell splitting is naïve** — we just divide the region width by N. If cards have padding or aren't evenly spaced, cells include part of adjacent cards. Workaround: tighten the region to *only* the card faces.
- **Templates store one capture per card** — no averaging across observations. The first time we see Q♠ we capture pixels, and re-seeing Q♠ just overwrites. If the first capture was at a moment of bad pixel rendering, that template stays bad until a clean re-see overwrites.
- **Cross-card confusion when templates are sparse** — with only 24/52, a new card with no template matches to its nearest stored card with some confidence. The 0.75 threshold blocks most false-positives but isn't perfect.
- **Bootstrap requires chat OCR to work** — if chat OCR is unreliable, templates never accumulate. Manual teach UI would bypass this; not built.
- **Per-hand cell snapshot timing** — even with two-phase loop, there's a tiny window between phase-1 draw and the event handler reading the canvas. Frame is the same, but if the source canvas is later read after another OCR pass starts, pixels are stale. Currently safe because handleEvent is synchronous and runs before the next pass starts.

### 2.8 Where to improve

**Highest leverage:**
- **Manual teach UI** — a textbox + button: "These are my current cards: `Q♠ 8♥`" → captures current my_Hand canvas as templates for those cards. Lets the user populate all 52 in ~15 minutes by sitting through hands and labeling each. Bypasses chat-OCR-dependent bootstrap entirely. **~30 lines.**
- **Improved cell segmentation** — instead of `width/N`, do horizontal projection: scan column-by-column for "card pixel density" and find natural gaps between cards. ~50 lines, would help when regions include padding.
- **Template averaging** — when teaching a card already known, blend the new hash with the old (e.g., 50/50) to reduce single-bad-capture damage. ~5 lines.
- **Vision LLM bootstrap** — send unknown card images to Claude's vision API for one-shot labeling. Bypasses chat OCR entirely. ~80 lines + API key. ~$0.005 per call.

**Lower leverage:**
- Per-region threshold tuning (currently global)
- Per-region OCR engine choice (different PSM mode per region)
- Custom-trained Tesseract on synthetic BetOnline card font (~6h training pipeline)

---

## 3. Keystroke Daemon + Auto-Focus

### 3.1 Server

`daemon.js` is a pure-Node HTTP server (no dependencies). Run:

```bash
cd ~/projects/live-ocr-test
node daemon.js --app="Google Chrome" --tab="NLHE"
```

Flags:
- `--app=<name>` — frontmost macOS app must match this (set to your browser's app name)
- `--tab=<substring>` — frontmost tab title must contain this substring (case-insensitive). Only meaningful for browsers we know how to query: Chrome, Brave, Edge, Arc
- `--dry-run` — log commands without executing osascript

Endpoints:
- `GET /health` — daemon status, dry-run flag, guard config
- `GET /focus` — current frontmost app + tab title (uses AppleScript to query)
- `POST /act` — body `{action, sliderTicks?, label?}` — runs focus check, navigates if needed, fires keystroke, switches back

### 3.2 Action mapping

```
fold     → Cmd+Left           (key code 123, command down)
check/call → Cmd+Down         (key code 125, command down)
bet/raise  → Cmd+Right        (key code 124, command down)
double     → Cmd+Up           (key code 126, command down)
foldview   → Shift+Cmd+Left   (key code 123, command+shift down)
allin      → Ctrl+0           (keystroke "0", control down)
sliderTicks > 0 → Ctrl+'+' (n times) before the raise key
sliderTicks < 0 → Ctrl+'-' (n times) before the raise key
```

Each `sliderTicks` keystroke has a 20ms delay between presses (`delay 0.02` in AppleScript). Capped at 50 ticks per fire.

### 3.3 Focus guard

Before any keystroke, the daemon calls `focusCheck()`:
1. Query frontmost app via `osascript: tell application "System Events" to get name of first application process whose frontmost is true`
2. If browser, query active tab title via the app's AppleScript dictionary
3. Compare against `APP_GUARD` and `TAB_GUARD`
4. If match → proceed
5. If mismatch → auto-navigate (next section)
6. If still mismatch after auto-nav → return 423 with `{ok: false, error: 'focus mismatch', app, tab}`

### 3.4 Auto-navigate + switch-back

This is the critical UX feature. The user wants to **sit on the bot UI tab watching templates fill / decisions tick** without losing screen capture continuity. When the bot decides, the daemon:

1. **Captures origin** before navigating:
   ```js
   const origApp = app;
   const origTabIdx = await getActiveTabIdx(app);  // AppleScript: get active tab index of front window
   ```

2. **Navigates to target tab** via `buildNavigationScript(APP_GUARD, TAB_GUARD)`:
   ```applescript
   tell application "Google Chrome"
     activate
     repeat with w in windows
       set tabIdx to 1
       repeat with t in tabs of w
         if (title of t) contains "NLHE" then
           set active tab index of w to tabIdx
           set index of w to 1
           exit repeat
         end if
         set tabIdx to tabIdx + 1
       end repeat
     end repeat
   end tell
   ```

3. **Waits 200ms** for focus to settle, re-checks.

4. **Fires the keystroke** via osascript.

5. **Waits 120ms** for the receiving app to process the keypress.

6. **Switches back to origin** via `switchBackTo({app, tabIdx})` — same AppleScript pattern but using the captured `tabIdx`.

So the visible behavior is: user sees their bot-UI tab; when the bot decides, the poker tab pops to the front for ~300-500ms, the keystroke lands, and then the bot-UI tab returns. Screen capture continues uninterrupted because `getDisplayMedia` is tied to the captured window, not the focused one.

### 3.5 Slider ticks

The engine returns `decision.sizeBB` in big blinds. The page translates this into slider ticks (each tick is approximately 0.5 BB above min-raise, but the actual mapping depends on BetOnline's slider granularity). Code in `live-ocr-test.jsx`'s `fireToDaemon`:

```js
const sliderTicks = (() => {
  if (!decision.sizeBB || (decision.action !== 'raise' && decision.action !== 'bet')) return 0;
  const above = decision.sizeBB - (gameState.toCallBB > 0 ? gameState.toCallBB * 2 : 2);
  return Math.max(0, Math.round(above * 2));
})();
```

This is approximate. If the bet sizes are systematically off, this is the function to tune (or replace with a per-game-state lookup table once you've measured BetOnline's actual slider step in BB).

### 3.6 Known failure modes

- **Tab title doesn't readably contain the configured substring** → guard refuses, auto-nav can't find target. Mitigation: keep `--tab` flag short and stable across game states.
- **AppleScript tab queries are slow** (~50-100ms each) — adds latency to every fire. Acceptable for the bot's tempo but not ideal for real-time.
- **The 200ms post-nav wait is empirical** — too short and the keystroke lands in the wrong tab; too long and the user perceives lag.
- **Focus permissions:** the terminal running `node daemon.js` must have macOS Accessibility permission. First fire that needs to actually send a keystroke triggers the system prompt.
- **Switch-back assumes a single window per app** — if Chrome has multiple windows open, `set index of front window to 1` activates whichever is "front" by Chrome's tracking. Edge case but worth knowing.
- **`--app=` is case-sensitive** and must match exactly what `System Events` returns. Common pitfall: `"google chrome"` won't match `"Google Chrome"`.

### 3.7 Where to improve

- **Calibrate slider-tick → BB mapping** by experiment: fire known-tick counts, observe resulting bet sizes in chat, derive a linear mapping. ~30 lines.
- **Use Chrome DevTools Protocol** instead of AppleScript for tab queries — sub-ms latency vs 50-100ms. Requires Chrome running with `--remote-debugging-port=9222`.
- **Native window detection** for non-browser targets (e.g., a future opponent that's a desktop app). The `buildNavigationScript` for non-browser apps just `activate`s without tab selection.
- **Fire confirmation** — after sending the keystroke, briefly OCR the action button area to confirm the action took effect (button row disappeared = it's no longer our turn). Closes the loop, catches keystroke-didn't-land scenarios.

---

## How to run end-to-end

```bash
# Terminal 1 — server for the bot UI
cd ~/projects/live-ocr-test && python3 -m http.server 8000

# Terminal 2 — daemon (needs Accessibility permission)
cd ~/projects/live-ocr-test && node daemon.js --app="Google Chrome" --tab="NLHE"

# Browser
open http://localhost:8000/Live%20OCR%20Test.html
# 1. Click CONNECT FEED, pick the Chrome window with the poker game
# 2. Draw 4 regions: chat, the_Board, my_Hand, turn
# 3. Verify CARDS counter in top bar climbs as you play
# 4. Click ▶ RUN SMOKE TEST in Templates collapsible to verify matcher health
# 5. Once templates are dense, flip AUTO MODE ON
```

---

## File-line index of the things this README discusses

| What | Where |
|---|---|
| OCR loop (two-phase) | `live-ocr.jsx`, `useLiveOCR.loop()` |
| `binarizeInvert` | `live-ocr.jsx` |
| `injectColorSuits`, `analyzeSuitGlyph`, `suitFrom` | `live-ocr.jsx` |
| `POKER_GRAMMAR`, `preprocessLines`, `extractCards` | `live-ocr.jsx` |
| `hashCardRGBA`, `hashCardEdge`, `hashCardColor` | `engine.js` |
| `MultiSignatureMatcher` class | `engine.js` |
| Teach pipeline | `live-ocr-test.jsx`, `handleEvent` (search "Card template TEACH") |
| Match pipeline | `live-ocr-test.jsx`, `handleEvent` (search "Card template MATCH") |
| Strict mode | `engine.js`, `decide()` |
| Daemon focus + nav + switch-back | `daemon.js` |
| `fireToDaemon` (UI side) | `live-ocr-test.jsx` |
