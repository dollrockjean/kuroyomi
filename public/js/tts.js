// Realistic Built-In Neural TTS Engine for BYoB
// Uses Blob-based local audio streaming for 100% compatibility across iOS Safari, macOS, Chrome, Edge, and Android
const TTS_ICONS = {
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  playLg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pauseLg: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  prevPara: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l-10 6 10 6V6z"/></svg>',
  nextPara: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 6l10 6-10 6V6z"/></svg>',
  prevCh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 6l-8.5 6 8.5 6V6zm8.5 0L11 12l8.5 6V6z"/></svg>',
  nextCh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 18l8.5-6-8.5-6v12zm8.5 0l8.5-6-8.5-6v12z"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
};

const TTSEngine = {
  audioElement: new Audio(),
  testAudioElement: new Audio(),
  blobCache: new Map(),
  pendingFetches: new Map(),
  // Raw MP3 frames + exact length per cached paragraph, so several paragraphs can be stitched into one stream
  audioBytes: new Map(),
  // The stitched stream now playing: { url, parts: [{ index, start, end }] }, or null for a single paragraph
  _chain: null,
  _lastSkipAt: 0,
  
  isPlaying: false,
  isPaused: false,
  isLoading: false,
  justDragged: false,
  
  selectedVoice: 'en-US-BrianNeural',
  rate: 1.0,
  pitch: 0,
  isUsingDeviceVoice: false,
  deviceUtterance: null,

  // --- Voice engine: Edge (Microsoft cloud) or Kokoro (Rocco's PC graphics card) ----------------
  // engineMode is what he picked; engineActive is what the audio now playing actually came from.
  // In Auto the app uses the PC whenever it answers and falls straight back to Edge when it does
  // not, mid-chapter included, because every paragraph is fetched on its own.
  engineMode: 'edge',               // 'auto' | 'kokoro' | 'edge' (Edge by default until Kokoro is measured; a saved choice wins)
  engineActive: 'edge',
  kokoroVoice: '',                  // '' = use the match for the chosen Edge voice
  kokoro: null,                     // { device, deviceName, rtf } while the PC is up; never its address
  kokoroVoices: [],
  _enginePromise: null,
  _engineCheckedAt: 0,
  _kokoroColdUntil: 0,              // after a failure, stop trying for a few seconds
  _kokoroPrefetched: new Set(),
  // 'unknown' until the server has answered once: a question that never came back is not the same
  // thing as a PC that is switched off, and the status line must not blame the PC for the server.
  engineProbeState: 'unknown',      // 'unknown' | 'ok' | 'down'
  _engineRetries: 0,
  _engineRetryTimer: null,
  ENGINE_PROBE_MS: 30000,           // re-ask the server at most this often
  ENGINE_PROBE_TIMEOUT_MS: 20000,   // the free host sleeps and wakes slowly; 6 s called it dead
  ENGINE_RETRY_MS: [2000, 4000, 8000, 15000, 30000],  // keep asking until the PC turns up
  KOKORO_RELAY_TIMEOUT_MS: 12000,   // a paragraph the PC has not rendered yet, over two hops
  KOKORO_COLD_MS: 20000,            // how long to stay on Edge after the PC failed
  
  paragraphs: [],
  currentIndex: 0,
  playbackSessionId: 0,
  onChapterEndCallback: null,
  _advancing: false,
  _advanceGen: 0,
  _watchdogTimer: null,
  _lastProgressAt: 0,
  _resumeAtChapterEnd: false,
  _preloadedChapterId: null,
  _prefetchActive: 0,
  // Dead-zone buffer: keep this much audio fetched past the paragraph now playing, so a drive through
  // a cellular dead zone keeps talking. Time-based, capped by paragraph count, three requests at a time.
  BUFFER_AHEAD_SECONDS: 240,
  BUFFER_MAX_PARAGRAPHS: 40,
  BUFFER_CHARS_PER_SECOND: 15,      // speech at 1.0x, used when a paragraph's real length is not known yet
  AUDIO_BYTES_KEEP: 160,
  _silenceUri: null,

  // Event handlers
  _onEndedHandler: null,
  _onTimeUpdateHandler: null,
  _onErrorHandler: null,
  _onPlayHandler: null,
  _onPauseHandler: null,

  // Real-time word-by-word highlight tracking
  currentWordList: [],
  currentSpokenLength: 0,
  activeWordIndex: -1,
  
  // Sleep Timer
  sleepTimerDuration: 0,
  sleepTimerRemaining: 0,
  sleepTimerInterval: null,
  sleepMode: 'off',
  sleepStartSnapshot: null,
  
  // Curated list of realistic narrative neural voices
  voices: [
    { id: 'en-US-BrianNeural', name: 'Brian', desc: 'Rich Baritone (Default)' },
    { id: 'en-US-AvaNeural', name: 'Ava', desc: 'Expressive & Natural' },
    { id: 'en-US-AndrewNeural', name: 'Andrew', desc: 'Dynamic American' },
    { id: 'en-US-EmmaNeural', name: 'Emma', desc: 'Warm & Articulate' },
    { id: 'en-US-ChristopherNeural', name: 'Christopher', desc: 'Deep Resonant' },
    { id: 'en-GB-RyanNeural', name: 'Ryan', desc: 'Classic British' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia', desc: 'Refined British' },
    { id: 'en-AU-WilliamNeural', name: 'William', desc: 'Smooth Australian' },
    { id: 'en-AU-NatashaNeural', name: 'Natasha', desc: 'Calm Australian' }
  ],

  // The "Multilingual" voices guess a language phrase by phrase, so an invented name in an English
  // book came out in a French accent. These books are all English, so a saved multilingual voice
  // becomes its English-only twin (the server does the same for anything that slips through).
  ENGLISH_ONLY_VOICE: {
    'en-US-AvaMultilingualNeural': 'en-US-AvaNeural',
    'en-US-EmmaMultilingualNeural': 'en-US-EmmaNeural',
    'en-US-BrianMultilingualNeural': 'en-US-BrianNeural',
    'en-US-AndrewMultilingualNeural': 'en-US-AndrewNeural',
    'en-US-ChristopherMultilingualNeural': 'en-US-ChristopherNeural',
    'en-GB-RyanMultilingualNeural': 'en-GB-RyanNeural',
    'en-GB-SoniaMultilingualNeural': 'en-GB-SoniaNeural',
    'en-AU-WilliamMultilingualNeural': 'en-AU-WilliamNeural',
    'en-AU-NatashaMultilingualNeural': 'en-AU-NatashaNeural'
  },

  englishOnlyVoice(id) {
    return (id && this.ENGLISH_ONLY_VOICE[id]) || id;
  },

  normalizeForSpeech(text) {
    if (!text) return '';
    // Unescape common HTML entities so &lt;&lt;Example&gt;&gt; becomes <<Example>>
    let clean = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Strip genuine leaked HTML tags using whitelist
    clean = clean.replace(/<\/?(?:a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|mark|ol|p|pre|ruby|s|small|span|strong|sub|sup|table|td|th|tr|u|ul)\b[^>]*\/?>/gi, ' ');

    // Unwrap decorated names/titles: <<Herald>>, <Herald>, «Herald», ‹Herald›, 〈Herald〉
    clean = clean.replace(/<{1,3}\s*([^<>\n]{1,120}?)\s*>{1,3}/g, ' $1 ');
    clean = clean.replace(/[«‹〈]\s*([^«»‹›〈〉\n]{1,120}?)\s*[»›〉]/g, ' $1 ');

    // Arrows, colons, brackets, ratios, em-dashes
    clean = clean.replace(/>>+|—>|->|==>|=>|→|⇒/g, ' — then — ');
    clean = clean.replace(/::+/g, ': ');
    clean = clean.replace(/[\[【《〔「『{](.*?)[\]】》〕」』}]/g, ' $1 ');
    clean = clean.replace(/\((\d+)\s*\/\s*(\d+)\)/g, '($1 of $2)');
    // Ellipses become one short breath pause. A comma or a run of dots left standing between
    // spaces is read out loud as the word "comma" (or "dot dot dot"), so the pause is attached to
    // the word before it, and an ellipsis with nothing before it is dropped.
    clean = clean.replace(/(\w)\s*(?:\.{3,}|…+)\s*/g, '$1, ');
    clean = clean.replace(/\s*(?:\.{3,}|…+)\s*/g, ' ');
    clean = clean.replace(/[\u2013\u2014]+|--+/g, ' — ');

    // Remove any leftover decorative symbols & stray angle brackets so speech synthesis never drops bracketed words
    clean = clean.replace(/[<>«»‹›〈〉\[\]【】《》〔〕「」『』{}|*_~^]+/g, ' ');

    // Collapse whitespace and fix spacing before punctuation
    clean = clean.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/\s+([,!?;:]|\.(?!\.))/g, '$1');
    // Nothing may be left standing on its own: a lone comma, semicolon or colon is read by name.
    clean = clean.replace(/(?:(?<=\s)|^)[,;:]+(?=\s|$)/g, ' ');
    clean = clean.replace(/^[\s,;:.]+/, '');
    // A paragraph that now ends on the pause an ellipsis left should just stop.
    clean = clean.replace(/[,;:]+$/, '.');
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
  },

  // Reads an MP3 (what the cloud voice returns) frame by frame. Returns the bare audio frames (no ID3 tags, no
  // Xing/Info header, which would make a joined file look as long as its first part) and the exact duration, or null
  // when it is not a plain MPEG Layer III stream (that paragraph then simply plays on its own).
  parseMp3(u8) {
    try {
      const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
      let i = 0;
      if (u8.length > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
        const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
        i = 10 + size + ((u8[5] & 0x10) ? 10 : 0);
      }
      const keep = [];
      let samples = 0;
      let rate = 0;
      let first = true;
      while (i + 4 <= u8.length) {
        if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) {
          if (keep.length) break;      // trailing junk or an ID3v1 tag
          i++;                         // leading junk before the first frame
          continue;
        }
        const ver = (u8[i + 1] >> 3) & 3;
        const layer = (u8[i + 1] >> 1) & 3;
        const bri = u8[i + 2] >> 4;
        const sri = (u8[i + 2] >> 2) & 3;
        const pad = (u8[i + 2] >> 1) & 1;
        if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) {
          if (keep.length) break;
          i++;
          continue;
        }
        const sr = SR[ver][sri];
        const kbps = (ver === 3 ? BR1 : BR2)[bri];
        const len = Math.floor(((ver === 3 ? 144 : 72) * kbps * 1000) / sr) + pad;
        if (len < 4 || i + len > u8.length) break;
        if (rate && sr !== rate) return null;
        rate = sr;
        let isInfo = false;
        if (first) {
          const head = String.fromCharCode.apply(null, u8.subarray(i + 4, Math.min(i + len, i + 60)));
          isInfo = /Xing|Info|VBRI/.test(head);
          first = false;
        }
        if (!isInfo) {
          keep.push([i, i + len]);
          samples += ver === 3 ? 1152 : 576;
        }
        i += len;
      }
      if (!keep.length || !rate) return null;
      const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const [a, b] of keep) { bytes.set(u8.subarray(a, b), o); o += b - a; }
      return { bytes, duration: samples / rate, rate };
    } catch (e) {
      return null;
    }
  },

  // Joins the paragraphs from `startIndex` whose audio is already here into ONE audio file. The phone then plays one
  // continuous track: no track ends between those paragraphs, so there is nothing for iOS to stall or kill on the lock
  // screen, and skipping inside it is just a seek. Returns null when fewer than two paragraphs are ready.
  buildChain(startIndex) {
    const parts = [];
    const blobs = [];
    let t = 0;
    let rate = 0;
    for (let i = startIndex; i < this.paragraphs.length && parts.length < 12 && t < 300; i++) {
      const el = this.paragraphs[i];
      const text = el ? el.innerText.trim() : '';
      if (!text) continue;
      const info = this.audioBytes.get(this.cacheKeyFor(text));
      if (!info || (rate && info.rate !== rate)) break;
      rate = info.rate;
      parts.push({ index: i, start: t, end: t + info.duration });
      blobs.push(info.bytes);
      t += info.duration;
    }
    if (parts.length < 2) return null;
    const url = URL.createObjectURL(new Blob(blobs, { type: 'audio/mpeg' }));
    return { url, parts };
  },

  // The stitched stream, only while it is what the audio element is actually playing
  activeChain() {
    const c = this._chain;
    return c && this.audioElement.src === c.url ? c : null;
  },

  chainPartAt(chain, time) {
    for (const part of chain.parts) {
      if (time < part.end - 0.05) return part;
    }
    return chain.parts[chain.parts.length - 1];
  },

  // Paragraph that should play once the current audio has finished
  indexAfterAudio() {
    const chain = this.activeChain();
    return chain ? chain.parts[chain.parts.length - 1].index + 1 : this.currentIndex + 1;
  },

  setChain(chain) {
    const old = this._chain;
    this._chain = chain;
    if (old && (!chain || old.url !== chain.url)) {
      setTimeout(() => { try { URL.revokeObjectURL(old.url); } catch (e) {} }, 2000);
    }
  },

  // Called as the stitched stream plays: when it crosses into the next paragraph, move the highlight, the saved spot,
  // the lock-screen title and the look-ahead along, without touching the audio itself
  syncChainPosition() {
    const chain = this.activeChain();
    if (!chain || !this.isPlaying || this.isPaused) return;
    const part = this.chainPartAt(chain, this.audioElement.currentTime || 0);
    if (part.index !== this.currentIndex) this.enterChainParagraph(part.index);
  },

  enterChainParagraph(index) {
    this.currentIndex = index;
    this._lastProgressAt = Date.now();
    const el = this.paragraphs[index];
    this.clearHighlight();
    if (el) {
      el.classList.add('speaking-active');
      if (!document.hidden && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (window.Reader) {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = docHeight > 0 ? Math.round((window.scrollY / docHeight) * 100) : 0;
      window.Reader.saveCurrentProgress(this.getParagraphPid(index), scrollPct, index === 0);
    }
    this.updateMediaSessionMetadata();
    this.updateAudiobookModalContent();
    this.updateAudioUI();
    this.prefetchAhead(index, 8);
    if (index >= this.paragraphs.length - 8) this.preloadNextChapter();
  },

  generateSilenceWavUri(seconds = 1) {
    const sampleRate = 22050;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = seconds * byteRate;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  },

  // Short on-device trail of what read aloud did (survives a reload), so "it stopped" always has a recorded reason
  logEvent(message) {
    try {
      const entry = `${new Date().toISOString().slice(11, 19)} ${message}`;
      const log = JSON.parse(localStorage.getItem('kuroyomi_tts_log') || '[]');
      log.push(entry);
      localStorage.setItem('kuroyomi_tts_log', JSON.stringify(log.slice(-60)));
    } catch (e) {}
  },

  // Playback went quiet for a reason that is not the listener's doing: say so instead of stopping silently
  stopWithReason(reason) {
    this.logEvent(`STOPPED: ${reason}`);
    this.stop();
    if (window.App && typeof window.App.showToast === 'function') {
      window.App.showToast(`Read aloud stopped: ${reason}`);
    }
  },

  // Playback is wanted but the browser would not start it (or the next chapter will not load): stay put, ready to
  // continue from the lock screen or the play button, rather than losing the session
  pauseWithReason(reason, atChapterEnd = false) {
    this.logEvent(`PAUSED: ${reason}`);
    this._resumeAtChapterEnd = atChapterEnd;
    this.isPaused = true;
    this.isLoading = false;
    this.releaseAudioSession();
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    this.updateAudioUI();
    if (window.App && typeof window.App.showToast === 'function') {
      window.App.showToast(`${reason} Tap play to continue.`);
    }
  },

  // Self-healing: if playback is supposed to be running but nothing has been audible for too long (a lost event, a
  // promise that never settled, device speech that never reported back), restart from where it should be
  startWatchdog() {
    this._lastProgressAt = Date.now();
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this.checkHealth(), 2000);
  },

  stopWatchdog() {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = null;
  },

  checkHealth() {
    if (!this.isPlaying || this.isPaused) {
      this._lastProgressAt = Date.now();
      return;
    }
    const a = this.audioElement;
    const deviceSpeaking = this.isUsingDeviceVoice && 'speechSynthesis' in window &&
      (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    if ((!a.paused && !a.loop && !a.ended) || deviceSpeaking) {
      this._lastProgressAt = Date.now();
      return;
    }
    const quietFor = Date.now() - this._lastProgressAt;
    // Loading a chapter or synthesizing a long paragraph legitimately takes a while; a lost event should not
    const patience = this._advancing ? 360000 : (this.isLoading ? 50000 : 8000);
    if (quietFor < patience) return;

    this._lastProgressAt = Date.now();
    const finished = a.ended || (isFinite(a.duration) && a.duration > 0 && a.currentTime >= a.duration - 0.3);
    this.logEvent(`watchdog: quiet ${Math.round(quietFor / 1000)}s at paragraph ${this.currentIndex}/${this.paragraphs.length}${this._advancing ? ' (chapter load)' : ''}`);
    if (this._advancing) {
      this._advanceGen++;           // abandon the stuck chapter load; its late result will be ignored
      this._advancing = false;
      this.speakParagraph(this.paragraphs.length);
    } else {
      this.speakParagraph(Math.min(finished ? this.indexAfterAudio() : this.currentIndex, this.paragraphs.length));
    }
  },

  // Keeps the audio element playing (silently) while the next audio is fetched. Mobile OSes freeze a page whose audio
  // goes quiet, which is what killed read aloud at chapter boundaries where the wait is a network round trip.
  holdAudioSession() {
    try {
      const a = this.audioElement;
      if (!this._silenceUri) this._silenceUri = this.generateSilenceWavUri(1);
      this._ignorePauseUntil = Date.now() + 500;
      a.loop = true;
      a.src = this._silenceUri;
      const p = a.play();
      if (p && p.catch) p.catch((e) => this.logEvent(`silent hold play() refused: ${e && e.name}`));
    } catch (e) {}
  },

  // Starts the first paragraph of the (preloaded) next chapter immediately. Returns its audio URL, or null if the
  // chapter text or that audio is not ready yet.
  startNextChapterAudioNow() {
    try {
      const reader = window.Reader;
      const ref = reader && reader.currentChapter && reader.currentChapter.next_chapter;
      if (!ref || !navigator.onLine || !reader.chapterCache) return null;
      const nextCh = reader.chapterCache.get(ref.id);
      if (!nextCh) return null;
      const texts = reader.getSpeakableTexts(nextCh, 1);
      if (!texts.length) return null;
      const url = this.blobCache.get(`${this.selectedVoice}_1.0_${this.pitch}_${this.normalizeForSpeech(texts[0])}`);
      if (!url) return null;
      const a = this.audioElement;
      this._ignorePauseUntil = Date.now() + 500;
      a.loop = false;
      a.src = url;
      a.playbackRate = this.rate || 1.0;
      const p = a.play();
      if (p && p.catch) p.catch((e) => this.logEvent(`handoff play() refused: ${e && e.name}`));
      this.logEvent('chapter handoff: next chapter audio started immediately');
      return url;
    } catch (e) {
      return null;
    }
  },

  // The OS paused our audio without the listener asking (the page is in the background, so the listener's own pause
  // would have come through the media-session handler). Retry for a while, because a navigation prompt or call that
  // caused it may end within seconds. Returns true if recovery is being attempted.
  tryRecoverFromInterruption(sessionAtPause) {
    const now = Date.now();
    if (!this._interruptSince || now - this._interruptSince > 120000) {
      this._interruptSince = now;
      this._interruptTries = 0;
    }
    if (this._interruptTries >= 40) return false;
    this._interruptTries++;
    this.logEvent(`audio paused by the system while backgrounded, retry ${this._interruptTries}`);
    clearTimeout(this._interruptTimer);
    const a = this.audioElement;
    const attempt = () => {
      if (this.playbackSessionId !== sessionAtPause || !this.isPlaying || this.isPaused) return;
      if (!a.paused) { this._interruptTries = 0; return; }
      const p = a.play();
      if (p && p.then) {
        p.then(() => {
          this.logEvent('audio resumed after system pause');
          this._interruptTries = 0;
        }).catch(() => {
          if (this._interruptTries >= 40) {
            this.logEvent('gave up resuming after system pause');
            this.isPaused = true;
            this.updateAudioUI();
            return;
          }
          this._interruptTries++;
          this._interruptTimer = setTimeout(attempt, 3000);
        });
      }
    };
    attempt();
    return true;
  },

  // Car, headphone and lock-screen "play": start the audio inside the handler itself, and if the element turns out to
  // be dead (nothing actually plays), rebuild the current paragraph from scratch
  mediaPlay() {
    this.logEvent('car/lock-screen play');
    clearTimeout(this._interruptTimer);
    this._interruptTries = 0;
    if (!this.isPlaying) { this.start(); return; }
    const a = this.audioElement;
    const special = this._resumeAtChapterEnd || this._advancing || this.isUsingDeviceVoice || a.loop ||
      !a.src || a.src === window.location.href;
    if (special) { this.resume(); return; }
    if (this.isPaused) {
      this.isPaused = false;
      this._lastProgressAt = Date.now();
    }
    const before = a.currentTime;
    const rebuild = (why) => {
      this.logEvent(`play did not start (${why}), rebuilding paragraph ${this.currentIndex}`);
      this.isPaused = false;
      this.speakParagraph(this.currentIndex);
    };
    const p = a.play();
    if (p && p.catch) p.catch((e) => rebuild(e && e.name ? e.name : 'refused'));
    this.updateAudioUI();
    setTimeout(() => {
      if (!this.isPlaying || this.isPaused || this.isLoading) return;
      if (a.paused || (a.currentTime === before && !a.ended)) rebuild('no progress');
    }, 1500);
  },

  // A play() refused in the background is often transient (the audio session is mid-handover); try a few more times
  async retryPlay(sessionId) {
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 350));
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return true;
      try {
        await this.audioElement.play();
        this.logEvent(`play() succeeded on retry ${i + 1}`);
        this.isLoading = false;
        return true;
      } catch (e) {}
    }
    return false;
  },

  releaseAudioSession() {
    this._ignorePauseUntil = Date.now() + 500;
    this.audioElement.pause();
    this.audioElement.loop = false;
  },

  bindAudioElementEvents() {
    if (this._onEndedHandler) {
      this.audioElement.removeEventListener('ended', this._onEndedHandler);
    }
    if (this._onTimeUpdateHandler) {
      this.audioElement.removeEventListener('timeupdate', this._onTimeUpdateHandler);
    }
    if (this._onErrorHandler) {
      this.audioElement.removeEventListener('error', this._onErrorHandler);
    }
    if (this._onPlayHandler) {
      this.audioElement.removeEventListener('play', this._onPlayHandler);
    }
    if (this._onPauseHandler) {
      this.audioElement.removeEventListener('pause', this._onPauseHandler);
    }

    this._onPlayHandler = () => {
      clearTimeout(this._pauseTimer);
      this._lastProgressAt = Date.now();
      try {
        if (this.rate) {
          this.audioElement.playbackRate = this.rate;
          this.audioElement.defaultPlaybackRate = this.rate;
        }
      } catch (e) {}
      if (this.isPlaying && this.isPaused) {
        // Resumed by the OS itself (lock screen / notification play button): sync our state. Special states need the
        // full resume logic (chapter end, chapter still loading, device voice, silent hold loop).
        this.logEvent('play event while paused -> resuming');
        if (this._resumeAtChapterEnd || this._advancing || this.isUsingDeviceVoice || this.audioElement.loop) {
          this.resume();
        } else {
          this.isPaused = false;
          this.updateAudioUI();
        }
      }
    };

    this._onPauseHandler = () => {
      // Browsers fire 'pause' just before 'ended' (and MP3 durations are often inexact), so never trust it right away.
      // Wait briefly: if the track simply finished, advance; otherwise treat it as an OS-level pause (bluetooth, call).
      if (Date.now() < (this._ignorePauseUntil || 0)) return;
      clearTimeout(this._pauseTimer);
      const sessionAtPause = this.playbackSessionId;
      this._pauseTimer = setTimeout(() => {
        const a = this.audioElement;
        if (this.playbackSessionId !== sessionAtPause || !this.isPlaying || this.isPaused || this.isLoading) return;
        if (!a.paused) return;
        const nearEnd = a.ended || (isFinite(a.duration) && a.duration > 0 && a.duration - a.currentTime < 0.6);
        if (nearEnd) {
          this.speakParagraph(this.indexAfterAudio());
        } else if (document.hidden && this.tryRecoverFromInterruption(sessionAtPause)) {
          // Paused by something other than the listener (a navigation voice prompt, a notification, a call): keep
          // trying to continue, since a real pause from the car or lock screen arrives through the media-session
          // handler below and never reaches this branch
        } else {
          this.isPaused = true;
          this.updateAudioUI();
        }
      }, 250);
    };

    this._onEndedHandler = () => {
      clearTimeout(this._pauseTimer);
      if (!this.isPlaying || this.isPaused || this.audioElement.loop) return;
      if (this.isLoading || this._advancing) return;
      this.speakParagraph(this.indexAfterAudio());
    };

    this._onTimeUpdateHandler = () => {
      this.syncChainPosition();
      this.syncWordHighlight();
    };

    this._onErrorHandler = (e) => {
      if (!this.isPlaying || this.isPaused || !this.audioElement.src || this.audioElement.src === window.location.href) {
        return;
      }
      console.warn('Audio playback error on paragraph', this.currentIndex, e);
      if (!this.isLoading) {
        const el = this.paragraphs[this.currentIndex];
        const text = el ? el.innerText.trim() : '';
        if (text) {
          this.setDeviceVoiceMode(true);
          this.updateAudiobookModalContent();
          this.speakWithDeviceVoice(text, this.currentIndex);
        }
      }
    };

    this.audioElement.addEventListener('ended', this._onEndedHandler);
    this.audioElement.addEventListener('timeupdate', this._onTimeUpdateHandler);
    this.audioElement.addEventListener('error', this._onErrorHandler);
    this.audioElement.addEventListener('play', this._onPlayHandler);
    this.audioElement.addEventListener('pause', this._onPauseHandler);
  },

  syncRateUI() {
    let r = this.rate;
    if (!r || isNaN(r) || r <= 0) r = 1.0;
    this.rate = Math.round(r * 100) / 100;
    const rateText = `${(this.rate % 1 === 0 ? this.rate.toFixed(1) : this.rate)}x`;

    const s1 = document.getElementById('ttsRateSlider');
    if (s1) s1.value = this.rate;
    const v1 = document.getElementById('ttsRateVal');
    if (v1) v1.textContent = rateText;

    const s2 = document.getElementById('audiobookModalSpeedSlider');
    if (s2) s2.value = this.rate;
    const v2 = document.getElementById('audiobookModalSpeedVal');
    if (v2) v2.textContent = rateText;

    const s3 = document.getElementById('quickSheetSpeedSlider');
    if (s3) s3.value = this.rate;
    const v3 = document.getElementById('quickSheetSpeedVal');
    if (v3) v3.textContent = rateText;

    const s4 = document.getElementById('ttsRateLabel');
    if (s4) s4.textContent = rateText;

    document.querySelectorAll('.speed-chip, .quick-sheet-speed-chip').forEach(chip => {
      const s = parseFloat(chip.getAttribute('data-speed'));
      chip.classList.toggle('selected', Math.abs(s - this.rate) < 0.05);
    });
  },

  init(onChapterEnd) {
    this.onChapterEndCallback = onChapterEnd;
    let savedRate = null;
    try {
      const directRate = localStorage.getItem('byob_tts_rate') || localStorage.getItem('kuroyomi_tts_rate');
      if (directRate) savedRate = parseFloat(directRate);
    } catch (e) {}

    const localSettings = (typeof Storage !== 'undefined' && Storage.getLocalSettings) ? Storage.getLocalSettings() : null;
    if (savedRate && !isNaN(savedRate) && savedRate > 0) {
      this.rate = Math.round(savedRate * 100) / 100;
    } else if (localSettings && localSettings.tts_rate) {
      this.rate = parseFloat(localSettings.tts_rate);
    } else if (window.ReaderSettings && window.ReaderSettings.tts_rate) {
      this.rate = parseFloat(window.ReaderSettings.tts_rate);
    }
    if (!this.rate || isNaN(this.rate) || this.rate <= 0) {
      this.rate = 1.0;
    }
    if (window.ReaderSettings) {
      window.ReaderSettings.tts_rate = this.rate;
    }

    if (localSettings && localSettings.tts_pitch !== undefined) {
      this.pitch = parseInt(localSettings.tts_pitch, 10) || 0;
    } else if (window.ReaderSettings && window.ReaderSettings.tts_pitch !== undefined) {
      this.pitch = parseInt(window.ReaderSettings.tts_pitch, 10) || 0;
    }
    if (localSettings && localSettings.tts_voice) {
      this.selectedVoice = this.englishOnlyVoice(localSettings.tts_voice);
    } else if (window.ReaderSettings && window.ReaderSettings.tts_voice) {
      this.selectedVoice = this.englishOnlyVoice(window.ReaderSettings.tts_voice);
    }
    this.loadEngineSettings();
    this.populateVoiceSelect();
    this.populateKokoroVoiceSelect();
    this.updatePitchUI();
    this.syncRateUI();
    this.updateEngineUI();
    // Ask once at startup and then whenever the tab comes back, so Auto knows if the PC is up.
    this.probeEngines(true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.probeEngines(true);
    });
    window.addEventListener('online', () => this.probeEngines(true));

    this.audioElement.playsInline = true;
    this.testAudioElement.playsInline = true;

    this.bindAudioElementEvents();

    // iOS Audio Priming on first user touch/click
    const primeAudio = () => {
      this.audioElement.load();
      this.testAudioElement.load();
      window.removeEventListener('touchstart', primeAudio);
      window.removeEventListener('click', primeAudio);
    };
    window.addEventListener('touchstart', primeAudio, { passive: true, once: true });
    window.addEventListener('click', primeAudio, { passive: true, once: true });

    // Handle tab visibility changes: restore smooth scrolling & wake suspended audio
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isPlaying) {
        const curEl = this.paragraphs[this.currentIndex];
        if (curEl && curEl.scrollIntoView) {
          curEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (!this.isPaused && !this.isLoading && this.audioElement && this.audioElement.paused && this.audioElement.src && this.audioElement.src !== window.location.href) {
          this.audioElement.play().catch(() => {});
        }
      }
    });

    // Setup lock screen & bluetooth media session controls
    this.setupMediaSession();

    // Allow tapping any paragraph in the reader to jump TTS speech to that paragraph (works playing or paused)
    const readerContent = document.getElementById('readerContent');
    if (readerContent) {
      readerContent.addEventListener('click', (e) => {
        const targetP = e.target.closest('.reader-paragraph, .reader-heading');
        if (targetP && this.paragraphs && this.paragraphs.length) {
          const idx = this.paragraphs.indexOf(targetP);
          if (idx !== -1 && idx !== this.currentIndex) {
            this.jumpToParagraph(idx);
          }
        }
      });
    }

    // Wire PC Mini Badge controls
    const pcPlayPause = document.getElementById('ttsPlayPauseBtn');
    if (pcPlayPause) pcPlayPause.addEventListener('click', () => this.toggle());

    const pcPrevPara = document.getElementById('ttsPrevParaBtn');
    if (pcPrevPara) pcPrevPara.addEventListener('click', () => this.prevParagraph());

    const pcNextPara = document.getElementById('ttsNextParaBtn');
    if (pcNextPara) pcNextPara.addEventListener('click', () => this.nextParagraph());

    const pcPrevCh = document.getElementById('ttsPrevChapterBtn');
    if (pcPrevCh) pcPrevCh.addEventListener('click', () => this.prevChapter());

    const pcNextCh = document.getElementById('ttsNextChapterBtn');
    if (pcNextCh) pcNextCh.addEventListener('click', () => this.nextChapter());

    const pcStop = document.getElementById('ttsStopBtn');
    if (pcStop) pcStop.addEventListener('click', () => this.stop());

    const pcCover = document.getElementById('ttsPcCoverBtn');
    if (pcCover) pcCover.addEventListener('click', () => this.openAudiobookModal());

    // Wire Mobile Mini Badge controls
    const mobPlayPause = document.getElementById('ttsMobilePlayPauseBtn');
    if (mobPlayPause) {
      mobPlayPause.addEventListener('click', () => {
        if (!this.justDragged) this.toggle();
      });
    }

    const mobStop = document.getElementById('ttsMobileStopBtn');
    if (mobStop) {
      mobStop.addEventListener('click', () => {
        if (!this.justDragged) this.stop();
      });
    }

    const mobCover = document.getElementById('ttsMobileCoverBtn');
    if (mobCover) {
      mobCover.addEventListener('click', () => {
        if (!this.justDragged) this.openAudiobookModal();
      });
    }

    // Wire Full-Screen Audiobook Modal controls
    const modalPlayPause = document.getElementById('modalPlayPauseBtn');
    if (modalPlayPause) modalPlayPause.addEventListener('click', () => this.toggle());

    const modalPrevPara = document.getElementById('modalPrevParaBtn');
    if (modalPrevPara) modalPrevPara.addEventListener('click', () => this.prevParagraph());

    const modalNextPara = document.getElementById('modalNextParaBtn');
    if (modalNextPara) modalNextPara.addEventListener('click', () => this.nextParagraph());

    const modalPrevCh = document.getElementById('modalPrevChapterBtn');
    if (modalPrevCh) modalPrevCh.addEventListener('click', () => this.prevChapter());

    const modalNextCh = document.getElementById('modalNextChapterBtn');
    if (modalNextCh) modalNextCh.addEventListener('click', () => this.nextChapter());

    const modalStop = document.getElementById('audiobookModalStopBtn');
    if (modalStop) modalStop.addEventListener('click', () => this.stop());

    const modalMinimize = document.getElementById('audiobookMinimizeBtn');
    if (modalMinimize) modalMinimize.addEventListener('click', () => this.closeAudiobookModal());

    // Set vector SVG icons for all skip and stop buttons
    const setBtnIcon = (id, svg) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = svg;
    };
    setBtnIcon('ttsPrevChapterBtn', TTS_ICONS.prevCh);
    setBtnIcon('ttsPrevParaBtn', TTS_ICONS.prevPara);
    setBtnIcon('ttsNextParaBtn', TTS_ICONS.nextPara);
    setBtnIcon('ttsNextChapterBtn', TTS_ICONS.nextCh);
    setBtnIcon('ttsStopBtn', TTS_ICONS.stop);
    setBtnIcon('ttsMobileStopBtn', TTS_ICONS.stop);
    setBtnIcon('modalPrevChapterBtn', TTS_ICONS.prevCh);
    setBtnIcon('modalPrevParaBtn', TTS_ICONS.prevPara);
    setBtnIcon('modalNextParaBtn', TTS_ICONS.nextPara);
    setBtnIcon('modalNextChapterBtn', TTS_ICONS.nextCh);

    // Wire speed preset chips across audiobook modal and middle quick sheet
    const speedChips = document.querySelectorAll('.speed-chip, .quick-sheet-speed-chip');
    speedChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const s = parseFloat(chip.getAttribute('data-speed'));
        if (!isNaN(s)) this.setRate(s);
      });
    });

    // Wire speed sliders across Audio tab and Audiobook modal
    const bindSpeedSlider = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => this.setRate(e.target.value));
      el.addEventListener('change', (e) => this.setRate(e.target.value));
    };
    bindSpeedSlider('ttsRateSlider');
    bindSpeedSlider('audiobookModalSpeedSlider');
    bindSpeedSlider('quickSheetSpeedSlider');

    // Wire pitch sliders (decoupled input for instant UI feedback + change for commit)
    const bindPitchSlider = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => this.onPitchInput(e.target.value));
      el.addEventListener('change', (e) => this.commitPitch(e.target.value));
    };
    bindPitchSlider('ttsPitchSlider');
    bindPitchSlider('audiobookModalPitchSlider');
    bindPitchSlider('audiobookCogPitchSlider');

    const pitchResetBtn = document.getElementById('audiobookPitchResetBtn');
    if (pitchResetBtn) {
      pitchResetBtn.addEventListener('click', () => {
        this.pitch = 0;
        this.updatePitchUI();
        this.commitPitch(0);
      });
    }

    // Wire retry on offline badge tap
    const offlineStatusBadge = document.getElementById('audiobookOfflineStatus');
    if (offlineStatusBadge) {
      offlineStatusBadge.style.cursor = 'pointer';
      offlineStatusBadge.title = 'Click to switch back to cloud voice';
      offlineStatusBadge.addEventListener('click', () => {
        if (window.App && typeof window.App.showToast === 'function') {
          window.App.showToast('Reconnecting to main cloud voice...');
        }
        this.setDeviceVoiceMode(false);
        this.speakParagraph(this.currentIndex);
      });
    }

    // Wire Audiobook Sleep Timer Cog & Modal
    const cogBtn = document.getElementById('audiobookSleepTimerCogBtn');
    if (cogBtn) cogBtn.addEventListener('click', () => this.openSleepModal());

    const sleepBadge = document.getElementById('audiobookModalSleepBadge');
    if (sleepBadge) sleepBadge.addEventListener('click', () => this.openSleepModal());

    const closeSleepBtn = document.getElementById('closeAudiobookSleepBtn');
    if (closeSleepBtn) closeSleepBtn.addEventListener('click', () => this.closeSleepModal());

    const sleepBackdrop = document.getElementById('audiobookSleepBackdrop');
    if (sleepBackdrop) sleepBackdrop.addEventListener('click', () => this.closeSleepModal());

    const presetBtns = document.querySelectorAll('.sleep-preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-sleep');
        this.setSleepTimer(val);
        this.closeSleepModal();
      });
    });

    const add5Btn = document.getElementById('sleepAdd5Btn');
    if (add5Btn) add5Btn.addEventListener('click', () => this.addSleepTimerMinutes(5));

    const add15Btn = document.getElementById('sleepAdd15Btn');
    if (add15Btn) add15Btn.addEventListener('click', () => this.addSleepTimerMinutes(15));

    const turnOffBtn = document.getElementById('sleepTurnOffBtn');
    if (turnOffBtn) turnOffBtn.addEventListener('click', () => {
      this.setSleepTimer('off');
      this.closeSleepModal();
    });

    // Initialize draggable mobile corner badge
    this.initDraggableBadge();

    // Listen for window resize
    window.addEventListener('resize', () => this.applySavedCornerPosition());
  },

  populateVoiceSelect() {
    const s1 = document.getElementById('ttsVoiceSelect');
    const s2 = document.getElementById('audiobookModalVoiceSelect');
    const s3 = document.getElementById('audiobookCogVoiceSelect');
    const selects = [s1, s2, s3].filter(Boolean);
    if (!selects.length) return;

    const saved = window.ReaderSettings?.tts_voice || this.selectedVoice;
    this.selectedVoice = this.englishOnlyVoice(saved);

    selects.forEach(sel => {
      sel.innerHTML = '';
      this.voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = `${v.name} (${v.desc})`;
        if (v.id === this.selectedVoice) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      });

      sel.onchange = (e) => {
        this.setVoice(e.target.value);
      };
    });
  },

  // The narrators Kokoro ships. Kept here so the picker works even before the PC has answered.
  KOKORO_VOICE_LIST: [
    { id: '', name: 'Match my Edge voice', desc: 'closest narrator' },
    { id: 'am_michael', name: 'Michael', desc: 'warm American' },
    { id: 'am_adam', name: 'Adam', desc: 'steady American' },
    { id: 'am_eric', name: 'Eric', desc: 'deeper American' },
    { id: 'am_fenrir', name: 'Fenrir', desc: 'dark and heavy' },
    { id: 'am_puck', name: 'Puck', desc: 'lively American' },
    { id: 'am_onyx', name: 'Onyx', desc: 'low and calm' },
    { id: 'af_heart', name: 'Heart', desc: 'expressive American' },
    { id: 'af_bella', name: 'Bella', desc: 'rich American' },
    { id: 'af_nicole', name: 'Nicole', desc: 'soft, close-mic' },
    { id: 'af_aoede', name: 'Aoede', desc: 'clear American' },
    { id: 'bm_george', name: 'George', desc: 'classic British' },
    { id: 'bm_fable', name: 'Fable', desc: 'storybook British' },
    { id: 'bm_lewis', name: 'Lewis', desc: 'gravelly British' },
    { id: 'bf_emma', name: 'Emma', desc: 'refined British' },
    { id: 'bf_isabella', name: 'Isabella', desc: 'bright British' }
  ],

  populateKokoroVoiceSelect() {
    const selects = [document.getElementById('kokoroVoiceSelect'),
                     document.getElementById('audiobookCogKokoroVoiceSelect')].filter(Boolean);
    selects.forEach(sel => {
      sel.innerHTML = '';
      this.KOKORO_VOICE_LIST.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.id ? `${v.name} (${v.desc})` : v.name;
        if (v.id === this.kokoroVoice) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = (e) => this.setKokoroVoice(e.target.value);
    });
  },

  setVoice(voiceId) {
    this.selectedVoice = this.englishOnlyVoice(voiceId);
    this.blobCache.clear(); // Clear cache when voice changes
    this.pendingFetches.clear();
    this.setDeviceVoiceMode(false); // ALWAYS prioritize selected cloud voice

    if (window.ReaderSettings) {
      window.ReaderSettings.tts_voice = voiceId;
      if (window.SyncService) {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    }
    const s1 = document.getElementById('ttsVoiceSelect');
    if (s1 && s1.value !== voiceId) s1.value = voiceId;
    const s2 = document.getElementById('audiobookModalVoiceSelect');
    if (s2 && s2.value !== voiceId) s2.value = voiceId;
    const s3 = document.getElementById('audiobookCogVoiceSelect');
    if (s3 && s3.value !== voiceId) s3.value = voiceId;

    if (this.isPlaying && !this.isPaused) {
      // Immediately stop existing playback so old voice stops instantly without collision
      this.audioElement.pause();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      this.speakParagraph(this.currentIndex);
    }
  },

  getRateParam(rateVal) {
    const r = rateVal !== undefined ? rateVal : this.rate;
    const pct = Math.round((r - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  },

  getPitchParam(pitchVal) {
    const p = pitchVal !== undefined ? pitchVal : this.pitch;
    return p >= 0 ? `+${p}Hz` : `${p}Hz`;
  },

  onPitchInput(val) {
    this.pitch = parseInt(val, 10) || 0;
    this.updatePitchUI();
  },

  commitPitch(val) {
    if (val !== undefined) {
      this.pitch = parseInt(val, 10) || 0;
    }
    this.blobCache.clear();
    this.pendingFetches.clear();
    if (window.ReaderSettings) {
      window.ReaderSettings.tts_pitch = this.pitch;
      if (typeof Storage !== 'undefined' && typeof Storage.setLocalSettings === 'function') {
        Storage.setLocalSettings(window.ReaderSettings);
      }
      if (window.SyncService && typeof window.SyncService.syncSettings === 'function') {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    }
    this.updatePitchUI();
    if (this.isPlaying && !this.isPaused) {
      this.speakParagraph(this.currentIndex);
    }
  },

  setPitch(val) {
    this.onPitchInput(val);
    this.commitPitch();
  },

  updatePitchUI() {
    const p = this.pitch || 0;
    const pStr = `${p >= 0 ? '+' : ''}${p}Hz`;
    const labelStr = p === 0 ? '0Hz (Normal)' : pStr;

    const slider1 = document.getElementById('ttsPitchSlider');
    if (slider1 && parseInt(slider1.value, 10) !== p) slider1.value = p;
    const val1 = document.getElementById('ttsPitchVal');
    if (val1) val1.textContent = labelStr;

    const slider2 = document.getElementById('audiobookModalPitchSlider');
    if (slider2 && parseInt(slider2.value, 10) !== p) slider2.value = p;
    const val2 = document.getElementById('audiobookModalPitchVal');
    if (val2) val2.textContent = pStr;

    const slider3 = document.getElementById('audiobookCogPitchSlider');
    if (slider3 && parseInt(slider3.value, 10) !== p) slider3.value = p;
    const val3 = document.getElementById('audiobookCogPitchVal');
    if (val3) val3.textContent = pStr;
  },

  // ---------------------------------------------------------------------------------------------
  // Voice engine plumbing
  // ---------------------------------------------------------------------------------------------

  // One key per (engine, voice, pitch, text). The engine is part of it so switching engines never
  // replays the other one's audio, and the joined-stream code only ever joins same-engine parts.
  cacheKeyFor(text, voiceId, pitchVal, engine) {
    const clean = this.normalizeForSpeech(text);
    const v = voiceId === undefined ? this.selectedVoice : voiceId;
    const p = pitchVal === undefined ? this.pitch : pitchVal;
    const e = engine === undefined ? this.engineForNextFetch() : engine;
    // Edge keeps the original key shape so audio already cached on his phone still counts.
    return e === 'kokoro'
      ? `k:${this.kokoroVoiceFor(v)}_1.0_${clean}`
      : `${v}_1.0_${p}_${clean}`;
  },

  engineStorageKey: 'byob_tts_engine',

  loadEngineSettings() {
    let mode = '';
    try { mode = localStorage.getItem(this.engineStorageKey) || ''; } catch (e) {}
    if (!mode) {
      const s = (typeof Storage !== 'undefined' && Storage.getLocalSettings) ? Storage.getLocalSettings() : null;
      mode = (s && s.tts_engine) || (window.ReaderSettings && window.ReaderSettings.tts_engine) || '';
    }
    if (['auto', 'kokoro', 'edge'].indexOf(mode) !== -1) this.engineMode = mode;
    let kv = '';
    try { kv = localStorage.getItem('byob_kokoro_voice') || ''; } catch (e) {}
    if (!kv) {
      const s = (typeof Storage !== 'undefined' && Storage.getLocalSettings) ? Storage.getLocalSettings() : null;
      kv = (s && s.kokoro_voice) || (window.ReaderSettings && window.ReaderSettings.kokoro_voice) || '';
    }
    this.kokoroVoice = kv || '';
  },

  setEngineMode(mode) {
    if (['auto', 'kokoro', 'edge'].indexOf(mode) === -1) return;
    if (mode === this.engineMode) { this.updateEngineUI(); return; }
    this.engineMode = mode;
    this._kokoroColdUntil = 0;
    try { localStorage.setItem(this.engineStorageKey, mode); } catch (e) {}
    this.persistEngineSetting('tts_engine', mode);
    this._engineCheckedAt = 0;
    this._engineRetries = 0;
    // Picking Edge stops the search; picking Kokoro or Auto starts it again from the quick steps.
    this.scheduleEngineRetry();
    this.probeEngines().then(() => this.updateEngineUI());
    this.updateEngineUI();
    this.logEvent(`voice engine set to ${mode}`);
  },

  setKokoroVoice(voiceId) {
    this.kokoroVoice = voiceId || '';
    try { localStorage.setItem('byob_kokoro_voice', this.kokoroVoice); } catch (e) {}
    this.persistEngineSetting('kokoro_voice', this.kokoroVoice);
    this.updateEngineUI();
  },

  persistEngineSetting(key, value) {
    if (!window.ReaderSettings) return;
    window.ReaderSettings[key] = value;
    try {
      if (typeof Storage !== 'undefined' && typeof Storage.setLocalSettings === 'function') {
        Storage.setLocalSettings(window.ReaderSettings);
      }
      if (window.SyncService && typeof window.SyncService.syncSettings === 'function') {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    } catch (e) {}
  },

  // Which Kokoro narrator stands in for an Edge voice, so his saved voice keeps its character.
  kokoroVoiceFor(edgeVoiceId) {
    if (this.kokoroVoice) return this.kokoroVoice;
    const map = {
      'en-US-BrianNeural': 'am_michael', 'en-US-BrianMultilingualNeural': 'am_michael',
      'en-US-AndrewNeural': 'am_adam', 'en-US-ChristopherNeural': 'am_eric',
      'en-US-AvaNeural': 'af_heart', 'en-US-AvaMultilingualNeural': 'af_heart',
      'en-US-EmmaNeural': 'af_nicole', 'en-US-EmmaMultilingualNeural': 'af_nicole',
      'en-GB-RyanNeural': 'bm_george', 'en-GB-SoniaNeural': 'bf_emma',
      'en-AU-WilliamMultilingualNeural': 'bm_lewis'
    };
    return map[edgeVoiceId || this.selectedVoice] || 'am_michael';
  },

  kokoroUsable() {
    return !!(this.kokoro && Date.now() > this._kokoroColdUntil);
  },

  engineForNextFetch() {
    if (this.engineMode === 'edge') return 'edge';
    if (this.kokoroUsable()) return 'kokoro';
    // Kokoro-only mode still has to make a sound when the PC is off, so it borrows Edge rather than
    // leaving him with silence on the road. The label says which one is actually speaking.
    return 'edge';
  },

  // Which build of the app this page is, read off the address its own script was asked for.
  runningBuild() {
    try {
      const el = document.querySelector('script[src*="js/tts.js"]');
      const m = ((el && el.getAttribute('src')) || '').match(/[?&]v=([0-9.]+)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  },

  // Asks the BYoB server which engines are up. Cheap, never blocks playback, and keeps asking.
  probeEngines(force) {
    const now = Date.now();
    if (!force && this._enginePromise && now - this._engineCheckedAt < this.ENGINE_PROBE_MS) {
      return this._enginePromise;
    }
    this._engineCheckedAt = now;
    this._enginePromise = (async () => {
      let answered = false;
      try {
        const userId = (window.SyncService && window.SyncService.currentUserId)
          || (typeof Storage !== 'undefined' && Storage.getUserId && Storage.getUserId()) || '';
        const token = (typeof Storage !== 'undefined' && Storage.getDeviceToken
          && Storage.getDeviceToken()) || '';
        if (!userId) {
          // No account yet: sync is still connecting, or the server was asleep when it tried. That
          // is not an answer about the PC, so keep asking instead of going quiet for the whole
          // session, which is what this did until 2026-11-25.
          this.kokoro = null;
          this.engineProbeState = 'unknown';
          this.scheduleEngineRetry();
          this.updateEngineUI();
          return null;
        }
        const controller = new AbortController();
        // The BYoB server sleeps when nobody is reading and needs 30 to 60 seconds to wake up. Six
        // seconds used to be the whole budget, so the very first question of the morning timed out
        // against a server that was only yawning (2026-11-24).
        const timer = setTimeout(() => controller.abort(), this.ENGINE_PROBE_TIMEOUT_MS);
        let res;
        try {
          // The build is sent so the server can say which app a phone is running when the voice
          // goes missing. Without it a stale copy of the app and a real fault look identical from
          // here, and that cost two nights of guessing (2026-11-25).
          res = await fetch(`/api/tts/engines?user_id=${encodeURIComponent(userId)}`
            + `&build=${encodeURIComponent(this.runningBuild())}`, {
            signal: controller.signal,
            headers: token ? { 'X-Device-Token': token } : {}
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error('engine list ' + res.status);
        const data = await res.json();
        answered = true;
        const k = data && data.engines && data.engines.kokoro;
        if (k && k.available) {
          // All this side needs to know is that the PC is up. Where it is and the key that opens it
          // stay on the BYoB server, which fetches the audio for us (2026-11-24): a browser is the
          // last place to keep either, and a stranger with the link could have used the graphics card.
          const wasDown = !this.kokoro;
          this.kokoro = {
            device: k.device || '',
            deviceName: k.device_name || 'PC',
            rtf: k.realtime_factor || 0
          };
          if (wasDown) this._kokoroPrefetched.clear();
        } else {
          this.kokoro = null;
        }
      } catch (e) {
        this.kokoro = null;
      }
      // "The server never answered" and "the server says the PC is not there" look the same on
      // screen otherwise, and only one of them is the PC's fault.
      this.engineProbeState = this.kokoro ? 'ok' : (answered ? 'down' : 'unknown');
      this.scheduleEngineRetry();
      this.updateEngineUI();
      return this.kokoro;
    })();
    return this._enginePromise;
  },

  // One unanswered question used to be the final word. The app asked once at startup and then only
  // when it came back to the front, so opening it while the server was still waking left "PC not
  // reachable" on the screen for the whole chapter with a perfectly healthy PC behind it. It is also
  // normal for the server to know nothing for the first three quarters of a minute after it wakes:
  // the PC's check-in only comes every 45 seconds. So keep asking, quickly at first and then every
  // half minute, until the PC turns up or he switches to Edge (2026-11-24).
  scheduleEngineRetry() {
    if (this._engineRetryTimer) {
      clearTimeout(this._engineRetryTimer);
      this._engineRetryTimer = null;
    }
    if (this.engineMode === 'edge' || this.kokoro) {
      this._engineRetries = 0;
      return;
    }
    const steps = this.ENGINE_RETRY_MS;
    const wait = steps[Math.min(this._engineRetries, steps.length - 1)];
    this._engineRetries += 1;
    this._engineRetryTimer = setTimeout(() => {
      this._engineRetryTimer = null;
      this.probeEngines(true);
    }, wait);
  },

  // Tells the PC which paragraphs are coming so it renders them before they are asked for. This is
  // what removes the gaps on a slow cellular link: by the time the app asks, the audio is ready and
  // the request is only a download.
  kokoroPrefetch(texts) {
    if (!this.kokoroUsable() || !texts || !texts.length) return;
    const voice = this.kokoroVoiceFor(this.selectedVoice);
    const fresh = [];
    for (const t of texts) {
      const clean = this.normalizeForSpeech(t);
      if (!clean) continue;
      const mark = voice + '|' + clean;
      if (this._kokoroPrefetched.has(mark)) continue;
      this._kokoroPrefetched.add(mark);
      fresh.push(clean);
    }
    if (!fresh.length) return;
    if (this._kokoroPrefetched.size > 3000) this._kokoroPrefetched.clear();
    const userId = (window.SyncService && window.SyncService.currentUserId)
      || (typeof Storage !== 'undefined' && Storage.getUserId && Storage.getUserId()) || '';
    if (!userId) return;
    try {
      fetch('/api/tts/prefetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, texts: fresh.slice(0, 60), voice: voice }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  },

  engineStatusText() {
    if (this.engineMode === 'edge') return 'Edge voices';
    const live = this.kokoroUsable();
    if (live) {
      return this.engineMode === 'kokoro' ? 'Your PC is speaking' : 'Auto: your PC is speaking';
    }
    // Still waiting on an answer (a sleeping server, no signal): Edge carries the reading in the
    // meantime and the app keeps asking, so do not announce the PC as dead before it has been asked.
    if (this.engineProbeState !== 'down') {
      return this.engineMode === 'kokoro'
        ? 'Looking for your PC, using Edge' : 'Auto: looking for your PC, using Edge';
    }
    return this.engineMode === 'kokoro'
      ? 'PC not reachable, using Edge' : 'Auto: using Edge (PC not reachable)';
  },

  // Keeps every engine control in the app showing the same truth: the chosen mode, whether the PC is
  // reachable right now, and which engine the audio playing came from.
  updateEngineUI() {
    const live = this.kokoroUsable();
    document.querySelectorAll('[data-engine-option]').forEach(btn => {
      const on = btn.getAttribute('data-engine-option') === this.engineMode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-engine-status]').forEach(el => {
      el.textContent = this.engineStatusText();
      el.classList.toggle('engine-live', live);
    });
    document.querySelectorAll('[data-engine-active]').forEach(el => {
      el.textContent = this.engineActive === 'kokoro' ? 'Kokoro' : 'Edge';
    });
    document.querySelectorAll('[data-engine-detail]').forEach(el => {
      if (live && this.kokoro) {
        const dev = this.kokoro.device === 'cuda' ? 'graphics card' : 'processor';
        el.textContent = `${this.kokoro.deviceName} on its ${dev}`
          + (this.kokoro.rtf > 1 ? `, ${this.kokoro.rtf}x faster than real time` : '');
      } else {
        el.textContent = 'Kokoro runs on your PC. It starts by itself when the PC is on.';
      }
    });
    // Narrator pickers only matter when Kokoro can be used (#kokoroVoiceRow plus any [data-kokoro-row])
    const kokoroRows = new Set(document.querySelectorAll('[data-kokoro-row]'));
    const kokoroRow = document.getElementById('kokoroVoiceRow');
    if (kokoroRow) kokoroRows.add(kokoroRow);
    kokoroRows.forEach(row => {
      row.style.display = (this.engineMode === 'edge') ? 'none' : (row.getAttribute('data-kokoro-display') || '');
    });
    const pitchNote = document.getElementById('ttsPitchKokoroNote');
    if (pitchNote) pitchNote.style.display = (this.engineMode === 'edge') ? 'none' : '';
  },

  markKokoroDown(why) {
    this._kokoroColdUntil = Date.now() + this.KOKORO_COLD_MS;
    this.engineActive = 'edge';
    this.logEvent(`PC voice unavailable (${why}), using Edge`);
    this.updateEngineUI();
    // Ask the server again soon: the PC may have come back with a new address.
    setTimeout(() => this.probeEngines(true), 2000);
  },

  async getAudioBlobUrl(text, voiceId, rateVal, pitchVal, retries = 1) {
    const pVal = pitchVal !== undefined ? pitchVal : this.pitch;
    // English books only: a voice that would guess the language becomes its English-only twin.
    voiceId = this.englishOnlyVoice(voiceId);
    const cleanSpeechText = this.normalizeForSpeech(text);
    if (!cleanSpeechText) return '';

    const engine = this.engineForNextFetch();
    // Synthesize cloud audio at base rate (+0%) so audioElement.playbackRate handles speed changes instantly without refetching or double-speeding
    const cacheKey = this.cacheKeyFor(text, voiceId, pVal, engine);
    if (this.blobCache.has(cacheKey)) {
      return this.blobCache.get(cacheKey);
    }
    if (this.pendingFetches.has(cacheKey)) {
      return await this.pendingFetches.get(cacheKey);
    }

    const storeBlob = async (blob, key) => {
      const blobUrl = URL.createObjectURL(blob);
      try {
        const info = this.parseMp3(new Uint8Array(await blob.arrayBuffer()));
        if (info) {
          this.audioBytes.set(key, info);
          // A long drive must not fill the phone's memory, but the dead-zone buffer (about 4 minutes, up to
          // 40 paragraphs ahead) must survive until it is played: keep the newest 160 paragraphs (48 kbps is
          // about 6 KB a second, so even 160 long paragraphs stay in the low tens of MB).
          while (this.audioBytes.size > this.AUDIO_BYTES_KEEP) this.audioBytes.delete(this.audioBytes.keys().next().value);
        }
      } catch (e) {}
      this.blobCache.set(key, blobUrl);
      return blobUrl;
    };

    const fetchPromise = (async () => {
      // 1. The PC, through the BYoB server. The server knows where the PC is and holds its key, and
      // falls back to Edge by itself if the PC stops answering, so this request always returns audio.
      if (engine === 'kokoro') {
        const userId = (window.SyncService && window.SyncService.currentUserId)
          || (typeof Storage !== 'undefined' && Storage.getUserId && Storage.getUserId()) || '';
        const rUrl = `/api/tts/speak?engine=kokoro&user_id=${encodeURIComponent(userId)}`
          + `&text=${encodeURIComponent(cleanSpeechText)}`
          + `&voice=${encodeURIComponent(voiceId)}`
          + `&kvoice=${encodeURIComponent(this.kokoroVoiceFor(voiceId || this.selectedVoice))}`
          + `&rate=${encodeURIComponent('+0%')}&pitch=${encodeURIComponent(this.getPitchParam(pVal))}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.KOKORO_RELAY_TIMEOUT_MS);
        try {
          const res = await fetch(rUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error('PC voice via server status ' + res.status);
          const blob = await res.blob();
          if (!blob || blob.size < 200) throw new Error('PC voice via server sent nothing');
          const blobUrl = await storeBlob(blob, cacheKey);
          this.engineActive = res.headers.get('X-BYoB-Engine') === 'kokoro' ? 'kokoro' : 'edge';
          this.pendingFetches.delete(cacheKey);
          this.updateEngineUI();
          return blobUrl;
        } catch (err) {
          clearTimeout(timer);
          this.markKokoroDown(err && err.name === 'AbortError' ? 'server too slow' : (err.message || 'error'));
          // fall through to Edge below, under Edge's own cache key
        }
      }

      // 2. Edge through the BYoB server: the one that is always there.
      const edgeKey = this.cacheKeyFor(text, voiceId, pVal, 'edge');
      if (this.blobCache.has(edgeKey)) {
        this.pendingFetches.delete(cacheKey);
        this.engineActive = 'edge';
        return this.blobCache.get(edgeKey);
      }
      const pitchParam = this.getPitchParam(pVal);
      const url = `/api/tts/speak?text=${encodeURIComponent(cleanSpeechText)}&voice=${encodeURIComponent(voiceId)}&rate=${encodeURIComponent('+0%')}&pitch=${encodeURIComponent(pitchParam)}`;

      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) {
            throw new Error(`Speech synthesis returned status ${res.status}`);
          }
          const blob = await res.blob();
          const blobUrl = await storeBlob(blob, edgeKey);
          if (edgeKey !== cacheKey) this.blobCache.set(cacheKey, blobUrl);
          this.pendingFetches.delete(cacheKey);
          this.engineActive = 'edge';
          this.updateEngineUI();
          return blobUrl;
        } catch (err) {
          clearTimeout(timer);
          if (attempt === retries) {
            this.pendingFetches.delete(cacheKey);
            throw err;
          }
          await new Promise(r => setTimeout(r, 400));
        }
      }
    })();

    this.pendingFetches.set(cacheKey, fetchPromise);
    return await fetchPromise;
  },

  async testVoice() {
    const select = document.getElementById('ttsVoiceSelect');
    const voiceId = select ? select.value : this.selectedVoice;
    const testBtn = document.getElementById('testVoiceBtn');
    const originalText = testBtn ? testBtn.textContent : 'Test Voice';
    
    if (testBtn) testBtn.textContent = 'Loading...';
    const testSentence = "Welcome to BYoB. This is how I sound reading your books.";

    try {
      this.testAudioElement.pause();
      const blobUrl = await this.getAudioBlobUrl(testSentence, voiceId, 1.0, this.pitch);
      this.testAudioElement.src = blobUrl;
      this.testAudioElement.playbackRate = this.rate || 1.0;
      await this.testAudioElement.play();
    } catch (err) {
      console.error('Test voice error:', err);
      alert('Could not play voice audio: ' + err.message);
    } finally {
      if (testBtn) testBtn.textContent = originalText;
    }
  },

  setRate(val) {
    const newRate = parseFloat(val);
    if (isNaN(newRate) || newRate <= 0) return;
    this.rate = Math.round(newRate * 100) / 100;

    try {
      localStorage.setItem('byob_tts_rate', String(this.rate));
      localStorage.setItem('kuroyomi_tts_rate', String(this.rate));
    } catch (e) {}

    if (window.ReaderSettings) {
      window.ReaderSettings.tts_rate = this.rate;
      if (typeof Storage !== 'undefined' && typeof Storage.setLocalSettings === 'function') {
        Storage.setLocalSettings(window.ReaderSettings);
      }
      if (window.SyncService && typeof window.SyncService.syncSettings === 'function') {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    }

    this.syncRateUI();
    this.updateAudioUI();

    // Immediately enforce playbackRate on active element
    if (this.audioElement) {
      try {
        this.audioElement.playbackRate = this.rate;
        this.audioElement.defaultPlaybackRate = this.rate;
      } catch (e) {}
    }

    if (this.isPlaying && !this.isPaused && this.isUsingDeviceVoice) {
      this.speakParagraph(this.currentIndex);
    }
  },

  // Reading progress is stored as the paragraph's data-pid (what the reader scrolls back to), not its position in
  // this.paragraphs: the chapter title heading is injected at index 0 without a data-pid, shifting every index by one.
  getParagraphPid(index) {
    const el = this.paragraphs && this.paragraphs[index];
    const pid = el ? parseInt(el.getAttribute('data-pid'), 10) : NaN;
    return isNaN(pid) ? 0 : pid;
  },

  refreshParagraphs() {
    const container = document.getElementById('readerContent');
    if (!container) return;
    this.paragraphs = Array.from(container.querySelectorAll('.reader-paragraph, .reader-heading'));
  },

  startKeepAlive() {
    // KeepAlive is integrated directly with the primary audio stream to prevent OS lockscreen/car control conflicts
  },

  stopKeepAlive() {
    // Clean-up handled by stopping primary audio stream
  },

  start(fromIndex = null) {
    this.refreshParagraphs();
    if (!this.paragraphs.length) return;

    if (window.App && typeof window.App.cancelPendingSleepResume === 'function') {
      window.App.cancelPendingSleepResume();
    } else {
      try {
        localStorage.removeItem('byob_pending_sleep_resume');
        localStorage.removeItem('kuroyomi_pending_sleep_resume');
      } catch (e) {}
    }
    this.sleepModeExpired = false;

    // Always prioritize the main voice selected
    this.setDeviceVoiceMode(false);
    this.startKeepAlive();
    if (this.sleepMode !== 'off' && !this.sleepStartSnapshot) {
      this.recordSleepStartSnapshot();
    }

    if (fromIndex === null || fromIndex === undefined) {
      if (window.Reader && typeof window.Reader.getVisibleParagraphIndex === 'function') {
        fromIndex = window.Reader.getVisibleParagraphIndex();
      } else {
        fromIndex = 0;
      }
    }

    this.currentIndex = Math.max(0, Math.min(fromIndex, this.paragraphs.length - 1));
    this.isPlaying = true;
    this.isPaused = false;
    this._resumeAtChapterEnd = false;
    this.logEvent(`start at paragraph ${this.currentIndex}`);
    this.startWatchdog();
    this.showBadge();

    // Auto-open full-screen audiobook mode when read aloud is started on phone
    const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth <= 1024);
    if (isMobile) {
      if (window.App && typeof window.App.closeMasterPanel === 'function') {
        window.App.closeMasterPanel();
      }
      this.openAudiobookModal();
    }

    this.updateAudioUI();
    this.speakParagraph(this.currentIndex);
  },

  setDeviceVoiceMode(enabled) {
    if (this.isUsingDeviceVoice === enabled) return;
    this.isUsingDeviceVoice = enabled;

    const offlineStatusEl = document.getElementById('audiobookOfflineStatus');
    if (offlineStatusEl) {
      offlineStatusEl.style.display = enabled ? 'inline-flex' : 'none';
      if (enabled) {
        offlineStatusEl.textContent = navigator.onLine ? 'Cloud voice unavailable: Device Voice' : 'Offline: Device Voice';
      }
    }

    if (enabled) {
      if (window.App && typeof window.App.showToast === 'function') {
        const curVoiceObj = this.voices.find(v => v.id === this.selectedVoice);
        const name = curVoiceObj ? curVoiceObj.name : 'Cloud Voice';
        window.App.showToast(navigator.onLine
          ? `${name} is unavailable right now, using Device Voice`
          : `Offline: Switched from ${name} to Device Voice`);
      }
    } else {
      if (window.App && typeof window.App.showToast === 'function') {
        const curVoiceObj = this.voices.find(v => v.id === this.selectedVoice);
        const name = curVoiceObj ? curVoiceObj.name : 'Cloud Voice';
        window.App.showToast(`Online: Resumed Cloud Voice (${name})`);
      }
    }
  },

  speakWithDeviceVoice(text, index) {
    if (!('speechSynthesis' in window)) {
      console.warn('SpeechSynthesis not supported on this device.');
      setTimeout(() => this.speakParagraph(index + 1), 1000);
      return;
    }

    window.speechSynthesis.cancel();
    const sessionId = this.playbackSessionId;

    // Clean brackets, evolution arrows, double colons, and stat fractions for smooth device voice pronunciation
    // Uses normalizeForSpeech to preserve words like <<Example>> or <Herald> without deleting them
    const cleanDeviceText = this.normalizeForSpeech(text);

    const utterance = new SpeechSynthesisUtterance(cleanDeviceText);
    utterance.rate = Math.min(2.0, Math.max(0.5, this.rate));
    utterance.pitch = Math.max(0.5, Math.min(1.5, 1.0 + (this.pitch / 40.0)));
    // English, always. Without this the system picks a language from the text and reads invented
    // names and places with a French (or German, or Spanish) accent.
    utterance.lang = 'en-US';

    // Choose best English system voice (e.g. Siri, Samantha, Daniel, etc.)
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      const enUS = voices.filter(v => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith('en-us'));
      const anyEn = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
      const pool = enUS.length ? enUS : anyEn;
      const best = pool.find(v => (
        v.name.includes('Siri') || v.name.includes('Daniel') || v.name.includes('Samantha') || v.name.includes('Karen') || v.name.includes('Google')
      )) || pool[0] || voices[0];
      if (best) {
        utterance.voice = best;
        if (best.lang) utterance.lang = best.lang;
      }
    }

    utterance.onboundary = (event) => {
      if (event.name === 'word' || event.charIndex !== undefined) {
        const charIdx = event.charIndex;
        if (this.currentWordList && this.currentWordList.length > 0) {
          let activeIdx = 0;
          for (let i = 0; i < this.currentWordList.length; i++) {
            if (this.currentWordList[i].start <= charIdx) {
              activeIdx = i;
            } else {
              break;
            }
          }
          this.highlightWordAtIndex(activeIdx);
        }
      }
    };

    utterance.onend = () => {
      if (this.playbackSessionId === sessionId && this.isPlaying && !this.isPaused) {
        this.speakParagraph(index + 1);
      }
    };

    utterance.onerror = (e) => {
      console.warn('Device speech synthesis error:', e);
      if (this.playbackSessionId === sessionId && this.isPlaying && !this.isPaused) {
        setTimeout(() => {
          if (this.playbackSessionId === sessionId && this.isPlaying && !this.isPaused) {
            this.speakParagraph(index + 1);
          }
        }, 600);
      }
    };

    this.deviceUtterance = utterance;
    window.speechSynthesis.speak(utterance);
    this.updateAudioUI();
  },

  pause() {
    clearTimeout(this._interruptTimer);
    if (this.isPlaying) {
      this.isPaused = true;
      this.audioElement.pause();
      if ('speechSynthesis' in window) {
        if (this.deviceUtterance) {
          this.deviceUtterance.onend = null;
          this.deviceUtterance.onerror = null;
        }
        window.speechSynthesis.cancel();
      }
      this.updateAudioUI();
    }
  },

  resume() {
    if (window.App && typeof window.App.cancelPendingSleepResume === 'function') {
      window.App.cancelPendingSleepResume();
    } else {
      try {
        localStorage.removeItem('byob_pending_sleep_resume');
        localStorage.removeItem('kuroyomi_pending_sleep_resume');
      } catch (e) {}
    }
    this.sleepModeExpired = false;

    if (this.isPlaying && this.isPaused) {
      this.isPaused = false;
      this._lastProgressAt = Date.now();
      if (this._resumeAtChapterEnd) {
        this._resumeAtChapterEnd = false;
        this.speakParagraph(this.paragraphs.length);
        this.updateAudioUI();
        return;
      }
      if (this._advancing) {
        // The next chapter is still loading; advanceToNextChapter starts it as soon as it lands
        this.holdAudioSession();
        this.updateAudioUI();
        return;
      }
      if (this.isUsingDeviceVoice) {
        // Attempt recovery to selected cloud voice on resume
        this.setDeviceVoiceMode(false);
        this.speakParagraph(this.currentIndex);
      } else if (this.audioElement && !this.audioElement.loop && this.audioElement.src && this.audioElement.src !== window.location.href) {
        this.audioElement.play().catch(() => this.speakParagraph(this.currentIndex));
      } else {
        this.speakParagraph(this.currentIndex);
      }
      this.updateAudioUI();
    } else {
      this.start(this.currentIndex);
    }
  },

  toggle() {
    if (this.isPlaying && !this.isPaused) {
      this.pause();
    } else if (this.isPlaying && this.isPaused) {
      this.resume();
    } else {
      this.start();
    }
  },

  stop() {
    if (window.__reloadWhenIdle) {
      window.__reloadWhenIdle = false;
      setTimeout(() => window.location.reload(), 400);
    }
    clearTimeout(this._interruptTimer);
    this.stopWatchdog();
    this._advanceGen++;
    this._advancing = false;
    this._resumeAtChapterEnd = false;
    this.playbackSessionId = (this.playbackSessionId || 0) + 1;
    this.isPlaying = false;
    this.isPaused = false;
    this.isLoading = false;
    this.stopKeepAlive();
    this.audioElement.pause();
    this.audioElement.loop = false;
    this.audioElement.src = '';
    this.setChain(null);
    this.preloadedIndex = -1;
    this.preloadedBlobUrl = null;
    this.isTransitioning = false;
    if ('speechSynthesis' in window) {
      if (this.deviceUtterance) {
        this.deviceUtterance.onend = null;
        this.deviceUtterance.onerror = null;
      }
      window.speechSynthesis.cancel();
    }
    this.deviceUtterance = null;
    this.setDeviceVoiceMode(false);
    this.clearHighlight();
    this.clearWordHighlights();
    this.hideBadge();
    this.closeAudiobookModal();
    this.updateAudioUI();
  },

  clearHighlight() {
    document.querySelectorAll('.reader-paragraph.speaking-active, .reader-heading.speaking-active')
      .forEach(el => el.classList.remove('speaking-active'));
    this.clearWordHighlights();
  },

  clearWordHighlights() {
    this.activeWordIndex = -1;
    document.querySelectorAll('.tts-word-active, .tts-word-spoken').forEach(el => {
      el.classList.remove('tts-word-active', 'tts-word-spoken');
    });
  },

  jumpToParagraph(index, autoPlay = null) {
    this.refreshParagraphs();
    if (!this.paragraphs || !this.paragraphs.length) return;
    const clampedIndex = Math.max(0, Math.min(index, this.paragraphs.length - 1));

    const shouldPlay = (autoPlay !== null) ? autoPlay : (this.isPlaying && !this.isPaused);

    const chain = this.activeChain();
    const part = chain && !this.audioElement.ended ? chain.parts.find(p => p.index === clampedIndex) : null;
    if (shouldPlay && part && this.isPlaying && !this.isUsingDeviceVoice) {
      // Already inside the joined stream: seek, keep the same track (fast and safe from the car or lock screen)
      this.isPaused = false;
      try { this.audioElement.currentTime = part.start + 0.01; } catch (e) {}
      this.enterChainParagraph(clampedIndex);
      if (this.audioElement.paused) {
        const p = this.audioElement.play();
        if (p && p.catch) p.catch(() => this.speakParagraph(clampedIndex));
      }
      return;
    }
    if (shouldPlay) {
      this.isPlaying = true;
      this.isPaused = false;
      this.speakParagraph(clampedIndex);
    } else {
      // Paused state: jump visual selection, update modal & save reading progress without unpausing
      this.playbackSessionId = (this.playbackSessionId || 0) + 1;
      this.currentIndex = clampedIndex;
      this.audioElement.pause();
      if ('speechSynthesis' in window) {
        if (this.deviceUtterance) {
          this.deviceUtterance.onend = null;
          this.deviceUtterance.onerror = null;
        }
        window.speechSynthesis.cancel();
      }

      this.clearHighlight();
      const el = this.paragraphs[clampedIndex];
      if (el) {
        el.classList.add('speaking-active');
        if (!document.hidden && el.scrollIntoView) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      if (window.Reader) {
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const scrollPct = docHeight > 0 ? Math.round((window.scrollY / docHeight) * 100) : 0;
        window.Reader.saveCurrentProgress(this.getParagraphPid(clampedIndex), scrollPct, clampedIndex === 0);
      }

      this.updateAudiobookModalContent();
      this.updateAudioUI();
      this.updateMediaSessionMetadata();

      // Pre-cache paragraph audio quietly in background so resuming is instant
      if (el) {
        const textToSpeak = el.innerText.trim();
        if (textToSpeak && navigator.onLine) {
          this.getAudioBlobUrl(textToSpeak, this.selectedVoice, 1.0, this.pitch)
            .then(blobUrl => {
              if (this.currentIndex === clampedIndex && this.isPaused) {
                this.audioElement.src = blobUrl;
                this.audioElement.playbackRate = this.rate || 1.0;
              }
            })
            .catch(() => {});
        }
      }
    }
  },

  async speakParagraph(index) {
    if (!this.isPlaying || this.isPaused) return;

    this.playbackSessionId = (this.playbackSessionId || 0) + 1;
    const sessionId = this.playbackSessionId;

    // No pause() here: swapping src on the same element keeps the phone's audio session (and lock-screen controls)
    // alive, whereas pausing between paragraphs lets the OS drop the session and refuse the next play() in the
    // background. Every branch below either assigns a new src, holds the silent loop, or releases the session.
    this._ignorePauseUntil = Date.now() + 500;
    this.audioElement.loop = false;

    this.isTransitioning = false;
    if ('speechSynthesis' in window) {
      if (this.deviceUtterance) {
        this.deviceUtterance.onend = null;
        this.deviceUtterance.onerror = null;
      }
      const synth = window.speechSynthesis;
      if (this.deviceUtterance || this.isUsingDeviceVoice || synth.speaking || synth.pending) {
        synth.cancel();
      }
    }
    this.deviceUtterance = null;

    // 2. Seamless transition to next chapter if current chapter ended
    if (index >= this.paragraphs.length) {
      this.clearHighlight();
      if (this.sleepMode === 'chapter_end') {
        // One-shot: it fired, so it must not also stop every later chapter
        this.sleepMode = 'off';
        this.updateSleepBadge();
        this.updateSleepModalUI();
        this.logEvent('sleep timer (end of chapter) stopped playback');
        this.stop();
        return;
      }
      this.logEvent(`chapter end -> loading next (${window.Reader && window.Reader.currentChapter ? window.Reader.currentChapter.title : '?'})`);
      // When the next chapter's text and first audio are already preloaded, start that audio right here, in the same
      // task as the 'ended' event, exactly like a paragraph-to-paragraph hand-off (which phones allow in the
      // background). Only fall back to the silent loop plus a wait when it is not ready.
      this._handoffUrl = this.startNextChapterAudioNow();
      if (!this._handoffUrl) this.holdAudioSession();
      await this.advanceToNextChapter();
      return;
    }

    this.currentIndex = index;
    this._lastProgressAt = Date.now();
    const el = this.paragraphs[index];
    if (!el) return;

    const textToSpeak = el.innerText.trim();
    if (!textToSpeak) {
      this.speakParagraph(index + 1);
      return;
    }

    // Cached audio goes first, ahead of every DOM update below. That work costs 100ms+ on a phone and used to sit
    // between one paragraph ending and the next starting.
    const cleanSpeech = this.normalizeForSpeech(textToSpeak);
    const cacheKey = `${this.selectedVoice}_1.0_${this.pitch}_${cleanSpeech}`;
    const isCached = this.blobCache.has(cacheKey);
    let started = null;
    if (isCached && navigator.onLine) {
      try {
        const cachedUrl = this.blobCache.get(cacheKey);
        if (this._handoffUrl && this._handoffUrl === cachedUrl && this.audioElement.src === cachedUrl && !this.audioElement.paused && !this.audioElement.ended) {
          // Already playing this paragraph from the chapter hand-off: let it carry on instead of restarting it
          started = Promise.resolve();
        } else {
          const chain = this.buildChain(index);
          this.setChain(chain);
          this.audioElement.src = chain ? chain.url : cachedUrl;
          this.audioElement.playbackRate = this.rate || 1.0;
          started = this.audioElement.play();
          started.catch(() => {});
          if (chain) this.logEvent(`stream: paragraphs ${chain.parts[0].index}-${chain.parts[chain.parts.length - 1].index} joined (${Math.round(chain.parts[chain.parts.length - 1].end)}s)`);
        }
      } catch (e) {
        started = null;
      }
    }
    this._handoffUrl = null;

    // Visual highlight on reader text
    this.clearHighlight();
    el.classList.add('speaking-active');
    if (!document.hidden && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Silently save progress with accurate scroll percentage
    if (window.Reader) {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = docHeight > 0 ? Math.round((window.scrollY / docHeight) * 100) : 0;
      window.Reader.saveCurrentProgress(this.getParagraphPid(index), scrollPct, index === 0);
    }

    // Only set loading state true if uncached fetch is needed
    this.isLoading = !isCached;
    this.updateAudioUI();
    this.updateMediaSessionMetadata();

    if (!isCached && navigator.onLine) {
      this.holdAudioSession();
      this.showAudiobookLoading();
    } else {
      this.updateAudiobookModalContent();
    }

    // If device is offline
    if (!navigator.onLine) {
      this.releaseAudioSession();
      this.isLoading = false;
      this.setDeviceVoiceMode(true);
      this.updateAudiobookModalContent();
      this.speakWithDeviceVoice(textToSpeak, index);
      return;
    }

    // ALWAYS prioritize the main voice selected (realistic cloud neural TTS)
    try {
      if (!started) {
        const blobUrl = await this.getAudioBlobUrl(textToSpeak, this.selectedVoice, 1.0, this.pitch);

        if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;

        this.audioElement.loop = false;
        this.audioElement.src = blobUrl;
        this.audioElement.playbackRate = this.rate || 1.0;

        // If user skipped or paused while fetching was in flight, discard cleanly
        if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;

        this.isLoading = false;

        // Cloud synthesis succeeded! Restore main cloud voice immediately
        if (this.isUsingDeviceVoice) {
          this.setDeviceVoiceMode(false);
        }

        // Immediately dismiss loading voice screen and render active paragraph words
        this.updateAudiobookModalContent();

        started = this.audioElement.play();
      } else if (this.isUsingDeviceVoice) {
        this.setDeviceVoiceMode(false);
      }

      await started;
      if (this.playbackSessionId !== sessionId) return;
      try {
        this.audioElement.playbackRate = this.rate || 1.0;
        this.audioElement.defaultPlaybackRate = this.rate || 1.0;
      } catch (e) {}
      this.updateAudioUI();

      // Proactively prefetch the next paragraphs so the next stream can join several of them
      this.prefetchAhead(index, 8);

      // Near the end of the chapter, get the next one (text and first audio) ready before it is needed
      if (index >= this.paragraphs.length - 8) {
        this.preloadNextChapter();
      }
    } catch (err) {
      this.isLoading = false;
      this.updateAudioUI();
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;
      if (err && err.name === 'NotAllowedError' && await this.retryPlay(sessionId)) {
        this.updateAudioUI();
        this.prefetchAhead(index, 6);
        return;
      }
      if (err && err.name === 'NotAllowedError') {
        // The browser refused to start audio without a tap (typically after a long wait in the background). Device
        // speech would be refused too, so wait for the play button instead of silently falling through.
        this.pauseWithReason('The browser blocked audio from starting on its own.');
        return;
      }
      this.logEvent(`cloud voice failed (${err && err.name ? err.name : 'error'}), using device voice for paragraph ${index}`);
      console.warn('Cloud TTS synthesis failed, using device voice fallback for this paragraph:', err);
      this.releaseAudioSession();
      this.setDeviceVoiceMode(true);
      this.updateAudiobookModalContent();
      this.speakWithDeviceVoice(textToSpeak, index);
    }
  },

  // Seconds of audio a paragraph lasts at 1.0x: the real length when its audio is here, else a guess from its text
  estimateParagraphSeconds(text, cacheKey) {
    const info = cacheKey ? this.audioBytes.get(cacheKey) : null;
    if (info && info.duration) return info.duration;
    return Math.max(1, text.length / this.BUFFER_CHARS_PER_SECOND);
  },

  // Fetches ahead until about BUFFER_AHEAD_SECONDS of listening is ready past `fromIndex` (at the current speed,
  // so 2x needs twice the audio), at most BUFFER_MAX_PARAGRAPHS, nearest first. `count` is a minimum paragraph
  // look-ahead kept for the callers.
  async prefetchAhead(fromIndex, count = 6) {
    if (!this.paragraphs || this.paragraphs.length === 0) return;
    const currentVoice = this.selectedVoice;
    const currentPitch = this.pitch;
    const sessionId = this.playbackSessionId;

    const speed = Math.max(1, parseFloat(this.rate) || 1);
    const targetAudioSeconds = this.BUFFER_AHEAD_SECONDS * speed;
    const needed = [];
    let bufferedSeconds = 0;
    let reachedChapterEnd = false;
    for (let offset = 1; offset <= this.BUFFER_MAX_PARAGRAPHS; offset++) {
      const idx = fromIndex + offset;
      if (idx >= this.paragraphs.length) { reachedChapterEnd = true; break; }
      if (offset > count && bufferedSeconds >= targetAudioSeconds) break;
      const el = this.paragraphs[idx];
      const text = el ? el.innerText.trim() : '';
      if (!text) continue;
      const cacheKey = this.cacheKeyFor(text, currentVoice, currentPitch);
      bufferedSeconds += this.estimateParagraphSeconds(text, cacheKey);
      if (!this.blobCache.has(cacheKey) && !this.pendingFetches.has(cacheKey)) needed.push(text);
    }
    // Give the PC a longer run-up than the app downloads, so it is always rendering ahead of the
    // drive. Costs one small request and nothing when the PC is not there.
    if (this.kokoroUsable()) {
      const ahead = [];
      for (let offset = 1; offset <= Math.max(count, 24, needed.length); offset++) {
        const el = this.paragraphs[fromIndex + offset];
        const t = el ? el.innerText.trim() : '';
        if (t) ahead.push(t);
      }
      this.kokoroPrefetch(ahead);
    }

    // Synthesis is slower than playback at higher speeds, so one request at a time lets the buffer run dry and
    // playback stalls between paragraphs. Keep three in flight, nearest paragraph first.
    let next = 0;
    const worker = async () => {
      while (next < needed.length) {
        if (!this.isPlaying || this.isPaused || this.playbackSessionId !== sessionId) return;
        // Look-ahead calls overlap (one per paragraph), so the cap is shared across all of them
        while (this._prefetchActive >= 3) {
          await new Promise(r => setTimeout(r, 60));
          if (!this.isPlaying || this.isPaused || this.playbackSessionId !== sessionId) return;
        }
        const text = needed[next++];
        this._prefetchActive++;
        try {
          await this.getAudioBlobUrl(text, currentVoice, 1.0, currentPitch);
        } catch (e) {
        } finally {
          this._prefetchActive--;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    // The buffer window ran into the end of the chapter: get the next chapter's text and first audio ready too
    if (reachedChapterEnd || fromIndex >= this.paragraphs.length - 2) {
      this.preloadNextChapter();
    }
  },

  // Loads the next chapter's text into the reader cache and synthesizes its first lines, once per chapter
  async preloadNextChapter() {
    const reader = window.Reader;
    const current = reader && reader.currentChapter;
    if (!current || !current.next_chapter || !navigator.onLine) return;
    const nextId = current.next_chapter.id;
    if (this._preloadedChapterId === nextId) return;
    this._preloadedChapterId = nextId;

    const voice = this.selectedVoice;
    const pitch = this.pitch;
    try {
      const nextCh = await reader.preloadChapter(nextId);
      if (!nextCh) throw new Error('next chapter unavailable');
      for (const text of reader.getSpeakableTexts(nextCh, 3)) {
        if (!this.isPlaying) break;
        await this.getAudioBlobUrl(text, voice, 1.0, pitch);
      }
    } catch (e) {
      // Allow a later paragraph to try again
      this._preloadedChapterId = null;
    }
  },

  prefetchNext(nextIndex) {
    return this.prefetchAhead(nextIndex - 1, 5);
  },

  handoffToSecondary() {
    // Retained for backward compatibility
  },

  swapAudioBuffers() {
    // Retained for backward compatibility with older extensions and tests
  },

  prepareNextParagraph(nextIndex) {
    // Retained for backward compatibility
  },

  playKeepAliveSilence() {
    this.startKeepAlive();
  },

  async advanceToNextChapter(autoPlay = null) {
    const reader = window.Reader;
    if (!reader || !reader.currentChapter || !reader.currentChapter.next_chapter) {
      this.logEvent('end of book (no next chapter)');
      this.stop();
      if (window.App && typeof window.App.showToast === 'function') window.App.showToast('End of the book.');
      return;
    }
    // The audio 'ended' and 'pause' events can both reach the chapter end; only one advance may run or a chapter gets skipped
    if (this._advancing) return;
    this._advancing = true;
    const gen = ++this._advanceGen;
    // False once the watchdog (or stop) has abandoned this attempt: whatever it was waiting on no longer matters
    const current = () => gen === this._advanceGen;

    try {
      const wasModalOpen = document.getElementById('audiobookFullModal')?.style.display === 'flex';
      const nextId = reader.currentChapter.next_chapter.id;
      const sessionId = this.playbackSessionId;

      this.clearHighlight();
      this.clearWordHighlights();

      // A dead zone or a sleeping server must not end the session: keep the silent loop going and keep trying
      let loaded = null;
      let lastReason = '';
      for (let attempt = 0; attempt < 8 && !loaded; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1500 * attempt, 8000)));
        if (!current() || this.playbackSessionId !== sessionId) return;
        loaded = await reader.withTimeout(reader.loadChapter(nextId, false, true), 30000, null);
        if (!current() || this.playbackSessionId !== sessionId) return;
        if (!loaded) {
          lastReason = navigator.onLine ? 'the chapter did not load' : 'no connection';
          this.logEvent(`next chapter load failed (attempt ${attempt + 1}): ${lastReason}`);
        }
      }
      if (!loaded) {
        this.pauseWithReason(`Couldn't load the next chapter (${lastReason}).`, true);
        return;
      }

      this.refreshParagraphs();
      if (this.paragraphs.length > 0) {
        if (wasModalOpen) {
          this.openAudiobookModal();
        }
        // Decide at the moment of the jump, so pausing while the chapter loaded is respected
        const shouldPlay = (autoPlay !== null) ? autoPlay : (this.isPlaying && !this.isPaused);
        this.logEvent(`next chapter ready (${loaded.title}), ${this.paragraphs.length} paragraphs, play=${shouldPlay}`);
        this.jumpToParagraph(0, shouldPlay);
      } else {
        this.stopWithReason('the next chapter has no text.');
      }
    } finally {
      if (gen === this._advanceGen) this._advancing = false;
    }
  },

  nextParagraph() {
    if (this.currentIndex < this.paragraphs.length - 1) {
      this.jumpToParagraph(this.currentIndex + 1);
    } else {
      this.advanceToNextChapter();
    }
  },

  prevParagraph() {
    if (this.currentIndex > 0) {
      this.jumpToParagraph(this.currentIndex - 1);
    } else if (this.isPlaying && window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.prev_chapter) {
      this.prevChapter();
    } else {
      this.jumpToParagraph(0);
    }
  },

  // Car steering-wheel and lock-screen skip buttons. Head units sometimes send one press twice; ignore repeats
  // that arrive within 200 ms.
  carSkip(direction) {
    const now = Date.now();
    if (now - this._lastSkipAt < 200) return;
    this._lastSkipAt = now;
    this.logEvent(`car/lock-screen ${direction > 0 ? 'next' : 'previous'} paragraph`);
    if (!this.isPlaying) {
      this.start(Math.max(0, this.currentIndex + direction));
      return;
    }
    if (direction > 0) this.nextParagraph(); else this.prevParagraph();
  },

  async nextChapter() {
    if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.next_chapter) {
      const wasModalOpen = document.getElementById('audiobookFullModal')?.style.display === 'flex';
      const nextId = window.Reader.currentChapter.next_chapter.id;
      this.clearHighlight();
      this.clearWordHighlights();
      this.playKeepAliveSilence();
      await window.Reader.loadChapter(nextId, false, true);
      this.refreshParagraphs();
      this.start(0);
      if (wasModalOpen) {
        this.openAudiobookModal();
      }
    }
  },

  async prevChapter() {
    if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.prev_chapter) {
      const wasModalOpen = document.getElementById('audiobookFullModal')?.style.display === 'flex';
      const prevId = window.Reader.currentChapter.prev_chapter.id;
      this.clearHighlight();
      this.clearWordHighlights();
      this.playKeepAliveSilence();
      await window.Reader.loadChapter(prevId, false, true, true);
      this.refreshParagraphs();
      this.start(0);
      if (wasModalOpen) {
        this.openAudiobookModal();
      }
    }
  },

  // === Sleep Timer ===
  recordSleepStartSnapshot() {
    if (this.sleepStartSnapshot) return;
    const novel = window.Reader ? window.Reader.currentNovel : null;
    const chapter = window.Reader ? window.Reader.currentChapter : null;
    this.sleepStartSnapshot = {
      novel_id: novel ? novel.id : null,
      novel_title: novel ? novel.title : 'Novel',
      chapter_id: chapter ? chapter.id : null,
      chapter_title: chapter ? chapter.title : 'Chapter',
      paragraph_index: this.getParagraphPid(this.currentIndex || 0),
      scroll_percent: window.Reader ? Math.round((window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) * 100) : 0,
      timestamp: Date.now()
    };
  },

  setSleepTimer(minutesOrMode) {
    if (this.sleepTimerInterval) clearInterval(this.sleepTimerInterval);

    if (minutesOrMode === 'off' || minutesOrMode === 0) {
      this.sleepMode = 'off';
      this.sleepTimerDuration = 0;
      this.sleepTimerRemaining = 0;
      this.sleepStartSnapshot = null;
      this.updateSleepBadge();
      this.updateSleepModalUI();
      return;
    }

    this.recordSleepStartSnapshot();

    if (minutesOrMode === 'chapter_end') {
      this.sleepMode = 'chapter_end';
      this.updateSleepBadge('End of Chapter');
      this.updateSleepModalUI();
      if (window.App && typeof window.App.showToast === 'function') {
        window.App.showToast('Sleep timer: End of Chapter');
      }
      return;
    }

    const minutes = parseInt(minutesOrMode);
    this.sleepMode = 'time';
    this.sleepTimerDuration = minutes * 60;
    this.sleepTimerRemaining = this.sleepTimerDuration;
    this.updateSleepBadge();
    this.updateSleepModalUI();

    if (window.App && typeof window.App.showToast === 'function') {
      window.App.showToast(`Sleep timer set for ${minutes} minutes`);
    }

    this.sleepTimerInterval = setInterval(() => {
      this.sleepTimerRemaining--;
      if (this.sleepTimerRemaining <= 0) {
        clearInterval(this.sleepTimerInterval);
        this.triggerSleepTimeout();
      } else {
        this.updateSleepBadge();
        this.updateSleepModalUI();
      }
    }, 1000);
  },

  addSleepTimerMinutes(minutes) {
    if (this.sleepMode === 'off' || this.sleepMode === 'chapter_end') {
      this.setSleepTimer(minutes);
      return;
    }
    this.sleepTimerRemaining += minutes * 60;
    this.sleepTimerDuration += minutes * 60;
    this.updateSleepBadge();
    this.updateSleepModalUI();
    if (window.App && typeof window.App.showToast === 'function') {
      window.App.showToast(`Added ${minutes} min to sleep timer`);
    }
  },

  triggerSleepTimeout() {
    this.sleepMode = 'off';
    this.updateSleepBadge();
    this.updateSleepModalUI();
    this.stop();
    if (AutoScroll.isActive) AutoScroll.stop();

    this.sleepModeExpired = true;
    this.sleepExpiredAt = Date.now();

    if (window.Reader) {
      window.Reader.saveCurrentProgress();
    }

    // Save sleep session completion record for resume prompt
    try {
      const novel = window.Reader ? window.Reader.currentNovel : null;
      const chapter = window.Reader ? window.Reader.currentChapter : null;
      const resumeRecord = {
        novel_id: novel ? novel.id : (this.sleepStartSnapshot ? this.sleepStartSnapshot.novel_id : null),
        novel_title: novel ? novel.title : (this.sleepStartSnapshot ? this.sleepStartSnapshot.novel_title : 'Novel'),
        start: this.sleepStartSnapshot || null,
        finish: {
          chapter_id: chapter ? chapter.id : null,
          chapter_title: chapter ? chapter.title : 'Chapter',
          paragraph_index: this.getParagraphPid(this.currentIndex),
          scroll_percent: window.Reader ? Math.round((window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) * 100) : 0
        },
        timestamp: Date.now()
      };
      localStorage.setItem('byob_pending_sleep_resume', JSON.stringify(resumeRecord));
      localStorage.setItem('kuroyomi_pending_sleep_resume', JSON.stringify(resumeRecord));
    } catch (e) {
      console.warn('Could not save sleep resume record:', e);
    }
    this.sleepStartSnapshot = null;
  },

  openSleepModal() {
    const modal = document.getElementById('audiobookSleepModal');
    const backdrop = document.getElementById('audiobookSleepBackdrop');
    if (modal && backdrop) {
      modal.style.display = 'block';
      backdrop.style.display = 'block';
      this.updatePitchUI();
      const cogVoice = document.getElementById('audiobookCogVoiceSelect');
      if (cogVoice && cogVoice.value !== this.selectedVoice) {
        cogVoice.value = this.selectedVoice;
      }
      this.updateSleepModalUI();
    }
  },

  closeSleepModal() {
    const modal = document.getElementById('audiobookSleepModal');
    const backdrop = document.getElementById('audiobookSleepBackdrop');
    if (modal && backdrop) {
      modal.style.display = 'none';
      backdrop.style.display = 'none';
    }
  },

  updateSleepModalUI() {
    const activeStatus = document.getElementById('audiobookSleepActiveStatus');
    const digits = document.getElementById('audiobookSleepDigits');
    if (!activeStatus) return;

    if (this.sleepMode === 'time' && this.sleepTimerRemaining > 0) {
      activeStatus.style.display = 'flex';
      const m = Math.floor(this.sleepTimerRemaining / 60);
      const s = this.sleepTimerRemaining % 60;
      if (digits) digits.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    } else if (this.sleepMode === 'chapter_end') {
      activeStatus.style.display = 'flex';
      if (digits) digits.textContent = 'End of Chapter';
    } else {
      activeStatus.style.display = 'none';
    }
  },

  updateSleepBadge(customText) {
    const badges = document.querySelectorAll('.sleep-timer-badge, #audiobookModalSleepBadge');
    badges.forEach(b => {
      if (this.sleepMode === 'off') {
        b.style.display = 'none';
      } else if (this.sleepMode === 'chapter_end') {
        b.style.display = 'inline-flex';
        b.textContent = 'End of Ch';
      } else {
        b.style.display = 'inline-flex';
        const m = Math.floor(this.sleepTimerRemaining / 60);
        const s = this.sleepTimerRemaining % 60;
        b.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
    });
  },

  showBadge() {
    const badge = document.getElementById('ttsMiniBadge');
    if (badge) {
      badge.style.display = 'flex';
      this.applySavedCornerPosition();
      this.updateCoverDisplays();
      this.updateAudioUI();
    }
  },

  hideBadge() {
    const badge = document.getElementById('ttsMiniBadge');
    if (badge) badge.style.display = 'none';
  },

  showPill() {
    this.showBadge();
  },

  hidePill() {
    this.hideBadge();
  },

  updatePillUI() {
    this.updateAudioUI();
  },

  showAudiobookLoading() {
    const titleEl = document.getElementById('audiobookHeaderTitle');
    const chEl = document.getElementById('audiobookHeaderChapter');
    const spokenEl = document.getElementById('audiobookSpokenText');
    const badgeEl = document.getElementById('audiobookParaBadge');

    if (window.Reader && window.Reader.currentNovel) {
      if (titleEl) titleEl.textContent = window.Reader.currentNovel.title || 'BYoB Audiobook';
    }
    if (window.Reader && window.Reader.currentChapter) {
      if (chEl) chEl.textContent = window.Reader.currentChapter.title || 'Chapter';
    }
    if (this.paragraphs && this.paragraphs.length > 0) {
      const pct = Math.round(((this.currentIndex + 1) / this.paragraphs.length) * 100);
      if (badgeEl) badgeEl.textContent = `${pct}%`;
    }

    if (spokenEl) {
      spokenEl.innerHTML = `
        <div class="audiobook-loading-wrap" id="audiobookLoadingPlaceholder">
          <div class="audiobook-sound-bars">
            <span class="audiobook-sound-bar"></span>
            <span class="audiobook-sound-bar"></span>
            <span class="audiobook-sound-bar"></span>
            <span class="audiobook-sound-bar"></span>
            <span class="audiobook-sound-bar"></span>
          </div>
          <div class="audiobook-loading-label">Loading Voice...</div>
        </div>
      `;
    }
    this.updateCoverDisplays();
  },

  openAudiobookModal() {
    const modal = document.getElementById('audiobookFullModal');
    if (modal) {
      modal.style.display = 'flex';
      this.updatePitchUI();
      this.syncRateUI();
      if (this.isLoading) {
        this.showAudiobookLoading();
      } else {
        this.updateAudiobookModalContent();
      }
      this.updateAudioUI();
    }
  },

  closeAudiobookModal() {
    const modal = document.getElementById('audiobookFullModal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  },

  tokenizeSpokenText(text) {
    if (!text) return { html: 'Reading novel...', words: [] };
    const regex = /\S+/g;
    let match;
    const words = [];
    let lastIndex = 0;
    let html = '';
    let wordIdx = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        html += this.escapeHtml(text.substring(lastIndex, match.index));
      }
      const word = match[0];
      const startChar = match.index;
      const endChar = match.index + word.length;
      words.push({ index: wordIdx, word: word, start: startChar, end: endChar });
      html += `<span class="tts-word" id="ttsWord-${wordIdx}" data-word-idx="${wordIdx}">${this.escapeHtml(word)}</span>`;
      wordIdx++;
      lastIndex = endChar;
    }
    if (lastIndex < text.length) {
      html += this.escapeHtml(text.substring(lastIndex));
    }
    return { html, words };
  },

  highlightWordAtIndex(idx) {
    if (idx === this.activeWordIndex) return;
    this.activeWordIndex = idx;

    const words = document.querySelectorAll('#audiobookSpokenText .tts-word');
    if (!words || words.length === 0) return;

    words.forEach((el, i) => {
      if (i < idx) {
        el.classList.remove('tts-word-active');
        el.classList.add('tts-word-spoken');
      } else if (i === idx) {
        el.classList.add('tts-word-active');
        el.classList.remove('tts-word-spoken');
      } else {
        el.classList.remove('tts-word-active');
        el.classList.remove('tts-word-spoken');
      }
    });

    const activeEl = document.getElementById(`ttsWord-${idx}`);
    if (activeEl) {
      const container = document.querySelector('.audiobook-spoken-card') || activeEl.parentElement;
      if (container && container.scrollHeight > container.clientHeight) {
        const wordOffset = activeEl.offsetTop - container.offsetTop;
        const targetScroll = wordOffset - (container.clientHeight / 2) + (activeEl.clientHeight / 2);
        container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
      }
    }
  },

  syncWordHighlight() {
    if (!this.currentWordList || this.currentWordList.length === 0) return;
    if (!this.audioElement || !this.audioElement.duration || isNaN(this.audioElement.duration)) return;
    if (this.audioElement.paused || this.audioElement.loop) return;

    const chain = this.activeChain();
    const part = chain ? chain.parts.find(p => p.index === this.currentIndex) : null;
    const progress = part
      ? Math.min(1.0, Math.max(0, (this.audioElement.currentTime - part.start) / Math.max(0.1, part.end - part.start)))
      : Math.min(1.0, Math.max(0, this.audioElement.currentTime / this.audioElement.duration));
    const targetChar = Math.floor(progress * (this.currentSpokenLength || 1));

    let activeIdx = 0;
    for (let i = 0; i < this.currentWordList.length; i++) {
      if (this.currentWordList[i].start <= targetChar) {
        activeIdx = i;
      } else {
        break;
      }
    }
    this.highlightWordAtIndex(activeIdx);
  },

  updateAudiobookModalContent() {
    const titleEl = document.getElementById('audiobookHeaderTitle');
    const chEl = document.getElementById('audiobookHeaderChapter');
    const spokenEl = document.getElementById('audiobookSpokenText');
    const badgeEl = document.getElementById('audiobookParaBadge');

    if (window.Reader && window.Reader.currentNovel) {
      if (titleEl) titleEl.textContent = window.Reader.currentNovel.title || 'BYoB Audiobook';
    }
    if (window.Reader && window.Reader.currentChapter) {
      if (chEl) chEl.textContent = window.Reader.currentChapter.title || 'Chapter';
    }

    if (this.paragraphs && this.paragraphs[this.currentIndex]) {
      const activeText = this.paragraphs[this.currentIndex].innerText.trim();
      if (spokenEl) {
        const tokenized = this.tokenizeSpokenText(activeText);
        spokenEl.innerHTML = tokenized.html;
        this.currentWordList = tokenized.words;
        this.currentSpokenLength = activeText.length;
        this.activeWordIndex = -1;
      }
      const pct = this.paragraphs.length > 0
        ? Math.round(((this.currentIndex + 1) / this.paragraphs.length) * 100)
        : 0;
      if (badgeEl) badgeEl.textContent = `${pct}%`;
    }

    this.updateCoverDisplays();
  },

  updateCoverDisplays() {
    const coverUrl = window.Reader?.currentNovel?.cover_data;
    const updateImgAndPlaceholder = (imgId, placeholderId) => {
      const img = document.getElementById(imgId);
      const placeholder = document.getElementById(placeholderId);
      if (img && placeholder) {
        if (coverUrl && coverUrl.trim().length > 10) {
          img.src = coverUrl;
          img.style.display = 'block';
          placeholder.style.display = 'none';
        } else {
          img.style.display = 'none';
          placeholder.style.display = 'block';
        }
      }
    };

    updateImgAndPlaceholder('ttsPcCoverImg', 'ttsPcCoverPlaceholder');
    updateImgAndPlaceholder('ttsMobileCoverImg', 'ttsMobileCoverPlaceholder');
    updateImgAndPlaceholder('audiobookModalCover', 'audiobookModalPlaceholder');
  },

  updateAudioUI() {
    const isPlayingState = this.isPlaying && !this.isPaused;
    const playSvg = isPlayingState ? TTS_ICONS.pause : TTS_ICONS.play;
    const modalPlaySvg = isPlayingState ? TTS_ICONS.pauseLg : TTS_ICONS.playLg;

    // PC Badge Play button
    const pcPlay = document.getElementById('ttsPlayPauseBtn');
    if (pcPlay) pcPlay.innerHTML = playSvg;

    // Mobile Badge Play button
    const mobPlay = document.getElementById('ttsMobilePlayPauseBtn');
    if (mobPlay) mobPlay.innerHTML = playSvg;

    // Full Modal Play button
    const modalPlay = document.getElementById('modalPlayPauseBtn');
    if (modalPlay) modalPlay.innerHTML = modalPlaySvg;

    // Side panel toggle button
    const panelPlay = document.getElementById('ttsPlayToggleBtn');
    if (panelPlay) panelPlay.textContent = isPlayingState ? 'Pause Read Aloud' : 'Start Read Aloud';

    // Mobile quick sheet toggle button text
    const quickTtsText = document.getElementById('quickSheetTTSText');
    if (quickTtsText) quickTtsText.textContent = isPlayingState ? 'Pause' : 'Read Aloud';

    // Toggle narration speed row in quick sheet (only visible when narration is active)
    const qsSpeedRow = document.getElementById('quickSheetSpeedRow');
    if (qsSpeedRow) {
      qsSpeedRow.style.display = (this.isPlaying || this.isPaused) ? 'flex' : 'none';
    }

    // Rate Label
    const rateLabel = document.getElementById('ttsRateLabel');
    if (rateLabel) rateLabel.textContent = `${this.rate}x`;

    // Speed chips in modal
    document.querySelectorAll('.speed-chip').forEach(chip => {
      const chipSpeed = parseFloat(chip.getAttribute('data-speed'));
      chip.classList.toggle('selected', Math.abs(chipSpeed - this.rate) < 0.05);
    });

    // Voice selects
    const modalVoiceSelect = document.getElementById('audiobookModalVoiceSelect');
    if (modalVoiceSelect && modalVoiceSelect.value !== this.selectedVoice) {
      modalVoiceSelect.value = this.selectedVoice;
    }
    const sideVoiceSelect = document.getElementById('ttsVoiceSelect');
    if (sideVoiceSelect && sideVoiceSelect.value !== this.selectedVoice) {
      sideVoiceSelect.value = this.selectedVoice;
    }
    const cogVoiceSelect = document.getElementById('audiobookCogVoiceSelect');
    if (cogVoiceSelect && cogVoiceSelect.value !== this.selectedVoice) {
      cogVoiceSelect.value = this.selectedVoice;
    }

    this.updateSleepBadge();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlayingState ? 'playing' : (this.isPlaying ? 'paused' : 'none');
    }
  },

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        this.mediaPlay();
        navigator.mediaSession.playbackState = 'playing';
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.logEvent('car/lock-screen pause');
        clearTimeout(this._interruptTimer);
        this.pause();
        this.audioElement.pause();
        navigator.mediaSession.playbackState = 'paused';
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        this.stop();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => this.carSkip(1));
      navigator.mediaSession.setActionHandler('previoustrack', () => this.carSkip(-1));
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
    // With seek handlers set, iPhones (and CarPlay / car Bluetooth) show 15-second skip buttons instead of next and
    // previous track. Clearing them makes the steering-wheel buttons send next/previous, which move a paragraph.
    for (const action of ['seekforward', 'seekbackward', 'seekto']) {
      try { navigator.mediaSession.setActionHandler(action, null); } catch (e) {}
    }
  },

  updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      const novelTitle = (window.Reader && window.Reader.currentNovel && window.Reader.currentNovel.title) || 'BYoB';
      const chTitle = (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.title) || 'Audiobook';

      const total = this.paragraphs ? this.paragraphs.length : 0;
      const album = total ? `Paragraph ${Math.min(this.currentIndex + 1, total)} of ${total}` : 'BYoB Audiobook';
      const cover = window.Reader && window.Reader.currentNovel && window.Reader.currentNovel.cover_data;
      const artwork = [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
      ];
      if (typeof cover === 'string' && cover.length < 2000000 && /^(https?:|\/|data:image\/)/.test(cover)) {
        artwork.unshift({ src: cover, sizes: '512x512' });
      }
      const m = navigator.mediaSession.metadata;
      if (m && m.title === chTitle && m.artist === novelTitle && m.album === album) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: chTitle, artist: novelTitle, album, artwork });
    } catch (e) {}
  },

  applySavedCornerPosition() {
    const badge = document.getElementById('ttsMiniBadge');
    if (!badge) return;

    if (window.innerWidth > 768) {
      badge.style.top = '';
      badge.style.left = '';
      badge.style.bottom = '';
      badge.style.right = '';
      return;
    }

    const corner = localStorage.getItem('byob_tts_badge_corner') || localStorage.getItem('kuroyomi_tts_badge_corner') || 'bottom-right';
    badge.style.transition = 'none';

    if (corner === 'top-left') {
      badge.style.top = 'calc(65px + var(--safe-top))';
      badge.style.left = '14px';
      badge.style.bottom = 'auto';
      badge.style.right = 'auto';
    } else if (corner === 'top-right') {
      badge.style.top = 'calc(65px + var(--safe-top))';
      badge.style.right = '14px';
      badge.style.bottom = 'auto';
      badge.style.left = 'auto';
    } else if (corner === 'bottom-left') {
      badge.style.bottom = 'calc(75px + var(--safe-bottom))';
      badge.style.left = '14px';
      badge.style.top = 'auto';
      badge.style.right = 'auto';
    } else {
      badge.style.bottom = 'calc(75px + var(--safe-bottom))';
      badge.style.right = '14px';
      badge.style.top = 'auto';
      badge.style.left = 'auto';
    }
  },

  initDraggableBadge() {
    const badge = document.getElementById('ttsMiniBadge');
    if (!badge) return;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;
    let hasMoved = false;

    badge.addEventListener('touchstart', (e) => {
      if (window.innerWidth > 768) return;
      const touch = e.touches[0];
      isDragging = true;
      hasMoved = false;
      this.justDragged = false;
      startX = touch.clientX;
      startY = touch.clientY;

      const rect = badge.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      badge.style.transition = 'none';
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (Math.hypot(dx, dy) > 6) {
        hasMoved = true;
      }

      badge.style.left = `${initialLeft + dx}px`;
      badge.style.top = `${initialTop + dy}px`;
      badge.style.bottom = 'auto';
      badge.style.right = 'auto';
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      badge.style.transition = 'all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';

      if (!hasMoved) return;

      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 280);

      // Snap to closest corner
      const rect = badge.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const winW = window.innerWidth;
      const winH = window.innerHeight;

      const isLeft = midX < winW / 2;
      const isTop = midY < winH / 2;

      badge.style.left = isLeft ? '14px' : 'auto';
      badge.style.right = isLeft ? 'auto' : '14px';
      badge.style.top = isTop ? 'calc(65px + var(--safe-top))' : 'auto';
      badge.style.bottom = isTop ? 'auto' : 'calc(75px + var(--safe-bottom))';

      const corner = (isTop ? 'top' : 'bottom') + '-' + (isLeft ? 'left' : 'right');
      localStorage.setItem('byob_tts_badge_corner', corner);
      localStorage.setItem('kuroyomi_tts_badge_corner', corner);
    });
  }
};

window.TTSEngine = TTSEngine;
