# PixelPoker — Eyes & Hands

**Project:** `~/projects/live-ocr-test/`
**Scope of this doc:** how PixelPoker *sees* the poker client (OCR + template matching) and *acts on it* (keystroke daemon). Everything decision-related (`engine.decide`, ranges, equity, opponent profiling) is out of scope here.

The reader after this doc should be able to: understand any OCR or keystroke bug, extend the matcher, swap the decision engine without breaking I/O, or replace the daemon with a different keystroke backend.

---

## 1. What this component is

PixelPoker is a browser-based screen-share OCR app plus a local Node keystroke daemon. The browser reads the poker client through `getDisplayMedia`, parses the chat and the card regions, and emits structured events. When it's hero's turn, the page POSTs to a local daemon that fires AppleScript keystrokes into the poker window.

The component has exactly two responsibilities:

- **EYES** — turn pixels into structured events: cards, actions, blinds, hero's turn signal.
- **HANDS** — turn an `{action, sliderTicks}` request into real keystrokes in the right window at the right time.

What goes between the two — the decision logic — lives in `engine.js` today but is interchangeable. If a different brain (e.g. a CFR policy server) replaces `engine.decide`, the eyes and hands don't change.

---

## 2. File layout

```
~/projects/live-ocr-test/
├── Live OCR Test.html          22 lines     entry point
├── live-ocr.jsx                555 lines    useLiveOCR hook — capture + OCR + grammar
├── live-ocr-test.jsx         1,812 lines    UI shell — regions, teach, match, FIRE
├── live-ocr-test.css          775 lines    component styles
├── styles.css                  42 lines    base styles
├── engine.js                1,322 lines    matcher classes + decision logic
├── engine.test.js             862 lines    custom test runner (decision-side only)
├── daemon.js                  334 lines    Node HTTP keystroke daemon
└── OCR_AND_KEYSTROKE_README.md  360 lines   authoritative system doc
```

**No build step.** `Live OCR Test.html` loads React 18.3.1, Babel-standalone 7.29.0, Tesseract.js 5.1.1, and `engine.js` via raw `<script>` tags. The two `.jsx` files load via `<script type="text/babel">` and are transpiled in-browser. Edit a file, refresh the browser, you're done.

**Of these files, the I/O layer lives in:** `live-ocr.jsx` (capture + Tesseract + chat grammar), the I/O parts of `live-ocr-test.jsx` (region UI, teach pipeline, match pipeline, FIRE button, fireToDaemon), the matcher classes and hash functions in `engine.js` (lines 824–1313), and all of `daemon.js`.

---

## 3. The EYES

### 3.1 Capture

`useLiveOCR` (`live-ocr.jsx:274`) owns the entire capture-and-OCR pipeline. It uses `navigator.mediaDevices.getDisplayMedia({video:{frameRate:15}, audio:false})` to get a `MediaStream`, drops it into a hidden `<video>` element, and samples frames on a timer (`intervalMs`, default 250 ms).

The stream's end event is wired up — when the user revokes the share, the loop bails cleanly via `stop()`.

### 3.2 Regions

