// Runs the real public/js/tts.js in Node with a fake audio element, navigator.mediaSession,
// fetch, and speechSynthesis to test Bluetooth headphone pause/play across Edge, Kokoro, and
// device-voice paths.
//
// Usage: node headphone_pause_harness.js <scenario>
//   edge-bg-native-pause     Edge playing, page hidden, native audio 'pause' fires, then mediaSession 'play'
//   kokoro-loading-pause     Kokoro fetching (silent hold loop), native 'pause' fires, then mediaSession 'play'
//   kokoro-media-pause       Kokoro playing, mediaSession 'pause' fires, then mediaSession 'play'
//   device-voice-pause       Offline device voice playing, mediaSession 'pause' fires, then mediaSession 'play'
//   media-session-handlers   Verify steering-wheel nexttrack/previoustrack and cleared seek handlers
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scenario = process.argv[2];
const ttsPath = path.join(__dirname, '..', 'public', 'js', 'tts.js');
const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetched = [];
let resolveDelayedFetch = null;
function fakeFetch(url) {
  const u = new URL(url, 'https://byob.test');
  if (u.pathname !== '/api/tts/speak') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  const text = u.searchParams.get('text');
  fetched.push(text);
  const engineHeader = scenario.startsWith('kokoro') ? 'kokoro' : 'edge';
  const bytes = new Uint8Array(400).fill(7);
  if (scenario === 'kokoro-loading-pause' && fetched.length === 1) {
    return new Promise((resolve) => {
      resolveDelayedFetch = () => resolve({
        ok: true, status: 200, headers: { get: () => engineHeader }, blob: async () => new Blob([bytes]),
      });
    });
  }
  return Promise.resolve({
    ok: true, status: 200, headers: { get: () => engineHeader }, blob: async () => new Blob([bytes]),
  });
}

function fakeAudio() {
  let startedAt = 0;
  let base = 0;
  const listeners = {};
  const a = {
    paused: true, ended: false, loop: false, duration: 10, src: '',
    plays: 0, pauses: 0,
    get currentTime() {
      if (a.paused || !startedAt) return base;
      return base + (Date.now() - startedAt) / 1000;
    },
    set currentTime(v) { base = v; if (!a.paused) startedAt = Date.now(); },
    playbackRate: 1, defaultPlaybackRate: 1, playsInline: false,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter((f) => f !== fn);
    },
    dispatch(ev) {
      for (const fn of (listeners[ev] || []).slice()) fn({ type: ev });
    },
    load: noop,
    pause() {
      base = a.currentTime;
      const wasPlaying = !a.paused;
      a.paused = true;
      a.pauses++;
      if (wasPlaying) a.dispatch('pause');
    },
    play() {
      if (a.paused) startedAt = Date.now();
      a.paused = false;
      a.plays++;
      a.dispatch('play');
      return Promise.resolve();
    },
  };
  return a;
}

const spoken = [];
const synthLog = [];
const synth = {
  speaking: false, pending: false, paused: false,
  getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }],
  addEventListener: noop,
  resume() { synthLog.push('resume'); synth.paused = false; },
  cancel() { synthLog.push('cancel'); synth.speaking = false; synth.pending = false; },
  speak(u) {
    synthLog.push(`speak:${u.text}`);
    if (u.volume === 0) return;
    spoken.push(u.text);
    synth.speaking = true;
    setTimeout(() => {
      if (synth.speaking) {
        synth.speaking = false;
        if (u.onend) u.onend({});
      }
    }, 80);
  },
};
function Utterance(text) { this.text = text; this.volume = 1; }

const mediaHandlers = {};
const mediaSession = {
  playbackState: 'none',
  metadata: null,
  setActionHandler(action, fn) {
    mediaHandlers[action] = fn;
  },
};

const paragraphs = ['First paragraph of the chapter.', 'Second paragraph of the chapter.', 'Third paragraph.'];
const els = paragraphs.map((t) => ({
  innerText: t, textContent: t,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  scrollIntoView: noop, getAttribute: () => null, dataset: {},
}));

const store = new Map();
const doc = {
  querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
  addEventListener: noop, createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
  body: { appendChild: noop }, hidden: false,
  documentElement: { scrollHeight: 1000 },
};
const win = {
  ReaderSettings: {}, addEventListener: noop, innerWidth: 440, innerHeight: 956,
  location: { href: 'https://byob.test/' }, scrollY: 0,
  speechSynthesis: synth,
  MediaMetadata: function MediaMetadata(init) { Object.assign(this, init); },
};
const nav = {
  onLine: scenario !== 'device-voice-pause',
  userAgent: 'iPhone',
  mediaSession,
};
const sandbox = {
  window: win,
  document: doc,
  navigator: nav,
  Audio: fakeAudio,
  SpeechSynthesisUtterance: Utterance,
  localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  URL, Blob, Uint8Array, ArrayBuffer, DataView, fetch: fakeFetch,
  Storage: { getUserId: () => 'usr_test', getLocalSettings: () => ({}), setLocalSettings: noop },
  AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Set, Map,
  performance: { now: () => Date.now() },
  console: { log: noop, warn: noop, error: noop },
};
win.window = win;
win.document = doc;
win.navigator = nav;
win.localStorage = sandbox.localStorage;
win.speechSynthesis = synth;
sandbox.globalThis = sandbox;

