# Advisor Panel — consumed event interface

The always-on-top advisor (`AdvisorPanel.jsx`, opened as a Chrome **Document
Picture-in-Picture** window) consumes exactly one event shape: **`AdvisorEvent`**.
Everything the human sees is derived from it. The panel never talks to the brain
and never triggers an action — it only displays.

This doc is the contract the **producer** side fulfills. Two producers exist:
1. `advisor-stub.js` — the in-process demo/test emitter (drives the STEP-4 evidence).
2. `converter/driver.jsx` — the **live** adapter: maps the converter pipeline's
   state + parsed brain reply onto `AdvisorEvent` (see *State mapping* below).

---

## `AdvisorEvent` (the wire shape)

```js
{
  kind: 'settling' | 'thinking' | 'advice' | 'stale' | 'wait' | 'escalate',
  seq: number,                  // snapshot seq — binds advice to its frame (staleness)

  // present only when kind === 'advice':
  action: 'fold'|'check'|'call'|'bet'|'raise'|'allin',
  amountChips: number | null,   // call/all-in amount, in CHIPS
  sizing: null | {              // bet/raise only — all in CHIPS
    raiseToChips: number|null,  // total "raise to"
    raiseByChips: number|null,  // increment over hero's current bet
    potPct: number|null,        // % of pot
  },
  fallbackUsed: boolean,        // loud amber border when true

  bbChips: number,              // chips per big blind — display-edge BB conversion
  urgency: { polls: number, elapsedMs: number, timerFrac: number|null },
}
```

`AdvisorEvent.normalize(evt)` validates and fills defaults (throws on a malformed
event — fail loud in dev). `AdvisorEvent.createBus()` is a tiny pub/sub whose
`publish()` normalizes at the boundary, so a bad producer event is caught before
it reaches the panel.

### Units: chips on the wire, BB at the display edge
The wire carries **chips** (the converter assembles chip counts). The human thinks
in **BB** (the client UI shows BB). Conversion happens **only** in the panel, via
`AdvisorEvent.toBB(chips, bbChips)`. Nothing upstream converts. The panel renders
BB-primary with the chip value in parentheses, e.g. `7.5BB (750)`.

---

## State mapping — converter pipeline → `AdvisorEvent.kind`

`AdvisorEvent.fromConverter()` (pure, node-tested) maps what `driver.jsx` can reach
without modifying converter logic — `conv.view.state` (the §5 escalator vocabulary),
the parsed brain reply `conv._advice`, `conv._sentThisTurn`, and the assembled
`request` returned by `conv.onFrame()`:

| converter state | condition | panel `kind` | meaning |
|---|---|---|---|
| `idle` | not hero's turn | `settling` | benign; nothing pending |
| `waiting` | `!sentThisTurn` | `settling` | hero's turn, frame not yet clean |
| `waiting` | `sentThisTurn` | `thinking` | clean snapshot sent, awaiting brain |
| `advising` | parsed advice present | `advice` | brain replied with an action |
| `escalate` | §5 clock-low, no clean read | `escalate` | eyes failed — "CAN'T READ TABLE — YOU DECIDE" |

**advice payload derivation** (`fromConverter`):
- `action` ← `mapAction(conv._advice.action, .abstractAction)` (normalizes the brain
  vocab `fold/check/call/bet/raise/all-in|allin`, plus `foldview→fold`, `double→raise`).
- all-in override: a raise-to `amount ≥ request.max_raise` (hero's all-in total) ⇒ `allin`.
- `sizing` (bet/raise): `raiseToChips = amount`; `raiseByChips = amount −
  request.current_bets[hero_seat]`; `potPct = round(amount / request.pot_committed)`.
  Any form that can't be computed cleanly is left `null` (the panel shows the rest).
- `fallbackUsed` ← `conv._advice.fallbackUsed`; `seq` ← `conv._advice.seq`.
- If the advised action is unparseable, `fromConverter` degrades to `wait`
  (NO ADVICE — YOU DECIDE) rather than fabricating a verb.

> **`amount` unit assumption (live-validation):** the adapter treats the brain
> reply's `amount` as a **chips raise-to total**, consistent with the converter's
> all-chips request (`to_call`/`min_raise`/`max_raise` are chip "raise-to" totals).
> Confirm against the brain at first live bring-up; if the brain denominates `amount`
> in BB, the adapter's chip math needs a `× bbChips` at the seam.

### Producer follow-ups (panel-ready, not yet emitted live)
The panel fully supports these (proven via the stub in the STEP-4 evidence), but
today's converter has no signal for them — wiring is a **CC-C producer task**:
- **`wait`** (brain declined / strict-block). The converter has no "brain said no
  advice" state; a decline currently arrives as `botLink.onError` → no advice →
  `waiting`/`escalate`. Emit `wait` when the brain returns a no-advice/strict-block reply.
- **`stale`** (a newer snapshot supersedes shown advice). The converter sends once
  per turn and clears advice between turns; it never signals supersession. Emit
  `stale` (with the newer `seq`) when a fresh snapshot's seq exceeds the seq of the
  advice currently displayed. **Executing stale advice is the system's worst failure
  — this is the highest-value follow-up.**

---

## WS-swappability

The stub is an **in-process emitter** (approved for demo stability), but the seam is
transport-agnostic: anything that calls `bus.publish(evt)` with a valid `AdvisorEvent`
drives the panel. A real WebSocket consumer is a drop-in replacement —

```js
const bus = AdvisorEvent.createBus();
socket.onmessage = (m) => bus.publish(JSON.parse(m.data)); // must match AdvisorEvent
```

— no panel changes required.

### Bridging the live converter feed to the always-on-top PiP (merge step)
Currently `driver.jsx` renders its **own** in-tab `AdvisorPanel` from the live feed,
and `advisor-mount.jsx` (the PiP host) renders from the **stub**. They are separate
React trees. To drive the always-on-top PiP from the live converter at merge, expose
one shared bus and have both sides use it:
- `driver.jsx`: `bus.publish(advisorEvent)` after each `fromConverter` map.
- `advisor-mount.jsx`: subscribe its controller to that shared bus instead of the stub
  (a "Live" source). This is the only remaining wire and touches only these two files.
