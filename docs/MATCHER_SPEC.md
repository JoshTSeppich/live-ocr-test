# PixelPoker — MATCHER_SPEC

The card matcher is the most complex single component on the table side. It identifies 52 card faces from pixel data using three hash functions and weighted Hamming distance. This document specifies the algorithm, the persistence format, the public API, the failure modes, and why each design choice was made.

**Read first:** `EYES_SPEC.md`. The matcher is the implementation of the `card` instinct.

---

## 1. What it is

The `MultiSignatureMatcher` is a learned lookup table that maps card-cell pixel data to one of 52 card codes (`2c`..`Ah`). It is taught from chat-region ground truth and stores one set of three hashes per card. At match time, it hashes a probe cell three ways and finds the stored card with minimum weighted Hamming distance.

**Why hash-and-compare and not a CNN:**

- The deck is fixed at 52 cards. There is no out-of-distribution problem.
- The poker client renders cards deterministically at fixed size and orientation. There is no rotation/lighting/scale invariance to handle.
- A 384-bit hash compares in microseconds. A CNN would dominate the latency budget.
- The model is built by labeling captures in real time. There's no training step, no GPU, no checkpoint to ship.
- The MTG card detector (hj3yoo, GitHub) demonstrates a 16×16 (256-bit) pHash distinguishes 30,000+ MTG cards. 52 cards is comfortably within that regime.

A single 64-bit pHash would also work for this task — the three-hash scheme is over-engineered for the recognition problem. It is kept because (a) it's already shipped and tested, (b) the failure modes of each hash are different and the weighted combination is empirically robust, and (c) reducing it to one hash is gain only if you also fix the naive width/N cell slicer, which is a bigger lift.

---

## 2. The three hashes

All three are implemented in `engine.js`. All three take `(rgba, w, h)` and return a `Uint8Array(384)`. All three are deterministic.

### 2.1 `hashCardRGBA` (brightness) — `engine.js:828`

- **Grid:** 16 × 24 = 384 cells.
- **Per cell:** compute mean of `max(R, G, B)` across all pixels in the cell.
- **Threshold:** compare each cell's mean against the global per-card mean; output 1 if above, 0 if below.
- **Captures:** luminance/brightness silhouette of the card glyphs.
- **Failure mode:** confuses cards with similar silhouettes (e.g. `A` rotated symmetric shape vs `4`).

### 2.2 `hashCardEdge` (gradients) — `engine.js:927`

- **Grid:** 16 × 24.
- **Per cell:** compute mean gradient magnitude (Sobel-like) across the cell.
- **Threshold:** mean-of-cells.
- **Captures:** where the high-frequency content is — corners, glyph edges, suit-pip outlines.
- **Failure mode:** noisy at low resolutions; small bboxes produce unstable edge maps.
- **Why include it:** catches `A↔4`-shape confusions where the brightness hash fails (both have similar silhouettes, different edge structures).

### 2.3 `hashCardColor` (red dominance) — `engine.js:961`

- **Grid:** 16 × 24.
- **Per cell:** count pixels matching "red-dominant" (`R > 130 ∧ G < 110 ∧ B < 110`) vs "light-dominant" (`R > 160 ∧ G > 160 ∧ B > 160`).
- **Threshold:** which side has more.
- **Captures:** spatial distribution of the red ink. Hearts/diamonds have it; clubs/spades don't.
- **Failure mode:** dim or anti-aliased red at small sizes drops below the R threshold.
- **Why include it:** catches `♥↔♠` confusions where edge and brightness alone can't distinguish the same-shape red-vs-black difference.

### 2.4 Hash dimensions — why 16×24

- 16 wide × 24 tall ≈ the aspect ratio of a poker card (~0.66).
- 384 bits per hash × 3 hashes = 1152 bits per card. 8 KB total for a full 52-card library. Storage is irrelevant.
- 16×24 is fine enough to discriminate glyph shapes, coarse enough to be insensitive to single-pixel jitter.

---

## 3. Matching

`match(rgba, w, h)` returns `{card, distance, confidence}`.

```
combined_distance =
    0.5 × hamming(probe.brightness, stored.brightness)
  + 0.3 × hamming(probe.color,      stored.color)
  + 0.2 × hamming(probe.edge,       stored.edge)
```

- For each stored card, compute `combined_distance`.
- Pick the card with minimum distance.
- Return `{card, distance, confidence}` where `confidence = 1 - distance / 384`.

**Threshold:** the eyes treat `confidence ≥ 0.75` as a successful match. Below that → `null` (no override). At the region-level, **all cells must individually pass 0.75** for the region's parsed cards to be overridden.

**Weights — why these:**

