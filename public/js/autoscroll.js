// Auto-Scroll Engine for BYoB WebNovel Reader
const AutoScroll = {
  isActive: false,
  isPaused: false,
  menuPaused: false,
  speed: 35, // pixels per second
  lastFrameTime: null,
  animationId: null,
  pauseTimeout: null,
  onChapterEndCallback: null,

  init(onChapterEnd) {
    this.onChapterEndCallback = onChapterEnd;
    if (window.ReaderSettings && window.ReaderSettings.auto_scroll_speed) {
      this.speed = Math.max(5, Math.min(180, window.ReaderSettings.auto_scroll_speed));
    }
    this.bindEvents();
  },

  bindEvents() {
    // Detect user manual scroll/touch in reader area to pause auto-scroll temporarily
    const handleUserInteraction = (e) => {
      if (e && e.target && e.target.closest && e.target.closest('#mobileQuickSheet, #masterPanel, .modal, #quickSheetBackdrop, .master-panel-backdrop')) {
        return;
      }
      if (this.menuPaused) return;

      if (this.isActive && !this.isPaused) {
        this.isPaused = true;
        this.updatePillUI();
        if (this.pauseTimeout) clearTimeout(this.pauseTimeout);
        this.pauseTimeout = setTimeout(() => {
          if (this.isActive && !this.menuPaused) {
            this.isPaused = false;
            this.lastFrameTime = performance.now();
            this.updatePillUI();
            this.loop();
          }
        }, 2200); // Resume 2.2s after user finishes manual scrolling
      }
    };

    window.addEventListener('wheel', handleUserInteraction, { passive: true });
    window.addEventListener('touchstart', handleUserInteraction, { passive: true });
  },

  pauseForMenu() {
    if (this.isActive) {
      this.menuPaused = true;
      this.isPaused = true;
      if (this.pauseTimeout) clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
      if (this.animationId) cancelAnimationFrame(this.animationId);
      this.updatePillUI();
    }
  },

  resumeFromMenu() {
    if (this.isActive && this.menuPaused) {
      this.menuPaused = false;
      this.isPaused = false;
      this.lastFrameTime = performance.now();
      this.updatePillUI();
      this.loop();
    }
  },

  start(speed) {
    if (speed) this.speed = speed;
    this.isActive = true;
    this.isPaused = false;
    this.menuPaused = false;
    this.lastFrameTime = performance.now();
    this.showPill();
    if (window.App && typeof window.App.updateAutoScrollUI === 'function') {
      window.App.updateAutoScrollUI();
    }
    this.loop();
  },

  stop() {
    this.isActive = false;
    this.isPaused = false;
    this.menuPaused = false;
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.pauseTimeout) clearTimeout(this.pauseTimeout);
    this.hidePill();
    if (window.App && typeof window.App.updateAutoScrollUI === 'function') {
      window.App.updateAutoScrollUI();
    }
  },

  toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      this.start();
    }
  },

  setSpeed(newSpeed) {
    this.speed = Math.max(5, Math.min(180, newSpeed));
    this.updatePillUI();
    if (window.App && typeof window.App.updateAutoScrollUI === 'function') {
      window.App.updateAutoScrollUI();
    }
    // Persist speed in settings
    if (window.ReaderSettings) {
      window.ReaderSettings.auto_scroll_speed = this.speed;
      if (window.SyncService && typeof window.SyncService.syncSettings === 'function') {
        window.SyncService.syncSettings(window.ReaderSettings);
      }
    }
  },

  changeSpeed(delta) {
    this.setSpeed(this.speed + delta);
  },

  loop() {
    if (!this.isActive || this.isPaused) return;

    const now = performance.now();
    const dt = (now - (this.lastFrameTime || now)) / 1000;
    this.lastFrameTime = now;

    const scrollDelta = this.speed * dt;
    window.scrollBy(0, scrollDelta);

    // Check if reached bottom of document
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.scrollHeight;

    if (scrollBottom >= docHeight - 10) {
      // Trigger next chapter
      if (this.onChapterEndCallback) {
        this.isPaused = true;
        setTimeout(() => {
          this.onChapterEndCallback();
          this.isPaused = false;
          this.lastFrameTime = performance.now();
        }, 800);
      }
    }

    this.animationId = requestAnimationFrame(() => this.loop());
  },

  showPill() {
    const pill = document.getElementById('autoscrollPill');
    if (pill) {
      pill.style.display = 'flex';
      this.updatePillUI();
    }
  },

  hidePill() {
    const pill = document.getElementById('autoscrollPill');
    if (pill) pill.style.display = 'none';
  },

  updatePillUI() {
    const speedLabel = document.getElementById('autoscrollSpeedLabel');
    const pauseBtn = document.getElementById('autoscrollPauseBtn');
    if (speedLabel) speedLabel.textContent = `${this.speed} px/s`;
    if (pauseBtn) {
      pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
      pauseBtn.style.color = this.isPaused ? 'var(--accent)' : 'inherit';
    }
  }
};

window.AutoScroll = AutoScroll;
