// Realistic Built-In Neural TTS Engine for KuroYomi
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
  secondaryAudioElement: new Audio(),
  testAudioElement: new Audio(),
  keepAliveAudio: null,
  audioContext: null,
  blobCache: new Map(),
  pendingFetches: new Map(),
  
  isPlaying: false,
  isPaused: false,
  isLoading: false,
  justDragged: false,
  
  selectedVoice: 'en-US-BrianNeural',
  rate: 1.0,
  pitch: 0,
  isUsingDeviceVoice: false,
  deviceUtterance: null,
  
  paragraphs: [],
  currentIndex: 0,
  playbackSessionId: 0,
  onChapterEndCallback: null,

  // Dual-buffer gapless handoff tracking
  preloadedIndex: -1,
  preloadedBlobUrl: null,
  isTransitioning: false,

  // Event handlers
  _onEndedHandler: null,
  _onTimeUpdateHandler: null,
  _onErrorHandler: null,

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
    { id: 'en-AU-WilliamMultilingualNeural', name: 'William', desc: 'Smooth Australian' }
  ],

  generateSilenceWavUri(seconds = 4) {
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

    this._onEndedHandler = () => {
      if (!this.isPlaying || this.isPaused || this.audioElement.loop) return;
      if (this.isLoading) return;
      this.speakParagraph(this.currentIndex + 1);
    };

    this._onTimeUpdateHandler = () => {
      this.syncWordHighlight();
    };

    this._onErrorHandler = (e) => {
      if (!this.isPlaying || this.isPaused || !this.audioElement.src || this.audioElement.src === window.location.href) {
        return;
      }
      console.warn('Audio playback error on paragraph', this.currentIndex, e);
      // DO NOT advance or skip paragraphs on error! Fall back to device voice for the current paragraph
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
  },

  init(onChapterEnd) {
    this.onChapterEndCallback = onChapterEnd;
    if (window.ReaderSettings && window.ReaderSettings.tts_rate) {
      this.rate = parseFloat(window.ReaderSettings.tts_rate);
    }
    if (window.ReaderSettings && window.ReaderSettings.tts_pitch !== undefined) {
      this.pitch = parseInt(window.ReaderSettings.tts_pitch, 10) || 0;
    }
    if (window.ReaderSettings && window.ReaderSettings.tts_voice) {
      this.selectedVoice = window.ReaderSettings.tts_voice;
    }
    this.populateVoiceSelect();
    this.updatePitchUI();

    this.audioElement.playsInline = true;
    this.secondaryAudioElement.playsInline = true;
    this.testAudioElement.playsInline = true;

    this.bindAudioElementEvents();

    // iOS Audio Context Priming on any user touch/click
    const primeAudio = () => {
      this.audioElement.load();
      this.secondaryAudioElement.load();
      this.testAudioElement.load();
      this.startKeepAlive();
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
        if (!this.isPaused && this.audioElement && this.audioElement.paused) {
          this.audioElement.play().catch(() => {});
        }
      }
    });

    // Setup lock screen & bluetooth media session controls
    this.setupMediaSession();

    // Allow tapping any paragraph in the reader to jump TTS speech to that paragraph
    const readerContent = document.getElementById('readerContent');
    if (readerContent) {
      readerContent.addEventListener('click', (e) => {
        if (!this.isPlaying) return;
        const targetP = e.target.closest('.reader-paragraph, .reader-heading');
        if (targetP && this.paragraphs && this.paragraphs.length) {
          const idx = this.paragraphs.indexOf(targetP);
          if (idx !== -1 && idx !== this.currentIndex) {
            this.speakParagraph(idx);
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
    this.selectedVoice = saved;

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

  setVoice(voiceId) {
    this.selectedVoice = voiceId;
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

  async getAudioBlobUrl(text, voiceId, rateVal, pitchVal, retries = 2) {
    const pVal = pitchVal !== undefined ? pitchVal : this.pitch;
    const cacheKey = `${voiceId}_${rateVal}_${pVal}_${text}`;
    if (this.blobCache.has(cacheKey)) {
      return this.blobCache.get(cacheKey);
    }
    if (this.pendingFetches.has(cacheKey)) {
      return await this.pendingFetches.get(cacheKey);
    }

    const fetchPromise = (async () => {
      const rateParam = this.getRateParam(rateVal);
      const pitchParam = this.getPitchParam(pVal);
      const url = `/api/tts/speak?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voiceId)}&rate=${encodeURIComponent(rateParam)}&pitch=${encodeURIComponent(pitchParam)}`;
      
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) {
            throw new Error(`Speech synthesis returned status ${res.status}`);
          }
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          this.blobCache.set(cacheKey, blobUrl);
          this.pendingFetches.delete(cacheKey);
          return blobUrl;
        } catch (err) {
          clearTimeout(timer);
          if (attempt === retries) {
            this.pendingFetches.delete(cacheKey);
            throw err;
          }
          await new Promise(r => setTimeout(r, 600));
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
    const testSentence = "Welcome to KuroYomi. This is how I sound reading your novel.";

    try {
      this.testAudioElement.pause();
      const blobUrl = await this.getAudioBlobUrl(testSentence, voiceId, this.rate, this.pitch);
      this.testAudioElement.src = blobUrl;
      await this.testAudioElement.play();
    } catch (err) {
      console.error('Test voice error:', err);
      alert('Could not play voice audio: ' + err.message);
    } finally {
      if (testBtn) testBtn.textContent = originalText;
    }
  },

  setRate(val) {
    this.rate = parseFloat(val);
    this.blobCache.clear();
    this.pendingFetches.clear();
    if (window.ReaderSettings) {
      window.ReaderSettings.tts_rate = this.rate;
      if (window.SyncService) {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    }
    const slider = document.getElementById('ttsRateSlider');
    if (slider) slider.value = this.rate;
    const rateVal = document.getElementById('ttsRateVal');
    if (rateVal) rateVal.textContent = `${this.rate}x`;

    // Update speed chips UI across audiobook modal and middle quick sheet
    document.querySelectorAll('.speed-chip, .quick-sheet-speed-chip').forEach(chip => {
      const s = parseFloat(chip.getAttribute('data-speed'));
      chip.classList.toggle('selected', Math.abs(s - this.rate) < 0.05);
    });
    const qsSpeedVal = document.getElementById('quickSheetSpeedVal');
    if (qsSpeedVal) qsSpeedVal.textContent = `${this.rate}x`;

    this.updateAudioUI();
    if (this.isPlaying && !this.isPaused) {
      if (this.audioElement && !this.audioElement.paused) {
        this.audioElement.playbackRate = this.rate;
      }
      if (this.secondaryAudioElement && !this.secondaryAudioElement.paused) {
        this.secondaryAudioElement.playbackRate = this.rate;
      }
      if (this.isUsingDeviceVoice) {
        this.speakParagraph(this.currentIndex);
      }
    }
  },

  refreshParagraphs() {
    const container = document.getElementById('readerContent');
    if (!container) return;
    this.paragraphs = Array.from(container.querySelectorAll('.reader-paragraph, .reader-heading'));
  },

  startKeepAlive() {
    // 1. Continuous silent PCM WAV looping track at low volume (keeps iOS AVAudioSession active)
    try {
      if (!this.keepAliveAudio) {
        this.keepAliveAudio = new Audio();
        this.keepAliveAudio.loop = true;
        this.keepAliveAudio.volume = 0.02;
        this.keepAliveAudio.playsInline = true;
        this.keepAliveAudio.src = this.generateSilenceWavUri(4);
      }
      if (this.keepAliveAudio.paused) {
        this.keepAliveAudio.play().catch(() => {});
      }
    } catch (e) {
      console.warn('Keepalive audio warning:', e);
    }

    // 2. Web Audio API AudioContext keepalive
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && !this.audioContext) {
        this.audioContext = new AudioCtx();
        const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate, this.audioContext.sampleRate);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = this.audioContext.createGain();
        gain.gain.value = 0.001;
        source.connect(gain);
        gain.connect(this.audioContext.destination);
        source.start(0);
      }
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }
    } catch (e) {
      console.warn('AudioContext keepalive warning:', e);
    }
  },

  stopKeepAlive() {
    try {
      if (this.keepAliveAudio) {
        this.keepAliveAudio.pause();
      }
    } catch {}
    try {
      if (this.audioContext && this.audioContext.state === 'running') {
        this.audioContext.suspend().catch(() => {});
      }
    } catch {}
  },

  start(fromIndex = null) {
    this.refreshParagraphs();
    if (!this.paragraphs.length) return;

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
        offlineStatusEl.textContent = 'Offline: Device Voice';
      }
    }

    if (enabled) {
      if (window.App && typeof window.App.showToast === 'function') {
        const curVoiceObj = this.voices.find(v => v.id === this.selectedVoice);
        const name = curVoiceObj ? curVoiceObj.name : 'Cloud Voice';
        window.App.showToast(`Offline: Switched from ${name} to Device Voice`);
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

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = Math.min(2.0, Math.max(0.5, this.rate));
    utterance.pitch = Math.max(0.5, Math.min(1.5, 1.0 + (this.pitch / 40.0)));

    // Choose best English system voice (e.g. Siri, Samantha, Daniel, etc.)
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      const best = voices.find(v => v.lang && v.lang.startsWith('en') && (
        v.name.includes('Siri') || v.name.includes('Daniel') || v.name.includes('Samantha') || v.name.includes('Karen') || v.name.includes('Google')
      )) || voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
      if (best) utterance.voice = best;
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
      if (this.isPlaying && !this.isPaused) {
        this.speakParagraph(index + 1);
      }
    };

    utterance.onerror = (e) => {
      console.warn('Device speech synthesis error:', e);
      if (this.isPlaying && !this.isPaused) {
        setTimeout(() => this.speakParagraph(index + 1), 600);
      }
    };

    this.deviceUtterance = utterance;
    window.speechSynthesis.speak(utterance);
    this.updateAudioUI();
  },

  pause() {
    if (this.isPlaying) {
      this.isPaused = true;
      this.stopKeepAlive();
      this.audioElement.pause();
      this.secondaryAudioElement.pause();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.pause();
      }
      this.updateAudioUI();
    }
  },

  resume() {
    if (this.isPlaying && this.isPaused) {
      this.isPaused = false;
      this.startKeepAlive();
      if (this.isUsingDeviceVoice) {
        // Attempt recovery to selected cloud voice on resume
        this.setDeviceVoiceMode(false);
        this.speakParagraph(this.currentIndex);
      } else {
        this.audioElement.play().catch(() => this.speakParagraph(this.currentIndex));
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
    this.playbackSessionId = (this.playbackSessionId || 0) + 1;
    this.isPlaying = false;
    this.isPaused = false;
    this.stopKeepAlive();
    this.audioElement.pause();
    this.audioElement.loop = false;
    this.audioElement.src = '';
    try {
      this.secondaryAudioElement.pause();
      this.secondaryAudioElement.loop = false;
      this.secondaryAudioElement.removeAttribute('src');
    } catch (e) {}
    this.preloadedIndex = -1;
    this.preloadedBlobUrl = null;
    this.isTransitioning = false;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
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

  async speakParagraph(index) {
    if (!this.isPlaying || this.isPaused) return;

    this.playbackSessionId = (this.playbackSessionId || 0) + 1;
    const sessionId = this.playbackSessionId;

    // 1. Immediately pause prior playback & cancel speech synthesis so skipping is instantaneous
    this.audioElement.pause();
    this.audioElement.loop = false;
    try {
      this.secondaryAudioElement.pause();
      this.secondaryAudioElement.removeAttribute('src');
    } catch (e) {}
    this.isTransitioning = false;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.clearWordHighlights();

    // 2. Seamless transition to next chapter if current chapter ended
    if (index >= this.paragraphs.length) {
      this.clearHighlight();
      if (this.sleepMode === 'chapter_end') {
        this.stop();
        return;
      }
      await this.advanceToNextChapter();
      return;
    }

    this.currentIndex = index;
    const el = this.paragraphs[index];
    if (!el) return;

    const textToSpeak = el.innerText.trim();
    if (!textToSpeak) {
      this.speakParagraph(index + 1);
      return;
    }

    this.isLoading = true;

    // Visual highlight on reader text (bypass smooth scroll in background to prevent animation frame freeze)
    this.clearHighlight();
    el.classList.add('speaking-active');
    if (!document.hidden && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    this.updateAudioUI();
    this.updateMediaSessionMetadata();

    // Silently save progress with accurate scroll percentage
    if (window.Reader) {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = docHeight > 0 ? Math.round((window.scrollY / docHeight) * 100) : 0;
      window.Reader.saveCurrentProgress(index, scrollPct);
    }

    // Check if audio blob is already in memory cache
    const cacheKey = `${this.selectedVoice}_${this.rate}_${this.pitch}_${textToSpeak}`;
    const isCached = this.blobCache.has(cacheKey);

    let loadingTimer = null;
    if (!isCached && navigator.onLine) {
      // Only show soundbars if synthesis takes longer than 120ms
      loadingTimer = setTimeout(() => {
        if (this.isLoading && this.currentIndex === index && this.playbackSessionId === sessionId) {
          this.showAudiobookLoading();
        }
      }, 120);
    } else {
      this.updateAudiobookModalContent();
    }

    // If device is offline
    if (!navigator.onLine) {
      if (loadingTimer) clearTimeout(loadingTimer);
      this.isLoading = false;
      this.setDeviceVoiceMode(true);
      this.updateAudiobookModalContent();
      this.speakWithDeviceVoice(textToSpeak, index);
      return;
    }

    // ALWAYS prioritize the main voice selected (realistic cloud neural TTS)
    try {
      this.playKeepAliveSilence();

      const blobUrl = await this.getAudioBlobUrl(textToSpeak, this.selectedVoice, this.rate, this.pitch);

      if (loadingTimer) clearTimeout(loadingTimer);

      // If user skipped or paused while fetching was in flight, discard cleanly
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;

      this.isLoading = false;

      // Cloud synthesis succeeded! Restore main cloud voice immediately
      if (this.isUsingDeviceVoice) {
        this.setDeviceVoiceMode(false);
      }

      this.audioElement.loop = false;
      this.audioElement.src = blobUrl;
      this.audioElement.playbackRate = this.rate;
      this.updateAudiobookModalContent();
      await this.audioElement.play();
      this.updateAudioUI();

      // Proactively prefetch the next 5 paragraphs in the background buffer!
      this.prefetchAhead(index, 5);
    } catch (err) {
      if (loadingTimer) clearTimeout(loadingTimer);
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;
      console.warn('Cloud TTS synthesis failed, using device voice fallback for this paragraph:', err);
      this.isLoading = false;
      this.setDeviceVoiceMode(true);
      this.updateAudiobookModalContent();
      this.speakWithDeviceVoice(textToSpeak, index);
    }
  },

  async prepareNextParagraph(nextIndex) {
    if (!this.paragraphs || nextIndex >= this.paragraphs.length) return;
    const el = this.paragraphs[nextIndex];
    const text = el ? el.innerText.trim() : '';
    if (text) {
      try {
        await this.getAudioBlobUrl(text, this.selectedVoice, this.rate, this.pitch);
      } catch (e) {}
    }
  },

  async prefetchAhead(fromIndex, count = 5) {
    if (!this.paragraphs || this.paragraphs.length === 0) return;
    const currentVoice = this.selectedVoice;
    const currentRate = this.rate;
    const currentPitch = this.pitch;

    for (let offset = 1; offset <= count; offset++) {
      const idx = fromIndex + offset;
      if (idx < this.paragraphs.length) {
        const el = this.paragraphs[idx];
        const text = el ? el.innerText.trim() : '';
        if (text) {
          const cacheKey = `${currentVoice}_${currentRate}_${currentPitch}_${text}`;
          if (!this.blobCache.has(cacheKey) && !this.pendingFetches.has(cacheKey)) {
            this.getAudioBlobUrl(text, currentVoice, currentRate, currentPitch).catch(() => {});
          }
        }
      }
    }

    if (fromIndex >= this.paragraphs.length - 2) {
      this.prefetchNextChapterHead();
    }
  },

  async prefetchNextChapterHead() {
    if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.next_chapter) {
      const nextId = window.Reader.currentChapter.next_chapter.id;
      try {
        const res = await fetch(`/api/chapters/${encodeURIComponent(nextId)}`);
        if (res.ok) {
          const nextCh = await res.json();
          if (nextCh && nextCh.content_html) {
            const div = document.createElement('div');
            div.innerHTML = nextCh.content_html;
            const ps = Array.from(div.querySelectorAll('.reader-paragraph, .reader-heading')).slice(0, 3);
            for (const p of ps) {
              const text = p.textContent.trim();
              if (text) {
                this.getAudioBlobUrl(text, this.selectedVoice, this.rate, this.pitch).catch(() => {});
              }
            }
          }
        }
      } catch {}
    }
  },

  prefetchNext(nextIndex) {
    return this.prefetchAhead(nextIndex - 1, 5);
  },

  handoffToSecondary() {
    // Retained for backward compatibility
  },

  playKeepAliveSilence() {
    this.startKeepAlive();
  },

  async advanceToNextChapter() {
    if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.next_chapter) {
      const wasModalOpen = document.getElementById('audiobookFullModal')?.style.display === 'flex';
      const nextId = window.Reader.currentChapter.next_chapter.id;
      
      this.clearHighlight();
      this.clearWordHighlights();
      this.playKeepAliveSilence();

      const loaded = await window.Reader.loadChapter(nextId, false, true);
      if (!loaded) {
        this.stop();
        return;
      }

      this.refreshParagraphs();
      if (this.paragraphs.length > 0) {
        if (wasModalOpen) {
          this.openAudiobookModal();
        }
        await this.speakParagraph(0);
      } else {
        this.stop();
      }
    } else {
      this.stop();
    }
  },

  nextParagraph() {
    if (this.currentIndex < this.paragraphs.length - 1) {
      this.speakParagraph(this.currentIndex + 1);
    } else {
      this.advanceToNextChapter();
    }
  },

  prevParagraph() {
    if (this.currentIndex > 0) {
      this.speakParagraph(this.currentIndex - 1);
    }
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
      paragraph_index: this.currentIndex || 0,
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
          paragraph_index: this.currentIndex,
          scroll_percent: window.Reader ? Math.round((window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) * 100) : 0
        },
        timestamp: Date.now()
      };
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
      if (titleEl) titleEl.textContent = window.Reader.currentNovel.title || 'KuroYomi Audiobook';
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
            <div class="audiobook-sound-bar"></div>
            <div class="audiobook-sound-bar"></div>
            <div class="audiobook-sound-bar"></div>
            <div class="audiobook-sound-bar"></div>
            <div class="audiobook-sound-bar"></div>
          </div>
          <span class="audiobook-loading-label">Loading Voice Audio...</span>
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
      const spokenEl = document.getElementById('audiobookSpokenText');
      if (!spokenEl || !spokenEl.querySelector('.audiobook-loading-wrap')) {
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
    if (this.audioElement.paused) return;

    const progress = Math.min(1.0, Math.max(0, this.audioElement.currentTime / this.audioElement.duration));
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
      if (titleEl) titleEl.textContent = window.Reader.currentNovel.title || 'KuroYomi Audiobook';
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
      navigator.mediaSession.playbackState = isPlayingState ? 'playing' : 'paused';
    }
  },

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (this.isPlaying && this.isPaused) {
          this.resume();
        } else if (!this.isPlaying) {
          this.start();
        }
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this.nextParagraph();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.prevParagraph();
      });
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
  },

  updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      const novelTitle = (window.Reader && window.Reader.currentNovel && window.Reader.currentNovel.title) || 'KuroYomi';
      const chTitle = (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.title) || 'Audiobook';

      navigator.mediaSession.metadata = new MediaMetadata({
        title: chTitle,
        artist: novelTitle,
        album: 'KuroYomi Audiobook',
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
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

    const corner = localStorage.getItem('kuroyomi_tts_badge_corner') || 'bottom-right';
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
      localStorage.setItem('kuroyomi_tts_badge_corner', corner);
    });
  }
};

window.TTSEngine = TTSEngine;
