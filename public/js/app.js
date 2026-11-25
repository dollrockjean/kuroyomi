// BYoB Main Application Controller
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const FALLBACK_COVER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 260 180'%3E%3Crect width='100%25' height='100%25' fill='%23141414'/%3E%3Crect x='10' y='10' width='240' height='160' rx='4' fill='none' stroke='%23333333' stroke-dasharray='4'/%3E%3Ctext x='50%25' y='50%25' fill='%23888888' font-family='sans-serif' font-size='13' font-weight='600' text-anchor='middle' dy='.3em'%3ENo Cover%3C/text%3E%3C/svg%3E";

window.ReaderSettings = {
  theme: 'monochrome-dark',
  font_family: 'times',
  font_size: 19,
  line_height: 1.85,
  letter_spacing: 0.0,
  content_width: 'normal',
  margin_width: 'edge',
  auto_scroll_speed: 35,
  tts_voice: 'en-US-BrianNeural',
  tts_rate: 1.0,
  tts_pitch: 0,
  bionic_reading: false,
  library_view_mode: 'tile',
  library_sort_by: 'last_read'
};

// One list for every theme picker. Colors match the [data-theme] blocks in brutalist.css
// (bg = --bg-primary, fg = --text-primary, accent = --accent). Dark themes first, then light.
const THEMES = [
  { id: 'monochrome-dark', name: 'Charcoal', bg: '#141518', fg: '#f3f4f6', accent: '#ffffff' },
  { id: 'graphite-dark', name: 'Graphite', bg: '#2a2a2a', fg: '#ececec', accent: '#f2f2f2' },
  { id: 'warm-dark', name: 'Warm Dark', bg: '#221d19', fg: '#f0e6d8', accent: '#e8b773' },
  { id: 'sepia-dark', name: 'Sepia Night', bg: '#2b2419', fg: '#e9dcc3', accent: '#d9ab63' },
  { id: 'forest-dark', name: 'Forest', bg: '#1b2420', fg: '#e4ece6', accent: '#8fd3ad' },
  { id: 'plum-dark', name: 'Plum', bg: '#221c2a', fg: '#ece6f2', accent: '#c4a2e8' },
  { id: 'nord-dark', name: 'Nord', bg: '#2e3440', fg: '#eceff4', accent: '#88c0d0' },
  { id: 'webnovel-dark', name: 'Slate', bg: '#23272e', fg: '#e2e8f0', accent: '#ffffff' },
  { id: 'webnovel-ocean', name: 'Midnight', bg: '#0f172a', fg: '#cbd5e1', accent: '#38bdf8' },
  { id: 'oled-blackout', name: 'True Black', bg: '#000000', fg: '#c9d1d9', accent: '#ffffff' },
  { id: 'monochrome-light', name: 'Light', bg: '#ffffff', fg: '#1f2328', accent: '#000000' },
  { id: 'webnovel-paper', name: 'Paper', bg: '#f8f4e6', fg: '#2c2c2c', accent: '#3e3428' },
  { id: 'sepia-parchment', name: 'Sepia', bg: '#f7f1e5', fg: '#2d261e', accent: '#8b5a2b' },
  { id: 'webnovel-mint', name: 'Mint', bg: '#e8f5e9', fg: '#1b4332', accent: '#1b4332' }
];

// Reading fonts (ids match the [data-font] rules in brutalist.css)
const FONTS = [
  { id: 'times', name: 'Times New Roman' },
  { id: 'merriweather', name: 'Merriweather' },
  { id: 'georgia', name: 'Georgia' },
  { id: 'palatino', name: 'Palatino' },
  { id: 'lora', name: 'Lora' },
  { id: 'ptserif', name: 'PT Serif' },
  { id: 'sans', name: 'Clean Sans' },
  { id: 'roboto', name: 'Roboto' },
  { id: 'opensans', name: 'Open Sans' },
  { id: 'lato', name: 'Lato' },
  { id: 'mono', name: 'Monospace' },
  { id: 'dyslexic', name: 'Dyslexic' }
];

function themeById(id) {
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === 'monochrome-dark');
}

// Listening and reading time, chapters finished, per local day. Device only (no server), 120 days kept.
const ReadingStats = {
  KEY: 'byob_stats_v1',
  KEEP_DAYS: 120,
  TICK_MS: 15000,
  IDLE_MS: 60000,
  _lastActivity: 0,
  _timer: null,
  _lastTick: 0,

  dayKey(d = new Date()) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },

  load() {
    try {
      const data = JSON.parse(localStorage.getItem(this.KEY) || '{}');
      if (data && typeof data === 'object' && data.days && typeof data.days === 'object') return data;
    } catch (e) {}
    return { days: {} };
  },

  save(data) {
    const keys = Object.keys(data.days).sort();
    while (keys.length > this.KEEP_DAYS) delete data.days[keys.shift()];
    try { localStorage.setItem(this.KEY, JSON.stringify(data)); } catch (e) {}
  },

  add(field, amount) {
    if (!amount) return;
    const data = this.load();
    const k = this.dayKey();
    const day = data.days[k] || (data.days[k] = { listen: 0, read: 0, chapters: 0 });
    day[field] = Math.round(((day[field] || 0) + amount) * 10) / 10;
    this.save(data);
  },

  chapterFinished() {
    this.add('chapters', 1);
  },

  isListening() {
    return typeof TTSEngine !== 'undefined' && TTSEngine.isPlaying && !TTSEngine.isPaused;
  },

  isReading() {
    return App.currentView === 'reader' && document.visibilityState === 'visible'
      && Date.now() - this._lastActivity < this.IDLE_MS;
  },

  // One cheap timer: every 15 s, credit the time since the last tick to listening or reading (never both)
  start() {
    if (this._timer) return;
    const mark = () => { this._lastActivity = Date.now(); };
    ['scroll', 'touchstart', 'pointerdown', 'keydown', 'wheel'].forEach(ev =>
      window.addEventListener(ev, mark, { passive: true, capture: true }));
    this._lastTick = Date.now();
    this._timer = setInterval(() => {
      const now = Date.now();
      const secs = Math.min(60, (now - this._lastTick) / 1000);
      this._lastTick = now;
      if (this.isListening()) this.add('listen', secs);
      else if (this.isReading()) this.add('read', secs);
    }, this.TICK_MS);
  },

  summary() {
    const days = this.load().days;
    const today = days[this.dayKey()] || {};
    let week = 0, weekListen = 0, chapters = 0;
    const d = new Date();
    for (let i = 0; i < 7; i++) {
      const x = days[this.dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i))];
      if (x) { week += (x.listen || 0) + (x.read || 0); weekListen += (x.listen || 0); }
    }
    Object.values(days).forEach(x => { chapters += x.chapters || 0; });
    // Streak: consecutive days with at least a minute, counting back from today (or yesterday if today is empty)
    const active = (x) => x && ((x.listen || 0) + (x.read || 0) >= 60 || (x.chapters || 0) > 0);
    let streak = 0;
    let offset = active(today) ? 0 : 1;
    for (; offset < this.KEEP_DAYS; offset++) {
      const x = days[this.dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset))];
      if (!active(x)) break;
      streak++;
    }
    return {
      todaySeconds: (today.listen || 0) + (today.read || 0),
      weekSeconds: week, weekListenSeconds: weekListen, streak, chapters
    };
  },

  formatMinutes(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  },

  render() {
    const s = this.summary();
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('statsToday', this.formatMinutes(s.todaySeconds));
    set('statsWeek', this.formatMinutes(s.weekSeconds));
    set('statsStreak', s.streak === 1 ? '1 day' : `${s.streak} days`);
    set('statsChapters', String(s.chapters));
    set('statsSplit', s.weekSeconds >= 60
      ? `Last 7 days: ${this.formatMinutes(s.weekListenSeconds)} listening, ${this.formatMinutes(s.weekSeconds - s.weekListenSeconds)} reading`
      : 'Time counts while narration plays or while you read and scroll.');
  }
};
window.ReadingStats = ReadingStats;

