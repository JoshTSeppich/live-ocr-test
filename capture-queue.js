// capture-queue.js — background queue of card captures awaiting human labels.
//
// The OCR loop drops cells the matcher doesn't recognize into this queue.
// The TeachZone UI pulls one record at a time, shows the cell + its source
// frame, and the user assigns a card code. Records persist across reloads
// via IndexedDB (browser) or an in-memory adapter (Node, used by tests).
//
// Public surface (exposed as window.CaptureQueue in a browser,
// module.exports in Node):
//   init(opts?)                         opts.adapter: 'idb'|'memory'|undefined
//   enqueue(record)                  → id
//   head()                           → oldest pending record or null
//   list({status?, topGuess?, limit?, before?})
//   count(status?)                   → integer
//   markLabeled(id, card)            → updated record
//   markTrashed(id)                  → updated record
//   markSkipped(id)                  → bumps ts, keeps pending
//   undoLast()                       → reverts most recent labeled → pending
//   recent(n=10)                     → labeled/trashed, newest first
//   get(id)                          → single record or null
//   clear()                          → drops everything
//   isDuplicate(probeHash, dist=30)  → bool, scans recent ~20 pending
//   dropIfMatcherKnowsNow(matcher, thresh=0.85) → {dropped}
//
// Record shape (all fields):
//   { id, ts, regionId, cellIndex, cellRgba (ArrayBuffer), cellW, cellH,
//     sourceFrameJpeg (Blob), sourceFrameW, sourceFrameH,
//     bboxInSourceFrame: {x, y, w, h},
//     matcherConfidence, matcherTopGuess,
//     handId, street, status, labelHistory: [{card, ts, action}] }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaptureQueue = factory();
}(typeof self !== 'undefined' ? self : this, function () {

// ─── storage adapters ──────────────────────────────────────────────────

class MemoryStore {
  constructor() { this.records = new Map(); this.nextId = 1; }
  async open() { /* nothing */ }
  async put(record) {
    if (record.id == null) { record.id = this.nextId++; }
    else { this.nextId = Math.max(this.nextId, record.id + 1); }
    // Shallow clone so the caller doesn't keep a live reference into the store.
    this.records.set(record.id, { ...record, labelHistory: [...(record.labelHistory || [])] });
    return record.id;
  }
  async update(id, patch) {
    const r = this.records.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return r;
  }
  async get(id) { return this.records.get(id) || null; }
  async getAll() { return [...this.records.values()]; }
  async delete(id) { this.records.delete(id); }
  async clear() { this.records.clear(); this.nextId = 1; }
}

class IDBStore {
  constructor(dbName, storeName) {
    this.dbName = dbName || 'pixelpoker-captures';
    this.storeName = storeName || 'captures';
    this.db = null;
  }
  async open() {
    if (this.db) return;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const os = db.createObjectStore(this.storeName,
            { keyPath: 'id', autoIncrement: true });
          os.createIndex('byTimestamp', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  _store(mode) {
    const tx = this.db.transaction(this.storeName, mode);
    return tx.objectStore(this.storeName);
  }
  _wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async put(record) {
    const os = this._store('readwrite');
    const cleaned = { ...record };
    if (cleaned.id == null) delete cleaned.id; // let autoIncrement assign
    return this._wrap(os.put(cleaned));
  }
  async update(id, patch) {
    const os = this._store('readwrite');
    const existing = await this._wrap(os.get(id));
    if (!existing) return null;
    Object.assign(existing, patch);
    await this._wrap(os.put(existing));
    return existing;
  }
  async get(id) {
    const os = this._store('readonly');
    return (await this._wrap(os.get(id))) || null;
  }
  async getAll() {
    const os = this._store('readonly');
    return this._wrap(os.getAll());
  }
  async delete(id) {
    const os = this._store('readwrite');
    return this._wrap(os.delete(id));
  }
  async clear() {
    const os = this._store('readwrite');
    return this._wrap(os.clear());
  }
}

// ─── CaptureQueue public API ───────────────────────────────────────────

let _store = null;
const QUEUE_CAP_PENDING = 200;

async function init(opts) {
  const adapter = opts && opts.adapter;
  const wantMemory = adapter === 'memory'
    || (adapter == null && typeof indexedDB === 'undefined');
  _store = wantMemory ? new MemoryStore() : new IDBStore();
  await _store.open();
}

function _requireStore() {
  if (!_store) throw new Error('CaptureQueue.init() must be called first');
  return _store;
}

async function enqueue(rec) {
  const store = _requireStore();
  // Enforce pending cap: drop oldest pending(s) first.
  const all = await store.getAll();
  const pending = all.filter((r) => r.status === 'pending')
                     .sort((a, b) => a.id - b.id);
  while (pending.length >= QUEUE_CAP_PENDING) {
    const oldest = pending.shift();
    await store.delete(oldest.id);
  }
  const id = await store.put({
    ...rec,
    status: rec.status || 'pending',
    labelHistory: rec.labelHistory || [],
  });
  return id;
}

async function head() {
  const store = _requireStore();
  const all = await store.getAll();
  const pending = all.filter((r) => r.status === 'pending')
                     .sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
  return pending[0] || null;
}

async function list(opts) {
  const { status, topGuess, limit, before } = opts || {};
  const store = _requireStore();
  let all = await store.getAll();
  if (status)   all = all.filter((r) => r.status === status);
  if (topGuess) all = all.filter((r) => r.matcherTopGuess === topGuess);
  if (before != null) all = all.filter((r) => r.ts < before);
  all.sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
  if (limit != null) all = all.slice(0, limit);
  return all;
}

async function count(status) {
  const store = _requireStore();
  const all = await store.getAll();
  if (status == null) return all.length;
  return all.filter((r) => r.status === status).length;
}

async function markLabeled(id, card) {
  const store = _requireStore();
  const r = await store.get(id);
  if (!r) return null;
  const entry = { card, ts: Date.now(), action: 'label' };
  return store.update(id, {
    status: 'labeled',
    labelHistory: [...(r.labelHistory || []), entry],
  });
}

async function markTrashed(id) {
  const store = _requireStore();
  const r = await store.get(id);
  if (!r) return null;
  const entry = { card: null, ts: Date.now(), action: 'trash' };
  return store.update(id, {
    status: 'trashed',
    labelHistory: [...(r.labelHistory || []), entry],
  });
}

async function markSkipped(id) {
  const store = _requireStore();
  const r = await store.get(id);
  if (!r) return null;
  // Keep status='pending' but bump ts so it sorts to the back of the queue.
  return store.update(id, { status: 'pending', ts: Date.now() });
}

function _lastHistoryTs(r) {
  const last = (r.labelHistory && r.labelHistory.length)
    ? r.labelHistory[r.labelHistory.length - 1]
    : null;
  return last ? last.ts : r.ts;
}

async function undoLast() {
  const store = _requireStore();
  const all = await store.getAll();
  const labeled = all.filter((r) => r.status === 'labeled')
                     .sort((a, b) => _lastHistoryTs(b) - _lastHistoryTs(a));
  const target = labeled[0];
  if (!target) return null;
  const entry = { card: null, ts: Date.now(), action: 'undo' };
  return store.update(target.id, {
    status: 'pending',
    labelHistory: [...(target.labelHistory || []), entry],
  });
}

async function recent(n) {
  const limit = Math.max(1, n || 10);
  const store = _requireStore();
  const all = await store.getAll();
  return all
    .filter((r) => r.status === 'labeled' || r.status === 'trashed')
    .sort((a, b) => _lastHistoryTs(b) - _lastHistoryTs(a))
    .slice(0, limit);
}

async function get(id) {
  const store = _requireStore();
  return store.get(id);
}

async function clear() {
  const store = _requireStore();
  return store.clear();
}

function _engine() {
  if (typeof window !== 'undefined' && window.PokerEngine) return window.PokerEngine;
  if (typeof require === 'function') {
    try { return require('./engine.js'); } catch (_) { return null; }
  }
  return null;
}

async function isDuplicate(probeHash, maxHammingDistance) {
  const thresh = maxHammingDistance == null ? 30 : maxHammingDistance;
  const E = _engine();
  if (!E) return false;
  const store = _requireStore();
  const all = await store.getAll();
  const recents = all
    .filter((r) => r.status === 'pending')
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  for (const r of recents) {
    const h = E.hashCardRGBA(new Uint8Array(r.cellRgba), r.cellW, r.cellH);
    if (E.hammingDistance(probeHash, h) <= thresh) return true;
  }
  return false;
}

async function dropIfMatcherKnowsNow(matcher, thresh) {
  const t = thresh == null ? 0.85 : thresh;
  if (!matcher || matcher.size === 0) return { dropped: 0 };
  const store = _requireStore();
  const all = await store.getAll();
  let dropped = 0;
  for (const r of all) {
    if (r.status !== 'pending') continue;
    const m = matcher.match(new Uint8Array(r.cellRgba), r.cellW, r.cellH);
    if (m && m.confidence >= t) {
      await store.delete(r.id);
      dropped++;
    }
  }
  return { dropped };
}

return {
  init, enqueue, head, list, count,
  markLabeled, markTrashed, markSkipped, undoLast,
  recent, get, clear,
  isDuplicate, dropIfMatcherKnowsNow,
  // Internals exposed for tests.
  _MemoryStore: MemoryStore,
  _IDBStore: IDBStore,
  _QUEUE_CAP_PENDING: QUEUE_CAP_PENDING,
  _resetForTests() { _store = null; },
};
}));
