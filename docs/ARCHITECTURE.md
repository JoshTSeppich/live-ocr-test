# PixelPoker — Architecture

**Two bodies, one conversation.**

PixelPoker (the **table body**) observes a poker client on screen, sends what it sees to a separate poker AI (the **brain body**, the `pokerbot` package at `~/projects/decision-db/`), receives decisions back, and presses keys to execute them. The two bodies communicate over a single WebSocket. Neither knows the other's internals.

This document is the top-level map. It names every part, draws the boundaries between them, and specifies which file owns which responsibility. It is the v2 contract that ties the spec docs together.

---

## 1. The two bodies

```
┌─────────────────────────────────────┐         ┌─────────────────────────────────────┐
│           TABLE BODY                │         │           BRAIN BODY                │
│           (PixelPoker)              │         │           (pokerbot)                │
│                                     │         │                                     │
│  Browser app + Node daemon          │         │  Python WebSocket server            │
│  ~/projects/pixelpoker/  (v2)       │  WS     │  ~/projects/decision-db/            │
│  ~/projects/live-ocr-test/ (v1)     │ ←───→  │  scripts/serve.py on :8765          │
│                                     │  JSON   │                                     │
│  Sees the screen.                   │         │  Reads infosets.                    │
│  Presses keys.                      │         │  Returns decisions.                 │
│                                     │         │                                     │
│  Has eyes and hands.                │         │  Has neither eyes nor hands.        │
│  No persistent state.               │         │  Stateless per-request.             │
└─────────────────────────────────────┘         └─────────────────────────────────────┘
```

**Why this split:**

- The brain runs in Python because the trained CFR policy, OpenSpiel, and PokerKit are Python. The poker client runs in Chrome, which is best observed and acted upon from the browser context that already has `getDisplayMedia` and DOM access. The split is forced by the runtime ecosystems, not by preference.
- Each body is independently testable. The brain's 237 tests don't depend on a poker client running. The table's 119 tests don't depend on a trained policy.
- The seam is a single TCP socket, which means each body can crash, restart, or get rebuilt without disturbing the other.

---

## 2. Four running processes

When the system is live, four processes are running:

1. **The browser app** — PixelPoker (HTML + React + Tesseract.js, served by `python3 -m http.server 8000`)
2. **The keystroke daemon** — `node daemon.js` on `127.0.0.1:9001`
3. **The brain server** — `python scripts/serve.py --port 8765`
4. **The poker client** — Chrome tab showing the poker site (the observed and acted-upon target)

Four processes, three of them yours, one of them the target. If any of the three yours die, the system halts safely — no auto-fold, no auto-action. The human takes over.

---

## 3. Seven organs

The table body is decomposed into seven organs, each with a single responsibility and a single direction of data flow. The brain body has three.

| Body | Organ | Direction | Job |
|---|---|---|---|
| Table | **EYES_TABLE** | outbound only | screen → structured events |
| Table | **MOUTH_TABLE** | outbound only | events → WebSocket to brain |
| Table | **EARS_TABLE** | inbound only | WebSocket from brain → decisions |
| Table | **INTERPRETER** | local | `amount_bb` → `sliderTicks` |
| Table | **HANDS_TABLE** | outbound only | decisions → daemon POST → keystroke |
| Table | **TWIN** | local | passive renderer of recent events |
| Table | **TEACHER** | local | manual teach loop for the template library |
| Brain | **EARS_BRAIN** | inbound only | receive events |
| Brain | **(cognition)** | local | hand state, opponent stats, policy lookup |
| Brain | **MOUTH_BRAIN** | outbound only | send decisions |

**Invariants:**

- **Eyes/Mouth send and never receive.**
- **Ears/Hands receive and never decide.**
- The Twin is passive — it renders, never sends, never decides.
- The Teacher lives entirely on the table side; the brain never knows it exists.
- The brain has no eyes and no hands. If the WebSocket dies, the brain is blind and mute.

Connection liveness and failure handling is the **table's** responsibility. The brain assumes the wire works; if it doesn't, the table surfaces it.

---

## 4. Layer model: perception / composition / display

A coarser view of the same seven organs, useful when reasoning about what changes when one of them changes:

