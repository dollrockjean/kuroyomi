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
