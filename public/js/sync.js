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

    // If loaded from a local private IP (e.g. 10.0.0.149 when Mac is closed in car)
    const host = window.location.hostname;
    const isPrivateLocal = host.endsWith('.local') ||
                           /^10\.\d+\.\d+\.\d+$/.test(host) ||
                           /^192\.168\.\d+\.\d+$/.test(host) ||
                           /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);

    if (isPrivateLocal) {
      try {
        const healthRes = await fetchWithTimeout('/api/health', { cache: 'no-store' }, 1500);
        if (!healthRes.ok) throw new Error('Local server offline');
      } catch (localErr) {
        if (navigator.onLine) {
          console.warn('Local Mac server unreachable while online. Auto-redirecting to cloud:', localErr);
          const params = new URLSearchParams(window.location.search);
          const key = Storage.getSyncKey();
          const uid = Storage.getUserId();
          if (key && key !== 'OFFLINE' && key !== 'READER-PRIMARY') params.set('pair', key);
          if (uid && uid !== 'universal_device_mirror') params.set('uid', uid);
          const qs = params.toString() ? '?' + params.toString() : '';
          window.location.replace(this.cloudServerUrl + window.location.pathname + qs + window.location.hash);
          return { userId: uid, syncKey: key, settings: {} };
        }
      }
    }

    // 1. Detect 1-Click Pairing Link (?pair=READER-XXXXX or ?uid=usr_XXXX)
    let pairKeyDetected = null;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const pairParam = urlParams.get('pair') || urlParams.get('key');
      const uidParam = urlParams.get('uid');
      if (pairParam) {
        pairKeyDetected = pairParam.trim().toUpperCase();
        Storage.setSyncKey(pairKeyDetected);
      }
      if (uidParam && uidParam.startsWith('usr_')) {
        Storage.setUserId(uidParam.trim());
      }
    } catch (e) {}

    const deviceToken = Storage.getDeviceToken();
    const isRemembered = Storage.isRemembered();

    try {
      // 2. If explicit pairing link was opened, pair immediately with it!
      if (pairKeyDetected) {
        console.log('Pairing device via 1-Click link:', pairKeyDetected);
        const pairData = await this.pairDeviceWithKey(pairKeyDetected, isRemembered);
        try {
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) {}
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

      // 4. Connect with existing local sync key (or empty to generate isolated visitor profile)
      let syncKey = Storage.getSyncKey();
      if (!syncKey || syncKey === 'OFFLINE' || syncKey === 'DEFAULT_READER') {
        syncKey = '';
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
      this.currentUserId = Storage.getUserId() || 'offline_user';
      this.currentSyncKey = Storage.getSyncKey() || 'OFFLINE';
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
      // Clear any temporary pre-pairing visitor data from local storage
      if (typeof Storage !== 'undefined' && Storage.clearLocalProgress) {
        Storage.clearLocalProgress();
      }
      if (typeof IDB !== 'undefined' && IDB.clearLibraryMirror) {
        await IDB.clearLibraryMirror();
      }

      const res = await fetchWithTimeout('/api/auth/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sync_key: syncKey.trim().toUpperCase(),
          device_token: deviceToken,
          device_name: deviceName,
          remember: remember
        })
      }, 45000);

      const contentType = res.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const txt = await res.text().catch(() => '');
        throw new Error(res.status === 502 || res.status === 503 ? 'Cloud server is waking up, please retry in a few seconds' : `Server returned HTTP ${res.status}`);
      }

      if (data && data.success) {
        this.currentUserId = data.user_id;
        this.currentSyncKey = data.sync_key;
        Storage.setUserId(data.user_id);
        Storage.setSyncKey(data.sync_key);
        Storage.setRemembered(remember);
        this.updateStatus('synced', 'SYNCED');
        return data;
      } else {
        throw new Error((data && data.error) || 'Pairing failed');
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

  syncReadingProgress(novelId, volumeId, chapterId, paragraphIndex, scrollPercent, extraMeta = {}, immediate = false) {
    if (!novelId || !chapterId) return;

    const activeUserId = this.currentUserId || (window.Storage && Storage.getUserId()) || 'guest';
    const activeVolumeId = volumeId || 'vol_default';

    this._syncSeq = (this._syncSeq || 0) + 1;
    const currentSeq = this._syncSeq;
    // Strictly increasing stamp: lets the server discard a save that arrives after a newer one
    this._lastClientTs = Math.max(Date.now(), (this._lastClientTs || 0) + 1);

    // 1. Immediately cache locally scoped to this user
    Storage.saveLocalProgress(novelId, {
      volumeId: activeVolumeId,
      chapterId,
      paragraphIndex,
      scrollPercent,
      ...extraMeta
    }, activeUserId);

    const progressRecord = {
      seq: currentSeq,
      client_id: Storage.getClientId(),
      client_ts: this._lastClientTs,
      user_id: activeUserId,
      novel_id: novelId,
      volume_id: activeVolumeId,
      chapter_id: chapterId,
      paragraph_index: paragraphIndex,
      scroll_percent: scrollPercent,
      extraMeta: { ...extraMeta }
    };

    // 2. If offline, queue for later sync
    if (!navigator.onLine) {
      Storage.queueOfflineProgress(progressRecord);
      this.updateStatus('offline', 'LOCAL ONLY');
      return;
    }

    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.updateStatus('syncing', 'SAVING...');
    this.lastPendingProgress = progressRecord;

    if (immediate) {
      this.flushPendingSync();
    } else {
      this.syncTimeout = setTimeout(() => {
        this.flushPendingSync();
      }, 400);
    }
  },

  flushPendingSync() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    const record = this.lastPendingProgress;
    if (!record) return;
    const uid = record.user_id || this.currentUserId || (window.Storage && Storage.getUserId()) || 'guest';
    record.user_id = uid;
    this.lastPendingProgress = null;
    const reqSeq = record.seq || 0;

    try {
      fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: record.user_id,
          novel_id: record.novel_id,
          volume_id: record.volume_id || 'vol_default',
          chapter_id: record.chapter_id,
          paragraph_index: record.paragraph_index,
          scroll_percent: record.scroll_percent,
          client_id: record.client_id,
          client_ts: record.client_ts
        }),
        keepalive: true
      }).then(res => res.json()).then(data => {
        if (data && data.success) {
          this.updateStatus('synced', 'SAVED');
          // Anything parked while the connection was bad can go now (the server drops it if it is stale)
          if (Storage.getOfflineProgressQueue().length > 0) this.flushOfflineQueue();
          if (data.updated_at) {
            // A response for an older save must not roll back local progress the reader has since moved past
            const currentLocal = Storage.getLocalProgress(record.novel_id, record.user_id);
            if (!currentLocal || (this._syncSeq && reqSeq >= this._syncSeq)) {
              Storage.saveLocalProgress(record.novel_id, {
                volumeId: record.volume_id || 'vol_default',
                chapterId: record.chapter_id,
                paragraphIndex: record.paragraph_index,
                scrollPercent: record.scroll_percent,
                ...(record.extraMeta || {}),
                savedAt: Math.round(data.updated_at * 1000)
              }, record.user_id);
            }
          }
        }
      }).catch(e => {
        console.warn('Progress cloud sync error, queuing offline:', e);
        Storage.queueOfflineProgress(record);
        this.updateStatus('offline', 'LOCAL ONLY');
      });
    } catch (e) {
      Storage.queueOfflineProgress(record);
    }
  },

  async flushOfflineQueue() {
    const queue = Storage.getOfflineProgressQueue();
    if (!queue || queue.length === 0) return;

    if (this._flushingQueue) return;
    this._flushingQueue = true;
    const activeUid = this.currentUserId || (window.Storage && Storage.getUserId()) || 'guest';
    let syncedCount = 0;
    const failed = [];
    for (const record of queue) {
      try {
        const uid = record.user_id || activeUid;
        const res = await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            novel_id: record.novel_id,
            volume_id: record.volume_id || 'vol_default',
            chapter_id: record.chapter_id,
            paragraph_index: record.paragraph_index,
            scroll_percent: record.scroll_percent,
            client_id: record.client_id,
            client_ts: record.client_ts
          })
        });
        const data = await res.json();
        if (!(data && data.success)) {
          failed.push(record);
          continue;
        }
        {
          syncedCount++;
          // A replayed save only refreshes local state if the server took it and nothing newer was saved since
          if (data.updated_at && data.applied !== false && (record.client_ts || 0) >= (this._lastClientTs || 0)) {
            Storage.saveLocalProgress(record.novel_id, {
              volumeId: record.volume_id || 'vol_default',
              chapterId: record.chapter_id,
              paragraphIndex: record.paragraph_index,
              scrollPercent: record.scroll_percent,
              ...(record.extraMeta || {}),
              savedAt: Math.round(data.updated_at * 1000)
            }, uid);
          }
        }
      } catch (e) {
        console.warn('Error syncing queued offline progress:', e);
        failed.push(record);
      }
    }
    this._flushingQueue = false;

    // Only drop what actually reached the server; the rest waits for the next attempt. Saves queued while this
    // flush was running are kept too, newest per novel winning.
    const handled = new Set(queue.map(r => `${r.novel_id}:${r.queued_at}`));
    const arrivedMeanwhile = Storage.getOfflineProgressQueue().filter(r => !handled.has(`${r.novel_id}:${r.queued_at}`));
    const keep = new Map();
    for (const r of [...failed, ...arrivedMeanwhile]) {
      const prev = keep.get(r.novel_id);
      if (!prev || (r.client_ts || 0) >= (prev.client_ts || 0)) keep.set(r.novel_id, r);
    }
    if (keep.size > 0) {
      Storage.setOfflineProgressQueue([...keep.values()]);
    } else {
      Storage.clearOfflineProgressQueue();
    }

    if (syncedCount > 0) {
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
    const userId = this.currentUserId || Storage.getUserId();
    const syncKey = this.currentSyncKey || Storage.getSyncKey();

    if (!userId) return { success: false, error: 'No user ID' };

    // 1. Fetch current full local backup from local server or IDB mirror
    let backupData = null;
    try {
      const res = await fetch(`/api/backup?user_id=${encodeURIComponent(userId)}`);
      if (res.ok) {
        backupData = await res.json();
      }
    } catch (e) {
      console.warn('Could not fetch from local /api/backup with user_id:', e);
    }

    if ((!backupData || !backupData.novels || backupData.novels.length === 0) && typeof IDB !== 'undefined') {
      backupData = await IDB.getLibraryMirror(userId);
    }

    if (!backupData || !backupData.novels || backupData.novels.length === 0) {
      throw new Error('No local novels found to push to cloud.');
    }

    // 2. Transmit to remote Cloud Server (/api/restore) with 60s timeout for large books
    const restoreRes = await fetchWithTimeout(`${cloudUrl}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        sync_key: syncKey,
        backup_data: backupData
      })
    }, 60000);

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
