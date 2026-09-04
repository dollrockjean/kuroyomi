// KuroYomi Main Application Controller
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
  content_width: 'normal',
  margin_width: 'edge',
  auto_scroll_speed: 35,
  tts_voice: 'en-US-BrianNeural',
  tts_rate: 1.0,
  tts_pitch: 1.0
};

const App = {
  currentView: 'library',
  novels: [],
  selectedUploadFiles: [],
  targetUploadNovelId: null,
  targetCoverNovelId: null,
  debounceSyncTimeout: null,

  debounceSyncSettings() {
    if (this.debounceSyncTimeout) clearTimeout(this.debounceSyncTimeout);
    this.debounceSyncTimeout = setTimeout(() => {
      SyncService.syncSettings(window.ReaderSettings);
    }, 350);
  },

  async init() {
    this.showLoading('Connecting...');

    // 1. Initialize reading engines first
    AutoScroll.init(() => Reader.loadNextChapter());
    TTSEngine.init(() => Reader.loadNextChapter());
    Reader.init();

    // 2. Load locally cached settings first for instant zero-flicker render
    const localSettings = Storage.getLocalSettings();
    if (localSettings && Object.keys(localSettings).length > 0) {
      this.applySettings(localSettings, false);
    } else {
      this.applySettings(window.ReaderSettings, false);
    }

    // 3. Connect to sync service & fetch cloud account settings
    const session = await SyncService.init();
    if (session && session.settings && Object.keys(session.settings).length > 0) {
      if (localSettings && Object.keys(localSettings).length > 0) {
        const merged = { ...session.settings, ...localSettings };
        this.applySettings(merged, false);
        SyncService.syncSettings(merged);
      } else {
        this.applySettings(session.settings, false);
      }
    }

    this.bindGlobalEvents();
    this.bindMasterPanelEvents();
    this.bindSettingsEvents();
    this.bindMobileQuickSheetEvents();
    this.bindSyncEvents();
    this.bindBackupRestoreEvents();
    this.bindNetworkEvents();

    // Register Service Worker for Mobile PWA Offline Reading
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[SW] ServiceWorker registered with scope:', reg.scope);
      }).catch((err) => {
        console.warn('[SW] ServiceWorker registration failed:', err);
      });
    }

    await this.loadLibrary();
    this.hideLoading();
  },

  bindGlobalEvents() {
    document.getElementById('logoBtn').addEventListener('click', () => {
      AutoScroll.stop();
      TTSEngine.stop();
      this.switchView('library');
    });

    document.getElementById('backToLibraryBtn').addEventListener('click', () => {
      AutoScroll.stop();
      TTSEngine.stop();
      this.switchView('library');
      this.loadLibrary();
    });

    // Master Panel Triggers
    document.getElementById('headerMenuBtn').addEventListener('click', () => this.openMasterPanel('tabSync'));
    document.getElementById('readerMenuBtn').addEventListener('click', () => this.openMasterPanel('tabChapters'));
    document.getElementById('footerMenuBtn').addEventListener('click', () => this.openMasterPanel('tabChapters'));
    document.getElementById('floatingQuickMenuBtn').addEventListener('click', () => this.toggleMasterPanel('tabChapters'));

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

    dropzone.addEventListener('click', () => fileInput.click());
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
        this.handleSelectedFiles(e.dataTransfer.files);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        this.handleSelectedFiles(e.target.files);
      }
    });

    document.getElementById('startUploadBtn').addEventListener('click', () => this.performUpload());

    // Custom Cover Image Upload Handler
    const coverInput = document.getElementById('novelCoverInput');
    if (coverInput) {
      coverInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file || !this.targetCoverNovelId) return;

        this.showLoading('Updating cover...');
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = new Image();
          img.onload = async () => {
            try {
              const maxW = 600;
              let w = img.width;
              let h = img.height;
              if (w > maxW) {
                h = Math.round((h * maxW) / w);
                w = maxW;
              }
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

              const res = await fetch('/api/novels/cover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  novel_id: this.targetCoverNovelId,
                  user_id: SyncService.currentUserId,
                  cover_data: dataUrl
                })
              });
              const resData = await res.json();
              this.hideLoading();
              if (resData.success) {
                this.showToast('Cover updated');
                await this.loadLibrary();
              } else {
                alert('Could not update cover: ' + (resData.error || 'Unknown error'));
              }
            } catch (err) {
              this.hideLoading();
              alert('Cover upload failed: ' + err.message);
            }
            coverInput.value = '';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
    }
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
      if (TTSEngine.isPlaying) {
        TTSEngine.pause();
        document.getElementById('ttsPlayToggleBtn').textContent = 'Start Read Aloud';
      } else {
        TTSEngine.start();
        document.getElementById('ttsPlayToggleBtn').textContent = 'Pause Read Aloud';
        this.closeMasterPanel();
      }
    });

    document.getElementById('testVoiceBtn').addEventListener('click', () => {
      TTSEngine.testVoice();
    });

    const rateSlider = document.getElementById('ttsRateSlider');
    if (rateSlider) {
      rateSlider.addEventListener('input', (e) => {
        const rate = parseFloat(e.target.value);
        TTSEngine.setRate(rate);
        document.getElementById('ttsRateVal').textContent = `${rate}x`;
        this.applySettings({ tts_rate: rate });
      });
    }

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
    const isReading = this.currentView === 'reader' && Reader.currentNovel;
    const titleEl = document.getElementById('masterPanelTitle');
    const subtitleEl = document.getElementById('masterPanelSubtitle');
    const bookTabs = document.querySelectorAll('.master-tab-btn.book-tab');

    if (isReading) {
      // In-Book Context
      titleEl.textContent = Reader.currentNovel.title;
      if (Reader.currentChapter) {
        subtitleEl.style.display = 'block';
        subtitleEl.textContent = `${Reader.currentChapter.volume_title} · ${Reader.currentChapter.title}`;
      } else {
        subtitleEl.style.display = 'none';
      }
      bookTabs.forEach(t => t.style.display = 'block');
      if (!tabName) tabName = 'tabChapters';
    } else {
      // Library / Main Menu Context: Hide book options
      titleEl.textContent = 'Library Menu';
      subtitleEl.style.display = 'none';
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

    document.getElementById('masterSidePanel').classList.add('open');
    document.getElementById('drawerBackdrop').classList.add('open');
    this.updateSyncDisplay();

    // Center on active chapter if opening chapters tab from within a book
    if (tabName === 'tabChapters' && isReading) {
      Reader.centerActiveChapterInTOC();
    }
  },

  closeMasterPanel() {
    document.getElementById('masterSidePanel').classList.remove('open');
    document.getElementById('drawerBackdrop').classList.remove('open');
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

    // Auto-center TOC on active reading chapter whenever the Chapters tab is selected
    if (tabId === 'tabChapters' && this.currentView === 'reader' && Reader.currentNovel) {
      Reader.centerActiveChapterInTOC();
    }
  },

  openMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (!sheet || !backdrop) return;

    // Ensure state displays are fresh
    const cur = window.ReaderSettings;
    const fontVal = document.getElementById('quickSheetFontVal');
    if (fontVal) fontVal.textContent = `${cur.font_size || 19}px`;

    const marginVal = document.getElementById('quickSheetMarginVal');
    if (marginVal) {
      const labels = { edge: 'Edge', compact: 'Compact', comfortable: 'Relaxed' };
      marginVal.textContent = labels[cur.margin_width || 'edge'] || 'Edge';
    }

    const ttsText = document.getElementById('quickSheetTTSText');
    if (ttsText && typeof TTSEngine !== 'undefined') {
      ttsText.textContent = (TTSEngine.isPlaying && !TTSEngine.isPaused) ? 'Pause' : 'Read Aloud';
    }

    sheet.classList.add('open');
    backdrop.classList.add('open');
  },

  closeMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (sheet) sheet.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
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

    const ttsBtn = document.getElementById('quickSheetTTSBtn');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', () => {
        this.closeMobileQuickSheet();
        if (typeof TTSEngine !== 'undefined') {
          TTSEngine.toggle();
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
  },

  bindSettingsEvents() {
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const theme = btn.getAttribute('data-theme');
        this.applySettings({ theme });
      });
    });

    document.querySelectorAll('.font-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.font-btn').forEach(b => b.classList.remove('selected'));
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

    // 4. Font size & Line height
    doc.style.setProperty('--reader-font-size', `${cur.font_size || 19}px`);
    doc.style.setProperty('--reader-line-height', `${cur.line_height || 1.85}`);

    // Update Theme buttons
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-theme') === cur.theme);
    });
    // Update Font buttons
    document.querySelectorAll('.font-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-font') === cur.font_family);
    });
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

    // 5. Read Speed (TTS Rate)
    const ttsRate = parseFloat(cur.tts_rate || 1.0);
    TTSEngine.rate = ttsRate;
    const rateSlider = document.getElementById('ttsRateSlider');
    if (rateSlider) {
      rateSlider.value = ttsRate;
      const rateVal = document.getElementById('ttsRateVal');
      if (rateVal) rateVal.textContent = `${ttsRate}x`;
    }

    // 6. TTS Voice
    if (cur.tts_voice) {
      TTSEngine.selectedVoice = cur.tts_voice;
      const voiceSelect = document.getElementById('ttsVoiceSelect');
      if (voiceSelect && voiceSelect.value !== cur.tts_voice) {
        voiceSelect.value = cur.tts_voice;
      }
      const modalVoice = document.getElementById('audiobookModalVoiceSelect');
      if (modalVoice && modalVoice.value !== cur.tts_voice) {
        modalVoice.value = cur.tts_voice;
      }
    }
    if (typeof TTSEngine.updateAudioUI === 'function') {
      TTSEngine.updateAudioUI();
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

    // Always persist to local device storage
    Storage.setLocalSettings(cur);

    // Sync to user account
    if (syncToCloud) {
      this.debounceSyncSettings();
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
        const link = `${window.location.origin}/?pair=${encodeURIComponent(key)}`;
        navigator.clipboard.writeText(link).then(() => {
          this.showToast('1-Click Pairing Link copied!');
        }).catch(() => {
          prompt('Copy this link and open it in Safari on your iPhone:', link);
        });
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
          const res = await fetch(`/api/backup?user_id=${encodeURIComponent(SyncService.currentUserId)}`);
          const backupData = await res.json();
          this.hideLoading();

          const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const dateStr = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `kuroyomi_backup_${dateStr}.json`;
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

          const data = await res.json();
          this.hideLoading();
          if (data.success) {
            this.showToast(`Restored ${data.novels_restored || 0} novel(s), ${data.chapters_restored || 0} chapters`);
            await this.loadLibrary();
            fileInput.value = '';
          } else {
            alert('Restore failed: ' + (data.error || 'Unknown error'));
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
  },

  updateOfflineBadges(isOffline) {
    const offline = isOffline !== undefined ? isOffline : !navigator.onLine;
    const topBadge = document.getElementById('mobileOfflineBadge');
    const libBadge = document.getElementById('libraryOfflineBadge');
    if (topBadge) topBadge.style.display = offline ? 'inline-flex' : 'none';
    if (libBadge) libBadge.style.display = offline ? 'inline-flex' : 'none';
  },

  bindNetworkEvents() {
    this.updateOfflineBadges();

    window.addEventListener('online', () => {
      this.updateOfflineBadges(false);
      this.showToast('🌐 Back Online · Syncing with cloud...');
      this.loadLibrary(false);
    });

    window.addEventListener('offline', () => {
      this.updateOfflineBadges(true);
      this.showToast('⚡ Offline Mode · Reading from local cache');
    });
  },

  async loadLibrary(allowAutoRestore = true) {
    try {
      const userId = SyncService.currentUserId;
      if (!userId) return;

      let novelsData = null;
      let lastReadData = null;

      // 1. Attempt network fetch if online
      if (navigator.onLine) {
        try {
          const [novelsRes, lastReadRes] = await Promise.all([
            fetch(`/api/novels?user_id=${encodeURIComponent(userId)}`),
            fetch(`/api/last-read?user_id=${encodeURIComponent(userId)}`)
          ]);
          if (novelsRes.ok) novelsData = await novelsRes.json();
          if (lastReadRes.ok) lastReadData = await lastReadRes.json();
        } catch (netErr) {
          console.warn('Network error loading library, checking local offline mirror:', netErr);
        }
      }

      // 2. Offline Fallback from IndexedDB
      if (!novelsData || !novelsData.novels) {
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
                chapter_title: ch ? ch.title : '',
                scroll_percent: latest.scroll_percent || 0,
                cover_data: book ? book.cover_data : null
              };
            }
            this.renderResumeHero(lastRead);
            this.updateMirrorStatus();
            this.updateOfflineBadges(true);
            return;
          }
        }
      }

      this.novels = novelsData ? (novelsData.novels || []) : [];

      // Auto-Shield: Check if server is missing any books present in local device mirror
      if (allowAutoRestore && typeof IDB !== 'undefined') {
        const mirroredBackup = await IDB.getLibraryMirror(userId);
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
                  backup_data: mirroredBackup
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
        this.updateDeviceMirror();
      }

      this.renderResumeHero(lastReadData.last_read);
      this.renderLibraryGrid();
      this.updateMirrorStatus();
    } catch (e) {
      console.warn('Error loading library:', e);
    }
  },

  async updateDeviceMirror() {
    try {
      const userId = SyncService.currentUserId;
      if (!userId || typeof IDB === 'undefined') return;

      const res = await fetch(`/api/backup?user_id=${encodeURIComponent(userId)}`);
      const serverBackup = await res.json();
      if (!serverBackup || !serverBackup.novels) return;

      const localBackup = await IDB.getLibraryMirror(userId);
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
              backup_data: localBackup
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

  renderResumeHero(lastRead) {
    const hero = document.getElementById('resumeHero');
    if (!lastRead) {
      hero.style.display = 'none';
      return;
    }

    hero.style.display = 'grid';
    document.getElementById('resumeCover').src = lastRead.cover_data || FALLBACK_COVER;
    document.getElementById('resumeNovelTitle').textContent = lastRead.novel_title;
    document.getElementById('resumeChapterTag').textContent = `${lastRead.volume_title} · ${lastRead.chapter_title}`;
    
    const pct = Math.round(lastRead.scroll_percent || 0);
    document.getElementById('resumeProgressBar').style.width = `${pct}%`;
    document.getElementById('resumeProgressPercent').textContent = `${pct}% Read`;

    const resumeBtn = document.getElementById('resumeReadBtn');
    resumeBtn.onclick = () => {
      Reader.openNovel(lastRead.novel_id, true);
    };
  },

  renderLibraryGrid() {
    const grid = document.getElementById('novelGrid');
    grid.innerHTML = '';

    if (this.novels.length === 0) {
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

    this.novels.forEach(n => {
      const card = document.createElement('div');
      card.className = 'novel-card';

      const coverSrc = n.cover_data || FALLBACK_COVER;
      const lastReadTag = n.last_chapter_title ? `Last: ${n.last_chapter_title}` : 'Not started';
      const readPercent = Math.round(n.progress_scroll || 0);

      card.innerHTML = `
        <div class="novel-card-cover-wrap" style="position: relative; cursor: pointer;" title="Click to change cover image">
          <img src="${coverSrc}" class="novel-card-cover" alt="${escapeHtml(n.title)}" loading="lazy" />
          <div class="cover-overlay-badge" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.75); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 6px; font-size: 10px; color: var(--text-secondary); backdrop-filter: blur(4px);">
            Change Cover
          </div>
        </div>
        <div class="novel-card-body">
          <h3 class="novel-card-title">${escapeHtml(n.title)}</h3>
          <p class="novel-card-author">${escapeHtml(n.author || 'Unknown')}</p>
          <div class="novel-card-meta">
            <span class="badge-brutal accent">${n.volume_count || 1} Volumes</span>
            <span class="badge-brutal">${n.total_chapters || 0} Chapters</span>
          </div>
          <div style="margin-bottom: 14px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;">${escapeHtml(lastReadTag)}</span>
              <span>${readPercent}%</span>
            </div>
            <div class="progress-bar-container" style="max-width: 100%;">
              <div class="progress-bar-fill" style="width: ${readPercent}%;"></div>
            </div>
          </div>
          <div class="novel-card-actions">
            <button class="btn-brutal btn-brutal-accent read-novel-btn" data-id="${n.id}">Read</button>
            <button class="btn-brutal add-vol-btn" data-id="${n.id}" title="Add another .epub volume">+ Vol</button>
            <button class="btn-brutal cover-novel-btn" data-id="${n.id}" title="Upload custom cover">Cover</button>
            <button class="btn-brutal delete-novel-btn" data-id="${n.id}" title="Delete novel" style="color: #ef4444;">Del</button>
          </div>
        </div>
      `;

      card.querySelector('.read-novel-btn').onclick = () => Reader.openNovel(n.id, true);
      card.querySelector('.add-vol-btn').onclick = () => this.openUploadModal(n.id, n.title);
      card.querySelector('.delete-novel-btn').onclick = () => this.deleteNovel(n.id, n.title);

      const triggerCover = () => {
        this.targetCoverNovelId = n.id;
        const input = document.getElementById('novelCoverInput');
        if (input) input.click();
      };
      card.querySelector('.novel-card-cover-wrap').onclick = triggerCover;
      card.querySelector('.cover-novel-btn').onclick = triggerCover;

      grid.appendChild(card);
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

  openUploadModal(targetNovelId = null, targetNovelTitle = null) {
    this.targetUploadNovelId = targetNovelId;
    this.selectedUploadFiles = [];
    document.getElementById('uploadModal').style.display = 'flex';
    document.getElementById('epubFileInput').value = '';
    document.getElementById('uploadFileList').innerHTML = '';
    document.getElementById('uploadProgress').style.display = 'none';

    const targetNotice = document.getElementById('uploadTargetNotice');
    if (targetNovelId && targetNovelTitle) {
      targetNotice.style.display = 'block';
      targetNotice.innerHTML = `Adding volumes to existing novel: <strong>${targetNovelTitle}</strong>`;
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

  handleSelectedFiles(fileList) {
    this.selectedUploadFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.epub'));
    if (!this.selectedUploadFiles.length) {
      alert('Please select .epub files.');
      return;
    }

    const listEl = document.getElementById('uploadFileList');
    listEl.innerHTML = '';
    this.selectedUploadFiles.forEach((file, idx) => {
      const item = document.createElement('div');
      item.style.padding = '8px 12px';
      item.style.borderRadius = '4px';
      item.style.border = '1px solid var(--border-color)';
      item.style.marginBottom = '6px';
      item.style.background = 'var(--bg-surface)';
      item.style.fontSize = '12px';
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.innerHTML = `
        <span style="font-weight: 600;">Volume ${idx + 1}: ${file.name}</span>
        <span style="color: var(--text-muted);">${(file.size / 1024 / 1024).toFixed(2)} MB</span>
      `;
      listEl.appendChild(item);
    });
  },

  async performUpload() {
    if (!this.selectedUploadFiles.length) {
      alert('Please select at least one .epub file.');
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

    this.selectedUploadFiles.forEach(file => {
      formData.append('files', file);
    });

    const progressDiv = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressText = document.getElementById('uploadProgressText');
    progressDiv.style.display = 'block';
    progressFill.style.width = '40%';
    progressText.textContent = 'Processing files...';

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Upload failed');
      }

      progressFill.style.width = '100%';
      progressText.textContent = 'Saving to device storage...';

      // Immediately mirror to IndexedDB so novel is bulletproof against any reload/restart
      await this.updateDeviceMirror();

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

  switchView(view) {
    this.currentView = view;
    const appHeader = document.querySelector('.app-header');
    const libView = document.getElementById('libraryView');
    const readerView = document.getElementById('readerView');

    if (view === 'reader') {
      if (appHeader) appHeader.style.display = 'none';
      libView.style.display = 'none';
      readerView.style.display = 'flex';
      window.scrollTo(0, 0);
    } else {
      if (appHeader) appHeader.style.display = 'flex';
      libView.style.display = 'block';
      readerView.style.display = 'none';
      window.scrollTo(0, 0);
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

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
