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
const answers = [];
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
      ? { getAttribute: () => '/js/tts.js?v=55.6' } : null),
    getElementById: () => null,
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
T.engineMode = 'kokoro';
T.updateEngineUI = () => {};          // no DOM to paint in here
T.logEvent = () => {};

(async () => {
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
