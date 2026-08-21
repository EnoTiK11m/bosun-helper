(() => {
  'use strict';

  const MAX_RESTORED_IDS = 5000;
  const MAX_SESSION_RAW_LENGTH = 2 * 1024 * 1024;

  function createNeedAckBaseline(options) {
    const {
      sessionKey,
      isSoundEnabled,
      reportDiagnostics,
      playNeedAckChime,
      collectCurrentIdsAndSeverity,
      onNewAlerts
    } = options;

    let ready = false;
    let previousIds = new Set();
    let previousSnapshotSize = 0;
    let refreshAttempts = 0;
    let missingCount = 0;
    let emptySnapshotCount = 0;
    let persistedState = null;

    function collectPersistedIds() {
      const ids = [];
      for (const id of previousIds) {
        if (typeof id !== 'string' || !id || id.length > 500) continue;
        ids.push(id);
        if (ids.length >= MAX_RESTORED_IDS) break;
      }
      return ids;
    }

    function samePersistedState(ids) {
      if (
        !persistedState ||
        persistedState.ready !== ready ||
        persistedState.size !== previousSnapshotSize ||
        persistedState.ids.size !== ids.length
      ) return false;
      return ids.every((id) => persistedState.ids.has(id));
    }

    function rememberPersistedState(ids) {
      persistedState = {
        ready,
        size: previousSnapshotSize,
        ids: new Set(ids)
      };
    }

    function persistToSession() {
      if (!window?.sessionStorage) return;
      try {
        const ids = collectPersistedIds();
        if (samePersistedState(ids)) return;
        const payload = {
          ready,
          ids,
          size: previousSnapshotSize
        };
        window.sessionStorage.setItem(sessionKey, JSON.stringify(payload));
        rememberPersistedState(ids);
      } catch (err) {
        console.warn('[Bosun plugin] Failed to persist NeedAck baseline to sessionStorage:', err);
        reportDiagnostics('baseline-session-save-failed', err?.message || 'unknown-error');
      }
    }

    function restoreFromSession() {
      if (!window?.sessionStorage) return;
      try {
        const raw = window.sessionStorage.getItem(sessionKey);
        if (!raw) return;
        if (raw.length > MAX_SESSION_RAW_LENGTH) {
          window.sessionStorage.removeItem(sessionKey);
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.ready !== true || !Array.isArray(parsed.ids)) return;
        const ids = [];
        const seen = new Set();
        for (const rawId of parsed.ids) {
          const id = typeof rawId === 'string' ? rawId.trim() : '';
          if (!id || id.length > 500 || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
          if (ids.length >= MAX_RESTORED_IDS) break;
        }
        const storedSize = Number(parsed.size);
        const restoreTruncated = parsed.ids.length > MAX_RESTORED_IDS ||
          (Number.isFinite(storedSize) && storedSize > ids.length);
        previousIds = restoreTruncated ? new Set() : new Set(ids);
        ready = !restoreTruncated;
        previousSnapshotSize = ready && Number.isFinite(storedSize)
          ? Math.max(0, Math.round(storedSize))
          : previousIds.size;
        if (ready) rememberPersistedState(ids);
      } catch (err) {
        console.warn('[Bosun plugin] Failed to restore NeedAck baseline from sessionStorage:', err);
        reportDiagnostics('baseline-session-restore-failed', err?.message || 'unknown-error');
      }
    }

    function clearSession() {
      if (!window?.sessionStorage) return;
      try {
        window.sessionStorage.removeItem(sessionKey);
        persistedState = null;
      } catch (err) {
        console.warn('[Bosun plugin] Failed to clear NeedAck baseline from sessionStorage:', err);
        reportDiagnostics('baseline-session-clear-failed', err?.message || 'unknown-error');
      }
    }

    function reset() {
      ready = false;
      previousIds = new Set();
      previousSnapshotSize = 0;
      refreshAttempts = 0;
      missingCount = 0;
      emptySnapshotCount = 0;
      clearSession();
    }

    function process(payload) {
      refreshAttempts += 1;

      const soundEnabled = isSoundEnabled();
      if (!soundEnabled) {
        reportDiagnostics('sound-disabled', 'toggle=off');
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
          if (soundEnabled && hasAlertChime) playNeedAckChime('alert');
          else if (soundEnabled && hasSoft) playNeedAckChime('soft');
          onNewAlerts?.({
            newIds: Array.from(currentIds),
            idToSeverity,
            total: currentIds.size,
            source: 'baseline-recovery'
          });
          reportDiagnostics('baseline-init-with-chime', `ids=${currentIds.size}, missingBefore=${missingCount}`);
        }

        previousIds = currentIds;
        previousSnapshotSize = currentIds.size;
        ready = true;
        missingCount = 0;
        emptySnapshotCount = 0;
        persistToSession();
        reportDiagnostics('baseline-init', `ids=${currentIds.size}`);
        return;
      }

      const currentSize = currentIds.size;
      if (currentSize === 0 && previousSnapshotSize > 0) {
        emptySnapshotCount += 1;
        if (emptySnapshotCount < 2) {
          reportDiagnostics(
            'empty-snapshot-pending',
            `previous=${previousSnapshotSize}, confirmation=${emptySnapshotCount}/2`
          );
          return;
        }
      } else {
        emptySnapshotCount = 0;
      }

      if (currentSize === 0) {
        previousIds = currentIds;
        previousSnapshotSize = 0;
        persistToSession();
        reportDiagnostics('empty-snapshot-confirmed', 'ids=0');
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

      if (soundEnabled && hasAlertChime) playNeedAckChime('alert');
      else if (soundEnabled && hasSoft) playNeedAckChime('soft');
      onNewAlerts?.({
        newIds: newIds.slice(),
        idToSeverity,
        total: currentIds.size,
        source: 'refresh'
      });
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
    MAX_RESTORED_IDS,
    createNeedAckBaseline
  };
})();
