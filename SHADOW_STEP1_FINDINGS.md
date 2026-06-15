# CC_SHADOW — STEP 1 measurement record

**Date:** 2026-06-15 · **Branch:** `converter` (HEAD `bf88eb6`) · **Brain:** decision-db serving `v5-6max-fix.db` on `ws://127.0.0.1:8766` · **Frame set:** `~/Desktop/poker-captures/20260603_121222/` (CC-B's 5,312-frame capture). Posture: observe-and-measure, no feature builds (the one pre-authorized change, the pot flip, is **not** taken — see §3).

This records the measurement phase of STEP 1, which is **complete to the extent capture frames allow**. Everything remaining needs the live loop (a real screen-share Capture Harness pass), not more frame-reading.

---

## 1. Play-direction verification — ACCEPTED (5/5)

The original STEP-1 gate keyed off "green SB/BB blind badges," which **do not exist** in this client (see §4). The actual safety question — *is play-direction correct?* — was instead verified directly: read SB/BB from the bet amounts (0.5 = SB, 1.0 = BB) + the dealer-button puck off blinds-only hand-start frames, and compare to the converter's computed direction (`seats.SEAT_ORDER_CW = ['TL','TC','TR','BR','BC','BL']`, SB = button+1, BB = button+2 over occupied seats).

| frame | BTN puck | computed (SEAT_ORDER_CW) | observed blinds | pot | result |
|---|---|---|---|---|---|
| `shot_00000_121232.png` | TR | SB=BR, BB=BC | BR 0.50, BC 1.00 | 1.50 | ✅ match |
| `shot_01385_133139.png` | BR | SB=BC, BB=BL | BC 0.50 (**"SB"** label), BL 1.00 (**"BB"** label) | 1.50 | ✅ match |
| `shot_04060_161808.png` | TC | SB=TR, BB=BR | TR 0.50, BR 1.00 | 1.50 | ✅ match |
| `shot_04669_165426.png` | BR | SB=BC, BB=BL | BC 0.50, BL 1.00 | 1.50 | ✅ match |
| `shot_02753_150446.png` | BC | SB=BL, BB=TL | BL 0.50, TL 1.00 | 1.50 | ✅ match |

**Result: 5/5 match, 0 mismatches**, across 4 distinct button positions (TR, TC, BR, BC) and all four hero roles (BB, SB, button, UTG). The converter's `SEAT_ORDER_CW` play-direction is **correct** for this client. TL/BL button positions were not directly observed (no clean blinds-only frames surfaced for them — SB OCR is unreliable, a known CC-B weakness), but a fixed cyclic order proven across 4 rotations holds for all six by construction.

## 2. Finding — this client renders explicit "SB"/"BB" text labels

The blind seats carry literal **"SB" / "BB" text labels** (clear in `shot_01385_133139.png`), in addition to the bet-chip amounts. This is a more direct, more robust signal than the bet amounts for the redesigned seat-order gate (§4). **Gold for the follow-up build.**

## 3. Carry-forward 1 (pot interpretation) — corpus-confirmed INCLUSIVE; flip HELD

All 5 blinds-only frames show **Pot: 1.50 BB** while the blinds *also* render as bet chips (0.50 + 1.00). That is the **inclusive-readout** signature — the pot display already counts the front-of-seat blinds. Under the assembler default (`potIncludesCurrentBets:false`, which adds Σbets) this would double-count to 300 chips vs the §G.1-correct 150.

**Strong corpus-confirmation that `potIncludesCurrentBets` should be `true`.** BUT these are capture frames, not a live converter read — per Orch ruling the flip is **NOT committed**. It stays `false` until the pot is read off the **first live converter blinds-only frame**, at which point the one-line flip lands as its own commit citing that live frame.

## 4. Surfaced gaps (REPORTED, not fixed this session)

**(a) Seat-order gate premise was wrong in the spec, not the code.** `seats.checkSeatOrder` consumes `badgeSeats` ("seats wearing green blind badges"), but: the green "B" icons in this client mark *active/dealt-in* (present on every active seat), not SB/BB; the blinds render as bet-chip amounts (+ "SB"/"BB" text). Nothing populates `observe._badgeSeats`, so `checkSeatOrder` never runs. **Follow-up build (separately dispatched):** redesign the gate input from `badgeSeats` → blind-bet-amount seats (or the "SB"/"BB" labels) cross-checked against the button. Validation basis: the 20260603 frames above. This is a clean spec-corrected build, **not** a mid-session edit.

**(b) §6 measurements need a live harness run.** Timer-bar full-drain curve, settle-gate N at the live **250 ms** cadence, and mid-animation frame rate cannot come from the 20260603 set (3 s-cadence PNGs, not a 250 ms harness stream). They require a live Capture Harness pass.

## Status / what's left (all needs the LIVE loop)

- §6 measurements (live Capture Harness pass).
- CF1 pot flip — commit only after a live blinds-only read confirms ~1.5 (expected per §3).
- CF2 panel OCR token matchers vs live strings (`observation.classifyActionSet`).
- CF3 amount unit (chips raise-to) at the first live brain reply.
- STEP 3 four gates: snapshot validity, advice latency p95 < 2 s, false-state < 0.5%, zero un-flagged stale.

The live pass is a separate, deliberate screen-share sit-down. Measurement phase ends here.
