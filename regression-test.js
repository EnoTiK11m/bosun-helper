'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = __dirname;

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function createFakeClock(startAt = 1_000_000) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flushMicrotasks();
      }
      now = target;
      await flushMicrotasks();
    },
    get timerCount() { return timers.size; }
  };
}

function createSharedCoordination(clock) {
  const data = {};
  const channels = new Map();
  const storageListeners = new Set();
  return {
    storage: {
      get(keys, callback) {
        const result = {};
        for (const key of keys || []) result[key] = data[key];
        callback(result);
      },
      set(values, callback) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: value };
          data[key] = value;
        }
        callback?.();
        clock.setTimeout(() => {
          for (const listener of storageListeners) listener(changes, 'local');
        }, 0);
      },
      remove(keys, callback) {
        for (const key of keys || []) delete data[key];
        callback?.();
      }
    },
    storageChanges: {
      addListener(listener) { storageListeners.add(listener); },
      removeListener(listener) { storageListeners.delete(listener); }
    },
    BroadcastChannel: class BroadcastChannel {
      constructor(name) {
        this.name = name;
        this.listeners = new Set();
        this.closed = false;
        const peers = channels.get(name) || new Set();
        peers.add(this);
        channels.set(name, peers);
      }
      addEventListener(name, listener) {
        if (name === 'message') this.listeners.add(listener);
      }
      removeEventListener(name, listener) {
        if (name === 'message') this.listeners.delete(listener);
      }
      postMessage(data) {
        for (const peer of channels.get(this.name) || []) {
          if (peer !== this && !peer.closed) {
            clock.setTimeout(() => {
              for (const listener of peer.listeners) listener({ data });
            }, 0);
          }
        }
      }
      close() {
        this.closed = true;
        channels.get(this.name)?.delete(this);
        this.listeners.clear();
      }
    },
    get openChannelCount() {
      return Array.from(channels.values()).reduce((sum, peers) => sum + peers.size, 0);
    }
  };
}

function createCoordinatorTab(name, clock, shared, options = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const applied = [];
  let fetchCount = 0;
  let uuidCount = 0;

  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(event, listener) { documentListeners.set(event, listener); },
    removeEventListener(event, listener) {
      if (documentListeners.get(event) === listener) documentListeners.delete(event);
    }
  };
  const context = {
    console,
    globalThis: null,
    window: null,
    document,
    location: { origin: 'https://bosun.example.test' },
    chrome: {
      runtime: { lastError: null },
      storage: { local: shared.storage, onChanged: shared.storageChanges }
    },
    crypto: { randomUUID: () => `${name}-uuid-${++uuidCount}` },
    BroadcastChannel: shared.BroadcastChannel,
    Date: FakeDate,
    Math,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON,
    AbortController,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    addEventListener(event, listener) { windowListeners.set(event, listener); },
    removeEventListener(event, listener) {
      if (windowListeners.get(event) === listener) windowListeners.delete(event);
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'refresh-coordinator.js'), 'utf8'), context, {
    filename: 'refresh-coordinator.js'
  });
  const coordinator = context.BosunHelperRefreshCoordinator.createRefreshCoordinator({
    async fetchSnapshot(fetchOptions) {
      fetchCount += 1;
      if (typeof options.fetchSnapshot === 'function') {
        return options.fetchSnapshot(fetchOptions, fetchCount);
      }
      return { owner: name, fetchCount };
    },
    applySnapshot(payload, metadata) { applied.push({ payload, metadata }); },
    visiblePollMs: 100,
    hiddenPollMs: 500,
    leaseMs: 240,
    heartbeatMs: 40,
    storageKeyPrefix: 'test-coordinator'
  });
  return {
    coordinator,
    applied,
    document,
    documentListeners,
    windowListeners,
    setVisibility(value) {
      document.visibilityState = value;
      documentListeners.get('visibilitychange')?.();
    },
    get fetchCount() { return fetchCount; }
  };
}

async function testHiddenFollowerDefersSnapshotsUntilVisible() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const leader = createCoordinatorTab('visible-leader', clock, shared);
  const follower = createCoordinatorTab('hidden-follower', clock, shared);
  follower.document.visibilityState = 'hidden';

  leader.coordinator.start();
  await clock.advance(0);
  follower.coordinator.start();
  await clock.advance(0);
  await clock.advance(220);

  assert.strictEqual(leader.coordinator.getRole(), 'leader');
  assert.strictEqual(follower.coordinator.getRole(), 'follower');
  assert.strictEqual(follower.applied.length, 0, 'Hidden follower must not apply snapshots');

  follower.setVisibility('visible');
  await flushMicrotasks();
  assert.strictEqual(follower.applied.length, 1, 'Visible follower must apply only the latest buffered snapshot');
  assert.strictEqual(follower.applied[0].metadata.reason, 'visibility-buffer');

  await clock.advance(0);
  leader.coordinator.stop();
  follower.coordinator.stop();
}

