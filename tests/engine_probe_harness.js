// Runs the real public/js/tts.js in Node with just enough of a browser around it to watch what the
// voice-engine probe does when the BYoB server is slow to wake, and prints the answer as JSON.
//
// Usage: node engine_probe_harness.js <scenario>
//   cold-then-up   the server ignores the first question, then says the PC is there
//   never-answers  the server never answers at all
//   says-pc-is-off the server answers at once and says the PC is not there
//   no-account-yet the app has no account id yet (sync is still connecting), then it gets one
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const ttsPath = path.join(__dirname, '..', 'public', 'js', 'tts.js');
const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const assetVersion = (swSource.match(/ASSET_VERSION\s*=\s*'([0-9.]+)'/) || ['', '55.7'])[1];

const noop = () => {};
const fakeElement = () => new Proxy({
  style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  setAttribute: noop, getAttribute: () => null, addEventListener: noop, appendChild: noop,
  querySelectorAll: () => [], querySelector: () => null, textContent: '', innerHTML: '',
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
}, { get: (t, k) => (k in t ? t[k] : noop) });

const store = new Map([['byob_tts_engine', 'kokoro']]);
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let calls = 0;
const fetchLog = [];
const answers = [];
function fakeAudioResponse(engineUsed, fallbackReason, status) {
  const bytes = new Uint8Array(400);
  const hdrs = new Map([['X-BYoB-Engine', engineUsed || 'edge']]);
  if (fallbackReason) hdrs.set('X-BYoB-Fallback', fallbackReason);
  return {
    ok: !status || (status >= 200 && status < 300),
    status: status || 200,
    headers: { get: (k) => hdrs.get(k) || null },
    blob: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
  };
}

