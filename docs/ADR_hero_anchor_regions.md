# ADR — Hero-Anchored Resolution-Independent Region Geometry

**Status:** Accepted, 2026-06-17. Implemented in `converter/regions.js`
(`detectHero`, `computeAnchoredRegions`). Loop wiring is a separate follow-up.

## Context

The table is the BetOnline 6-max client rendered in a **Chrome browser tab**,
captured via `getDisplayMedia`. A browser tab has no fixed capture resolution —
viewport height changes with window size, bookmarks bar, devtools, zoom.
Observed capture heights in a single session: 1558, 1364, 1054, 1912 (width
~2932–2940 throughout).

Fraction-of-frame region geometry FAILS here: when only the height changes, the
table's aspect ratio changes, so a region authored as a fixed fraction of the
frame drifts off-target. This produced an extended calibration loop where each
re-share of the tab landed at a different height and broke the boxes.

## Decision

Anchor all region geometry to the **hero nameplate** ("RoloDango", seat BC,
bottom-center) — never to the BETONLINE felt logo or any site branding.

The hero plate is the one element that is always present, always occupied
(hero never leaves, unlike fast-fold villain seats that churn every hand), at a
fixed relative position. Its measured position gives the table ORIGIN; its
measured text height gives the table SCALE.

## Measurement that justifies this (the provenance)

A probe measured the hero name-text at three capture heights:

| video      | textH/frameH | cy (frac) | cx (frac) |
|------------|--------------|-----------|-----------|
| 2940×1558  | 0.02760      | 0.7397    | 0.5214    |
| 2932×1364  | 0.02786      | 0.7405    | 0.5193    |
| 2932×1054  | 0.02751      | 0.7405    | 0.5153    |

Conclusion: **the table SCALES PROPORTIONALLY** (it does not reflow or
letterbox). `textH/frameH` is invariant (~0.0276) across a near-2× height range;
`cy` is invariant (~0.740); `cx` drifts only slightly with aspect (so anchor x to
hero, not to frame). Because hero scales identically to the whole table, hero's
own size is a valid scale gauge for every other region.

## Constants (single source of truth)

- `HERO_TEXTH_FRAC = 0.0276`  ← the invariant; scale derives from this, never a raw pixel
- `HERO_CY_FRAC    = 0.740`
- `HERO_CX_FRAC    = 0.521`
- `REF_FRAME = { w: 2940, h: 1846 }`
- `REF_HERO  = { cx: 1532, cy: 1366, textH: 50.95 }`  (= the fracs × REF_FRAME)

Region boxes are stored as offsets from `REF_HERO` in REF_FRAME px. Each region's
box literals (STACK_BOXES, BET_BOXES, POT_BOX, …) remain the geometry source;
offsets are derived, not duplicated.

## Runtime transform

Per frame, detect hero → `{cx, cy, textH}` in live-frame px. Then:
```
scale   = (detected_textH / frameH) / 0.0276     // fraction-based — resolution-safe
originX = detected_cx
originY = detected_cy
center  = origin + offset * scale * (frameH / 1846)
```
(Equivalently `scale·frameH/1846` reduces to `detected_textH / REF_HERO.textH`;
the fraction form is canonical so the 0.0276 invariant stays the only magic
number.)

## Fallback (required — hero is missing on ~30% of frames)

Hero text is not detectable when the action overlay covers the plate or
mid-animation. Three states:
- `anchor-live`  — hero found this frame, fresh transform.
- `anchor-cached`— hero not found, reuse last-good transform.
- `anchor-cold`  — no detection yet this session; falls back to static
  `captureRegions()` geometry.
Never crash, never emit blank/garbage coordinates.

## Consequences

- Region geometry now survives any capture height automatically; the calibration
  loop does not recur.
- Cost: one extra OCR pass over a hero search band per detection (throttleable;
  the table only moves on window resize).
- The anchor depends on hero's name being OCR-legible; the fallback covers misses.

## Follow-ups (not done in the implementing session)

1. **Loop wiring** — `regions.js` exposes the math but nothing calls it per
   frame yet. Wire via a second Tesseract worker on the hero band in the driver
   (loop untouched), feeding `computeAnchoredRegions().regions` into the array
   the loop reads.
2. **Test repair** — 3 region tests assert pre-recalibration pixel values and
   are red; update them to assert invariants, not stale coordinates.
3. **Per-villain name regions** — deferred; the nameplate identity channel is a
   separate build, now unblocked by the confirmed nameplate legibility.