async function testHiddenFollowerRejectsSnapshotFromExpiredLeader() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const leader = createCoordinatorTab('stale-leader', clock, shared);
  const follower = createCoordinatorTab('stale-follower', clock, shared);
  follower.document.visibilityState = 'hidden';
  leader.coordinator.start();
  await clock.advance(0);
  follower.coordinator.start();
  await clock.advance(0);
  await clock.advance(120);
  assert.strictEqual(follower.applied.length, 0);

  shared.storage.set({
    'test-coordinator:lease:https://bosun.example.test': {
      version: 1,
      tabId: 'replacement-leader',
      term: 'replacement-term',
      visible: true,
      expiresAt: clock.now + 240
    }
  });
  follower.setVisibility('visible');
  await flushMicrotasks();
  assert.strictEqual(follower.applied.length, 0, 'Snapshot from an expired leader must not be applied');
  leader.coordinator.stop();
  follower.coordinator.stop();
}

async function testCoordinatorStopAbortsActiveFetch() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  let aborted = false;
  const tab = createCoordinatorTab('abort-owner', clock, shared, {
    fetchSnapshot({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  });

  tab.coordinator.start();
  await clock.advance(0);
  await flushMicrotasks();
  await clock.advance(0);
  assert.strictEqual(tab.fetchCount, 1);
  tab.coordinator.stop();
  await flushMicrotasks();
  assert.strictEqual(aborted, true, 'Stopping coordinator must abort the active fetch');
  assert.strictEqual(tab.coordinator.getRole(), 'stopped');
}

async function testAlertsDataBoundsAndAbort() {
  let fetchCalls = 0;
  const context = {
    console,
    globalThis: null,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        headers: { get: () => String(11 * 1024 * 1024) },
        async text() { return '{}'; }
      };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON
  };
  context.TextDecoder = TextDecoder;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'alerts-data.js'), 'utf8'), context, {
    filename: 'alerts-data.js'
  });
  const api = context.BosunSilenceHiderAlertsData.createAlertsData({ oldNoNoteMinutes: 60 });
  await assert.rejects(
    api.fetchAlertsDataWithRetry({ attempts: 1 }),
    (error) => error?.code === 'ERESPONSETOOLARGE'
  );
  assert.strictEqual(fetchCalls, 1, 'Oversized response must not be retried');

  let streamCancelled = false;
  let chunkIndex = 0;
  const oversizedChunks = [new Uint8Array(6 * 1024 * 1024), new Uint8Array(6 * 1024 * 1024)];
  context.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    text() { throw new Error('Streaming path expected'); },
    body: {
      getReader() {
        return {
          async read() {
            return chunkIndex < oversizedChunks.length
              ? { done: false, value: oversizedChunks[chunkIndex++] }
              : { done: true, value: undefined };
          },
          async cancel() { streamCancelled = true; }
        };
      }
    }
  });
  await assert.rejects(
    api.fetchAlertsDataWithRetry({ attempts: 1 }),
    (error) => error?.code === 'ERESPONSETOOLARGE'
  );
  assert.strictEqual(streamCancelled, true, 'Oversized streaming response must be cancelled early');

  context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    fetchCalls += 1;
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  const pending = api.fetchAlertsDataWithRetry({ signal: controller.signal, attempts: 3 });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.strictEqual(fetchCalls, 2, 'Lifecycle abort must not be retried');
}

async function testRefreshCoordinatorLeaderFailoverAndStop() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const first = createCoordinatorTab('first', clock, shared);
  const second = createCoordinatorTab('second', clock, shared);
  const third = createCoordinatorTab('third', clock, shared);

  first.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);
  second.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);
  third.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);

  assert.strictEqual(first.coordinator.getRole(), 'leader');
  assert.strictEqual(second.coordinator.getRole(), 'follower');
  assert.strictEqual(third.coordinator.getRole(), 'follower');
  assert.strictEqual(first.fetchCount, 1);
  assert.strictEqual(second.fetchCount, 0);
  assert.ok(second.applied.some((entry) => entry.metadata.source === 'follower'));

  shared.storage.set({
    'test-coordinator:token:https://bosun.example.test': 'rotated-token'
  }, () => {});
  await clock.advance(0);
  await clock.advance(40);
  assert.strictEqual(shared.openChannelCount, 3, 'Tabs did not converge after channel token rotation');
  assert.strictEqual(
    [first, second, third].filter((tab) => tab.coordinator.getRole() === 'leader').length,
    1,
    'Token rotation produced multiple leaders'
  );

  await clock.advance(220);
  assert.ok(first.fetchCount > 1, 'Leader sequence did not advance before failover');

  first.coordinator.stop();
  await flushMicrotasks();
  await clock.advance(40);
  assert.strictEqual(second.coordinator.getRole(), 'leader');
  assert.ok(second.fetchCount >= 1, 'Follower did not take over polling');
  await clock.advance(0);
  assert.ok(
    third.applied.some((entry) => entry.payload.owner === 'second'),
    'Existing follower rejected the replacement leader sequence'
  );

  second.coordinator.stop();
  second.coordinator.stop();
  third.coordinator.stop();
  const fetchCountAtStop = second.fetchCount;
  await flushMicrotasks();
  await clock.advance(600);
  assert.strictEqual(second.fetchCount, fetchCountAtStop, 'Stopped coordinator continued polling');
  assert.strictEqual(second.coordinator.getRole(), 'stopped');
  assert.strictEqual(second.documentListeners.size, 0);
  assert.strictEqual(second.windowListeners.size, 0);
  assert.strictEqual(shared.openChannelCount, 0);
  assert.strictEqual(clock.timerCount, 0);
}

