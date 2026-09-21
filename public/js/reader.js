// WebNovel Reader Controller for KuroYomi
const Reader = {
  currentNovel: null,
  currentVolumeId: null,
  currentChapter: null,
  chapterList: [],
  volumes: [],
  targetParagraphIndex: 0,
  targetScrollPercent: 0,
  isControlsVisible: true,
  scrollDebounce: null,
  lastScrollY: 0,

  init() {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    this.bindScroll();
    this.bindCenterScreenTap();
    this.initOverscrollNavigation();
    this.bindDesktopHover();
    this.bindKeyboardShortcuts();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushPendingProgress();
      } else if (document.visibilityState === 'visible') {
        this.checkRemoteSync();
      }
    });
    window.addEventListener('focus', () => {
      this.checkRemoteSync();
    });
    window.addEventListener('pagehide', () => {
      this.flushPendingProgress();
    });
  },

  bindDesktopHover() {
    window.addEventListener('mousemove', (e) => {
      if (!this.currentChapter || document.getElementById('readerView').style.display === 'none') return;
      // Moving cursor to within 90px of the top edge un-hides top navigation bar on desktop
      if (e.clientY <= 90) {
        const topBar = document.getElementById('readerTopBar');
        if (topBar && topBar.classList.contains('minimized')) {
          topBar.classList.remove('minimized');
          this.isControlsVisible = true;
        }
      }
    }, { passive: true });
  },

  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (document.getElementById('readerView').style.display === 'none') return;
      if (e.target.closest('input, textarea, select')) return;

      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        App.toggleMasterPanel('tabChapters');
      } else if (e.key === 'Escape') {
        App.closeMasterPanel();
      }
    });
  },

  bindScroll() {
    window.addEventListener('scroll', () => {
      if (!this.currentChapter || document.getElementById('readerView').style.display === 'none') return;

      const currentScrollY = window.scrollY;
      const topBar = document.getElementById('readerTopBar');
      const floatBar = document.getElementById('readerFloatingBar');

      // Auto-minimize when scrolling down, show when scrolling up
      if (currentScrollY > 80) {
        if (currentScrollY > this.lastScrollY + 12) {
          if (topBar) topBar.classList.add('minimized');
          if (floatBar) floatBar.classList.add('minimized');
          this.isControlsVisible = false;
        } else if (currentScrollY < this.lastScrollY - 15) {
          if (topBar) topBar.classList.remove('minimized');
          if (floatBar) floatBar.classList.remove('minimized');
          this.isControlsVisible = true;
        }
      } else {
        if (topBar) topBar.classList.remove('minimized');
        if (floatBar) floatBar.classList.remove('minimized');
        this.isControlsVisible = true;
      }
      this.lastScrollY = currentScrollY;

      // Whole-book reading progress calculation across all volumes & chapters
      this.updateProgressPill(currentScrollY);

      // Invalidate pending sleep timer resume prompt if user continues scrolling to read
      if (window.TTSEngine && window.TTSEngine.sleepModeExpired) {
        if (!window.TTSEngine.sleepExpiredAt || (Date.now() - window.TTSEngine.sleepExpiredAt > 1000)) {
          if (window.App && typeof window.App.cancelPendingSleepResume === 'function') {
            window.App.cancelPendingSleepResume();
          }
        }
      }

      // Silently debounce saving progress to cloud without toasts
      if (this.isRestoringScroll) return;
      if (this.scrollDebounce) clearTimeout(this.scrollDebounce);
      this.scrollDebounce = setTimeout(() => {
        if (!this.isRestoringScroll) {
          this.saveCurrentProgress();
        }
      }, 500);
    }, { passive: true });
  },

  updateProgressPill(scrollY = window.scrollY) {
    if (!this.currentChapter) return;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const chapterScrollFrac = docHeight > 0 ? Math.min(1, Math.max(0, scrollY / docHeight)) : 0;
    
    let overallPercent = 0;
    const totalCh = (this.chapterList && this.chapterList.length) ? this.chapterList.length : 1;
    let chIdx = 0;
    if (typeof this.currentChapter.global_index === 'number' && this.currentChapter.global_index >= 1) {
      chIdx = this.currentChapter.global_index - 1;
    } else {
      chIdx = this.chapterList.findIndex(c => c.id === this.currentChapter.id);
      if (chIdx < 0) chIdx = 0;
    }
    overallPercent = Math.min(100, Math.max(0, ((chIdx + chapterScrollFrac) / totalCh) * 100));
    
    const pill = document.getElementById('readerProgressPill');
    if (pill) {
      pill.textContent = `${Math.round(overallPercent)}%`;
      pill.title = `Overall Book Progress: ${overallPercent.toFixed(1)}% (Chapter ${(this.currentChapter && this.currentChapter.global_index) || (chIdx + 1)} of ${totalCh})`;
    }
  },

  getVisibleParagraphIndex() {
    const paras = document.querySelectorAll('#readerContent .reader-paragraph, #readerContent .reader-heading');
    let bestPid = 0;
    for (let p of paras) {
      const rect = p.getBoundingClientRect();
      if (rect.top <= window.innerHeight * 0.4) {
        bestPid = parseInt(p.getAttribute('data-pid') || '0');
      } else {
        break;
      }
    }
    return bestPid;
  },

  bindCenterScreenTap() {
    // Tapping the reading text or screen center opens menu / controls
    const wrapper = document.getElementById('readerBodyWrapper');
    if (!wrapper) return;

    wrapper.addEventListener('pointerup', (e) => {
      // Don't trigger on buttons, links, or inputs
      if (e.target.closest('button, a, input, select')) return;

      // If text selection is active, ignore
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;

      // Mobile: slide up quick sheet
      if (window.innerWidth <= 768) {
        if (window.App && typeof window.App.openMobileQuickSheet === 'function') {
          window.App.openMobileQuickSheet();
        } else {
          App.toggleMasterPanel();
        }
      } else {
        // Desktop Mac/PC: unhide top bar and toggle master panel
        const topBar = document.getElementById('readerTopBar');
        if (topBar && topBar.classList.contains('minimized')) {
          topBar.classList.remove('minimized');
          this.isControlsVisible = true;
        } else {
          App.toggleMasterPanel('tabChapters');
        }
      }
    });
  },

  initOverscrollNavigation() {
    let startY = 0;
    let isTracking = false;
    let atTop = false;
    let atBottom = false;

    window.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (document.getElementById('readerView').style.display === 'none') return;

      const scrollY = window.scrollY || window.pageYOffset;
      const docHeight = document.documentElement.scrollHeight;
      const winHeight = window.innerHeight;

      atTop = scrollY <= 25;
      atBottom = (scrollY + winHeight) >= (docHeight - 65);

      if (atTop || atBottom) {
        startY = e.touches[0].clientY;
        isTracking = true;
      } else {
        isTracking = false;
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      const currentY = e.touches[0].clientY;
      const scrollY = window.scrollY || window.pageYOffset;
      const docHeight = document.documentElement.scrollHeight;
      const winHeight = window.innerHeight;

      // Allow tracking even if top/bottom reached during active continuous scroll
      if (!isTracking) {
        if ((scrollY + winHeight) >= (docHeight - 65) && currentY < startY) {
          atBottom = true;
          startY = currentY;
          isTracking = true;
        } else if (scrollY <= 25 && currentY > startY) {
          atTop = true;
          startY = currentY;
          isTracking = true;
        } else {
          return;
        }
      }

      const diffY = currentY - startY;

      // Pull down at top -> previous chapter positioned at bottom
      if (atTop && diffY > 6) {
        const topInd = document.getElementById('overscrollTopIndicator');
        const topText = document.getElementById('overscrollTopText');
        if (topInd) {
          topInd.classList.add('pulling');
          topInd.style.opacity = Math.min(1, diffY / 25);
          if (diffY > 20) {
            topInd.classList.add('armed');
            if (topText) topText.textContent = 'Release to load previous chapter';
          } else {
            topInd.classList.remove('armed');
            if (topText) topText.textContent = 'Scroll up for previous chapter';
          }
        }
      }

      // Pull up at bottom -> next chapter
      if (atBottom && diffY < -6) {
        const botInd = document.getElementById('overscrollBottomIndicator');
        const botText = document.getElementById('overscrollBottomText');
        const absDiff = Math.abs(diffY);
        if (botInd) {
          botInd.style.opacity = Math.min(1, absDiff / 25);
          if (absDiff > 20) {
            botInd.classList.add('armed');
            if (botText) botText.textContent = 'Release to load next chapter';
          } else {
            botInd.classList.remove('armed');
            if (botText) botText.textContent = 'Scroll down for next chapter';
          }
        }
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (!isTracking) return;
      isTracking = false;

      const topInd = document.getElementById('overscrollTopIndicator');
      const botInd = document.getElementById('overscrollBottomIndicator');

      if (topInd && topInd.classList.contains('armed')) {
        topInd.classList.remove('armed', 'pulling');
        topInd.style.opacity = '0';
        this.loadPrevChapter(false, true);
      } else if (topInd) {
        topInd.style.opacity = '0';
        topInd.classList.remove('armed', 'pulling');
      }

      if (botInd && botInd.classList.contains('armed')) {
        botInd.classList.remove('armed');
        botInd.style.opacity = '0';
        this.loadNextChapter();
      } else if (botInd) {
        botInd.style.opacity = '0';
        botInd.classList.remove('armed');
      }
    });

    // Wheel / trackpad scroll-to-next/prev-chapter support
    let wheelAtBottomCount = 0;
    let wheelAtTopCount = 0;
    let wheelTopDelta = 0;
    let wheelBottomDelta = 0;
    let wheelTimer = null;
    let wheelTopTimer = null;
    window.addEventListener('wheel', (e) => {
      if (document.getElementById('readerView').style.display === 'none') return;
      const scrollY = window.scrollY || window.pageYOffset;
      const docHeight = document.documentElement.scrollHeight;
      const winHeight = window.innerHeight;

      // Wheel down at bottom -> next chapter
      if (e.deltaY > 0 && (scrollY + winHeight) >= (docHeight - 25)) {
        wheelAtBottomCount++;
        wheelBottomDelta += Math.abs(e.deltaY);
        const botInd = document.getElementById('overscrollBottomIndicator');
        const botText = document.getElementById('overscrollBottomText');
        if (botInd) {
          botInd.style.opacity = '1';
          botInd.classList.add('armed');
          if (botText) botText.textContent = 'Continuing scroll loads next chapter...';
        }

        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
          if (wheelAtBottomCount >= 2 || wheelBottomDelta >= 40) {
            wheelAtBottomCount = 0;
            wheelBottomDelta = 0;
            if (botInd) {
              botInd.classList.remove('armed');
              botInd.style.opacity = '0';
            }
            this.loadNextChapter();
          } else {
            wheelAtBottomCount = 0;
            wheelBottomDelta = 0;
            if (botInd) {
              botInd.classList.remove('armed');
              botInd.style.opacity = '0';
            }
          }
        }, 220);
      }

      // Wheel up at top -> previous chapter positioned at bottom
      if (e.deltaY < 0 && scrollY <= 25) {
        wheelAtTopCount++;
        wheelTopDelta += Math.abs(e.deltaY);
        const topInd = document.getElementById('overscrollTopIndicator');
        const topText = document.getElementById('overscrollTopText');
        if (topInd) {
          topInd.style.opacity = '1';
          topInd.classList.add('armed');
          if (topText) topText.textContent = 'Continuing scroll loads previous chapter...';
        }

        clearTimeout(wheelTopTimer);
        wheelTopTimer = setTimeout(() => {
          if (wheelAtTopCount >= 2 || wheelTopDelta >= 40) {
            wheelAtTopCount = 0;
            wheelTopDelta = 0;
            if (topInd) {
              topInd.classList.remove('armed');
              topInd.style.opacity = '0';
            }
            this.loadPrevChapter(false, true);
          } else {
            wheelAtTopCount = 0;
            wheelTopDelta = 0;
            if (topInd) {
              topInd.classList.remove('armed');
              topInd.style.opacity = '0';
            }
          }
        }, 220);
      }
    }, { passive: true });
  },

  toggleControls() {
    this.isControlsVisible = !this.isControlsVisible;
    const topBar = document.getElementById('readerTopBar');
    const floatBar = document.getElementById('readerFloatingBar');
    if (topBar) topBar.classList.toggle('minimized', !this.isControlsVisible);
    if (floatBar) floatBar.classList.toggle('minimized', !this.isControlsVisible);
  },

  showControls() {
    this.isControlsVisible = true;
    const topBar = document.getElementById('readerTopBar');
    const floatBar = document.getElementById('readerFloatingBar');
    if (topBar) topBar.classList.remove('minimized');
    if (floatBar) floatBar.classList.remove('minimized');
  },

  async openNovel(novelId, resume = true) {
    App.showLoading('Opening novel...');
    try {
      const userId = SyncService.currentUserId || Storage.getUserId() || 'universal_device_mirror';
      let data = null;

      // 1. Attempt network fetch if online
      if (navigator.onLine && userId !== 'offline_user') {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const res = await fetch(`/api/novels/${encodeURIComponent(novelId)}?user_id=${encodeURIComponent(userId)}`, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            data = await res.json();
          }
        } catch (netErr) {
          console.warn('Network novel fetch failed, attempting offline cache:', netErr);
        }
      }

      // 2. Offline Fallback from IndexedDB
      if (!data || !data.novel) {
        if (typeof IDB !== 'undefined') {
          data = await IDB.getNovelData(userId, novelId);
        }
      }

      if (!data || !data.novel) {
        throw new Error('Novel not found or not cached offline on this device.');
      }

      this.currentNovel = data.novel;
      this.volumes = data.volumes || [];
      this.chapterList = data.chapters || [];

      let targetChapterId = null;
      let targetPid = 0;
      let targetPercent = 0;

      const local = Storage.getLocalProgress(novelId, userId);
      if (resume) {
        const hasCloud = !!(data.progress && data.progress.chapter_id);
        const hasLocal = !!(local && local.chapterId);

        const cloudChIdx = hasCloud ? this.chapterList.findIndex(c => c.id === data.progress.chapter_id) : -1;
        const localChIdx = hasLocal ? this.chapterList.findIndex(c => c.id === local.chapterId) : -1;

        let chooseSource = null;

        if (hasLocal && hasCloud) {
          const localTime = local.savedAt || 0;
          const cloudTime = (data.progress.updated_at || 0) * 1000;

          // If one is clearly newer (by more than 1.5s), newer position wins (forward OR backward)
          if (localTime > 0 && cloudTime > 0 && Math.abs(localTime - cloudTime) > 1500) {
            chooseSource = (localTime > cloudTime) ? 'local' : 'cloud';
          } else if (localTime > 0 && cloudTime === 0) {
            chooseSource = 'local';
          } else if (cloudTime > 0 && localTime === 0) {
            chooseSource = 'cloud';
          } else {
            // Timestamps are close or identical: check position
            if (local.chapterId === data.progress.chapter_id) {
              const localPid = local.paragraphIndex || 0;
              const cloudPid = data.progress.paragraph_index || 0;
              const localPct = local.scrollPercent || 0;
              const cloudPct = data.progress.scroll_percent || 0;
              const localScore = (localPid * 1000) + localPct;
              const cloudScore = (cloudPid * 1000) + cloudPct;
              if (localScore !== cloudScore) {
                chooseSource = (localScore > cloudScore) ? 'local' : 'cloud';
              } else {
                chooseSource = (localTime >= cloudTime) ? 'local' : 'cloud';
              }
            } else {
              // Different chapters with close timestamps: break tie with timestamp
              chooseSource = (localTime >= cloudTime) ? 'local' : 'cloud';
            }
          }
        } else if (hasLocal) {
          chooseSource = 'local';
        } else if (hasCloud) {
          chooseSource = 'cloud';
        }

        if (chooseSource === 'local') {
          targetChapterId = local.chapterId;
          targetPid = local.paragraphIndex || 0;
          targetPercent = local.scrollPercent || 0;

          // If local was newer than cloud, push it to cloud so all devices sync to it
          const localTime = local.savedAt || 0;
          const cloudTime = (data.progress ? (data.progress.updated_at || 0) : 0) * 1000;
          if (!hasCloud || localTime > cloudTime) {
            SyncService.syncReadingProgress(
              novelId,
              local.volumeId || this.currentVolumeId,
              targetChapterId,
              targetPid,
              targetPercent,
              {
                chapterTitle: local.chapterTitle || '',
                globalIndex: local.globalIndex || 1,
                overallPercent: local.overallPercent !== undefined ? local.overallPercent : 0
              }
            );
          }
        } else if (chooseSource === 'cloud') {
          targetChapterId = data.progress.chapter_id;
          targetPid = data.progress.paragraph_index || 0;
          targetPercent = data.progress.scroll_percent || 0;

          // Resolve chapter global index and title from chapterList
          const chObj = this.chapterList.find(c => c.id === targetChapterId);
          const chIdx = chObj ? (chObj.global_index ? chObj.global_index - 1 : this.chapterList.indexOf(chObj)) : 0;
          const totalCh = this.chapterList.length || 1;
          const cloudOverall = Math.min(100, Math.max(0, ((chIdx + (targetPercent / 100)) / totalCh) * 100));

          // Update local cache with latest cloud reading position
          Storage.saveLocalProgress(novelId, {
            volumeId: data.progress.volume_id,
            chapterId: targetChapterId,
            paragraphIndex: targetPid,
            scrollPercent: targetPercent,
            chapterTitle: chObj ? chObj.title : '',
            globalIndex: chObj ? (chObj.global_index || chIdx + 1) : 1,
            overallPercent: cloudOverall,
            savedAt: (data.progress.updated_at || 0) * 1000
          }, userId);
        }
      }

      if (!targetChapterId && this.chapterList.length > 0) {
        targetChapterId = this.chapterList[0].id;
      }

      if (!targetChapterId) {
        throw new Error('This novel has no chapters.');
      }

      this.targetParagraphIndex = targetPid;
      this.targetScrollPercent = targetPercent;

      // Switch to reader view FIRST so container layout and dimensions exist before scrolling
      App.switchView('reader', false);
      await this.loadChapter(targetChapterId, true);
    } catch (e) {
      App.hideLoading();
      alert('Could not open novel: ' + e.message);
    }
  },

  async loadChapter(chapterId, scrollToTarget = false, isTtsAdvance = false, scrollToBottom = false) {
    if (!isTtsAdvance && window.TTSEngine && window.TTSEngine.sleepModeExpired) {
      if (window.App && typeof window.App.cancelPendingSleepResume === 'function') {
        window.App.cancelPendingSleepResume();
      }
    }
    App.showLoading('Loading chapter...');
    try {
      const userId = SyncService.currentUserId || Storage.getUserId() || 'universal_device_mirror';
      let ch = null;

      // 1. Attempt network fetch if online with 15s timeout
      if (navigator.onLine) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const res = await fetch(`/api/chapters/${encodeURIComponent(chapterId)}`, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            ch = await res.json();
            if (ch && !ch.error && typeof IDB !== 'undefined') {
              IDB.saveCachedChapter(ch);
            }
          }
        } catch (netErr) {
          console.warn('Network chapter fetch failed, attempting offline cache:', netErr);
        }
      }

      // 2. Fallback to local IndexedDB mirror & chapter cache
      if (!ch || ch.error) {
        if (typeof IDB !== 'undefined') {
          ch = await IDB.getChapter(userId, chapterId);
        }
      }

      if (!ch || ch.error) {
        throw new Error('This chapter is not downloaded yet. Connect to the internet to cache it.');
      }

      this.currentChapter = ch;
      this.currentVolumeId = ch.volume_id;
      if (typeof IDB !== 'undefined') {
        IDB.saveCachedChapter(ch);
      }
      this.prefetchUpcomingChapters(ch);

      // Update Top Bar
      const titleEl = document.getElementById('readerChapterTitle');
      if (titleEl) {
        titleEl.innerHTML = `<strong>${ch.novel_title || ''}</strong> · ${ch.title || ''}`;
      }

      // Sanitize weird whitespace / non-breaking spaces on already-uploaded books
      let cleanContentHtml = ch.content_html || '';
      cleanContentHtml = cleanContentHtml
        .replace(/(&nbsp;|&#160;|&#xa0;|\u00a0|[\u2000-\u200b\u3000])/g, ' ')
        .replace(/\s+style=(["\'])[^"\']*\1/gi, '')
        .replace(/([^\s>])\s{2,}([^\s<])/g, '$1 $2');

      // Check if content already starts with the chapter title or heading
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = cleanContentHtml.slice(0, 800);
      const firstHeading = tempDiv.querySelector('.reader-heading, h1, h2, h3, .reader-paragraph');
      const firstText = firstHeading ? firstHeading.textContent.trim().toLowerCase() : '';
      const cleanTitle = (ch.title || '').trim().toLowerCase();

      const titleAlreadyInContent = firstText && (
        firstText === cleanTitle ||
        firstText.includes(cleanTitle) ||
        cleanTitle.includes(firstText) ||
        firstText.replace(/[^a-z0-9]/g, '') === cleanTitle.replace(/[^a-z0-9]/g, '')
      );

      const headingHtml = titleAlreadyInContent ? '' : `<h1 class="reader-heading">${ch.title}</h1>`;

      // Render Content
      const contentEl = document.getElementById('readerContent');
      contentEl.innerHTML = `
        <div class="chapter-separator-banner">
          ${ch.volume_title || ch.novel_title || ''}
        </div>
        ${headingHtml}
        ${cleanContentHtml}
      `;

      // Update Nav Buttons
      const prevBtn = document.getElementById('prevChapterBtn');
      const nextBtn = document.getElementById('nextChapterBtn');
      const footerPrevBtn = document.getElementById('footerPrevBtn');
      const footerNextBtn = document.getElementById('footerNextBtn');

      const setupBtn = (btn, target, isPrev = false) => {
        if (!btn) return;
        if (target) {
          btn.style.display = 'inline-flex';
          btn.onclick = () => this.loadChapter(target.id, false, false, isPrev);
          btn.title = target.title;
        } else {
          btn.style.display = 'none';
        }
      };

      setupBtn(prevBtn, ch.prev_chapter, true);
      setupBtn(nextBtn, ch.next_chapter, false);
      setupBtn(footerPrevBtn, ch.prev_chapter, true);
      setupBtn(footerNextBtn, ch.next_chapter, false);

      // Update mobile quick sheet title and navigation buttons
      const qsPrevBtn = document.getElementById('quickSheetPrevChBtn');
      const qsNextBtn = document.getElementById('quickSheetNextChBtn');
      const qsTitle = document.getElementById('quickSheetChapterTitle');
      if (qsTitle) {
        const volNum = ch.volume_number || 1;
        const chNum = ch.chapter_index || ch.global_index || 1;
        qsTitle.textContent = `Vol. ${volNum}, Chap. ${chNum}`;
      }
      if (qsPrevBtn) {
        const hasPrev = !!ch.prev_chapter;
        qsPrevBtn.disabled = !hasPrev;
        qsPrevBtn.style.opacity = hasPrev ? '1' : '0.4';
        qsPrevBtn.style.cursor = hasPrev ? 'pointer' : 'default';
        qsPrevBtn.title = hasPrev ? (ch.prev_chapter.title || 'Previous Chapter') : 'No Previous Chapter';
      }
      if (qsNextBtn) {
        const hasNext = !!ch.next_chapter;
        qsNextBtn.disabled = !hasNext;
        qsNextBtn.style.opacity = hasNext ? '1' : '0.4';
        qsNextBtn.style.cursor = hasNext ? 'pointer' : 'default';
        qsNextBtn.title = hasNext ? (ch.next_chapter.title || 'Next Chapter') : 'No Next Chapter';
      }

      App.hideLoading();
      this.updateProgressPill();

      TTSEngine.refreshParagraphs();
      if (typeof TTSEngine.updateAudiobookModalContent === 'function') {
        TTSEngine.updateAudiobookModalContent();
      }

      // Reliable reading spot restoration
      if (scrollToBottom) {
        this.isRestoringScroll = true;
        const performScrollBottom = () => {
          const docEl = document.documentElement;
          const bodyEl = document.body;
          const totalHeight = Math.max(docEl.scrollHeight, bodyEl ? bodyEl.scrollHeight : 0);
          const maxScroll = Math.max(0, totalHeight - window.innerHeight);

          window.scrollTo(0, maxScroll);
          if (docEl) docEl.scrollTop = maxScroll;
          if (bodyEl) bodyEl.scrollTop = maxScroll;

          const footerNav = document.getElementById('readerFooterNav');
          if (footerNav && footerNav.scrollIntoView) {
            try {
              footerNav.scrollIntoView({ block: 'end', behavior: 'instant' });
            } catch (e) {
              footerNav.scrollIntoView(false);
            }
          }
        };
        performScrollBottom();
        requestAnimationFrame(performScrollBottom);
        setTimeout(performScrollBottom, 30);
        setTimeout(performScrollBottom, 80);
        setTimeout(performScrollBottom, 180);
        setTimeout(performScrollBottom, 320);
        setTimeout(() => {
          performScrollBottom();
          this.isRestoringScroll = false;
          this.saveCurrentProgress(null, 100);
        }, 450);
      } else if (scrollToTarget && (this.targetParagraphIndex > 0 || this.targetScrollPercent > 0)) {
        this.isRestoringScroll = true;
        const targetPid = this.targetParagraphIndex;
        const targetPct = this.targetScrollPercent;

        const performScroll = () => {
          let found = false;
          if (targetPid > 0) {
            let el = document.getElementById(`p-${targetPid}`);
            if (!el) {
              el = document.querySelector(`[data-pid="${targetPid}"]`);
            }
            if (!el) {
              const allP = document.querySelectorAll('#readerContent .reader-paragraph, #readerContent .reader-heading');
              if (allP && allP[targetPid]) {
                el = allP[targetPid];
              }
            }
            if (el) {
              el.scrollIntoView({ behavior: 'auto', block: 'start' });
              found = true;
            }
          }

          if (!found && targetPct > 0) {
            const docH = document.documentElement.scrollHeight - window.innerHeight;
            if (docH > 0) {
              window.scrollTo(0, (targetPct / 100) * docH);
            }
          }

          setTimeout(() => {
            this.isRestoringScroll = false;
            this.targetParagraphIndex = 0;
            this.targetScrollPercent = 0;
          }, 350);
        };

        requestAnimationFrame(() => {
          setTimeout(performScroll, 60);
        });
      } else {
        if (!isTtsAdvance) {
          window.scrollTo(0, 0);
          this.saveCurrentProgress(0, 0);
        }
      }

      this.renderTOC();
      return this.currentChapter;
    } catch (e) {
      App.hideLoading();
      const contentEl = document.getElementById('readerContent');
      if (contentEl) {
        contentEl.innerHTML = `
          <div style="padding: 40px 20px; text-align: center; border: 1px dashed var(--border-color); border-radius: 8px; margin: 40px auto; max-width: 500px; background: var(--bg-surface);">
            <div style="margin-bottom: 14px; display: flex; justify-content: center; color: var(--accent);">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
            </div>
            <h3 style="font-family: var(--font-sans); margin-bottom: 8px; font-size: 16px;">Chapter Not Cached Offline</h3>
            <p style="font-family: var(--font-sans); font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 18px;">
              ${e.message || 'This chapter has not been downloaded to your device storage yet. Connect to the internet to cache it.'}
            </p>
            <button class="btn-brutal btn-brutal-accent" onclick="Reader.loadChapter('${chapterId}', true)">Retry Loading</button>
          </div>
        `;
      }
      App.showToast('Chapter not cached offline yet');
      return null;
    }
  },

  saveCurrentProgress(pid = null, scrollPercent = null) {
    if (!this.currentNovel || !this.currentChapter) return;
    if (this.isRestoringScroll) return;

    if (pid === null) pid = this.getVisibleParagraphIndex();
    if (scrollPercent === null) {
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      scrollPercent = docHeight > 0 ? Math.min(100, Math.max(0, (window.scrollY / docHeight) * 100)) : 0;
    }

    // Calculate whole-book overall percentage
    let overallPercent = 0;
    const totalCh = (this.chapterList && this.chapterList.length) ? this.chapterList.length : 1;
    let chIdx = 0;
    if (typeof this.currentChapter.global_index === 'number' && this.currentChapter.global_index >= 1) {
      chIdx = this.currentChapter.global_index - 1;
    } else {
      chIdx = (this.chapterList || []).findIndex(c => c.id === this.currentChapter.id);
      if (chIdx < 0) chIdx = 0;
    }
    const chapterScrollFrac = scrollPercent / 100;
    overallPercent = Math.min(100, Math.max(0, ((chIdx + chapterScrollFrac) / totalCh) * 100));

    SyncService.syncReadingProgress(
      this.currentNovel.id,
      this.currentVolumeId,
      this.currentChapter.id,
      pid,
      scrollPercent,
      {
        chapterTitle: this.currentChapter.title || '',
        globalIndex: (this.currentChapter && this.currentChapter.global_index) || (chIdx + 1),
        totalChapters: totalCh,
        overallPercent: Math.round(overallPercent * 10) / 10
      }
    );
  },

  flushPendingProgress() {
    if (this.scrollDebounce) {
      clearTimeout(this.scrollDebounce);
      this.scrollDebounce = null;
      this.saveCurrentProgress();
    }
    if (window.SyncService && typeof window.SyncService.flushPendingSync === 'function') {
      window.SyncService.flushPendingSync();
    }
  },

  async checkRemoteSync() {
    if (!navigator.onLine || !this.currentNovel || !this.currentChapter) return;
    if (window.App && window.App.currentView !== 'reader') return;
    const userId = (window.SyncService && SyncService.currentUserId) || (window.Storage && Storage.getUserId());
    if (!userId || userId === 'offline_user' || userId === 'universal_device_mirror') return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`/api/novels/${encodeURIComponent(this.currentNovel.id)}?user_id=${encodeURIComponent(userId)}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return;

      const data = await res.json();
      if (!data || !data.progress || !data.progress.chapter_id) return;

      const remote = data.progress;
      const remoteTime = (remote.updated_at || 0) * 1000;
      const local = Storage.getLocalProgress(this.currentNovel.id, userId);
      const localTime = (local && local.savedAt) || 0;

      // If remote position was updated more recently on another device (by more than 2.5 seconds)
      if (remoteTime > (localTime + 2500)) {
        if (remote.chapter_id !== this.currentChapter.id) {
          // Cancel pending debounce to prevent local scroll from overwriting remote progress
          if (this.scrollDebounce) {
            clearTimeout(this.scrollDebounce);
            this.scrollDebounce = null;
          }

          Storage.saveLocalProgress(this.currentNovel.id, {
            volumeId: remote.volume_id,
            chapterId: remote.chapter_id,
            paragraphIndex: remote.paragraph_index || 0,
            scrollPercent: remote.scroll_percent || 0,
            savedAt: remoteTime
          }, userId);

          this.targetParagraphIndex = remote.paragraph_index || 0;
          this.targetScrollPercent = remote.scroll_percent || 0;
          await this.loadChapter(remote.chapter_id, true);
          if (window.App && typeof window.App.showToast === 'function') {
            window.App.showToast('Synced reading position from another device');
          }
        }
      }
    } catch (e) {
      console.warn('checkRemoteSync notice:', e);
    }
  },

  async prefetchUpcomingChapters(ch) {
    if (!ch || !ch.next_chapter || !navigator.onLine) return;
    try {
      let cur = ch;
      for (let i = 0; i < 3; i++) {
        if (!cur || !cur.next_chapter) break;
        const nextId = cur.next_chapter.id;
        if (typeof IDB !== 'undefined') {
          const cached = await IDB.getCachedChapter(nextId);
          if (cached && cached.content_html) {
            cur = cached;
            continue;
          }
        }
        const res = await fetch(`/api/chapters/${encodeURIComponent(nextId)}`);
        if (res.ok) {
          const nextCh = await res.json();
          if (nextCh && !nextCh.error && typeof IDB !== 'undefined') {
            await IDB.saveCachedChapter(nextCh);
          }
          cur = nextCh;
        } else {
          break;
        }
      }
    } catch {}
  },

  async loadNextChapter(isTtsAdvance = false) {
    if (this.currentChapter && this.currentChapter.next_chapter) {
      return await this.loadChapter(this.currentChapter.next_chapter.id, false, isTtsAdvance);
    }
    return null;
  },

  async loadPrevChapter(isTtsAdvance = false, scrollToBottom = true) {
    if (this.currentChapter && this.currentChapter.prev_chapter) {
      return await this.loadChapter(this.currentChapter.prev_chapter.id, false, isTtsAdvance, scrollToBottom);
    }
    return null;
  },

  renderTOC() {
    const listEl = document.getElementById('tocList');
    if (!listEl) return;
    listEl.innerHTML = '';

    const volMap = {};
    this.volumes.forEach(v => {
      volMap[v.id] = { volume: v, chapters: [] };
    });

    this.chapterList.forEach(c => {
      if (volMap[c.volume_id]) {
        volMap[c.volume_id].chapters.push(c);
      } else {
        if (!volMap['misc']) volMap['misc'] = { volume: { title: 'Chapters' }, chapters: [] };
        volMap['misc'].chapters.push(c);
      }
    });

    Object.values(volMap).forEach(group => {
      const volHead = document.createElement('li');
      volHead.className = 'toc-volume-header';
      volHead.textContent = group.volume.title;
      listEl.appendChild(volHead);

      group.chapters.forEach(c => {
        const item = document.createElement('li');
        item.className = 'toc-item';
        item.setAttribute('data-id', c.id);
        if (this.currentChapter && this.currentChapter.id === c.id) {
          item.classList.add('active');
        }
        item.innerHTML = `
          <span class="toc-chapter-title">${c.title}</span>
          <span class="toc-item-words">${c.word_count || ''} words</span>
        `;
        item.onclick = () => {
          this.loadChapter(c.id, false);
          App.closeMasterPanel();
        };
        listEl.appendChild(item);
      });
    });
  },

  centerActiveChapterInTOC() {
    const listEl = document.getElementById('tocList');
    if (!listEl) return;

    // Reset search query if filtered so full TOC is visible
    const searchInput = document.getElementById('tocSearchInput');
    if (searchInput && searchInput.value) {
      searchInput.value = '';
      this.filterTOC('');
    }

    const doCenter = () => {
      let activeItem = listEl.querySelector('.toc-item.active');
      if (!activeItem && this.currentChapter) {
        activeItem = listEl.querySelector(`.toc-item[data-id="${this.currentChapter.id}"]`);
        if (activeItem) activeItem.classList.add('active');
      }

      if (activeItem) {
        try {
          activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {
          activeItem.scrollIntoView(true);
        }

        const masterBody = document.querySelector('.master-panel-body');
        if (masterBody && masterBody.scrollHeight > masterBody.clientHeight) {
          const bodyRect = masterBody.getBoundingClientRect();
          const itemRect = activeItem.getBoundingClientRect();
          const offsetDiff = itemRect.top - bodyRect.top - (masterBody.clientHeight / 2) + (activeItem.clientHeight / 2);
          masterBody.scrollTop += offsetDiff;
        }
      }
    };

    doCenter();
    requestAnimationFrame(doCenter);
    setTimeout(doCenter, 60);
    setTimeout(doCenter, 180);
    setTimeout(doCenter, 300);
  },

  filterTOC(query) {
    const q = query.toLowerCase();
    const items = document.querySelectorAll('.toc-item');
    items.forEach(it => {
      const text = it.innerText.toLowerCase();
      it.style.display = text.includes(q) ? 'flex' : 'none';
    });
  }
};

window.Reader = Reader;
