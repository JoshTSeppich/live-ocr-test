// advisor/AdvisorPanel.jsx — THE always-on-top advisor (contract items 1–9).
//
// Pure/presentational: props in → render. No subscriptions, no audio, no timers
// here (the controller in advisor-mount.jsx owns those) so this exact component
// renders identically in-page AND inside the Document-PiP window. Styles are
// INLINE on purpose: they travel with the elements into the PiP document, which
// has no access to dist/app.css.
//
// Reads at a glance under a running action clock: one dominant verb, color-coded;
// state as an unmissable full-width band, not a label; staleness as a red wash.
// Conversion to BB happens HERE, at the display edge (item: BB-primary).
//
// UMD-ish: self-registers window.AdvisorPanel.
/* global React, AdvisorEvent */
(function () {
  'use strict';
  const React = (typeof window !== 'undefined' && window.React) || null;
  const AE = (typeof window !== 'undefined' && window.AdvisorEvent) || null;
  if (!React) return;
  const h = React.createElement;

  const bb = (chips, bbChips) => AE.toBB(chips, bbChips);
  // "7.5BB" with chips in parens, e.g. "7.5BB (750)"
  const bbStr = (chips, bbChips) => {
    const v = bb(chips, bbChips);
    if (v == null) return chips != null ? String(chips) : '—';
    return v + 'BB';
  };
  const chipsStr = (chips) => (chips != null ? '(' + chips + ')' : '');

  function AdvisorPanel(props) {
    const evt = props.event; // normalized AdvisorEvent or null
    const muted = !!props.muted;
    const kind = evt ? evt.kind : 'settling';
    const isAdvice = kind === 'advice';
    const isStale = kind === 'stale';
    const isWait = kind === 'wait';
    const isEscalate = kind === 'escalate';
    const isBlock = isWait || isEscalate;

    const bandBg = AE.STATE_BG[kind] || AE.STATE_BG.settling;
    const stateLabel = AE.STATE_LABEL[kind] || '—';
    const action = isAdvice ? evt.action : null;
    const verbColor = isAdvice ? AE.COLOR[action] : '#e8e8e8';
    const fallback = !!(evt && evt.fallbackUsed);

    // ── styles ────────────────────────────────────────────────────────────
    const root = {
      boxSizing: 'border-box', width: '100%', height: '100%', minHeight: 180,
      display: 'flex', flexDirection: 'column',
      font: '13px -apple-system, system-ui, sans-serif',
      background: '#0b0d10', color: '#e8e8e8',
      // contract item 6: loud persistent amber border when fallback_used
      border: fallback ? '4px solid #f5a623' : '4px solid transparent',
      opacity: isStale ? 0.78 : 1,
      position: 'relative', overflow: 'hidden',
    };
    const band = {
      flex: '0 0 auto', padding: '6px 10px', background: bandBg,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontWeight: 800, letterSpacing: 1.5, fontSize: 14,
      textShadow: '0 1px 2px rgba(0,0,0,.6)',
    };
    const body = {
      flex: '1 1 auto', display: 'flex', flexDirection: 'column',
      justifyContent: 'center', alignItems: 'center', textAlign: 'center',
      padding: '4px 8px', gap: 6,
    };
    const verbStyle = {
      fontSize: 64, lineHeight: 1, fontWeight: 900, color: verbColor,
      letterSpacing: 1, textShadow: '0 2px 6px rgba(0,0,0,.5)',
    };
    const blockStyle = {
      fontSize: 30, lineHeight: 1.05, fontWeight: 900,
      color: '#fff', padding: '4px 6px',
    };
    const staleStyle = {
      fontSize: 34, lineHeight: 1.05, fontWeight: 900, color: '#fff',
      background: '#7f1d1d', padding: '8px 12px', borderRadius: 6,
      letterSpacing: 1,
    };
    const sizingRow = { display: 'flex', gap: 14, alignItems: 'baseline', justifyContent: 'center', flexWrap: 'wrap' };
    const sizeCell = { display: 'flex', flexDirection: 'column', alignItems: 'center' };
    const sizeBig = { fontSize: 22, fontWeight: 800, color: '#fff' };
    const sizeLbl = { fontSize: 10, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 1 };
    const chipsMut = { fontSize: 11, color: '#6b7177' };
    const footer = {
      flex: '0 0 auto', display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', padding: '4px 10px', borderTop: '1px solid #1c2026',
      fontSize: 11, color: '#9aa0a6',
    };
    const muteBtn = {
      cursor: 'pointer', border: '1px solid #2a2f36', borderRadius: 4,
      background: 'transparent', color: muted ? '#f5a623' : '#9aa0a6',
      fontSize: 12, padding: '2px 6px',
    };

    // ── body content per kind ────────────────────────────────────────────
    let content;
    if (isStale) {
      content = h('div', { style: body },
        h('div', { style: staleStyle }, AE.BLOCK_MSG.stale));
    } else if (isBlock) {
      // distinct labels: eyes failed vs brain declined (same full-weight family)
      content = h('div', { style: body },
        h('div', { style: blockStyle }, isWait ? AE.BLOCK_MSG.wait : AE.BLOCK_MSG.escalate));
    } else if (isAdvice) {
      const children = [h('div', { key: 'verb', style: verbStyle }, evt.verb)];
      // sizing line — bet/raise only (contract item 2): three forms side by side
      if (evt.sizing && (action === 'bet' || action === 'raise')) {
        const s = evt.sizing;
        children.push(h('div', { key: 'sizing', style: sizingRow },
          h('div', { style: sizeCell },
            h('div', { style: sizeBig }, bbStr(s.raiseToChips, evt.bbChips)),
            h('div', { style: chipsMut }, chipsStr(s.raiseToChips)),
            h('div', { style: sizeLbl }, 'raise to')),
          h('div', { style: sizeCell },
            h('div', { style: sizeBig }, '+' + bbStr(s.raiseByChips, evt.bbChips)),
            h('div', { style: chipsMut }, chipsStr(s.raiseByChips)),
            h('div', { style: sizeLbl }, 'raise by')),
          h('div', { style: sizeCell },
            h('div', { style: sizeBig }, (s.potPct != null ? s.potPct + '%' : '—')),
            h('div', { style: chipsMut }, ' '),
            h('div', { style: sizeLbl }, 'of pot'))));
      } else if (evt.amountChips != null && (action === 'call' || action === 'allin')) {
        // call/all-in: show the amount (BB primary) — it's part of the instruction
        children.push(h('div', { key: 'amt', style: sizingRow },
          h('div', { style: sizeCell },
            h('div', { style: sizeBig }, bbStr(evt.amountChips, evt.bbChips)),
            h('div', { style: chipsMut }, chipsStr(evt.amountChips)),
            h('div', { style: sizeLbl }, action === 'call' ? 'to call' : 'all-in'))));
      }
      content = h('div', { style: body }, children);
    } else {
      // settling / thinking — never blank (contract item 5)
      content = h('div', { style: body },
        h('div', { style: { fontSize: 20, fontWeight: 700, color: '#6b7177', letterSpacing: 2 } },
          kind === 'thinking' ? 'THINKING…' : 'SETTLING…'));
    }

    // ── urgency proxy (item 8) ───────────────────────────────────────────
    const u = evt && evt.urgency ? evt.urgency : { polls: 0, elapsedMs: 0, timerFrac: null };
    const urgencyText = (u.timerFrac != null ? Math.round(u.timerFrac * 100) + '% clock · ' : '')
      + u.polls + ' polls';

    return h('div', { style: root, 'data-kind': kind, 'data-seq': evt ? evt.seq : -1 },
      h('div', { style: band },
        h('span', null, stateLabel + (fallback ? '  ⚠ FALLBACK' : '')),
        h('span', { style: { fontSize: 11, opacity: 0.85, letterSpacing: 1 } }, 'seq ' + (evt ? evt.seq : '—'))),
      content,
      h('div', { style: footer },
        h('span', null, urgencyText),
        h('button', {
          style: muteBtn, title: 'mute audio cues',
          onClick: props.onToggleMute,
        }, muted ? '🔇 muted' : '🔊 sound')));
  }

  if (typeof window !== 'undefined') window.AdvisorPanel = AdvisorPanel;
})();
