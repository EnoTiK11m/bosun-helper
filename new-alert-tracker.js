(() => {
  'use strict';

  const VERSION = 1;
  const MAX_TRACKED_ALERTS = 500;

  function createNewAlertTracker(options = {}) {
    const {
      storageKey = 'bosunNewAlertsAwaitingNoteV1',
      getStorage = () => globalThis.chrome?.storage?.local || null,
      getLastError = () => globalThis.chrome?.runtime?.lastError || null,
      storageChanges = globalThis.chrome?.storage?.onChanged,
      collectCurrentIdsAndSeverity = () => ({ currentIds: new Set(), idToSeverity: new Map() }),
      normalizeChildren = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]),
      getChildStableKey = () => null,
      getGroupStableKey = () => null,
      hasNoteFromActions = () => false,
      onChange = () => {},
      reportDiagnostics = () => {}
    } = options;

    const tracked = new Map();
    let started = false;
    let readyPromise = null;
    let storageListener = null;
    let lastSerialized = '';
    let storageRevision = 0;
    let writeInFlight = false;
    let queuedSerialized = '';
    let lifecycleGeneration = 0;

    function normalizeSeverity(value) {
      const severity = String(value || '').toLowerCase();
      if (severity === 'warning' || severity === 'critical') return severity;
      return 'unknown';
    }

    function serialize() {
      return JSON.stringify({
        version: VERSION,
        alerts: Array.from(tracked, ([id, value]) => ({
          id,
          severity: value.severity,
          detectedAt: value.detectedAt
        }))
      });
    }

    function notify() {
      const counts = { warning: 0, critical: 0, unknown: 0 };
      for (const value of tracked.values()) counts[normalizeSeverity(value.severity)] += 1;
      onChange({ counts, total: tracked.size });
    }

    function applyStoredValue(value) {
      const alerts = value?.version === VERSION && Array.isArray(value.alerts)
        ? value.alerts.slice(0, MAX_TRACKED_ALERTS)
        : [];
      tracked.clear();
      for (const item of alerts) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        if (!id || id.length > 500) continue;
        tracked.set(id, {
          severity: normalizeSeverity(item.severity),
          detectedAt: Number.isFinite(Number(item.detectedAt))
            ? Number(item.detectedAt)
            : Date.now()
        });
      }
      lastSerialized = serialize();
      notify();
    }

    function restore(expectedRevision, generation) {
      return new Promise((resolve) => {
        const storage = getStorage();
        if (!storage?.get) {
          applyStoredValue(null);
          resolve();
          return;
        }
        try {
          storage.get([storageKey], (items) => {
            if (!started || generation !== lifecycleGeneration) {
              resolve();
              return;
            }
            const error = getLastError();
            if (error) {
              reportDiagnostics('new-alert-tracker-restore-failed', error.message || 'unknown-error');
              if (storageRevision === expectedRevision) applyStoredValue(null);
            } else {
              if (storageRevision === expectedRevision) applyStoredValue(items?.[storageKey]);
            }
            resolve();
          });
        } catch (error) {
          if (!started || generation !== lifecycleGeneration) {
            resolve();
            return;
          }
          reportDiagnostics('new-alert-tracker-restore-failed', error?.message || 'unknown-error');
          if (storageRevision === expectedRevision) applyStoredValue(null);
          resolve();
        }
      });
    }

    function flushPersistQueue() {
      if (!started) return;
      if (writeInFlight || !queuedSerialized) return;
      const storage = getStorage();
      if (!storage?.set) {
        queuedSerialized = '';
        return;
      }
      const serialized = queuedSerialized;
      const generation = lifecycleGeneration;
      queuedSerialized = '';
      writeInFlight = true;
      try {
        storage.set({ [storageKey]: JSON.parse(serialized) }, () => {
          if (!started || generation !== lifecycleGeneration) return;
          const error = getLastError();
          writeInFlight = false;
          if (error) {
            reportDiagnostics('new-alert-tracker-save-failed', error.message || 'unknown-error');
            return;
          }
          lastSerialized = serialized;
          const current = serialize();
          if (current !== lastSerialized) queuedSerialized = current;
          flushPersistQueue();
        });
      } catch (error) {
        writeInFlight = false;
        reportDiagnostics('new-alert-tracker-save-failed', error?.message || 'unknown-error');
      }
    }

    function persist() {
      if (!started) return;
      const serialized = serialize();
      if (serialized === lastSerialized || serialized === queuedSerialized) return;
      queuedSerialized = serialized;
      flushPersistQueue();
    }

    function getEntityActions(entity) {
      const state = entity?.State || {};
      const actions = [
        ...(Array.isArray(state.Actions) ? state.Actions : []),
        ...(Array.isArray(state.actions) ? state.actions : []),
        ...(Array.isArray(entity?.Actions) ? entity.Actions : []),
        ...(Array.isArray(entity?.actions) ? entity.actions : [])
      ];
      const lastAction = state.LastAction ?? state.lastAction ?? entity?.LastAction ?? entity?.lastAction;
      if (lastAction != null) actions.push(lastAction);
      return actions;
    }

    function entityHasNote(entity) {
      const actions = getEntityActions(entity);
      if (hasNoteFromActions(actions)) return true;
      return actions.some((action) => {
        return typeof action === 'string' && /\bNote\b[\s\S]*?:\s*\S/i.test(action);
      });
    }

    function collectIdsWithNote(payload) {
      const result = new Set();
      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) return result;

      for (const group of groups) {
        const children = normalizeChildren(group?.Children);
        if (!children.length) {
          const key = getGroupStableKey(group);
          if (key && entityHasNote(group)) result.add(key);
          continue;
        }

        let childKeyFound = false;
        for (const child of children) {
          const key = getChildStableKey(child, group);
          if (!key) continue;
          childKeyFound = true;
          if (entityHasNote(child)) result.add(key);
        }
        if (!childKeyFound) {
          const key = getGroupStableKey(group);
          if (key && entityHasNote(group)) result.add(key);
        }
      }
      return result;
    }

    async function add(newIds, idToSeverity) {
      const generation = lifecycleGeneration;
      await (readyPromise || Promise.resolve());
      if (!started || generation !== lifecycleGeneration) return;
      let changed = false;
      for (const rawId of Array.isArray(newIds) ? newIds : []) {
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id || tracked.has(id) || tracked.size >= MAX_TRACKED_ALERTS) continue;
        tracked.set(id, {
          severity: normalizeSeverity(idToSeverity?.get?.(id)),
          detectedAt: Date.now()
        });
        changed = true;
      }
      persist();
      if (changed) notify();
    }

    async function reconcile(payload) {
      const generation = lifecycleGeneration;
      await (readyPromise || Promise.resolve());
      if (!started || generation !== lifecycleGeneration) return;
      const { currentIds, idToSeverity } = collectCurrentIdsAndSeverity(payload);
      const notedIds = collectIdsWithNote(payload);
      let changed = false;

      for (const [id, value] of tracked) {
        if (!currentIds.has(id) || notedIds.has(id)) {
          tracked.delete(id);
          changed = true;
          continue;
        }
        const severity = normalizeSeverity(idToSeverity.get(id));
        if (severity !== value.severity) {
          value.severity = severity;
          changed = true;
        }
      }
      persist();
      if (changed) notify();
    }

    function start() {
      if (started) return readyPromise;
      started = true;
      const generation = ++lifecycleGeneration;
      storageListener = (changes, areaName) => {
        if (!started || generation !== lifecycleGeneration) return;
        if (areaName !== 'local' || !changes?.[storageKey]) return;
        storageRevision += 1;
        const next = changes[storageKey].newValue;
        const nextSerialized = JSON.stringify(next || null);
        if (nextSerialized === lastSerialized) return;
        if (nextSerialized === serialize()) {
          lastSerialized = nextSerialized;
          return;
        }
        applyStoredValue(next);
      };
      storageChanges?.addListener?.(storageListener);
      readyPromise = restore(storageRevision, generation);
      return readyPromise;
    }

    function destroy() {
      lifecycleGeneration += 1;
      storageChanges?.removeListener?.(storageListener);
      storageListener = null;
      started = false;
      readyPromise = null;
      writeInFlight = false;
      queuedSerialized = '';
    }

    return { start, destroy, add, reconcile };
  }

  globalThis.BosunHelperNewAlertTracker = { createNewAlertTracker };
})();