| Layer | Organs | What it does |
|---|---|---|
| **Perception** | EYES_TABLE | observes the screen, emits primitive observation events |
| **Composition** | (cognition in the brain) | accumulates events into a coherent hand state, decides |
| **Display** | TWIN | renders events back to a human-readable surface for the human to compare against reality |
| **Action** | INTERPRETER + HANDS_TABLE | translates a brain decision into a real keystroke |

Eyes observe and emit primitives. The brain receives primitives and composes. The twin receives primitives and renders. No layer reaches into another. Every change to one layer's internal model is invisible to the others.

This is also the architecture that scales. If the brain gets smarter (new opponent classifier, new bet-sizing buckets, new range-narrowing logic), the eyes stay the same. If the eyes get sharper (per-seat stack OCR added, faster Tesseract, better template matching), the brain stays the same. Each layer evolves independently.

The composite shape `[name, position_relative_hero, bb, seat, this_turn]` — the brain's view of the table — exists in the brain's memory, not on the wire. That's the right home for it.

---

## 5. Dataflow — one observe-to-fire cycle

```
[Chrome tab: poker client renders a hand]
              │
              ▼  getDisplayMedia frame (~15 fps, sampled at 250 ms)
[EYES_TABLE]
   │  Phase 1: draw every region's source + preprocessed canvas from
   │           the SAME video frame
   │  Phase 2: OCR each region, run grammar, run template matcher
   │  Emit: {kind, ...fields}, BB-normalized
   ▼
[MOUTH_TABLE]
   │  WebSocket.send({type:"observation", event})
   ▼
[wire: ws://localhost:8765]
   ▼
[EARS_BRAIN]
   │  Parse, hand to session-state accumulator
   ▼
[cognition]
   │  Build GameStateRequest
   │  RuntimeAdapter.decide() → ActionResponse
   ▼
[MOUTH_BRAIN]
   │  WebSocket.send({type:"decision", request_id, action, amount_bb})
   ▼
[wire]
   ▼
[EARS_TABLE]
   │  Route to interpreter
   ▼
[INTERPRETER]
   │  amount_bb × stake → sliderTicks
   ▼
[HANDS_TABLE]
   │  POST /act {action, sliderTicks, label}
   ▼
[daemon.js]
   │  focus check → navigate to poker tab → keystroke → switch back
   ▼
[Chrome tab: keystroke lands, poker client updates]
   │
   └──► loop back to EYES_TABLE on the next frame
```

**Latency budget (from canvas page 10, observe-to-fire):**

| Stage | Budget |
|---|---|
| Frame capture | 5 ms |
| Preprocess (binarize+invert) | 5 ms |
| Tesseract OCR | 240 ms |
| Template matcher | 2 ms |
| Grammar | 1 ms |
| WebSocket out | 4 ms |
| Brain decide | 180 ms |
| WebSocket back | 4 ms |
| Interpreter | 1 ms |
| Daemon (focus, keystroke, switch-back) | 420 ms |
| Client redraw | 200 ms |
| **Total** | **~1.06 s** |

Tesseract and the daemon dominate. Anything trying to speed the loop should target those.

---

## 6. The bridge — one WebSocket, two directions

The bridge is the physical seam between the table and the brain. Conceptually it's two organs (MOUTH_TABLE + EARS_BRAIN one way, MOUTH_BRAIN + EARS_TABLE the other), but as code it's a single WebSocket connection with two directions of traffic. One file, one connection, two interfaces.

**Direction 1: MOUTH_TABLE → EARS_BRAIN** (observations)

```
{ "type": "observation", "event": {...} }
```

The envelope is `{type, event}` so the wire format can grow later without ambiguity. Today only `type: "observation"` flows this way. Tomorrow there might be `type: "heartbeat"` or `type: "session_reset"`.

Behavior:
- No batching. Each event ships individually.
- Send-and-forget. The table doesn't wait for an ack.
- The bridge knows nothing about poker. It moves messages.

**Direction 2: MOUTH_BRAIN → EARS_TABLE** (decisions)

```
{ "type": "decision", "request_id": "...", "action": "raise", "amount_bb": 6.0 }
```

Minimal payload. **No reasoning text, no confidence, no alternatives.** If the table wants to show "why" in the Twin, it has to make that up from local data — the wire doesn't carry it.