- 0.5 on brightness is the dominant signal; it works on almost every card most of the time.
- 0.3 on color disambiguates suits (red vs black) which brightness can't see.
- 0.2 on edge is the tiebreaker for shape-confusion pairs (`A`/`4`, `5`/`S`, `2`/`Z`).

The weights are not tuned by a learning procedure — they were chosen by hand to match the relative reliability of each hash and have not been revisited. Likely good enough; if you ever want to revisit, the right test is per-card recall on a few hundred labeled captures.

---

## 4. The teach pipeline

Teach fires when **all** of these are true in `handleEvent` at `live-ocr-test.jsx:241`:

1. The event came from the **chat** region (not the card region — would be circular).
2. The event's `raw_cards` all contain real unicode suits (not `?` placeholders, not lowercase fallbacks).
3. A region named like `/hand/` (for hero) or `/board/` (for board cards) exists.

For each card:

```js
matcher.teach(card, cells[i].imageData, cells[i].w, cells[i].h)
```

`teach()` **overwrites**. Re-teaching a card replaces the old template, doesn't blend. No averaging across captures. This is a known limitation (see EYES_SPEC §7 "non-goals").

After teaching, three pieces of UI state update:
- `templateCount` → `matcher.size`
- `teachAttempts` → +1 (proves the pipeline is alive even when count plateaus)
- `lastTeachAt` → timestamp (drives the "+N learned" toast)

**The bootstrap coupon-collector problem:** by Bayes, getting all 52 cards taught from random hands averages ~30–40 hands without a manual teach UI. The Teach UI in v2 short-circuits this by letting the user label a queued capture against a known card code.

---

## 5. The match pipeline (overriding OCR)

In `handleEvent` at `live-ocr-test.jsx:285`. Fires when **all** of these are true:

1. The event came from `my_Hand` or `the_Board` (not chat).
2. The matcher has at least one template (`size > 0`).
3. The region slices cleanly into the expected number of cells.

The handler:

1. Slices the region into cells (`cardCellsFromRegion`, `live-ocr-test.jsx:492`).
2. Hashes each cell and calls `matcher.match()`.
3. If **every** match returns `confidence ≥ 0.75`, **overwrites `parsed.cards`** with the matched card codes.
4. Sets `parsed.fromTemplate = true` and `parsed.templateConfidence = min(per-cell confidences)`.

This bypasses Tesseract's struggles with card art entirely once templates are dense.

---

## 6. Strict mode

`engine.decide()` (in v1 — not in v2) accepted `state.strictMode`. When true, the engine returned `{action:'wait', reason:'strict: ...'}` unless `state.heroFromTemplate` is true AND (if a board exists) `state.boardFromTemplate` is true.

**In v2 this moves to the brain side** — the brain refuses to decide if `heroFromTemplate` or `boardFromTemplate` is false. The table side surfaces "STRICT BLOCK" in the UI; the human takes over manually.

The principle is unchanged: the bot refuses to play cards it isn't sure of.

---

## 7. Cell slicing — the known weak point

`cardCellsFromRegion` at `live-ocr-test.jsx:492` splits a region's pixels into N evenly-spaced horizontal cells:

```js
const cellW = Math.floor(px.w / n);
// for each i in 0..n-1:
//   extract sub-rectangle [i*cellW .. i*cellW+cellW, full height]
//   return { imageData, w, h } per cell
```

`n = 2` for hero (`my_Hand`); `n = 3 | 4 | 5` for board (flop/turn/river).

**The slicer assumes cards are laid out horizontally and evenly spaced.** It just divides region width by N. If the region includes padding or gaps, cells will include partial adjacent cards, and templates will be polluted.

**Mitigations:**

- Draw regions tightly around just the card faces, no slop.
- Validate after each capture: smoke test in 🃏 Templates collapsible matches every learned card against itself; if any per-cell match is < 0.95 against the same card you taught, the slicer is the suspect.

**Long-term fix (not yet built):** projection-based gap detection. Column-sum the binarized image and find local minima between cards. This is how OpenScrape tablemaps work.

---

## 8. Persistence — schema v1

Templates are serialized to localStorage via `serializeTemplates` / `deserializeTemplates` (`engine.js:1223 / 1271`).

**Format:**

```json
{
  "version": 1,
  "tplWidth": 16,
  "tplHeight": 24,
  "tplBits": 384,
  "cards": {
    "As": {
      "brightness": "base64-encoded Uint8Array(384)",
      "edge": "base64-encoded Uint8Array(384)",
      "color": "base64-encoded Uint8Array(384)"
    },
    ...
  }
}
```

