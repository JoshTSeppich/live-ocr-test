// converter/botLink.js — Layer 4 transport (CONVERTER_BUILD_SPEC §4): a thin
// WebSocket client to the brain at ws://127.0.0.1:8766.
//
//   • Sends {seq, request} (ZoomObservation envelope; optionals omitted).
//   • Parses the reply branching on "response" (ZoomAdvice) vs "error".
//   • A ~200-entry ring buffer holds outgoing requests while the brain is down;
//     they flush on reconnect (oldest dropped past the cap).
//   • Reconnect with exponential backoff. A DROPPED BRAIN CONNECTION MUST NOT
//     CRASH THE EYES — every socket fault is caught and turns into a reconnect,
//     never a throw into the capture loop.
//
// The WebSocket impl and timer are injectable so the whole thing is node-testable
// with a fake socket (no real network, no real time).
//
// UMD: `window.PokerBotLink` in browser, `module.exports` under Node.
(function (root, factory) {
  const m = factory(typeof require === 'function' ? require : null, root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  if (root) root.PokerBotLink = m;
})(typeof self !== 'undefined' ? self : this, function (req, root) {
  'use strict';

  const Assembler = req ? req('./assembler.js') : (root && root.PokerAssembler);

  const DEFAULTS = {
    url: 'ws://127.0.0.1:8766',
    bufferSize: 200,
    backoffStartMs: 250,
    backoffMaxMs: 5000,
  };

  // WebSocket readyState constants (avoid depending on a global WebSocket).
  const OPEN = 1;

  class BotLink {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url || DEFAULTS.url;
      this.bufferSize = opts.bufferSize != null ? opts.bufferSize : DEFAULTS.bufferSize;
      this.backoffStartMs = opts.backoffStartMs != null ? opts.backoffStartMs : DEFAULTS.backoffStartMs;
      this.backoffMaxMs = opts.backoffMaxMs != null ? opts.backoffMaxMs : DEFAULTS.backoffMaxMs;
      // injectable for tests; default to browser globals
      this._createSocket = opts.createSocket || ((url) => new root.WebSocket(url));
      this._setTimeout = opts.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
      this._clearTimeout = opts.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

      this.onAdvice = opts.onAdvice || (() => {});
      this.onError = opts.onError || (() => {});
      this.onStatus = opts.onStatus || (() => {});

      this._sock = null;
      this._seq = 0;
      this._buffer = [];          // pending {seq, request} envelopes
      this._backoff = this.backoffStartMs;
      this._reconnectTimer = null;
      this._closedByUser = false;
      this.status = 'idle';       // idle|connecting|open|reconnecting|closed
    }

    _setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

    connect() {
      this._closedByUser = false;
      this._open();
    }

    _open() {
      if (this._closedByUser) return;
      this._setStatus('connecting');
      let sock;
      try { sock = this._createSocket(this.url); }
      catch (e) { this._scheduleReconnect(); return; } // creation failed → retry
      this._sock = sock;
      sock.onopen = () => {
        this._backoff = this.backoffStartMs;
        this._setStatus('open');
        this._flush();
      };
      sock.onmessage = (ev) => this._onMessage(ev && ev.data != null ? ev.data : ev);
      sock.onerror = () => { /* swallowed; onclose drives the reconnect */ };
      sock.onclose = () => {
        this._sock = null;
        if (!this._closedByUser) this._scheduleReconnect();
        else this._setStatus('closed');
      };
    }

    _scheduleReconnect() {
      if (this._closedByUser || !this._setTimeout) return;
      this._setStatus('reconnecting');
      const delay = this._backoff;
      this._backoff = Math.min(this._backoff * 2, this.backoffMaxMs);
      this._reconnectTimer = this._setTimeout(() => this._open(), delay);
    }

    // Send a GameStateRequest. Returns the assigned seq. Buffers if not open.
    send(request) {
      const seq = ++this._seq;
      const env = Assembler.buildEnvelope(seq, request);
      if (this._sock && this._sock.readyState === OPEN) {
        if (!this._rawSend(env)) this._enqueue(env);
      } else {
        this._enqueue(env);
      }
      return seq;
    }

    _rawSend(env) {
      try { this._sock.send(JSON.stringify(env)); return true; }
      catch (e) { return false; } // never throw into the caller (the eyes)
    }

    _enqueue(env) {
      this._buffer.push(env);
      if (this._buffer.length > this.bufferSize) this._buffer.shift(); // drop oldest
    }

    _flush() {
      const pending = this._buffer;
      this._buffer = [];
      for (const env of pending) {
        if (!(this._sock && this._sock.readyState === OPEN && this._rawSend(env))) {
          this._enqueue(env); // socket went away mid-flush → re-buffer the rest
        }
      }
    }

    _onMessage(raw) {
      let msg;
      try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (e) { this.onError({ kind: 'malformed', error: 'reply-parse-failed' }); return; }
      const parsed = Assembler.parseReply(msg);
      if (parsed.ok) this.onAdvice(parsed);
      else this.onError(parsed);
    }

    close() {
      this._closedByUser = true;
      if (this._reconnectTimer && this._clearTimeout) this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      try { if (this._sock) this._sock.close(); } catch (e) { /* ignore */ }
      this._sock = null;
      this._setStatus('closed');
    }

    get pending() { return this._buffer.length; }
  }

  return { BotLink, DEFAULTS };
});
