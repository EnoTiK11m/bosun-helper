(() => {
  'use strict';

  function createAlertMarkerCache({ window, Date, setTimeout, clearTimeout, getAlertMarkerCacheMaps, onRestored, reportDiagnostics }) {
  const ALERT_MARKER_CACHE_SESSION_KEY = 'bosunAlertMarkerCacheV1';
  const ALERT_MARKER_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  const ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP = 2000;
  const ALERT_MARKER_CACHE_PERSIST_DELAY_MS = 5000;
  const ALERT_MARKER_CACHE_MIN_PERSIST_INTERVAL_MS = 30000;
  const ALERT_MARKER_CACHE_MAX_UNCHANGED_AGE_MS = 5 * 60 * 1000;
  const ALERT_MARKER_CACHE_MAX_RAW_LENGTH = 5 * 1024 * 1024;
  const ALERT_MARKER_CACHE_MAX_KEY_LENGTH = 1000;
  const ALERT_MARKER_CACHE_SCHEMA_VERSION = 2;

  let alertMarkerCachePersistTimer = null;
  let lastAlertMarkerCacheSerializedMaps = '';
  let lastAlertMarkerCachePersistAttemptAt = 0;
  let lastAlertMarkerCacheSavedAt = 0;

  function serializeAlertMarkerMap(map) {
    return Array.from(map.entries())
      .filter(([key, value]) => (
        (typeof key === 'number' || (
          typeof key === 'string' && key.length <= ALERT_MARKER_CACHE_MAX_KEY_LENGTH
        )) &&
        (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      ))
      .slice(0, ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP);
  }

  function flushAlertMarkerCacheToSession() {
    try {
      lastAlertMarkerCachePersistAttemptAt = Date.now();
      const maps = {};
      for (const [name, map] of Object.entries(getAlertMarkerCacheMaps())) {
        maps[name] = serializeAlertMarkerMap(map);
      }
      const serializedMaps = JSON.stringify(maps);
      if (
        serializedMaps === lastAlertMarkerCacheSerializedMaps &&
        Date.now() - lastAlertMarkerCacheSavedAt < ALERT_MARKER_CACHE_MAX_UNCHANGED_AGE_MS
      ) return;
      const savedAt = Date.now();
      window.sessionStorage.setItem(ALERT_MARKER_CACHE_SESSION_KEY, JSON.stringify({
        version: ALERT_MARKER_CACHE_SCHEMA_VERSION,
        savedAt,
        maps
      }));
      lastAlertMarkerCacheSerializedMaps = serializedMaps;
      lastAlertMarkerCacheSavedAt = savedAt;
    } catch (err) {
      reportDiagnostics('alert-marker-cache-save-failed', err?.message || 'unknown-error');
    }
  }

  function persistAlertMarkerCacheToSession() {
    if (alertMarkerCachePersistTimer) return;
    const elapsed = Date.now() - lastAlertMarkerCachePersistAttemptAt;
    const throttleDelay = Math.max(0, ALERT_MARKER_CACHE_MIN_PERSIST_INTERVAL_MS - elapsed);
    alertMarkerCachePersistTimer = setTimeout(() => {
      alertMarkerCachePersistTimer = null;
      flushAlertMarkerCacheToSession();
    }, Math.max(ALERT_MARKER_CACHE_PERSIST_DELAY_MS, throttleDelay));
  }

  function restoreAlertMarkerCacheFromSession() {
    try {
      const raw = window.sessionStorage.getItem(ALERT_MARKER_CACHE_SESSION_KEY);
      if (!raw) return false;
      if (raw.length > ALERT_MARKER_CACHE_MAX_RAW_LENGTH) {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
        return false;
      }
      const cached = JSON.parse(raw);
      const ageMs = Date.now() - Number(cached?.savedAt);
      if (
        cached?.version !== ALERT_MARKER_CACHE_SCHEMA_VERSION ||
        !cached.maps ||
        typeof cached.maps !== 'object' ||
        !Number.isFinite(ageMs) ||
        ageMs < 0 ||
        ageMs > ALERT_MARKER_CACHE_MAX_AGE_MS
      ) {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
        return false;
      }

      const cacheMaps = getAlertMarkerCacheMaps();
      if (Object.keys(cacheMaps).some((name) => !Array.isArray(cached.maps[name]))) {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
        return false;
      }

      const restoredMaps = new Map();
      for (const [name] of Object.entries(cacheMaps)) {
        const entries = cached.maps[name];
        const restoredMap = new Map();
        for (const entry of entries.slice(0, ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP)) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
            return false;
          }
          const [key, value] = entry;
          const validKey = typeof key === 'number' || (
            typeof key === 'string' && key.length <= ALERT_MARKER_CACHE_MAX_KEY_LENGTH
          );
          const validValue = typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
          if (!validKey || !validValue) {
            window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
            return false;
          }
          restoredMap.set(key, value);
        }
        restoredMaps.set(name, restoredMap);
      }
      for (const [name, map] of Object.entries(cacheMaps)) {
        map.clear();
        for (const [key, value] of restoredMaps.get(name)) map.set(key, value);
      }
      lastAlertMarkerCacheSerializedMaps = JSON.stringify(cached.maps);
      lastAlertMarkerCacheSavedAt = Number(cached.savedAt);
      onRestored();
      return true;
    } catch (err) {
      try {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
      } catch (_) {}
      reportDiagnostics('alert-marker-cache-restore-failed', err?.message || 'unknown-error');
      return false;
    }
  }

  function flushPending() {
    if (alertMarkerCachePersistTimer) {
      clearTimeout(alertMarkerCachePersistTimer);
      alertMarkerCachePersistTimer = null;
      flushAlertMarkerCacheToSession();
    }
  }

    return { serializeAlertMarkerMap, flushAlertMarkerCacheToSession, persistAlertMarkerCacheToSession, restoreAlertMarkerCacheFromSession, flushPending };
  }

  globalThis.BosunHelperAlertMarkerCache = Object.freeze({ createAlertMarkerCache });
})();