async function testRefreshCoordinatorResumesFromBfcache() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const tab = createCoordinatorTab('bfcache', clock, shared);
  tab.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);
  assert.strictEqual(tab.coordinator.getRole(), 'leader');

  tab.windowListeners.get('pagehide')?.({ persisted: true });
  await flushMicrotasks();
  assert.strictEqual(tab.coordinator.getRole(), 'stopped');
  tab.windowListeners.get('pageshow')?.({ persisted: true });
  await flushMicrotasks();
  await clock.advance(0);
  assert.strictEqual(tab.coordinator.getRole(), 'leader');
  tab.coordinator.stop();
  await flushMicrotasks();
  await clock.advance(0);
}

async function testVisibleFollowerImmediatelyTakesLeadership() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const first = createCoordinatorTab('visible-first', clock, shared);
  const second = createCoordinatorTab('visible-second', clock, shared);
  first.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);
  second.coordinator.start();
  await flushMicrotasks();
  await clock.advance(0);
  assert.strictEqual(first.coordinator.getRole(), 'leader');
  assert.strictEqual(second.coordinator.getRole(), 'follower');

  first.setVisibility('hidden');
  await clock.advance(0);
  await clock.advance(0);
  assert.strictEqual(second.coordinator.getRole(), 'leader', 'Visible follower did not take leadership');
  assert.ok(second.fetchCount >= 1, 'Visible replacement leader did not refresh immediately');

  first.coordinator.stop();
  second.coordinator.stop();
  await flushMicrotasks();
  await clock.advance(0);
}

async function testNewAlertTrackerPersistsUntilNote() {
  const storageData = {};
  const changes = [];
  const context = {
    console,
    globalThis: null,
    chrome: { runtime: { lastError: null } },
    Date,
    JSON,
    Map,
    Set,
    Promise,
    Number,
    String,
    Array,
    Object
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'new-alert-tracker.js'), 'utf8'), context, {
    filename: 'new-alert-tracker.js'
  });
  const storage = {
    get(keys, callback) {
      const result = {};
      for (const key of keys || []) result[key] = storageData[key];
      callback(result);
    },
    set(values, callback) { Object.assign(storageData, values); callback?.(); }
  };
  const createTracker = () => context.BosunHelperNewAlertTracker.createNewAlertTracker({
    storageKey: 'test-new-alerts',
    getStorage: () => storage,
    getLastError: () => null,
    storageChanges: null,
    collectCurrentIdsAndSeverity(payload) {
      const ids = new Set(payload.currentIds || []);
      return {
        currentIds: ids,
        idToSeverity: new Map(Array.from(ids, (id) => [id, payload.severity?.[id] || 'unknown']))
      };
    },
    normalizeChildren: (value) => Array.isArray(value) ? value : [],
    getChildStableKey: (child) => `id:${child.State.Id}`,
    getGroupStableKey: () => null,
    hasNoteFromActions: (actions) => actions.some((action) => {
      return String(action?.Type || action?.type || '').toLowerCase() === 'note';
    }),
    onChange: (snapshot) => changes.push(JSON.parse(JSON.stringify(snapshot)))
  });

  const first = createTracker();
  await first.start();
  await first.add(
    ['id:1', 'id:2', 'id:3'],
    new Map([['id:1', 'warning'], ['id:2', 'critical'], ['id:3', 'unknown']])
  );
  assert.deepStrictEqual(changes.at(-1).counts, { warning: 1, critical: 1, unknown: 1 });
  assert.strictEqual(storageData['test-new-alerts'].alerts.length, 3);
  first.destroy();

  const restored = createTracker();
  await restored.start();
  assert.deepStrictEqual(changes.at(-1).counts, { warning: 1, critical: 1, unknown: 1 });
  const reconciledPayload = {
    currentIds: ['id:1', 'id:2'],
    severity: { 'id:1': 'warning', 'id:2': 'critical' },
    Groups: {
      NeedAck: [{
        Children: [
          { State: { Id: 1, Actions: [{ Type: 'Note', Message: 'checked' }] } },
          { State: { Id: 2, Actions: [] } }
        ]
      }]
    }
  };
  await restored.reconcile(reconciledPayload);
  assert.deepStrictEqual(changes.at(-1).counts, { warning: 0, critical: 1, unknown: 0 });
  assert.deepStrictEqual(
    storageData['test-new-alerts'].alerts.map((alert) => alert.id),
    ['id:2']
  );
  const notificationCount = changes.length;
  await restored.reconcile(reconciledPayload);
  assert.strictEqual(changes.length, notificationCount, 'Unchanged tracker state was announced again');
  restored.destroy();
}