const App = {
  // Server backup plus any book only this device still has (never drops anything either side holds)
  mergeBackupForExport(serverData, mirror) {
    const hasBooks = (d) => d && Array.isArray(d.novels) && d.novels.length > 0;
    if (!hasBooks(mirror)) return serverData;
    if (!hasBooks(serverData)) return { ...mirror, exported_at: new Date().toISOString() };
    const out = { ...serverData };
    const have = new Set(serverData.novels.map(n => n.id));
    const extra = new Set(mirror.novels.filter(n => !have.has(n.id)).map(n => n.id));
    if (!extra.size) return out;
    const add = (key) => {
      out[key] = [...(serverData[key] || []), ...((mirror[key] || []).filter(r => extra.has(r.novel_id)))];
    };
    out.novels = [...serverData.novels, ...mirror.novels.filter(n => extra.has(n.id))];
    add('volumes');
    add('chapters');
    add('progress');
    return out;
  },

  currentView: 'library',
  novels: [],
  searchQuery: '',
  selectedUploadFiles: [],
  targetUploadNovelId: null,
  targetCoverNovelId: null,
  debounceSyncTimeout: null,
  _wakePoller: null,

  debounceSyncSettings() {
    if (this.debounceSyncTimeout) clearTimeout(this.debounceSyncTimeout);
    this.debounceSyncTimeout = setTimeout(() => {
      SyncService.syncSettings(window.ReaderSettings);
    }, 350);
  },

  pollServerWakeUp() {
    if (this._wakePoller) return;
    let attempts = 0;
    this._wakePoller = setInterval(async () => {
      attempts++;
      if (attempts > 30) {
        clearInterval(this._wakePoller);
        this._wakePoller = null;
        return;
      }
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(this._wakePoller);
          this._wakePoller = null;
          console.log('[WakeUp] Backend server is now online!');
          SyncService.isOnline = true;
          await SyncService.init();
          SyncService.updateStatus('synced', 'ONLINE');
          await this.loadLibrary(false);
          SyncService.flushOfflineQueue();
        }
      } catch (e) {}
    }, 4000);
  },

  // A new version arrived. Reloading mid-chapter would silence read aloud, so wait until the listener stops it.
  reloadForUpdate() {
    if (window.TTSEngine && TTSEngine.isPlaying) {
      window.__reloadWhenIdle = true;
      this.showToast('Update ready. It will install when you stop read aloud.');
      return;
    }
    window.location.reload();
  },

  async init() {

    try {
      // 1. Initialize reading engines first
      AutoScroll.init(() => Reader.loadNextChapter());
      TTSEngine.init(() => Reader.loadNextChapter());
      Reader.init();

      // Theme swatches and font chips come from THEMES / FONTS, so build them before settings mark the selection
      this.renderAppearancePickers();
      ReadingStats.start();

      // 2. Load locally cached settings first for instant zero-flicker render
      const localSettings = Storage.getLocalSettings();
      if (localSettings && Object.keys(localSettings).length > 0) {
        this.applySettings(localSettings, false);
      } else {
        this.applySettings(window.ReaderSettings, false);
      }

      this.bindGlobalEvents();
      this.bindMasterPanelEvents();
      this.bindSettingsEvents();
      this.bindMobileQuickSheetEvents();
      this.bindLibraryToolbarEvents();
      this.bindSyncEvents();
      this.bindBackupRestoreEvents();
      this.bindNovelSettingsModalEvents();
      this.bindNetworkEvents();

      // Register Service Worker for Mobile PWA Offline Reading
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then((reg) => {
          console.log('[SW] ServiceWorker registered with scope:', reg.scope);
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
          reg.onupdatefound = () => {
            const installing = reg.installing;
            if (installing) {
              installing.onstatechange = () => {
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[SW] New version installed, reloading...');
                  App.reloadForUpdate();
                }
              };
            }
          };
        }).catch((err) => {
          console.warn('[SW] ServiceWorker registration failed:', err);
        });

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!refreshing) {
            refreshing = true;
            App.reloadForUpdate();
          }
        });
      }

      // 3. Connect to sync service & fetch cloud account settings (instant local fallback if offline)
      const session = await SyncService.init();
      if (session && session.settings && Object.keys(session.settings).length > 0) {
        const server = SyncService.expandSettings(session.settings);
        // Read again: pairing a link (?pair=) during init resets the local stamp so the account's settings win
        const localNow = Storage.getLocalSettings();
        if (localNow && Object.keys(localNow).length > 0) {
          // Newest change wins: a setting changed on the phone shows up on the computer and the other way round
          const serverMs = (server.updated_at || 0) * 1000;
          if (serverMs > (localNow.changed_at || 0) + 1000) {
            this.adoptServerSettings(server);
          } else {
            const merged = { ...server, ...localNow };
            delete merged.user_id;
            this.applySettings(merged, false);
            SyncService.syncSettings(merged, true);
          }
        } else {
          this.adoptServerSettings(server);
        }
      }

      // 4. Render library from local storage or cloud
      await this.loadLibrary();

      // If server was offline or timed out, background poll for Render wake-up
      if (!SyncService.isOnline || SyncService.currentSyncKey === 'OFFLINE') {
        this.pollServerWakeUp();
      }
    } catch (err) {
      console.warn('App init exception, falling back to local library:', err);
      try {
        await this.loadLibrary();
      } catch {}
      this.pollServerWakeUp();
    } finally {
      this.hideLoading();
    }
  },

  bindGlobalEvents() {
    document.getElementById('logoBtn').addEventListener('click', (e) => {
      handleGoToLibrary(e);
    });

    const handleGoToLibrary = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      try {
        if (typeof Reader !== 'undefined' && Reader.flushPendingProgress) {
          Reader.flushPendingProgress();
        }
      } catch (err) {
        console.warn('Reader.flushPendingProgress warning:', err);
      }
      try {
        if (typeof AutoScroll !== 'undefined' && AutoScroll.stop) AutoScroll.stop();
      } catch (err) {
        console.warn('AutoScroll.stop warning:', err);
      }
      try {
        if (typeof TTSEngine !== 'undefined' && TTSEngine.stop) TTSEngine.stop();
      } catch (err) {
        console.warn('TTSEngine.stop warning:', err);
      }
      try {
        this.closeMasterPanel();
      } catch (err) {}
      try {
        this.closeMobileQuickSheet();
      } catch (err) {}

      this.switchView('library');
      this.loadLibrary().catch(err => console.warn('loadLibrary warning:', err));
    };

    const backToLib = document.getElementById('backToLibraryBtn');
    if (backToLib) backToLib.addEventListener('click', handleGoToLibrary);

    const drawerBackToLib = document.getElementById('drawerBackToLibraryBtn');
    if (drawerBackToLib) drawerBackToLib.addEventListener('click', handleGoToLibrary);

    const footerLib = document.getElementById('footerLibraryBtn');
    if (footerLib) footerLib.addEventListener('click', handleGoToLibrary);

    // Master Panel Triggers
    document.getElementById('headerMenuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMasterPanel('tabSync');
    });
    document.getElementById('readerMenuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMasterPanel('tabChapters');
    });
    document.getElementById('footerMenuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMasterPanel('tabChapters');
    });
    document.getElementById('floatingQuickMenuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMasterPanel('tabChapters');
    });

    const chTitleBtn = document.getElementById('readerChapterTitle');
    if (chTitleBtn) {
      chTitleBtn.style.cursor = 'pointer';
      chTitleBtn.title = 'Open Chapters Menu';
      chTitleBtn.addEventListener('click', () => this.openMasterPanel('tabChapters'));
    }

    document.getElementById('readerAutoScrollBtn').addEventListener('click', () => {
      if (AutoScroll.isActive) {
        AutoScroll.stop();
      } else {
        this.openMasterPanel('tabScroll');
      }
    });

    document.getElementById('readerTTSBtn').addEventListener('click', () => {
      if (TTSEngine.isPlaying) {
        TTSEngine.stop();
      } else {
        this.openMasterPanel('tabTTS');
      }
    });

    document.getElementById('drawerBackdrop').addEventListener('click', () => {
      this.closeMasterPanel();
    });

    // Auto-Scroll Pill Controls
    document.getElementById('autoscrollPauseBtn').addEventListener('click', () => {
      if (AutoScroll.isPaused) {
        AutoScroll.isPaused = false;
        AutoScroll.lastFrameTime = performance.now();
        AutoScroll.updatePillUI();
        AutoScroll.loop();
      } else {
        AutoScroll.isPaused = true;
        AutoScroll.updatePillUI();
      }
    });
    document.getElementById('autoscrollSpeedDown').addEventListener('click', () => AutoScroll.changeSpeed(-5));
    document.getElementById('autoscrollSpeedUp').addEventListener('click', () => AutoScroll.changeSpeed(5));
    document.getElementById('autoscrollCloseBtn').addEventListener('click', () => AutoScroll.stop());

    // TTS Pill Controls (Legacy fallback)
    const ttsPause = document.getElementById('ttsPauseBtn');
    if (ttsPause) {
      ttsPause.addEventListener('click', () => {
        if (TTSEngine.isPaused) TTSEngine.resume();
        else TTSEngine.pause();
      });
    }
    const ttsClose = document.getElementById('ttsCloseBtn');
    if (ttsClose) ttsClose.addEventListener('click', () => TTSEngine.stop());
    const ttsPrev = document.getElementById('ttsPrevBtn');
    if (ttsPrev) ttsPrev.addEventListener('click', () => TTSEngine.prevParagraph());
    const ttsNext = document.getElementById('ttsNextBtn');
    if (ttsNext) ttsNext.addEventListener('click', () => TTSEngine.nextParagraph());

    // Upload Modal Trigger
    document.getElementById('uploadNovelBtn').addEventListener('click', () => this.openUploadModal());
    document.getElementById('closeUploadModalBtn').addEventListener('click', () => this.closeUploadModal());
    document.getElementById('cancelUploadBtn').addEventListener('click', () => this.closeUploadModal());

    // Upload Dropzone
    const dropzone = document.getElementById('epubDropzone');
    const fileInput = document.getElementById('epubFileInput');
    const addMoreBtn = document.getElementById('addMoreFilesBtn');

    const triggerFilePicker = (forceAppend = false) => {
      fileInput.value = '';
      this.uploadAppendMode = forceAppend || (this.selectedUploadFiles && this.selectedUploadFiles.length > 0);
      fileInput.click();
    };

    if (addMoreBtn) {
      addMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerFilePicker(true);
      });
    }

    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('#addMoreFilesBtn')) return;
      triggerFilePicker();
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent)';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'var(--border-color)';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border-color)';
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        const shouldAppend = (this.selectedUploadFiles && this.selectedUploadFiles.length > 0);
        this.handleSelectedFiles(e.dataTransfer.files, shouldAppend);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        const shouldAppend = this.uploadAppendMode || (this.selectedUploadFiles && this.selectedUploadFiles.length > 0);
        this.handleSelectedFiles(e.target.files, shouldAppend);
        this.uploadAppendMode = false;
        fileInput.value = '';
      }
    });

    document.getElementById('startUploadBtn').addEventListener('click', () => this.performUpload());

    // Custom cover picture (Book Settings > Change Cover, or tapping a cover)
    const coverInput = document.getElementById('novelCoverInput');
    if (coverInput) {
      coverInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        const targetId = this.targetCoverNovelId;
        if (!file || !targetId) return;
        this.showLoading('Updating cover...');
        try {
          const dataUrl = await this.readCoverFile(file);
          const onServer = await this.applyCover(targetId, dataUrl);
          this.hideLoading();
          this.showToast(onServer ? 'Cover updated' : 'Cover saved on this device; it will sync when the server is back');
        } catch (err) {
          this.hideLoading();
          alert('Could not use that picture: ' + (err && err.message ? err.message : err));
        } finally {
          coverInput.value = '';
        }
      });
    }

    // Optional cover picture in the upload form
    const uploadCoverInput = document.getElementById('uploadCoverInput');
    if (uploadCoverInput) {
      uploadCoverInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          this.pendingUploadCover = await this.readCoverFile(file);
          this.renderUploadCoverPreview();
        } catch (err) {
          alert('Could not use that picture: ' + (err && err.message ? err.message : err));
        } finally {
          uploadCoverInput.value = '';
        }
      });
    }
    const uploadCoverPick = document.getElementById('uploadCoverPickBtn');
    if (uploadCoverPick) uploadCoverPick.addEventListener('click', () => uploadCoverInput && uploadCoverInput.click());
    const uploadCoverClear = document.getElementById('uploadCoverClearBtn');
    if (uploadCoverClear) uploadCoverClear.addEventListener('click', () => { this.pendingUploadCover = null; this.renderUploadCoverPreview(); });
  },

  // Reads a picture file and shrinks it to at most 480x720 JPEG (about 40-80 KB), sharp on phone screens.
  readCoverFile(file) {
    return new Promise((resolve, reject) => {
      if (!file.type || !file.type.startsWith('image/')) { reject(new Error('Pick a picture file (JPG, PNG, WebP).')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the picture.'));
      reader.onload = (ev) => {
        const raw = ev.target.result;
        const img = new Image();
        img.onerror = () => (raw.length < 5.5 * 1024 * 1024 ? resolve(raw) : reject(new Error('That picture is too big.')));
        img.onload = () => {
          try {
            const ratio = Math.min(480 / img.width, 720 / img.height, 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * ratio));
            canvas.height = Math.max(1, Math.round(img.height * ratio));
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } catch (_) {
            resolve(raw);
          }
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    });
  },

  // Saves a cover on this device right away, then on the server. Returns true when the server has it.
  async applyCover(novelId, dataUrl) {
    if (typeof Storage !== 'undefined' && Storage.setNovelCover) Storage.setNovelCover(novelId, dataUrl);
    try { localStorage.setItem('byob_cover_pending_' + novelId, '1'); } catch (_) {}
    const novel = (this.novels || []).find(n => n.id === novelId);
    if (novel) { novel.cover_data = dataUrl; novel.has_cover = true; }
    const uid = (window.SyncService && SyncService.currentUserId) || (window.Storage && Storage.getUserId()) || 'guest';
    if (typeof IDB !== 'undefined' && IDB.updateCoverInMirror) {
      try { await IDB.updateCoverInMirror(uid, novelId, dataUrl); } catch (_) {}
    }
    this.renderLibraryGrid();
    if (this.lastReadNovelId === novelId) {
      const resumeCover = document.getElementById('resumeCover');
      if (resumeCover) resumeCover.src = dataUrl;
      const backdrop = document.getElementById('resumeBackdrop');
      if (backdrop) backdrop.style.backgroundImage = `url("${dataUrl}")`;
    }
    return this.pushCoverToServer(novelId, dataUrl, uid);
  },

  async pushCoverToServer(novelId, dataUrl, uid) {
    try {
      const res = await fetch('/api/novels/cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: novelId, user_id: uid, cover_data: dataUrl, sync_key: (window.Storage && Storage.getSyncKey && Storage.getSyncKey()) || '' })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.success !== false) {
        try { localStorage.removeItem('byob_cover_pending_' + novelId); } catch (_) {}
        return true;
      }
      console.warn('Cover not saved on server:', res.status, data);
    } catch (err) {
      console.warn('Cover upload offline, kept on this device:', err);
    }
    return false;
  },

  // A cover changed while offline stays on this device until the server takes it.
  coverFor(n) {
    let pending = false;
    try { pending = localStorage.getItem('byob_cover_pending_' + n.id) === '1'; } catch (_) {}
    const local = typeof Storage !== 'undefined' && Storage.getNovelCover ? Storage.getNovelCover(n.id) : null;
    return (pending && local) || n.cover_data || local || FALLBACK_COVER;
  },

  retryPendingCovers() {
    const uid = (window.SyncService && SyncService.currentUserId) || 'guest';
    (this.novels || []).forEach(n => {
      let pending = false;
      try { pending = localStorage.getItem('byob_cover_pending_' + n.id) === '1'; } catch (_) {}
      const local = pending && Storage.getNovelCover(n.id);
      if (local) this.pushCoverToServer(n.id, local, uid);
    });
  },

  renderUploadCoverPreview() {
    const img = document.getElementById('uploadCoverPreview');
    const empty = document.getElementById('uploadCoverEmpty');
    const clear = document.getElementById('uploadCoverClearBtn');
    const pick = document.getElementById('uploadCoverPickBtn');
    const has = !!this.pendingUploadCover;
    if (img) { img.src = has ? this.pendingUploadCover : ''; img.style.display = has ? 'block' : 'none'; }
    if (empty) empty.style.display = has ? 'none' : 'flex';
    if (clear) clear.style.display = has ? 'inline-flex' : 'none';
    if (pick) pick.textContent = has ? 'Change picture' : 'Choose picture';
  },

  bindMasterPanelEvents() {
    document.getElementById('closeMasterPanelBtn').addEventListener('click', () => this.closeMasterPanel());

    // Tab buttons
    document.querySelectorAll('.master-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        this.switchMasterTab(targetTab);
      });
    });

    // Tab 2: Audio / TTS
    document.getElementById('ttsPlayToggleBtn').addEventListener('click', () => {
      if (typeof TTSEngine !== 'undefined') {
        TTSEngine.toggle();
        this.closeMasterPanel();
      }
    });

    document.getElementById('testVoiceBtn').addEventListener('click', () => {
      TTSEngine.testVoice();
    });

    document.querySelectorAll('.sleep-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sleep-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const mode = btn.getAttribute('data-sleep');
        TTSEngine.setSleepTimer(mode);
      });
    });

    // Tab 3: Auto-Scroll
    const panelScrollBtn = document.getElementById('panelAutoScrollToggleBtn');
    if (panelScrollBtn) {
      panelScrollBtn.addEventListener('click', () => {
        AutoScroll.toggle();
        this.closeMasterPanel();
      });
    }

    const scrollSlider = document.getElementById('panelScrollSpeedSlider');
    if (scrollSlider) {
      scrollSlider.addEventListener('input', (e) => {
        const speed = parseInt(e.target.value);
        AutoScroll.setSpeed(speed);
        document.getElementById('panelScrollSpeedVal').textContent = `${speed} px/s`;
        this.applySettings({ auto_scroll_speed: speed });
      });
    }

    // Tab 1: Chapters TOC Search
    const tocSearch = document.getElementById('tocSearchInput');
    if (tocSearch) {
      tocSearch.addEventListener('input', (e) => Reader.filterTOC(e.target.value));
    }

    // Tab 5: Panel Upload Button
    const panelUpload = document.getElementById('panelUploadBtn');
    if (panelUpload) {
      panelUpload.addEventListener('click', () => {
        this.closeMasterPanel();
        this.openUploadModal();
      });
    }
  },

  openMasterPanel(tabName = null) {
    try {
      if (!Reader.currentNovel && Reader.currentChapter) {
        Reader.currentNovel = {
          id: Reader.currentChapter.novel_id,
          title: Reader.currentChapter.novel_title || 'Novel'
        };
      }

      const isReading = this.currentView === 'reader' && (Reader.currentNovel || Reader.currentChapter);
      const titleEl = document.getElementById('masterPanelTitle');
      const subtitleEl = document.getElementById('masterPanelSubtitle');
      const bookTabs = document.querySelectorAll('.master-tab-btn.book-tab');

      if (isReading) {
        // In-Book Context
        const nTitle = (Reader.currentNovel && Reader.currentNovel.title) || (Reader.currentChapter && Reader.currentChapter.novel_title) || 'Reading';
        if (titleEl) titleEl.textContent = nTitle;
        if (Reader.currentChapter && subtitleEl) {
          subtitleEl.style.display = 'block';
          const vTitle = Reader.currentChapter.volume_title || `Volume ${Reader.currentChapter.volume_number || 1}`;
          subtitleEl.textContent = `${vTitle} · ${Reader.currentChapter.title || ''}`;
        } else if (subtitleEl) {
          subtitleEl.style.display = 'none';
        }
        bookTabs.forEach(t => t.style.display = 'block');
        if (!tabName) tabName = 'tabChapters';
      } else {
        // Library / Main Menu Context: Hide book options
        if (titleEl) titleEl.textContent = 'Library Menu';
        if (subtitleEl) subtitleEl.style.display = 'none';
        bookTabs.forEach(t => t.style.display = 'none');
        if (!tabName || tabName === 'tabChapters' || tabName === 'tabTTS' || tabName === 'tabScroll') {
          tabName = 'tabSync';
        }
      }

      this.switchMasterTab(tabName);

      const ttsBtn = document.getElementById('ttsPlayToggleBtn');
      if (ttsBtn) {
        ttsBtn.textContent = (TTSEngine.isPlaying && !TTSEngine.isPaused) ? 'Pause Read Aloud' : 'Start Read Aloud';
      }

      const panel = document.getElementById('masterSidePanel');
      const backdrop = document.getElementById('drawerBackdrop');
      if (panel) panel.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      if (typeof AutoScroll !== 'undefined' && AutoScroll.isActive) {
        AutoScroll.pauseForMenu();
      }
      this.updateSyncDisplay();

      // Center on active chapter if opening chapters tab from within a book
      if (tabName === 'tabChapters' && isReading && Reader && typeof Reader.centerActiveChapterInTOC === 'function') {
        try {
          Reader.centerActiveChapterInTOC();
        } catch (tocErr) {
          console.warn('Could not center active chapter in TOC:', tocErr);
        }
      }
    } catch (err) {
      console.warn('openMasterPanel error, forcing panel display:', err);
      const panel = document.getElementById('masterSidePanel');
      const backdrop = document.getElementById('drawerBackdrop');
      if (panel) panel.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
    }
  },

  closeMasterPanel() {
    document.getElementById('masterSidePanel').classList.remove('open');
    document.getElementById('drawerBackdrop').classList.remove('open');
    if (typeof AutoScroll !== 'undefined' && AutoScroll.menuPaused) {
      AutoScroll.resumeFromMenu();
    }
  },

  toggleMasterPanel(tabName = null) {
    const panel = document.getElementById('masterSidePanel');
    if (panel.classList.contains('open')) {
      this.closeMasterPanel();
    } else {
      this.openMasterPanel(tabName);
    }
  },

  switchMasterTab(tabId) {
    document.querySelectorAll('.master-tab-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.master-tab-content').forEach(c => {
      c.classList.toggle('active', c.id === tabId);
    });

    if (tabId === 'tabPrefs') ReadingStats.render();
    if (tabId === 'tabTTS' && typeof TTSEngine !== 'undefined' && TTSEngine.updateEngineUI) TTSEngine.updateEngineUI();

    // Auto-center TOC on active reading chapter whenever the Chapters tab is selected
    if (tabId === 'tabChapters' && this.currentView === 'reader' && Reader.currentNovel) {
      Reader.centerActiveChapterInTOC();
    }
  },

  updateAutoScrollUI() {
    if (typeof AutoScroll === 'undefined') return;
    const isAct = !!AutoScroll.isActive;
    const bar = document.getElementById('quickSheetAutoScrollActiveBar');
    const autoScrollTile = document.getElementById('quickSheetAutoScrollBtn');
    const autoScrollText = document.getElementById('quickSheetAutoScrollText');
    const speedVal = document.getElementById('quickSheetAutoScrollSpeedVal');
    const speedDisplay = document.getElementById('quickSheetAutoScrollSpeedDisplay');
    const speedSlider = document.getElementById('quickSheetAutoScrollSpeedSlider');

    if (bar) {
      bar.style.display = isAct ? 'flex' : 'none';
    }
    if (autoScrollTile) {
      autoScrollTile.classList.toggle('active', isAct);
    }
    if (autoScrollText) {
      autoScrollText.textContent = isAct ? 'Scrolling' : 'Auto-Scroll';
    }
    if (speedVal) {
      speedVal.textContent = `${AutoScroll.speed} px/s`;
    }
    if (speedDisplay) {
      speedDisplay.textContent = `${AutoScroll.speed} px/s`;
    }
    if (speedSlider) {
      speedSlider.value = AutoScroll.speed;
    }
  },

  openMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (!sheet || !backdrop) return;

    if (typeof AutoScroll !== 'undefined' && AutoScroll.isActive) {
      AutoScroll.pauseForMenu();
    }

    // Ensure state displays are fresh
    const cur = window.ReaderSettings;
    const fontVal = document.getElementById('quickSheetFontVal');
    if (fontVal) fontVal.textContent = `${cur.font_size || 19}px`;

    const lineVal = document.getElementById('quickSheetLineVal');
    if (lineVal) lineVal.textContent = (cur.line_height || 1.85).toFixed(2);

    const letterVal = document.getElementById('quickSheetLetterVal');
    if (letterVal) letterVal.textContent = `${(cur.letter_spacing || 0).toFixed(1)}px`;

    const marginVal = document.getElementById('quickSheetMarginVal');
    if (marginVal) {
      const labels = { edge: 'Edge', compact: 'Compact', comfortable: 'Relaxed' };
      marginVal.textContent = labels[cur.margin_width || 'edge'] || 'Edge';
    }

    this.updateAppearancePickers(cur);
    if (typeof TTSEngine !== 'undefined' && typeof TTSEngine.updateEngineUI === 'function') {
      TTSEngine.updateEngineUI();
    }

    const ttsText = document.getElementById('quickSheetTTSText');
    if (ttsText && typeof TTSEngine !== 'undefined') {
      ttsText.textContent = (TTSEngine.isPlaying && !TTSEngine.isPaused) ? 'Pause' : 'Read Aloud';
    }

    this.updateAutoScrollUI();

    // Show narration speed only when narration is active (playing or paused)
    const isAudioActive = typeof TTSEngine !== 'undefined' && (TTSEngine.isPlaying || TTSEngine.isPaused);
    const qsSpeedRow = document.getElementById('quickSheetSpeedRow');
    if (qsSpeedRow) {
      qsSpeedRow.style.display = isAudioActive ? 'flex' : 'none';
    }

    // Synchronize Bionic Reading state in quick sheet
    const isBionic = !!(window.ReaderSettings && window.ReaderSettings.bionic_reading);
    const qsBionicBtn = document.getElementById('quickSheetBionicBtn');
    const qsBionicStatus = document.getElementById('quickSheetBionicStatus');
    if (qsBionicBtn) {
      qsBionicBtn.classList.toggle('active', isBionic);
      qsBionicBtn.setAttribute('aria-pressed', isBionic ? 'true' : 'false');
    }
    if (qsBionicStatus) {
      qsBionicStatus.textContent = isBionic ? 'ON' : 'OFF';
    }
    const qsBionicToggle = document.getElementById('quickSheetBionicToggle');
    if (qsBionicToggle) {
      qsBionicToggle.checked = isBionic;
    }
    if (window.Reader && window.Reader.applyBionicSettings) {
      window.Reader.applyBionicSettings();
    }
    const qsBionicSliderRow = document.getElementById('quickBionicSliderRow');
    if (qsBionicSliderRow) {
      qsBionicSliderRow.style.opacity = isBionic ? '1' : '0.65';
    }

    // Update speed slider and chips in quick sheet
    const qsSpeedSlider = document.getElementById('quickSheetSpeedSlider');
    if (typeof TTSEngine !== 'undefined' && typeof TTSEngine.syncRateUI === 'function') {
      TTSEngine.syncRateUI();
    }

    // Update chapter navigation buttons & title inside quick sheet
    const prevBtn = document.getElementById('quickSheetPrevChBtn');
    const nextBtn = document.getElementById('quickSheetNextChBtn');
    const chTitleEl = document.getElementById('quickSheetChapterTitle');
    const currentCh = window.Reader ? window.Reader.currentChapter : null;
    if (chTitleEl && currentCh) {
      const volNum = currentCh.volume_number || 1;
      const chNum = currentCh.chapter_index || currentCh.global_index || 1;
      chTitleEl.textContent = `Vol. ${volNum}, Chap. ${chNum}`;
    }
    this.updateQuickSheetChapterMeta();
    if (prevBtn) {
      const hasPrev = !!(currentCh && currentCh.prev_chapter);
      prevBtn.disabled = !hasPrev;
      prevBtn.style.opacity = hasPrev ? '1' : '0.4';
      prevBtn.style.cursor = hasPrev ? 'pointer' : 'default';
      prevBtn.title = hasPrev ? (currentCh.prev_chapter.title || 'Previous Chapter') : 'No Previous Chapter';
    }
    if (nextBtn) {
      const hasNext = !!(currentCh && currentCh.next_chapter);
      nextBtn.disabled = !hasNext;
      nextBtn.style.opacity = hasNext ? '1' : '0.4';
      nextBtn.style.cursor = hasNext ? 'pointer' : 'default';
      nextBtn.title = hasNext ? (currentCh.next_chapter.title || 'Next Chapter') : 'No Next Chapter';
    }

    // Hide floating action buttons and top bar so they never overlap or clash with the sheet
    const floatBar = document.getElementById('readerFloatingBar');
    const floatBtn = document.getElementById('floatingQuickMenuBtn');
    const topBar = document.getElementById('readerTopBar');
    if (floatBar) floatBar.style.display = 'none';
    if (floatBtn) floatBtn.style.display = 'none';
    if (topBar) topBar.classList.add('minimized');

    sheet.classList.add('open');
    backdrop.classList.add('open');
    requestAnimationFrame(() => this.scrollPickersToSelection());
  },

  closeMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (sheet) sheet.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');

    if (typeof AutoScroll !== 'undefined' && AutoScroll.menuPaused) {
      AutoScroll.resumeFromMenu();
    }

    // Restore floating controls smoothly
    const floatBar = document.getElementById('readerFloatingBar');
    const floatBtn = document.getElementById('floatingQuickMenuBtn');
    if (floatBar) floatBar.style.display = '';
    if (floatBtn) floatBtn.style.display = '';
  },

  toggleMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    if (sheet && sheet.classList.contains('open')) {
      this.closeMobileQuickSheet();
    } else {
      this.openMobileQuickSheet();
    }
  },

  bindMobileQuickSheetEvents() {
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.closeMobileQuickSheet());
    }

    const chaptersBtn = document.getElementById('quickSheetChaptersBtn');
    if (chaptersBtn) {
      chaptersBtn.addEventListener('click', () => {
        this.closeMobileQuickSheet();
        this.openMasterPanel('tabChapters');
      });
    }

    const prevChBtn = document.getElementById('quickSheetPrevChBtn');
    if (prevChBtn) {
      prevChBtn.addEventListener('click', () => {
        if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.prev_chapter) {
          this.closeMobileQuickSheet();
          window.Reader.loadPrevChapter(false, true);
        }
      });
    }

    const nextChBtn = document.getElementById('quickSheetNextChBtn');
    if (nextChBtn) {
      nextChBtn.addEventListener('click', () => {
        if (window.Reader && window.Reader.currentChapter && window.Reader.currentChapter.next_chapter) {
          this.closeMobileQuickSheet();
          window.Reader.loadNextChapter(false);
        }
      });
    }

    const ttsBtn = document.getElementById('quickSheetTTSBtn');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', () => {
        this.closeMobileQuickSheet();
        if (typeof TTSEngine !== 'undefined') {
          TTSEngine.toggle();
        }
      });
    }

    const autoScrollBtn = document.getElementById('quickSheetAutoScrollBtn');
    if (autoScrollBtn) {
      autoScrollBtn.addEventListener('click', () => {
        if (typeof AutoScroll !== 'undefined') {
          AutoScroll.toggle();
          this.updateAutoScrollUI();
        }
      });
    }

    const autoScrollStopBtn = document.getElementById('quickSheetAutoScrollStopBtn');
    if (autoScrollStopBtn) {
      autoScrollStopBtn.addEventListener('click', () => {
        if (typeof AutoScroll !== 'undefined') {
          AutoScroll.stop();
          this.updateAutoScrollUI();
        }
      });
    }

    const autoScrollSlowBtn = document.getElementById('quickSheetAutoScrollSlowBtn');
    if (autoScrollSlowBtn) {
      autoScrollSlowBtn.addEventListener('click', () => {
        if (typeof AutoScroll !== 'undefined') {
          AutoScroll.changeSpeed(-5);
          this.updateAutoScrollUI();
        }
      });
    }

    const autoScrollFastBtn = document.getElementById('quickSheetAutoScrollFastBtn');
    if (autoScrollFastBtn) {
      autoScrollFastBtn.addEventListener('click', () => {
        if (typeof AutoScroll !== 'undefined') {
          AutoScroll.changeSpeed(5);
          this.updateAutoScrollUI();
        }
      });
    }

    const autoScrollSlider = document.getElementById('quickSheetAutoScrollSpeedSlider');
    if (autoScrollSlider) {
      autoScrollSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && typeof AutoScroll !== 'undefined') {
          AutoScroll.setSpeed(val);
          this.updateAutoScrollUI();
        }
      });
    }


    const fontDownBtn = document.getElementById('quickSheetFontDown');
    if (fontDownBtn) {
      fontDownBtn.addEventListener('click', () => {
        const curSize = parseInt(window.ReaderSettings.font_size || 19);
        const newSize = Math.max(12, curSize - 1);
        this.applySettings({ font_size: newSize });
      });
    }

    const fontUpBtn = document.getElementById('quickSheetFontUp');
    if (fontUpBtn) {
      fontUpBtn.addEventListener('click', () => {
        const curSize = parseInt(window.ReaderSettings.font_size || 19);
        const newSize = Math.min(36, curSize + 1);
        this.applySettings({ font_size: newSize });
      });
    }

    const lineDownBtn = document.getElementById('quickSheetLineDown');
    if (lineDownBtn) {
      lineDownBtn.addEventListener('click', () => {
        const curLh = parseFloat(window.ReaderSettings.line_height || 1.85);
        const newLh = Math.max(1.3, parseFloat((curLh - 0.1).toFixed(2)));
        this.applySettings({ line_height: newLh });
      });
    }

    const lineUpBtn = document.getElementById('quickSheetLineUp');
    if (lineUpBtn) {
      lineUpBtn.addEventListener('click', () => {
        const curLh = parseFloat(window.ReaderSettings.line_height || 1.85);
        const newLh = Math.min(2.6, parseFloat((curLh + 0.1).toFixed(2)));
        this.applySettings({ line_height: newLh });
      });
    }

    const letterDownBtn = document.getElementById('quickSheetLetterDown');
    if (letterDownBtn) {
      letterDownBtn.addEventListener('click', () => {
        const curLs = parseFloat(window.ReaderSettings.letter_spacing || 0);
        const newLs = Math.max(-0.5, parseFloat((curLs - 0.2).toFixed(1)));
        this.applySettings({ letter_spacing: newLs });
      });
    }

    const letterUpBtn = document.getElementById('quickSheetLetterUp');
    if (letterUpBtn) {
      letterUpBtn.addEventListener('click', () => {
        const curLs = parseFloat(window.ReaderSettings.letter_spacing || 0);
        const newLs = Math.min(2.5, parseFloat((curLs + 0.2).toFixed(1)));
        this.applySettings({ letter_spacing: newLs });
      });
    }

    const marginsBtn = document.getElementById('quickSheetMarginsBtn');
    if (marginsBtn) {
      marginsBtn.addEventListener('click', () => {
        const order = ['edge', 'compact', 'comfortable'];
        const curMargin = window.ReaderSettings.margin_width || 'edge';
        const nextIdx = (order.indexOf(curMargin) + 1) % order.length;
        const nextMargin = order[nextIdx];
        this.applySettings({ margin_width: nextMargin });
      });
    }

    const settingsBtn = document.getElementById('quickSheetSettingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.closeMobileQuickSheet();
        this.openMasterPanel('tabPrefs');
      });
    }

    const qsBionicBar = document.getElementById('quickSheetBionicBar');
    const qsBionicHeader = document.getElementById('quickBionicHeader');
    const qsBionicBtn = document.getElementById('quickSheetBionicBtn');
    const toggleQuickBionic = (e) => {
      if (e) e.stopPropagation();
      if (window.Reader && window.Reader.toggleBionicReading) {
        window.Reader.toggleBionicReading();
      }
    };
    if (qsBionicBtn) {
      qsBionicBtn.addEventListener('click', toggleQuickBionic);
    }
    if (qsBionicHeader) {
      qsBionicHeader.addEventListener('click', toggleQuickBionic);
    } else if (qsBionicBar) {
      qsBionicBar.addEventListener('click', toggleQuickBionic);
    }

    const bionicSliderRow = document.getElementById('quickBionicSliderRow');
    if (bionicSliderRow) {
      bionicSliderRow.addEventListener('click', (e) => e.stopPropagation());
    }

    const bionicSlider = document.getElementById('quickSheetBionicSlider');
    if (bionicSlider) {
      bionicSlider.addEventListener('click', (e) => e.stopPropagation());
      bionicSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        if (window.Reader && window.Reader.setBionicFixationSize) {
          window.Reader.setBionicFixationSize(e.target.value);
        }
      });
      bionicSlider.addEventListener('change', (e) => {
        e.stopPropagation();
        if (window.Reader && window.Reader.setBionicFixationSize) {
          window.Reader.setBionicFixationSize(e.target.value);
        }
      });
    }

    const qsStepper = document.getElementById('quickSheetBionicSizeStepper');
    if (qsStepper) {
      qsStepper.addEventListener('click', (e) => e.stopPropagation());
    }

    const qsBionicDown = document.getElementById('qsBionicSizeDown');
    if (qsBionicDown) {
      qsBionicDown.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.Reader && window.Reader.stepBionicFixationSize) {
          window.Reader.stepBionicFixationSize(-0.05);
        }
      });
    }

    const qsBionicUp = document.getElementById('qsBionicSizeUp');
    if (qsBionicUp) {
      qsBionicUp.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.Reader && window.Reader.stepBionicFixationSize) {
          window.Reader.stepBionicFixationSize(0.05);
        }
      });
    }

    const qsBionicToggle = document.getElementById('quickSheetBionicToggle');
    if (qsBionicToggle) {
      qsBionicToggle.addEventListener('change', (e) => {
        if (window.Reader && window.Reader.toggleBionicReading) {
          window.Reader.toggleBionicReading(e.target.checked);
        }
      });
    }


  },

  bindSettingsEvents() {
    const stdBtn = document.getElementById('panelModeStandardBtn');
    const bionicBtn = document.getElementById('panelModeBionicBtn');
    if (stdBtn) {
      stdBtn.addEventListener('click', () => {
        if (window.Reader && window.Reader.toggleBionicReading) {
          window.Reader.toggleBionicReading(false);
        }
      });
    }
    if (bionicBtn) {
      bionicBtn.addEventListener('click', () => {
        if (window.Reader && window.Reader.toggleBionicReading) {
          window.Reader.toggleBionicReading(true);
        }
      });
    }
    const panelBionicToggle = document.getElementById('panelBionicToggle');
    if (panelBionicToggle) {
      panelBionicToggle.addEventListener('change', (e) => {
        if (window.Reader && window.Reader.toggleBionicReading) {
          window.Reader.toggleBionicReading(e.target.checked);
        }
      });
    }

    document.querySelectorAll('.bionic-size-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const sz = btn.getAttribute('data-bionic-size');
        if (window.Reader && window.Reader.setBionicFixationSize) {
          window.Reader.setBionicFixationSize(sz);
        }
      });
    });
    // Theme swatches (quick sheet + Display tab) and quick-sheet font chips: one delegated listener each
    ['quickSheetThemeRow', 'prefsThemeGrid'].forEach(id => {
      const host = document.getElementById(id);
      if (!host) return;
      host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-theme-id]');
        if (!btn || !host.contains(btn)) return;
        this.applySettings({ theme: btn.getAttribute('data-theme-id') });
      });
    });
    const fontRow = document.getElementById('quickSheetFontRow');
    if (fontRow) {
      fontRow.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-font]');
        if (!chip || !fontRow.contains(chip)) return;
        this.applySettings({ font_family: chip.getAttribute('data-font') });
      });
    }

    // Voice engine switch: every [data-engine-option] button anywhere in the app
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-engine-option]');
      if (!btn || typeof TTSEngine === 'undefined' || typeof TTSEngine.setEngineMode !== 'function') return;
      e.preventDefault();
      TTSEngine.setEngineMode(btn.getAttribute('data-engine-option'));
    });

    document.querySelectorAll('.choice-btn.font-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.choice-btn.font-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const font = btn.getAttribute('data-font');
        this.applySettings({ font_family: font });
      });
    });

    const fontSizeSlider = document.getElementById('fontSizeSlider');
    if (fontSizeSlider) {
      fontSizeSlider.addEventListener('input', (e) => {
        const size = parseInt(e.target.value);
        this.applySettings({ font_size: size });
      });
    }

    const lineHeightSlider = document.getElementById('lineHeightSlider');
    if (lineHeightSlider) {
      lineHeightSlider.addEventListener('input', (e) => {
        const lh = parseFloat(e.target.value);
        this.applySettings({ line_height: lh });
      });
    }

    const letterSpacingSlider = document.getElementById('letterSpacingSlider');
    if (letterSpacingSlider) {
      letterSpacingSlider.addEventListener('input', (e) => {
        const ls = parseFloat(e.target.value);
        this.applySettings({ letter_spacing: ls });
      });
    }

    document.querySelectorAll('.width-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.width-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const width = btn.getAttribute('data-width');
        this.applySettings({ content_width: width });
      });
    });

    document.querySelectorAll('.margin-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.margin-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const margin = btn.getAttribute('data-margin');
        this.applySettings({ margin_width: margin });
      });
    });
  },

  // Builds the theme swatches (quick sheet row + Display tab grid) and the quick-sheet font chips
  renderAppearancePickers() {
    const swatch = (t) => `<button type="button" class="theme-swatch" role="radio" aria-checked="false" data-theme-id="${t.id}"`
      + ` title="${escapeHtml(t.name)}" style="--sw-bg:${t.bg};--sw-fg:${t.fg};--sw-accent:${t.accent};">`
      + `<span class="theme-swatch-tile"><span class="theme-swatch-aa">Aa</span><span class="theme-swatch-dot"></span></span>`
      + `<span class="theme-swatch-name">${escapeHtml(t.name)}</span></button>`;
    const html = THEMES.map(swatch).join('');
    ['quickSheetThemeRow', 'prefsThemeGrid'].forEach(id => {
      const host = document.getElementById(id);
      if (host) host.innerHTML = html;
    });
    const fontRow = document.getElementById('quickSheetFontRow');
    if (fontRow) {
      fontRow.innerHTML = FONTS.map(f => `<button type="button" class="font-chip" role="radio" aria-checked="false"`
        + ` data-font="${f.id}">${escapeHtml(f.name)}</button>`).join('');
    }
  },

  updateAppearancePickers(cur = window.ReaderSettings) {
    const theme = themeById(cur.theme);
    const fontId = cur.font_family || 'times';
    document.querySelectorAll('[data-theme-id]').forEach(b => {
      const on = b.getAttribute('data-theme-id') === theme.id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    document.querySelectorAll('.font-btn, .font-chip').forEach(b => {
      const on = b.getAttribute('data-font') === fontId;
      b.classList.toggle('selected', on);
      if (b.classList.contains('font-chip')) b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const themeVal = document.getElementById('quickSheetThemeVal');
    if (themeVal) themeVal.textContent = theme.name;
    const fontName = document.getElementById('quickSheetFontName');
    if (fontName) {
      const f = FONTS.find(x => x.id === fontId);
      fontName.textContent = f ? f.name : fontId;
    }
  },

  // Keeps the iOS status bar (theme-color), the overscroll area and the boot background on the theme's color
  applyThemeChrome(themeId) {
    const t = themeById(themeId);
    const doc = document.documentElement;
    doc.style.setProperty('--boot-bg', t.bg);
    doc.style.setProperty('--boot-fg', t.fg);
    doc.style.backgroundColor = t.bg;
    doc.style.color = t.fg;
    if (document.body) {
      document.body.style.backgroundColor = t.bg;
      document.body.style.color = t.fg;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute('content') !== t.bg) meta.setAttribute('content', t.bg);
  },

  // Brings the selected swatch and font chip into view inside their scroll rows
  scrollPickersToSelection() {
    ['quickSheetThemeRow', 'quickSheetFontRow'].forEach(id => {
      const row = document.getElementById(id);
      const sel = row && row.querySelector('.selected');
      if (!row || !sel) return;
      const left = sel.offsetLeft - (row.clientWidth - sel.offsetWidth) / 2;
      row.scrollLeft = Math.max(0, left);
    });
  },

  // "Chapter N of M" and, while narrating, "about X min left in chapter". Computed when the sheet opens.
  updateQuickSheetChapterMeta() {
    const el = document.getElementById('quickSheetChapterMeta');
    if (!el) return;
    const reader = window.Reader;
    const ch = reader ? reader.currentChapter : null;
    if (!ch) { el.textContent = ''; return; }
    const list = (reader.chapterList || []);
    let idx = list.findIndex(c => c.id === ch.id);
    if (idx < 0 && typeof ch.global_index === 'number' && ch.global_index >= 1) idx = ch.global_index - 1;
    const total = list.length || 0;
    const parts = [];
    if (idx >= 0 && total) parts.push(`Chapter ${idx + 1} of ${total}`);
    const tts = typeof TTSEngine !== 'undefined' ? TTSEngine : null;
    if (tts && (tts.isPlaying || tts.isPaused) && tts.paragraphs && tts.paragraphs.length) {
      let words = 0;
      for (let i = Math.max(0, tts.currentIndex || 0); i < tts.paragraphs.length; i++) {
        const t = (tts.paragraphs[i] && tts.paragraphs[i].textContent) || '';
        words += t.split(/\s+/).filter(Boolean).length;
      }
      const rate = parseFloat(tts.rate) || 1;
      const mins = Math.max(1, Math.round(words / (165 * rate)));
      parts.push(`about ${mins} min left in chapter`);
    }
    el.textContent = parts.join(' · ');
  },

  applySettings(s, syncToCloud = true) {
    window.ReaderSettings = { ...window.ReaderSettings, ...s };
    const cur = window.ReaderSettings;
    const doc = document.documentElement;

    // 1. Theme
    doc.setAttribute('data-theme', cur.theme || 'monochrome-dark');
    // 2. Font family
    doc.setAttribute('data-font', cur.font_family || 'times');
    // 3. Content width
    doc.setAttribute('data-width', cur.content_width || 'normal');
    // 3.5 Margin Mode (Edge, Compact, Relaxed)
    const marginMode = cur.margin_width || 'edge';
    doc.setAttribute('data-margin', marginMode);

    // 4. Font size, Line height & Letter spacing
    doc.style.setProperty('--reader-font-size', `${cur.font_size || 19}px`);
    doc.style.setProperty('--reader-line-height', `${cur.line_height || 1.85}`);
    doc.style.setProperty('--reader-letter-spacing', `${cur.letter_spacing || 0}px`);

    // Status bar color, overscroll background and every theme / font picker follow the theme (sync included)
    this.applyThemeChrome(cur.theme);
    this.updateAppearancePickers(cur);
    // Update Width buttons
    document.querySelectorAll('.width-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-width') === cur.content_width);
    });
    // Update Margin buttons
    document.querySelectorAll('.margin-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-margin') === marginMode);
    });

    // Update Mobile Quick Sheet dynamic values
    const quickMarginVal = document.getElementById('quickSheetMarginVal');
    if (quickMarginVal) {
      const labels = { edge: 'Edge', compact: 'Compact', comfortable: 'Relaxed' };
      quickMarginVal.textContent = labels[marginMode] || 'Edge';
    }

    const quickFontVal = document.getElementById('quickSheetFontVal');
    if (quickFontVal) {
      quickFontVal.textContent = `${cur.font_size || 19}px`;
    }

    const quickLineVal = document.getElementById('quickSheetLineVal');
    if (quickLineVal) {
      quickLineVal.textContent = (cur.line_height || 1.85).toFixed(2);
    }

    const quickLetterVal = document.getElementById('quickSheetLetterVal');
    if (quickLetterVal) {
      quickLetterVal.textContent = `${(cur.letter_spacing || 0).toFixed(1)}px`;
    }

    const quickTtsText = document.getElementById('quickSheetTTSText');
    if (quickTtsText && typeof TTSEngine !== 'undefined') {
      quickTtsText.textContent = (TTSEngine.isPlaying && !TTSEngine.isPaused) ? 'Pause' : 'Read Aloud';
    }


    // Update Font Size Slider
    const fsSlider = document.getElementById('fontSizeSlider');
    if (fsSlider) {
      fsSlider.value = cur.font_size || 19;
      const fsVal = document.getElementById('fontSizeVal');
      if (fsVal) fsVal.textContent = `${cur.font_size || 19}px`;
    }

    // Update Line Height Slider
    const lhSlider = document.getElementById('lineHeightSlider');
    if (lhSlider) {
      lhSlider.value = cur.line_height || 1.85;
      const lhVal = document.getElementById('lineHeightVal');
      if (lhVal) lhVal.textContent = (cur.line_height || 1.85).toFixed(2);
    }

    // Update Letter Spacing Slider
    const lsSlider = document.getElementById('letterSpacingSlider');
    if (lsSlider) {
      lsSlider.value = cur.letter_spacing || 0.0;
      const lsVal = document.getElementById('letterSpacingVal');
      if (lsVal) lsVal.textContent = `${(cur.letter_spacing || 0).toFixed(1)}px`;
    }

    // 5. Read Speed (TTS Rate)
    let ttsRate = parseFloat(cur.tts_rate || 1.0);
    try {
      const directRate = localStorage.getItem('byob_tts_rate') || localStorage.getItem('kuroyomi_tts_rate');
      if (directRate && (!s || s.tts_rate === undefined)) {
        ttsRate = parseFloat(directRate);
      }
    } catch (e) {}
    if (!ttsRate || isNaN(ttsRate) || ttsRate <= 0) ttsRate = 1.0;
    cur.tts_rate = ttsRate;

    try {
      localStorage.setItem('byob_tts_rate', String(ttsRate));
      localStorage.setItem('kuroyomi_tts_rate', String(ttsRate));
    } catch (e) {}

    if (typeof TTSEngine !== 'undefined') {
      TTSEngine.rate = ttsRate;
      if (typeof TTSEngine.syncRateUI === 'function') {
        TTSEngine.syncRateUI();
      }
    }

    // 6. TTS Voice
    if (cur.tts_voice) TTSEngine.selectedVoice = cur.tts_voice;
    if (typeof cur.kokoro_voice === 'string') TTSEngine.kokoroVoice = cur.kokoro_voice;
    if (typeof TTSEngine.syncVoicePickers === 'function') TTSEngine.syncVoicePickers();
    if (typeof TTSEngine.updateAudioUI === 'function') {
      TTSEngine.updateAudioUI();
    }

    // 6b. TTS Pitch
    if (cur.tts_pitch !== undefined) {
      const pitchVal = parseInt(cur.tts_pitch, 10) || 0;
      if (typeof TTSEngine !== 'undefined') {
        TTSEngine.pitch = pitchVal;
        if (typeof TTSEngine.updatePitchUI === 'function') {
          TTSEngine.updatePitchUI();
        }
      }
    }

    // 7. Auto-Scroll Speed
    const scrollSpeed = parseInt(cur.auto_scroll_speed || 35);
    AutoScroll.speed = scrollSpeed;
    const scrollSlider = document.getElementById('panelScrollSpeedSlider');
    if (scrollSlider) {
      scrollSlider.value = scrollSpeed;
      const speedVal = document.getElementById('panelScrollSpeedVal');
      if (speedVal) speedVal.textContent = `${scrollSpeed} px/s`;
    }

    // 7b. Bionic Reading State & Controls Sync
    const isBionic = !!cur.bionic_reading;
    const qsBionicBtn = document.getElementById('quickSheetBionicBtn');
    const qsBionicStatus = document.getElementById('quickSheetBionicStatus');
    if (qsBionicBtn) {
      qsBionicBtn.classList.toggle('active', isBionic);
      qsBionicBtn.setAttribute('aria-pressed', isBionic ? 'true' : 'false');
    }
    if (qsBionicStatus) {
      qsBionicStatus.textContent = isBionic ? 'ON' : 'OFF';
    }

    const stdBtn = document.getElementById('panelModeStandardBtn');
    const bionicBtn = document.getElementById('panelModeBionicBtn');
    if (stdBtn) stdBtn.classList.toggle('selected', !isBionic);
    if (bionicBtn) bionicBtn.classList.toggle('selected', isBionic);

    const qsBionicToggle = document.getElementById('quickSheetBionicToggle');
    if (qsBionicToggle) {
      qsBionicToggle.checked = isBionic;
    }
    const panelBionicToggle = document.getElementById('panelBionicToggle');
    if (panelBionicToggle) {
      panelBionicToggle.checked = isBionic;
    }
    const bionicSizeGroup = document.getElementById('bionicFixationSizeGroup');
    if (bionicSizeGroup) {
      bionicSizeGroup.style.display = isBionic ? 'block' : 'none';
    }
    if (window.Reader && window.Reader.applyBionicSettings) {
      window.Reader.applyBionicSettings();
    }

    // 8. Library View Mode (Tile / List)
    const viewMode = cur.library_view_mode || 'tile';
    const tileBtn = document.getElementById('viewTileBtn');
    const listBtn = document.getElementById('viewListBtn');
    if (tileBtn && listBtn) {
      tileBtn.classList.toggle('active', viewMode === 'tile');
      listBtn.classList.toggle('active', viewMode === 'list');
    }
    const grid = document.getElementById('novelGrid');
    if (grid) {
      grid.className = (viewMode === 'list') ? 'novel-list' : 'novel-grid';
    }

    // 9. Library Sort Selection
    const sortBy = cur.library_sort_by || 'last_read';
    const sortSelect = document.getElementById('librarySortSelect');
    if (sortSelect && sortSelect.value !== sortBy) {
      sortSelect.value = sortBy;
    }

    // Always persist to local device storage
    Storage.setLocalSettings(cur);

    // Sync to user account
    if (syncToCloud) {
      this.debounceSyncSettings();
    }
  },

  bindLibraryToolbarEvents() {
    const searchInput = document.getElementById('librarySearchInput');
    const clearBtn = document.getElementById('librarySearchClearBtn');
    const sortSelect = document.getElementById('librarySortSelect');
    const tileBtn = document.getElementById('viewTileBtn');
    const listBtn = document.getElementById('viewListBtn');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        if (clearBtn) {
          clearBtn.style.display = this.searchQuery.length > 0 ? 'flex' : 'none';
        }
        this.renderLibraryGrid();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.searchQuery = '';
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
        clearBtn.style.display = 'none';
        this.renderLibraryGrid();
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        const sortBy = e.target.value;
        window.ReaderSettings.library_sort_by = sortBy;
        Storage.setLocalSettings(window.ReaderSettings);
        this.debounceSyncSettings();
        this.renderLibraryGrid();
      });
    }

    if (tileBtn) {
      tileBtn.addEventListener('click', () => {
        if (window.ReaderSettings.library_view_mode === 'tile') return;
        window.ReaderSettings.library_view_mode = 'tile';
        tileBtn.classList.add('active');
        if (listBtn) listBtn.classList.remove('active');
        const grid = document.getElementById('novelGrid');
        if (grid) {
          grid.className = 'novel-grid';
        }
        Storage.setLocalSettings(window.ReaderSettings);
        this.debounceSyncSettings();
        this.renderLibraryGrid();
      });
    }

    if (listBtn) {
      listBtn.addEventListener('click', () => {
        if (window.ReaderSettings.library_view_mode === 'list') return;
        window.ReaderSettings.library_view_mode = 'list';
        listBtn.classList.add('active');
        if (tileBtn) tileBtn.classList.remove('active');
        const grid = document.getElementById('novelGrid');
        if (grid) {
          grid.className = 'novel-list';
        }
        Storage.setLocalSettings(window.ReaderSettings);
        this.debounceSyncSettings();
        this.renderLibraryGrid();
      });
    }
  },

  bindSyncEvents() {
    const rememberToggle = document.getElementById('rememberDeviceToggle');
    if (rememberToggle) {
      rememberToggle.checked = Storage.isRemembered();
      rememberToggle.addEventListener('change', (e) => {
        Storage.setRemembered(e.target.checked);
        SyncService.pairDeviceWithKey(SyncService.currentSyncKey, e.target.checked);
      });
    }

    document.getElementById('pairKeyBtn').addEventListener('click', async () => {
      const input = document.getElementById('pairKeyInput');
      const key = input.value.trim().toUpperCase();
      if (!key) return;

      try {
        this.showLoading('Pairing device...');
        const remember = document.getElementById('rememberDeviceToggle').checked;
        const result = await SyncService.pairDeviceWithKey(key, remember);
        if (result && result.settings && Object.keys(result.settings).length > 0) {
          this.applySettings(result.settings, false);
        }
        // Clear cached novels to prevent old account books from remaining in memory
        this.novels = [];
        this.updateSyncDisplay();
        if (this.currentView === 'reader') {
          if (typeof Reader !== 'undefined') Reader.currentNovel = null;
          this.switchView('library');
        }
        await this.loadLibrary();
        this.hideLoading();
        this.closeMasterPanel();
        this.showToast(`Paired successfully! Sync Key: ${key}`);
      } catch (e) {
        this.hideLoading();
        alert('Could not pair device: ' + e.message);
      }
    });

    document.getElementById('copySyncKeyBtn').addEventListener('click', () => {
      const key = SyncService.currentSyncKey;
      if (key) {
        navigator.clipboard.writeText(key);
        this.showToast('Sync Key copied');
      }
    });

    const copyLinkBtn = document.getElementById('copyPairingLinkBtn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => {
        const key = SyncService.currentSyncKey;
        if (!key) return;
        const host = window.location.hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
                        /^10\.\d+\.\d+\.\d+$/.test(host) ||
                        /^192\.168\.\d+\.\d+$/.test(host) ||
                        /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
        const baseUrl = isLocal ? SyncService.cloudServerUrl : window.location.origin;
        const uid = SyncService.currentUserId || Storage.getUserId() || '';
        const link = `${baseUrl}/?pair=${encodeURIComponent(key)}${uid ? `&uid=${encodeURIComponent(uid)}` : ''}`;
        navigator.clipboard.writeText(link).then(() => {
          this.showToast('1-Click Pairing Link copied!');
        }).catch(() => {
          prompt('Copy this link and open it in Safari on your iPhone:', link);
        });
      });
    }

    const copyPingBtn = document.getElementById('copyKeepaliveUrlBtn');
    if (copyPingBtn) {
      copyPingBtn.addEventListener('click', () => {
        const pingUrl = `${window.location.origin}/api/health`;
        navigator.clipboard.writeText(pingUrl).then(() => {
          this.showToast('Copied keepalive URL to clipboard!');
        }).catch(() => {
          prompt('Copy this Keepalive URL for cron-job.org:', pingUrl);
        });
      });
    }

    const pushToCloudBtn = document.getElementById('pushToCloudBtn');
    if (pushToCloudBtn) {
      pushToCloudBtn.addEventListener('click', async () => {
        const statusEl = document.getElementById('pushToCloudStatus');
        const origText = pushToCloudBtn.textContent;
        try {
          pushToCloudBtn.disabled = true;
          pushToCloudBtn.textContent = 'Pushing to Cloud...';
          if (statusEl) statusEl.textContent = 'Uploading all local books and reading positions to Render...';

          const result = await SyncService.pushLibraryToCloud();
          this.showToast(`Cloud Sync Complete: Pushed ${result.novelsCount} novel(s) to Render!`);
          if (statusEl) {
            statusEl.textContent = `Uploaded ${result.novelsCount} novel(s) to Render successfully! Available on your phone 24/7.`;
            statusEl.style.color = 'var(--accent)';
          }
        } catch (err) {
          console.error('Push to cloud error:', err);
          alert('Could not push library to cloud: ' + err.message);
          if (statusEl) {
            statusEl.textContent = `Upload error: ${err.message}`;
            statusEl.style.color = '#ef4444';
          }
        } finally {
          pushToCloudBtn.disabled = false;
          pushToCloudBtn.textContent = origText;
        }
      });
    }
  },

  bindBackupRestoreEvents() {
    // 1. Export Backup (Download JSON)
    const exportBtn = document.getElementById('exportBackupBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        try {
          this.showLoading('Exporting backup...');
          // The server copy can be empty for a while after the host restarts (books come back from this device's own
          // saved copy), so the export always adds every book this device holds that the server does not have yet.
          const uid = SyncService.currentUserId;
          let serverData = null;
          let serverError = '';
          try {
            const res = await fetch(`/api/backup?user_id=${encodeURIComponent(uid)}`);
            if (res.ok) serverData = await res.json();
            else serverError = `server returned HTTP ${res.status}`;
          } catch (e) {
            serverError = e.message || 'server unreachable';
          }
          let mirror = null;
          try {
            if (typeof IDB !== 'undefined') mirror = await IDB.getLibraryMirror(uid);
          } catch (e) {}
          const backupData = App.mergeBackupForExport(serverData, mirror);
          this.hideLoading();
          if (!backupData || !Array.isArray(backupData.novels) || backupData.novels.length === 0) {
            throw new Error(serverError || 'no books found on the server or on this device');
          }

          const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const dateStr = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `byob_backup_${dateStr}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          this.showToast('Backup downloaded');
        } catch (err) {
          this.hideLoading();
          alert('Backup failed: ' + err.message);
        }
      });
    }

    // 2. Import Restore (Upload JSON)
    const importBtn = document.getElementById('importBackupBtn');
    const fileInput = document.getElementById('backupFileInput');

    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          this.showLoading('Restoring library...');
          const text = await file.text();
          const backupData = JSON.parse(text);

          const res = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: SyncService.currentUserId,
              backup_data: backupData
            })
          });

          let data = null;
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try { data = await res.json(); } catch (je) { data = null; }
          }
          this.hideLoading();
          if (res.ok && data && data.success) {
            this.showToast(`Restored ${data.novels_restored || 0} novel(s), ${data.chapters_restored || 0} chapters`);
            await this.loadLibrary();
            fileInput.value = '';
          } else {
            alert('Restore failed: ' + (data && data.error ? data.error : `HTTP ${res.status}`));
          }
        } catch (err) {
          this.hideLoading();
          alert('Could not parse backup file: ' + err.message);
        }
      });
    }
  },

  updateSyncDisplay() {
    const keyEl = document.getElementById('syncKeyDisplay');
    if (keyEl) keyEl.textContent = SyncService.currentSyncKey || '---';

    const nameEl = document.getElementById('deviceNameDisplay');
    if (nameEl) nameEl.textContent = Storage.getDeviceName();

    const toggle = document.getElementById('rememberDeviceToggle');
    if (toggle) toggle.checked = Storage.isRemembered();

    const keepaliveInput = document.getElementById('keepaliveUrlInput');
    if (keepaliveInput) {
      keepaliveInput.textContent = `${window.location.origin}/api/health`;
    }
  },

  updateOfflineBadges(isOffline) {
    const offline = isOffline !== undefined ? isOffline : !navigator.onLine;
    const topBadge = document.getElementById('mobileOfflineBadge');
    if (topBadge) topBadge.style.display = offline ? 'inline-flex' : 'none';
  },

  bindNetworkEvents() {
    let startupGracePeriod = true;
    setTimeout(() => { startupGracePeriod = false; }, 6000);

    window.addEventListener('online', async () => {
      this.updateOfflineBadges(false);
      if (!startupGracePeriod) {
        this.showToast('Online: Synced with cloud');
      }
      this.loadLibrary(false);
    });

    window.addEventListener('offline', async () => {
      if (startupGracePeriod) return;
      // In mobile Safari / WebKit, confirm with network probe before alarming user
      try {
        const ping = await fetch('/health?_t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
        if (ping.ok) return; // False alarm from iOS radio handover
      } catch (e) {}
      this.updateOfflineBadges(true);
      this.showToast('Offline Mode: Reading from local cache');
    });

    // Auto-refresh when mobile reader wakes up or user returns to tab
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        this.checkSleepTimerResume();
        if (navigator.onLine) {
          if (!this._lastWakeCheck || (Date.now() - this._lastWakeCheck > 8000)) {
            this._lastWakeCheck = Date.now();
            if (this.currentView === 'library') {
              this.loadLibrary(false);
            } else if (this.currentView === 'reader' && typeof Reader !== 'undefined' && Reader.checkRemoteSync) {
              Reader.checkRemoteSync();
            }
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);

    // Periodic background sync: check for new books and progress every 30s when active
    setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine && this.currentView === 'library') {
        this.loadLibrary(false);
      }
    }, 30000);
  },

  adoptServerSettings(serverSettings) {
    try {
      const server = SyncService.expandSettings(serverSettings);
      const local = Storage.getLocalSettings() || {};
      const merged = { ...local, ...server, changed_at: Math.round((server.updated_at || 0) * 1000) };
      delete merged.user_id;
      Storage.setLocalSettings(merged);
      this.applySettings(merged, false);
      if (typeof TTSEngine !== 'undefined' && TTSEngine.syncRateUI && merged.tts_rate) {
        try { TTSEngine.rate = Number(merged.tts_rate) || TTSEngine.rate; localStorage.setItem('byob_tts_rate', String(TTSEngine.rate)); TTSEngine.syncRateUI(); } catch (e) {}
      }
    } catch (e) {
      console.warn('adoptServerSettings failed:', e);
    }
  },

  async loadLibrary(allowAutoRestore = true) {
    try {
      const userId = SyncService.currentUserId || Storage.getUserId() || 'universal_device_mirror';

      // Immediate loading skeleton if library is empty to avoid any blank or frozen appearance
      if (!this.novels || this.novels.length === 0) {
        const grid = document.getElementById('novelGrid');
        if (grid && !grid.querySelector('.library-skeleton-loader')) {
          grid.innerHTML = `
            <div class="library-skeleton-loader" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; gap: 14px; color: var(--text-secondary);">
              <div class="spinner-brutal"></div>
              <span style="font-size: 13px; font-weight: 600; letter-spacing: 0.5px;">Loading your library...</span>
            </div>
          `;
        }
      }

      let novelsData = null;
      let lastReadData = null;

      // 1. Attempt network fetch if online
      if (navigator.onLine && userId && userId !== 'offline_user') {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20000);

          const [novelsRes, lastReadRes] = await Promise.all([
            fetch(`/api/novels?user_id=${encodeURIComponent(userId)}`, { signal: controller.signal }),
            fetch(`/api/last-read?user_id=${encodeURIComponent(userId)}`, { signal: controller.signal })
          ]);
          clearTimeout(timer);

          if (novelsRes.ok) novelsData = await novelsRes.json();
          if (lastReadRes.ok) lastReadData = await lastReadRes.json();
        } catch (netErr) {
          console.warn('Network error loading library, checking local offline mirror:', netErr);
        }
      }

      // 2. Offline / Local Mirror Fallback from IndexedDB
      if (!novelsData || !novelsData.novels || novelsData.novels.length === 0) {
        if (typeof IDB !== 'undefined') {
          const mirror = await IDB.getLibraryMirror(userId);
          if (mirror && mirror.novels && mirror.novels.length > 0) {
            this.novels = mirror.novels;
            this.renderLibraryGrid();

            let lastRead = null;
            if (mirror.progress && mirror.progress.length > 0) {
              const latest = [...mirror.progress].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
              const book = mirror.novels.find(n => n.id === latest.novel_id);
              const vol = (mirror.volumes || []).find(v => v.id === latest.volume_id);
              const ch = (mirror.chapters || []).find(c => c.id === latest.chapter_id);
              lastRead = {
                novel_id: latest.novel_id,
                novel_title: book ? book.title : 'Novel',
                volume_title: vol ? vol.title : '',
                volume_number: vol ? vol.volume_number : null,
                chapter_title: ch ? ch.title : '',
                chapter_index: ch ? ch.chapter_index : null,
                chapter_global_index: ch ? (ch.global_index || ch.chapter_global_index) : null,
                scroll_percent: latest.scroll_percent || 0,
                cover_data: book ? book.cover_data : null
              };
            }
            this.renderResumeHero(lastRead);
            this.updateMirrorStatus();
            this.updateOfflineBadges();

            // If online, auto-restore missing novels to cloud
            if (navigator.onLine && allowAutoRestore && userId && userId !== 'universal_device_mirror') {
              const serverNovelIds = new Set((novelsData && novelsData.novels ? novelsData.novels : []).map(n => n.id));
              const missingNovels = mirror.novels.filter(n => !serverNovelIds.has(n.id));
              if (missingNovels.length > 0) {
                console.warn(`Auto-Shield: Server is missing ${missingNovels.length} novel(s) from device mirror. Restoring...`);
                this.showToast(`Restoring ${missingNovels.length} novel(s) to cloud...`);
                try {
                  const restoreRes = await fetch('/api/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      user_id: userId,
                      backup_data: this.withFreshLocalProgress(mirror, userId)
                    })
                  });
                  const restoreData = await restoreRes.json();
                  if (restoreData.success) {
                    this.showToast(`Auto-restored ${restoreData.novels_restored || 0} novel(s) from device!`);
                    return this.loadLibrary(false);
                  }
                } catch (e) {
                  console.warn('Auto-restore failed:', e);
                }
              }
            }
            return;
          }
        }
      }

      if (novelsData && novelsData.novels && novelsData.novels.length > 0) {
        this.novels = novelsData.novels;
      } else if (!this.novels || this.novels.length === 0) {
        this.novels = novelsData ? (novelsData.novels || []) : [];
      }

      // Auto-Shield: Check if server is missing any books present in local device mirror
      if (allowAutoRestore && typeof IDB !== 'undefined') {
        const mirroredBackup = await IDB.getLibraryMirror(userId, false);
        if (mirroredBackup && mirroredBackup.novels && mirroredBackup.novels.length > 0) {
          const serverNovelIds = new Set(this.novels.map(n => n.id));
          const missingNovels = mirroredBackup.novels.filter(n => !serverNovelIds.has(n.id));

          if (missingNovels.length > 0) {
            console.warn(`Auto-Shield: Server is missing ${missingNovels.length} novel(s) from device mirror. Restoring...`);
            this.showToast(`Restoring ${missingNovels.length} novel(s) to cloud...`);
            try {
              const restoreRes = await fetch('/api/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  user_id: userId,
                  backup_data: this.withFreshLocalProgress(mirroredBackup, userId)
                })
              });
              const restoreData = await restoreRes.json();
              if (restoreData.success) {
                this.showToast(`Auto-restored ${restoreData.novels_restored || 0} novel(s) from device!`);
                return this.loadLibrary(false);
              }
            } catch (e) {
              console.warn('Auto-restore failed:', e);
            }
          }
        }
      }

      // If server has novels, update our local device mirror safely
      if (this.novels.length > 0) {
        this.retryPendingCovers();
        this.updateDeviceMirror();
        SyncService.reconcileProgress(this.novels).then((r) => {
          if (r && r.pulled > 0 && this.currentView !== 'reader') {
            fetch(`/api/last-read?user_id=${encodeURIComponent(userId)}`).then(x => x.json())
              .then(d => this.renderResumeHero(d ? d.last_read : null)).catch(() => {});
          }
        }).catch(() => {});
      }

      this.renderResumeHero(lastReadData ? lastReadData.last_read : null);
      this.renderLibraryGrid();
      this.updateMirrorStatus();
      this.updateOfflineBadges();
      this.checkSleepTimerResume();
    } catch (e) {
      console.warn('Error loading library:', e);
    }
  },

  // The device mirror's reading positions are only as fresh as the last library load. Before pushing it to a server
  // that lost its data, lay this device's own (newer) saved positions over it so the restore cannot roll a book back.
  withFreshLocalProgress(backup, userId) {
    try {
      if (!backup || !Array.isArray(backup.progress)) return backup;
      const progress = backup.progress.map((p) => {
        const local = Storage.getLocalProgress(p.novel_id, userId);
        if (!local || !local.chapterId || !local.savedAt) return p;
        if (local.savedAt <= (p.updated_at || 0) * 1000) return p;
        return {
          ...p,
          volume_id: local.volumeId || p.volume_id,
          chapter_id: local.chapterId,
          paragraph_index: Number.isFinite(Number(local.paragraphIndex)) ? Number(local.paragraphIndex) : (p.paragraph_index || 0),
          scroll_percent: local.scrollPercent || 0,
          updated_at: local.savedAt / 1000
        };
      });
      return { ...backup, progress };
    } catch (e) {
      return backup;
    }
  },

  async updateDeviceMirror() {
    try {
      const userId = SyncService.currentUserId;
      if (!userId || typeof IDB === 'undefined') return;

      // The full backup holds every chapter of every book (tens of MB). Only download it when the server's book list
      // or chapter counts differ from this device's copy; this used to run on every library open and made it slow.
      const localBackup = await IDB.getLibraryMirror(userId);
      try {
        const sres = await fetch(`/api/sync/state?user_id=${encodeURIComponent(userId)}`, {
          headers: { 'X-Device-Token': Storage.getDeviceToken() || '' }, cache: 'no-store'
        });
        if (sres.ok && localBackup && Array.isArray(localBackup.novels)) {
          const st = await sres.json();
          const localCounts = new Map();
          for (const c of (localBackup.chapters || [])) localCounts.set(c.novel_id, (localCounts.get(c.novel_id) || 0) + 1);
          const localCovers = new Map(localBackup.novels.map(n => [n.id, (n.cover_data || '').length]));
          const same = (st.novels || []).length > 0 && (st.novels || []).every(n =>
            localCounts.get(n.id) === n.chapter_count && localCovers.has(n.id) && (!!n.has_cover) === (localCovers.get(n.id) > 0)
            && !(n.updated_at && localBackup.novels.find(m => m.id === n.id && (m.updated_at || 0) + 1 < n.updated_at)));
          if (same && (st.novels || []).length >= localBackup.novels.filter(n => !n.id.startsWith('nov_demo')).length) return;
        }
      } catch (e) {}

      const res = await fetch(`/api/backup?user_id=${encodeURIComponent(userId)}`, {
        headers: { 'X-Device-Token': Storage.getDeviceToken() || '' }
      });
      const serverBackup = await res.json();
      if (!serverBackup || !serverBackup.novels) return;

      if (localBackup && localBackup.novels && localBackup.novels.length > 0) {
        // Safety guard: NEVER overwrite a mirror that has user-uploaded books with a server backup that has FEWER books!
        const localUserBooks = localBackup.novels.filter(n => !n.id.startsWith('nov_demo') && !n.title.includes('Chronicles of the Aether'));
        const serverUserBooks = serverBackup.novels.filter(n => !n.id.startsWith('nov_demo') && !n.title.includes('Chronicles of the Aether'));

        if (localUserBooks.length > serverUserBooks.length) {
          console.warn('Local mirror has more user books than server. Preserving mirror and auto-syncing to server.');
          await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: userId,
              backup_data: this.withFreshLocalProgress(localBackup, userId)
            })
          });
          return;
        }
      }

      if (serverBackup.novels.length > 0) {
        await IDB.saveLibraryMirror(userId, serverBackup);
        this.updateMirrorStatus();
      }
    } catch (e) {
      console.warn('Could not update device mirror:', e);
    }
  },

  async updateMirrorStatus() {
    const statusEl = document.getElementById('mirrorStatusText');
    if (!statusEl || typeof IDB === 'undefined') return;
    const count = await IDB.getMirroredCount(SyncService.currentUserId);
    if (count > 0) {
      statusEl.textContent = `Active · ${count} novel(s) mirrored locally on this device`;
    } else {
      statusEl.textContent = 'Active · Mirrored locally';
    }
  },

  formatResumeChapterTag(lastRead) {
    if (!lastRead) return '';

    // 1. Determine volume number
    let volNum = lastRead.volume_number;
    if (!volNum && lastRead.volume_title) {
      const vm = lastRead.volume_title.match(/vol(?:ume)?\.?\s*([0-9]+)/i);
      if (vm) volNum = parseInt(vm[1], 10);
    }
    if (!volNum) volNum = 1;

    // 2. Determine chapter number and subtitle
    const rawTitle = (lastRead.chapter_title || '').trim();
    let chNum = null;
    let subtitle = '';

    const prefixMatch = rawTitle.match(/\b(?:chapter|chap|ch|episode|ep|act)\b\.?\s*([0-9]+(?:\.[0-9]+)?)(?:[:\.\-\s]+(.*))?$/i);
    const leadingNumMatch = !prefixMatch && rawTitle.match(/^([0-9]+(?:\.[0-9]+)?)(?:[:\.\-\s]+(.*))?$/);

    if (prefixMatch) {
      chNum = prefixMatch[1];
      subtitle = (prefixMatch[2] || '').trim();
    } else if (leadingNumMatch) {
      chNum = leadingNumMatch[1];
      subtitle = (leadingNumMatch[2] || '').trim();
    } else {
      if (lastRead.chapter_global_index !== undefined && lastRead.chapter_global_index !== null) {
        chNum = lastRead.chapter_global_index;
      } else if (lastRead.chapter_index !== undefined && lastRead.chapter_index !== null) {
        chNum = Number(lastRead.chapter_index) + 1;
      }
      subtitle = rawTitle;
    }

    if (subtitle) {
      subtitle = subtitle.replace(/^[:\.\-\s]+|[:\.\-\s]+$/g, '').trim();
      const sLower = subtitle.toLowerCase();
      if (lastRead.novel_title && sLower === lastRead.novel_title.toLowerCase()) subtitle = '';
      if (lastRead.volume_title && sLower === lastRead.volume_title.toLowerCase()) subtitle = '';
      if (sLower.startsWith('volume ') || sLower.startsWith('vol.') || sLower === 'chapter' || sLower === 'chap') subtitle = '';
    }

    let tag = `Vol. ${volNum}, Chap. ${chNum || 1}`;
    if (subtitle && subtitle.length > 0) {
      tag += `: ${subtitle}`;
    }
    return tag;
  },

  renderResumeHero(lastRead) {
    const hero = document.getElementById('resumeHero');
    if (!lastRead) {
      hero.style.display = 'none';
      return;
    }

    hero.style.display = 'grid';
    const resumeCoverEl = document.getElementById('resumeCover');
    if (resumeCoverEl) {
      resumeCoverEl.src = this.coverFor({ id: lastRead.novel_id, cover_data: lastRead.cover_data });
      resumeCoverEl.style.cursor = 'pointer';
      resumeCoverEl.title = 'Resume reading';
      resumeCoverEl.onclick = () => { const b = document.getElementById('resumeReadBtn'); if (b) b.click(); };
      const backdrop = document.getElementById('resumeBackdrop');
      if (backdrop) backdrop.style.backgroundImage = `url("${resumeCoverEl.src}")`;
    }
    const resumeTitle = document.getElementById('resumeNovelTitle');
    resumeTitle.textContent = lastRead.novel_title;
    resumeTitle.onclick = () => {
      Reader.openNovel(lastRead.novel_id, true);
    };
    document.getElementById('resumeChapterTag').textContent = this.formatResumeChapterTag(lastRead);
    
    const pct = Math.round(lastRead.progress_overall_percent !== undefined ? lastRead.progress_overall_percent : (lastRead.scroll_percent || 0));
    document.getElementById('resumeProgressBar').style.width = `${pct}%`;
    document.getElementById('resumeProgressPercent').textContent = `${pct}% Read`;

    const resumeBtn = document.getElementById('resumeReadBtn');
    resumeBtn.onclick = () => {
      Reader.openNovel(lastRead.novel_id, true);
    };
  },

  checkSleepTimerResume() {
    try {
      const raw = localStorage.getItem('byob_pending_sleep_resume') || localStorage.getItem('kuroyomi_pending_sleep_resume');
      if (!raw) return;
      const record = JSON.parse(raw);
      if (!record || !record.finish) {
        localStorage.removeItem('byob_pending_sleep_resume');
        localStorage.removeItem('kuroyomi_pending_sleep_resume');
        return;
      }

      const modal = document.getElementById('sleepResumeModal');
      const backdrop = document.getElementById('sleepResumeBackdrop');
      const desc = document.getElementById('sleepResumeDesc');
      const finishSub = document.getElementById('sleepResumeFinishedSub');
      const startedSub = document.getElementById('sleepResumeStartedSub');
      const resumeFinBtn = document.getElementById('resumeWhereFinishedBtn');
      const resumeStartBtn = document.getElementById('resumeWhereStartedBtn');
      const closeBtn = document.getElementById('closeSleepResumeBtn');

      if (!modal || !backdrop) return;

      const title = record.novel_title || 'your novel';
      if (desc) {
        desc.innerHTML = `Your sleep timer finished while reading <strong>${escapeHtml(title)}</strong>. Where would you like to resume?`;
      }

      if (finishSub) {
        const chTitle = record.finish.chapter_title || 'Chapter';
        const pIdx = (record.finish.paragraph_index !== undefined) ? record.finish.paragraph_index + 1 : 1;
        finishSub.textContent = `${chTitle} · Para ${pIdx}`;
      }

      if (startedSub) {
        if (record.start) {
          const chTitle = record.start.chapter_title || 'Chapter';
          const pIdx = (record.start.paragraph_index !== undefined) ? record.start.paragraph_index + 1 : 1;
          startedSub.textContent = `${chTitle} · Para ${pIdx}`;
          if (resumeStartBtn) resumeStartBtn.style.display = 'block';
        } else {
          if (resumeStartBtn) resumeStartBtn.style.display = 'none';
        }
      }

      const hide = () => {
        modal.style.display = 'none';
        backdrop.style.display = 'none';
        localStorage.removeItem('byob_pending_sleep_resume');
        localStorage.removeItem('kuroyomi_pending_sleep_resume');
      };

      if (closeBtn) closeBtn.onclick = hide;
      if (backdrop) backdrop.onclick = hide;

      if (resumeFinBtn) {
        resumeFinBtn.onclick = async () => {
          hide();
          if (record.novel_id && record.finish.chapter_id) {
            await Reader.openNovel(record.novel_id, false);
            Reader.targetParagraphIndex = record.finish.paragraph_index;
            Reader.targetScrollPercent = record.finish.scroll_percent || 0;
            await Reader.loadChapter(record.finish.chapter_id, true);
          }
        };
      }

      if (resumeStartBtn) {
        resumeStartBtn.onclick = async () => {
          hide();
          if (record.novel_id && record.start && record.start.chapter_id) {
            await Reader.openNovel(record.novel_id, false);
            Reader.targetParagraphIndex = record.start.paragraph_index;
            Reader.targetScrollPercent = record.start.scroll_percent || 0;
            await Reader.loadChapter(record.start.chapter_id, true);
          }
        };
      }

      modal.style.display = 'block';
      backdrop.style.display = 'block';
    } catch (e) {
      console.warn('Error checking sleep timer resume:', e);
      localStorage.removeItem('byob_pending_sleep_resume');
      localStorage.removeItem('kuroyomi_pending_sleep_resume');
    }
  },

  cancelPendingSleepResume() {
    try {
      localStorage.removeItem('byob_pending_sleep_resume');
      localStorage.removeItem('kuroyomi_pending_sleep_resume');
    } catch (e) {}
    if (typeof TTSEngine !== 'undefined') {
      TTSEngine.sleepModeExpired = false;
    }
  },

  getSortedAndFilteredNovels() {
    let list = [...(this.novels || [])];

    // 1. Filter by search query
    const q = (this.searchQuery || '').trim().toLowerCase();
    if (q) {
      list = list.filter(n => {
        const t = (n.title || '').toLowerCase();
        const a = (n.author || '').toLowerCase();
        return t.includes(q) || a.includes(q);
      });
    }

    // 2. Sort by selected criterion
    const sortBy = (window.ReaderSettings && window.ReaderSettings.library_sort_by) || 'last_read';
    if (sortBy === 'upload_date') {
      list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    } else if (sortBy === 'length') {
      list.sort((a, b) => (b.total_chapters || 0) - (a.total_chapters || 0));
    } else if (sortBy === 'title') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
    } else {
      // Default: last_read
      const getLastReadTime = (n) => {
        let t = n.last_read_at || 0;
        if (typeof Storage !== 'undefined' && Storage.getLocalProgress) {
          const local = Storage.getLocalProgress(n.id);
          if (local && local.savedAt) {
            t = Math.max(t, local.savedAt / 1000);
          }
        }
        return Math.max(t, n.created_at || 0);
      };
      list.sort((a, b) => getLastReadTime(b) - getLastReadTime(a));
    }

    return list;
  },

  renderLibraryGrid() {
    const grid = document.getElementById('novelGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const countBadge = document.getElementById('libraryCountBadge');
    const viewMode = (window.ReaderSettings && window.ReaderSettings.library_view_mode) || 'tile';
    grid.className = (viewMode === 'list') ? 'novel-list' : 'novel-grid';

    if (this.novels.length === 0) {
      if (countBadge) countBadge.textContent = '0 Novels';
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; border: 1px dashed var(--border-color); border-radius: 8px;">
          <p style="font-size: 15px; font-weight: 600; margin-bottom: 6px;">Your Library is Empty</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 18px; max-width: 440px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            If you uploaded novels on another device (like your Mac), pair your sync key from that device or restore a backup.
          </p>
          <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
            <button class="btn-brutal btn-brutal-accent" onclick="App.openUploadModal()">+ Upload Novel .EPUB</button>
            <button class="btn-brutal" onclick="App.openMasterPanel('tabSync')">Pair Devices</button>
          </div>
        </div>
      `;
      return;
    }

    const items = this.getSortedAndFilteredNovels();

    if (countBadge) {
      if (this.searchQuery && this.searchQuery.trim()) {
        countBadge.textContent = `${items.length} of ${this.novels.length}`;
      } else {
        countBadge.textContent = `${this.novels.length} ${this.novels.length === 1 ? 'Novel' : 'Novels'}`;
      }
    }

    if (items.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; border: 1px dashed var(--border-color); border-radius: 8px;">
          <p style="font-size: 14px; font-weight: 600; margin-bottom: 6px;">No novels match "${escapeHtml(this.searchQuery)}"</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">Try adjusting your search query or clear the filter.</p>
          <button class="btn-brutal btn-sm" id="emptyClearSearchBtn">Clear Search</button>
        </div>
      `;
      const clrBtn = document.getElementById('emptyClearSearchBtn');
      if (clrBtn) {
        clrBtn.onclick = () => {
          this.searchQuery = '';
          const searchInput = document.getElementById('librarySearchInput');
          if (searchInput) searchInput.value = '';
          const clearBtn = document.getElementById('librarySearchClearBtn');
          if (clearBtn) clearBtn.style.display = 'none';
          this.renderLibraryGrid();
        };
      }
      return;
    }

    items.forEach(n => {
      const coverSrc = this.coverFor(n);
      let lastReadTag = n.last_chapter_title ? `Last: ${n.last_chapter_title}` : 'Not started';
      let readPercent = Math.round(n.progress_overall_percent !== undefined ? n.progress_overall_percent : (n.progress_scroll || 0));

      const activeUserId = (window.SyncService && SyncService.currentUserId) || (window.Storage && Storage.getUserId()) || 'guest';
      const localProg = (typeof Storage !== 'undefined' && Storage.getLocalProgress) ? Storage.getLocalProgress(n.id, activeUserId) : null;
      if (localProg) {
        const localTime = localProg.savedAt || 0;
        const serverTime = (n.last_read_at || 0) * 1000;
        if (localTime >= serverTime || readPercent === 0) {
          if (localProg.overallPercent !== undefined) {
            readPercent = Math.round(localProg.overallPercent);
          } else if (localProg.scrollPercent !== undefined) {
            readPercent = Math.round(localProg.scrollPercent);
          }
          if (localProg.chapterTitle) {
            lastReadTag = `Last: ${localProg.chapterTitle}`;
          }
        }
      }

      if (viewMode === 'list') {
        const card = document.createElement('div');
        card.className = 'novel-card-list';
        card.setAttribute('data-id', n.id);
        card.innerHTML = `
          <div class="novel-list-cover-wrap" title="Open ${escapeHtml(n.title)}">
            <img src="${escapeHtml(coverSrc)}" class="novel-list-cover" alt="${escapeHtml(n.title)}" loading="lazy" />
          </div>
          <div class="novel-list-body">
            <h3 class="novel-list-title">${escapeHtml(n.title)}</h3>
            <p class="novel-list-author">${escapeHtml(n.author || 'Unknown')}</p>
            <div class="novel-list-meta">
              <span class="badge-brutal accent">${n.volume_count || 1} Vol</span>
              <span class="badge-brutal">${n.total_chapters || 0} Ch</span>
            </div>
            <div class="novel-list-progress-bar">
              <span class="novel-list-progress-info">${escapeHtml(lastReadTag)}</span>
              <div class="progress-bar-container" style="flex: 1; min-width: 50px;">
                <div class="progress-bar-fill" style="width: ${readPercent}%;"></div>
              </div>
              <span class="badge-brutal" style="font-size: 10px; padding: 1px 5px;">${readPercent}%</span>
            </div>
          </div>
          <div class="novel-list-actions" style="display: flex; align-items: center; gap: 8px;">
            <button class="btn-brutal btn-brutal-accent btn-sm read-novel-btn" data-id="${escapeHtml(n.id)}">Read</button>
            <button class="btn-brutal btn-sm novel-settings-cog-btn" data-id="${escapeHtml(n.id)}" title="Book Settings (+ Volume, Change Cover, Fix Dotted Words, Delete)" style="padding: 6px 9px; display: flex; align-items: center; justify-content: center;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        `;

        card.querySelector('.read-novel-btn').onclick = () => Reader.openNovel(n.id, true);
        const listTitle = card.querySelector('.novel-list-title');
        if (listTitle) listTitle.onclick = () => Reader.openNovel(n.id, true);
        const listSettingsBtn = card.querySelector('.novel-settings-cog-btn');
        if (listSettingsBtn) listSettingsBtn.onclick = (e) => { e.stopPropagation(); this.openNovelSettingsModal(n.id, n.title, coverSrc); };
        card.querySelector('.novel-list-cover-wrap').onclick = () => Reader.openNovel(n.id, true);

        grid.appendChild(card);
      } else {
        const card = document.createElement('div');
        card.className = 'novel-card';
        card.setAttribute('data-id', n.id);
        card.innerHTML = `
          <div class="novel-card-cover-wrap" title="Open ${escapeHtml(n.title)}">
            <img src="${escapeHtml(coverSrc)}" class="novel-card-cover-bg" alt="" aria-hidden="true" loading="lazy" />
            <img src="${escapeHtml(coverSrc)}" class="novel-card-cover" alt="${escapeHtml(n.title)}" loading="lazy" />
            ${readPercent > 0 ? `<div class="novel-card-cover-progress"><div style="width: ${readPercent}%;"></div></div>` : ''}
          </div>
          <div class="novel-card-body">
            <h3 class="novel-card-title">${escapeHtml(n.title)}</h3>
            <p class="novel-card-author">${escapeHtml(n.author || 'Unknown')}</p>
            <div class="novel-card-meta">
              <span class="badge-brutal accent">${n.volume_count || 1} Vol</span>
              <span class="badge-brutal">${n.total_chapters || 0} Ch</span>
            </div>
            <div class="novel-card-progress">
              <div class="novel-card-progress-info">
                <span>${escapeHtml(lastReadTag)}</span>
                <span>${readPercent}%</span>
              </div>
              <div class="progress-bar-container" style="max-width: 100%;">
                <div class="progress-bar-fill" style="width: ${readPercent}%;"></div>
              </div>
            </div>
            <div class="novel-card-actions">
              <div class="novel-card-primary-action" style="flex: 1; display: flex; gap: 8px;">
                <button class="btn-brutal btn-brutal-accent read-novel-btn" data-id="${escapeHtml(n.id)}" style="flex: 1;">Read</button>
                <button class="btn-brutal btn-sm novel-settings-cog-btn" data-id="${escapeHtml(n.id)}" title="Book Settings (+ Volume, Change Cover, Fix Dotted Words, Delete)" style="padding: 7px 11px; display: flex; align-items: center; justify-content: center;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `;

        card.querySelector('.read-novel-btn').onclick = () => Reader.openNovel(n.id, true);
        const cardTitle = card.querySelector('.novel-card-title');
        if (cardTitle) cardTitle.onclick = () => Reader.openNovel(n.id, true);
        const cardSettingsBtn = card.querySelector('.novel-settings-cog-btn');
        if (cardSettingsBtn) cardSettingsBtn.onclick = (e) => { e.stopPropagation(); this.openNovelSettingsModal(n.id, n.title, coverSrc); };
        card.querySelector('.novel-card-cover-wrap').onclick = () => Reader.openNovel(n.id, true);

        grid.appendChild(card);
      }
    });
  },

  async deleteNovel(novelId, title) {
    if (!confirm(`Delete "${title}" from your library?`)) return;
    try {
      this.showLoading('Deleting...');

      // 1. Remove from local device mirror first so it NEVER auto-restores
      const userId = SyncService.currentUserId;
      if (typeof IDB !== 'undefined') {
        await IDB.removeNovelFromMirror(userId, novelId);
      }

      // 2. Delete from server
      await fetch('/api/novels/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          novel_id: novelId,
          user_id: userId
        })
      });

      // 3. Reload library WITHOUT auto-restore so it stays deleted
      await this.loadLibrary(false);
      this.hideLoading();
      this.showToast(`Deleted "${title}"`);
    } catch (e) {
      this.hideLoading();
      alert('Delete failed: ' + e.message);
    }
  },

  naturalSortFiles(files) {
    return files.slice().sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  },

  openNovelSettingsModal(novelId, title, coverSrc) {
    this.activeSettingsNovel = { id: novelId, title: title, coverSrc: coverSrc };
    const modal = document.getElementById('novelSettingsModal');
    const nameEl = document.getElementById('novelSettingsBookName');
    const statusEl = document.getElementById('novelSettingsCleanStatus');
    if (nameEl) nameEl.textContent = title || 'Selected Book';
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
    }
    if (modal) modal.style.display = 'flex';
  },

  closeNovelSettingsModal() {
    const modal = document.getElementById('novelSettingsModal');
    if (modal) modal.style.display = 'none';
    this.activeSettingsNovel = null;
  },

  bindNovelSettingsModalEvents() {
    const backdrop = document.getElementById('novelSettingsBackdrop');
    const closeBtn = document.getElementById('closeNovelSettingsBtn');
    if (backdrop) backdrop.addEventListener('click', () => this.closeNovelSettingsModal());
    if (closeBtn) closeBtn.addEventListener('click', () => this.closeNovelSettingsModal());

    const addVolBtn = document.getElementById('novelSettingsAddVolBtn');
    if (addVolBtn) {
      addVolBtn.addEventListener('click', () => {
        if (!this.activeSettingsNovel) return;
        const { id, title } = this.activeSettingsNovel;
        this.closeNovelSettingsModal();
        this.openUploadModal(id, title);
      });
    }

    const coverBtn = document.getElementById('novelSettingsCoverBtn');
    if (coverBtn) {
      coverBtn.addEventListener('click', () => {
        if (!this.activeSettingsNovel) return;
        const { id } = this.activeSettingsNovel;
        this.closeNovelSettingsModal();
        this.targetCoverNovelId = id;
        const input = document.getElementById('novelCoverInput');
        if (input) {
          input.value = '';
          input.click();
        }
      });
    }

    const cleanBtn = document.getElementById('novelSettingsCleanBtn');
    if (cleanBtn) {
      cleanBtn.addEventListener('click', async () => {
        if (!this.activeSettingsNovel) return;
        const { id, title } = this.activeSettingsNovel;
        const statusEl = document.getElementById('novelSettingsCleanStatus');
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.style.borderColor = 'var(--accent)';
          statusEl.textContent = 'Fixing dotted words across all chapters...';
        }
        try {
          const uid = (window.SyncService && window.SyncService.currentUserId) || (window.ReaderSettings && window.ReaderSettings.user_id) || 'usr_default';
          const res = await fetch('/api/novels/clean-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ novel_id: id, user_id: uid })
          });
          const data = await res.json();
          if (data.success) {
            if (statusEl) {
              statusEl.style.borderColor = 'var(--accent)';
              statusEl.textContent = `Cleaned ${data.cleaned_chapters} of ${data.total_chapters} chapters successfully!`;
            }
            // If currently reading this novel, reload chapter content
            if (window.Reader && window.Reader.currentNovel && window.Reader.currentNovel.id === id) {
              if (window.Reader.currentChapter) {
                window.Reader.loadChapter(window.Reader.currentChapter.id, false);
              }
            }
          } else {
            if (statusEl) {
              statusEl.style.borderColor = '#ef4444';
              statusEl.textContent = `Error: ${data.error || 'Failed to clean text'}`;
            }
          }
        } catch (err) {
          if (statusEl) {
            statusEl.style.borderColor = '#ef4444';
            statusEl.textContent = `Request failed: ${err.message}`;
          }
        }
      });
    }

    const rechapterBtn = document.getElementById('novelSettingsRechapterBtn');
    if (rechapterBtn) {
      rechapterBtn.addEventListener('click', async () => {
        if (!this.activeSettingsNovel || rechapterBtn.disabled) return;
        const { id } = this.activeSettingsNovel;
        const statusEl = document.getElementById('novelSettingsCleanStatus');
        const say = (msg, bad = false) => {
          if (!statusEl) return;
          statusEl.style.display = 'block';
          statusEl.style.borderColor = bad ? '#ef4444' : 'var(--accent)';
          statusEl.textContent = msg;
        };
        rechapterBtn.disabled = true;
        say('Joining page fragments into real chapters...');
        try {
          const uid = (window.SyncService && window.SyncService.currentUserId) || Storage.getUserId() || 'usr_default';
          const res = await fetch('/api/novels/rechapter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ novel_id: id, user_id: uid })
          });
          const data = await res.json();
          if (!data.success) {
            say(`Error: ${data.error || 'Could not fix chapter breaks'}`, true);
            return;
          }
          if (!data.merged) {
            say('Chapters already look right. Nothing changed.');
            return;
          }
          // Move this device's saved spot onto the merged chapter so the book reopens where it was.
          const remap = data.remap || {};
          const local = Storage.getLocalProgress(id, uid);
          if (local && local.chapterId && remap[local.chapterId]) {
            const [newId, offset] = remap[local.chapterId];
            Storage.saveLocalProgress(id, {
              ...local,
              chapterId: newId,
              paragraphIndex: (local.paragraphIndex || 0) + (offset || 0)
            }, uid);
          }
          if (window.Reader && window.Reader.chapterCache) window.Reader.chapterCache.clear();
          await this.updateDeviceMirror();
          say(`Done: ${data.total_before} entries joined into ${data.total_after} chapters. Your place is kept.`);
          if (window.Reader && window.Reader.currentNovel && window.Reader.currentNovel.id === id) {
            this.closeNovelSettingsModal();
            window.Reader.openNovel(id, true);
          } else {
            this.loadLibrary(false);
          }
        } catch (err) {
          say(`Request failed: ${err.message}`, true);
        } finally {
          rechapterBtn.disabled = false;
        }
      });
    }

    const deleteBtn = document.getElementById('novelSettingsDeleteBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (!this.activeSettingsNovel) return;
        const { id, title } = this.activeSettingsNovel;
        this.closeNovelSettingsModal();
        this.deleteNovel(id, title);
      });
    }
  },

  openUploadModal(targetNovelId = null, targetNovelTitle = null) {
    this.targetUploadNovelId = targetNovelId;
    this.selectedUploadFiles = [];
    this.uploadAppendMode = false;
    this.pendingUploadCover = null;
    this.renderUploadCoverPreview();
    document.getElementById('uploadModal').style.display = 'flex';
    document.getElementById('epubFileInput').value = '';
    this.renderUploadFileList();
    document.getElementById('uploadProgress').style.display = 'none';

    const targetNotice = document.getElementById('uploadTargetNotice');
    if (targetNovelId && targetNovelTitle) {
      targetNotice.style.display = 'block';
      targetNotice.innerHTML = `Adding volumes to existing novel: <strong>${escapeHtml(targetNovelTitle)}</strong>`;
      document.getElementById('customTitleGroup').style.display = 'none';
    } else {
      targetNotice.style.display = 'none';
      document.getElementById('customTitleGroup').style.display = 'block';
      document.getElementById('seriesTitleInput').value = '';
    }
  },

  closeUploadModal() {
    document.getElementById('uploadModal').style.display = 'none';
  },

  handleSelectedFiles(fileList, append = false) {
    const valid = Array.from(fileList).filter(f => {
      const lower = f.name.toLowerCase();
      return lower.endsWith('.epub') || lower.endsWith('.pdf');
    });
    if (!valid.length) {
      alert('Please select .epub or .pdf files.');
      return;
    }

    if (append && this.selectedUploadFiles && this.selectedUploadFiles.length > 0) {
      const existingSignatures = new Set(this.selectedUploadFiles.map(f => `${f.name}:${f.size}`));
      const newItems = valid.filter(f => !existingSignatures.has(`${f.name}:${f.size}`));
      const sortedNew = this.naturalSortFiles(newItems);
      this.selectedUploadFiles = this.selectedUploadFiles.concat(sortedNew);
    } else {
      this.selectedUploadFiles = this.naturalSortFiles(valid);
    }

    this.renderUploadFileList();
  },

  renderUploadFileList() {
    const listEl = document.getElementById('uploadFileList');
    const queueHeader = document.getElementById('uploadQueueHeader');
    const orderHint = document.getElementById('uploadOrderHint');
    const countEl = document.getElementById('uploadFileCount');

    if (!listEl) return;
    listEl.innerHTML = '';

    const files = this.selectedUploadFiles || [];
    if (queueHeader) queueHeader.style.display = files.length > 0 ? 'flex' : 'none';
    if (orderHint) orderHint.style.display = files.length > 1 ? 'block' : 'none';
    if (countEl) countEl.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;

    files.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'upload-file-item';

      const left = document.createElement('div');
      left.className = 'upload-file-item-left';

      const badge = document.createElement('span');
      badge.className = 'upload-order-badge';
      badge.textContent = `Vol ${idx + 1}`;

      const details = document.createElement('div');
      details.className = 'upload-file-details';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'upload-file-name';
      nameSpan.textContent = file.name;
      nameSpan.title = file.name;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'upload-file-meta';
      const ext = file.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'EPUB';
      metaSpan.textContent = `${ext} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

      details.appendChild(nameSpan);
      details.appendChild(metaSpan);
      left.appendChild(badge);
      left.appendChild(details);

      const actions = document.createElement('div');
      actions.className = 'upload-item-actions';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'upload-reorder-btn move-up';
      upBtn.title = 'Move volume up';
      upBtn.textContent = '▲';
      if (idx === 0) upBtn.disabled = true;
      upBtn.addEventListener('click', () => {
        if (idx > 0) {
          const temp = this.selectedUploadFiles[idx];
          this.selectedUploadFiles[idx] = this.selectedUploadFiles[idx - 1];
          this.selectedUploadFiles[idx - 1] = temp;
          this.renderUploadFileList();
        }
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'upload-reorder-btn move-down';
      downBtn.title = 'Move volume down';
      downBtn.textContent = '▼';
      if (idx === files.length - 1) downBtn.disabled = true;
      downBtn.addEventListener('click', () => {
        if (idx < this.selectedUploadFiles.length - 1) {
          const temp = this.selectedUploadFiles[idx];
          this.selectedUploadFiles[idx] = this.selectedUploadFiles[idx + 1];
          this.selectedUploadFiles[idx + 1] = temp;
          this.renderUploadFileList();
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'upload-remove-btn';
      removeBtn.title = 'Remove file';
      removeBtn.textContent = 'X';
      removeBtn.addEventListener('click', () => {
        this.selectedUploadFiles.splice(idx, 1);
        this.renderUploadFileList();
      });

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(removeBtn);

      item.appendChild(left);
      item.appendChild(actions);
      listEl.appendChild(item);
    });
  },

  async performUpload() {
    if (!this.selectedUploadFiles || !this.selectedUploadFiles.length) {
      alert('Please select at least one .epub or .pdf file.');
      return;
    }

    const formData = new FormData();
    formData.append('user_id', SyncService.currentUserId);
    if (this.targetUploadNovelId) {
      formData.append('novel_id', this.targetUploadNovelId);
    }
    const seriesTitle = document.getElementById('seriesTitleInput').value.trim();
    if (seriesTitle) {
      formData.append('series_title', seriesTitle);
    }

    const fileOrder = this.selectedUploadFiles.map(f => f.name);
    formData.append('file_order', JSON.stringify(fileOrder));

    this.selectedUploadFiles.forEach(file => {
      formData.append('files', file);
    });

    const progressDiv = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressText = document.getElementById('uploadProgressText');
    progressDiv.style.display = 'block';
    progressFill.style.width = '40%';
    progressText.textContent = `Processing ${this.selectedUploadFiles.length} file(s) in volume order...`;

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      let data = null;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (jsonErr) {
          data = null;
        }
      }

      if (!res.ok || !data || !data.success) {
        if (res.status === 413) {
          throw new Error('File exceeds upload limit (50MB). Please upload a smaller file or one volume at a time.');
        } else if (res.status === 502 || res.status === 503) {
          throw new Error('Server is currently waking up or restarting. Please wait 10 seconds and try again.');
        } else if (res.status === 504) {
          throw new Error('Upload timed out. Try uploading fewer files or one volume at a time.');
        } else if (data && data.error) {
          throw new Error(data.error);
        } else {
          const rawText = await res.text().catch(() => '');
          throw new Error(`Server returned HTTP ${res.status}: ${rawText.slice(0, 100) || 'Upload failed'}`);
        }
      }

      progressFill.style.width = '100%';
      progressText.textContent = 'Saving to device storage...';

      // Cover picked in the upload form beats the one inside the file
      if (this.pendingUploadCover && data.novel_id) {
        progressText.textContent = 'Saving cover...';
        await this.applyCover(data.novel_id, this.pendingUploadCover);
        this.pendingUploadCover = null;
      }

      // Immediately mirror to IndexedDB so novel is bulletproof against any reload/restart
      await this.updateDeviceMirror();

      // Automatic Cloud Push: If running locally on Mac, push novel to Render cloud in background
      const host = window.location.hostname;
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
                          /^10\.\d+\.\d+\.\d+$/.test(host) ||
                          /^192\.168\.\d+\.\d+$/.test(host) ||
                          /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);

      if (isLocalHost && navigator.onLine) {
        this.showToast('Syncing novel to cloud for phone reader...');
        SyncService.pushLibraryToCloud().then((res) => {
          console.log('[CloudSync] Novel successfully pushed to cloud:', res);
          this.showToast(`Cloud Sync Complete: Pushed ${res.novelsCount} novel(s) to cloud!`);
        }).catch((err) => {
          console.warn('[CloudSync] Automatic cloud push notice:', err);
        });
      }

      if (data.duplicates_skipped && data.duplicates_skipped > 0) {
        this.showToast(`Uploaded ${data.chapters_added} chapters across ${data.volumes_added} volume(s) (${data.duplicates_skipped} duplicates skipped)`);
      } else {
        this.showToast(`Uploaded ${data.chapters_added} chapters across ${data.volumes_added} volume(s)`);
      }

      setTimeout(async () => {
        this.closeUploadModal();
        await this.loadLibrary();
        Reader.openNovel(data.novel_id, false);
      }, 300);
    } catch (e) {
      progressDiv.style.display = 'none';
      alert('Upload error: ' + e.message);
    }
  },

  switchView(view, resetScroll = true) {
    this.currentView = view;
    const appHeader = document.querySelector('.app-header');
    const libView = document.getElementById('libraryView');
    const readerView = document.getElementById('readerView');

    if (view === 'reader') {
      if (appHeader) appHeader.style.display = 'none';
      if (libView) libView.style.display = 'none';
      if (readerView) readerView.style.display = 'flex';
      if (resetScroll) window.scrollTo(0, 0);
    } else {
      try { this.closeMasterPanel(); } catch (e) {}
      try { this.closeMobileQuickSheet(); } catch (e) {}
      if (appHeader) appHeader.style.display = 'flex';
      if (libView) libView.style.display = 'block';
      if (readerView) readerView.style.display = 'none';
      if (resetScroll) window.scrollTo(0, 0);
    }
  },

  showLoading(text) {
    const overlay = document.getElementById('loadingOverlay');
    const label = document.getElementById('loadingText');
    if (overlay && label) {
      label.textContent = text || 'Loading...';
      overlay.style.display = 'flex';
    }
  },

  hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
  },

  showToast(msg) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
};

window.App = App;
window.Reader = Reader;
window.AutoScroll = AutoScroll;
window.TTSEngine = TTSEngine;
window.SyncService = SyncService;
window.Storage = Storage;

// Small version tag on the library screen: asset release 48 shows as 0.4.8, release 50 as 0.5.0
function showAppVersion() {
  const tag = document.getElementById('appVersionTag');
  const src = (document.querySelector('script[src*="app.js"]') || {}).src || '';
  const m = src.match(/[?&]v=(\d+)/);
  if (!tag || !m) return;
  const n = parseInt(m[1], 10);
  tag.textContent = `0.${Math.floor(n / 10)}.${n % 10}`;

  // Tap the version three times quickly to see (and copy) what read aloud has been doing on this device
  let taps = [];
  tag.addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 1500).concat(now);
    if (taps.length >= 3) { taps = []; showPlaybackLog(); }
  });
}

function showPlaybackLog() {
  let lines = [];
  try { lines = JSON.parse(localStorage.getItem('kuroyomi_tts_log') || '[]'); } catch (e) {}
  const text = lines.length ? lines.join('\n') : '(nothing recorded yet)';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;gap:10px;padding:16px;';
  const area = document.createElement('textarea');
  area.readOnly = true;
  area.value = text;
  area.style.cssText = 'flex:1;width:100%;background:#111;color:#ddd;border:1px solid #333;border-radius:8px;padding:10px;font:12px monospace;';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;font-size:14px;';
    b.onclick = fn;
    return b;
  };
  row.append(
    mk('Copy', () => { area.select(); try { navigator.clipboard.writeText(text); } catch (e) { document.execCommand('copy'); } }),
    mk('Close', () => box.remove())
  );
  box.append(area, row);
  document.body.appendChild(box);
  area.scrollTop = area.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
  showAppVersion();
  App.init();
});
