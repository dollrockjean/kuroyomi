// Storage & Device Token Manager (iOS & Web)
const Storage = {
  DEVICE_TOKEN_KEY: 'byob_device_token',
  CLIENT_ID_KEY: 'byob_client_id',
  LEGACY_DEVICE_TOKEN_KEY: 'kuroyomi_device_token',
  SYNC_KEY_KEY: 'byob_sync_key',
  LEGACY_SYNC_KEY_KEY: 'kuroyomi_sync_key',
  USER_ID_KEY: 'byob_user_id',
  LEGACY_USER_ID_KEY: 'kuroyomi_user_id',
  REMEMBER_KEY: 'byob_remember_device',
  LEGACY_REMEMBER_KEY: 'kuroyomi_remember_device',
  DEVICE_NAME_KEY: 'byob_device_name',
  LEGACY_DEVICE_NAME_KEY: 'kuroyomi_device_name',
  SETTINGS_KEY: 'byob_settings',
  LEGACY_SETTINGS_KEY: 'kuroyomi_settings',
  PROGRESS_PREFIX: 'byob_prog_',
  LEGACY_PROGRESS_PREFIX: 'kuroyomi_prog_',
  COVER_PREFIX: 'byob_cover_',
  LEGACY_COVER_PREFIX: 'kuroyomi_cover_',

  // Random id from the browser's cryptographic generator (Math.random is predictable, and this token is a login)
  randomId(prefix, bytes = 16) {
    const buf = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(buf);
    } else {
      for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    return prefix + Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  },

  getDeviceToken() {
    let token = localStorage.getItem(this.DEVICE_TOKEN_KEY) || localStorage.getItem(this.LEGACY_DEVICE_TOKEN_KEY);
    if (!token) {
      token = this.randomId('dev_');
      localStorage.setItem(this.DEVICE_TOKEN_KEY, token);
    }
    return token;
  },

  // Stable per-install id sent with reading progress so the server can tell which saves came from this device.
  // Separate from the device token, which is a login credential and must not travel with every save.
  getClientId() {
    try {
      let id = localStorage.getItem(this.CLIENT_ID_KEY);
      if (!id) {
        id = this.randomId('cli_', 10);
        localStorage.setItem(this.CLIENT_ID_KEY, id);
      }
      return id;
    } catch (e) {
      // Storage unavailable: a per-page id still orders this page's own saves
      if (!this._memClientId) this._memClientId = 'cli_' + Math.random().toString(36).substring(2, 12);
      return this._memClientId;
    }
  },

  getDeviceName() {
    let name = localStorage.getItem(this.DEVICE_NAME_KEY) || localStorage.getItem(this.LEGACY_DEVICE_NAME_KEY);
    if (!name) {
      const ua = navigator.userAgent;
      if (/iPhone/.test(ua)) name = 'iPhone';
      else if (/iPad/.test(ua)) name = 'iPad';
      else if (/Macintosh/.test(ua)) name = 'Mac';
      else if (/Android/.test(ua)) name = 'Android Device';
      else if (/Windows/.test(ua)) name = 'Windows PC';
      else name = 'Web Client';
      localStorage.setItem(this.DEVICE_NAME_KEY, name);
    }
    return name;
  },

  setDeviceName(name) {
    localStorage.setItem(this.DEVICE_NAME_KEY, name);
  },

  isRemembered() {
    let val = localStorage.getItem(this.REMEMBER_KEY);
    if (val === null) val = localStorage.getItem(this.LEGACY_REMEMBER_KEY);
    return val === null ? true : val === 'true';
  },

  setRemembered(remember) {
    localStorage.setItem(this.REMEMBER_KEY, remember ? 'true' : 'false');
  },

  getSyncKey() {
    return localStorage.getItem(this.SYNC_KEY_KEY) || localStorage.getItem(this.LEGACY_SYNC_KEY_KEY) || '';
  },

  setSyncKey(key) {
    localStorage.setItem(this.SYNC_KEY_KEY, key);
  },

  getUserId() {
    return localStorage.getItem(this.USER_ID_KEY) || localStorage.getItem(this.LEGACY_USER_ID_KEY) || '';
  },

  setUserId(id) {
    localStorage.setItem(this.USER_ID_KEY, id);
  },

  getLocalSettings() {
    try {
      const s = localStorage.getItem(this.SETTINGS_KEY) || localStorage.getItem(this.LEGACY_SETTINGS_KEY);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  },

  setLocalSettings(settings) {
    this._safeSetItem(this.SETTINGS_KEY, JSON.stringify(settings));
  },

  // localStorage is small (about 5MB) and cached covers fill it. A full or blocked store must never throw into the
  // caller: a thrown error here used to abort the reading-progress save before it reached the cloud.
  _safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (!this._freeLocalSpace()) return false;
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e2) {
        return false;
      }
    }
  },

  // Cached covers (re-downloadable from the server) are the only bulky data kept in localStorage; drop them to make room
  _freeLocalSpace() {
    let freed = false;
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(this.COVER_PREFIX) || k.startsWith(this.LEGACY_COVER_PREFIX))) doomed.push(k);
      }
      doomed.forEach(k => { localStorage.removeItem(k); freed = true; });
    } catch (e) {}
    return freed;
  },

  saveSettings(settings) {
    this.setLocalSettings(settings);
  },

  setNovelCover(novelId, coverData) {
    if (!novelId) return;
    try {
      if (coverData) {
        localStorage.setItem(this.COVER_PREFIX + novelId, coverData);
        localStorage.setItem(this.LEGACY_COVER_PREFIX + novelId, coverData);
      } else {
        localStorage.removeItem(this.COVER_PREFIX + novelId);
        localStorage.removeItem(this.LEGACY_COVER_PREFIX + novelId);
      }
    } catch (e) {
      console.warn('Storage.setNovelCover quota or access error:', e);
    }
  },

  getNovelCover(novelId) {
    if (!novelId) return null;
    return localStorage.getItem(this.COVER_PREFIX + novelId) ||
           localStorage.getItem(this.LEGACY_COVER_PREFIX + novelId) ||
           null;
  },

  saveLocalProgress(novelId, progress, userId = null) {
    const uid = userId || this.getUserId() || 'guest';
    const payload = JSON.stringify({
      ...progress,
      savedAt: (progress && typeof progress.savedAt === 'number' && progress.savedAt > 0) ? progress.savedAt : Date.now()
    });
    // Scoped key first: it is the one reopening a book reads. The rest are compatibility copies.
    const saved = this._safeSetItem(`${this.PROGRESS_PREFIX}${uid}_${novelId}`, payload);
    this._safeSetItem(this.PROGRESS_PREFIX + novelId, payload);
    // Also save legacy key for backward compatibility
    this._safeSetItem(`${this.LEGACY_PROGRESS_PREFIX}${uid}_${novelId}`, payload);
    this._safeSetItem(this.LEGACY_PROGRESS_PREFIX + novelId, payload);
    return saved;
  },

  getLocalProgress(novelId, userId = null) {
    try {
      const uid = userId || this.getUserId();
      if (uid) {
        const pScoped = localStorage.getItem(`${this.PROGRESS_PREFIX}${uid}_${novelId}`) ||
                        localStorage.getItem(`${this.LEGACY_PROGRESS_PREFIX}${uid}_${novelId}`);
        if (pScoped) return JSON.parse(pScoped);
      }
      const pLegacy = localStorage.getItem(this.PROGRESS_PREFIX + novelId) ||
                      localStorage.getItem(this.LEGACY_PROGRESS_PREFIX + novelId);
      return pLegacy ? JSON.parse(pLegacy) : null;
    } catch {
      return null;
    }
  },

  clearLocalProgress() {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(this.PROGRESS_PREFIX) || k.startsWith(this.LEGACY_PROGRESS_PREFIX))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn('Could not clear local progress:', e);
    }
  },

  clearSession() {
    localStorage.removeItem(this.SYNC_KEY_KEY);
    localStorage.removeItem(this.LEGACY_SYNC_KEY_KEY);
    localStorage.removeItem(this.USER_ID_KEY);
    localStorage.removeItem(this.LEGACY_USER_ID_KEY);
    this.clearLocalProgress();
  },

  // Offline Progress Queue Management
  OFFLINE_QUEUE_KEY: 'byob_offline_progress_queue',
  LEGACY_OFFLINE_QUEUE_KEY: 'kuroyomi_offline_progress_queue',

  queueOfflineProgress(record) {
    try {
      const q = this.getOfflineProgressQueue();
      const existingIdx = q.findIndex(item => item.novel_id === record.novel_id);
      if (existingIdx >= 0) {
        q[existingIdx] = { ...record, queued_at: Date.now() };
      } else {
        q.push({ ...record, queued_at: Date.now() });
      }
      localStorage.setItem(this.OFFLINE_QUEUE_KEY, JSON.stringify(q));
    } catch (e) {
      console.warn('Queue offline progress error:', e);
    }
  },

  getOfflineProgressQueue() {
    try {
      const val = localStorage.getItem(this.OFFLINE_QUEUE_KEY) || localStorage.getItem(this.LEGACY_OFFLINE_QUEUE_KEY);
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  },

  setOfflineProgressQueue(queue) {
    try {
      localStorage.setItem(this.OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      console.warn('Could not store offline progress queue:', e);
    }
  },

  clearOfflineProgressQueue() {
    localStorage.removeItem(this.OFFLINE_QUEUE_KEY);
    localStorage.removeItem(this.LEGACY_OFFLINE_QUEUE_KEY);
  }
};

// IndexedDB Persistent Device Storage (Survives server redeploys and cloud restarts)
const IDB = {
  dbName: 'byob_cache_v2',
  legacyDbName: 'kuroyomi_cache_v2',
  storeName: 'library_mirror',
  chapterStore: 'chapter_cache',

  open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        return reject(new Error('IndexedDB not supported'));
      }
      const request = indexedDB.open(this.dbName, 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'user_id' });
        }
        if (!db.objectStoreNames.contains(this.chapterStore)) {
          db.createObjectStore(this.chapterStore, { keyPath: 'id' });
        }
      };
    });
  },

  async saveLibraryMirror(userId, backupData) {
    if (!userId || !backupData || !backupData.novels) return false;
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const record = {
          user_id: userId,
          backup_data: backupData,
          novel_count: (backupData.novels && backupData.novels.length) || 0,
          saved_at: Date.now()
        };
        store.put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('IDB save error:', e);
      return false;
    }
  },

  async updateCoverInMirror(userId, novelId, coverData) {
    if (!userId || !novelId) return false;
    try {
      const mirror = await this.getLibraryMirror(userId);
      if (mirror && mirror.novels && mirror.novels.length > 0) {
        const novel = mirror.novels.find(n => n.id === novelId);
        if (novel) {
          novel.cover_data = coverData;
          await this.saveLibraryMirror(userId, mirror);
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn('IDB updateCoverInMirror error:', e);
      return false;
    }
  },

  async clearLibraryMirror() {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  getLegacyMirror(userId) {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = indexedDB.open(this.legacyDbName);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.close();
            return resolve(null);
          }
          const tx = db.transaction(this.storeName, 'readonly');
          const store = tx.objectStore(this.storeName);
          const getReq = store.get(userId);
          getReq.onsuccess = () => {
            const res = getReq.result && getReq.result.backup_data ? getReq.result.backup_data : null;
            db.close();
            resolve(res);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      } catch {
        resolve(null);
      }
    });
  },

  async getLibraryMirror(userId) {
    if (!userId) return null;
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(userId);
        req.onsuccess = async () => {
          if (req.result && req.result.backup_data) {
            resolve(req.result.backup_data);
          } else {
            try {
              const legacyData = await this.getLegacyMirror(userId);
              if (legacyData) {
                await this.saveLibraryMirror(userId, legacyData);
                resolve(legacyData);
                return;
              }
            } catch (e) {}
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      console.warn('IDB get error:', e);
      return null;
    }
  },

  async removeNovelFromMirror(userId, novelId) {
    if (!userId || !novelId) return false;
    try {
      const currentBackup = await this.getLibraryMirror(userId);
      if (!currentBackup || !currentBackup.novels) return true;

      currentBackup.novels = currentBackup.novels.filter(n => n.id !== novelId);
      if (currentBackup.volumes) {
        currentBackup.volumes = currentBackup.volumes.filter(v => v.novel_id !== novelId);
      }
      if (currentBackup.chapters) {
        currentBackup.chapters = currentBackup.chapters.filter(c => c.novel_id !== novelId);
      }
      if (currentBackup.progress) {
        currentBackup.progress = currentBackup.progress.filter(p => p.novel_id !== novelId);
      }

      await this.saveLibraryMirror(userId, currentBackup);
      return true;
    } catch (e) {
      console.warn('IDB remove error:', e);
      return false;
    }
  },

  async getMirroredCount(userId) {
    if (!userId) return 0;
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(userId);
        req.onsuccess = () => {
          resolve(req.result ? (req.result.novel_count || 0) : 0);
        };
        req.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  },

  async getNovelData(userId, novelId) {
    try {
      const mirror = await this.getLibraryMirror(userId);
      if (!mirror || !mirror.novels) return null;

      const novel = mirror.novels.find(n => n.id === novelId);
      if (!novel) return null;

      const volumes = (mirror.volumes || [])
        .filter(v => v.novel_id === novelId)
        .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));

      const chapters = (mirror.chapters || [])
        .filter(c => c.novel_id === novelId)
        .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));

      const progress = (mirror.progress || []).find(p => p.novel_id === novelId) || null;

      return {
        novel,
        volumes,
        chapters,
        progress
      };
    } catch (e) {
      console.warn('IDB getNovelData error:', e);
      return null;
    }
  },

  async saveCachedChapter(chapter) {
    if (!chapter || !chapter.id) return false;
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.chapterStore, 'readwrite');
        const store = tx.objectStore(this.chapterStore);
        store.put({
          id: chapter.id,
          novel_id: chapter.novel_id,
          volume_id: chapter.volume_id,
          title: chapter.title,
          content_html: chapter.content_html,
          word_count: chapter.word_count,
          order_index: chapter.order_index,
          global_index: chapter.global_index,
          novel_title: chapter.novel_title,
          volume_title: chapter.volume_title,
          prev_chapter: chapter.prev_chapter,
          next_chapter: chapter.next_chapter,
          saved_at: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  async getCachedChapter(chapterId) {
    if (!chapterId) return null;
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.chapterStore, 'readonly');
        const store = tx.objectStore(this.chapterStore);
        const req = store.get(chapterId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  async getChapter(userId, chapterId) {
    try {
      // 1. Check dedicated instant chapter cache first
      const cached = await this.getCachedChapter(chapterId);
      if (cached && cached.content_html) {
        return cached;
      }

      const mirror = await this.getLibraryMirror(userId);
      if (!mirror || !mirror.chapters) return null;

      const ch = mirror.chapters.find(c => c.id === chapterId);
      if (!ch) return null;

      // Find novel and volume titles
      const novel = (mirror.novels || []).find(n => n.id === ch.novel_id);
      const volume = (mirror.volumes || []).find(v => v.id === ch.volume_id);

      // Find prev and next chapters
      const novelChapters = mirror.chapters
        .filter(c => c.novel_id === ch.novel_id)
        .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));

      const idx = novelChapters.findIndex(c => c.id === chapterId);
      const prev = idx > 0 ? novelChapters[idx - 1] : null;
      const next = idx < novelChapters.length - 1 ? novelChapters[idx + 1] : null;

      return {
        ...ch,
        novel_title: novel ? novel.title : '',
        volume_title: volume ? volume.title : '',
        prev_chapter: prev ? { id: prev.id, title: prev.title } : null,
        next_chapter: next ? { id: next.id, title: next.title } : null
      };
    } catch (e) {
      console.warn('IDB getChapter error:', e);
      return null;
    }
  }
};

window.Storage = Storage;
window.IDB = IDB;

// Same-origin API calls carry this device's token, so the server can tell the account's own devices apart from anyone
// who merely knows its user id. The token is never attached to requests for other origins (e.g. the cloud push).
(function installDeviceTokenHeader() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.__deviceTokenFetchInstalled) return;
  window.__deviceTokenFetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = new URL(typeof input === 'string' ? input : (input && input.url) || '', window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
        if (!headers.has('X-Device-Token')) headers.set('X-Device-Token', Storage.getDeviceToken());
        init = Object.assign({}, init, { headers });
      }
    } catch (e) {
      // Storage blocked or odd input: send the request exactly as the caller asked
    }
    return nativeFetch(input, init);
  };
})();