async function testNewAlertTrackerRestoreRaceAndSaveRetry() {
  const context = {
    console,
    globalThis: null,
    chrome: { runtime: { lastError: null } },
    Date,
    JSON,
    Map,
    Set,
    Promise,
    Number,
    String,
    Array,
    Object
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'new-alert-tracker.js'), 'utf8'), context);

  let delayedGet = null;
  const storageListeners = new Set();
  const snapshots = [];
  const raceTracker = context.BosunHelperNewAlertTracker.createNewAlertTracker({
    storageKey: 'race',
    getStorage: () => ({ get(_keys, callback) { delayedGet = callback; }, set() {} }),
    getLastError: () => null,
    storageChanges: {
      addListener(listener) { storageListeners.add(listener); },
      removeListener(listener) { storageListeners.delete(listener); }
    },
    onChange: (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot)))
  });
  const starting = raceTracker.start();
  const newer = {
    version: 1,
    alerts: [{ id: 'new', severity: 'critical', detectedAt: 2 }]
  };
  for (const listener of storageListeners) {
    listener({ race: { oldValue: null, newValue: newer } }, 'local');
  }
  delayedGet({ race: {
    version: 1,
    alerts: [{ id: 'old', severity: 'warning', detectedAt: 1 }]
  } });
  await starting;
  assert.deepStrictEqual(snapshots.at(-1).counts, { warning: 0, critical: 1, unknown: 0 });
  raceTracker.destroy();

  const persisted = {};
  let currentError = null;
  let failFirstSet = true;
  const retrySnapshots = [];
  const retryStorage = {
    get(keys, callback) {
      const result = {};
      for (const key of keys || []) result[key] = persisted[key];
      callback(result);
    },
    set(values, callback) {
      if (failFirstSet) {
        failFirstSet = false;
        currentError = { message: 'transient' };
        callback();
        currentError = null;
        return;
      }
      Object.assign(persisted, values);
      callback();
    }
  };
  const retryTracker = context.BosunHelperNewAlertTracker.createNewAlertTracker({
    storageKey: 'retry',
    getStorage: () => retryStorage,
    getLastError: () => currentError,
    storageChanges: null,
    collectCurrentIdsAndSeverity: () => ({
      currentIds: new Set(['id:retry']),
      idToSeverity: new Map([['id:retry', 'critical']])
    }),
    onChange: (snapshot) => retrySnapshots.push(JSON.parse(JSON.stringify(snapshot)))
  });
  await retryTracker.start();
  await retryTracker.add(['id:retry'], new Map([['id:retry', 'critical']]));
  assert.strictEqual(persisted.retry, undefined, 'First simulated storage failure unexpectedly persisted');
  await retryTracker.reconcile({ Groups: { NeedAck: [] } });
  assert.strictEqual(persisted.retry.alerts[0].id, 'id:retry');
  retryTracker.destroy();
}

function testPortConfigurationSynchronization() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-config-test-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'scripts'));
    fs.copyFileSync(
      path.join(root, 'scripts', 'sync-config.js'),
      path.join(temporaryRoot, 'scripts', 'sync-config.js')
    );
    fs.copyFileSync(
      path.join(root, 'scripts', 'config-sync.js'),
      path.join(temporaryRoot, 'scripts', 'config-sync.js')
    );
    fs.writeFileSync(path.join(temporaryRoot, 'config.local.js'), `
      globalThis.BosunHelperLocalConfig = {
        bosunHosts: ['bosun.example.test:7443'],
        grafanaHost: 'grafana.example.test:8443',
        grafanaPanelUrl: 'https://grafana.example.test:8443/d/test?editPanel=1'
      };
    `);
    fs.writeFileSync(path.join(temporaryRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      content_scripts: [
        { matches: [], js: ['config.js', 'content.js'] },
        { matches: [], js: ['config.js', 'grafana-content.js'] }
      ],
      web_accessible_resources: [
        { matches: [], resources: ['bosun_notification_alert_chime.wav'] },
        { matches: [], resources: ['grafana-page.js'] }
      ]
    }));

    const result = spawnSync(process.execPath, ['scripts/sync-config.js'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const manifest = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.content_scripts[0].matches, ['https://bosun.example.test/*']);
    assert.deepStrictEqual(manifest.content_scripts[1].matches, ['https://grafana.example.test/*']);
    assert.deepStrictEqual(manifest.web_accessible_resources[0].matches, ['https://bosun.example.test/*']);
    assert.deepStrictEqual(manifest.web_accessible_resources[1].matches, ['https://grafana.example.test/*']);

    const configContext = { globalThis: null };
    configContext.globalThis = configContext;
    vm.runInNewContext(
      fs.readFileSync(path.join(temporaryRoot, 'config.js'), 'utf8'),
      configContext
    );
    assert.strictEqual(configContext.BosunHelperLocalConfig.bosunHosts[0], 'bosun.example.test:7443');
    assert.strictEqual(configContext.BosunHelperLocalConfig.grafanaHost, 'grafana.example.test:8443');
    assert.strictEqual(
      new URL(configContext.BosunHelperLocalConfig.grafanaPanelUrl).host,
      'grafana.example.test:8443'
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createGrafanaPageContext(overrides = {}) {
  const messageListeners = [];
  const postedMessages = [];
  const bridgeScript = {
    dataset: { channelToken: 'test-token' },
    removeAttribute(name) { delete this.dataset[name === 'data-channel-token' ? 'channelToken' : name]; }
  };
  const document = {
    currentScript: bridgeScript,
    querySelector: overrides.querySelector || (() => null),
    querySelectorAll: overrides.querySelectorAll || (() => []),
    createRange: overrides.createRange || (() => ({ selectNodeContents() {} })),
    execCommand: overrides.execCommand || (() => true)
  };
  const location = { origin: 'https://grafana.example.test' };
  const window = {
    document,
    location,
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage(message, targetOrigin) { postedMessages.push({ message, targetOrigin }); },
    getSelection: overrides.getSelection || (() => ({
      removeAllRanges() {},
      addRange() {}
    }))
  };
  window.window = window;
  const context = {
    console,
    globalThis: null,
    window,
    document,
    location,
    Date,
    Math,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    Event: function Event(type, init) { this.type = type; Object.assign(this, init || {}); },
    setTimeout: overrides.setTimeout || ((callback) => { callback(); return 1; }),
    clearTimeout() {}
  };
  context.globalThis = context;
  if (overrides.monaco) window.monaco = overrides.monaco;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'grafana-page.js'), 'utf8'), context, {
    filename: 'grafana-page.js'
  });
  return { context, window, messageListeners, postedMessages };
}

