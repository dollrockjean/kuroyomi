// Runs the real public/js/tts.js in Node with just enough of a browser around it to watch what the
// voice-engine probe does when the BYoB server is slow to wake, and prints the answer as JSON.
//
// Usage: node engine_probe_harness.js <scenario>
//   cold-then-up   the server ignores the first question, then says the PC is there
//   never-answers  the server never answers at all
//   says-pc-is-off the server answers at once and says the PC is not there
//   no-account-yet the app has no account id yet (sync is still connecting), then it gets one
//   fresh-phone    nothing saved anywhere: no stored engine choice on the device and none on the
//                  account either, which is what Rocco's real iPhone looked like. Every other
//                  scenario here seeds 'kokoro' into the fake storage first, so this was the one
//                  path never tested - and the one his phone took (2026-11-25).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const ttsPath = path.join(__dirname, '..', 'public', 'js', 'tts.js');

const noop = () => {};
const fakeElement = () => new Proxy({
  style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  setAttribute: noop, getAttribute: () => null, addEventListener: noop, appendChild: noop,
  querySelectorAll: () => [], querySelector: () => null, textContent: '', innerHTML: '',
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
}, { get: (t, k) => (k in t ? t[k] : noop) });

const store = scenario === 'fresh-phone'
  ? new Map()
  : new Map([['byob_tts_engine', 'kokoro']]);
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let calls = 0;
const answers = [];
const probeUrls = [];
const syncedSettings = [];   // what the app pushed up to the account
function fakeFetch(url, opts) {
  calls += 1;
  const n = calls;
  const signal = opts && opts.signal;
  if (scenario === 'no-account-yet') {
    return Promise.resolve(jsonResponse({
      engines: {
        edge: { available: true },
        kokoro: { available: true, device: 'cuda', device_name: 'BYoB Kokoro (PC)',
                  realtime_factor: 3.3, url: null, token: null, direct: false },
      },
    }));
  }
  if (scenario === 'fresh-phone') {
    probeUrls.push(String(url));
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
      if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
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
  SyncService: {
    get currentUserId() { return account; },
    syncSettings: (s) => syncedSettings.push(JSON.parse(JSON.stringify(s || {}))),
  },
  // A phone whose storage was wiped has no settings object built yet either, which is the state the
  // engine choice used to be silently dropped in.
  ReaderSettings: scenario === 'fresh-phone' ? undefined : {},
  addEventListener: noop,
  innerWidth: 440, innerHeight: 956,
};
const sandbox = {
  window: win,
  document: {
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    addEventListener: noop, createElement: fakeElement, body: fakeElement(), hidden: false,
  },
  navigator: { onLine: true, userAgent: 'node', mediaSession: null },
  localStorage,
  Storage: { getUserId: () => account, getDeviceToken: () => 'dev_test',
             getLocalSettings: () => ({}), setLocalSettings: noop },
  fetch: fakeFetch,
  AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  console, URL, Date, Math, JSON, Promise, Set, Map,
  performance: { now: () => Date.now() },
  Audio: function () { return fakeElement(); },
  speechSynthesis: null,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(ttsPath, 'utf8'), sandbox, { filename: 'tts.js' });

const T = win.TTSEngine;
// Every other scenario pins the mode so it can test the probe. 'fresh-phone' must not: the whole
// point is what the app decides for itself when nothing has ever been saved.
if (scenario !== 'fresh-phone') T.engineMode = 'kokoro';
T.updateEngineUI = () => {};          // no DOM to paint in here
T.logEvent = () => {};

if (scenario === 'fresh-phone') {
  (async () => {
    T.loadEngineSettings();
    const chosen = T.engineMode;
    const source = T.engineModeSource;
    T.probeEngines(true);
    await new Promise((r) => setTimeout(r, 400));
    if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
    console.log(JSON.stringify([{
      at: 'a phone with nothing saved, one launch',
      mode: chosen,
      modeSource: source,
      storedOnDevice: store.get('byob_tts_engine') || '',
      pushedToAccount: syncedSettings.map((s) => s.tts_engine).filter(Boolean),
      status: T.engineStatusText(),
      why: T.engineWhyText(),
      usable: T.kokoroUsable(),
      engineForNextFetch: T.engineForNextFetch(),
      probeUrl: probeUrls[0] || '',
      probes: calls,
    }]));
    process.exit(0);
  })();
  return;
}

(async () => {
  T.probeEngines(true);
  await new Promise((r) => setTimeout(r, 300));
  answers.push({ at: 'while the server is still waking', status: T.engineStatusText(),
                 usable: T.kokoroUsable(), probes: calls });
  // Sync finishes connecting a moment later, with nobody touching the app.
  if (scenario === 'no-account-yet') setTimeout(() => { account = 'usr_test'; }, 1000);
  // Long enough for the give-up and the first two retries, never touching the app.
  await new Promise((r) => setTimeout(r, 26000));
  answers.push({ at: 'after waiting, with no app restart', status: T.engineStatusText(),
                 usable: T.kokoroUsable(), probes: calls });
  if (T._engineRetryTimer) clearTimeout(T._engineRetryTimer);
  console.log(JSON.stringify(answers));
  process.exit(0);
})();
