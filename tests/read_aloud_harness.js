// Runs the real public/js/tts.js in Node with a fake audio element, a fake server and a fake
// speechSynthesis shaped like iOS Safari's, and prints what read aloud did as JSON.
//
// Usage: node read_aloud_harness.js <scenario>
//   ellipsis-edge       a line that is only "…" between two real lines, cloud voice
//   ellipsis-device     the same chapter read by the phone's own voice (offline)
//   device-never-ends   iOS leaves speaking=true and never fires onend
//   fetch-hangs         the server never answers for one line
//   play-hangs          play() never settles and the element never moves
//   long-line-plays     audio that is really moving must never be cut off by the line timeout
//   device-ios          the phone's voice: late voice list, tap unlock, cancel-then-speak, not-allowed
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const ttsPath = path.join(__dirname, '..', 'public', 'js', 'tts.js');
const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetched = [];
function fakeFetch(url, opts) {
  const u = new URL(url, 'https://byob.test');
  if (u.pathname !== '/api/tts/speak') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  const text = u.searchParams.get('text');
  fetched.push(text);
  if (scenario === 'fetch-hangs' && text.indexOf('Stuck') === 0) {
    return new Promise((_res, rej) => {
      // Only our own abort can end it, and the line timeout must not wait for that
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
  }
  const bytes = new Uint8Array(400).fill(7);
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'edge' }, blob: async () => new Blob([bytes]) });
}

// <audio>: play() resolves at once unless the scenario hangs it
function fakeAudio() {
  let startedAt = 0;
  let base = 0;
  const a = {
    paused: true, ended: false, loop: false, duration: NaN, src: '',
    // Real audio moves while it plays; a hung play() never does
    get currentTime() {
      if (a.paused || !startedAt || (scenario === 'play-hangs' && String(a.src).indexOf('blob:') === 0)) return base;
      return base + (Date.now() - startedAt) / 1000;
    },
    set currentTime(v) { base = v; if (!a.paused) startedAt = Date.now(); },
    playbackRate: 1, defaultPlaybackRate: 1, playsInline: false,
    addEventListener: noop, removeEventListener: noop, load: noop,
    pause() { base = a.currentTime; a.paused = true; },
    play() {
      if (a.paused) startedAt = Date.now();
      a.paused = false;
      a.plays = (a.plays || 0) + 1;
      if (scenario === 'play-hangs' && String(a.src).indexOf('blob:') === 0) return new Promise(noop);
      return Promise.resolve();
    },
  };
  return a;
}

// speechSynthesis the way iOS behaves
const spoken = [];
const synthLog = [];
let voices = [];
const synthListeners = {};
let allowed = scenario !== 'device-ios';   // iOS: not allowed until speak() runs inside a tap
let inTap = false;
const synth = {
  speaking: false, pending: false, paused: scenario === 'device-ios',
  getVoices: () => voices,
  addEventListener: (k, fn) => { synthListeners[k] = fn; },
  resume() { synthLog.push('resume'); synth.paused = false; },
  cancel() { synthLog.push('cancel'); synth.lastCancel = Date.now(); synth.speaking = false; },
  speak(u) {
    const sameTickAsCancel = synth.lastCancel && Date.now() - synth.lastCancel < 5;
    synthLog.push(`speak:${JSON.stringify(u.text)}${sameTickAsCancel ? ':dropped' : ''}${synth.paused ? ':paused' : ''}`);
    if (inTap) allowed = true;
    if (!allowed) { setTimeout(() => u.onerror && u.onerror({ error: 'not-allowed' }), 5); return; }
    if (sameTickAsCancel || synth.paused) { synth.speaking = true; return; }  // silently swallowed, like iOS
    spoken.push({ text: u.text, voice: u.voice ? u.voice.name : null, lang: u.lang, volume: u.volume });
    if (u.volume === 0) return;
    synth.speaking = true;
    if (scenario === 'device-never-ends') return;     // speaking stays true, onend never comes
    setTimeout(() => { synth.speaking = false; if (u.onend) u.onend({}); }, 20);
  },
};
function Utterance(text) { this.text = text; this.volume = 1; }

const paragraphs = {
  'ellipsis-edge': ['Hello there.', '…', 'Next line.'],
  'ellipsis-device': ['Hello there.', '…', ' — ', 'Next line.'],
  'device-never-ends': ['First line here.', 'Second line here.'],
  'fetch-hangs': ['Stuck line here.', 'After the stuck line.'],
  'play-hangs': ['Stuck line here.', 'After the stuck line.'],
  'long-line-plays': ['A long line that really is playing.', 'The next line.'],
  'device-ios': ['Phone voice line one.', 'Phone voice line two.'],
}[scenario];
const els = paragraphs.map((t) => ({
  innerText: t, textContent: t,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  scrollIntoView: noop, getAttribute: () => null, dataset: {},
}));

const store = new Map();
const win = {
  ReaderSettings: {}, addEventListener: noop, innerWidth: 440, innerHeight: 956,
  location: { href: 'https://byob.test/' }, scrollY: 0,
  speechSynthesis: synth,
};
const sandbox = {
  window: win,
  document: {
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    addEventListener: noop, createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    body: { appendChild: noop }, hidden: false,
    documentElement: { scrollHeight: 1000 },
  },
  navigator: { onLine: scenario !== 'ellipsis-device', userAgent: 'node', mediaSession: null },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  Storage: { getUserId: () => 'usr_test', getLocalSettings: () => ({}), setLocalSettings: noop },
  fetch: fakeFetch,
  AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  console: { log: noop, warn: noop, error: noop }, URL, Blob, Date, Math, JSON, Promise, Set, Map, Uint8Array,
  performance: { now: () => Date.now() },
  Audio: fakeAudio,
  SpeechSynthesisUtterance: Utterance,
};
// tts.js tests `'speechSynthesis' in window`
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(ttsPath, 'utf8'), sandbox, { filename: 'tts.js' });

