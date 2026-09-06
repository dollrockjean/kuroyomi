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
  letter_spacing: 0.0,
  content_width: 'normal',
  margin_width: 'edge',
  auto_scroll_speed: 35,
  tts_voice: 'en-US-BrianNeural',
  tts_rate: 1.0,
  tts_pitch: 1.0,
  library_view_mode: 'tile',
  library_sort_by: 'last_read'
};

const App = {
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

  async init() {

    try {
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

      this.bindGlobalEvents();
      this.bindMasterPanelEvents();
      this.bindSettingsEvents();
      this.bindMobileQuickSheetEvents();
      this.bindLibraryToolbarEvents();
      this.bindSyncEvents();
      this.bindBackupRestoreEvents();
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
                  window.location.reload();
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
            window.location.reload();
          }
        });
      }

      // 3. Connect to sync service & fetch cloud account settings (instant local fallback if offline)
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
    document.getElementById('logoBtn').addEventListener('click', () => {
      AutoScroll.stop();
      TTSEngine.stop();
      this.switchView('library');
    });

    const handleGoToLibrary = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
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

    const lineVal = document.getElementById('quickSheetLineVal');
    if (lineVal) lineVal.textContent = (cur.line_height || 1.85).toFixed(2);

    const letterVal = document.getElementById('quickSheetLetterVal');
    if (letterVal) letterVal.textContent = `${(cur.letter_spacing || 0).toFixed(1)}px`;

    const marginVal = document.getElementById('quickSheetMarginVal');
    if (marginVal) {
      const labels = { edge: 'Edge', compact: 'Compact', comfortable: 'Relaxed' };
      marginVal.textContent = labels[cur.margin_width || 'edge'] || 'Edge';
    }

    const ttsText = document.getElementById('quickSheetTTSText');
    if (ttsText && typeof TTSEngine !== 'undefined') {
      ttsText.textContent = (TTSEngine.isPlaying && !TTSEngine.isPaused) ? 'Pause' : 'Read Aloud';
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
  },

  closeMobileQuickSheet() {
    const sheet = document.getElementById('mobileQuickSheet');
    const backdrop = document.getElementById('quickSheetBackdrop');
    if (sheet) sheet.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');

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
        const link = `${baseUrl}/?pair=${encodeURIComponent(key)}`;
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

    const keepaliveInput = document.getElementById('keepaliveUrlInput');
    if (keepaliveInput) {
      keepaliveInput.value = `${window.location.origin}/api/health`;
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
      if (document.visibilityState === 'visible' && navigator.onLine) {
        if (!this._lastWakeCheck || (Date.now() - this._lastWakeCheck > 8000)) {
          this._lastWakeCheck = Date.now();
          if (this.currentView === 'library') {
            this.loadLibrary(false);
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

  async loadLibrary(allowAutoRestore = true) {
    try {
      const userId = SyncService.currentUserId || Storage.getUserId() || 'universal_device_mirror';

      // Immediate loading skeleton if library is empty to avoid any blank or frozen appearance
      if (!this.novels || this.novels.length === 0) {
        const grid = document.getElementById('novelGrid');
        if (grid && !grid.querySelector('.library-skeleton-loader')) {
          grid.innerHTML = `
            <div class="library-skeleton-loader" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; gap: 14px; color: var(--text-secondary);">
              <div class="spinner-brutal" style="width: 28px; height: 28px; border: 3px solid var(--border-color); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
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
                chapter_title: ch ? ch.title : '',
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
                      backup_data: mirror
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

      this.renderResumeHero(lastReadData ? lastReadData.last_read : null);
      this.renderLibraryGrid();
      this.updateMirrorStatus();
      this.updateOfflineBadges();
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
    const resumeTitle = document.getElementById('resumeNovelTitle');
    resumeTitle.textContent = lastRead.novel_title;
    resumeTitle.onclick = () => {
      Reader.openNovel(lastRead.novel_id, true);
    };
    document.getElementById('resumeChapterTag').textContent = `${lastRead.volume_title} · ${lastRead.chapter_title}`;
    
    const pct = Math.round(lastRead.progress_overall_percent !== undefined ? lastRead.progress_overall_percent : (lastRead.scroll_percent || 0));
    document.getElementById('resumeProgressBar').style.width = `${pct}%`;
    document.getElementById('resumeProgressPercent').textContent = `${pct}% Read`;

    const resumeBtn = document.getElementById('resumeReadBtn');
    resumeBtn.onclick = () => {
      Reader.openNovel(lastRead.novel_id, true);
    };
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
        if (typeof Storage !== 'undefined' && Storage.getProgress) {
          const local = Storage.getProgress(SyncService.currentUserId, n.id);
          if (local && local.updated_at) {
            t = Math.max(t, local.updated_at);
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
      const coverSrc = n.cover_data || FALLBACK_COVER;
      const lastReadTag = n.last_chapter_title ? `Last: ${n.last_chapter_title}` : 'Not started';
      const readPercent = Math.round(n.progress_overall_percent !== undefined ? n.progress_overall_percent : (n.progress_scroll || 0));

      const triggerCover = () => {
        this.targetCoverNovelId = n.id;
        const input = document.getElementById('novelCoverInput');
        if (input) input.click();
      };

      if (viewMode === 'list') {
        const card = document.createElement('div');
        card.className = 'novel-card-list';
        card.innerHTML = `
          <div class="novel-list-cover-wrap" style="cursor: pointer;" title="Click to change cover image">
            <img src="${coverSrc}" class="novel-list-cover" alt="${escapeHtml(n.title)}" loading="lazy" />
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
          <div class="novel-list-actions">
            <button class="btn-brutal btn-brutal-accent btn-sm read-novel-btn" data-id="${n.id}">Read</button>
            <button class="btn-brutal btn-sm add-vol-btn" data-id="${n.id}" title="Add another .epub volume">+ Vol</button>
            <button class="btn-brutal btn-sm cover-novel-btn" data-id="${n.id}" title="Upload custom cover">Cover</button>
            <button class="btn-brutal btn-sm btn-brutal-danger delete-novel-btn" data-id="${n.id}" title="Delete novel">Del</button>
          </div>
        `;

        card.querySelector('.read-novel-btn').onclick = () => Reader.openNovel(n.id, true);
        const listTitle = card.querySelector('.novel-list-title');
        if (listTitle) listTitle.onclick = () => Reader.openNovel(n.id, true);
        card.querySelector('.add-vol-btn').onclick = () => this.openUploadModal(n.id, n.title);
        card.querySelector('.delete-novel-btn').onclick = () => this.deleteNovel(n.id, n.title);
        card.querySelector('.novel-list-cover-wrap').onclick = triggerCover;
        card.querySelector('.cover-novel-btn').onclick = triggerCover;

        grid.appendChild(card);
      } else {
        const card = document.createElement('div');
        card.className = 'novel-card';
        card.innerHTML = `
          <div class="novel-card-cover-wrap" style="position: relative; cursor: pointer;" title="Click to change cover image">
            <img src="${coverSrc}" class="novel-card-cover" alt="${escapeHtml(n.title)}" loading="lazy" />
            <div class="cover-overlay-badge">
              Change Cover
            </div>
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
              <div class="novel-card-primary-action">
                <button class="btn-brutal btn-brutal-accent read-novel-btn" data-id="${n.id}">Read</button>
              </div>
              <div class="novel-card-secondary-actions">
                <button class="btn-brutal btn-sm add-vol-btn" data-id="${n.id}" title="Add another .epub volume">+ Vol</button>
                <button class="btn-brutal btn-sm cover-novel-btn" data-id="${n.id}" title="Upload custom cover">Cover</button>
                <button class="btn-brutal btn-sm btn-brutal-danger delete-novel-btn" data-id="${n.id}" title="Delete novel">Del</button>
              </div>
            </div>
          </div>
        `;

        card.querySelector('.read-novel-btn').onclick = () => Reader.openNovel(n.id, true);
        const cardTitle = card.querySelector('.novel-card-title');
        if (cardTitle) cardTitle.onclick = () => Reader.openNovel(n.id, true);
        card.querySelector('.add-vol-btn').onclick = () => this.openUploadModal(n.id, n.title);
        card.querySelector('.delete-novel-btn').onclick = () => this.deleteNovel(n.id, n.title);
        card.querySelector('.novel-card-cover-wrap').onclick = triggerCover;
        card.querySelector('.cover-novel-btn').onclick = triggerCover;

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

  openUploadModal(targetNovelId = null, targetNovelTitle = null) {
    this.targetUploadNovelId = targetNovelId;
    this.selectedUploadFiles = [];
    this.uploadAppendMode = false;
    document.getElementById('uploadModal').style.display = 'flex';
    document.getElementById('epubFileInput').value = '';
    this.renderUploadFileList();
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
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Upload failed');
      }

      progressFill.style.width = '100%';
      progressText.textContent = 'Saving to device storage...';

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

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
