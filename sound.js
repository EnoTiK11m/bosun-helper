(() => {
  'use strict';

  function createSound(options) {
    const {
      alertFile,
      softFile,
      getEnabled,
      reportDiagnostics,
      crossTabStorageKey = 'bosunNeedAckSoundClaimV1'
    } = options;

    let lastNeedAckChimeAt = 0;
    let audioUnlocked = false;
    let pendingNeedAckChimeKind = null;
    let pendingNeedAckRetryAttached = false;
    let alertChimeAudio = null;
    let softChimeAudio = null;
    let unlockTrackingHandler = null;
    let retryTrackingHandler = null;
    let lifecycleGeneration = 0;
    const crossTabDedupMs = 2000;

    function ensureAudioObjects() {
      if (!chrome?.runtime?.getURL) return;

      if (!alertChimeAudio) {
        alertChimeAudio = new Audio(chrome.runtime.getURL(alertFile));
        alertChimeAudio.preload = 'auto';
        alertChimeAudio.volume = 0.85;
      }

      if (!softChimeAudio) {
        softChimeAudio = new Audio(chrome.runtime.getURL(softFile));
        softChimeAudio.preload = 'auto';
        softChimeAudio.volume = 0.85;
      }
    }

    function unlockAudioOnce() {
      if (audioUnlocked) return;
      const generation = lifecycleGeneration;
      ensureAudioObjects();

      const candidates = [alertChimeAudio, softChimeAudio].filter(Boolean);
      if (!candidates.length) return;

      const unlockPromises = candidates.map((audio) => {
        try {
          audio.muted = true;
          audio.currentTime = 0;
          const playPromise = audio.play();
          if (playPromise && typeof playPromise.then === 'function') {
            return playPromise
              .then(() => {
                audio.pause();
                audio.currentTime = 0;
                audio.muted = false;
                return true;
              })
              .catch(() => false);
          }
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          return Promise.resolve(true);
        } catch (_) {}
        return Promise.resolve(false);
      });

      Promise.all(unlockPromises).then((results) => {
        if (generation !== lifecycleGeneration) return;
        audioUnlocked = results.some(Boolean);
      });
    }

    function installAudioUnlockTracking() {
      if (unlockTrackingHandler) return;
      const onceHandler = () => {
        unlockAudioOnce();
        window.removeEventListener('pointerdown', onceHandler, true);
        window.removeEventListener('keydown', onceHandler, true);
        if (unlockTrackingHandler === onceHandler) unlockTrackingHandler = null;
      };

      unlockTrackingHandler = onceHandler;
      window.addEventListener('pointerdown', onceHandler, true);
      window.addEventListener('keydown', onceHandler, true);
    }

    function formatPlayError(err) {
      if (!err) return 'unknown';
      const name = typeof err?.name === 'string' ? err.name : '';
      const message = typeof err?.message === 'string' ? err.message : '';
      if (name && message) return `${name}: ${message}`;
      return name || message || String(err);
    }

    function isAutoplayBlockReason(reason) {
      if (!reason) return false;
      return /NotAllowedError|gesture|interact/i.test(String(reason));
    }

    function scheduleNeedAckChimeRetry(kind, reason) {
      if (!isAutoplayBlockReason(reason)) return;

      if (pendingNeedAckChimeKind !== 'alert') {
        pendingNeedAckChimeKind = kind;
      }

      if (pendingNeedAckRetryAttached) return;
      pendingNeedAckRetryAttached = true;

      const retryHandler = () => {
        const generation = lifecycleGeneration;
        window.removeEventListener('pointerdown', retryHandler, true);
        window.removeEventListener('keydown', retryHandler, true);
        pendingNeedAckRetryAttached = false;
        if (retryTrackingHandler === retryHandler) retryTrackingHandler = null;

        const retryKind = pendingNeedAckChimeKind;
        pendingNeedAckChimeKind = null;
        if (!retryKind || !getEnabled()) return;

        unlockAudioOnce();
        setTimeout(() => {
          if (generation !== lifecycleGeneration) return;
          playNeedAckChimeUnlocked(retryKind);
        }, 0);
      };

      retryTrackingHandler = retryHandler;
      window.addEventListener('pointerdown', retryHandler, true);
      window.addEventListener('keydown', retryHandler, true);
      reportDiagnostics('sound-retry-armed', `kind=${kind}`);
    }

    function claimCrossTabPlayback(kind) {
      if (!window?.localStorage) return true;
      try {
        const now = Date.now();
        const rawCurrent = window.localStorage.getItem(crossTabStorageKey) || '';
        if (rawCurrent.length > 1024) window.localStorage.removeItem(crossTabStorageKey);
        const current = rawCurrent.length <= 1024 ? JSON.parse(rawCurrent || 'null') : null;
        const currentAgeMs = now - Number(current?.at || 0);
        if (current && currentAgeMs >= 0 && currentAgeMs < crossTabDedupMs) {
          reportDiagnostics('sound-cross-tab-suppressed', `kind=${kind}`);
          return false;
        }

        const token = `${now}-${Math.random().toString(16).slice(2)}`;
        window.localStorage.setItem(crossTabStorageKey, JSON.stringify({ at: now, kind, token }));
        const saved = JSON.parse(window.localStorage.getItem(crossTabStorageKey) || 'null');
        return saved?.token === token;
      } catch (_) {
        return true;
      }
    }

    function playNeedAckChimeUnlocked(kind) {
      if (!getEnabled()) return;
      const generation = lifecycleGeneration;

      const now = Date.now();
      if (now - lastNeedAckChimeAt < 450) {
        reportDiagnostics('sound-throttled', `kind=${kind}`);
        return;
      }
      lastNeedAckChimeAt = now;

      ensureAudioObjects();

      const file = kind === 'alert' ? alertFile : softFile;
      const audio = kind === 'alert' ? alertChimeAudio : softChimeAudio;
      if (!audio) return;

      try {
        audio.pause();
        audio.currentTime = 0;

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          return playPromise
            .then(() => {
              if (generation !== lifecycleGeneration) return false;
              reportDiagnostics('sound-played', `kind=${kind}, file=${file}`);
              return true;
            })
            .catch((err) => {
              if (generation !== lifecycleGeneration) return false;
              const reason = err?.name || err?.message || 'play-error';
              if (!isAutoplayBlockReason(reason)) {
                console.warn('[Bosun plugin] Sound play blocked or failed:', formatPlayError(err), err);
              }
              lastNeedAckChimeAt = 0;
              scheduleNeedAckChimeRetry(kind, reason);
              reportDiagnostics('sound-blocked', `kind=${kind}, reason=${reason}`);
              return false;
            });
        }
        reportDiagnostics('sound-played', `kind=${kind}, file=${file}`);
        return Promise.resolve(true);
      } catch (err) {
        if (generation !== lifecycleGeneration) return Promise.resolve(false);
        const reason = err?.name || err?.message || 'play-error';
        if (!isAutoplayBlockReason(reason)) {
          console.warn('[Bosun plugin] Sound play failed:', formatPlayError(err), err);
        }
        lastNeedAckChimeAt = 0;
        scheduleNeedAckChimeRetry(kind, reason);
        reportDiagnostics('sound-blocked', `kind=${kind}, reason=${reason}`);
        return Promise.resolve(false);
      }
    }

    function playNeedAckChime(kind) {
      if (!getEnabled()) return;
      const generation = lifecycleGeneration;

      const lockManager = globalThis.navigator?.locks;
      if (lockManager?.request) {
        lockManager.request(
          'bosun-helper-needack-sound',
          { ifAvailable: true, mode: 'exclusive' },
          (lock) => {
            if (generation !== lifecycleGeneration) return false;
            if (!lock) {
              reportDiagnostics('sound-cross-tab-suppressed', `kind=${kind}, via=lock`);
              return false;
            }
            if (!claimCrossTabPlayback(kind)) return false;
            return playNeedAckChimeUnlocked(kind);
          }
        ).catch((err) => {
          if (generation !== lifecycleGeneration) return;
          reportDiagnostics('sound-lock-failed', err?.message || 'unknown-error');
          if (claimCrossTabPlayback(kind)) playNeedAckChimeUnlocked(kind);
        });
        return;
      }

      if (claimCrossTabPlayback(kind)) playNeedAckChimeUnlocked(kind);
    }

    function destroy() {
      lifecycleGeneration += 1;
      if (unlockTrackingHandler) {
        window.removeEventListener('pointerdown', unlockTrackingHandler, true);
        window.removeEventListener('keydown', unlockTrackingHandler, true);
        unlockTrackingHandler = null;
      }
      if (retryTrackingHandler) {
        window.removeEventListener('pointerdown', retryTrackingHandler, true);
        window.removeEventListener('keydown', retryTrackingHandler, true);
        retryTrackingHandler = null;
      }
      pendingNeedAckRetryAttached = false;
      pendingNeedAckChimeKind = null;
      for (const audio of [alertChimeAudio, softChimeAudio]) {
        try { audio?.pause?.(); } catch (_) {}
      }
      alertChimeAudio = null;
      softChimeAudio = null;
      audioUnlocked = false;
      lastNeedAckChimeAt = 0;
    }

    return {
      ensureAudioObjects,
      unlockAudioOnce,
      installAudioUnlockTracking,
      formatPlayError,
      isAutoplayBlockReason,
      scheduleNeedAckChimeRetry,
      claimCrossTabPlayback,
      playNeedAckChimeUnlocked,
      playNeedAckChime,
      destroy
    };
  }

  globalThis.BosunSilenceHiderSound = {
    createSound
  };
})();