**Disconnect behavior:**

- The eyes keep observing.
- The mouth buffers up to some bound (TBD; canvas v1 shows "BUFFERED" status).
- The ears wait.
- The interpreter and hands do not auto-fire anything.
- The Twin keeps rendering whatever events the eyes are still producing.
- The disconnect surface fires manual-fire buttons in the UI; the human takes over.
- **No auto-fold.** No "safe default action." The bot stops; the human decides.

---

## 7. File ownership

What lives where, and what is preserved vs rewritten:

**Preserved from v1 (5 pieces, copied unchanged):**
- `daemon.js` — keystroke server
- `MultiSignatureMatcher` — three-hash card matcher (in `engine.js`)
- `POKER_GRAMMAR` — 19 ordered regex rules (in `live-ocr.jsx`)
- Color-suit recovery (`analyzeSuitGlyph`, `suitFrom`, `injectColorSuits`)
- Tesseract config + template I/O helpers (`serializeTemplates`, `deserializeTemplates`)

**Written fresh on the table side (7 pieces):**
- `live-ocr.jsx` rewritten — the OCR loop wrapping the preserved pieces
- `live-ocr-test.jsx` rewritten — thin React shell, dispatcher
- `bot_link.js` — WebSocket client to the brain
- `game_state_builder.js` — events → `GameStateRequest` JSON
- `action_translator.js` — `ActionResponse` → `{action, sliderTicks}`
- The Twin — passive renderer of what the eyes think they see
- The Teach UI + Manual Fire panel

**Written fresh on the brain side (1 piece):**
- `scripts/serve.py` — WebSocket server wrapping `RuntimeAdapter`

**The contract (3 pieces):**
- `ARCHITECTURE.md` (this doc) + `EYES_SPEC.md` + `MATCHER_SPEC.md` + `PROTOCOL.md`
- `DESIGN_CANVAS.pdf` (v2, when redrawn)
- `INTEGRATION_CONTRACT.md` on the brain side — the schema doc the table-side developer reads

**Total: 16 artifacts.** The humanizer is a planned 17th.

---

## 8. What's not in this architecture

To make the contract sharp, here's what is **deliberately absent**:

- **No local decision engine on the table side in v2.** The `engine.js` from v1 (which had hand evaluator, ranges, `decide()`) is being deleted. The brain replaces it entirely. Do not add "fallback to old engine" safety nets.
- **No auto-fold, no auto-anything-on-disconnect.** The bot stops cleanly; the human takes over.
- **No invented schema fields.** If the eyes can't observe something the brain needs, it gets marked `❌ MISSING` in `INTEGRATION.md`. No default values, no inference, no silent guesses.
- **No mutating brain state from the table side.** The brain is stateless per request. The table can't write to it.
- **No persistent state on the bridge.** Reconnects don't replay events. The brain accumulates state from whatever the eyes emit after reconnect.

---

## 9. Why this shape

The two-body architecture is not idiosyncratic — it mirrors:

- OpenHoldem's recommended "System A / System B" dual-machine pattern (a documented stealth measure).
- Commercial AI bots (e.g. Poker Bot AI+) that separate game-client environment from decision engine.
- Modern superhuman bot papers (Pluribus, ReBeL, Player of Games) that all separate perception/state from blueprint/search.

The seam is the contract. Eyes emit a fixed event shape. Hands accept a fixed payload. Anything that consumes the first and produces the second can sit in between — `engine.js` did once; `pokerbot` does now; whatever replaces `pokerbot` later (real-time depth-limited search, latent opponent embeddings, an entirely new policy) will too.

---

## 10. Reading order for the rest of the contract

After this doc, read in order:

1. **`EYES_SPEC.md`** — what the eyes observe, what they emit, what they don't do.
2. **`MATCHER_SPEC.md`** — how the card matcher works, since cards are the eyes' hardest job.
3. **`PROTOCOL.md`** — the wire format both directions.
4. **`HUMANIZER_SPEC.md`** (planned) — the timing/modality layer that wraps the daemon.
5. **`DESIGN_CANVAS.pdf`** — the visual reference; what the UI actually looks like.

If you only read one of these, read `EYES_SPEC.md` — it's where the most decisions are made.
