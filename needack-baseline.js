(() => {
  'use strict';

  function createNeedAckBaseline(options) {
    const {
      sessionKey,
      isSoundEnabled,
      reportDiagnostics,
      playNeedAckChime,
      collectCurrentIdsAndSeverity
    } = options;

    let ready = false;
    let previousIds = new Set();
    let previousSnapshotSize = 0;
    let refreshAttempts = 0;
    let missingCount = 0;

    function persistToSession() {
      if (!window?.sessionStorage) return;
      try {
        const payload = {
          ready,
          ids: Array.from(previousIds),
          size: previousSnapshotSize
        };
        window.sessionStorage.setItem(sessionKey, JSON.stringify(payload));
      } catch (_) {}
    }

    function restoreFromSession() {
      if (!window?.sessionStorage) return;
      try {
        const raw = window.sessionStorage.getItem(sessionKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.ready !== true || !Array.isArray(parsed.ids)) return;
        previousIds = new Set(parsed.ids.filter((id) => typeof id === 'string' && id));
        ready = true;
        previousSnapshotSize = Number.isFinite(Number(parsed.size))
          ? Math.max(0, Math.round(Number(parsed.size)))
          : previousIds.size;
      } catch (_) {}
    }

    function clearSession() {
      if (!window?.sessionStorage) return;
      try {
        window.sessionStorage.removeItem(sessionKey);
      } catch (_) {}
    }

    function reset() {
      ready = false;
      previousIds = new Set();
      previousSnapshotSize = 0;
      refreshAttempts = 0;
      missingCount = 0;
      clearSession();
    }

    function process(payload) {
      refreshAttempts += 1;

      if (!isSoundEnabled()) {
        reportDiagnostics('sound-disabled', 'toggle=off');
        return;
      }

      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) {
        missingCount += 1;
        reportDiagnostics('needack-missing', 'Groups.NeedAck is not array');
        return;
      }

      const { currentIds, idToSeverity } = collectCurrentIdsAndSeverity(payload);

      if (!ready) {
        if (missingCount > 0 && refreshAttempts > 1 && currentIds.size > 0) {
          let hasAlertChime = false;
          let hasSoft = false;
          for (const id of currentIds) {
            const bucket = idToSeverity.get(id) || 'unknown';
            if (bucket === 'critical' || bucket === 'unknown') hasAlertChime = true;
            else hasSoft = true;
          }
          if (hasAlertChime) playNeedAckChime('alert');
          else if (hasSoft) playNeedAckChime('soft');
          reportDiagnostics('baseline-init-with-chime', `ids=${currentIds.size}, missingBefore=${missingCount}`);
        }

        previousIds = currentIds;
        previousSnapshotSize = currentIds.size;
        ready = true;
        missingCount = 0;
        persistToSession();
        reportDiagnostics('baseline-init', `ids=${currentIds.size}`);
        return;
      }

      const currentSize = currentIds.size;
      if (
        previousSnapshotSize > 0 &&
        currentSize > 0 &&
        Math.abs(currentSize - previousSnapshotSize) >
          Math.max(5, previousSnapshotSize * 0.7)
      ) {
        const prevSize = previousSnapshotSize;
        previousIds = currentIds;
        previousSnapshotSize = currentSize;
        persistToSession();
        reportDiagnostics('baseline-reset', `prev=${prevSize}, current=${currentSize}`);
        return;
      }

      const newIds = [];
      for (const id of currentIds) {
        if (!previousIds.has(id)) newIds.push(id);
      }
      previousIds = currentIds;
      previousSnapshotSize = currentSize;
      persistToSession();

      if (!newIds.length) {
        reportDiagnostics('no-new-alerts', `ids=${currentIds.size}`);
        return;
      }

      let hasAlertChime = false;
      let hasSoft = false;
      for (const id of newIds) {
        const bucket = idToSeverity.get(id) || 'unknown';
        if (bucket === 'critical' || bucket === 'unknown') hasAlertChime = true;
        else if (bucket === 'warning') hasSoft = true;
        else hasSoft = true;
      }

      if (hasAlertChime) playNeedAckChime('alert');
      else if (hasSoft) playNeedAckChime('soft');
      reportDiagnostics('new-alerts', `new=${newIds.length}, total=${currentIds.size}`);
    }

    return {
      reset,
      persistToSession,
      restoreFromSession,
      clearSession,
      process
    };
  }

  globalThis.BosunSilenceHiderNeedAckBaseline = {
    createNeedAckBaseline
  };
})();
