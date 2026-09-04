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
  }
};
