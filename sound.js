(() => {
  'use strict';

  function createSound(options) {
    const {
      alertFile,
      softFile,
      getEnabled,
      reportDiagnostics
    } = options;

    let lastNeedAckChimeAt = 0;
    let audioUnlocked = false;
    let pendingNeedAckChimeKind = null;
    let pendingNeedAckRetryAttached = false;
    let alertChimeAudio = null;
    let softChimeAudio = null;

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
              })
              .catch(() => {});
          }
        } catch (_) {}
        return Promise.resolve();
      });

      Promise.allSettled(unlockPromises).finally(() => {
        audioUnlocked = true;
      });
    }

    function installAudioUnlockTracking() {
      const onceHandler = () => {
        unlockAudioOnce();
        window.removeEventListener('pointerdown', onceHandler, true);
        window.removeEventListener('keydown', onceHandler, true);
      };

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
        window.removeEventListener('pointerdown', retryHandler, true);
        window.removeEventListener('keydown', retryHandler, true);
        pendingNeedAckRetryAttached = false;

        const retryKind = pendingNeedAckChimeKind;
        pendingNeedAckChimeKind = null;
        if (!retryKind || !getEnabled()) return;

        unlockAudioOnce();
        setTimeout(() => {
          playNeedAckChime(retryKind);
        }, 0);
      };

      window.addEventListener('pointerdown', retryHandler, true);
      window.addEventListener('keydown', retryHandler, true);
      reportDiagnostics('sound-retry-armed', `kind=${kind}`);
    }

    function playNeedAckChime(kind) {
      if (!getEnabled()) return;

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
          playPromise
            .then(() => {
              reportDiagnostics('sound-played', `kind=${kind}, file=${file}`);
            })
            .catch((err) => {
              const reason = err?.name || err?.message || 'play-error';
              if (!isAutoplayBlockReason(reason)) {
                console.warn('[Bosun plugin] Sound play blocked or failed:', formatPlayError(err), err);
              }
              lastNeedAckChimeAt = 0;
              scheduleNeedAckChimeRetry(kind, reason);
              reportDiagnostics('sound-blocked', `kind=${kind}, reason=${reason}`);
            });
        }
      } catch (err) {
        const reason = err?.name || err?.message || 'play-error';
        if (!isAutoplayBlockReason(reason)) {
          console.warn('[Bosun plugin] Sound play failed:', formatPlayError(err), err);
        }
        lastNeedAckChimeAt = 0;
        scheduleNeedAckChimeRetry(kind, reason);
        reportDiagnostics('sound-blocked', `kind=${kind}, reason=${reason}`);
      }
    }

    return {
      ensureAudioObjects,
      unlockAudioOnce,
      installAudioUnlockTracking,
      formatPlayError,
      isAutoplayBlockReason,
      scheduleNeedAckChimeRetry,
      playNeedAckChime
    };
  }

  globalThis.BosunSilenceHiderSound = {
    createSound
  };
})();
