// converter/botLink.test.cjs — WebSocket client: buffering, flush, reply
// routing, ring-buffer cap, reconnect/backoff, no-throw on a dead link.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BotLink } = require('./botLink.js');

// Fake WebSocket: records sends; test drives open/message/close manually.
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
  send(s) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  _msg(data) { if (this.onmessage) this.onmessage({ data }); }
  _drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

// Manual scheduler so reconnect timing is deterministic.
function harness(opts) {
  const sockets = [];
  const timers = [];
  const link = new BotLink(Object.assign({
    createSocket: (url) => { const s = new FakeWS(url); sockets.push(s); return s; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeout: () => {},
  }, opts));
  return { link, sockets, timers, fire: () => { const t = timers.splice(0); t.forEach((x) => x.fn()); } };
}
const REQ = { schema_version: 1, table_size: 6 };

test('send while down buffers; flushes on open', () => {
  const h = harness();
  h.link.connect();
  h.link.send(REQ);
  assert.strictEqual(h.link.pending, 1, 'buffered while connecting');
  assert.strictEqual(h.sockets[0].sent.length, 0);
  h.sockets[0]._open();
  assert.strictEqual(h.link.pending, 0, 'flushed on open');
  assert.strictEqual(h.sockets[0].sent.length, 1);
  const env = JSON.parse(h.sockets[0].sent[0]);
  assert.deepStrictEqual(Object.keys(env).sort(), ['request', 'seq']);
  assert.strictEqual(env.seq, 1);
});

test('send while open goes straight out', () => {
  const h = harness();
  h.link.connect(); h.sockets[0]._open();
  h.link.send(REQ);
  assert.strictEqual(h.sockets[0].sent.length, 1);
  assert.strictEqual(h.link.pending, 0);
});

test('reply with response → onAdvice', () => {
  let advice = null;
  const h = harness({ onAdvice: (a) => { advice = a; } });
  h.link.connect(); h.sockets[0]._open();
  h.sockets[0]._msg(JSON.stringify({ seq: 1, response: { advice: 'BOT SAYS: CALL 2', action: 'call', amount: 2 } }));
  assert.ok(advice && advice.ok);
  assert.strictEqual(advice.advice, 'BOT SAYS: CALL 2');
  assert.strictEqual(advice.amount, 2);
});

test('reply with error → onError', () => {
  let err = null;
  const h = harness({ onError: (e) => { err = e; } });
  h.link.connect(); h.sockets[0]._open();
  h.sockets[0]._msg(JSON.stringify({ seq: 1, error: 'validation_error', details: {} }));
  assert.ok(err && !err.ok);
  assert.strictEqual(err.error, 'validation_error');
});

test('ring buffer caps at bufferSize, dropping oldest', () => {
  const h = harness({ bufferSize: 200 });
  h.link.connect(); // never opens
  for (let i = 0; i < 250; i++) h.link.send(REQ);
  assert.strictEqual(h.link.pending, 200);
  h.sockets[0]._open();
  // 200 flushed; the first 50 seqs were dropped → lowest flushed seq is 51
  const seqs = h.sockets[0].sent.map((s) => JSON.parse(s).seq);
  assert.strictEqual(seqs.length, 200);
  assert.strictEqual(seqs[0], 51);
  assert.strictEqual(seqs[199], 250);
});

test('reconnect with backoff after a drop', () => {
  const h = harness({ backoffStartMs: 250 });
  h.link.connect(); h.sockets[0]._open();
  h.sockets[0]._drop();
  assert.strictEqual(h.link.status, 'reconnecting');
  assert.strictEqual(h.timers[0].ms, 250, 'first backoff');
  h.fire(); // reconnect
  assert.strictEqual(h.sockets.length, 2, 'a new socket was created');
  h.sockets[1]._open();
  assert.strictEqual(h.link.status, 'open');
});

test('user close() stops reconnect', () => {
  const h = harness();
  h.link.connect(); h.sockets[0]._open();
  h.link.close();
  assert.strictEqual(h.link.status, 'closed');
  // a subsequent drop callback must not schedule a reconnect
  assert.strictEqual(h.timers.length, 0);
});

test('a dead link never throws into the caller', () => {
  const h = harness();
  h.link.connect();
  // socket exists but not open; send must buffer, not throw
  assert.doesNotThrow(() => h.link.send(REQ));
  // even if the socket send() itself throws, _rawSend swallows it
  h.sockets[0].readyState = 1;
  h.sockets[0].send = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => h.link.send(REQ));
});

test('buffered sends survive a flush where the socket dies mid-way', () => {
  const h = harness();
  h.link.connect();
  h.link.send(REQ); h.link.send(REQ);
  // open, but make send throw so flush re-buffers
  h.sockets[0].readyState = 1;
  h.sockets[0].send = () => { throw new Error('boom'); };
  h.sockets[0]._open();
  assert.strictEqual(h.link.pending, 2, 're-buffered on failed flush');
});
