// Runs the real public/sw.js in Node with a fake Cache Storage and a slow network, and prints what
// a launch gets as JSON.
//
// The fault it pins down (found 2026-11-25): the worker gave the network 1500 ms for the page and
// then CANCELLED it, serving the cached page instead. A phone whose launch was ever slower than
// that kept the old page for good, and the old page is what asks for the old /js/ files, which is
// why Rocco's phone kept saying his PC voice was unreachable while the PC was fine.
//
// Usage: node stale_shell_harness.js <scenario>
//   slow-and-changed  the network answers after the timeout with a different page
//   slow-and-same     the network answers after the timeout with the same page
//   fast              the network answers inside the timeout
//   offline           no network at all
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const OLD_HTML = '<html data-build="55.0">old</html>';
const NEW_HTML = '<html data-build="55.4">new</html>';

function makeResponse(body, status) {
  return {
    status: status || 200,
    _body: body,
    clone() { return makeResponse(this._body, this.status); },
    async text() { return this._body; },
  };
}

// Just enough Cache Storage: one named cache per key, entries by URL string.
const caches_ = new Map();
function cacheFor(name) {
  if (!caches_.has(name)) caches_.set(name, new Map());
  const store = caches_.get(name);
  return {
    async put(req, res) { store.set(typeof req === 'string' ? req : req.url, res); },
    async addAll(urls) { for (const u of urls) store.set(u, makeResponse('precached ' + u)); },
    async match(req) { return store.get(typeof req === 'string' ? req : req.url) || undefined; },
    async keys() { return [...store.keys()]; },
    async delete(req) { return store.delete(typeof req === 'string' ? req : req.url); },
  };
}
const cachesApi = {
  async open(name) { return cacheFor(name); },
  async keys() { return [...caches_.keys()]; },
  async delete(name) { return caches_.delete(name); },
  async match(req) {
    for (const name of caches_.keys()) {
      const hit = await cacheFor(name).match(req);
      if (hit) return hit;
    }
    return undefined;
  },
};

let networkCalls = 0;
const fetch_ = (request) => {
  networkCalls += 1;
  const url = typeof request === 'string' ? request : request.url;
  if (!url.endsWith('/') && !url.endsWith('/index.html')) {
    return Promise.resolve(makeResponse('asset ' + url));
  }
  if (scenario === 'offline') return Promise.reject(new Error('offline'));
  if (scenario === 'fast') return Promise.resolve(makeResponse(NEW_HTML));
  const body = scenario === 'slow-and-same' ? OLD_HTML : NEW_HTML;
  return new Promise((resolve) => setTimeout(() => resolve(makeResponse(body)), 2600));
};

const listeners = {};
const messages = [];
const sandbox = {
  self: null,
  caches: cachesApi,
  fetch: fetch_,
  navigator: { onLine: scenario !== 'offline' },
  setTimeout, clearTimeout, Promise, console, URL, Date, Math, JSON, Set, Map,
  AbortController,
};
sandbox.self = {
  addEventListener: (name, fn) => { listeners[name] = fn; },
  skipWaiting: () => {},
  clients: {
    claim: async () => {},
    matchAll: async () => ([{ postMessage: (m) => messages.push(m) }]),
  },
  registration: { scope: 'https://byob.test/' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
vm.runInContext(swSource, sandbox, { filename: 'sw.js' });
const CACHE_NAME = 'byob-v' + swSource.match(/ASSET_VERSION\s*=\s*'([0-9.]+)'/)[1];

(async () => {
  // A phone that already has last week's page, in last week's cache and in this build's cache:
  // the worker has taken over but the page it serves is still the old one.
  await cacheFor('byob-v55.0').put('/index.html', makeResponse(OLD_HTML));
  await cacheFor(CACHE_NAME).put('/index.html', makeResponse(OLD_HTML));

  const request = { url: 'https://byob.test/', mode: 'navigate', method: 'GET',
                    destination: 'document' };
  let served = null;
  const waits = [];
  listeners.fetch({
    request,
    respondWith: (p) => { served = p; },
    waitUntil: (p) => waits.push(p),
  });
  const response = await served;
  const firstLaunch = await response.text();

  await Promise.all(waits.map((p) => p.catch(() => {})));
  await new Promise((r) => setTimeout(r, 3200));   // let the slow answer land
  await Promise.all(waits.map((p) => p.catch(() => {})));

  const cachedNow = await cacheFor(CACHE_NAME).match('/index.html');
  console.log(JSON.stringify({
    scenario,
    servedOnLaunch: firstLaunch,
    toldThePage: messages.map((m) => m.type),
    cachedAfterwards: cachedNow ? await cachedNow.text() : null,
    networkCalls,
  }));
  process.exit(0);
})();
