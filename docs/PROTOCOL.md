# PixelPoker — PROTOCOL

The wire format between the table body and the brain body. One WebSocket. Two directions. Sixteen event kinds outbound (table → brain). Eight decision actions inbound (brain → table). This document is the canonical reference; if anything in `EYES_SPEC.md` or `MATCHER_SPEC.md` disagrees, PROTOCOL wins.

**Read first:** `ARCHITECTURE.md`.

---

## 1. Connection

- **URL:** `ws://localhost:8765` (default; configurable per-environment).
- **Transport:** WebSocket over TCP. Loopback only — no auth, no TLS.
- **Lifecycle:** table-side opens; brain-side accepts. Heartbeats every 5 s.
- **Disconnect behavior:** the table reconnects with exponential backoff (1 s, 2 s, 4 s, 8 s, ..., capped at 30 s). The brain does not initiate reconnects. The brain is stateless; reconnects do not replay events.

### 1.1 Envelope

Every message is a JSON object with a `type` field. The known types:

| Direction | `type` | Payload key |
|---|---|---|
| table → brain | `observation` | `event` |
| table → brain | `heartbeat` | `ts` |
| brain → table | `decision` | (`request_id, action, amount_bb`) inline |
| brain → table | `error` | (`request_id, code, message`) inline |
| brain → table | `heartbeat_ack` | `ts` |

**Why an envelope:** the wire format can grow later without ambiguity. Unknown `type` values are logged and dropped, not rejected.

---

## 2. Direction 1: Observation events (table → brain)

The table emits structured observation events. The brain accumulates them into hand state. The events are **primitive** — they describe one thing each, no composite state, no history.

### 2.1 The 16 event kinds

| `kind` | Source | Fields |
|---|---|---|
| `hand_start` | chat | `hand_id` |
| `hand_end` | chat | `hand_id` |
| `post_blind` | chat | `who, blind: 'small'\|'big', amount_bb` |
| `hero_cards` | chat + matcher | `cards: [code, code], fromTemplate, templateConfidence` |
| `board` | chat + matcher | `street: 'flop'\|'turn'\|'river', cards: [...], fromTemplate, templateConfidence` |
| `fold` | chat | `who` |
| `check` | chat | `who` |
| `call` | chat | `who, amount_bb` |
| `bet` | chat | `who, amount_bb` |
| `raise` | chat | `who, amount_bb, target_bb` |
| `win` | chat | `who, amount_bb` |
| `showdown` | chat | `who, cards: [code, code]` |
| `seat_state` | name + stack OCR | `seat, name, stack_bb, in_hand, sit_out, anonymized` |
| `pot` | pot OCR | `pot_bb` |
| `dealer_position` | (offline pipeline; live pending) | `seat_index` |
| `actionOnHero` | turn indicator | `value: bool` |

### 2.2 Common envelope fields

Every `observation` event carries:

```json
{
  "type": "observation",
  "event": {
    "kind": "...",
    "ts": "ISO-8601 timestamp with millisecond precision",
    "region": "chat | the_Board | my_Hand | turn | seat_N | derived",
    "raw": "original OCR line if applicable (for debugging only; brain ignores)",
    ...kind-specific fields...
  }
}
```

The `raw` field is for the Twin and event log only. The brain does not parse it.

### 2.3 Card codes

Every card is a two-character string: rank (uppercase) + suit (lowercase).

- Ranks: `2 3 4 5 6 7 8 9 T J Q K A` (`T` not `10`).
- Suits: `c d h s`.
- Regex: `/^[2-9TJQKA][cdhs]$/`.

`?` placeholders never appear on the wire. Resolution to a real suit happens in `resolveCard()` before the event is built (see EYES_SPEC §2.7).

### 2.4 BB-denominated amounts

**Every monetary value on the wire is in big blinds.** The eyes do the dollar→BB conversion before emitting. The brain never sees dollars.

