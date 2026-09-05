// Storage & Device Token Manager (iOS & Web)
const Storage = {
  DEVICE_TOKEN_KEY: 'kuroyomi_device_token',
  SYNC_KEY_KEY: 'kuroyomi_sync_key',
  USER_ID_KEY: 'kuroyomi_user_id',
  REMEMBER_KEY: 'kuroyomi_remember_device',
  DEVICE_NAME_KEY: 'kuroyomi_device_name',
  SETTINGS_KEY: 'kuroyomi_settings',
  PROGRESS_PREFIX: 'kuroyomi_prog_',

  getDeviceToken() {
    let token = localStorage.getItem(this.DEVICE_TOKEN_KEY);
    if (!token) {
      token = 'dev_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      localStorage.setItem(this.DEVICE_TOKEN_KEY, token);
    }
    return token;
  },

  getDeviceName() {
    let name = localStorage.getItem(this.DEVICE_NAME_KEY);
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
    const val = localStorage.getItem(this.REMEMBER_KEY);
    return val === null ? true : val === 'true';
  },

  setRemembered(remember) {
    localStorage.setItem(this.REMEMBER_KEY, remember ? 'true' : 'false');
  },

  getSyncKey() {
    return localStorage.getItem(this.SYNC_KEY_KEY) || '';
  },

  setSyncKey(key) {
    localStorage.setItem(this.SYNC_KEY_KEY, key);
  },

  getUserId() {
    return localStorage.getItem(this.USER_ID_KEY) || '';
  },

  setUserId(id) {
    localStorage.setItem(this.USER_ID_KEY, id);
  },

  getLocalSettings() {
    try {
      const s = localStorage.getItem(this.SETTINGS_KEY);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  },

  setLocalSettings(settings) {
    localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
  },

  saveLocalProgress(novelId, progress) {
    localStorage.setItem(this.PROGRESS_PREFIX + novelId, JSON.stringify({
      ...progress,
      savedAt: Date.now()
    }));
  },

  getLocalProgress(novelId) {
    try {
      const p = localStorage.getItem(this.PROGRESS_PREFIX + novelId);
      return p ? JSON.parse(p) : null;
    } catch {
      return null;
    }
  },

  clearSession() {
    localStorage.removeItem(this.SYNC_KEY_KEY);
    localStorage.removeItem(this.USER_ID_KEY);
  },

  // Offline Progress Queue Management
  OFFLINE_QUEUE_KEY: 'kuroyomi_offline_progress_queue',

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
      const val = localStorage.getItem(this.OFFLINE_QUEUE_KEY);
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  },

  clearOfflineProgressQueue() {
    localStorage.removeItem(this.OFFLINE_QUEUE_KEY);
  }
};

// IndexedDB Persistent Device Storage (Survives server redeploys and cloud restarts)
const IDB = {
  dbName: 'kuroyomi_cache_v1',
  storeName: 'library_mirror',

  open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        return reject(new Error('IndexedDB not supported'));
      }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'user_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async saveLibraryMirror(userId, backupData) {
    if (!backupData || !backupData.novels) return false;
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const record = {
          user_id: userId || 'universal_device_mirror',
          backup_data: backupData,
          novel_count: backupData.novels.length,
          saved_at: Date.now()
        };
        store.put(record);
        if (userId && userId !== 'universal_device_mirror') {
          store.put({
            ...record,
            user_id: 'universal_device_mirror'
          });
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('IDB save error:', e);
      return false;
    }
  },

  async getLibraryMirror(userId) {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);

        const fallbackAll = () => {
          const allReq = store.getAll();
          allReq.onsuccess = () => {
            const items = allReq.result || [];
            if (items.length > 0) {
              items.sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
              const best = items.find(it => it.novel_count > 0 && it.backup_data) || items[0];
              resolve(best ? best.backup_data : null);
            } else {
              resolve(null);
            }
          };
          allReq.onerror = () => resolve(null);
        };

        if (userId) {
          const req = store.get(userId);
          req.onsuccess = () => {
            if (req.result && req.result.backup_data) {
              resolve(req.result.backup_data);
            } else {
              fallbackAll();
            }
          };
          req.onerror = () => fallbackAll();
        } else {
          fallbackAll();
        }
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

  async getChapter(userId, chapterId) {
    try {
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
