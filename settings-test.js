'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createStorageHarness(initial = {}) {
  const data = { ...initial };
  const setCalls = [];
  const removeCalls = [];
  const listeners = new Set();
  const onChanged = {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); }
  };
  const emit = (changes) => {
    for (const listener of Array.from(listeners)) listener(changes, 'local');
  };
  const storage = {
    get(keys, callback) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : Object.keys(data)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
      }
      queueMicrotask(() => callback(result));
    },
    set(values, callback = () => {}) {
      setCalls.push({ ...values });
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        const oldValue = data[key];
        data[key] = value;
        if (!Object.is(oldValue, value)) changes[key] = { oldValue, newValue: value };
      }
      queueMicrotask(() => {
        if (Object.keys(changes).length) emit(changes);
        callback();
      });
    },
    remove(keys, callback = () => {}) {
      removeCalls.push(Array.isArray(keys) ? keys.slice() : [keys]);
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        changes[key] = { oldValue: data[key], newValue: undefined };
        delete data[key];
      }
      queueMicrotask(() => {
        if (Object.keys(changes).length) emit(changes);
        callback();
      });
    }
  };
  return { data, storage, onChanged, emit, setCalls, removeCalls };
}

function loadApi() {
  const context = { console, structuredClone, queueMicrotask, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8'),
    context,
    { filename: 'settings.js' }
  );
  return context.BosunHelperSettings;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const api = loadApi();
  assert.strictEqual(api.SCHEMA_VERSION, 1);
  assert.strictEqual(api.VERSION_KEY, 'bosunSettingsSchemaVersion');

  const defaultsHarness = createStorageHarness();
  const defaultsStore = api.createSettingsStore({
    storage: defaultsHarness.storage,
    storageChanges: defaultsHarness.onChanged,
    getLastError: () => null
  });
  await defaultsStore.start();
  assert.deepStrictEqual(plain(defaultsStore.getSnapshot()), plain(api.DEFAULTS));
  assert.strictEqual(defaultsStore.get('features.grafanaIntegration'), true);
  assert.strictEqual(defaultsStore.get('preferences.autoRefreshIdleSeconds'), 60);
  assert.throws(() => defaultsStore.get('unknown.path'), /Unknown setting/);
  const immutable = defaultsStore.getSnapshot();
  immutable.features.copyButtons = false;
  assert.strictEqual(defaultsStore.get('features.copyButtons'), true);
  assert.deepStrictEqual(defaultsHarness.setCalls, [{ [api.VERSION_KEY]: 1 }], 'fresh start must not materialize every default leaf');

  const legacy = {
    bosunShowSilenced: true,
    bosunAutoRefreshEnabled: false,
    bosunAutoRefreshIdleSeconds: 9.6,
    bosunNoUserCommentFilterEnabled: true,
    bosunAcknowledgedCollapseEnabled: true,
    bosunSoundAlertsEnabled: false,
    bosunDiagnosticsEnabled: true,
    'bosunActionTemplatesV1:note': [],
    'bosunActionTemplatesV1:ack': [' first ', 'first', 9, 'second'],
    'bosunActionTemplatesV1:close': ['done']
  };
  const migrationHarness = createStorageHarness(legacy);
  const migrationStore = api.createSettingsStore({
    storage: migrationHarness.storage,
    storageChanges: migrationHarness.onChanged,
    getLastError: () => null
  });
  await migrationStore.start();
  const migrated = plain(migrationStore.getSnapshot());
  assert.strictEqual(migrated.preferences.showSilenced, true);
  assert.strictEqual(migrated.preferences.autoRefreshEnabled, false);
  assert.strictEqual(migrated.preferences.autoRefreshIdleSeconds, 10);
  assert.strictEqual(migrated.preferences.noCommentFilterActive, true);
  assert.strictEqual(migrated.preferences.acknowledgedCollapsed, true);
  assert.strictEqual(migrated.preferences.soundEnabled, false);
  assert.strictEqual(migrated.internal.diagnosticsEnabled, true);
  assert.deepStrictEqual(migrated.actionTemplates.note, []);
  assert.deepStrictEqual(migrated.actionTemplates.ack, ['first', 'second']);
  assert.deepStrictEqual(migrated.actionTemplates.close, ['done']);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.strictEqual(migrationHarness.data[api.VERSION_KEY], 1);
  const migratedCanonicalKeys = Object.keys(migrationHarness.setCalls.at(-1) || {}).filter((key) => key.startsWith(api.STORAGE_PREFIX));
  assert.deepStrictEqual(
    migratedCanonicalKeys.sort(),
    Array.from(api.SCHEMA).filter((entry) => entry.legacyKey).map((entry) => entry.storageKey).sort(),
    'startup migration must write only canonical leaves backed by valid legacy data'
  );
  assert.strictEqual(
    migrationHarness.setCalls.some((call) => Object.keys(call).some((key) => key.startsWith('bosunActionTemplatesV1:'))),
    false,
    'startup migration must not rewrite authoritative legacy leaves'
  );

  const sameValueMigrationHarness = createStorageHarness({ bosunShowSilenced: true });
  const sameValueCanonicalKey = 'bosunSettingsV1:preferences.showSilenced';
  const originalSameValueSet = sameValueMigrationHarness.storage.set.bind(sameValueMigrationHarness.storage);
  let injectedConcurrentCanonical = false;
  sameValueMigrationHarness.storage.set = (values, callback) => {
    if (!injectedConcurrentCanonical && Object.prototype.hasOwnProperty.call(values, sameValueCanonicalKey)) {
      injectedConcurrentCanonical = true;
      sameValueMigrationHarness.data[sameValueCanonicalKey] = true;
    }
    originalSameValueSet(values, callback);
  };
  const sameValueMigrationStore = api.createSettingsStore({
    storage: sameValueMigrationHarness.storage,
    storageChanges: sameValueMigrationHarness.onChanged,
    getLastError: () => null
  });
  await sameValueMigrationStore.start();
  await new Promise((resolve) => sameValueMigrationHarness.storage.set({ [sameValueCanonicalKey]: false }, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sameValueMigrationHarness.data.bosunShowSilenced, false);
  await new Promise((resolve) => sameValueMigrationHarness.storage.set({ [sameValueCanonicalKey]: true }, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    sameValueMigrationHarness.data.bosunShowSilenced,
    true,
    'a same-value concurrent migration must not leave stale legacy-mirror suppression'
  );

  const staleMigrationHarness = createStorageHarness({ bosunShowSilenced: true });
  const originalStaleMigrationGet = staleMigrationHarness.storage.get.bind(staleMigrationHarness.storage);
  let staleMigrationGetCount = 0;
  staleMigrationHarness.storage.get = (keys, callback) => {
    staleMigrationGetCount += 1;
    if (staleMigrationGetCount === 2) {
      staleMigrationHarness.data[sameValueCanonicalKey] = false;
      staleMigrationHarness.data.bosunShowSilenced = false;
    }
    originalStaleMigrationGet(keys, callback);
  };
  const staleMigrationStore = api.createSettingsStore({
    storage: staleMigrationHarness.storage,
    storageChanges: staleMigrationHarness.onChanged,
    getLastError: () => null
  });
  await staleMigrationStore.start();
  assert.strictEqual(
    staleMigrationHarness.data[sameValueCanonicalKey],
    false,
    'startup migration must not overwrite a canonical leaf committed after the initial read'
  );
  assert.strictEqual(
    staleMigrationHarness.setCalls.some((call) => Object.prototype.hasOwnProperty.call(call, sameValueCanonicalKey)),
    false,
    'a concurrently created canonical leaf must be removed from the pending migration write'
  );
  assert.strictEqual(
    staleMigrationStore.get('preferences.showSilenced'),
    false,
    'start must expose the canonical leaf found by its authoritative reread'
  );
  staleMigrationHarness.emit({
    [sameValueCanonicalKey]: { oldValue: undefined, newValue: false },
    bosunShowSilenced: { oldValue: true, newValue: false }
  });
  assert.strictEqual(staleMigrationStore.get('preferences.showSilenced'), false);

  const refreshedLegacyHarness = createStorageHarness({ bosunShowSilenced: true });
  const originalRefreshedLegacyGet = refreshedLegacyHarness.storage.get.bind(refreshedLegacyHarness.storage);
  let refreshedLegacyGetCount = 0;
  refreshedLegacyHarness.storage.get = (keys, callback) => {
    refreshedLegacyGetCount += 1;
    if (refreshedLegacyGetCount === 2) refreshedLegacyHarness.data.bosunShowSilenced = false;
    originalRefreshedLegacyGet(keys, callback);
  };
  const refreshedLegacyStore = api.createSettingsStore({
    storage: refreshedLegacyHarness.storage,
    storageChanges: refreshedLegacyHarness.onChanged,
    getLastError: () => null
  });
  await refreshedLegacyStore.start();
  assert.strictEqual(
    refreshedLegacyHarness.data[sameValueCanonicalKey],
    false,
    'startup migration must use the latest authoritative legacy leaf'
  );
  assert.strictEqual(
    refreshedLegacyStore.get('preferences.showSilenced'),
    false,
    'startup snapshot must use the latest authoritative legacy leaf'
  );

  const authoritativeHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    'bosunSettingsV1:features.copyButtons': false,
    'bosunSettingsV1:preferences.showSilenced': true,
    bosunShowSilenced: true
  });
  const authoritativeStore = api.createSettingsStore({
    storage: authoritativeHarness.storage,
    storageChanges: authoritativeHarness.onChanged,
    getLastError: () => null
  });
  await authoritativeStore.start();
  assert.deepStrictEqual(authoritativeHarness.setCalls, [], 'valid canonical/version storage must not be rewritten on start');

  const damagedHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    'bosunSettingsV1:features.copyButtons': 'yes',
    'bosunSettingsV1:preferences.showSilenced': true,
    'bosunSettingsV1:preferences.autoRefreshIdleSeconds': 'broken',
    'bosunSettingsV1:actionTemplates.note': { nope: true }
  });
  const damagedStore = api.createSettingsStore({
    storage: damagedHarness.storage,
    storageChanges: damagedHarness.onChanged,
    getLastError: () => null
  });
  await damagedStore.start();
  assert.strictEqual(damagedStore.get('features.copyButtons'), true);
  assert.strictEqual(damagedStore.get('preferences.showSilenced'), true);
  assert.strictEqual(damagedStore.get('preferences.autoRefreshIdleSeconds'), 60);
  assert.strictEqual(damagedStore.get('actionTemplates.note'), null);
  for (const invalidIdle of [null, true, false, [], [30], {}, '   ', '30seconds']) {
    await assert.rejects(
      damagedStore.update({ 'preferences.autoRefreshIdleSeconds': invalidIdle }),
      /Invalid setting value/
    );
  }
  await damagedStore.update({ 'preferences.autoRefreshIdleSeconds': ' 30.4 ' });
  assert.strictEqual(damagedStore.get('preferences.autoRefreshIdleSeconds'), 30);

  const delayedHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    'bosunSettingsV1:preferences.showSilenced': true
  });
  let releaseDelayedGet = null;
  delayedHarness.storage.get = (keys, callback) => {
    const captured = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(delayedHarness.data, key)) captured[key] = delayedHarness.data[key];
    }
    releaseDelayedGet = () => callback(captured);
  };
  const delayedStore = api.createSettingsStore({
    storage: delayedHarness.storage,
    storageChanges: delayedHarness.onChanged,
    getLastError: () => null
  });
  const delayedStart = delayedStore.start();
  await new Promise((resolve) => delayedHarness.storage.set({
    'bosunSettingsV1:features.copyButtons': false
  }, resolve));
  releaseDelayedGet();
  await delayedStart;
  assert.strictEqual(delayedStore.get('features.copyButtons'), false, 'stale initial get rolled back a live leaf');
  assert.strictEqual(delayedStore.get('preferences.showSilenced'), true, 'live leaf caused an unrelated persisted leaf to be lost');

  const futureRaceHarness = createStorageHarness({ [api.VERSION_KEY]: 1 });
  let releaseFutureRaceGet = null;
  futureRaceHarness.storage.get = (keys, callback) => {
    const captured = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(futureRaceHarness.data, key)) captured[key] = futureRaceHarness.data[key];
    }
    releaseFutureRaceGet = () => callback(captured);
  };
  const futureRaceStore = api.createSettingsStore({
    storage: futureRaceHarness.storage,
    storageChanges: futureRaceHarness.onChanged,
    getLastError: () => null
  });
  const futureRaceStart = futureRaceStore.start();
  await new Promise((resolve) => futureRaceHarness.storage.set({
    [api.VERSION_KEY]: 99,
    'bosunSettingsV99:futureOnly': 'preserve-me'
  }, resolve));
  releaseFutureRaceGet();
  await futureRaceStart;
  assert.deepStrictEqual(plain(futureRaceStore.getSnapshot()), plain(api.DEFAULTS));
  assert.strictEqual(futureRaceHarness.data[api.VERSION_KEY], 99, 'stale initial get overwrote a future schema');
  assert.strictEqual(futureRaceHarness.data['bosunSettingsV99:futureOnly'], 'preserve-me');

  const delayedFutureDelivery = createStorageHarness({
    [api.VERSION_KEY]: 1,
    bosunShowSilenced: true
  });
  let releaseDelayedFutureGet = null;
  const originalDelayedFutureGet = delayedFutureDelivery.storage.get.bind(delayedFutureDelivery.storage);
  let delayedFutureReadCount = 0;
  delayedFutureDelivery.storage.get = (keys, callback) => {
    delayedFutureReadCount += 1;
    if (delayedFutureReadCount > 1) {
      originalDelayedFutureGet(keys, callback);
      return;
    }
    const captured = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(delayedFutureDelivery.data, key)) captured[key] = delayedFutureDelivery.data[key];
    }
    releaseDelayedFutureGet = () => callback(captured);
  };
  const delayedFutureStore = api.createSettingsStore({
    storage: delayedFutureDelivery.storage,
    storageChanges: delayedFutureDelivery.onChanged,
    getLastError: () => null
  });
  const delayedFutureStart = delayedFutureStore.start();
  delayedFutureDelivery.data[api.VERSION_KEY] = 99;
  delayedFutureDelivery.data['bosunSettingsV99:futureOnly'] = 'authoritative';
  releaseDelayedFutureGet();
  await delayedFutureStart;
  assert.strictEqual(delayedFutureDelivery.data[api.VERSION_KEY], 99, 'migration downgraded future version before delayed onChanged');
  assert.strictEqual(
    delayedFutureDelivery.setCalls.some((call) => call[api.VERSION_KEY] === 1),
    false,
    'migration wrote schema v1 after authoritative future version appeared'
  );

  const inverseFutureHarness = createStorageHarness({ [api.VERSION_KEY]: 99 });
  let releaseInverseFutureGet = null;
  const originalInverseFutureGet = inverseFutureHarness.storage.get.bind(inverseFutureHarness.storage);
  let inverseFutureGetCount = 0;
  inverseFutureHarness.storage.get = (keys, callback) => {
    inverseFutureGetCount += 1;
    if (inverseFutureGetCount > 1) {
      originalInverseFutureGet(keys, callback);
      return;
    }
    const captured = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(inverseFutureHarness.data, key)) captured[key] = inverseFutureHarness.data[key];
    }
    releaseInverseFutureGet = () => callback(captured);
  };
  const inverseFutureStore = api.createSettingsStore({
    storage: inverseFutureHarness.storage,
    storageChanges: inverseFutureHarness.onChanged,
    getLastError: () => null
  });
  const inverseFutureStart = inverseFutureStore.start();
  await new Promise((resolve) => inverseFutureHarness.storage.set({
    [api.VERSION_KEY]: 1,
    'bosunSettingsV1:features.copyButtons': false
  }, resolve));
  releaseInverseFutureGet();
  await inverseFutureStart;
  assert.strictEqual(inverseFutureStore.get('features.copyButtons'), false, 'stale future get overrode newer supported schema');
  await inverseFutureStore.update({ 'features.copyButtons': true });

  const delayedFutureUpdateHarness = createStorageHarness({ [api.VERSION_KEY]: 1 });
  const delayedFutureUpdateStore = api.createSettingsStore({
    storage: delayedFutureUpdateHarness.storage,
    storageChanges: delayedFutureUpdateHarness.onChanged,
    getLastError: () => null
  });
  await delayedFutureUpdateStore.start();
  delayedFutureUpdateHarness.data[api.VERSION_KEY] = 99;
  const delayedFutureUpdateCalls = delayedFutureUpdateHarness.setCalls.length;
  await assert.rejects(
    delayedFutureUpdateStore.update({ 'features.copyButtons': false }),
    /newer settings schema/
  );
  assert.strictEqual(delayedFutureUpdateHarness.data[api.VERSION_KEY], 99);
  assert.strictEqual(
    delayedFutureUpdateHarness.setCalls.length,
    delayedFutureUpdateCalls,
    'update must not write after an authoritative future schema appears'
  );

  const delayedFutureResetHarness = createStorageHarness({ [api.VERSION_KEY]: 1 });
  const delayedFutureResetStore = api.createSettingsStore({
    storage: delayedFutureResetHarness.storage,
    storageChanges: delayedFutureResetHarness.onChanged,
    getLastError: () => null
  });
  await delayedFutureResetStore.start();
  delayedFutureResetHarness.data[api.VERSION_KEY] = 99;
  await assert.rejects(delayedFutureResetStore.reset(), /newer settings schema/);
  assert.strictEqual(delayedFutureResetHarness.data[api.VERSION_KEY], 99, 'reset removed a delayed future schema');
  assert.deepStrictEqual(delayedFutureResetHarness.removeCalls, []);

  const delayedFutureMirrorWarnings = [];
  const delayedFutureMirrorHarness = createStorageHarness({ [api.VERSION_KEY]: 1 });
  const delayedFutureMirrorStore = api.createSettingsStore({
    storage: delayedFutureMirrorHarness.storage,
    storageChanges: delayedFutureMirrorHarness.onChanged,
    getLastError: () => null,
    warn(message) { delayedFutureMirrorWarnings.push(message); }
  });
  await delayedFutureMirrorStore.start();
  delayedFutureMirrorHarness.data[api.VERSION_KEY] = 99;
  const delayedFutureMirrorCalls = delayedFutureMirrorHarness.setCalls.length;
  delayedFutureMirrorHarness.emit({ bosunSoundAlertsEnabled: { oldValue: true, newValue: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(delayedFutureMirrorHarness.data[api.VERSION_KEY], 99);
  assert.strictEqual(
    delayedFutureMirrorHarness.setCalls.length,
    delayedFutureMirrorCalls,
    'live legacy mirroring must not write into a delayed future schema'
  );
  assert.strictEqual(delayedFutureMirrorStore.get('preferences.soundEnabled'), true);
  assert.ok(delayedFutureMirrorWarnings.some((message) => /live legacy change/.test(message)));

  const reorderedUpdateHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    'bosunSettingsV1:features.copyButtons': true
  });
  const reorderedUpdateStore = api.createSettingsStore({
    storage: reorderedUpdateHarness.storage,
    storageChanges: reorderedUpdateHarness.onChanged,
    getLastError: () => null
  });
  await reorderedUpdateStore.start();
  const reorderedUpdateReads = [];
  reorderedUpdateHarness.storage.get = (keys, callback) => reorderedUpdateReads.push({ keys, callback });
  const olderUpdate = reorderedUpdateStore.update({ 'features.copyButtons': false });
  const newerUpdate = reorderedUpdateStore.update({ 'features.copyButtons': true });
  assert.strictEqual(reorderedUpdateReads.length, 2);
  reorderedUpdateReads[1].callback({ [api.VERSION_KEY]: 1 });
  await newerUpdate;
  reorderedUpdateReads[0].callback({ [api.VERSION_KEY]: 1 });
  await olderUpdate;
  assert.strictEqual(
    reorderedUpdateHarness.data['bosunSettingsV1:features.copyButtons'],
    true,
    'an older same-path update must not persist after a newer update'
  );
  assert.strictEqual(reorderedUpdateStore.get('features.copyButtons'), true);

  const reorderedMirrorHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    [sameValueCanonicalKey]: true,
    bosunShowSilenced: true
  });
  const reorderedMirrorStore = api.createSettingsStore({
    storage: reorderedMirrorHarness.storage,
    storageChanges: reorderedMirrorHarness.onChanged,
    getLastError: () => null
  });
  await reorderedMirrorStore.start();
  const reorderedMirrorReads = [];
  reorderedMirrorHarness.storage.get = (keys, callback) => reorderedMirrorReads.push({ keys, callback });
  reorderedMirrorHarness.data.bosunShowSilenced = false;
  reorderedMirrorHarness.emit({ bosunShowSilenced: { oldValue: true, newValue: false } });
  reorderedMirrorHarness.data.bosunShowSilenced = true;
  reorderedMirrorHarness.emit({ bosunShowSilenced: { oldValue: false, newValue: true } });
  assert.strictEqual(reorderedMirrorReads.length, 2);
  reorderedMirrorReads[1].callback({ [api.VERSION_KEY]: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  reorderedMirrorReads[0].callback({ [api.VERSION_KEY]: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(reorderedMirrorHarness.data[sameValueCanonicalKey], true);
  assert.strictEqual(reorderedMirrorHarness.data.bosunShowSilenced, true);
  assert.strictEqual(reorderedMirrorStore.get('preferences.showSilenced'), true);

  const resetInvalidatesMirrorHarness = createStorageHarness({
    [api.VERSION_KEY]: 1,
    [sameValueCanonicalKey]: false,
    bosunShowSilenced: false
  });
  const resetInvalidatesMirrorStore = api.createSettingsStore({
    storage: resetInvalidatesMirrorHarness.storage,
    storageChanges: resetInvalidatesMirrorHarness.onChanged,
    getLastError: () => null
  });
  await resetInvalidatesMirrorStore.start();
  const resetInvalidatesMirrorReads = [];
  resetInvalidatesMirrorHarness.storage.get = (keys, callback) => resetInvalidatesMirrorReads.push({ keys, callback });
  resetInvalidatesMirrorHarness.data[sameValueCanonicalKey] = true;
  resetInvalidatesMirrorHarness.emit({
    [sameValueCanonicalKey]: { oldValue: false, newValue: true }
  });
  const resetAfterMirror = resetInvalidatesMirrorStore.reset();
  assert.strictEqual(resetInvalidatesMirrorReads.length, 2);
  resetInvalidatesMirrorReads[1].callback({ [api.VERSION_KEY]: 1 });
  await resetAfterMirror;
  resetInvalidatesMirrorReads[0].callback({ [api.VERSION_KEY]: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resetInvalidatesMirrorHarness.data, api.VERSION_KEY), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resetInvalidatesMirrorHarness.data, sameValueCanonicalKey), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resetInvalidatesMirrorHarness.data, 'bosunShowSilenced'), false);

  const retryHarness = createStorageHarness({ bosunShowSilenced: true });
  let failNextGet = true;
  let retryLastError = null;
  retryHarness.storage.get = (keys, callback) => {
    const result = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(retryHarness.data, key)) result[key] = retryHarness.data[key];
    }
    queueMicrotask(() => {
      if (failNextGet) retryLastError = { message: 'synthetic settings get failure' };
      callback(result);
      retryLastError = null;
      failNextGet = false;
    });
  };
  const retryStore = api.createSettingsStore({
    storage: retryHarness.storage,
    storageChanges: retryHarness.onChanged,
    getLastError: () => retryLastError
  });
  await assert.rejects(retryStore.start(), /synthetic settings get failure/);
  await retryStore.start();
  assert.strictEqual(retryStore.get('preferences.showSilenced'), true, 'store did not recover after transient get failure');

  const unavailableWarnings = [];
  const unavailableStore = api.createSettingsStore({
    storage: null,
    storageChanges: null,
    warn(message) { unavailableWarnings.push(message); }
  });
  assert.deepStrictEqual(plain(unavailableStore.getSnapshot()), plain(api.DEFAULTS));
  await assert.rejects(unavailableStore.start(), /storage\.local\.get is unavailable/);
  await assert.rejects(unavailableStore.start(), /storage\.local\.get is unavailable/);
  assert.ok(unavailableWarnings.length >= 2, 'unavailable storage retries must remain observable');

  const futureHarness = createStorageHarness({
    [api.VERSION_KEY]: 99,
    'bosunSettingsV1:features.copyButtons': false,
    bosunShowSilenced: true
  });
  const futureStore = api.createSettingsStore({
    storage: futureHarness.storage,
    storageChanges: futureHarness.onChanged,
    getLastError: () => null
  });
  await futureStore.start();
  assert.deepStrictEqual(plain(futureStore.getSnapshot()), plain(api.DEFAULTS));
  await assert.rejects(
    futureStore.update({ 'features.copyButtons': false }),
    /newer settings schema/
  );
  assert.strictEqual(futureHarness.data['bosunSettingsV1:features.copyButtons'], false);

  const shared = createStorageHarness({ operationalRecord: { untouched: true } });
  const storeA = api.createSettingsStore({ storage: shared.storage, storageChanges: shared.onChanged, getLastError: () => null });
  const storeB = api.createSettingsStore({ storage: shared.storage, storageChanges: shared.onChanged, getLastError: () => null });
  await Promise.all([storeA.start(), storeB.start()]);
  const eventsB = [];
  const unsubscribe = storeB.subscribe((next, previous, paths) => eventsB.push(paths.slice()));
  await storeA.update({
    'features.copyButtons': false,
    'preferences.autoRefreshIdleSeconds': 88.6
  });
  assert.strictEqual(storeA.get('features.copyButtons'), false);
  assert.strictEqual(storeB.get('features.copyButtons'), false);
  assert.strictEqual(storeB.get('preferences.autoRefreshIdleSeconds'), 89);
  assert.strictEqual(shared.data.bosunAutoRefreshIdleSeconds, 89, 'canonical updates dual-write legacy keys');
  assert.ok(eventsB.some((paths) => paths.includes('features.copyButtons')));

  await new Promise((resolve) => shared.storage.set({ bosunSoundAlertsEnabled: false }, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(storeA.get('preferences.soundEnabled'), false, 'legacy-only old-tab write migrates live');
  assert.strictEqual(storeB.get('preferences.soundEnabled'), false);
  assert.strictEqual(shared.data['bosunSettingsV1:preferences.soundEnabled'], false);

  await storeA.reset();
  assert.deepStrictEqual(plain(storeA.getSnapshot()), plain(api.DEFAULTS));
  assert.deepStrictEqual(plain(storeB.getSnapshot()), plain(api.DEFAULTS));
  assert.deepStrictEqual(shared.data.operationalRecord, { untouched: true });
  for (const key of api.SETTINGS_STORAGE_KEYS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(shared.data, key), false, `reset leaked ${key}`);
  }

  const resetRace = createStorageHarness();
  const resetRaceA = api.createSettingsStore({ storage: resetRace.storage, storageChanges: resetRace.onChanged, getLastError: () => null });
  const resetRaceB = api.createSettingsStore({ storage: resetRace.storage, storageChanges: resetRace.onChanged, getLastError: () => null });
  await Promise.all([resetRaceA.start(), resetRaceB.start()]);
  let finishResetRemove = null;
  resetRace.storage.remove = (keys, callback = () => {}) => {
    const changes = {};
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(resetRace.data, key)) continue;
      changes[key] = { oldValue: resetRace.data[key], newValue: undefined };
      delete resetRace.data[key];
    }
    queueMicrotask(() => {
      if (Object.keys(changes).length) resetRace.emit(changes);
      finishResetRemove = callback;
    });
  };
  const pendingReset = resetRaceA.reset();
  while (!finishResetRemove) await Promise.resolve();
  await resetRaceB.update({ 'features.copyButtons': false });
  finishResetRemove();
  await pendingReset;
  assert.strictEqual(resetRaceA.get('features.copyButtons'), false, 'reset dropped a later committed onChanged update');
  assert.strictEqual(resetRaceB.get('features.copyButtons'), false, 'tabs diverged after reset/update race');

  unsubscribe();
  const eventCount = eventsB.length;
  await storeA.update({ 'features.copyButtons': false });
  assert.strictEqual(eventsB.length, eventCount);
  storeA.destroy();
  storeB.destroy();
  storeA.destroy();

  console.log('Settings tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
