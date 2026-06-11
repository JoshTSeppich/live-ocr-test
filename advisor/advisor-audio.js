// advisor/advisor-audio.js — the zero-glance channel (contract item 7).
//
// The human watches the table, not the panel, so sound carries the two signals
// that must never be missed: ADVICE-ready and STALE. Two DISTINCT cues:
//   • advice : a short rising two-tone chime (neutral "ready")
//   • stale  : a harsh low double-buzz (alarming "do NOT use")
//
// Default = SOUND ON. The contract's "mute toggle, default on" is the safety
// reading: the zero-glance channel is live unless the human silences it. The
// AudioContext must be created/resumed from a user gesture (the panel-open
// click), per browser autoplay policy.
//
// UMD: self-registers window.AdvisorAudio.
(function (root, factory) {
  const m = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  root.AdvisorAudio = m;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function createAudio() {
    let ctx = null;
    let muted = false;

    function ensure() {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    // Schedule one tone on the shared context.
    function tone(c, freq, startMs, durMs, type, gainPeak) {
      const t0 = c.currentTime + startMs / 1000;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gainPeak == null ? 0.18 : gainPeak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      osc.connect(g).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + durMs / 1000 + 0.02);
    }

    return {
      // call once from the panel-open user gesture to unlock audio
      unlock() { ensure(); },
      get muted() { return muted; },
      setMuted(v) { muted = !!v; },
      toggle() { muted = !muted; return muted; },

      // rising two-tone — "advice ready"
      advice() {
        if (muted) return;
        const c = ensure(); if (!c) return;
        tone(c, 660, 0,  120, 'sine', 0.18);
        tone(c, 880, 90, 160, 'sine', 0.20);
      },

      // harsh low double-buzz — "STALE, do not use" (deliberately unpleasant)
      stale() {
        if (muted) return;
        const c = ensure(); if (!c) return;
        tone(c, 200, 0,   160, 'square', 0.22);
        tone(c, 160, 200, 220, 'square', 0.24);
      },
    };
  }

  return { createAudio };
});