- `amount_bb` is `float`, rounded to 2 decimal places (cent precision at BB=$0.25).
- `target_bb` on raise events is the bet-to amount (total chips committed this street), not the additional amount.
- `stack_bb` on `seat_state` events is the current stack at observation time.
- `pot_bb` is the displayed pot. The brain reconciles this against the action stream; the eyes don't track a running pot.

### 2.5 Hand boundaries

`hand_start` and `hand_end` fire when the chat says so. Between them, all action events belong to a single hand.

- Multiple `hero_cards` events can fire in one hand (the chat repeats the hole cards on showdown). The first one wins for state purposes.
- The `board` event repeats the **full board** each street (not just the new card). The brain takes the most recent `board.cards` as ground truth.

### 2.6 Validation rules (brain-side enforcement)

The brain validates incoming events and emits an `error` if any rule is violated:

| Rule | Error code |
|---|---|
| Unknown `kind` | `unknown_event_kind` |
| Missing required field for that `kind` | `missing_field` |
| Card code fails regex | `invalid_card_code` |
| Duplicate cards in `cards` array | `duplicate_cards` |
| `amount_bb < 0` | `negative_amount` |
| `target_bb < amount_bb` on a raise | `inconsistent_raise` |
| `stack_bb < 0` | `negative_stack` |
| Event fires outside a `hand_start`/`hand_end` window when the kind requires hand context | `out_of_hand_event` |

The brain logs the error and continues. It does **not** disconnect on validation errors.

### 2.7 Example observation messages

**Hero cards:**

```json
{
  "type": "observation",
  "event": {
    "kind": "hero_cards",
    "ts": "2026-05-26T14:32:01.847Z",
    "region": "my_Hand",
    "cards": ["As", "Kd"],
    "fromTemplate": true,
    "templateConfidence": 0.92,
    "raw": "As Kd"
  }
}
```

**Raise:**

```json
{
  "type": "observation",
  "event": {
    "kind": "raise",
    "ts": "2026-05-26T14:32:03.122Z",
    "region": "chat",
    "who": "pinata77",
    "amount_bb": 4.0,
    "target_bb": 6.0,
    "raw": "[14:32:03] pinata77 raises $1.50"
  }
}
```

**Seat state:**

```json
{
  "type": "observation",
  "event": {
    "kind": "seat_state",
    "ts": "2026-05-26T14:32:02.500Z",
    "region": "seat_3",
    "seat": 3,
    "name": "pinata77",
    "stack_bb": 113.0,
    "in_hand": true,
    "sit_out": false,
    "anonymized": false
  }
}
```

**Action on hero:**

```json
{ "type": "observation", "event": { "kind": "actionOnHero", "value": true, "ts": "..." } }
```

---

## 3. Direction 2: Decision messages (brain → table)

When the brain emits a decision, the payload is **minimal**:

```json
{
  "type": "decision",
  "request_id": "DEC-12345",
  "action": "raise",
  "amount_bb": 6.0
}
```

### 3.1 The eight action types

| `action` | Carries `amount_bb`? | Meaning |
|---|---|---|
| `fold` | no | fold to current bet |
| `check` | no | check (no bet to call) |
| `call` | no | call the current bet |
| `bet` | yes | bet `amount_bb` (no facing bet) |
| `raise` | yes | raise-to `amount_bb` (facing a bet) |
| `allin` | no | all-in |
| `wait` | no | strict mode block; no action taken; human takes over |
| `disconnect` | no | brain is going down; table should buffer |

`fold`, `check`, `call`, `allin` carry no amount. The table's interpreter ignores any `amount_bb` on these.

`bet` and `raise` carry `amount_bb`. The interpreter computes `sliderTicks` from this.

`wait` is the brain's "I refuse to play this hand for safety reasons" output (strict mode, schema-gap detection). The table surfaces it loudly; the human takes over.

`disconnect` is the graceful shutdown signal. The brain sends this when it knows it's about to go away (e.g. SIGTERM). The table puts the UI into "DISCONNECTED" state.

### 3.2 What is NOT on the decision wire

