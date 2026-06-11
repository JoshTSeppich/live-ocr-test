# ACTION CHECKLIST — Advisor Panel (always-on-top advice display)

Status of the advisor panel against its contract (CONVERTER_BUILD_SPEC §4
[AMENDED 2026-06-10] / the CC-D panel brief). The panel is the human-facing layer:
a Chrome **Document Picture-in-Picture** window, opened from one user gesture, that
tells a person what action to take — readable in under a second, OS-level always-on-top.
It only **displays**; it never sends to the brain and never triggers an action.

Files: `advisor/` (panel, stub, audio, PiP host, controller); live producer adapter in
`converter/driver.jsx`. Event contract: `advisor/ADVISOR_PANEL_INTERFACE.md`.
Demo evidence: `advisor/evidence/`.

## Contract items
- [x] **1. Dominant action line** — large verb, color-coded: fold gray · check/call teal ·
  bet/raise amber · all-in red. (`evidence/01-fold`…`07-allin`, `12-pip-window-advice`)
- [x] **2. Sizing line (bet/raise)** — three forms side by side: raise-to / raise-by / pot-%,
  **BB-primary** with chips in parens. (`evidence/04-bet`, `05-raise`, `12`)
- [x] **3. State strip** — SETTLING → THINKING → ADVICE → STALE / WAIT / CAN'T READ as a
  full-width band (background shift, not a small label). (all evidence)
- [x] **4. Staleness binding** — advice carries its snapshot `seq`; a `stale` event flips the
  panel to dimmed "STALE — DO NOT USE" instantly. **Measured flip = 17 ms (< 100 ms).**
  (`evidence/10-stale`)
- [x] **5. WAIT / strict-block** — "NO ADVICE — YOU DECIDE" at full weight; never blank,
  never a lingering previous advice. (`evidence/08-wait`)
- [x] **6. `fallback_used` warning** — persistent loud amber border + "⚠ FALLBACK" band.
  (`evidence/06-raise-fallback`)
- [x] **7. Audio cues** — distinct ADVICE chime + STALE buzz; mute toggle, default sound-on.
  (verified: advice→2 oscillators, stale→2, muted→0)
- [x] **8. Urgency proxy** — poll-counter / elapsed indicator (the guaranteed floor; timer-bar
  fraction shown when available). (footer in all evidence)
- [x] **9. Nothing else** — no EV, reasoning, confidence, or opponent stats.

## Mechanism / safety
- [x] Chrome Document PiP, opened from one user gesture; same page / same React state
  (portal), OS-level always-on-top. No Electron, no second process.
- [x] **G-CAP**: capture pinned window-scoped (`displaySurface:'window'` +
  `monitorTypeSurfaces:'exclude'`, `live-ocr.jsx:368`) so the PiP window can never pollute
  OCR or occlude what the eyes read. (commit: PiP non-occlusion guarantee)
- [x] Panel never steals focus — after PiP open, main `document.hasFocus()` stays true;
  code calls `.focus()` nowhere. (`evidence/11-pip-window-live`)
- [x] Distinct labels: brain **WAIT** ("NO ADVICE — YOU DECIDE") vs §5 **escalate**
  ("CAN'T READ TABLE — YOU DECIDE"). (`evidence/08`, `09`)

## Live wiring
- [x] `converter/driver.jsx` maps the live converter state + parsed brain reply →
  `AdvisorEvent` and renders the shared `AdvisorPanel` (replacing the old green-string readout).
- [x] Tests: 17 advisor node tests (`advisor/*.test.cjs`); full suite 136 pass.

## Producer follow-ups (panel-ready; CC-C wires at/after merge — see interface doc)
- [ ] Emit **`wait`** on a brain decline / strict-block reply (today arrives as no-advice).
- [ ] Emit **`stale`** (newer `seq`) when a fresh snapshot supersedes shown advice — the
  highest-value safety follow-up.
- [ ] Bridge the live feed into the always-on-top PiP via one shared bus (driver publishes,
  advisor-mount subscribes as a "Live" source).
- [ ] Confirm the brain reply `amount` unit (chips assumed) at first live bring-up.