The user draws up to 4 rectangles on the captured video. Each is `{id, name, color, x, y, w, h}` with x/y/w/h as **fractions of the video** (so resizing the window doesn't break alignment). Stored at `localStorage['ocr-regions']` (`live-ocr-test.jsx:54, 75`).

`MAX_REGIONS = 4` (`live-ocr-test.jsx:46`). The default seed is a single `chat` region covering the bottom 45% (`live-ocr-test.jsx:47`). The four canonical regions a user typically draws:

| Region name match | Purpose | Parser path |
|---|---|---|
| `chat` | full chat panel | full POKER_GRAMMAR; teaches templates from ground truth |
| `the_Board` | community cards + pot | card extraction + pot regex; template match override |
| `my_Hand` | hero's hole cards | card extraction; template match override |
| `turn` | action button row (`Fold \| Check \| Bet`) | regex match → sets `gameState.actionOnHero = true` |

Region routing is by **substring match on `region.name`** — `regions.find((r) => /hand/i.test(r.name||''))` etc. (`live-ocr-test.jsx:244, 264`). Names matter; renaming `my_Hand` to `cards` will break the teach pipeline silently.

### 3.3 Per-frame two-phase loop (critical detail)

The loop in `useLiveOCR` runs in two phases per pass:

**Phase 1 — draw every region's source + preprocessed canvas from the SAME video frame.** All regions get their pixels captured before any OCR runs.

**Phase 2 — OCR each region sequentially and emit events.**

Each region gets two `OffscreenCanvas`es stored in `canvasMapRef`:
- `source` — full-resolution color crop (used for color-based suit detection)
- `ocr` — downscaled to `ocrMaxWidth` (default 1200 px) and optionally binarized + inverted

**Why two phases:** the older single-phase loop (`draw → OCR → emit` per region in order) had a silent bug. When the chat region emitted a `hero_cards` event, the teach handler reached into the `my_Hand` source canvas — but `my_Hand` hadn't been drawn yet that pass, so pixels were from the previous frame, often the previous hand. Templates got taught with wrong-card pixels under correct labels. The two-phase loop guarantees all source canvases hold same-frame pixels before any handler runs.

If you suspect bad teaches from before this fix, clear templates via the **🃏 Templates** collapsible's **CLEAR ALL** button.

### 3.4 Tesseract config

```js
// live-ocr.jsx:331
const worker = await Tesseract.createWorker('eng', 1, {
  langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
});
await worker.setParameters({
  tessedit_pageseg_mode: '6',  // single uniform block of text
  tessedit_char_whitelist:
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$.:#[]()- ♠♥♦♣',
  user_defined_dpi: '300',
  preserve_interword_spaces: '1',
});
```

Key points:
- **`tessdata_best` LSTM model**, not the default fast model. ~10 MB one-time download, cached in IndexedDB. ~2× more accurate on small/anti-aliased text.
- **OEM = 1** (LSTM only; no legacy heuristic engine).
- **`♠♥♦♣` are in the whitelist** — without them Tesseract drops suit glyphs silently.
- **PSM 6** assumes a single uniform block; works for the chat panel and for tight card regions alike.

### 3.5 Preprocessing — binarize + invert

`binarizeInvert(ctx, w, h, threshold)` at `live-ocr.jsx:258`. Default threshold 128.

The threshold operates on `max(R, G, B)` — the HSV "Value" channel — **not luminance**. This is load-bearing for suits: pure red (255, 0, 0) has luminance ~76, which a naive luminance threshold would drop as background. `max(255, 0, 0) = 255`, so red ink survives.

Output is inverted (light → black, dark → white) because Tesseract was trained on dark-on-light scans, and the poker client renders chat as colored-text-on-dark.

User-tunable sliders (`live-ocr-test.jsx:66-67, 488`):

| Control | Range | Default | Effect |
|---|---|---|---|
| OCR INTERVAL | 100–1500 ms | 250 | pause between OCR passes |
| PREPROCESS | toggle | on | enable binarize+invert |
| threshold | 60–200 | 128 | ink-vs-background cutoff |
| OCR MAX WIDTH | 400–3500 px | 1200 | OCR canvas downscale cap |

The source canvas is always full-res regardless of `ocrMaxWidth` — that's what color-suit recovery samples from.

### 3.6 Color-based suit recovery

Even with the unicode suits in the whitelist, Tesseract often drops or misreads them at small sizes. The recovery pipeline fixes this **after OCR returns** and **before grammar parses**.

`injectColorSuits(data, srcCtx, scale)` walks every OCR word, finds tokens that look like rank-only (1–3 chars starting with `[2-9TJQKA]` with no real unicode suit), and samples pixels just right of the rank on the **source canvas** (the full-color one).

`analyzeSuitGlyph(ctx, bbox)` at `live-ocr.jsx:97` returns `{colour, shape}`:
- **colour**: `'red' | 'black' | null`. Pixel-counts red (R>130, G<110, B<110) vs. light (R>160, G>160, B>160). Whichever wins by 1.2× sets the colour.
- **shape**: max number of horizontal "ink runs" in any row of the suit area. 1 = solid body, 2 = two lobes, 3 = three lobes.

`suitFrom(colour, shape)` at `live-ocr.jsx:135`:

| shape | colour | suit |
|---|---|---|
| ≥ 3 | any | ♣ |
| = 2 | red | ♥ |
| = 2 | black | ♣ (fallback — shape-2 black rare) |
| ≤ 1 | red | ♦ |
| ≤ 1 | black | ♠ |

The patched text then goes to the grammar. So `K 2` (suits dropped) becomes `K♠ 2♥` before any rule fires.

**Failure mode:** at very small or misaligned bboxes, shape detection becomes noisy and ♥/♣ can confuse. The 2-run-black-falls-back-to-club rule is a deliberate band-aid for one direction of that confusion.

### 3.7 Chat grammar

`POKER_GRAMMAR` at `live-ocr.jsx:197` is an ordered list of `{re, build}` rules. Each rule's regex tries against the (preprocessed) line; first match wins; `build(m)` returns a structured event.

Card patterns:
- **`Your cards: <C> <C>`** → `{kind:'hero_cards', cards, raw_cards}`
- **`Dealing Flop: <C> <C> <C>`** → `{kind:'board', street:'flop', cards}`
- **`Dealing Turn: <C> <C> <C> <C>`** → `{kind:'board', street:'turn', cards}` (the poker client repeats the **full** board on each street, not just the new card)
- **`Dealing River: <C> <C> <C> <C> <C>`** → `{kind:'board', street:'river', cards}`

Action patterns (each captures optional `[HH:MM:SS]` timestamp + player + amount):
- `X folds` → `{kind:'fold', who}`
- `X checks` → `{kind:'check', who}`
- `X calls $N` → `{kind:'call', who, amount}`
- `X bets $N` → `{kind:'bet', who, amount}`
- `X raises $N` → `{kind:'raise', who, amount, target}`
- `X wins $N` → `{kind:'win', who, amount}`

Blind posts use a flexible match because the poker client phrases them weirdly:
- `X (any-text) posts (Small|Big) Blind $N` — e.g. `RoloDango skips Straddle and posts Big Blind $0.25 with dead $0.10`

Hand boundaries:
- `Hand #NNNNN` → `{kind:'sys', text}`
- `Dealing cards` → `{kind:'sys', text}`

Pre-grammar text fixups happen in `preprocessLines(text)` (`live-ocr.jsx:170`), which merges multi-line patterns (e.g. `Your cards\nA♠ 5♦` → one line). For hand/board regions, `extractCards(text)` pulls every `[2-9TJQKA][♠♥♦♣shdcT4689]?` match and normalizes to `Rs` form.

### 3.8 Card normalization

`SUIT_MAP` at `live-ocr.jsx:20` handles canonical glyphs **and** common OCR misreads:

| Misread | Maps to |
|---|---|
| `T` (capital letter) | `s` (♠) |
| `9`, `4` | `d` (♦) |
| `6`, `8` | `c` (♣) |
| `S`, `H`, `D`, `C` | lowercase suit |
| Real `♠♥♦♣` | correct suit |

If a rank is found but no recognizable suit follows, `normalizeCard` returns `R?` (rank + `?` placeholder). The grammar builder (`buildHeroCards`, `buildBoardCards`) then `resolveCard()`s placeholders to suits that aren't already taken in this hand, so the engine never sees a `?` suit but is forced to use **unique** suits — important because it prevents the engine from falsely thinking we have a suited combo.

### 3.9 Hero username

`gameState.heroUsername = 'RoloDango'` at `live-ocr-test.jsx:96`. Used by `fireToDaemon` to record the bot's own intent into the hand history with the correct attribution.

The chat grammar does **not** special-case hero by name — it parses all players' actions identically. The username is only used downstream for display and history.

### 3.10 `actionOnHero` — the turn signal

The hero-turn detection lives entirely in the `turn` region.

The turn region's OCR text gets tested against a user-defined regex (`turnPattern`, configurable in the UI). When the regex matches, `gameState.actionOnHero` flips to `true` (`live-ocr-test.jsx:209-217`). When it doesn't match, the flag clears.

After a successful FIRE in auto-mode, `actionOnHero` is explicitly cleared (`live-ocr-test.jsx:564`) so the same turn can't refire — the next "Your turn" detection must re-set it.

This is the entire integration contract for "is it the bot's turn." Any replacement decision engine just reads `gameState.actionOnHero`.

---

## 4. TEMPLATE MATCHING (still EYES)

When the chat grammar can't read suits cleanly, the template matcher steps in. It identifies cards by pixel-pattern hash against templates learned from previous hands.

### 4.1 The three hashes

Templates are **384 bits each** on a 16×24 grid (`TPL_W=16, TPL_H=24, TPL_BITS=384` at `engine.js:824-826`). Three hash functions, all in `engine.js`:

| Function | Line | What it captures |
|---|---|---|
| `hashCardRGBA` | 828 | per-cell brightness (max R,G,B), mean-thresholded → 0/1 |
| `hashCardEdge` | 927 | per-cell mean gradient magnitude → catches A↔4-shape confusions |
| `hashCardColor` | 961 | per-cell red-dominance (R>130, G<110, B<110) vs light-dominance (R>160 all) → catches ♥↔♠ |

All three take `(rgba, w, h)` and return `Uint8Array(384)`. Deterministic, ~microseconds each.

### 4.2 `MultiSignatureMatcher`

At `engine.js:989`. The active matcher in the live path. Stores `{brightness, edge, color}` per card. Persists to `localStorage` (separate key from the legacy `CardTemplateMatcher` at line 864, which is kept around but unused).

**Match scoring** — weighted Hamming distance:

```
combined = 0.5 × hamming(probe.brightness, sig.brightness)
         + 0.3 × hamming(probe.color,      sig.color)
         + 0.2 × hamming(probe.edge,       sig.edge)
```

`match(rgba, w, h)` returns `{card, distance, confidence}` where `confidence = 1 - distance/384`. The override path requires `confidence ≥ 0.75` per cell (`live-ocr-test.jsx:293, 309`).

API: `teach(card, rgba, w, h)`, `match(rgba, w, h)`, `clear()`, `forget(card)`, `get size`.

### 4.3 Cell slicing — `cardCellsFromRegion`

At `live-ocr-test.jsx:492`. Splits a region's pixels into N evenly-spaced horizontal cells:

```js
const cellW = Math.floor(px.w / n);
// for each i in 0..n-1:
//   extract sub-rectangle [i*cellW .. i*cellW+sw, full height]
//   return { imageData, w, h } per cell
```

`n = 2` for hero (my_Hand); `n = 3|4|5` for board (flop/turn/river).

**Critical:** the slicer assumes cards are laid out horizontally and evenly spaced. It just divides region width by N. If the region includes padding or gaps, cells will include partial adjacent cards, and templates will be polluted. Mitigation: draw regions tightly around just the card faces.

### 4.4 Teach pipeline

In `handleEvent` at `live-ocr-test.jsx:241-280`. Teach fires when **all** of these are true:

1. The event came from the **chat** region (not from the card region — would be circular).
2. The event's `raw_cards` all contain real unicode suits (not `?` placeholders, not lowercase fallbacks).
3. A region named like `/hand/` (for hero) or `/board/` (for board cards) exists.

For each card:

```
matcherRef.current.teach(card, cells[i].imageData, cells[i].w, cells[i].h)
```

`teach()` **overwrites**. Re-teaching a card replaces the old template, doesn't blend. No averaging across captures.

After teaching, three pieces of UI state update:
- `templateCount` → `matcher.size` (drives the count in the Templates collapsible)
- `teachAttempts` → +1 per teach call (proves the pipeline is alive even when count plateaus)
- `lastTeachAt` → timestamp (drives the "+N learned" toast)

### 4.5 Match pipeline (override OCR)

In `handleEvent` at `live-ocr-test.jsx:285-320`. Fires when **all** of these are true:

1. The event came from the `my_Hand` or `the_Board` region (not chat).
2. The matcher has at least one template (`size > 0`).
3. The region slices cleanly into the expected number of cells.

The handler:
1. Slices the region into cells.
2. Hashes each cell and calls `matcher.match()`.
3. If **every** match returns `confidence ≥ 0.75`, **overwrites `parsed.cards`** with the matched card codes.
4. Sets `parsed.fromTemplate = true` and `parsed.templateConfidence = min(per-cell confidences)`.

This bypasses Tesseract's struggles with card art entirely once templates are dense.

### 4.6 Strict mode

`engine.decide()` accepts `state.strictMode`. When true, the engine returns `{action:'wait', reason:'strict: ...'}` unless `state.heroFromTemplate` is true AND (if a board exists) `state.boardFromTemplate` is true.

The bot refuses to play cards it isn't sure of. Toggle in the **⏱ Auto-mode settings** collapsible.

### 4.7 Template I/O — export and import

`engine.js:1186-1295`. Pure additive helpers — they don't touch matcher internals. Used by the manual-teach UI and engine.test.js round-trip tests.

Helpers:
- `normalizeCard(s)` (1191) — strict 2-char card codes: rank uppercased, suit lowercased; throws on bad input
- `parseCardList(s)` (1200) — comma-separated card list with dedupe; throws on duplicates
- `regionIdForCardCount(n)` (1214) — 2 → `'my_Hand'`; 3/4/5 → `'the_Board'`; throws otherwise
- `serializeTemplates(matcher)` (1223) — emits schema-v1 JSON
- `_validateImportedTemplates(payload)` (1240) — strict schema validation: 384-length arrays of 0/1 only
- `deserializeTemplates(matcher, payload, strategy)` (1271) — `strategy: 'merge' | 'replace'`; returns `{added, skipped, total}`

**Schema v1:**

```json
{
  "schema_version": 1,
  "captured_at": "2026-05-21T22:41:26.000Z",
  "template_count": 32,
  "templates": {
    "As": { "brightness": [0,1,0,...384 entries], "edge": [...], "color": [...] },
    "Kh": { ... },
    ...
  }
}
```

Reads-back round-trip cleanly. Validation is strict — any non-0/1 entry, wrong length, or unknown card code throws.

### 4.8 What's NOT built

- **Manual teach UI in the React app.** The I/O helpers shipped to `engine.js`, but as of this writing there is no UI surface in `live-ocr-test.jsx` that calls `parseCardList` + `cardCellsFromRegion` to teach the current frame. Without it, populating the 52 templates still requires sitting through hands (~30–40 hands for full coverage by coupon-collector). README §2.8 sketches it as a ~30-line feature.
- **Template averaging.** Re-teaching overwrites. One bad capture stays bad until a clean re-see overwrites it.
- **Per-card cell segmentation.** Current slicer is `width/N`. No projection-based gap detection.

---

## 5. The HANDS

### 5.1 `daemon.js` — what it is

A pure-Node HTTP server. **No npm dependencies.** Listens on `127.0.0.1:9001`. Sends macOS keystrokes via `osascript` (AppleScript). Requires Accessibility permission on the terminal running it — first real keystroke triggers the system prompt.

Run:

```bash
cd ~/projects/live-ocr-test
node daemon.js                                        # live, no focus guard
node daemon.js --dry-run                              # log only, no keystrokes
node daemon.js --app="Google Chrome" --tab="NLHE"     # only fire when Chrome is frontmost
                                                      # AND active tab title contains "NLHE"
```

Flags:
- `--app=<name>` — frontmost macOS app must match exactly (case-sensitive).
- `--tab=<substring>` — frontmost tab title must contain this (case-insensitive). Only meaningful for browsers the daemon knows: Chrome, Brave, Edge, Arc. (Safari is queryable but tab-titled differently. Firefox can't be queried via AppleScript without an extension.)
- `--dry-run` — log commands and the generated AppleScript without executing them.

### 5.2 HTTP API

```
GET  /health   → 200 {ok, dryRun, port, ts, appGuard, tabGuard}
GET  /focus    → 200 {ok, app, tab}     // queries frontmost app + tab title
POST /act      → 200 {ok, switchedBack} // on success
                 423 {ok:false, error:'focus mismatch', reason, app, tab}
                 400 {ok:false}          // bad json / unknown action
                 500 {ok:false, error}   // osascript failed
```

`POST /act` body:

```json
{ "action": "fold|call|check|raise|bet|allin|foldview|double",
  "sliderTicks": 0,
  "label": "optional freeform tag for the daemon log" }
```

CORS is permissive (`Access-Control-Allow-Origin: *`). The body is capped at 1 KB — anything larger destroys the connection. The daemon binds to `127.0.0.1` only, so it's not exposed to the network.

### 5.3 Action → keystroke mapping

`scriptFor(action, sliderTicks)` at `daemon.js:186`. macOS hardware key codes:

```
KC_LEFT  = 123       KC_RIGHT = 124
KC_DOWN  = 125       KC_UP    = 126
```

Mapping (the comment "Ghost-mode keybindings" at `live-ocr-test.jsx:6` shows the source — these are the poker client's own configured shortcuts):

| `action` | AppleScript | UI label |
|---|---|---|
| `fold` | `key code 123 using command down` | `⌘ ←` |
| `check` / `call` | `key code 125 using command down` | `⌘ ↓` |
| `bet` / `raise` | `key code 124 using command down` | `⌘ →` |
| `double` | `key code 126 using command down` | `⌘ ↑` |
| `foldview` | `key code 123 using {command down, shift down}` | `⇧ ⌘ ←` |
| `allin` | `keystroke "0" using control down` | `⌃ 0` |

Any other action → `scriptFor` returns null → 400 "unknown action".

### 5.4 Slider ticks (bet sizing)

If `sliderTicks` is non-zero, slider lines are prepended to the action keystroke:

```
keystroke "+" using control down    (if sliderTicks > 0)
delay 0.02
... repeated |sliderTicks| times, capped at 50 ...
key code 124 using command down     (the raise/bet)
```

Each slider tick is followed by `delay 0.02` (20 ms). Safety cap: `Math.min(50, Math.abs(sliderTicks))`. The mapping from "bet size in BB" to "slider ticks" lives on the browser side (`fireToDaemon` and `SuggestedActionPanel.sliderTicks`):

```js
const above = decision.sizeBB - (gameState.toCallBB > 0 ? gameState.toCallBB * 2 : 2);
return Math.max(0, Math.round(above * 2));
```

**This is approximate.** One tick is assumed to be ~0.5 BB above min-raise. Real slider granularity may differ. If bet sizes come out systematically wrong, this is the function to tune or replace with a per-stakes lookup table.

### 5.5 Focus guard

Before any keystroke, `focusCheck()` at `daemon.js:155`:

1. Query the frontmost macOS app: `tell application "System Events" to get name of first application process whose frontmost is true`.
2. If it's a known browser, query the active tab title via that app's AppleScript dictionary.
3. Compare against `APP_GUARD` and `TAB_GUARD` via `focusMatches(app, tab)`.

If both guards are unset, the daemon fires blindly with no switch-back context.

### 5.6 Auto-navigate + switch-back

The killer UX feature. The user sits on the **bot's UI tab** watching templates fill and decisions tick. When the bot fires, the daemon brings the **poker tab** to the front, presses the key, and returns to the **bot tab** — all in ~300–500 ms.

The sequence in `POST /act` (`daemon.js:233-326`):

1. **focusCheck** queries current state.
2. If match → proceed, `original = null`.
3. If mismatch → capture origin (`{app: currentApp, tabIdx: getActiveTabIdx(currentApp)}`), build a navigation AppleScript via `buildNavigationScript(APP_GUARD, TAB_GUARD)` (`daemon.js:103`), run it, wait **200 ms** for focus to settle, re-check.
4. If still mismatch → return 423 with `{error:'focus mismatch', app, tab, reason}`.
5. Run the action AppleScript (`scriptFor(action, sliderTicks)`).
6. If we navigated away from somewhere, wait **120 ms** for the receiving app to finish processing, then call `switchBackTo(original)` to restore the original tab.
7. Return 200 with `{ok:true, switchedBack: !!original}`.

The navigation AppleScript walks all tabs in all windows of the target app, looking for the first whose `title contains` the tab-pattern, and activates it via `set active tab index of w to tabIdx; set index of w to 1`.

Screen capture continues uninterrupted across the switch because `getDisplayMedia` is bound to the **captured window**, not the focused one.

### 5.7 `fireToDaemon` — browser side

At `live-ocr-test.jsx:1163`. Called from two places:
- The **FIRE button** in `SuggestedActionPanel` (when `gameState.actionOnHero` is true; clicking POSTs the current decision).
- The **auto-fire `useEffect`** (when AUTO MODE is on, `actionOnHero` is true, and the decision is non-`wait`). 500 ms cooldown, state-signature dedup so the same situation only fires once.

```js
async function fireToDaemon({ gameState, decision, daemonUrl, setLastFire, label, history }) {
  if (!decision || decision.action === 'wait') return { ok: false };
  const sliderTicks = ...;  // see §5.4
  const payload = { action: decision.action, sliderTicks,
                    label: label || decision.debug?.reason || '' };
  // Record bot intent in hand history BEFORE network call (so it shows up
  // in the timeline even if the daemon refuses — focus mismatch etc.)
  history?.recordEvent({ kind:'bot_decision', who: gameState.heroUsername, action: ..., ... });
  const r = await fetch(daemonUrl + '/act', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await r.json().catch(() => ({}));
  setLastFire({ ok: r.ok, status: r.status, payload, response: json, at: Date.now() });
  return { ok: r.ok, response: json };
}
```

Two notable behaviors:
- **Hand history is updated before the network call**, so the timeline reflects intent even on focus-mismatch refusals.
- **Auto-fire clears `actionOnHero`** on a successful POST (`live-ocr-test.jsx:564`), preventing refire on the same turn.

### 5.8 No feedback loop

The daemon fires and trusts the next OCR pass to confirm the action landed (turn region's "Your turn" text disappears). There is no re-OCR verification step before considering the action complete.

This is fine for typical play and bad for adversarial scenarios (focus shift during the 120 ms settle window, keystroke landing in the wrong app). README §3.7 lists "Fire confirmation" as a planned improvement: briefly OCR the action button area to confirm the row disappeared.

---

## 6. The contract — anything can plug into the middle

The two ends are the contract; everything between them is replaceable.

### 6.1 Eyes side — what the matcher and grammar emit

```
parsed event from chat:
  { kind: 'hero_cards' | 'board' | 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'win' | 'sys',
    cards?: ['As', 'Kd'],          // for hero_cards / board, after template override
    street?: 'flop' | 'turn' | 'river',
    who?: 'PlayerName',
    amount?: 1.50,                  // dollars, decimals supported
    ts?: 'HH:MM:SS',
    raw_cards?: [...],              // pre-normalization, includes '?' placeholders
    fromTemplate?: true,            // matcher overrode the OCR
    templateConfidence?: 0.92,      // min across cells if override fired
    region?: 'chat' | 'the_Board' | 'my_Hand' | 'turn',
    regionName?: 'chat' | ...,
    raw: 'original OCR line',
  }

gameState.actionOnHero: boolean    // set by turn region regex match
gameState.heroUsername: 'RoloDango'
```

### 6.2 Hands side — what the daemon expects

```
POST /act
  { action: 'fold' | 'call' | 'check' | 'raise' | 'bet' | 'allin' | 'foldview' | 'double',
    sliderTicks?: integer (signed, capped at ±50),
    label?: 'string' }
```

Anything that produces this payload can drive the daemon. The browser's `fireToDaemon` is one client; a Python script could be another. A CFR policy server would expose its own `/decide` endpoint that returns `{action, sliderTicks}`, and `fireToDaemon` would call that first, then call `/act` with the result.

The decision engine sits **between** the parsed event stream and `fireToDaemon`. Replacing `engine.decide()` requires nothing from the eyes or hands as long as the replacement consumes the parsed event shape and produces the `/act` payload shape.

---

## 7. Reliability gaps — I/O only

### Eyes

- **No per-seat stack OCR.** Hero stack is read from `my_Hand`; opponent stacks are visible on the felt but no region captures them. Any decision engine that needs opponent stacks is currently flying blind.
- **Cell segmentation is naïve** (`width/N`). Regions with padding cause partial-card cells and polluted templates.
- **Templates store one capture per card.** No averaging; bad captures persist until overwritten.
- **Bootstrap requires chat OCR to work.** If chat OCR is unreliable, templates never accumulate.
- **Color-suit recovery confuses ♥↔♣** at shape-2 small bboxes (deliberately hardcoded to fall back to ♣).
- **Anonymized usernames** collide across hands when seat order changes — the chat parser keys players by name string.
- **Coupon collector for templates:** ~30–40 hands for full 52 coverage without manual teach UI.
- **OCR interval too high** loses lines in fast multi-way pots.

### Hands

- **Slider-tick → BB mapping is approximate** (`above * 2`, rounded). Systematically off bets are this function's fault.
- **AppleScript tab queries are slow** (~50–100 ms each). Adds latency to every fire.
- **200 ms post-nav wait is empirical.** Too short → keystroke lands in wrong tab; too long → user perceives lag.
- **Switch-back assumes single window per app.** Multi-window setups confuse `set index of front window to 1`.
- **`--app=` is case-sensitive** and must exactly match `System Events` output (`"google chrome"` ≠ `"Google Chrome"`).
- **Tab title must reliably contain the `--tab=` substring.** Keep it short and stable across game states.
- **No fire confirmation.** Daemon trusts the keystroke landed; doesn't re-OCR to verify.
- **Accessibility permission is required** for the terminal running the daemon; first real keystroke triggers the system prompt.

### Testing

- **`engine.test.js` covers zero OCR and zero keystroke behavior.** All tests target the hand evaluator, ranges, `decide()`, and the new `normalizeCard`/`parseCardList`/template I/O helpers. The eyes and hands are not under test.
- Custom test runner using a homegrown `ok(label, cond)` / `near(label, actual, target, tol)` style. Run with `node engine.test.js`. Exits non-zero on any assertion failure.

---

## 8. Operational runbook

### Start order

```bash
# Terminal 1 — static server for the browser app
cd ~/projects/live-ocr-test && python3 -m http.server 8000

# Terminal 2 — keystroke daemon (needs macOS Accessibility permission)
cd ~/projects/live-ocr-test && node daemon.js --app="Google Chrome" --tab="NLHE"

# Browser
open http://localhost:8000/Live%20OCR%20Test.html
# 1. Click CONNECT FEED, pick the Chrome window with the poker game
# 2. Draw 4 regions named: chat, the_Board, my_Hand, turn
# 3. Watch the CARDS counter in top bar climb as you play
# 4. Click ▶ RUN SMOKE TEST in 🃏 Templates collapsible to sanity-check the matcher
# 5. Once templates are dense (≥40/52), flip AUTO MODE ON
```

### Sanity checks before each session

- **`GET http://127.0.0.1:9001/health`** — daemon up, dry-run state, guards configured as expected.
- **`GET http://127.0.0.1:9001/focus`** — confirms AppleScript can query the frontmost app.
- **Template count** — visible in 🃏 Templates. If <30, expect strict mode to block decisions.
- **OCR loop FPS** — visible in the status header. ~3–4 fps is normal at 250 ms interval. Drop below ~1 fps means regions are too large or `ocrMaxWidth` too high.
- **Drop a known hand through the chat region** — verify events parse correctly in the Events panel before going live.

### Diagnostic surfaces in the UI

- **Raw OCR Panel** — shows literal Tesseract output per region. First place to look when grammar isn't matching.
- **Events Panel** — parsed event stream, last 200 events.
- **🃏 Templates collapsible** — count, learned/missing pills, smoke test, CLEAR ALL.
- **`/focus` polling badge** (if surfaced) — shows current frontmost app + tab.

### Clean shutdown

1. Toggle AUTO MODE off.
2. Disconnect feed.
3. Ctrl-C the daemon.
4. Stop the static server.

---

## 9. File-line index (the things in this doc)

| Concept | File | Line |
|---|---|---|
| `useLiveOCR` hook | `live-ocr.jsx` | 274 |
| Two-phase loop | `live-ocr.jsx` | inside `loop()` |
| `binarizeInvert` | `live-ocr.jsx` | 258 |
| `analyzeSuitGlyph` / `suitFrom` | `live-ocr.jsx` | 97 / 135 |
| `injectColorSuits` | `live-ocr.jsx` | (window-exported) |
| `POKER_GRAMMAR` | `live-ocr.jsx` | 197 |
| `SUIT_MAP` / `normalizeCard` / `resolveCard` | `live-ocr.jsx` | 20 / 29 / 43 |
| `DEFAULT_REGIONS` | `live-ocr-test.jsx` | 47 |
| `loadRegions` | `live-ocr-test.jsx` | 52 |
| `handleEvent` | `live-ocr-test.jsx` | 198 |
| Turn detection → `actionOnHero` | `live-ocr-test.jsx` | 209 |
| Teach pipeline | `live-ocr-test.jsx` | 241 |
| Match pipeline | `live-ocr-test.jsx` | 287 |
| `cardCellsFromRegion` | `live-ocr-test.jsx` | 492 |
| `fireToDaemon` | `live-ocr-test.jsx` | 1163 |
| `KEYBINDINGS` / `actionToKind` | `live-ocr-test.jsx` | 7 / 19 |
| `SuggestedActionPanel` (FIRE button) | `live-ocr-test.jsx` | 990 |
| `hashCardRGBA` | `engine.js` | 828 |
| `CardTemplateMatcher` (legacy) | `engine.js` | 864 |
| `hashCardEdge` | `engine.js` | 927 |
| `hashCardColor` | `engine.js` | 961 |
| `MultiSignatureMatcher` | `engine.js` | 989 |
| `normalizeCard` / `parseCardList` / `regionIdForCardCount` | `engine.js` | 1191 / 1200 / 1214 |
| `serializeTemplates` / `deserializeTemplates` | `engine.js` | 1223 / 1271 |
| `TPL_W` / `TPL_H` / `TPL_BITS` | `engine.js` | 824 |
| Daemon HTTP routes | `daemon.js` | 233 |
| `scriptFor` (action → AppleScript) | `daemon.js` | 186 |
| `focusCheck` / `focusMatches` | `daemon.js` | 155 / 138 |
| `buildNavigationScript` | `daemon.js` | 103 |
| Key codes (123/124/125/126) | `daemon.js` | 180 |
| README OCR section | `OCR_AND_KEYSTROKE_README.md` | 26 |
| README Template Matching section | `OCR_AND_KEYSTROKE_README.md` | 132 |
| README Daemon section | `OCR_AND_KEYSTROKE_README.md` | 210 |
