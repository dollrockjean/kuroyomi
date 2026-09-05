// Auto-Scroll Engine for KuroYomi WebNovel Reader
const AutoScroll = {
  isActive: false,
  isPaused: false,
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
    // Detect user manual scroll/touch to pause auto-scroll temporarily
    const handleUserInteraction = () => {
      if (this.isActive && !this.isPaused) {
        this.isPaused = true;
        this.updatePillUI();
        if (this.pauseTimeout) clearTimeout(this.pauseTimeout);
        this.pauseTimeout = setTimeout(() => {
          if (this.isActive) {
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

  start(speed) {
    if (speed) this.speed = speed;
    this.isActive = true;
    this.isPaused = false;
    this.lastFrameTime = performance.now();
    this.showPill();
    this.loop();
  },

  stop() {
    this.isActive = false;
    this.isPaused = false;
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.pauseTimeout) clearTimeout(this.pauseTimeout);
    this.hidePill();
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
    // Persist speed in settings
    if (window.ReaderSettings) {
      window.ReaderSettings.auto_scroll_speed = this.speed;
      SyncService.syncSettings(window.ReaderSettings);
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
