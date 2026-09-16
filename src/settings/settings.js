(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const VERSION_KEY = 'bosunSettingsSchemaVersion';
  const STORAGE_PREFIX = 'bosunSettingsV1:';
  const ACTION_TYPES = Object.freeze(['note', 'ack', 'close']);
  const MAX_TEMPLATES_PER_TYPE = 50;
  const MAX_TEMPLATE_LENGTH = 500;
  const MAX_TOTAL_TEMPLATE_TEXT_LENGTH = 10000;

  const FEATURE_DEFAULTS = Object.freeze({
    singleAlertAge: true,
    checkboxImprovements: true,
    copyButtons: true,
    lastActionEnhancements: true,
    silencedFilter: true,
    noCommentFilter: true,
    acknowledgedCollapse: true,
    soundNotifications: true,
    visualNewAlertNotifications: true,
    autoRefresh: true,
    actionTemplates: true,
    grafanaIntegration: true
  });

  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    features: FEATURE_DEFAULTS,
    preferences: Object.freeze({
      showSilenced: false,
      noCommentFilterActive: false,
      acknowledgedCollapsed: false,
      soundEnabled: true,
      autoRefreshEnabled: true,
      autoRefreshIdleSeconds: 60
    }),
    actionTemplates: Object.freeze({ note: null, ack: null, close: null }),
    internal: Object.freeze({ diagnosticsEnabled: false })
  });

  function normalizeBoolean(value) {
    return typeof value === 'boolean' ? { valid: true, value } : { valid: false };
  }

  function normalizeIdleSeconds(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return { valid: false };
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return { valid: false };
      value = text;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return { valid: false };
    return { valid: true, value: Math.min(3600, Math.max(10, Math.round(numeric))) };
  }

  function normalizeTemplates(value) {
    if (value === null) return { valid: true, value: null };
    if (!Array.isArray(value)) return { valid: false };
    const normalized = [];
    const seen = new Set();
    let totalLength = 0;
    let scanned = 0;
    for (const candidate of value) {
      scanned += 1;
      if (scanned > MAX_TEMPLATES_PER_TYPE * 4 || normalized.length >= MAX_TEMPLATES_PER_TYPE) break;
      if (typeof candidate !== 'string') continue;
      const text = candidate.trim();
      if (
        !text ||
        text.length > MAX_TEMPLATE_LENGTH ||
        seen.has(text) ||
        totalLength + text.length > MAX_TOTAL_TEMPLATE_TEXT_LENGTH
      ) continue;
      seen.add(text);
      normalized.push(text);
      totalLength += text.length;
    }
    return { valid: true, value: normalized };
  }

  function entry(path, defaultValue, normalize, legacyKey = '') {
    return Object.freeze({
      path,
      defaultValue,
      normalize,
      legacyKey,
      storageKey: `${STORAGE_PREFIX}${path}`
    });
  }

  const schemaEntries = [];
  for (const [name, defaultValue] of Object.entries(FEATURE_DEFAULTS)) {
    schemaEntries.push(entry(`features.${name}`, defaultValue, normalizeBoolean));
  }
  schemaEntries.push(
    entry('preferences.showSilenced', false, normalizeBoolean, 'bosunShowSilenced'),
    entry('preferences.noCommentFilterActive', false, normalizeBoolean, 'bosunNoUserCommentFilterEnabled'),
    entry('preferences.acknowledgedCollapsed', false, normalizeBoolean, 'bosunAcknowledgedCollapseEnabled'),
    entry('preferences.soundEnabled', true, normalizeBoolean, 'bosunSoundAlertsEnabled'),
    entry('preferences.autoRefreshEnabled', true, normalizeBoolean, 'bosunAutoRefreshEnabled'),
    entry('preferences.autoRefreshIdleSeconds', 60, normalizeIdleSeconds, 'bosunAutoRefreshIdleSeconds')
  );
  for (const type of ACTION_TYPES) {
    schemaEntries.push(entry(`actionTemplates.${type}`, null, normalizeTemplates, `bosunActionTemplatesV1:${type}`));
  }
  schemaEntries.push(entry('internal.diagnosticsEnabled', false, normalizeBoolean, 'bosunDiagnosticsEnabled'));

  const SCHEMA = Object.freeze(schemaEntries);
  const ENTRY_BY_PATH = new Map(SCHEMA.map((item) => [item.path, item]));
  const ENTRY_BY_STORAGE_KEY = new Map(SCHEMA.map((item) => [item.storageKey, item]));
  const ENTRY_BY_LEGACY_KEY = new Map(SCHEMA.filter((item) => item.legacyKey).map((item) => [item.legacyKey, item]));
  const SETTINGS_STORAGE_KEYS = Object.freeze(Array.from(new Set([
    VERSION_KEY,
    ...SCHEMA.map((item) => item.storageKey),
    ...SCHEMA.map((item) => item.legacyKey).filter(Boolean)
  ])));

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = clone(child);
      return result;
    }
    return value;
  }

  function createDefaultSnapshot() {
    return clone(DEFAULTS);
  }

  function readPath(snapshot, path) {
    const [section, name] = path.split('.');
    return snapshot?.[section]?.[name];
  }

  function writePath(snapshot, path, value) {
    const [section, name] = path.split('.');
    snapshot[section][name] = clone(value);
  }

  function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  }

  function createSettingsStore(options = {}) {
    const storage = options.storage || null;
    const storageChanges = options.storageChanges || null;
    const getLastError = typeof options.getLastError === 'function' ? options.getLastError : () => null;
    const warn = typeof options.warn === 'function'
      ? options.warn
      : (message, error) => console.warn(`[Bosun Helper] ${message}`, error || '');

    let snapshot = createDefaultSnapshot();
    let started = false;
    let destroyed = false;
    let startPromise = null;
    let changeListener = null;
    let futureVersion = false;
    let versionRevision = 0;
    let operationSequence = 0;
    let resetInFlight = false;
    let resetBufferedChanges = [];
    let mutationGeneration = 0;
    const subscribers = new Set();
    const latestOperationByPath = new Map();
    const pathRevisions = new Map(SCHEMA.map((item) => [item.path, 0]));
    const mirrorGenerationByPath = new Map(SCHEMA.map((item) => [item.path, 0]));
    const suppressLegacyMirrorByStorageKey = new Map();

    function notify(previous, changedPaths) {
      if (!changedPaths.length || destroyed) return;
      const nextClone = clone(snapshot);
      const previousClone = clone(previous);
      for (const subscriber of Array.from(subscribers)) {
        try {
          subscriber(clone(nextClone), clone(previousClone), changedPaths.slice());
        } catch (error) {
          warn('Settings subscriber failed.', error);
        }
      }
    }

    function applyValues(valuesByPath) {
      const previous = clone(snapshot);
      const changedPaths = [];
      for (const [path, value] of Object.entries(valuesByPath)) {
        if (equal(readPath(snapshot, path), value)) continue;
        writePath(snapshot, path, value);
        changedPaths.push(path);
      }
      notify(previous, changedPaths);
      return changedPaths;
    }

    function callStorage(method, argument) {
      return new Promise((resolve, reject) => {
        if (!storage || typeof storage[method] !== 'function') {
          reject(new Error(`chrome.storage.local.${method} is unavailable`));
          return;
        }
        let settled = false;
        const callback = (result) => {
          if (settled) return;
          settled = true;
          const lastError = getLastError();
          if (lastError) {
            reject(new Error(lastError.message || String(lastError)));
            return;
          }
          resolve(result);
        };
        try {
          storage[method](argument, callback);
        } catch (error) {
          settled = true;
          reject(error);
        }
      });
    }

    async function persistSet(values) {
      if (!Object.keys(values).length) return;
      await callStorage('set', values);
    }

    async function assertWritableSchemaVersion() {
      const items = await callStorage('get', [VERSION_KEY]);
      const storedVersion = Number(items?.[VERSION_KEY]);
      if (Number.isInteger(storedVersion) && storedVersion > SCHEMA_VERSION) {
        mutationGeneration += 1;
        futureVersion = true;
        applyValues(Object.fromEntries(SCHEMA.map((item) => [item.path, clone(item.defaultValue)])));
        throw new Error('Cannot update a newer settings schema');
      }
      return storedVersion;
    }

    async function getVersionWriteForMutation() {
      const storedVersion = await assertWritableSchemaVersion();
      return storedVersion === SCHEMA_VERSION ? {} : { [VERSION_KEY]: SCHEMA_VERSION };
    }

    function buildLegacyValue(entry, value) {
      return Array.isArray(value) ? value.slice() : value;
    }

    function beginMirror(path) {
      const generation = (mirrorGenerationByPath.get(path) || 0) + 1;
      mirrorGenerationByPath.set(path, generation);
      return { generation, mutationGeneration };
    }

    function mirrorIsCurrent(entry, value, operation) {
      return !destroyed &&
        !futureVersion &&
        operation.mutationGeneration === mutationGeneration &&
        operation.generation === mirrorGenerationByPath.get(entry.path) &&
        equal(readPath(snapshot, entry.path), value);
    }

    function mirrorChange(entry, value, changes) {
      if (!entry.legacyKey) return;
      const operation = beginMirror(entry.path);
      const hasSuppressedMigration = suppressLegacyMirrorByStorageKey.has(entry.storageKey);
      const suppressedMigrationValue = suppressLegacyMirrorByStorageKey.get(entry.storageKey);
      if (hasSuppressedMigration) {
        suppressLegacyMirrorByStorageKey.delete(entry.storageKey);
      }
      if (hasSuppressedMigration && equal(suppressedMigrationValue, value)) return;
      if (Object.prototype.hasOwnProperty.call(changes, entry.legacyKey)) return;
      const legacyValue = buildLegacyValue(entry, value);
      getVersionWriteForMutation().then((versionWrite) => {
        if (!mirrorIsCurrent(entry, value, operation)) return;
        return persistSet({ ...versionWrite, [entry.legacyKey]: legacyValue });
      }).catch((error) => {
        warn(`Failed to mirror ${entry.path} to its legacy key.`, error);
      });
    }

    function mirrorLegacyChange(entry, value, changes) {
      if (Object.prototype.hasOwnProperty.call(changes, entry.storageKey)) return;
      const operation = beginMirror(entry.path);
      getVersionWriteForMutation().then((versionWrite) => {
        if (!mirrorIsCurrent(entry, value, operation)) return;
        return persistSet({ ...versionWrite, [entry.storageKey]: clone(value) });
      }).catch((error) => {
        warn(`Failed to migrate live legacy change for ${entry.path}.`, error);
      });
    }

    function handleStorageChanged(changes, areaName) {
      if (destroyed || areaName !== 'local' || !changes || typeof changes !== 'object') return;
      if (resetInFlight) {
        resetBufferedChanges.push(changes);
        return;
      }
      const versionChange = changes[VERSION_KEY];
      if (versionChange) versionRevision += 1;
      if (versionChange && Number(versionChange.newValue) > SCHEMA_VERSION) {
        mutationGeneration += 1;
        futureVersion = true;
        applyValues(Object.fromEntries(SCHEMA.map((item) => [item.path, clone(item.defaultValue)])));
        return;
      }
      if (futureVersion && versionChange && Number(versionChange.newValue) <= SCHEMA_VERSION) {
        futureVersion = false;
      }
      if (futureVersion) return;

      const nextValues = {};
      const pathsChangedByEvent = new Set();
      for (const [key, change] of Object.entries(changes)) {
        const entry = ENTRY_BY_STORAGE_KEY.get(key);
        if (!entry) continue;
        const normalized = entry.normalize(change.newValue);
        const value = normalized.valid ? normalized.value : clone(entry.defaultValue);
        nextValues[entry.path] = value;
        pathsChangedByEvent.add(entry.path);
        mirrorChange(entry, value, changes);
      }
      for (const [key, change] of Object.entries(changes)) {
        const entry = ENTRY_BY_LEGACY_KEY.get(key);
        if (!entry || Object.prototype.hasOwnProperty.call(changes, entry.storageKey)) continue;
        const normalized = entry.normalize(change.newValue);
        if (!normalized.valid) continue;
        nextValues[entry.path] = normalized.value;
        pathsChangedByEvent.add(entry.path);
        mirrorLegacyChange(entry, normalized.value, changes);
      }
      for (const path of pathsChangedByEvent) {
        pathRevisions.set(path, (pathRevisions.get(path) || 0) + 1);
      }
      applyValues(nextValues);
    }

    function installListener() {
      if (changeListener || !storageChanges?.addListener) return;
      changeListener = handleStorageChanged;
      storageChanges.addListener(changeListener);
    }

    async function start() {
      if (destroyed) throw new Error('Settings store is destroyed');
      if (startPromise) return startPromise;
      startPromise = (async () => {
        installListener();
        const readPathRevisions = new Map(pathRevisions);
        const readVersionRevision = versionRevision;
        let items;
        try {
          items = await callStorage('get', SETTINGS_STORAGE_KEYS);
        } catch (error) {
          warn('Failed to load settings; using defaults.', error);
          throw error;
        }
        if (destroyed) return clone(snapshot);
        items = items && typeof items === 'object' ? items : {};
        if (Number(items[VERSION_KEY]) > SCHEMA_VERSION) {
          if (versionRevision !== readVersionRevision && !futureVersion) {
            items = { ...items, [VERSION_KEY]: SCHEMA_VERSION };
          } else {
            mutationGeneration += 1;
            futureVersion = true;
            snapshot = createDefaultSnapshot();
            started = true;
            return clone(snapshot);
          }
        }
        if (versionRevision !== readVersionRevision && futureVersion) {
          started = true;
          return clone(snapshot);
        }
        const loaded = {};
        const writes = {};
        const storedVersion = Number(items[VERSION_KEY]);
        if (!Number.isInteger(storedVersion) || storedVersion < SCHEMA_VERSION) {
          writes[VERSION_KEY] = SCHEMA_VERSION;
        }
        for (const entry of SCHEMA) {
          const hasCanonical = Object.prototype.hasOwnProperty.call(items, entry.storageKey);
          const canonical = entry.normalize(items[entry.storageKey]);
          const legacy = entry.legacyKey ? entry.normalize(items[entry.legacyKey]) : { valid: false };
          const value = pathRevisions.get(entry.path) !== readPathRevisions.get(entry.path)
            ? readPath(snapshot, entry.path)
            : (canonical.valid
                ? canonical.value
                : (!hasCanonical && legacy.valid ? legacy.value : clone(entry.defaultValue)));
          loaded[entry.path] = value;
          if (
            pathRevisions.get(entry.path) === readPathRevisions.get(entry.path) &&
            !hasCanonical &&
            legacy.valid
          ) {
            writes[entry.storageKey] = clone(legacy.value);
          }
        }
        if (Object.keys(writes).length) {
          let authoritativeVersion;
          let migrationEntries;
          try {
            migrationEntries = SCHEMA.filter((entry) => {
              return Object.prototype.hasOwnProperty.call(writes, entry.storageKey);
            });
            authoritativeVersion = await callStorage('get', [
              VERSION_KEY,
              ...migrationEntries.flatMap((entry) => [entry.storageKey, entry.legacyKey].filter(Boolean))
            ]);
            for (const entry of migrationEntries) {
              if (pathRevisions.get(entry.path) !== readPathRevisions.get(entry.path)) {
                loaded[entry.path] = clone(readPath(snapshot, entry.path));
                delete writes[entry.storageKey];
                continue;
              }
              if (Object.prototype.hasOwnProperty.call(authoritativeVersion || {}, entry.storageKey)) {
                const canonical = entry.normalize(authoritativeVersion[entry.storageKey]);
                loaded[entry.path] = canonical.valid ? canonical.value : clone(entry.defaultValue);
                delete writes[entry.storageKey];
                continue;
              }
              const legacy = entry.legacyKey
                ? entry.normalize(authoritativeVersion?.[entry.legacyKey])
                : { valid: false };
              if (legacy.valid) {
                loaded[entry.path] = legacy.value;
                writes[entry.storageKey] = clone(legacy.value);
              } else {
                loaded[entry.path] = clone(entry.defaultValue);
                delete writes[entry.storageKey];
              }
            }
          } catch (error) {
            warn('Failed to verify settings version before migration.', error);
            throw error;
          }
          if (Number(authoritativeVersion?.[VERSION_KEY]) > SCHEMA_VERSION) {
            mutationGeneration += 1;
            futureVersion = true;
            snapshot = createDefaultSnapshot();
            started = true;
            return clone(snapshot);
          }
          applyValues(loaded);
          try {
            for (const entry of SCHEMA) {
              if (Object.prototype.hasOwnProperty.call(writes, entry.storageKey)) {
                suppressLegacyMirrorByStorageKey.set(entry.storageKey, clone(writes[entry.storageKey]));
              }
            }
            await persistSet(writes);
          } catch (error) {
            suppressLegacyMirrorByStorageKey.clear();
            warn('Failed to persist migrated settings; using normalized in-memory values.', error);
          }
        } else {
          applyValues(loaded);
        }
        started = true;
        return clone(snapshot);
      })();
      startPromise = startPromise.catch((error) => {
        started = false;
        startPromise = null;
        throw error;
      });
      return startPromise;
    }

    function getSnapshot() {
      return clone(snapshot);
    }

    function get(path) {
      const entry = ENTRY_BY_PATH.get(path);
      if (!entry) throw new Error(`Unknown setting: ${path}`);
      return clone(readPath(snapshot, path));
    }

    async function update(valuesByPath) {
      if (destroyed) throw new Error('Settings store is destroyed');
      if (!started) await start();
      if (futureVersion) throw new Error('Cannot update a newer settings schema');
      if (!valuesByPath || typeof valuesByPath !== 'object' || Array.isArray(valuesByPath)) {
        throw new TypeError('Settings update must be an object');
      }
      const normalizedValues = {};
      const writes = {};
      const operation = ++operationSequence;
      const operationMutationGeneration = mutationGeneration;
      const paths = Object.keys(valuesByPath);
      if (!paths.length) return getSnapshot();
      for (const path of paths) {
        const entry = ENTRY_BY_PATH.get(path);
        if (!entry) throw new Error(`Unknown setting: ${path}`);
        const normalized = entry.normalize(valuesByPath[path]);
        if (!normalized.valid) throw new TypeError(`Invalid setting value: ${path}`);
        normalizedValues[path] = normalized.value;
        writes[entry.storageKey] = clone(normalized.value);
        if (entry.legacyKey) writes[entry.legacyKey] = buildLegacyValue(entry, normalized.value);
        latestOperationByPath.set(path, operation);
        mirrorGenerationByPath.set(path, (mirrorGenerationByPath.get(path) || 0) + 1);
      }
      const revisionsBeforeWrite = new Map(paths.map((path) => [path, pathRevisions.get(path) || 0]));
      const versionWrite = await getVersionWriteForMutation();
      if (destroyed || operationMutationGeneration !== mutationGeneration) return getSnapshot();
      let activePathCount = 0;
      for (const path of paths) {
        if (latestOperationByPath.get(path) === operation) {
          activePathCount += 1;
          continue;
        }
        const entry = ENTRY_BY_PATH.get(path);
        delete writes[entry.storageKey];
        if (entry.legacyKey) delete writes[entry.legacyKey];
      }
      if (!activePathCount) return getSnapshot();
      Object.assign(writes, versionWrite);
      await persistSet(writes);
      if (destroyed) return getSnapshot();
      const currentOperationValues = {};
      for (const path of paths) {
        if (
          latestOperationByPath.get(path) === operation &&
          (pathRevisions.get(path) || 0) === revisionsBeforeWrite.get(path)
        ) {
          currentOperationValues[path] = normalizedValues[path];
        }
      }
      applyValues(currentOperationValues);
      return getSnapshot();
    }

    async function reset() {
      if (destroyed) throw new Error('Settings store is destroyed');
      if (!started) await start();
      if (futureVersion) throw new Error('Cannot reset a newer settings schema');
      await assertWritableSchemaVersion();
      mutationGeneration += 1;
      resetInFlight = true;
      resetBufferedChanges = [];
      let removed = false;
      let resetError = null;
      try {
        await callStorage('remove', SETTINGS_STORAGE_KEYS);
        removed = true;
      } catch (error) {
        resetError = error;
      } finally {
        resetInFlight = false;
      }
      if (removed) {
        applyValues(Object.fromEntries(SCHEMA.map((item) => [item.path, clone(item.defaultValue)])));
      }
      const buffered = resetBufferedChanges;
      resetBufferedChanges = [];
      for (const changes of buffered) handleStorageChanged(changes, 'local');
      if (resetError) throw resetError;
      return getSnapshot();
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Settings subscriber must be a function');
      if (destroyed) return () => {};
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    }

    function destroy() {
      if (destroyed) return;
      mutationGeneration += 1;
      destroyed = true;
      subscribers.clear();
      if (changeListener) storageChanges?.removeListener?.(changeListener);
      changeListener = null;
    }

    return { start, getSnapshot, get, update, reset, subscribe, destroy };
  }

  globalThis.BosunHelperSettings = Object.freeze({
    SCHEMA_VERSION,
    VERSION_KEY,
    STORAGE_PREFIX,
    DEFAULTS,
    SCHEMA,
    SETTINGS_STORAGE_KEYS,
    MAX_TEMPLATES_PER_TYPE,
    MAX_TEMPLATE_LENGTH,
    MAX_TOTAL_TEMPLATE_TEXT_LENGTH,
    createSettingsStore
  });
})();
