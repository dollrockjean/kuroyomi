// Realistic Built-In Neural TTS Engine for KuroYomi
// Uses Blob-based local audio streaming for 100% compatibility across iOS Safari, macOS, Chrome, Edge, and Android
const TTSEngine = {
  audioElement: new Audio(),
  testAudioElement: new Audio(),
  blobCache: new Map(),
  
  isPlaying: false,
  isPaused: false,
  
  selectedVoice: 'en-US-JennyNeural',
  rate: 1.0,
  
  paragraphs: [],
  currentIndex: 0,
  onChapterEndCallback: null,
  
  // Sleep Timer
  sleepTimerDuration: 0,
  sleepTimerRemaining: 0,
  sleepTimerInterval: null,
  sleepMode: 'off',
  
  // Curated list of realistic neural voices
  voices: [
    { id: 'en-US-JennyNeural', name: 'Jenny', desc: 'US Female · Natural & Expressive' },
    { id: 'en-US-GuyNeural', name: 'Guy', desc: 'US Male · Warm & Narrative' },
    { id: 'en-US-AriaNeural', name: 'Aria', desc: 'US Female · Smooth & Clear' },
    { id: 'en-US-ChristopherNeural', name: 'Christopher', desc: 'US Male · Deep Storyteller' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia', desc: 'UK Female · Refined & Melodic' },
    { id: 'en-GB-RyanNeural', name: 'Ryan', desc: 'UK Male · Classic Narrator' },
    { id: 'en-AU-NatashaNeural', name: 'Natasha', desc: 'AU Female · Calm & Relaxed' }
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
      if (this.isPlaying && !this.isPaused) {
        this.speakParagraph(this.currentIndex + 1);
      }
    });

    this.audioElement.addEventListener('error', (e) => {
      console.warn('Audio playback error:', e);
      if (this.isPlaying && !this.isPaused) {
        // Retry next paragraph after brief pause
        setTimeout(() => this.speakParagraph(this.currentIndex + 1), 600);
      }
    });
  },

  populateVoiceSelect() {
    const select = document.getElementById('ttsVoiceSelect');
    if (!select) return;

    select.innerHTML = '';
    const saved = window.ReaderSettings?.tts_voice || this.selectedVoice;
    this.selectedVoice = saved;

    this.voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.desc})`;
      if (v.id === this.selectedVoice) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      this.setVoice(e.target.value);
    });
  },

  setVoice(voiceId) {
    this.selectedVoice = voiceId;
    this.blobCache.clear(); // Clear cache when voice changes
    if (window.ReaderSettings) {
      window.ReaderSettings.tts_voice = voiceId;
      SyncService.syncSettings(window.ReaderSettings);
    }
    if (this.isPlaying && !this.isPaused) {
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
    
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Speech synthesis returned status ${res.status}`);
    }

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    this.blobCache.set(cacheKey, blobUrl);
    return blobUrl;
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
    }
    if (this.isPlaying && !this.isPaused) {
      this.speakParagraph(this.currentIndex);
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
    this.showPill();
    this.speakParagraph(this.currentIndex);
  },

  pause() {
    if (this.isPlaying) {
      this.isPaused = true;
      this.audioElement.pause();
      this.updatePillUI();
    }
  },

  resume() {
    if (this.isPlaying && this.isPaused) {
      this.isPaused = false;
      this.audioElement.play().catch(() => this.speakParagraph(this.currentIndex));
      this.updatePillUI();
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
    this.isPlaying = false;
    this.isPaused = false;
    this.audioElement.pause();
    this.audioElement.src = '';
    this.clearHighlight();
    this.hidePill();
  },

  clearHighlight() {
    document.querySelectorAll('.reader-paragraph.speaking-active, .reader-heading.speaking-active')
      .forEach(el => el.classList.remove('speaking-active'));
  },

  async speakParagraph(index) {
    if (!this.isPlaying || this.isPaused) return;

    if (index >= this.paragraphs.length) {
      this.clearHighlight();
      if (this.sleepMode === 'chapter_end') {
        this.stop();
        return;
      }
      if (this.onChapterEndCallback) {
        this.onChapterEndCallback();
        setTimeout(() => {
          this.refreshParagraphs();
          this.speakParagraph(0);
        }, 1200);
      } else {
        this.stop();
      }
      return;
    }

    this.currentIndex = index;
    const el = this.paragraphs[index];
    if (!el) return;

    // Visual highlight
    this.clearHighlight();
    el.classList.add('speaking-active');

    // Keep reading view smoothly focused on the active spoken text
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Silently save progress at current spot
    if (window.Reader) {
      window.Reader.saveCurrentProgress(index);
    }

    const textToSpeak = el.innerText.trim();
    if (!textToSpeak) {
      this.speakParagraph(index + 1);
      return;
    }

    try {
      const blobUrl = await this.getAudioBlobUrl(textToSpeak, this.selectedVoice, this.rate);
      if (!this.isPlaying || this.isPaused) return;

      this.audioElement.src = blobUrl;
      await this.audioElement.play();
      this.updatePillUI();

      // Pre-fetch next paragraph into memory for seamless instant playback
      this.prefetchNext(index + 1);
    } catch (err) {
      console.error('Speech playback error for paragraph:', err);
      // If error occurs, advance after brief delay
      if (this.isPlaying && !this.isPaused) {
        setTimeout(() => this.speakParagraph(index + 1), 1000);
      }
    }
  },

  async prefetchNext(nextIndex) {
    if (nextIndex < this.paragraphs.length) {
      const nextEl = this.paragraphs[nextIndex];
      const nextText = nextEl ? nextEl.innerText.trim() : '';
      if (nextText) {
        try {
          await this.getAudioBlobUrl(nextText, this.selectedVoice, this.rate);
        } catch {}
      }
    }
  },

  nextParagraph() {
    if (this.currentIndex < this.paragraphs.length - 1) {
      this.speakParagraph(this.currentIndex + 1);
    }
  },

  prevParagraph() {
    if (this.currentIndex > 0) {
      this.speakParagraph(this.currentIndex - 1);
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
    const badges = document.querySelectorAll('.sleep-timer-badge');
    badges.forEach(b => {
      if (this.sleepMode === 'off') {
        b.style.display = 'none';
      } else if (this.sleepMode === 'chapter_end') {
        b.style.display = 'inline-block';
        b.textContent = 'End of Ch';
      } else {
        b.style.display = 'inline-block';
        const m = Math.floor(this.sleepTimerRemaining / 60);
        const s = this.sleepTimerRemaining % 60;
        b.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
    });
  },

  showPill() {
    const pill = document.getElementById('ttsPill');
    if (pill) {
      pill.style.display = 'flex';
      this.updatePillUI();
    }
  },

  hidePill() {
    const pill = document.getElementById('ttsPill');
    if (pill) pill.style.display = 'none';
  },

  updatePillUI() {
    const pauseBtn = document.getElementById('ttsPauseBtn');
    const rateLabel = document.getElementById('ttsRateLabel');
    if (pauseBtn) {
      pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
    }
    if (rateLabel) rateLabel.textContent = `${this.rate}x`;
    this.updateSleepBadge();
  }
};
