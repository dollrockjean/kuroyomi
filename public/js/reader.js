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
    this.bindScroll();
    this.bindCenterScreenTap();
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

      // Progress calculation
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const percent = docHeight > 0 ? Math.min(100, Math.max(0, (currentScrollY / docHeight) * 100)) : 0;
      
      const pill = document.getElementById('readerProgressPill');
      if (pill) pill.textContent = `${Math.round(percent)}%`;

      // Silently and continuously detect the current reading paragraph
      const currentPid = this.getVisibleParagraphIndex();

      // Silently debounce saving progress to cloud without toasts
      if (this.scrollDebounce) clearTimeout(this.scrollDebounce);
      this.scrollDebounce = setTimeout(() => {
        this.saveCurrentProgress(currentPid, percent);
      }, 1000);
    }, { passive: true });
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
    // Tapping the reading text or screen center opens/toggles the master panel (TOUCH devices only)
    const wrapper = document.getElementById('readerBodyWrapper');
    if (!wrapper) return;

    wrapper.addEventListener('pointerup', (e) => {
      // On PC with a mouse / trackpad click: do NOTHING
      if (e.pointerType === 'mouse') return;

      // Don't trigger on buttons, links, or inputs
      if (e.target.closest('button, a, input, select')) return;

      // If text selection is active, ignore
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;

      // Toggle the master panel on touch screens
      App.toggleMasterPanel();
    });
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
      const userId = SyncService.currentUserId;
      const res = await fetch(`/api/novels/${encodeURIComponent(novelId)}?user_id=${encodeURIComponent(userId)}`);
      const data = await res.json();
      if (!data.novel) throw new Error('Novel not found');

      this.currentNovel = data.novel;
      this.volumes = data.volumes || [];
      this.chapterList = data.chapters || [];

      let targetChapterId = null;
      let targetPid = 0;
      let targetPercent = 0;

      if (resume && data.progress) {
        targetChapterId = data.progress.chapter_id;
        targetPid = data.progress.paragraph_index || 0;
        targetPercent = data.progress.scroll_percent || 0;
      }

      if (resume && !targetChapterId) {
        const local = Storage.getLocalProgress(novelId);
        if (local) {
          targetChapterId = local.chapterId;
          targetPid = local.paragraphIndex || 0;
          targetPercent = local.scrollPercent || 0;
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

      await this.loadChapter(targetChapterId, true);
      App.switchView('reader');
    } catch (e) {
      App.hideLoading();
      alert('Could not open novel: ' + e.message);
    }
  },

  async loadChapter(chapterId, scrollToTarget = false) {
    App.showLoading('Loading chapter...');
    try {
      const res = await fetch(`/api/chapters/${encodeURIComponent(chapterId)}`);
      const ch = await res.json();
      if (ch.error) throw new Error(ch.error);

      this.currentChapter = ch;
      this.currentVolumeId = ch.volume_id;

      // Update Top Bar
      const titleEl = document.getElementById('readerChapterTitle');
      if (titleEl) {
        titleEl.innerHTML = `<strong>${ch.novel_title}</strong> · ${ch.title}`;
      }

      // Check if content already starts with the chapter title or heading
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = (ch.content_html || '').slice(0, 800);
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
          ${ch.volume_title || ch.novel_title}
        </div>
        ${headingHtml}
        ${ch.content_html}
      `;

      // Update Nav Buttons
      const prevBtn = document.getElementById('prevChapterBtn');
      const nextBtn = document.getElementById('nextChapterBtn');
      const footerPrevBtn = document.getElementById('footerPrevBtn');
      const footerNextBtn = document.getElementById('footerNextBtn');

      const setupBtn = (btn, target) => {
        if (!btn) return;
        if (target) {
          btn.style.display = 'inline-flex';
          btn.onclick = () => this.loadChapter(target.id, false);
          btn.title = target.title;
        } else {
          btn.style.display = 'none';
        }
      };

      setupBtn(prevBtn, ch.prev_chapter);
      setupBtn(nextBtn, ch.next_chapter);
      setupBtn(footerPrevBtn, ch.prev_chapter);
      setupBtn(footerNextBtn, ch.next_chapter);

      App.hideLoading();

      TTSEngine.refreshParagraphs();
      if (typeof TTSEngine.updateAudiobookModalContent === 'function') {
        TTSEngine.updateAudiobookModalContent();
      }

      // Silent scroll position restoration
      if (scrollToTarget && this.targetParagraphIndex > 0) {
        setTimeout(() => {
          const targetP = document.getElementById(`p-${this.targetParagraphIndex}`);
          if (targetP) {
            targetP.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (this.targetScrollPercent > 0) {
            const docH = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, (this.targetScrollPercent / 100) * docH);
          }
          this.targetParagraphIndex = 0;
          this.targetScrollPercent = 0;
        }, 150);
      } else {
        window.scrollTo(0, 0);
      }

      this.saveCurrentProgress(0, 0);
      this.renderTOC();
    } catch (e) {
      App.hideLoading();
      alert('Error loading chapter: ' + e.message);
    }
  },

  saveCurrentProgress(pid = null, scrollPercent = 0) {
    if (!this.currentNovel || !this.currentChapter) return;
    if (pid === null) pid = this.getVisibleParagraphIndex();

    SyncService.syncReadingProgress(
      this.currentNovel.id,
      this.currentVolumeId,
      this.currentChapter.id,
      pid,
      scrollPercent
    );
  },

  loadNextChapter() {
    if (this.currentChapter && this.currentChapter.next_chapter) {
      this.loadChapter(this.currentChapter.next_chapter.id, false);
    }
  },

  loadPrevChapter() {
    if (this.currentChapter && this.currentChapter.prev_chapter) {
      this.loadChapter(this.currentChapter.prev_chapter.id, false);
    }
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
          <span>${c.title}</span>
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
        const itemTop = activeItem.offsetTop;
        const itemHeight = activeItem.offsetHeight;
        const listHeight = listEl.clientHeight;
        if (listHeight > 0) {
          listEl.scrollTop = Math.max(0, itemTop - (listHeight / 2) + (itemHeight / 2));
        } else {
          activeItem.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
      }
    };

    doCenter();
    requestAnimationFrame(doCenter);
    setTimeout(doCenter, 100);
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