vm.runInNewContext(fs.readFileSync(ttsPath, 'utf8'), sandbox, { filename: 'tts.js' });
const TTS = win.TTSEngine;
for (const k of ['showBadge', 'openAudiobookModal', 'updateAudiobookModalContent',
  'showAudiobookLoading', 'updateEngineUI', 'preloadNextChapter', 'clearHighlight',
  'highlightWordAtIndex', 'updateSleepBadge']) TTS[k] = noop;
TTS.refreshParagraphs = () => { TTS.paragraphs = els; };
TTS.bindAudioElementEvents();
TTS.setupMediaSession();
TTS.paragraphs = els;
TTS.selectedVoice = 'en-US-AndrewNeural';
TTS.prefetchAhead = noop;
TTS.probeKokoro = async () => {};
TTS.DEVICE_SPEAK_AFTER_CANCEL_MS = 10;

(async () => {
  if (scenario === 'media-session-handlers') {
    console.log(JSON.stringify({
      hasPlay: typeof mediaHandlers.play === 'function',
      hasPause: typeof mediaHandlers.pause === 'function',
      hasStop: typeof mediaHandlers.stop === 'function',
      hasNextTrack: typeof mediaHandlers.nexttrack === 'function',
      hasPrevTrack: typeof mediaHandlers.previoustrack === 'function',
      seekForward: mediaHandlers.seekforward,
      seekBackward: mediaHandlers.seekbackward,
      seekTo: mediaHandlers.seekto,
    }));
    process.exit(0);
  }

  if (scenario === 'edge-bg-native-pause') {
    TTS.start(0);
    await sleep(60);
    // Simulate iPhone locked + Bluetooth AVRCP pausing the audio element directly
    doc.hidden = true;
    TTS._ignorePauseUntil = 0;
    const playsBeforePause = TTS.audioElement.plays;
    TTS.audioElement.pause();
    // Wait past _pauseTimer (250ms) and check if interruption recovery fought the pause
    await sleep(450);
    const afterPause = {
      isPaused: TTS.isPaused,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
      extraPlays: TTS.audioElement.plays - playsBeforePause,
    };
    // Now press play on headphones
    mediaHandlers.play();
    await sleep(60);
    const afterResume = {
      isPaused: TTS.isPaused,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
    };
    TTS.stop();
    console.log(JSON.stringify({ afterPause, afterResume }));
    process.exit(0);
  }

  if (scenario === 'kokoro-loading-pause') {
    TTS.enginePreference = 'kokoro';
    TTS.kokoroAvailable = true;
    TTS.start(0);
    await sleep(40);
    // Still loading (silent hold loop active), user presses pause on headphones (native pause)
    doc.hidden = true;
    TTS._ignorePauseUntil = 0;
    TTS.audioElement.pause();
    await sleep(350);
    // Now the in-flight fetch resolves while paused
    if (resolveDelayedFetch) resolveDelayedFetch();
    await sleep(60);
    const afterPause = {
      isPaused: TTS.isPaused,
      isLoading: TTS.isLoading,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
    };
    // Press play on headphones -> should resume from line 0
    mediaHandlers.play();
    await sleep(80);
    const afterResume = {
      isPaused: TTS.isPaused,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
    };
    TTS.stop();
    console.log(JSON.stringify({ afterPause, afterResume }));
    process.exit(0);
  }

  if (scenario === 'kokoro-media-pause') {
    TTS.enginePreference = 'kokoro';
    TTS.kokoroAvailable = true;
    TTS.start(0);
    await sleep(60);
    mediaHandlers.pause();
    await sleep(350);
    const afterPause = {
      isPaused: TTS.isPaused,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
    };
    mediaHandlers.play();
    await sleep(60);
    const afterResume = {
      isPaused: TTS.isPaused,
      audioPaused: TTS.audioElement.paused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
    };
    TTS.stop();
    console.log(JSON.stringify({ afterPause, afterResume }));
    process.exit(0);
  }

  if (scenario === 'device-voice-pause') {
    TTS.start(0);
    await sleep(30);
    // Pause via headphones while device voice is speaking paragraph 0
    mediaHandlers.pause();
    await sleep(150);
    const afterPause = {
      isPaused: TTS.isPaused,
      speaking: synth.speaking,
      deviceUtteranceNull: TTS.deviceUtterance === null,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
      spokenCount: spoken.length,
    };
    // Resume via headphones -> should speak paragraph 0 again
    mediaHandlers.play();
    await sleep(40);
    const afterResume = {
      isPaused: TTS.isPaused,
      playbackState: mediaSession.playbackState,
      currentIndex: TTS.currentIndex,
      spokenCount: spoken.length,
      lastSpoken: spoken[spoken.length - 1] || null,
    };
    TTS.stop();
    console.log(JSON.stringify({ afterPause, afterResume }));
    process.exit(0);
  }

  console.error('Unknown scenario:', scenario);
  process.exit(2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
