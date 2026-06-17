# PIP-CROP GEOMETRY CONTRACT

The suit-pip classifier (`readSuitFromPip`, engine.js Component 4) is **calibrated
to one exact crop**. It is integrated into `MultiSignatureMatcher.match()`, so
**whatever the live card-region path feeds `match()` MUST satisfy this geometry**,
or the suit read is undefined. (Rank/color also assume the same corner-strip crop
— the strip templates are built from it.) This is the spec the live wiring
conforms to; the classifier does not move to fit the live region.

Calibrated against **every clean card instance in the capture corpus** — 704
instances: 660 board cells + 22 occluded hero rears + 22 hero fronts — at native
capture resolution **2940 × 1846**.

## The crop fed to `match()`

A single card's **left-corner strip**, RGBA, **55 w × 130 h** at native resolution.

**Anchor (top-left of the strip):**
- **Left edge** = the card's **white body left edge** (where the rank glyph sits),
  NOT including felt to its left.
  - Corpus board: `board_cards.json` bbox_x **+ 30** (card_reader shifts its bbox
    30 px left of the body to include the rank; the body/strip left is bbox_x+30).
  - Corpus hero: the detected white-card left edge (rear/front bbox_x).
- **Top edge** = the card's **white top edge** — scanning down from the band top,
  the first row where **≥ 50 %** of the strip-width columns are bright
  (mean RGB > 150/255).

**Extent:** 55 px wide × 130 px tall from the anchor.

**Resolution scaling:** offsets/sizes above are native (card pitch ≈ 167 px). At
another resolution, scale proportionally to card pitch — strip width ≈ **0.329 ×
pitch**, strip height ≈ **0.778 × pitch**. Aspect ratio (h/w ≈ 2.36) is fixed.

## What the classifier does inside that crop

1. **Pip band** = rows `[0.569·H .. H]` (lower 43 %) × full width — the corner pip.
2. **Ink mask** (color from the reliable color hash):
   - red: `R − (G+B)/2 > 38` and `R > 110`
   - black: `lum < 140` and `|R−G| < 28` and `|G−B| < 32`
3. **Isolate the pip:** 4-connected components; **drop any blob touching the band's
   top row** (the rank glyph's bottom stroke bleeds in there — this was the single
   biggest error source); drop blobs < 18 % of the largest survivor; bbox-crop.
4. **Decide (same-color 2-way), else ABSTAIN:**

| color | feature | rule | corpus range |
|---|---|---|---|
| red | top-band width = fraction of bbox cols with ink in top 22 % rows | ♥ if ≥ **0.75**, ♦ if ≤ **0.45**, else abstain | ♥ ≥ 0.89, ♦ ≤ 0.30 |
| black | max horizontal ink-runs across mid band `[0.30h..0.70h]` | ♣ if ≥ **3**, ♠ if **= 1**, else abstain | ♣ = 3, ♠ = 1 |

The decision bands sit in wide empty gaps between the two classes, so abstention
only fires on genuinely degraded pips — never a confident wrong suit.

> **Deviation from the original spec:** the spec named *mid-band fill* for ♣/♠.
> Measured over the corpus that overlaps (club median 0.58 inside spade's range →
> 52 % abstain). **Max ink-runs** measures card_reader's *own* stated insight
> ("clubs have a gap between their three lobes") more directly and separates
> cleanly (0 % abstain). Mid-band-fill remains a valid fallback if ever needed.

## Validation result (`tools/validate-suit-corpus.mjs`)

704 instances, real `match()`: **suit confusion matrix perfectly diagonal, 698/698
confident reads correct, 0 confident wrong**, 6 abstains (0.9 %, all occluded
rears). Rank 99.3 %, color 100 %. **Bar (zero confident same-color error): PASS.**

## Live-wiring follow-up (NOT done here)

`cardCellsFromRegion` (live-ocr-test.jsx) / `sliceCells` (converter/frame.js)
currently slice a region into N **full-height** cells. Those are full cards, not
this corner strip. The follow-up must crop each detected card to the strip
geometry above (white top-left anchor, 55×130-proportioned) before calling
`match()`. Until then the pip classifier has the wrong input live.