async function dispatchGrafanaApply(
  harness,
  operationId,
  query,
  run = true,
  deadlineAt = Date.now() + 10_000
) {
  const listener = harness.messageListeners[0];
  assert.ok(listener, 'Grafana bridge message listener was not installed');
  await listener({
    source: harness.window,
    origin: harness.context.location.origin,
    data: {
      type: 'BOSUN_HELPER_APPLY_GRAFANA_QUERY',
      channelToken: 'test-token',
      requestId: `request-${operationId}`,
      operationId,
      query,
      run,
      deadlineAt
    }
  });
  return harness.postedMessages.at(-1)?.message?.result;
}

async function testGrafanaRejectsAmbiguousMonacoModels() {
  const values = ['old query', 'old query'];
  const models = values.map((_value, index) => ({
    getValue: () => values[index],
    getVersionId: () => 1,
    setValue(next) { values[index] = next; }
  }));
  const textarea = {
    value: 'old query',
    focus() {}, click() {}, blur() {}, dispatchEvent() {}
  };
  const harness = createGrafanaPageContext({
    monaco: { editor: { getModels: () => models } },
    querySelector(selector) {
      return selector.includes('textarea.inputarea') ? textarea : null;
    },
    querySelectorAll(selector) {
      return selector.includes('textarea.inputarea') ? [textarea] : [];
    }
  });

  const result = await dispatchGrafanaApply(harness, 'ambiguous-models', 'new query', false);
  assert.deepStrictEqual(values, ['old query', 'old query'], 'Ambiguous Monaco models were mutated');
  assert.strictEqual(result?.ok, false);

  let modelValue = 'old query';
  const singleModel = {
    getValue: () => modelValue,
    getVersionId: () => 1,
    setValue(next) { modelValue = next; }
  };
  const editors = [
    { innerText: 'first', textContent: 'first', closest: () => null },
    { innerText: 'second', textContent: 'second', closest: () => null }
  ];
  const ambiguousDom = createGrafanaPageContext({
    monaco: { editor: { getModels: () => [singleModel] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [textarea];
      if (selector.includes('.cm-content')) return editors;
      return [];
    }
  });
  const domResult = await dispatchGrafanaApply(
    ambiguousDom,
    'ambiguous-editor-dom',
    'new query',
    false
  );
  assert.strictEqual(modelValue, 'old query', 'Ambiguous editor DOM still mutated a Monaco model');
  assert.strictEqual(domResult?.ok, false);
}

async function testGrafanaRejectsMixedAdaptersAndIgnoresHiddenAncestorDecoy() {
  let cmText = 'old cm query';
  let modelText = 'old monaco query';
  const view = {
    state: { doc: { toString: () => cmText } },
    dispatch(transaction) { cmText = transaction.changes.insert; }
  };
  const editorRoot = { cmView: view, querySelectorAll: () => [] };
  const content = { innerText: '', textContent: '', closest: () => editorRoot };
  const textarea = { value: 'old monaco query', focus() {}, click() {}, blur() {}, dispatchEvent() {} };
  const model = {
    getValue: () => modelText,
    getVersionId: () => 1,
    setValue(next) { modelText = next; }
  };
  const mixed = createGrafanaPageContext({
    monaco: { editor: { getModels: () => [model] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [textarea];
      if (selector.includes('.cm-content')) return [content];
      return [];
    }
  });
  const mixedResult = await dispatchGrafanaApply(mixed, 'mixed-adapters', 'new query', false);
  assert.strictEqual(cmText, 'old cm query', 'Mixed editor adapters mutated CodeMirror');
  assert.strictEqual(modelText, 'old monaco query', 'Mixed editor adapters mutated Monaco');
  assert.strictEqual(mixedResult?.ok, false);

  let visibleText = 'old visible query';
  const visibleView = {
    state: { doc: { toString: () => visibleText } },
    dispatch(transaction) { visibleText = transaction.changes.insert; }
  };
  const visibleRoot = { cmView: visibleView, querySelectorAll: () => [] };
  const hiddenAncestor = { hidden: true, parentElement: null };
  const hiddenContent = {
    innerText: 'hidden query',
    textContent: 'hidden query',
    parentElement: hiddenAncestor,
    closest: () => ({ cmView: null, querySelectorAll: () => [] })
  };
  const visibleContent = {
    innerText: '', textContent: '', parentElement: null, closest: () => visibleRoot
  };
  const zeroRectContent = {
    innerText: 'layout-hidden query',
    textContent: 'layout-hidden query',
    parentElement: null,
    getClientRects: () => [],
    closest: () => ({ cmView: null, querySelectorAll: () => [] })
  };
  const hiddenDecoy = createGrafanaPageContext({
    querySelectorAll(selector) {
      return selector.includes('.cm-content')
        ? [visibleContent, hiddenContent, zeroRectContent]
        : [];
    }
  });
  const hiddenResult = await dispatchGrafanaApply(
    hiddenDecoy,
    'hidden-ancestor-decoy',
    'new visible query',
    false
  );
  assert.strictEqual(hiddenResult?.ok, true, 'Hidden ancestor decoy blocked unique visible editor');
  assert.strictEqual(visibleText, 'new visible query');
}

async function testGrafanaRequiresUniqueVisibleEnabledRunButton() {
  async function runCase(operationId, buttons) {
    let docText = 'old query';
    let clicks = 0;
    for (const button of buttons) {
      button.textContent = 'Run queries';
      button.click = () => { clicks += 1; };
    }
    const view = {
      state: { doc: { toString: () => docText } },
      dispatch(transaction) { docText = transaction.changes.insert; }
    };
    const editorRoot = { cmView: view, querySelectorAll: () => [] };
    const content = { innerText: '', textContent: '', closest: () => editorRoot };
    const queryArea = { querySelectorAll: () => [content] };
    const codeButton = { textContent: 'Code', closest: () => ({ parentElement: queryArea }) };
    const harness = createGrafanaPageContext({
      querySelectorAll(selector) {
        if (selector === 'button') return [codeButton, ...buttons];
        if (selector.includes('.cm-content')) return [content];
        return [];
      }
    });
    const result = await dispatchGrafanaApply(harness, operationId, 'new query');
    return { result, clicks };
  }

  for (const [name, buttons] of [
    ['missing', []],
    ['duplicate', [{}, {}]],
    ['hidden', [{ hidden: true }]],
    ['disabled', [{ disabled: true }]],
    ['aria-disabled', [{ getAttribute: (name) => name === 'aria-disabled' ? 'true' : null }]]
  ]) {
    const outcome = await runCase(`run-${name}`, buttons);
    assert.strictEqual(outcome.result?.ok, false, `${name} Run button produced success`);
    assert.strictEqual(outcome.clicks, 0, `${name} Run button was clicked`);
  }
}

async function testGrafanaFocusedFallbackNeverRuns() {
  const editor = {
    innerText: 'old query', textContent: 'old query',
    focus() {}, click() {}, closest: () => null
  };
  const queryArea = { querySelectorAll: () => [editor] };
  const codeButton = { textContent: 'Code', closest: () => ({ parentElement: queryArea }) };
  let runCount = 0;
  let commandCount = 0;
  let backingText = 'old backing query';
  const runButton = { textContent: 'Run queries', click() { runCount += 1; } };
  const harness = createGrafanaPageContext({
    querySelectorAll(selector) {
      if (selector === 'button') return [codeButton, runButton];
      if (selector.includes('.cm-content')) return [editor];
      return [];
    },
    execCommand(command, _showUi, value) {
      commandCount += 1;
      backingText = command === 'delete' ? '' : String(value || '');
      editor.innerText = command === 'delete' ? '' : String(value || '');
      editor.textContent = editor.innerText;
      return true;
    }
  });
  const result = await dispatchGrafanaApply(harness, 'focused-run', 'new query');
  assert.strictEqual(editor.innerText, 'old query', 'Focused fallback mutated DOM editor state');
  assert.strictEqual(backingText, 'old backing query', 'Focused fallback mutated backing state');
  assert.strictEqual(commandCount, 0, 'Focused fallback invoked execCommand');
  assert.strictEqual(runCount, 0, 'Focused DOM fallback clicked Run queries');
  assert.strictEqual(result?.ok, false, 'Focused DOM fallback reported automatic Run success');
}

async function testGrafanaHardDeadlinePreventsMutation() {
  let value = 'old query';
  let setCount = 0;
  const model = {
    getValue: () => value,
    getVersionId: () => setCount,
    setValue(next) { setCount += 1; value = next; }
  };
  const textarea = { value: 'old query', focus() {}, click() {}, blur() {}, dispatchEvent() {} };
  const harness = createGrafanaPageContext({
    monaco: { editor: { getModels: () => [model] } },
    querySelector(selector) {
      return selector.includes('textarea.inputarea') ? textarea : null;
    },
    querySelectorAll(selector) {
      return selector.includes('textarea.inputarea') ? [textarea] : [];
    }
  });
  const result = await dispatchGrafanaApply(
    harness,
    'expired-before-write',
    'new query',
    false,
    Date.now() - 1
  );
  assert.strictEqual(setCount, 0, 'Expired operation mutated a Monaco model');
  assert.strictEqual(value, 'old query');
  assert.strictEqual(result?.ok, false);
}

async function testGrafanaCodeMirrorRejectsRemountAndEditAwayBack() {
  async function runCase(kind) {
    const timers = [];
    let runCount = 0;
    let docText = 'old query';
    const view = {
      state: { doc: { toString: () => docText } },
      dispatch(transaction) {
        docText = transaction.changes.insert;
        this.state.doc = { toString: () => docText };
      }
    };
    const replacementView = {
      state: { doc: { toString: () => 'replacement' } },
      dispatch() {}
    };
    const editorRoot = { cmView: view, isConnected: true, querySelectorAll: () => [] };
    const replacementRoot = { cmView: replacementView, isConnected: true, querySelectorAll: () => [] };
    const content = { innerText: '', textContent: '', isConnected: true, closest: () => editorRoot };
    const replacementContent = {
      innerText: '', textContent: '', isConnected: true, closest: () => replacementRoot
    };
    let activeContent = content;
    const queryArea = { querySelectorAll: () => [activeContent] };
    const codeButton = { textContent: 'Code', closest: () => ({ parentElement: queryArea }) };
    const runButton = { textContent: 'Run queries', click() { runCount += 1; } };
    const harness = createGrafanaPageContext({
      setTimeout(callback) { timers.push(callback); return timers.length; },
      querySelectorAll(selector) {
        if (selector === 'button') return [codeButton, runButton];
        if (selector.includes('.cm-content')) return [activeContent];
        return [];
      }
    });

    const pending = dispatchGrafanaApply(harness, `cm-${kind}`, 'new query');
    await flushMicrotasks();
    if (kind === 'remount') {
      content.isConnected = false;
      editorRoot.isConnected = false;
      activeContent = replacementContent;
    } else {
      view.dispatch({ changes: { insert: 'user query' } });
      view.dispatch({ changes: { insert: 'new query' } });
    }
    timers.shift()();
    const result = await pending;
    assert.strictEqual(runCount, 0, `CodeMirror ${kind} still ran`);
    assert.strictEqual(result?.ok, false, `CodeMirror ${kind} reported success`);
  }

  await runCase('remount');
  await runCase('edit-away-back');
}

async function testGrafanaMonacoConditionalRollback() {
  async function runCase(changeConcurrently) {
    let value = 'old query';
    let version = 1;
    const model = {
      getValue: () => value,
      getVersionId: () => version,
      setValue(next) { value = next; version += 1; }
    };
    const textarea = {
      value: '',
      focus() {},
      click() {},
      blur() {},
      dispatchEvent() {}
    };
    const runButton = {
      textContent: 'Run queries',
      click() {
        if (changeConcurrently) {
          value = 'concurrent query';
          version += 1;
        }
        throw new Error('run failed');
      }
    };
    const harness = createGrafanaPageContext({
      monaco: { editor: { getModels: () => [model] } },
      querySelector(selector) {
        return selector.includes('textarea.inputarea') ? textarea : null;
      },
      querySelectorAll(selector) {
        if (selector.includes('textarea.inputarea')) return [textarea];
        return selector === 'button' ? [runButton] : [];
      }
    });

    const result = await dispatchGrafanaApply(
      harness,
      changeConcurrently ? 'concurrent' : 'owned',
      'new query'
    );
    return { value, result };
  }

  const owned = await runCase(false);
  assert.strictEqual(
    owned.value,
    'old query',
    'Monaco transaction failure did not roll back an unchanged owned value'
  );
  const concurrent = await runCase(true);
  assert.strictEqual(
    concurrent.value,
    'concurrent query',
    `Monaco rollback overwrote a concurrent model change: ${JSON.stringify(concurrent.result)}`
  );

  let normalizedValue = 'old query';
  let normalizedVersion = 1;
  const normalizedModel = {
    getValue: () => normalizedValue,
    getVersionId: () => normalizedVersion,
    setValue(next) {
      normalizedVersion += 1;
      normalizedValue = next === 'new query' ? 'normalized query' : next;
    }
  };
  const normalizedHarness = createGrafanaPageContext({
    monaco: { editor: { getModels: () => [normalizedModel] } },
    querySelector(selector) {
      return selector.includes('textarea.inputarea')
        ? { focus() {}, click() {}, blur() {}, dispatchEvent() {} }
        : null;
    },
    querySelectorAll(selector) {
      return selector.includes('textarea.inputarea')
        ? [{ focus() {}, click() {}, blur() {}, dispatchEvent() {} }]
        : [];
    }
  });
  await dispatchGrafanaApply(normalizedHarness, 'normalized-owned', 'new query', false);
  assert.strictEqual(
    normalizedValue,
    'old query',
    'Monaco mismatch with an unchanged owned version was not rolled back'
  );
}

async function testGrafanaCodeMirrorAwaitsRun() {
  const timers = [];
  let runCount = 0;
  let docText = 'old query';
  const view = {
    state: { doc: { toString: () => docText } },
    dispatch(transaction) { docText = transaction.changes.insert; }
  };
  const editorRoot = {
    cmView: view,
    querySelectorAll: () => []
  };
  const content = {
    innerText: '',
    textContent: '',
    closest: () => editorRoot
  };
  const queryArea = {
    querySelectorAll: () => [content]
  };
  const codeButton = {
    textContent: 'Code',
    closest: () => ({ parentElement: queryArea })
  };
  const runButton = {
    textContent: 'Run queries',
    click() { runCount += 1; }
  };
  const harness = createGrafanaPageContext({
    setTimeout(callback) { timers.push(callback); return timers.length; },
    querySelectorAll(selector) {
      if (selector === 'button') return [codeButton, runButton];
      if (selector.includes('.cm-content')) return [content];
      return [];
    }
  });

  const pending = dispatchGrafanaApply(harness, 'codemirror', 'new query');
  await flushMicrotasks();
  assert.strictEqual(runCount, 0);
  assert.ok(timers.length > 0, 'CodeMirror Run delay was not scheduled');
  timers.shift()();
  await pending;
  assert.strictEqual(runCount, 1, 'CodeMirror operation completed without running the query');

  const insertOnly = await dispatchGrafanaApply(harness, 'codemirror-insert-only', 'inspect query', false);
  assert.strictEqual(insertOnly?.ok, true);
  assert.strictEqual(docText, 'inspect query');
  assert.strictEqual(runCount, 1, 'Insert-only mode clicked Run queries');
}

async function testGrafanaFocusedEditorDoesNotOverwriteUnknownPartialDelete() {
  const editor = {
    innerText: 'old query',
    textContent: 'old query',
    focus() {},
    click() {},
    closest: () => null
  };
  const queryArea = { querySelectorAll: () => [editor] };
  const codeButton = {
    textContent: 'Code',
    closest: () => ({ parentElement: queryArea })
  };
  let deleteCount = 0;
  const harness = createGrafanaPageContext({
    querySelectorAll(selector) {
      if (selector === 'button') return [codeButton];
      if (selector.includes('.cm-content')) return [editor];
      return [];
    },
    execCommand(command, _showUi, value) {
      if (command === 'delete') {
        deleteCount += 1;
        editor.innerText = deleteCount === 1 ? 'part' : '';
        editor.textContent = editor.innerText;
      } else if (command === 'insertText') {
        editor.innerText = String(value || '');
        editor.textContent = editor.innerText;
      }
      return true;
    }
  });

  const result = await dispatchGrafanaApply(harness, 'partial-delete', 'new query');
  assert.strictEqual(
    editor.innerText,
    'old query',
    'Insert-only focused-editor fallback mutated DOM state'
  );
  assert.strictEqual(deleteCount, 0, 'Insert-only focused-editor fallback invoked execCommand');
  assert.strictEqual(result?.ok, false);
  assert.strictEqual(result?.rolledBack, undefined);
}

(async () => {
  await testRefreshCoordinatorLeaderFailoverAndStop();
  await testHiddenFollowerDefersSnapshotsUntilVisible();
  await testHiddenFollowerRejectsSnapshotFromExpiredLeader();
  await testCoordinatorStopAbortsActiveFetch();
  await testAlertsDataBoundsAndAbort();
  await testRefreshCoordinatorResumesFromBfcache();
  await testVisibleFollowerImmediatelyTakesLeadership();
  await testNewAlertTrackerPersistsUntilNote();
  await testNewAlertTrackerRestoreRaceAndSaveRetry();
  await testGrafanaRejectsAmbiguousMonacoModels();
  await testGrafanaRejectsMixedAdaptersAndIgnoresHiddenAncestorDecoy();
  await testGrafanaRequiresUniqueVisibleEnabledRunButton();
  await testGrafanaFocusedFallbackNeverRuns();
  await testGrafanaHardDeadlinePreventsMutation();
  await testGrafanaCodeMirrorRejectsRemountAndEditAwayBack();
  await testGrafanaMonacoConditionalRollback();
  await testGrafanaCodeMirrorAwaitsRun();
  await testGrafanaFocusedEditorDoesNotOverwriteUnknownPartialDelete();
  testPortConfigurationSynchronization();
  console.log('Regression test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
