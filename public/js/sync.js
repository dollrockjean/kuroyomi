async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Cloud Sync & Device Management Service
const SyncService = {
  currentUserId: null,
  currentSyncKey: null,
  syncTimeout: null,
  isOnline: true,
  cloudServerUrl: 'https://kuroyomi-webnovel-reader.onrender.com',

  async init() {
    // Register online/offline status listeners once
    if (!this._listenersBound) {
      this._listenersBound = true;
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.updateStatus('synced', 'ONLINE');
        this.flushOfflineQueue();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
        this.updateStatus('offline', 'OFFLINE');
      });
    }

    // 0. If browser is offline, exit IMMEDIATELY with local credentials (0ms delay)
    if (!navigator.onLine) {
      this.isOnline = false;
      this.updateStatus('offline', 'OFFLINE');
      this.currentUserId = Storage.getUserId() || 'universal_device_mirror';
      this.currentSyncKey = Storage.getSyncKey() || 'READER-PRIMARY';
      return {
        userId: this.currentUserId,
        syncKey: this.currentSyncKey,
        settings: Storage.getLocalSettings() || {}
      };
    }

    this.updateStatus('syncing', 'CONNECTING...');

    // 1. Detect 1-Click Pairing Link (?pair=READER-XXXXX)
    let pairKeyDetected = null;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const pairParam = urlParams.get('pair') || urlParams.get('key');
      if (pairParam) {
        pairKeyDetected = pairParam.trim().toUpperCase();
        Storage.setSyncKey(pairKeyDetected);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (e) {}

    const deviceToken = Storage.getDeviceToken();
    const isRemembered = Storage.isRemembered();

    try {
      // 2. If explicit pairing link was opened, pair immediately with it!
      if (pairKeyDetected) {
        console.log('Pairing device via 1-Click link:', pairKeyDetected);
        const pairData = await this.pairDeviceWithKey(pairKeyDetected, isRemembered);
        return { userId: pairData.user_id, syncKey: pairData.sync_key, settings: pairData.settings };
      }

      // 3. Try to restore session via device token ("Remember This Device")
      if (isRemembered && deviceToken) {
        try {
          const res = await fetchWithTimeout(`/api/auth/device-session?device_token=${encodeURIComponent(deviceToken)}`, {}, 12000);
          if (res.ok) {
            const data = await res.json();
            if (data.authenticated) {
              this.currentUserId = data.user_id;
              this.currentSyncKey = data.sync_key;
              Storage.setUserId(data.user_id);
              Storage.setSyncKey(data.sync_key);
              this.updateStatus('synced', 'SYNCED');
              return { userId: data.user_id, syncKey: data.sync_key, settings: data.settings };
            }
          }
        } catch (netErr) {
          console.warn('Device session restore network timeout, proceeding to register/offline:', netErr);
        }
      }

      // 4. Connect with existing local sync key or link to primary shared library
      let syncKey = Storage.getSyncKey();
      if (!syncKey || syncKey === 'OFFLINE') {
        syncKey = 'READER-PRIMARY';
      }
      const deviceName = Storage.getDeviceName();
      const existingUserId = Storage.getUserId();

      const regRes = await fetchWithTimeout('/api/auth/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sync_key: syncKey,
          user_id: existingUserId,
          device_token: deviceToken,
          device_name: deviceName,
          remember: isRemembered
        })
      }, 15000);

      if (regRes.ok) {
        const regData = await regRes.json();
        if (regData.success) {
          this.currentUserId = regData.user_id;
          this.currentSyncKey = regData.sync_key;
          Storage.setUserId(regData.user_id);
          Storage.setSyncKey(regData.sync_key);
          this.updateStatus('synced', 'SYNCED');
          return { userId: regData.user_id, syncKey: regData.sync_key, settings: regData.settings };
        }
      }

      throw new Error('Registration failed or offline');
    } catch (e) {
      console.warn('Sync connection error, operating in offline fallback:', e);
      this.isOnline = false;
      this.updateStatus('offline', 'OFFLINE');
      this.currentUserId = Storage.getUserId() || 'universal_device_mirror';
      this.currentSyncKey = Storage.getSyncKey() || 'READER-PRIMARY';
      return { userId: this.currentUserId, syncKey: this.currentSyncKey, settings: Storage.getLocalSettings() || {} };
    }
  },

  updateStatus(state, text) {
    const badge = document.getElementById('syncStatusBadge');
    const dot = document.getElementById('syncDot');
    const label = document.getElementById('syncStatusText');
    if (!badge || !dot || !label) return;

    dot.className = 'sync-dot';
    if (state === 'syncing') {
      dot.classList.add('syncing');
      label.textContent = text || 'SYNCING...';
    } else if (state === 'synced') {
      label.textContent = text || 'SYNCED';
    } else {
      dot.style.background = '#ef4444';
      label.textContent = text || 'OFFLINE';
    }
  },

  async pairDeviceWithKey(syncKey, remember = true) {
    this.updateStatus('syncing', 'PAIRING...');
    const deviceToken = Storage.getDeviceToken();
    const deviceName = Storage.getDeviceName();

    try {
      const res = await fetch('/api/auth/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sync_key: syncKey.trim().toUpperCase(),
          device_token: deviceToken,
          device_name: deviceName,
          remember: remember
        })
      });

      const data = await res.json();
      if (data.success) {
        this.currentUserId = data.user_id;
        this.currentSyncKey = data.sync_key;
        Storage.setUserId(data.user_id);
        Storage.setSyncKey(data.sync_key);
        Storage.setRemembered(remember);
        this.updateStatus('synced', 'SYNCED');
        return data;
      } else {
        throw new Error(data.error || 'Pairing failed');
      }
    } catch (e) {
      this.updateStatus('offline', 'PAIR FAILED');
      throw e;
    }
  },

  async getPairedDevices() {
    if (!this.currentUserId) return [];
    try {
      const res = await fetch(`/api/devices?user_id=${encodeURIComponent(this.currentUserId)}`);
      const data = await res.json();
      return data.devices || [];
    } catch {
      return [];
    }
  },

  async unlinkDevice(deviceToken) {
    try {
      await fetch('/api/devices/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.currentUserId,
          device_token: deviceToken
        })
      });
      return true;
    } catch {
      return false;
    }
  },

  syncReadingProgress(novelId, volumeId, chapterId, paragraphIndex, scrollPercent) {
    if (!novelId || !chapterId) return;

    // 1. Immediately cache locally
    Storage.saveLocalProgress(novelId, {
      volumeId,
      chapterId,
      paragraphIndex,
      scrollPercent
    });

    const progressRecord = {
      user_id: this.currentUserId,
      novel_id: novelId,
      volume_id: volumeId,
      chapter_id: chapterId,
      paragraph_index: paragraphIndex,
      scroll_percent: scrollPercent
    };

    // 2. If offline, queue for later sync
    if (!navigator.onLine) {
      Storage.queueOfflineProgress(progressRecord);
      this.updateStatus('offline', 'LOCAL ONLY');
      return;
    }

    // 3. Debounce cloud sync
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.updateStatus('syncing', 'SAVING...');

    this.syncTimeout = setTimeout(async () => {
      if (!this.currentUserId) return;
      try {
        const res = await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(progressRecord)
        });
        const data = await res.json();
        if (data.success) {
          this.updateStatus('synced', 'SAVED');
        }
      } catch (e) {
        console.warn('Progress cloud sync error, queuing offline:', e);
        Storage.queueOfflineProgress(progressRecord);
        this.updateStatus('offline', 'LOCAL ONLY');
      }
    }, 1500);
  },

  async flushOfflineQueue() {
    const queue = Storage.getOfflineProgressQueue();
    if (!queue || queue.length === 0) return;

    let syncedCount = 0;
    for (const record of queue) {
      try {
        const res = await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...record,
            user_id: this.currentUserId || record.user_id
          })
        });
        const data = await res.json();
        if (data.success) {
          syncedCount++;
        }
      } catch (e) {
        console.warn('Error syncing queued offline progress:', e);
      }
    }

    if (syncedCount > 0) {
      Storage.clearOfflineProgressQueue();
      this.updateStatus('synced', 'SYNCED');
      if (window.App && typeof window.App.showToast === 'function') {
        window.App.showToast(`Online: Synced ${syncedCount} reading position(s)`);
      }
    }
  },

  async syncSettings(settings) {
    Storage.setLocalSettings(settings);
    if (!this.currentUserId) return;

    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: this.currentUserId,
          ...settings
        })
      });
    } catch (e) {
      console.warn('Settings cloud sync error:', e);
    }
  },

  async pushLibraryToCloud(targetRemoteUrl = null) {
    const cloudUrl = (targetRemoteUrl || this.cloudServerUrl).replace(/\/+$/, '');
    const userId = this.currentUserId || Storage.getUserId() || 'universal_device_mirror';

    // 1. Fetch current full local backup from local server or IDB mirror
    let backupData = null;
    try {
      const res = await fetch(`/api/backup?user_id=${encodeURIComponent(userId)}`);
      if (res.ok) {
        backupData = await res.json();
      }
    } catch (e) {
      console.warn('Could not fetch from local /api/backup, checking IDB mirror:', e);
    }

    if ((!backupData || !backupData.novels || backupData.novels.length === 0) && typeof IDB !== 'undefined') {
      backupData = await IDB.getLibraryMirror(userId);
    }

    if (!backupData || !backupData.novels || backupData.novels.length === 0) {
      throw new Error('No local novels found to push to cloud.');
    }

    // 2. Transmit to remote Cloud Server (/api/restore)
    const restoreRes = await fetch(`${cloudUrl}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        backup_data: backupData
      })
    });

    if (!restoreRes.ok) {
      const errText = await restoreRes.text();
      throw new Error(`Cloud server responded with status ${restoreRes.status}: ${errText}`);
    }

    const resJson = await restoreRes.json();
    return {
      success: true,
      novelsCount: backupData.novels.length,
      serverResult: resJson
    };
  }
};

window.SyncService = SyncService;