function fakeFetch(url, opts) {
  calls += 1;
  fetchLog.push({ url: String(url), cache: opts && opts.cache });
  const n = calls;
  const signal = opts && opts.signal;
  if (scenario === 'probe-502') {
    return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
  }
  if (scenario === 'cache-switch') {
    if (String(url).indexOf('/api/tts/engines') >= 0) {
      return Promise.resolve(jsonResponse({
        engines: {
          edge: { available: true },
          kokoro: { available: true, device: 'cuda', device_name: 'BYoB Kokoro (PC)',
                    realtime_factor: 10.0, url: null, token: null, direct: false },
        },
      }));
    }
    const isKokoro = String(url).indexOf('engine=kokoro') >= 0;
    return Promise.resolve(fakeAudioResponse(isKokoro ? 'kokoro' : 'edge', '', 200));
  }
  if (scenario === 'relay-fallback' || scenario === 'relay-502') {
    if (String(url).indexOf('/api/tts/engines') >= 0) {
      return Promise.resolve(jsonResponse({
        engines: {
          edge: { available: true },
          kokoro: { available: true, device: 'cuda', device_name: 'BYoB Kokoro (PC)',
                    realtime_factor: 10.0, url: null, token: null, direct: false },
        },
      }));
    }
    if (String(url).indexOf('engine=kokoro') >= 0) {
      return scenario === 'relay-502'
        ? Promise.resolve(fakeAudioResponse('edge', '', 502))
        : Promise.resolve(fakeAudioResponse('edge', 'PC did not answer', 200));
    }
    return Promise.resolve(fakeAudioResponse('edge', '', 200));
  }
  if (scenario === 'no-account-yet') {
    return Promise.resolve(jsonResponse({
      engines: {
        edge: { available: true },
        kokoro: { available: true, device: 'cuda', device_name: 'BYoB Kokoro (PC)',
                  realtime_factor: 3.3, url: null, token: null, direct: false },
      },
    }));
  }
  if (scenario === 'says-pc-is-off') {
    return Promise.resolve(jsonResponse({ engines: { edge: { available: true },
                                                     kokoro: { available: false } } }));
  }
  // A sleeping free host: the first question goes unanswered until the app gives up.
  const wakesOnCall = scenario === 'cold-then-up' ? 2 : Infinity;
  if (n < wakesOnCall) {
    return new Promise((_resolve, reject) => {
      // A browser rejects an aborted fetch with a DOMException named AbortError, not a plain Error.
      if (signal) signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }
  return Promise.resolve(jsonResponse({
    engines: {
      edge: { available: true },
      kokoro: { available: true, device: 'cuda', device_name: 'BYoB Kokoro (PC)',
                realtime_factor: 3.3, url: null, token: null, direct: false },
    },
  }));
}

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

// The account id the app knows about. Empty while sync is still connecting, which is normal on a
// cold start against a sleeping server: the probe must keep asking rather than go quiet for good.
let account = scenario === 'no-account-yet' ? '' : 'usr_test';

const win = {
  SyncService: { get currentUserId() { return account; } },
  ReaderSettings: {},
  addEventListener: noop,
  innerWidth: 440, innerHeight: 956,
};
const sandbox = {
  window: win,
  document: {
    querySelectorAll: () => [],
    // The page knows which build it is only from the address its own script was asked for, and the
    // on-screen voice report prints that, so the harness has to carry a real-looking script tag.
    querySelector: (sel) => (String(sel).indexOf('js/tts.js') >= 0
      ? { getAttribute: () => '/js/tts.js?v=' + assetVersion } : null),
    getElementById: () => null,
    addEventListener: noop, createElement: fakeElement, body: fakeElement(), hidden: false,
  },
  navigator: { onLine: true, userAgent: 'node', mediaSession: { playbackState: 'none', metadata: null, setActionHandler: noop } },
  localStorage,
  Storage: { getUserId: () => account, getDeviceToken: () => 'dev_test',
             getLocalSettings: () => ({}), setLocalSettings: noop },
  fetch: fakeFetch,
  Blob: function (parts, opts) { this.parts = parts; this.type = opts && opts.type; this.size = 400; },
  AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  console, URL: Object.assign(URL, { createObjectURL: () => 'blob:test-' + Math.random().toString(36).slice(2, 8), revokeObjectURL: noop }),
  Date, Math, JSON, Promise, Set, Map,
  performance: { now: () => Date.now() },
  Audio: function () { return fakeElement(); },
  speechSynthesis: null,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(ttsPath, 'utf8'), sandbox, { filename: 'tts.js' });

const T = win.TTSEngine;
T.engineMode = 'kokoro';
T.updateEngineUI = () => {};          // no DOM to paint in here
T.logEvent = () => {};

(async () => {
  if (scenario === 'probe-502') {
    await T.probeEngines(true);
    if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
    console.log(JSON.stringify({
      report: T.engineReportText(),
      status: T.engineStatusText(),
      cacheMode: fetchLog[0] && fetchLog[0].cache,
    }));
    process.exit(0);
  }
  if (scenario === 'cache-switch') {
    const mkPara = (txt) => Object.assign(fakeElement(), { innerText: txt });
    T.paragraphs = [mkPara('First paragraph of the chapter.'), mkPara('Second paragraph of the chapter.')];
    T.isPlaying = true;
    T.isPaused = false;
    T.prefetchAhead = noop;
    T.audioElement.play = () => Promise.resolve();
    // Simulate Edge prefetching both paragraphs while the server was waking up.
    T.kokoro = null;
    const edgeKey0 = T.cacheKeyFor('First paragraph of the chapter.', T.selectedVoice, T.pitch, 'edge');
    const edgeKey1 = T.cacheKeyFor('Second paragraph of the chapter.', T.selectedVoice, T.pitch, 'edge');
    T.blobCache.set(edgeKey0, 'blob:edge-0');
    T.blobCache.set(edgeKey1, 'blob:edge-1');
    // Now Kokoro comes online.
    await T.probeEngines(true);
    await T.speakParagraph(0);
    const afterPara0 = {
      src: T.audioElement.src,
      engineActive: T.engineActive,
      report: T.engineReportText(),
      kokoroCalls: fetchLog.filter((f) => f.url.indexOf('engine=kokoro') >= 0).length,
    };
    // Pre-cache Kokoro audio for paragraph 1, then speakParagraph(1) must hit cache with zero fetches.
    const kKey1 = T.cacheKeyFor('Second paragraph of the chapter.', T.selectedVoice, T.pitch, 'kokoro');
    T.blobCache.set(kKey1, 'blob:kokoro-1');
    const callsBefore = fetchLog.length;
    await T.speakParagraph(1);
    const afterPara1 = {
      src: T.audioElement.src,
      engineActive: T.engineActive,
      newFetches: fetchLog.length - callsBefore,
    };
    if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
    console.log(JSON.stringify({ afterPara0, afterPara1 }));
    process.exit(0);
  }
  if (scenario === 'relay-fallback' || scenario === 'relay-502') {
    await T.probeEngines(true);
    const txt = 'A test paragraph relayed through the server.';
    await T.getAudioBlobUrl(txt, T.selectedVoice, 1.0, T.pitch);
    const kKey = T.cacheKeyFor(txt, T.selectedVoice, T.pitch, 'kokoro');
    const eKey = T.cacheKeyFor(txt, T.selectedVoice, T.pitch, 'edge');
    if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
    console.log(JSON.stringify({
      engineActive: T.engineActive,
      report: T.engineReportText(),
      lastFallbackReason: T.lastFallbackReason,
      kokoroCached: T.blobCache.has(kKey),
      edgeCached: T.blobCache.has(eKey),
    }));
    process.exit(0);
  }

  T.probeEngines(true);
  await new Promise((r) => setTimeout(r, 300));
  answers.push({ at: 'while the server is still waking', status: T.engineStatusText(),
                 usable: T.kokoroUsable(), probes: calls, report: T.engineReportText() });
  // Sync finishes connecting a moment later, with nobody touching the app.
  if (scenario === 'no-account-yet') setTimeout(() => { account = 'usr_test'; }, 1000);
  // Long enough for the give-up and the first two retries, never touching the app.
  await new Promise((r) => setTimeout(r, 26000));
  answers.push({ at: 'after waiting, with no app restart', status: T.engineStatusText(),
                 usable: T.kokoroUsable(), probes: calls, report: T.engineReportText() });
  if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
  console.log(JSON.stringify(answers));
  process.exit(0);
})();
