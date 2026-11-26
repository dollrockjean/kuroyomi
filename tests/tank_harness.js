// Runs the real public/js/tank.js and public/js/tts.js in Node with an in-memory IndexedDB and a fake
// server, and prints what the phone tank did as JSON.
//
// Usage: node tank_harness.js <scenario>
//   sizing        target size from the listening log, eviction order, Wi-Fi rule
//   storage       put / get / init reload / trim / clear against the fake IndexedDB
//   tts-hit       a clip already on the phone plays without any network request
//   tts-save      fetched audio is saved under the engine that really made it
//   tts-offline   the PC dropped (keys turned to Edge) but the PC's stored copy still plays
//   tts-fill      on Wi-Fi the tank fills past the look-ahead to the goal without using memory
//   tts-nofill    on an iPhone (no connection type) it does not fill unless mobile data is allowed
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..', 'public', 'js');

// ---- a small IndexedDB: one database, object stores keyed by keyPath -------------------------------
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function makeTx(data) {
    let pending = 0;
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const done = () => { if (--pending === 0) later(() => tx.oncomplete && tx.oncomplete()); };
    const op = (fn) => {
      const req = { result: undefined, onsuccess: null, onerror: null };
      pending++;
      later(() => { req.result = fn(); if (req.onsuccess) req.onsuccess(); done(); });
      return req;
    };
    const store = {
      get: (k) => op(() => (data.has(k) ? Object.assign({}, data.get(k)) : undefined)),
      put: (v) => op(() => { data.set(v.key, Object.assign({}, v)); return v.key; }),
      delete: (k) => op(() => { data.delete(k); }),
      clear: () => op(() => { data.clear(); }),
      openCursor: () => {
        const req = { result: null, onsuccess: null };
        const vals = Array.from(data.values());
        let i = 0;
        pending++;
        const step = () => later(() => {
          if (i < vals.length) {
            const v = vals[i++];
            req.result = { value: Object.assign({}, v), continue: step };
            if (req.onsuccess) req.onsuccess();
          } else {
            req.result = null;
            if (req.onsuccess) req.onsuccess();
            done();
          }
        });
        step();
        return req;
      },
    };
    tx.objectStore = () => store;
    // A transaction with no requests still completes
    later(() => { if (pending === 0) { pending = 1; done(); } });
    return tx;
  }
  return {
    _dbs: dbs,
    open(name) {
      const req = { result: null };
      later(() => {
        let entry = dbs.get(name);
        const fresh = !entry;
        if (!entry) { entry = { stores: new Map() }; dbs.set(name, entry); }
        const db = {
          objectStoreNames: { contains: (n) => entry.stores.has(n) },
          createObjectStore: (n) => { entry.stores.set(n, new Map()); },
          transaction: (n) => makeTx(entry.stores.get(n)),
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

// ---- a sandbox with window, storage, a fake server ------------------------------------------------
const fetched = [];
let relayEngine = 'kokoro';
function fakeFetch(url) {
  const u = new URL(url, 'https://byob.test');
  if (u.pathname !== '/api/tts/speak') return Promise.resolve({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } });
  fetched.push((u.searchParams.get('engine') || 'edge') + ':' + u.searchParams.get('text'));
  const isRelay = u.searchParams.get('engine') === 'kokoro';
  const eng = isRelay ? relayEngine : 'edge';
  const bytes = new Uint8Array(4000).fill(eng === 'kokoro' ? 3 : 7);
  return Promise.resolve({ ok: true, status: 200, headers: { get: (h) => (h === 'X-BYoB-Engine' ? eng : null) }, blob: async () => new Blob([bytes]) });
}

function makeSandbox(connection) {
  const store = new Map();
  const win = { ReaderSettings: {}, addEventListener: noop, location: { href: 'https://byob.test/' }, speechSynthesis: null };
  const sandbox = {
    window: win,
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener: noop,
      createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }), body: { appendChild: noop }, hidden: false,
      readyState: 'complete', documentElement: { scrollHeight: 1000 } },
    navigator: { onLine: true, userAgent: 'node', mediaSession: null, connection },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    Storage: { getUserId: () => 'usr_test', getLocalSettings: () => ({}), setLocalSettings: noop },
    indexedDB: fakeIndexedDB(),
    fetch: fakeFetch,
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log: noop, warn: noop, error: noop }, URL, Blob, Date, Math, JSON, Promise, Set, Map, Uint8Array, Object, Array,
    performance: { now: () => Date.now() },
    Audio: function () { return { paused: true, currentTime: 0, addEventListener: noop, removeEventListener: noop, load: noop, pause: noop, play: () => Promise.resolve() }; },
  };
  sandbox.globalThis = sandbox;
  win.indexedDB = sandbox.indexedDB;
  vm.createContext(sandbox);
  return { sandbox, win, store };
}

