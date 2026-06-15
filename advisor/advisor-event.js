// advisor/advisor-event.js — THE display seam (advisor-panel scope).
//
// One normalized event, `AdvisorEvent`, is everything the always-on-top panel
// consumes. The stub (advisor-stub.js) emits these for the demo; in production a
// thin adapter in converter/driver.jsx maps `conv.view` + the parsed brain reply
// onto this exact shape. The panel never sees the pipeline — only this event.
//
// WIRE/UNIT CONTRACT: the wire carries CHIPS (the converter assembles chip
// counts). The human thinks in BB (the client UI shows BB). Conversion happens
// at the DISPLAY EDGE ONLY — events carry chips + `bbChips`, the panel renders
// BB-primary with chips available. Nothing upstream converts.
//
// TRANSPORT: the stub is an in-process emitter (approved — demo-stable, no
// socket). It is WS-SWAPPABLE by construction: anything that calls
// `bus.publish(evt)` with a valid AdvisorEvent drives the panel, so a real
// WebSocket consumer (onmessage → publish) is a drop-in replacement.
//
// UMD: self-registers on window.AdvisorEvent; also CommonJS-exportable (node tests).
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  root.AdvisorEvent = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── event kinds (the panel's full state vocabulary) ───────────────────────
  // settling : frame not yet stable (no advice pending)
  // thinking : snapshot sent to brain, awaiting reply (~200ms)
  // advice   : brain replied with an action to take
  // stale    : a newer snapshot superseded an in-flight/shown advice — DO NOT USE
  // wait     : brain declined / strict-block — "NO ADVICE — YOU DECIDE"
  // escalate : §5 — eyes can't read the table in time — "CAN'T READ TABLE — YOU DECIDE"
  const KINDS = ['settling', 'thinking', 'advice', 'stale', 'wait', 'escalate'];

  const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

  // ── action → display verb ─────────────────────────────────────────────────
  const VERB = {
    fold: 'FOLD', check: 'CHECK', call: 'CALL',
    bet: 'BET', raise: 'RAISE', allin: 'ALL-IN',
  };

  // ── action → color family (contract item 1) ───────────────────────────────
  //   fold gray · check/call teal · bet/raise amber · all-in red
  const COLOR = {
    fold:  '#9aa0a6',
    check: '#2dd4bf', call: '#2dd4bf',
    bet:   '#f5a623', raise: '#f5a623',
    allin: '#ff4d4d',
  };

  // ── state → strip band background (contract item 3: unmissable, not a label) ─
  const STATE_BG = {
    settling: '#3a4a5a', // cool slate — "wait, not your move yet"
    thinking: '#4b3a78', // indigo — "working"
    advice:   '#14532d', // deep green — "go"
    stale:    '#7f1d1d', // crimson — the worst failure
    wait:     '#7c5e10', // dark amber — brain declined
    escalate: '#7c3a10', // burnt orange — eyes failed (distinct from wait)
  };

  const STATE_LABEL = {
    settling: 'SETTLING', thinking: 'THINKING', advice: 'ADVICE',
    stale: 'STALE', wait: 'WAIT', escalate: "CAN'T READ",
  };

  // Full-weight body message for the no-advice family. DISTINCT per the ruling:
  // the human must know whether the EYES failed or the BRAIN declined.
  const BLOCK_MSG = {
    wait: 'NO ADVICE — YOU DECIDE',     // brain declined
    escalate: "CAN'T READ TABLE — YOU DECIDE", // eyes couldn't read in time
    stale: 'STALE — DO NOT USE',        // superseded advice
  };

  // ── chips → BB, at the display edge only ──────────────────────────────────
  // Returns a number of BB rounded to 1 decimal, or null if bbChips is unusable.
  function toBB(chips, bbChips) {
    if (chips == null || bbChips == null || !(bbChips > 0)) return null;
    return Math.round((chips / bbChips) * 10) / 10;
  }

  // ── validator / normalizer ────────────────────────────────────────────────
  // Throws on a malformed event (fail loud in dev). Returns a frozen, defaulted
  // copy so the panel can render without optional-chaining everywhere.
  function normalize(evt) {
    if (!evt || typeof evt !== 'object') throw new Error('AdvisorEvent: not an object');
    if (!KINDS.includes(evt.kind)) throw new Error('AdvisorEvent: bad kind ' + evt.kind);
    if (!Number.isFinite(evt.seq)) throw new Error('AdvisorEvent: seq must be a finite number');

    const out = {
      kind: evt.kind,
      seq: evt.seq,
      action: null, verb: null,
      amountChips: null,
      sizing: null,
      fallbackUsed: !!evt.fallbackUsed,
      bbChips: Number.isFinite(evt.bbChips) ? evt.bbChips : null,
      urgency: {
        polls: evt.urgency && Number.isFinite(evt.urgency.polls) ? evt.urgency.polls : 0,
        elapsedMs: evt.urgency && Number.isFinite(evt.urgency.elapsedMs) ? evt.urgency.elapsedMs : 0,
        timerFrac: evt.urgency && Number.isFinite(evt.urgency.timerFrac) ? evt.urgency.timerFrac : null,
      },
    };

    if (evt.kind === 'advice') {
      if (!ACTIONS.includes(evt.action)) throw new Error('AdvisorEvent: advice needs a valid action, got ' + evt.action);
      out.action = evt.action;
      out.verb = VERB[evt.action];
      out.amountChips = Number.isFinite(evt.amountChips) ? evt.amountChips : null;
      // sizing only meaningful for bet/raise (contract item 2)
      if ((evt.action === 'bet' || evt.action === 'raise') && evt.sizing) {
        out.sizing = {
          raiseToChips: Number.isFinite(evt.sizing.raiseToChips) ? evt.sizing.raiseToChips : null,
          raiseByChips: Number.isFinite(evt.sizing.raiseByChips) ? evt.sizing.raiseByChips : null,
          potPct: Number.isFinite(evt.sizing.potPct) ? evt.sizing.potPct : null,
        };
      }
    }
    return out;
  }

  // ── tiny in-process pub/sub bus (the WS-swappable seam) ────────────────────
  function createBus() {
    const subs = new Set();
    return {
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      publish(evt) {
        const n = normalize(evt);           // validate at the boundary
        subs.forEach((fn) => { try { fn(n); } catch (e) { /* a bad subscriber must not break others */ } });
        return n;
      },
      get size() { return subs.size; },
    };
  }

  // ── the ONE shared bus (live→PiP bridge seam) ──────────────────────────────
  // Both the live converter (driver.jsx, the producer) and the always-on-top PiP
  // host (advisor-mount.jsx, the consumer) talk to this single instance, so the
  // PiP the human looks at shows LIVE advice. The stub publishes here too — last
  // writer wins (you run one source at a time). Process-singleton.
  let _shared = null;
  function sharedBus() { if (!_shared) _shared = createBus(); return _shared; }

  // ── live adapter: converter pipeline → AdvisorEvent (the production seam) ──
  // Pure + node-testable. Maps what the CURRENT converter actually exposes
  // (driver.jsx reaches conv.view.state, the parsed brain reply conv._advice,
  // conv._sentThisTurn, and the assembled `request` returned by conv.onFrame).
  //
  // State map (escalator vocab → panel kind):
  //   idle                       → settling   (not hero's turn; benign, nothing pending)
  //   waiting & !sentThisTurn     → settling   (hero's turn, frame not yet clean)
  //   waiting &  sentThisTurn     → thinking   (clean snapshot sent, awaiting brain)
  //   advising                   → advice
  //   escalate                   → escalate   (§5 clock-low, can't read)
  //   src.stale                  → stale      (CC-C: newer snapshot superseded shown advice)
  //   src.declined               → wait       (CC-C: brain declined / §3a panel disagreement)
  // `stale` and `wait` are now PRODUCED by the converter (amendment E):
  //   - src.stale: this._lastSentSeq > the shown advice's seq (a fresh snapshot
  //     superseded it). Carries the NEWER seq.
  //   - src.declined: a brain decline (botLink.onError) or a §3a panel↔arithmetic
  //     disagreement on what is still hero's turn.
  const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');
  function mapAction(action, abstractAction, amountChips, request) {
    const candidates = [_norm(action), _norm(abstractAction)];
    for (const c of candidates) {
      if (c === 'fold' || c === 'foldview') return 'fold';
      if (c === 'check') return 'check';
      if (c === 'call') return 'call';
      if (c === 'bet') return 'bet';
      if (c === 'raise' || c === 'double') return 'raise';
      if (c === 'allin') return 'allin';
    }
    return null; // unknown → caller falls back to a safe no-instruction
  }
  function heroCurrentBet(request) {
    if (!request || !Array.isArray(request.current_bets) || !Number.isFinite(request.hero_seat)) return null;
    const v = request.current_bets[request.hero_seat];
    return Number.isFinite(v) ? v : null;
  }
  // src: { view, advice, request, sentThisTurn, polls, timerFrac, bbChips }
  function fromConverter(src) {
    src = src || {};
    const view = src.view || {};
    const advice = src.advice || null;
    const request = src.request || null;
    const bbChips = Number.isFinite(src.bbChips) ? src.bbChips : 100;
    const polls = Number.isFinite(src.polls) ? src.polls : 0;
    const urgency = { polls, elapsedMs: polls * 250, timerFrac: Number.isFinite(src.timerFrac) ? src.timerFrac : null };
    const seq = (advice && Number.isFinite(advice.seq)) ? advice.seq
              : (Number.isFinite(src.lastSeq) ? src.lastSeq : 0);
    const base = { seq, bbChips, urgency };

    // stale supersedes everything — executing stale advice is the worst failure of
    // a tell-only tool. Carry the NEWER snapshot seq.
    if (src.stale) {
      const staleSeq = Number.isFinite(src.lastSeq) ? src.lastSeq : seq;
      return Object.assign({ kind: 'stale' }, base, { seq: staleSeq });
    }
    // brain declined / strict-block, or a §3a panel↔arithmetic disagreement → wait.
    if (src.declined) return Object.assign({ kind: 'wait' }, base);

    if (view.state === 'advising' && advice) {
      let action = mapAction(advice.action, advice.abstractAction, advice.amount, request);
      const amountChips = Number.isFinite(advice.amount) ? advice.amount : null;
      // all-in override: a raise-to total at/above hero's all-in total IS an all-in.
      if (action && (action === 'bet' || action === 'raise') && amountChips != null
          && request && Number.isFinite(request.max_raise) && amountChips >= request.max_raise) {
        action = 'allin';
      }
      if (!action) {
        // brain advised but the action is unparseable — never fabricate a verb.
        return Object.assign({ kind: 'wait' }, base);
      }
      const out = Object.assign({ kind: 'advice', action, amountChips, fallbackUsed: !!advice.fallbackUsed }, base);
      if ((action === 'bet' || action === 'raise') && amountChips != null) {
        const heroBet = heroCurrentBet(request);
        const pot = request && Number.isFinite(request.pot_committed) ? request.pot_committed : null;
        out.sizing = {
          raiseToChips: amountChips,
          raiseByChips: heroBet != null ? Math.max(0, amountChips - heroBet) : null,
          potPct: (pot && pot > 0) ? Math.round((amountChips / pot) * 100) : null,
        };
      }
      return out;
    }
    if (view.state === 'escalate') return Object.assign({ kind: 'escalate' }, base);
    if (view.state === 'waiting') return Object.assign({ kind: src.sentThisTurn ? 'thinking' : 'settling' }, base);
    return Object.assign({ kind: 'settling' }, base); // idle / unknown
  }

  return {
    KINDS, ACTIONS, VERB, COLOR, STATE_BG, STATE_LABEL, BLOCK_MSG,
    toBB, normalize, createBus, sharedBus, mapAction, fromConverter,
  };
});
