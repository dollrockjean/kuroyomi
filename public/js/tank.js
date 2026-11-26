// Phone audio tank: read-aloud audio kept on the phone (IndexedDB), so a drive through a dead zone,
// a PC that is switched off or a server that is asleep still has hours of voice ready.
//
// - Every clip that arrives (real Kokoro or real Edge, under its own key) is saved.
// - The tank's size follows how much he listens: about 2 days of his last 2 weeks' average, never
//   less than 30 minutes, never more than 12 hours. A quiet week shrinks it and old audio is cleared.
// - Filling past the normal look-ahead happens on Wi-Fi only, unless "Use mobile data" is on. iPhone
//   Safari cannot tell Wi-Fi from mobile data, so there an unknown connection counts as mobile data.
// - Speed is applied on the phone, so one clip serves every speed. About 20 MB per hour of audio.
'use strict';
(function (root) {
  const DB_NAME = 'byob-audio-tank';
  const STORE = 'clips';
  const DAY_MS = 86400000;

  const AudioTank = {
    LISTEN_KEY: 'byob_tank_listen',       // { 'YYYY-MM-DD': seconds of audio played }
    CELLULAR_KEY: 'byob_tank_cellular',   // '1' = fill on mobile data too
    HISTORY_DAYS: 14,
    TARGET_DAYS: 2,
    MIN_SECONDS: 30 * 60,
    MAX_SECONDS: 12 * 3600,
    STALE_DAYS: 14,                       // a clip nobody played or saved for this long goes
    BYTES_PER_SECOND: 20 * 1024 * 1024 / 3600,  // about 20 MB per hour when nothing is measured yet

    _db: null,
    _dbPromise: null,
    _meta: new Map(),                     // key -> { bytes, seconds, savedAt, playedAt }; blobs stay on disk
    _ready: null,
    _pendingListen: 0,
    _listenFlushAt: 0,
    disabled: false,

    // ---- pure parts (tested in Node) ------------------------------------------------------------

    dayKey(ms) {
      const d = new Date(ms);
      const p = (n) => (n < 10 ? '0' : '') + n;
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },

    // Keeps only the last HISTORY_DAYS days of a listening log.
    pruneLog(log, now) {
      const out = {};
      const oldest = this.dayKey(now - (this.HISTORY_DAYS - 1) * DAY_MS);
      for (const day of Object.keys(log || {})) {
        const v = Number(log[day]);
        if (day >= oldest && isFinite(v) && v > 0) out[day] = v;
      }
      return out;
    },

    // Seconds of audio the tank aims to hold: 2 days of the 14-day daily average, at least 30 minutes.
    targetSeconds(log, now) {
      const kept = this.pruneLog(log, now);
      let total = 0;
      for (const day of Object.keys(kept)) total += kept[day];
      const want = (total / this.HISTORY_DAYS) * this.TARGET_DAYS;
      return Math.round(Math.min(this.MAX_SECONDS, Math.max(this.MIN_SECONDS, want)));
    },

    // Measured bytes per second of the clips held, or the 20 MB/hour guess.
    bytesPerSecond(entries) {
      let b = 0, s = 0;
      for (const e of entries) { if (e.seconds > 0 && e.bytes > 0) { b += e.bytes; s += e.seconds; } }
      return s > 60 ? b / s : this.BYTES_PER_SECOND;
    },

    // Which clips to delete: anything stale, then the longest-unplayed first until the tank fits.
    // `protect` holds keys that must stay (the audio just ahead of where he is).
    evictionPlan(entries, budgetBytes, now, protect) {
      const keep = protect || new Set();
      const drop = [];
      const staleBefore = now - this.STALE_DAYS * DAY_MS;
      let used = 0;
      const live = [];
      for (const e of entries) {
        const last = Math.max(e.playedAt || 0, e.savedAt || 0);
        if (!keep.has(e.key) && last < staleBefore) drop.push(e.key);
        else { live.push(e); used += e.bytes || 0; }
      }
      if (used <= budgetBytes) return drop;
      // Played clips go before unplayed ones (unplayed is audio still ahead of him), oldest first.
      const order = live.filter(e => !keep.has(e.key)).sort((a, b) => {
        const ap = a.playedAt ? 0 : 1, bp = b.playedAt ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (a.playedAt || a.savedAt || 0) - (b.playedAt || b.savedAt || 0);
      });
      for (const e of order) {
        if (used <= budgetBytes) break;
        drop.push(e.key);
        used -= e.bytes || 0;
      }
      return drop;
    },

    // 'full' = fill up to the target; 'lookahead' = only what the normal look-ahead already fetches.
    fillMode(connection, cellularAllowed) {
      if (connection && connection.saveData) return 'lookahead';
      const type = connection && connection.type;
      if (type === 'wifi' || type === 'ethernet') return 'full';
      if (type === 'none') return 'lookahead';
      // Mobile data, or a phone that will not say (iPhone): only when he allowed mobile data.
      return cellularAllowed ? 'full' : 'lookahead';
    },

    // ---- settings and listening log -------------------------------------------------------------

    readLog() {
      try { return JSON.parse(localStorage.getItem(this.LISTEN_KEY) || '{}') || {}; } catch (e) { return {}; }
    },

    cellularAllowed() {
      try { return localStorage.getItem(this.CELLULAR_KEY) === '1'; } catch (e) { return false; }
    },

    setCellularAllowed(on) {
      try { localStorage.setItem(this.CELLULAR_KEY, on ? '1' : '0'); } catch (e) {}
      this.updateUI();
    },

    currentFillMode() {
      const c = (typeof navigator !== 'undefined' && navigator.connection) || null;
      return this.fillMode(c, this.cellularAllowed());
    },

    // Seconds of audio played (already multiplied by speed, so it is audio, not wall time).
    recordListen(audioSeconds, now) {
      if (!(audioSeconds > 0) || audioSeconds > 30) return;
      this._pendingListen += audioSeconds;
      const t = now || Date.now();
      if (t - this._listenFlushAt < 30000 && this._pendingListen < 60) return;
      this.flushListen(t);
    },

    flushListen(now) {
      const t = now || Date.now();
      if (this._pendingListen <= 0) return;
      const log = this.pruneLog(this.readLog(), t);
      const day = this.dayKey(t);
      log[day] = Math.round(((log[day] || 0) + this._pendingListen) * 10) / 10;
      this._pendingListen = 0;
      this._listenFlushAt = t;
      try { localStorage.setItem(this.LISTEN_KEY, JSON.stringify(log)); } catch (e) {}
    },

    target() { return this.targetSeconds(this.readLog(), Date.now()); },

    // ---- storage --------------------------------------------------------------------------------

    openDb() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve) => {
        try {
          if (typeof indexedDB === 'undefined' || !indexedDB) { this.disabled = true; resolve(null); return; }
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
          };
          req.onsuccess = () => { this._db = req.result; resolve(this._db); };
          req.onerror = () => { this.disabled = true; resolve(null); };
          req.onblocked = () => resolve(null);
        } catch (e) { this.disabled = true; resolve(null); }
      });
      return this._dbPromise;
    },

    _tx(mode, fn) {
      return this.openDb().then((db) => new Promise((resolve) => {
        if (!db) { resolve(null); return; }
        try {
          const tx = db.transaction(STORE, mode);
          const store = tx.objectStore(STORE);
          let out = null;
          const r = fn(store);
          if (r) r.onsuccess = () => { out = r.result; };
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
      }));
    },

    // Loads the list of clips (not their audio) once, and trims to the current target.
    init() {
      if (this._ready) return this._ready;
      this._ready = this.openDb().then((db) => new Promise((resolve) => {
        if (!db) { resolve(); return; }
        try {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            const v = cur.value;
            this._meta.set(v.key, { bytes: v.bytes || 0, seconds: v.seconds || 0, savedAt: v.savedAt || 0, playedAt: v.playedAt || 0 });
            cur.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (e) { resolve(); }
      })).then(() => this.trim()).then(() => this.updateUI());
      return this._ready;
    },

    has(key) { return this._meta.has(key); },

    // The stored clip as a Blob, or null. Marks it played-recently so it is the last to go.
    async get(key) {
      if (!key || !this._meta.has(key)) return null;
      const rec = await this._tx('readonly', (s) => s.get(key));
      if (!rec || !rec.blob) { this._meta.delete(key); return null; }
      return rec.blob;
    },

    markPlayed(key) {
      const m = this._meta.get(key);
      if (!m) return;
      m.playedAt = Date.now();
      this._tx('readwrite', (s) => {
        const r = s.get(key);
        r.onsuccess = () => { const v = r.result; if (v) { v.playedAt = m.playedAt; s.put(v); } };
        return null;
      });
    },

    async put(key, blob, seconds) {
      if (!key || !blob || blob.size < 200 || this.disabled) return false;
      const now = Date.now();
      const rec = { key, blob, bytes: blob.size, seconds: seconds || 0, savedAt: now, playedAt: 0 };
      const ok = await this._tx('readwrite', (s) => s.put(rec));
      if (ok === null && !this._db) return false;
      this._meta.set(key, { bytes: rec.bytes, seconds: rec.seconds, savedAt: now, playedAt: 0 });
      if (!this._trimTimer) {
        this._trimTimer = setTimeout(() => { this._trimTimer = null; this.trim(); this.updateUI(); }, 5000);
      }
      return true;
    },

    entries() {
      const out = [];
      for (const [key, m] of this._meta) out.push(Object.assign({ key }, m));
      return out;
    },

    stats() {
      let bytes = 0, seconds = 0;
      for (const m of this._meta.values()) { bytes += m.bytes || 0; seconds += m.seconds || 0; }
      return { clips: this._meta.size, bytes, seconds, target: this.target() };
    },

    budgetBytes() {
      return this.target() * this.bytesPerSecond(this.entries());
    },

    async trim(protect) {
      const plan = this.evictionPlan(this.entries(), this.budgetBytes(), Date.now(), protect);
      if (!plan.length) return 0;
      await this._tx('readwrite', (s) => { for (const k of plan) s.delete(k); return null; });
      for (const k of plan) this._meta.delete(k);
      return plan.length;
    },

    async clear() {
      await this._tx('readwrite', (s) => s.clear());
      this._meta.clear();
      this.updateUI();
    },

    // ---- settings row ---------------------------------------------------------------------------

    formatMinutes(sec) {
      const m = Math.round(sec / 60);
      if (m < 60) return m + ' min';
      const h = Math.floor(m / 60), r = m % 60;
      return h + ' h' + (r ? ' ' + r + ' min' : '');
    },

    statusText() {
      if (this.disabled) return 'This browser does not allow stored audio.';
      const s = this.stats();
      const mb = Math.round(s.bytes / 1048576);
      const mode = this.currentFillMode();
      const fill = mode === 'full'
        ? 'Filling to the goal while read aloud plays.'
        : (this.cellularAllowed() ? 'Not filling: no connection or Low Data Mode.'
          : 'Fills on Wi-Fi only. iPhone cannot tell Wi-Fi from mobile data, so turn on mobile data below to fill past the next few minutes.');
      return this.formatMinutes(s.seconds) + ' stored (' + mb + ' MB). Goal: '
        + this.formatMinutes(s.target) + ', about 2 days of your listening. ' + fill;
    },

    updateUI() {
      if (typeof document === 'undefined') return;
      const text = this.statusText();
      document.querySelectorAll('[data-tank-status]').forEach((el) => { if (el.textContent !== text) el.textContent = text; });
      document.querySelectorAll('[data-tank-cellular]').forEach((el) => { el.checked = this.cellularAllowed(); });
    },

    bindUI() {
      if (typeof document === 'undefined') return;
      document.querySelectorAll('[data-tank-cellular]').forEach((el) => {
        el.addEventListener('change', () => this.setCellularAllowed(!!el.checked));
      });
      document.querySelectorAll('[data-tank-clear]').forEach((el) => {
        el.addEventListener('click', async () => {
          await this.clear();
          if (root.App && typeof root.App.showToast === 'function') root.App.showToast('Stored audio cleared.');
        });
      });
      const c = typeof navigator !== 'undefined' && navigator.connection;
      if (c && c.addEventListener) c.addEventListener('change', () => this.updateUI());
      if (root.addEventListener) {
        root.addEventListener('pagehide', () => this.flushListen());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushListen(); });
      }
      this.updateUI();
    },
  };

  root.AudioTank = AudioTank;
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioTank;
  if (typeof document !== 'undefined') {
    const start = () => { AudioTank.bindUI(); AudioTank.init(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