function loadTank(env) {
  // tank.js hangs itself on window (the sandbox's `window`)
  vm.runInContext(fs.readFileSync(path.join(root, 'tank.js'), 'utf8'), env.sandbox, { filename: 'tank.js' });
  return env.win.AudioTank;
}

function loadTTS(env, paragraphs) {
  vm.runInContext(fs.readFileSync(path.join(root, 'tts.js'), 'utf8'), env.sandbox, { filename: 'tts.js' });
  const T = env.win.TTSEngine;
  for (const k of ['updateAudioUI', 'showBadge', 'updateEngineUI', 'preloadNextChapter', 'kokoroPrefetch', 'probeEngines']) T[k] = noop;
  T.logEvent = noop;
  T.stopWatchdog && T.stopWatchdog();
  T.paragraphs = (paragraphs || []).map((t) => ({ innerText: t, textContent: t }));
  return T;
}

const out = { scenario };
const DAY = 86400000;

(async () => {
  if (scenario === 'sizing') {
    const env = makeSandbox(null);
    const A = loadTank(env);
    const now = new Date(2026, 10, 26, 12).getTime();
    const log = {};
    // 14 days at 1 hour a day -> 2 hours
    for (let i = 0; i < 14; i++) log[A.dayKey(now - i * DAY)] = 3600;
    out.heavy = A.targetSeconds(log, now);
    out.empty = A.targetSeconds({}, now);
    out.light = A.targetSeconds({ [A.dayKey(now)]: 600 }, now);
    out.huge = A.targetSeconds(Object.fromEntries(Object.keys(log).map((d) => [d, 86400])), now);
    // a month-old binge does not count any more
    out.oldOnly = A.targetSeconds({ [A.dayKey(now - 20 * DAY)]: 100000 }, now);
    out.pruned = Object.keys(A.pruneLog({ [A.dayKey(now - 20 * DAY)]: 5, [A.dayKey(now)]: 5 }, now)).length;
    const e = [
      { key: 'played-old', bytes: 100, seconds: 10, savedAt: now - 5 * DAY, playedAt: now - 4 * DAY },
      { key: 'played-new', bytes: 100, seconds: 10, savedAt: now - 3 * DAY, playedAt: now - DAY },
      { key: 'ahead', bytes: 100, seconds: 10, savedAt: now - 2 * DAY, playedAt: 0 },
      { key: 'stale', bytes: 100, seconds: 10, savedAt: now - 30 * DAY, playedAt: 0 },
      { key: 'protected', bytes: 100, seconds: 10, savedAt: now - 40 * DAY, playedAt: 0 },
    ];
    out.evictFits = A.evictionPlan(e, 10000, now, new Set(['protected']));
    out.evictTight = A.evictionPlan(e, 250, now, new Set(['protected']));
    out.wifi = A.fillMode({ type: 'wifi' }, false);
    out.cell = A.fillMode({ type: 'cellular' }, false);
    out.cellAllowed = A.fillMode({ type: 'cellular' }, true);
    out.iphone = A.fillMode(null, false);
    out.iphoneAllowed = A.fillMode(null, true);
    out.saveData = A.fillMode({ type: 'wifi', saveData: true }, true);
    A.recordListen(10, now); A.recordListen(55, now + 1000);  // passes 60 s, so it is written
    out.logged = JSON.parse(env.store.get(A.LISTEN_KEY) || '{}')[A.dayKey(now + 1000)];
    out.ignoredJump = (A.recordListen(500, now + 2000), A._pendingListen);
  } else if (scenario === 'storage') {
    const env = makeSandbox(null);
    const A = loadTank(env);
    await A.init();
    const blob = new Blob([new Uint8Array(5000).fill(1)]);
    out.put = await A.put('k1', blob, 3);
    out.tiny = await A.put('k2', new Blob([new Uint8Array(10)]), 1);
    const got = await A.get('k1');
    out.gotSize = got ? got.size : 0;
    out.stats = A.stats();
    // A new page load reads the list back from disk
    A._meta = new Map(); A._ready = null;
    await A.init();
    out.reloaded = A.has('k1');
    A.markPlayed('k1');
    await sleep(20);
    // Force over budget: target 30 min at a tiny measured rate -> budget below one clip
    A.target = () => 1;
    A.bytesPerSecond = () => 1;
    out.trimmed = await A.trim();
    out.afterTrim = A.has('k1');
    await A.put('k3', blob, 3);
    await A.clear();
    out.afterClear = A.stats().clips;
  } else if (scenario.indexOf('tts-') === 0) {
    const conn = scenario === 'tts-nofill' ? undefined : { type: 'wifi' };
    const env = makeSandbox(conn);
    const A = loadTank(env);
    await A.init();
    const paras = [];
    for (let i = 0; i < 30; i++) paras.push('Line number ' + i + ' of the chapter.');
    const T = loadTTS(env, paras);
    T.kokoroUsable = () => scenario !== 'tts-offline-down';
    T.kokoroVoiceFor = () => 'am_michael';

    if (scenario === 'tts-hit') {
      T.engineMode = 'edge';
      const key = T.cacheKeyFor('Stored line.', T.selectedVoice, 0, 'edge');
      await A.put(key, new Blob([new Uint8Array(3000).fill(9)]), 2);
      const url = await T.getAudioBlobUrl('Stored line.', T.selectedVoice, 1.0, 0);
      out.url = !!url;
      out.fetched = fetched.slice();
    } else if (scenario === 'tts-save') {
      T.engineMode = 'kokoro';
      relayEngine = 'kokoro';
      await T.getAudioBlobUrl('Made by the PC.', T.selectedVoice, 1.0, 0);
      relayEngine = 'edge';   // the server fell back to Edge for this one
      await T.getAudioBlobUrl('Made by Edge really.', T.selectedVoice, 1.0, 0);
      await sleep(20);
      out.kokoroKeySaved = A.has(T.cacheKeyFor('Made by the PC.', T.selectedVoice, 0, 'kokoro'));
      out.fallbackUnderKokoro = A.has(T.cacheKeyFor('Made by Edge really.', T.selectedVoice, 0, 'kokoro'));
      out.fallbackUnderEdge = A.has(T.cacheKeyFor('Made by Edge really.', T.selectedVoice, 0, 'edge'));
    } else if (scenario === 'tts-offline') {
      T.engineMode = 'auto';
      const kkey = T.cacheKeyFor('Saved by the PC.', T.selectedVoice, 0, 'kokoro');
      await A.put(kkey, new Blob([new Uint8Array(3000).fill(3)]), 2);
      T.kokoroUsable = () => false;     // the dead zone knocked the PC out: next keys are Edge keys
      const url = await T.getAudioBlobUrl('Saved by the PC.', T.selectedVoice, 1.0, 0);
      out.url = !!url;
      out.fetched = fetched.slice();
      out.engineActive = T.engineActive;
    } else if (scenario === 'tts-low') {
      const toasts = [];
      env.win.App = { showToast: (m) => toasts.push(m) };
      T.engineMode = 'edge';
      T.isPlaying = true; T.isPaused = false; T.currentIndex = 0;
      // Lines 1-3 are stored (a few seconds), the rest are not, and the phone has no signal
      for (let i = 1; i <= 3; i++) await A.put(T.cacheKeyFor(paras[i]), new Blob([new Uint8Array(3000)]), 2);
      env.sandbox.navigator.onLine = true;
      T.checkAudioLow(true);
      out.onlineToasts = toasts.length;
      env.sandbox.navigator.onLine = false;
      T.checkAudioLow(true);
      T.checkAudioLow(true);
      out.lowToasts = toasts.slice();
      T.warnRanOut(false);
      T.warnRanOut(false);
      out.allToasts = toasts.slice();
      T.noteNetworkBack();
      out.resetLow = T._lowWarned;
    } else if (scenario === 'tts-fill' || scenario === 'tts-nofill') {
      T.engineMode = 'edge';
      T.isPlaying = true; T.isPaused = false;
      A.target = () => 30 * 60;
      // Each line is about 2.3 s of speech, so 30 lines are not enough for the goal: the fill takes all of them
      await T.fillTank(0);
      out.stored = A.stats().clips;
      out.blobCache = T.blobCache.size;
      out.fetched = fetched.length;
      if (scenario === 'tts-nofill') {
        A.setCellularAllowed(true);
        await T.fillTank(0);
        out.storedAllowed = A.stats().clips;
      }
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
