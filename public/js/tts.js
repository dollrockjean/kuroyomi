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
  testAudioElement: new Audio(),
  blobCache: new Map(),
  
  isPlaying: false,
  isPaused: false,
  justDragged: false,
  
  selectedVoice: 'en-US-BrianNeural',
  rate: 1.0,
  isUsingDeviceVoice: false,
  deviceUtterance: null,
  
  paragraphs: [],
  currentIndex: 0,
  playbackSessionId: 0,
  onChapterEndCallback: null,

  // Real-time word-by-word highlight tracking
  currentWordList: [],
  currentSpokenLength: 0,
  activeWordIndex: -1,
  
  // Sleep Timer
  sleepTimerDuration: 0,
  sleepTimerRemaining: 0,
  sleepTimerInterval: null,
  sleepMode: 'off',
  
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

  init(onChapterEnd) {
    this.onChapterEndCallback = onChapterEnd;
    if (window.ReaderSettings && window.ReaderSettings.tts_rate) {
      this.rate = parseFloat(window.ReaderSettings.tts_rate);
    }
    if (window.ReaderSettings && window.ReaderSettings.tts_voice) {
      this.selectedVoice = window.ReaderSettings.tts_voice;
    }
    this.populateVoiceSelect();

    // iOS Audio Context Priming on any user touch/click
    const primeAudio = () => {
      this.audioElement.load();
      this.testAudioElement.load();
      window.removeEventListener('touchstart', primeAudio);
      window.removeEventListener('click', primeAudio);
    };
    window.addEventListener('touchstart', primeAudio, { passive: true, once: true });
    window.addEventListener('click', primeAudio, { passive: true, once: true });

    // Handle audio completion -> move to next paragraph
    this.audioElement.addEventListener('ended', () => {
      if (this.isPlaying && !this.isPaused && !this.audioElement.loop) {
        this.speakParagraph(this.currentIndex + 1);
      }
    });

    // Real-time word-by-word highlight synchronization
    this.audioElement.addEventListener('timeupdate', () => {
      this.syncWordHighlight();
    });

    this.audioElement.addEventListener('error', (e) => {
      console.warn('Audio playback error:', e);
      if (this.isPlaying && !this.isPaused && !this.audioElement.loop) {
        setTimeout(() => this.speakParagraph(this.currentIndex + 1), 600);
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

    // Wire modal speed preset chips
    const speedChips = document.querySelectorAll('.speed-chip');
    speedChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const s = parseFloat(chip.getAttribute('data-speed'));
        if (!isNaN(s)) this.setRate(s);
      });
    });

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

    // Initialize draggable mobile corner badge
    this.initDraggableBadge();

    // Listen for window resize
    window.addEventListener('resize', () => this.applySavedCornerPosition());
  },

  populateVoiceSelect() {
    const s1 = document.getElementById('ttsVoiceSelect');
    const s2 = document.getElementById('audiobookModalVoiceSelect');
    const selects = [s1, s2].filter(Boolean);
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

  async getAudioBlobUrl(text, voiceId, rateVal) {
    const cacheKey = `${voiceId}_${rateVal}_${text}`;
    if (this.blobCache.has(cacheKey)) {
      return this.blobCache.get(cacheKey);
    }

    const rateParam = this.getRateParam(rateVal);
    const url = `/api/tts/speak?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voiceId)}&rate=${encodeURIComponent(rateParam)}`;
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`Speech synthesis returned status ${res.status}`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      this.blobCache.set(cacheKey, blobUrl);
      return blobUrl;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
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
      const blobUrl = await this.getAudioBlobUrl(testSentence, voiceId, this.rate);
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

    // Update speed chips UI
    document.querySelectorAll('.speed-chip').forEach(chip => {
      const s = parseFloat(chip.getAttribute('data-speed'));
      chip.classList.toggle('selected', Math.abs(s - this.rate) < 0.05);
    });

    this.updateAudioUI();
    if (this.isPlaying && !this.isPaused) {
      // If audio is actively playing, immediately adjust playback tempo in real-time
      if (this.audioElement && !this.audioElement.paused) {
        this.audioElement.playbackRate = this.rate;
      } else if (this.isUsingDeviceVoice) {
        this.speakParagraph(this.currentIndex);
      }
    }
  },

  refreshParagraphs() {
    const container = document.getElementById('readerContent');
    if (!container) return;
    this.paragraphs = Array.from(container.querySelectorAll('.reader-paragraph, .reader-heading'));
  },

  start(fromIndex = null) {
    this.refreshParagraphs();
    if (!this.paragraphs.length) return;

    // Always prioritize the main voice selected
    this.setDeviceVoiceMode(false);

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
      this.audioElement.pause();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.pause();
      }
      this.updateAudioUI();
    }
  },

  resume() {
    if (this.isPlaying && this.isPaused) {
      this.isPaused = false;
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
    this.audioElement.pause();
    this.audioElement.loop = false;
    this.audioElement.src = '';
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

  async speakParagraph(index) {
    if (!this.isPlaying || this.isPaused) return;

    this.playbackSessionId = (this.playbackSessionId || 0) + 1;
    const sessionId = this.playbackSessionId;

    // 1. Immediately pause prior playback & cancel speech synthesis so skipping is instantaneous
    this.audioElement.pause();
    this.audioElement.loop = false;
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

    // Visual highlight on reader text
    this.clearHighlight();
    el.classList.add('speaking-active');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update audiobook modal content and audio UI immediately
    this.updateAudiobookModalContent();
    this.updateAudioUI();
    this.updateMediaSessionMetadata();

    // Silently save progress with accurate scroll percentage
    if (window.Reader) {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPct = docHeight > 0 ? Math.round((window.scrollY / docHeight) * 100) : 0;
      window.Reader.saveCurrentProgress(index, scrollPct);
    }

    const textToSpeak = el.innerText.trim();
    if (!textToSpeak) {
      this.speakParagraph(index + 1);
      return;
    }

    // If device is offline
    if (!navigator.onLine) {
      this.setDeviceVoiceMode(true);
      this.speakWithDeviceVoice(textToSpeak, index);
      return;
    }

    // ALWAYS prioritize the main voice selected (realistic cloud neural TTS)
    try {
      const blobUrl = await this.getAudioBlobUrl(textToSpeak, this.selectedVoice, this.rate);
      // If user skipped or paused while fetching was in flight, discard cleanly
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;

      // Cloud synthesis succeeded! Restore main cloud voice immediately
      if (this.isUsingDeviceVoice) {
        this.setDeviceVoiceMode(false);
      }

      this.audioElement.loop = false;
      this.audioElement.src = blobUrl;
      await this.audioElement.play();
      this.updateAudioUI();

      // Pre-fetch next paragraph into memory for seamless instant playback
      this.prefetchNext(index + 1);
    } catch (err) {
      if (this.playbackSessionId !== sessionId || !this.isPlaying || this.isPaused) return;
      console.warn('Cloud TTS synthesis failed, using device voice fallback for this paragraph:', err);
      this.setDeviceVoiceMode(true);
      this.speakWithDeviceVoice(textToSpeak, index);
    }
  },

  playKeepAliveSilence() {
    // 0.5s silent WAV loop to maintain WebKit background audio session during chapter transition
    const SILENCE_DATA_URI = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    try {
      this.audioElement.loop = true;
      this.audioElement.src = SILENCE_DATA_URI;
      this.audioElement.play().catch(() => {});
    } catch {}
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

  async prefetchNext(nextIndex) {
    if (nextIndex < this.paragraphs.length) {
      const targets = [nextIndex, nextIndex + 1];
      for (const idx of targets) {
        if (idx < this.paragraphs.length) {
          const el = this.paragraphs[idx];
          const text = el ? el.innerText.trim() : '';
          if (text) {
            try {
              await this.getAudioBlobUrl(text, this.selectedVoice, this.rate);
            } catch {}
          }
        }
      }
    } else {
      // Near end of chapter -> preload next chapter in background
      if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.next_chapter) {
        const nextId = window.Reader.currentChapter.next_chapter.id;
        try {
          const res = await fetch(`/api/chapters/${encodeURIComponent(nextId)}`);
          if (res.ok) {
            const nextCh = await res.json();
            if (nextCh && nextCh.content_html) {
              const div = document.createElement('div');
              div.innerHTML = nextCh.content_html;
              const firstP = div.querySelector('.reader-paragraph, .reader-heading');
              const firstText = firstP ? firstP.textContent.trim() : '';
              if (firstText) {
                await this.getAudioBlobUrl(firstText, this.selectedVoice, this.rate);
              }
            }
          }
        } catch {}
      }
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
      await window.Reader.loadChapter(prevId, false, true);
      this.refreshParagraphs();
      this.start(0);
      if (wasModalOpen) {
        this.openAudiobookModal();
      }
    }
  },

  // === Sleep Timer ===
  setSleepTimer(minutesOrMode) {
    if (this.sleepTimerInterval) clearInterval(this.sleepTimerInterval);

    if (minutesOrMode === 'off' || minutesOrMode === 0) {
      this.sleepMode = 'off';
      this.sleepTimerDuration = 0;
      this.sleepTimerRemaining = 0;
      this.updateSleepBadge();
      return;
    }

    if (minutesOrMode === 'chapter_end') {
      this.sleepMode = 'chapter_end';
      this.updateSleepBadge('End of Chapter');
      return;
    }

    const minutes = parseInt(minutesOrMode);
    this.sleepMode = 'time';
    this.sleepTimerDuration = minutes * 60;
    this.sleepTimerRemaining = this.sleepTimerDuration;
    this.updateSleepBadge();

    this.sleepTimerInterval = setInterval(() => {
      this.sleepTimerRemaining--;
      if (this.sleepTimerRemaining <= 0) {
        clearInterval(this.sleepTimerInterval);
        this.triggerSleepTimeout();
      } else {
        this.updateSleepBadge();
      }
    }, 1000);
  },

  triggerSleepTimeout() {
    this.sleepMode = 'off';
    this.updateSleepBadge();
    this.stop();
    if (AutoScroll.isActive) AutoScroll.stop();

    if (window.Reader) {
      window.Reader.saveCurrentProgress();
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

  openAudiobookModal() {
    const modal = document.getElementById('audiobookFullModal');
    if (modal) {
      modal.style.display = 'flex';
      this.updateAudiobookModalContent();
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