const T = win.TTSEngine;
for (const k of ['updateAudioUI', 'showBadge', 'openAudiobookModal', 'updateMediaSessionMetadata',
  'updateAudiobookModalContent', 'showAudiobookLoading', 'updateEngineUI', 'preloadNextChapter',
  'clearHighlight', 'highlightWordAtIndex', 'setupMediaSession']) T[k] = noop;
T.refreshParagraphs = () => { T.paragraphs = els; };
T.engineMode = 'edge';
const events = [];
T.logEvent = (m) => events.push(m);
T.stopWatchdog();
const out = { scenario };

async function tick(n, ms) {
  for (let i = 0; i < n; i++) { await sleep(ms); T.checkHealth(); }
}

(async () => {
  if (scenario === 'ellipsis-edge') {
    T.start(0);
    await sleep(50);
    out.afterFirst = T.currentIndex;
    // the audio element's 'ended' for line 0 hands over to line 1, which is only "…"
    T.speakParagraph(1);
    await sleep(50);
    // it holds a short silence on the "…" line, then the silence ending moves on
    out.onBeat = T.currentIndex;
    out.beatIsSilence = Object.values(T._silenceUris || {}).indexOf(T.audioElement.src) !== -1;
    T.speakParagraph(T.indexAfterAudio());  // what the "ended" event does
    await sleep(50);
    out.afterEllipsis = T.currentIndex;
    out.fetched = fetched;
    out.usedDeviceVoice = T.isUsingDeviceVoice;
    out.spoken = spoken.filter((s) => s.volume !== 0).map((s) => s.text);
  } else if (scenario === 'ellipsis-device') {
    T.start(0);
    await sleep(400);
    out.index = T.currentIndex;
    out.spoken = spoken.filter((s) => s.volume !== 0).map((s) => s.text);
    out.fetched = fetched;
    out.isPlaying = T.isPlaying;
  } else if (scenario === 'device-never-ends') {
    sandbox.navigator.onLine = false;
    T.DEVICE_LINE_SLACK_MS = 400;
    T.BUFFER_CHARS_PER_SECOND = 1000;     // budget = 400 ms + a sliver for the words
    T.start(0);
    await sleep(250);
    out.beforeTimeout = T.currentIndex;
    await tick(40, 100);       // one second of words plus the slack, about 3 s
    out.afterTimeout = T.currentIndex;
    out.spoken = spoken.filter((s) => s.volume !== 0).map((s) => s.text);
    out.events = events.filter((e) => /timed out/.test(e));
  } else if (scenario === 'fetch-hangs' || scenario === 'play-hangs') {
    T.LINE_STALL_MS = 500;
    T.start(0);
    await sleep(100);
    T.checkHealth();
    out.beforeTimeout = T.currentIndex;
    await tick(10, 100);
    out.afterTimeout = T.currentIndex;
    out.fetched = fetched;
    out.events = events.filter((e) => /timed out/.test(e));
  } else if (scenario === 'long-line-plays') {
    T.LINE_STALL_MS = 300;
    T.start(0);
    await sleep(100);
    await tick(15, 100);
    out.index = T.currentIndex;
    out.events = events.filter((e) => /timed out/.test(e));
  } else if (scenario === 'device-ios') {
    // 1. Voices arrive late, through voiceschanged
    T.init(noop);
    out.voicesAtStart = T._deviceVoices.length;
    voices = [
      { name: 'Thomas', lang: 'fr-FR', localService: true },
      { name: 'Samantha', lang: 'en-US', localService: true },
      { name: 'Fred', lang: 'en-US', localService: true },
    ];
    if (synthListeners.voiceschanged) synthListeners.voiceschanged();
    out.voicesAfterEvent = T._deviceVoices.length;
    // 2. He taps play: the tap must unlock speech even though cloud audio is what plays
    inTap = true;
    T.start(0);
    inTap = false;
    out.primed = T._speechPrimed;
    out.primerSpoken = spoken.some((s) => s.volume === 0);
    T.stop();
    // 3. Later, with no tap, the cloud voice fails and the phone's voice takes over
    sandbox.navigator.onLine = false;
    T.isPlaying = true; T.isPaused = false;
    synth.paused = true;          // iOS left it paused after an interruption
    T.speakParagraph(0);
    await sleep(400);
    out.spoken = spoken.filter((s) => s.volume !== 0).map((s) => ({ text: s.text, voice: s.voice, lang: s.lang }));
    out.droppedSpeaks = synthLog.filter((l) => /:dropped|:paused/.test(l) && !/" "/.test(l));
    out.resumed = synthLog.includes('resume');
    // 4. A phone that was never tapped refuses: it must pause and ask, not race through the chapter
    T.stop();
    allowed = false;
    T._speechPrimed = false;
    T.isPlaying = true; T.isPaused = false;
    T.speakParagraph(0);
    await sleep(300);
    out.notAllowedPaused = T.isPaused;
    out.notAllowedIndex = T.currentIndex;
  }
  T.stopWatchdog();
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