- **No reasoning text.** The brain doesn't send "why" it chose this. If the Twin shows reasoning, it's making it up from local data.
- **No confidence.** The brain's policy is either strict-blocked (`wait`) or committed.
- **No alternatives.** No "consider also bet 4.0 BB". One decision, one action.
- **No EV.** No "expected value 0.45 BB". Out of scope.
- **No opponent classification.** The brain's archetype model is internal.

This minimalism is deliberate. It keeps the wire stable as the brain evolves and prevents the table from rendering brain internals that may not be meaningful to a human.

### 3.3 `request_id` semantics

The brain assigns a unique `request_id` to each decision. The table uses it for:

- Matching decision to fire-attempt in the UI ("DEC-12345 fired ✓").
- Logging in the hand history with attribution.
- Deduping if the same decision arrives twice (shouldn't happen on a healthy wire, but defense-in-depth).

The brain's request_id format is opaque to the table — treat as a string. Example: `DEC-{hand_id}-{action_index}`.

### 3.4 Error responses

If the brain can't decide (validation error, internal exception, schema gap):

```json
{
  "type": "error",
  "request_id": "...",
  "code": "schema_gap | internal_error | strict_block | ...",
  "message": "human-readable description"
}
```

The table renders the error in the UI. **No retry, no fallback action.** The human takes over.

---

## 4. Heartbeats

Every 5 seconds, both sides exchange:

```json
{ "type": "heartbeat", "ts": 1716738721000 }
```

The receiver replies with `heartbeat_ack` carrying the same `ts`. The sender measures round-trip; if > 200 ms consistently or if no ack arrives within 2 s, the connection is "degraded" and the UI surfaces it.

If no heartbeat or message arrives within 15 s, the table closes and reconnects.

---

## 5. Buffering and reconnect

**Table side buffering:**

- The table buffers outbound observation events when the WebSocket is not open.
- Buffer cap: 200 events. Older events are dropped FIFO.
- On reconnect, the buffer is flushed in order.
- The UI surfaces the buffer state: `BUFFERED: 47 events`.

**Brain side reset:**

- On a fresh connection, the brain starts with empty session state. It does not remember the previous connection's state.
- The table's buffered events will rebuild what state the brain needs.
- **Caveat:** events from the middle of a hand (e.g. just the `raise` event without the preceding `hand_start`) will leave the brain confused. The eyes should not be emitting events outside a hand boundary anyway. If the buffer happens to span a hand boundary, the brain processes events normally — any out-of-hand events are flagged via `out_of_hand_event` errors and ignored.

**Decision requests during disconnect:**

- `actionOnHero` events buffer like any other observation.
- When the connection resumes, the brain receives the buffered `actionOnHero` and decides on it. The latency will be high but the system will recover.
- If the brain's decision arrives after the action window has passed (hero has been auto-folded by the poker client), the table discards the decision and logs a "STALE_DECISION" warning.

---

## 6. Field-level reference

This section enumerates every field with type, required-ness, and constraints. Useful for implementers writing validators.

### 6.1 Observation event fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | one of 16 valid kinds |
| `ts` | ISO 8601 string | yes | UTC, ms precision |
| `region` | string | recommended | for debugging only |
| `raw` | string | optional | original OCR line; brain ignores |
| `hand_id` | string | for `hand_start`/`hand_end` | opaque identifier |
| `who` | string | for `fold`,`check`,`call`,`bet`,`raise`,`win`,`showdown`,`post_blind` | seat name as observed |
| `cards` | array of card codes | for `hero_cards`,`board`,`showdown` | 2 for hero/showdown, 3/4/5 for board |
| `fromTemplate` | boolean | for `hero_cards`,`board` | true if matcher override fired |
| `templateConfidence` | float | for `hero_cards`,`board` when `fromTemplate` is true | min across cells, ≥ 0.75 |
| `street` | string | for `board` | `flop`, `turn`, `river` |
| `amount_bb` | float ≥ 0 | for `call`,`bet`,`raise`,`win`,`post_blind` | 2 decimal places |
| `target_bb` | float ≥ `amount_bb` | for `raise` | bet-to amount |
| `seat` | integer | for `seat_state` | 1-indexed |
| `name` | string \| null | for `seat_state` | null if anonymized or empty |
| `stack_bb` | float ≥ 0 | for `seat_state` | 0 if sit-out |
| `in_hand` | boolean | for `seat_state` | true if green card backs visible |
| `sit_out` | boolean | for `seat_state` | true if plate is dimmed |
| `anonymized` | boolean | for `seat_state` | true if name is `*****` |
| `pot_bb` | float ≥ 0 | for `pot` | 2 decimal places |
| `seat_index` | integer | for `dealer_position` | 1-indexed |
| `value` | boolean | for `actionOnHero` | the new state |
| `blind` | string | for `post_blind` | `small` or `big` |

### 6.2 Decision message fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `request_id` | string | yes | opaque, unique per decision |
| `action` | string | yes | one of 8 valid actions |
| `amount_bb` | float ≥ 0 | for `bet`,`raise` | the bet-to amount |

### 6.3 Error message fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `request_id` | string | when error pertains to a specific decision | else absent |
| `code` | string | yes | machine-readable code |
| `message` | string | yes | human-readable description |

---

## 7. What's explicitly out of scope

To keep the protocol stable, these are NOT in v1:

- **Versioning.** No `protocol_version` field. If we ever break the format, we change the URL (`ws://localhost:8765/v2`).
- **Compression.** Loopback TCP doesn't benefit.
- **Binary frames.** JSON only. The Twin and event log are human-readable.
- **Bidirectional state queries.** The table can't ask the brain "what do you think the pot is?" The brain is stateless per request.
- **Streaming decisions.** No partial decisions or intermediate "thinking" messages. One `decision` per `actionOnHero` window.
- **Training data flow.** The brain is read-only. The table doesn't push hand histories for online learning.
- **Authentication.** Loopback only. If you ever expose this beyond localhost, that's a different protocol.

---

## 8. Implementation checklist

For anyone implementing either end:

**Table side (`bot_link.js`, `game_state_builder.js`, `action_translator.js`):**

- [ ] Open WebSocket to `ws://localhost:8765` on `Eyes.start()`.
- [ ] Subscribe to `Eyes.onEvent`; for every event, wrap in `{type:"observation", event}` and send.
- [ ] Buffer outbound when not open; cap at 200; flush on reconnect.
- [ ] Heartbeat every 5 s; reconnect if no ack within 15 s.
- [ ] On `decision` message: route to interpreter → daemon.
- [ ] On `error` message: surface in UI; no retry.
- [ ] On `disconnect` message: graceful close; mark UI disconnected.

**Brain side (`scripts/serve.py`):**

- [ ] Accept WebSocket on `:8765`.
- [ ] Parse incoming envelope; dispatch by `type`.
- [ ] Validate observation events; emit `error` on violation; continue.
- [ ] On `actionOnHero: true`: build `GameStateRequest`, call `RuntimeAdapter.decide()`, emit `decision`.
- [ ] On `actionOnHero: false`: do nothing.
- [ ] Respond to heartbeats within 100 ms.
- [ ] On schema gap: emit `decision: wait` with `error: schema_gap`.
- [ ] Stateless per request — no cross-connection memory.

---

## 9. The integration contract

This protocol pairs with `INTEGRATION_CONTRACT.md` on the brain side, which specifies:

- The `GameStateRequest` Pydantic schema (`extra='forbid'`, frozen).
- The `ActionResponse` shape.
- What `RuntimeAdapter.decide()` expects and guarantees.

The PROTOCOL doc is the wire. The INTEGRATION_CONTRACT is the in-process Python schema. The `game_state_builder.js` on the table side is responsible for going from observation-event-stream to a valid `GameStateRequest` JSON; the `scripts/serve.py` on the brain side parses that JSON into the Pydantic model.

**If `GameStateRequest` has fields the eyes can't observe**, the builder marks them `❌ MISSING` and the brain returns `wait`. Do not invent values silently.