**Validation on load:**
- `version === 1`
- `tplWidth × tplHeight === tplBits` (384)
- Every key in `cards` matches the 52-card vocabulary (`^[2-9TJQKA][shdc]$`)
- Every signature decodes to exactly 384 bytes
- Reject the whole blob if any check fails (don't partially load — corrupted state is worse than fresh)

**Export/import format** for sharing templates between machines: same JSON, downloadable as a file via the manual teach UI's EXPORT button.

---

## 9. The 52 card codes

The matcher vocabulary, enumerated:

```
2c 2d 2h 2s 3c 3d 3h 3s 4c 4d 4h 4s
5c 5d 5h 5s 6c 6d 6h 6s 7c 7d 7h 7s
8c 8d 8h 8s 9c 9d 9h 9s Tc Td Th Ts
Jc Jd Jh Js Qc Qd Qh Qs Kc Kd Kh Ks
Ac Ad Ah As
```

**Rules:**
- Rank is uppercase: `2 3 4 5 6 7 8 9 T J Q K A`.
- Suit is lowercase: `c d h s`.
- No `10` — always `T`.
- No unicode suit glyphs in storage — those are an OCR-side concern; the matcher works in normalized form.
- `normalizeCard(s)` in `engine.js:1191` is the canonical normalizer. Strict — throws on bad input.

---

## 10. Public API

```js
class MultiSignatureMatcher {
  teach(card, rgba, w, h)              // overwrite the template for `card`
  match(rgba, w, h)                    // → {card, distance, confidence} | null
  forget(card)                         // delete a single template
  clear()                              // delete all templates
  get size                             // number of cards currently learned
  serialize()                          // → JSON string (schema v1)
  static deserialize(json)             // → new MultiSignatureMatcher, throws on invalid
}
```

The matcher is pure with respect to the event system. The teach pipeline and match pipeline in `live-ocr-test.jsx` call into it; no events fire from the matcher itself.

---

## 11. Performance

| Operation | Budget | Why |
|---|---|---|
| `teach(card, rgba, w, h)` | < 1 ms | three hashes computed once, stored |
| `match(rgba, w, h)` against full library | ~250 µs | 52 × 3 hashes × 384-bit Hamming each |
| `serialize()` | < 5 ms | base64-encode 156 buffers |
| `deserialize()` | < 10 ms | base64-decode + validate |
| Full library size | ~8 KB | 52 × 3 × 384 bits + key overhead |

These numbers leave plenty of headroom in the 250 ms OCR pass budget. The matcher is not the bottleneck.

---

## 12. Why three hashes instead of one — a longer answer

The strategic benchmark argues 1 hash is sufficient. Both views are correct:

- **From a recognition-rate perspective:** yes, a single 64-bit pHash discriminates 52 cards trivially. Three 384-bit hashes is overkill for the IDENTIFICATION task.
- **From a robustness-to-bad-input perspective:** the three hashes fail differently:
  - Brightness fails on shape-similar pairs at the same suit (`4↔A`).
  - Color fails on shape-similar pairs at different colors (`9↔6`, `Q↔O` if there were Os).
  - Edge fails on low-resolution crops.
  - When all three agree, the result is very robust to a single bad signal (one hash got a noisy cell, the others outvote it).

Specifically: in early debugging, single-hash failure modes were what motivated the multi-hash approach. The user was getting confident-but-wrong matches in specific cells, and each hash by itself had blind spots. The weighted combination eliminated those.

So: if you replace the three-hash scheme with a single pHash and the recognition rate drops, the slicer is probably the culprit, not the hash count. Fix the slicer first.

---

## 13. The smoke test

In v1, the 🃏 Templates collapsible has a **▶ RUN SMOKE TEST** button. It re-matches every learned card against its own stored template and reports per-cell confidence.

- All 52 should match themselves at confidence ≥ 0.95.
- Any card matching itself at < 0.95 → the template is noisy. Re-teach.
- Any card matching a *different* card at confidence ≥ 0.75 → ambiguous templates. Inspect both source captures.

The smoke test is the first thing to run after a fresh bootstrap, before going live.

---

## 14. What's not in scope for the matcher

- **Suit-glyph recovery** — that's in EYES_SPEC §2.7. Same problem domain but operates on a different bbox (the small glyph area next to the rank) and uses different heuristics (pixel-count colour + ink-run shape).
- **Card rotation, scale invariance, perspective** — not needed; cards don't rotate in the poker client.
- **Detecting card backs** (green) — the offline pipeline does this via dominant green-back colour percentage; live integration is pending.
- **Detecting card-slot empty** — same: offline pipeline checks card-white percentage with no rank/suit glyph.

---

## 15. The bootstrap-complete milestone

When **52/52 templates are taught** and the smoke test passes, the matcher is production-ready. The Teach UI transitions to dormant. The eyes' card pipeline runs on template-only override (Tesseract is still computed but its card output is overridden every time).

This is the natural moment to flip strict mode on permanently and to consider the eyes "complete" for the cash-game target. Per-seat opponent cards at showdown are a future expansion using the same matcher.
