'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

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
    },
    get openChannelNames() {
      return Array.from(channels.entries()).flatMap(([name, peers]) => {
        return Array.from(peers, () => name);
      });
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
  const runtime = options.runtime || { lastError: null };
  const context = {
    console,
    globalThis: null,
    window: null,
    document,
    location: { origin: 'https://bosun.example.test' },
    chrome: {
      runtime,
      storage: { local: options.storage || shared.storage, onChanged: shared.storageChanges }
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
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/shared/refresh-coordinator.js'), 'utf8'), context, {
    filename: 'src/shared/refresh-coordinator.js'
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
    runtime,
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSoundRaceHarness() {
  const audioByKind = new Map();
  const diagnostics = [];
  let now = 1_000_000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  class FakeAudio {
    constructor(url) {
      this.kind = String(url).includes('alert.wav') ? 'alert' : 'soft';
      this.currentTime = 0;
      this.muted = false;
      this.volume = 1;
      this.plans = [];
      this.pauseCount = 0;
      this.activePlayCount = 0;
      this.overlapPlayAttempts = 0;
      this.pauseWhilePlaying = 0;
      audioByKind.set(this.kind, this);
    }
    play() {
      const plan = this.plans.shift();
      if (!plan) throw new Error(`Missing ${this.kind} audio plan`);
      if (this.activePlayCount > 0) this.overlapPlayAttempts += 1;
      if (plan.type === 'throw') throw plan.error;
      if (plan.type === 'value') return plan.value;
      this.activePlayCount += 1;
      return plan.deferred.promise.finally(() => { this.activePlayCount -= 1; });
    }
    pause() {
      this.pauseCount += 1;
      if (this.activePlayCount > 0) this.pauseWhilePlaying += 1;
    }
  }
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const context = {
    console,
    globalThis: null,
    window,
    chrome: { runtime: { getURL: (file) => `chrome-extension://test/${file}` } },
    navigator: {},
    Audio: FakeAudio,
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
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {}
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/shared/sound.js'), 'utf8'), context, {
    filename: 'src/shared/sound.js'
  });
  const api = context.BosunSilenceHiderSound.createSound({
    alertFile: 'alert.wav',
    softFile: 'soft.wav',
    getEnabled: () => true,
    reportDiagnostics(event, details) {
      diagnostics.push({
        event,
        details,
        alertMuted: audioByKind.get('alert')?.muted === true,
        softMuted: audioByKind.get('soft')?.muted === true
      });
    }
  });
  api.ensureAudioObjects();
  return {
    api,
    diagnostics,
    audio(kind) { return audioByKind.get(kind); },
    enqueueDeferred(kind, deferred) {
      audioByKind.get(kind).plans.push({ type: 'deferred', deferred });
    },
    enqueueThrow(kind, error) {
      audioByKind.get(kind).plans.push({ type: 'throw', error });
    },
    enqueueValue(kind, value) {
      audioByKind.get(kind).plans.push({ type: 'value', value });
    },
    advance(milliseconds) { now += milliseconds; }
  };
}

async function testSoundUnlockAndNotificationRacesRestoreMuteState() {
  const unlockFirst = createSoundRaceHarness();
  const unlockAlert = createDeferred();
  const unlockSoft = createDeferred();
  const overlappingNotification = createDeferred();
  unlockFirst.enqueueDeferred('alert', unlockAlert);
  unlockFirst.enqueueDeferred('soft', unlockSoft);
  unlockFirst.enqueueDeferred('alert', overlappingNotification);
  unlockFirst.api.unlockAudioOnce();
  const overlappingPlay = unlockFirst.api.playNeedAckChimeUnlocked('alert');
  overlappingNotification.resolve();
  await flushMicrotasks();
  unlockAlert.reject(Object.assign(new Error('synthetic unlock rejection'), { name: 'NotAllowedError' }));
  unlockSoft.resolve();
  const overlappingPlayResult = await Promise.resolve(overlappingPlay);
  await flushMicrotasks();

  unlockFirst.advance(1000);
  const subsequentAfterRejectedUnlock = createDeferred();
  unlockFirst.enqueueDeferred('alert', subsequentAfterRejectedUnlock);
  const subsequentRejectedUnlockPlay = unlockFirst.api.playNeedAckChimeUnlocked('alert');
  subsequentAfterRejectedUnlock.resolve();
  const subsequentRejectedUnlockResult = await Promise.resolve(subsequentRejectedUnlockPlay);
  await flushMicrotasks();

  const notificationFirst = createSoundRaceHarness();
  const initialNotification = createDeferred();
  notificationFirst.enqueueDeferred('alert', initialNotification);
  const notificationPending = notificationFirst.api.playNeedAckChimeUnlocked('alert');
  const notificationFirstUnlock = notificationFirst.api.unlockAudioOnce();
  initialNotification.resolve();
  const notificationPendingResult = await Promise.resolve(notificationPending);
  const notificationFirstUnlockResult = await Promise.resolve(notificationFirstUnlock);
  await flushMicrotasks();
  const notificationFirstPlayedBeforeRecovery = notificationFirst.diagnostics.filter((entry) => {
    return entry.event === 'sound-played';
  }).length;

  notificationFirst.advance(1000);
  const subsequentAfterThrownUnlock = createDeferred();
  notificationFirst.enqueueDeferred('alert', subsequentAfterThrownUnlock);
  const subsequentThrownUnlockPlay = notificationFirst.api.playNeedAckChimeUnlocked('alert');
  subsequentAfterThrownUnlock.resolve();
  const subsequentThrownUnlockResult = await Promise.resolve(subsequentThrownUnlockPlay);
  await flushMicrotasks();
  const notificationFirstPlayedAfterRecovery = notificationFirst.diagnostics.filter((entry) => {
    return entry.event === 'sound-played';
  }).length;

  const thrownUnlock = createSoundRaceHarness();
  thrownUnlock.enqueueThrow('alert', new Error('synthetic unlock throw'));
  thrownUnlock.enqueueValue('soft', undefined);
  const thrownUnlockResult = await thrownUnlock.api.unlockAudioOnce();
  thrownUnlock.advance(1000);
  const subsequentAfterStandaloneThrow = createDeferred();
  thrownUnlock.enqueueDeferred('alert', subsequentAfterStandaloneThrow);
  const standaloneThrowRecovery = thrownUnlock.api.playNeedAckChimeUnlocked('alert');
  subsequentAfterStandaloneThrow.resolve();
  const standaloneThrowRecoveryResult = await Promise.resolve(standaloneThrowRecovery);
  await flushMicrotasks();

  const normal = createSoundRaceHarness();
  normal.enqueueValue('alert', undefined);
  normal.enqueueValue('soft', undefined);
  normal.api.unlockAudioOnce();
  await flushMicrotasks();
  normal.advance(1000);
  normal.enqueueValue('alert', undefined);
  await normal.api.playNeedAckChimeUnlocked('alert');

  const actual = {
    unlockFirstRestoredMute: unlockFirst.audio('alert').muted === false && unlockFirst.audio('soft').muted === false,
    unlockFirstNeverReportedMutedPlayback: !unlockFirst.diagnostics.some((entry) => {
      return entry.event === 'sound-played' && entry.alertMuted;
    }),
    notificationFirstRestoredMute: notificationFirst.audio('alert').muted === false &&
      notificationFirst.audio('soft').muted === false,
    notificationFirstNeverReportedMutedPlayback: !notificationFirst.diagnostics.some((entry) => {
      return entry.event === 'sound-played' && entry.alertMuted;
    }),
    unlockFirstOperationsSucceeded: overlappingPlayResult === true && subsequentRejectedUnlockResult === true,
    notificationFirstOperationsSucceeded: notificationPendingResult === true &&
      notificationFirstUnlockResult === true && subsequentThrownUnlockResult === true,
    unlockFirstSerialized: unlockFirst.audio('alert').overlapPlayAttempts === 0 &&
      unlockFirst.audio('alert').pauseWhilePlaying === 0,
    notificationFirstSerialized: notificationFirst.audio('alert').overlapPlayAttempts === 0 &&
      notificationFirst.audio('alert').pauseWhilePlaying === 0,
    unlockFirstPlansConsumed: unlockFirst.audio('alert').plans.length === 0 &&
      unlockFirst.audio('soft').plans.length === 0,
    notificationFirstPlansConsumed: notificationFirst.audio('alert').plans.length === 0 &&
      notificationFirst.audio('soft').plans.length === 0,
    rejectedUnlockRecovered: unlockFirst.diagnostics.filter((entry) => entry.event === 'sound-played').length === 2,
    notificationFirstPlayedOnceBeforeRecovery: notificationFirstPlayedBeforeRecovery === 1,
    notificationFirstRecoveryPlayedOnce: notificationFirstPlayedAfterRecovery ===
      notificationFirstPlayedBeforeRecovery + 1,
    standaloneThrowRestoredMute: thrownUnlock.audio('alert').muted === false &&
      thrownUnlock.audio('soft').muted === false,
    standaloneThrowRecovered: thrownUnlockResult === true && standaloneThrowRecoveryResult === true &&
      thrownUnlock.diagnostics.filter((entry) => entry.event === 'sound-played').length === 1,
    normalUnlockRestoredMute: normal.audio('alert').muted === false && normal.audio('soft').muted === false,
    normalNotificationReported: normal.diagnostics.some((entry) => {
      return entry.event === 'sound-played' && !entry.alertMuted;
    })
  };
  assert.deepStrictEqual(actual, {
    unlockFirstRestoredMute: true,
    unlockFirstNeverReportedMutedPlayback: true,
    notificationFirstRestoredMute: true,
    notificationFirstNeverReportedMutedPlayback: true,
    unlockFirstOperationsSucceeded: true,
    notificationFirstOperationsSucceeded: true,
    unlockFirstSerialized: true,
    notificationFirstSerialized: true,
    unlockFirstPlansConsumed: true,
    notificationFirstPlansConsumed: true,
    rejectedUnlockRecovered: true,
    notificationFirstPlayedOnceBeforeRecovery: true,
    notificationFirstRecoveryPlayedOnce: true,
    standaloneThrowRestoredMute: true,
    standaloneThrowRecovered: true,
    normalUnlockRestoredMute: true,
    normalNotificationReported: true
  });
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
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/alerts-data.js'), 'utf8'), context, {
    filename: 'src/bosun/alerts-data.js'
  });
  const api = context.BosunSilenceHiderAlertsData.createAlertsData({ oldNoNoteMinutes: 60 });
  assert.deepStrictEqual(
    await api.fetchAlertsDataWithRetry({ attempts: 1 }),
    {},
    'A legitimate alerts response larger than 10 MiB must be accepted'
  );

  context.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      headers: { get: () => String(65 * 1024 * 1024) },
      async text() { return '{}'; }
    };
  };
  await assert.rejects(
    api.fetchAlertsDataWithRetry({ attempts: 1 }),
    (error) => error?.code === 'ERESPONSETOOLARGE'
  );
  assert.strictEqual(fetchCalls, 2, 'Oversized response must not be retried');

  let streamCancelled = false;
  let chunkIndex = 0;
  const oversizedChunks = [new Uint8Array([123]), { byteLength: 64 * 1024 * 1024 }];
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
  assert.strictEqual(fetchCalls, 3, 'Lifecycle abort must not be retried');
}

function createAlertsDataIndexApi() {
  const context = {
    console,
    globalThis: null,
    Date,
    Math,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    JSON
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/alerts-data.js'), 'utf8'), context, {
    filename: 'src/bosun/alerts-data.js'
  });
  return context.BosunSilenceHiderAlertsData.createAlertsData({ oldNoNoteMinutes: 60 });
}

function buildSyntheticAlertIndex(api, groups) {
  return api.rebuildAlertDataIndex({ Groups: { NeedAck: groups } }, {
    buildChildMarkerKeyFromData(child) {
      return typeof child?.MarkerKey === 'string' ? child.MarkerKey : null;
    },
    buildGroupMarkerKeyFromData(group) {
      return typeof group?.MarkerKey === 'string' ? group.MarkerKey : null;
    },
    normalizeNeedAckChildren(value) {
      return Array.isArray(value) ? value : [];
    }
  });
}

function indexedChildState(index, identityType, identity) {
  const suffix = identityType === 'id' ? 'ById' : 'ByKey';
  return {
    note: index[`childHasNote${suffix}`].get(identity) === true,
    oldNoNote: index[`childOldNoNote${suffix}`].get(identity) === true,
    userComment: index[`childHasUserComment${suffix}`].get(identity) === true
  };
}

function createSyntheticIndexedChild({ id, markerKey, note = false }) {
  return {
    MarkerKey: markerKey,
    Ago: '2020-01-01T00:00:00.000Z',
    State: {
      ...(id == null ? {} : { Id: id }),
      Actions: note
        ? [{ Type: 'Note', User: 'operator', Message: 'synthetic investigation note' }]
        : []
    }
  };
}

function testAlertsDataRejectsAmbiguousChildIdentities() {
  const api = createAlertsDataIndexApi();
  const noState = { note: false, oldNoNote: false, userComment: false };

  for (const children of [
    [
      createSyntheticIndexedChild({ id: 41, markerKey: 'key:first' }),
      createSyntheticIndexedChild({ id: 41, markerKey: 'key:second', note: true })
    ],
    [
      createSyntheticIndexedChild({ id: 41, markerKey: 'key:second', note: true }),
      createSyntheticIndexedChild({ id: 41, markerKey: 'key:first' })
    ]
  ]) {
    const index = buildSyntheticAlertIndex(api, [{ Subject: 'same parent', Children: children }]);
    assert.deepStrictEqual(
      indexedChildState(index, 'id', '41'),
      noState,
      'A duplicate child ID transferred state from one alert entity to another'
    );
  }

  for (const children of [
    [
      createSyntheticIndexedChild({ markerKey: 'key:shared' }),
      createSyntheticIndexedChild({ markerKey: 'key:shared', note: true })
    ],
    [
      createSyntheticIndexedChild({ markerKey: 'key:shared', note: true }),
      createSyntheticIndexedChild({ markerKey: 'key:shared' })
    ]
  ]) {
    const index = buildSyntheticAlertIndex(api, [{ Subject: 'same parent', Children: children }]);
    assert.deepStrictEqual(
      indexedChildState(index, 'key', 'key:shared'),
      noState,
      'A duplicate child key transferred state from one alert entity to another'
    );
  }

  const crossParent = buildSyntheticAlertIndex(api, [
    {
      Subject: 'parent A',
      Children: [createSyntheticIndexedChild({ id: 61, markerKey: 'key:parent-a' })]
    },
    {
      Subject: 'parent B',
      Children: [createSyntheticIndexedChild({ id: 61, markerKey: 'key:parent-b', note: true })]
    }
  ]);
  assert.deepStrictEqual(
    indexedChildState(crossParent, 'id', '61'),
    noState,
    'The same child ID under different parent identities was treated as unambiguous'
  );

  const unique = buildSyntheticAlertIndex(api, [{
    Subject: 'unique parent',
    Children: [
      createSyntheticIndexedChild({ id: 71, markerKey: 'key:unique-id', note: true }),
      createSyntheticIndexedChild({ markerKey: 'key:unique-key', note: true })
    ]
  }]);
  assert.deepStrictEqual(indexedChildState(unique, 'id', '71'), {
    note: true,
    oldNoNote: false,
    userComment: true
  }, 'A unique child ID no longer resolved its state');
  assert.deepStrictEqual(indexedChildState(unique, 'key', 'key:unique-key'), {
    note: true,
    oldNoNote: false,
    userComment: true
  }, 'A unique child key no longer resolved its state');
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

async function testRefreshCoordinatorRejoinTracksRotatedToken() {
  const clock = createFakeClock();
  const shared = createSharedCoordination(clock);
  const followerRuntime = { lastError: null };
  let failNextGet = false;
  const followerStorage = {
    get(keys, callback) {
      if (!failNextGet) {
        shared.storage.get(keys, callback);
        return;
      }
      failNextGet = false;
      followerRuntime.lastError = { message: 'synthetic rejoin storage failure' };
      callback({});
      followerRuntime.lastError = null;
    },
    set: shared.storage.set.bind(shared.storage),
    remove: shared.storage.remove.bind(shared.storage)
  };
  const leader = createCoordinatorTab('rejoin-leader', clock, shared);
  const follower = createCoordinatorTab('rejoin-follower', clock, shared, {
    runtime: followerRuntime,
    storage: followerStorage
  });

  leader.coordinator.start();
  await clock.advance(0);
  follower.coordinator.start();
  await clock.advance(0);
  assert.strictEqual(leader.coordinator.getRole(), 'leader');
  assert.strictEqual(follower.coordinator.getRole(), 'follower');

  failNextGet = true;
  shared.storage.set({
    'test-coordinator:token:https://bosun.example.test': 'rejoin-token-b'
  });
  await clock.advance(0);
  await flushMicrotasks();
  await clock.advance(5000);
  await clock.advance(0);
  assert.strictEqual(
    follower.coordinator.getRole(),
    'follower',
    'Follower did not recover coordination after its transient storage failure'
  );

  const appliedBeforeSecondRotation = follower.applied.length;
  shared.storage.set({
    'test-coordinator:token:https://bosun.example.test': 'rejoin-token-c'
  });
  await clock.advance(0);
  await clock.advance(240);
  assert.ok(
    follower.applied.length > appliedBeforeSecondRotation,
    'Follower that rejoined token B stopped receiving snapshots after normal B-to-C rotation'
  );
  assert.deepStrictEqual(
    Array.from(new Set(shared.openChannelNames)),
    ['bosun-helper-alerts:rejoin-token-c'],
    'Old coordination channel remained active after the post-rejoin rotation'
  );

  leader.coordinator.stop();
  follower.coordinator.stop();
  await flushMicrotasks();
  await clock.advance(0);
  assert.strictEqual(shared.openChannelCount, 0, 'Rejoined coordinator did not clean up its channel');
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
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/new-alert-tracker.js'), 'utf8'), context, {
    filename: 'src/bosun/new-alert-tracker.js'
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

async function testNewAlertTrackerUsesStructuredLastActionType() {
  const storageData = {};
  const context = {
    console,
    globalThis: null,
    chrome: { runtime: { lastError: null } },
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Object,
    Array
  };
  context.globalThis = context;
  for (const file of ['src/bosun/alerts-data.js', 'src/bosun/new-alert-tracker.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const storage = {
    get(keys, callback) {
      const result = {};
      for (const key of keys || []) result[key] = storageData[key];
      callback(result);
    },
    set(values, callback) { Object.assign(storageData, values); callback?.(); }
  };
  const alertsApi = context.BosunSilenceHiderAlertsData.createAlertsData({ oldNoNoteMinutes: 60 });
  const tracker = context.BosunHelperNewAlertTracker.createNewAlertTracker({
    storageKey: 'test-last-action-types',
    getStorage: () => storage,
    getLastError: () => null,
    storageChanges: null,
    collectCurrentIdsAndSeverity(payload) {
      const currentIds = new Set(payload.currentIds);
      return {
        currentIds,
        idToSeverity: new Map(Array.from(currentIds, (id) => [id, 'warning']))
      };
    },
    normalizeChildren: (value) => Array.isArray(value) ? value : [],
    getChildStableKey: (child) => `id:${child.State.Id}`,
    getGroupStableKey: () => null,
    hasNoteFromActions: alertsApi.hasNoteFromActions
  });
  await tracker.start();
  const ids = [
    'id:ack-string',
    'id:ack-object',
    'id:close-string',
    'id:unknown-string',
    'id:note-string',
    'id:note-object'
  ];
  await tracker.add(ids, new Map(ids.map((id) => [id, 'warning'])));
  await tracker.reconcile({
    currentIds: ids,
    Groups: {
      NeedAck: [{
        Children: [
          {
            State: {
              Id: 'ack-string',
              LastAction: 'Ack by operator at (2026-09-17 10:00:00): investigate\nNote: copied from runbook'
            }
          },
          {
            State: {
              Id: 'ack-object',
              LastAction: { Type: 'Ack', User: 'operator', Message: 'investigate\nNote: copied from runbook' }
            }
          },
          {
            State: {
              Id: 'close-string',
              LastAction: 'Close by operator at (2026-09-17 10:00:00): resolved\nNote: final context'
            }
          },
          {
            State: {
              Id: 'unknown-string',
              LastAction: 'Arbitrary message body with Note: incidental text'
            }
          },
          {
            State: {
              Id: 'note-string',
              LastAction: 'Note by operator at (2026-09-17 10:00:00): real note'
            }
          },
          {
            State: {
              Id: 'note-object',
              LastAction: { Type: 'Note', User: 'operator', Message: 'real structured note' }
            }
          }
        ]
      }]
    }
  });

  assert.deepStrictEqual(
    storageData['test-last-action-types'].alerts.map((alert) => alert.id).sort(),
    ['id:ack-object', 'id:ack-string', 'id:close-string', 'id:unknown-string'],
    'Tracker inferred Note from message text instead of the LastAction type'
  );
  tracker.destroy();
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
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'src/bosun/new-alert-tracker.js'), 'utf8'),
    context
  );

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
        { matches: [], js: ['config.js', 'src/bosun/content.js'] },
        { matches: [], js: ['config.js', 'src/grafana/grafana-content.js'] }
      ],
      web_accessible_resources: [
        { matches: [], resources: ['assets/sounds/bosun_notification_alert_chime.wav'] },
        { matches: [], resources: ['src/grafana/grafana-page.js'] }
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
    contains: overrides.documentContains || ((node) => node?.isConnected !== false),
    documentElement: overrides.documentElement || {
      contains: overrides.documentContains || ((node) => node?.isConnected !== false)
    },
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
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/grafana/grafana-page.js'), 'utf8'), context, {
    filename: 'src/grafana/grafana-page.js'
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

function createTrackedMonacoModel(initialValue) {
  let value = initialValue;
  let version = 1;
  return {
    api: {
      getValue: () => value,
      getVersionId: () => version,
      setValue(next) {
        value = next;
        version += 1;
      }
    },
    get value() { return value; },
    get version() { return version; },
    replace(next) {
      value = next;
      version += 1;
    }
  };
}

function createMonacoDom() {
  const root = {
    isConnected: true,
    parentElement: null,
    hidden: false,
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    matches(selector) { return selector === '.monaco-editor'; },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement || null;
      }
      return false;
    }
  };
  const textarea = {
    value: '',
    isConnected: true,
    parentElement: root,
    hidden: false,
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    closest(selector) { return selector === '.monaco-editor' ? root : null; },
    focus() {},
    click() {},
    blur() {},
    dispatchEvent() {}
  };
  return { root, textarea };
}

function createGrafanaMonacoHarness(options) {
  let runClicks = 0;
  const doms = options.doms || [createMonacoDom()];
  const getEditors = options.getEditors || (() => options.editors || []);
  const getModels = options.getModels || (() => options.models || []);
  const runButton = {
    textContent: 'Run queries',
    click() { runClicks += 1; }
  };
  const harness = createGrafanaPageContext({
    setTimeout: options.setTimeout,
    monaco: {
      editor: {
        getEditors,
        getModels
      }
    },
    querySelector(selector) {
      if (selector.includes('textarea.inputarea') && doms.length === 1) return doms[0].textarea;
      if (selector.includes('.monaco-editor') && doms.length === 1) return doms[0].root;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return doms.map((dom) => dom.textarea);
      if (selector.includes('.monaco-editor')) return doms.map((dom) => dom.root);
      if (selector === 'button') return [runButton];
      return [];
    }
  });
  return {
    harness,
    doms,
    get runClicks() { return runClicks; }
  };
}

async function testGrafanaRetriesSafePreMutationFailureForSameOperation() {
  const model = createTrackedMonacoModel('up');
  const dom = createMonacoDom();
  const editor = {
    getDomNode: () => dom.root,
    getModel: () => model.api
  };
  let mounted = false;
  const rig = createGrafanaMonacoHarness({
    doms: [dom],
    getEditors: () => mounted ? [editor] : [],
    models: [model.api]
  });
  const deadlineAt = Date.now() + 10_000;

  const first = await dispatchGrafanaApply(
    rig.harness,
    'delayed-editor-operation',
    'sum(new_metric)',
    true,
    deadlineAt
  );
  assert.deepStrictEqual(
    { ok: first?.ok, reason: first?.reason, value: model.value, runClicks: rig.runClicks },
    { ok: false, reason: 'editor-binding-not-found', value: 'up', runClicks: 0 },
    'The first delayed-mount attempt was not a safe pre-mutation failure'
  );

  const collision = await dispatchGrafanaApply(
    rig.harness,
    'delayed-editor-operation',
    'different query',
    true,
    deadlineAt
  );
  assert.strictEqual(collision?.reason, 'operation-id-collision', 'Retryable operation lost collision protection');

  mounted = true;
  const retry = await dispatchGrafanaApply(
    rig.harness,
    'delayed-editor-operation',
    'sum(new_metric)',
    true,
    deadlineAt
  );
  assert.deepStrictEqual(
    { ok: retry?.ok, value: model.value, runClicks: rig.runClicks },
    { ok: true, value: 'sum(new_metric)', runClicks: 1 },
    'The same operationId did not retry after the editor mounted'
  );

  const duplicate = await dispatchGrafanaApply(
    rig.harness,
    'delayed-editor-operation',
    'sum(new_metric)',
    true,
    deadlineAt
  );
  assert.strictEqual(duplicate?.ok, true, 'A completed operation did not retain its final result');
  assert.strictEqual(rig.runClicks, 1, 'A duplicate completed operation clicked Run queries again');

  const expired = await dispatchGrafanaApply(
    rig.harness,
    'expired-operation',
    'sum(expired_metric)',
    true,
    Date.now() - 1
  );
  assert.strictEqual(expired?.ok, false, 'An expired operation was accepted');
  assert.strictEqual(expired?.reason, 'invalid-operation-deadline');
  assert.strictEqual(model.value, 'sum(new_metric)', 'An expired operation mutated the editor');
  assert.strictEqual(rig.runClicks, 1, 'An expired operation clicked Run queries');

  const consumedModel = createTrackedMonacoModel('original query');
  const consumedDom = createMonacoDom();
  let setValueCalls = 0;
  const originalSetValue = consumedModel.api.setValue;
  consumedModel.api.setValue = (value) => {
    setValueCalls += 1;
    originalSetValue(value);
  };
  const consumedEditor = {
    getDomNode: () => consumedDom.root,
    getModel: () => consumedModel.api
  };
  let exposeRunButton = false;
  let consumedRunClicks = 0;
  const runButton = {
    textContent: 'Run queries',
    click() { consumedRunClicks += 1; }
  };
  const consumedHarness = createGrafanaPageContext({
    monaco: { editor: { getEditors: () => [consumedEditor], getModels: () => [consumedModel.api] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [consumedDom.textarea];
      if (selector.includes('.monaco-editor')) return [consumedDom.root];
      if (selector === 'button') return exposeRunButton ? [runButton] : [];
      return [];
    }
  });
  const consumedDeadline = Date.now() + 10_000;
  const terminal = await dispatchGrafanaApply(
    consumedHarness,
    'terminal-after-mutation',
    'consumed query',
    true,
    consumedDeadline
  );
  assert.strictEqual(terminal?.reason, 'run-button-not-found');
  const valueAfterTerminal = consumedModel.value;
  const callsAfterTerminal = setValueCalls;
  exposeRunButton = true;
  const terminalDuplicate = await dispatchGrafanaApply(
    consumedHarness,
    'terminal-after-mutation',
    'consumed query',
    true,
    consumedDeadline
  );
  assert.strictEqual(terminalDuplicate?.reason, 'run-button-not-found');
  assert.strictEqual(consumedModel.value, valueAfterTerminal, 'A consumed terminal operation changed editor state on retry');
  assert.strictEqual(setValueCalls, callsAfterTerminal, 'A consumed terminal operation mutated the editor again');
  assert.strictEqual(consumedRunClicks, 0, 'A consumed terminal operation became executable on retry');

  const unknownModel = createTrackedMonacoModel('original unknown query');
  const unknownDom = createMonacoDom();
  const unknownEditor = {
    getDomNode: () => unknownDom.root,
    getModel: () => unknownModel.api
  };
  let unknownRunAttempts = 0;
  let throwFromRun = true;
  const unknownRunButton = {
    textContent: 'Run queries',
    click() {
      unknownRunAttempts += 1;
      if (throwFromRun) throw new Error('synthetic unknown Run outcome');
    }
  };
  const unknownHarness = createGrafanaPageContext({
    monaco: { editor: { getEditors: () => [unknownEditor], getModels: () => [unknownModel.api] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [unknownDom.textarea];
      if (selector.includes('.monaco-editor')) return [unknownDom.root];
      if (selector === 'button') return [unknownRunButton];
      return [];
    }
  });
  const unknownDeadline = Date.now() + 10_000;
  const unknown = await dispatchGrafanaApply(
    unknownHarness,
    'unknown-run-outcome',
    'unknown outcome query',
    true,
    unknownDeadline
  );
  assert.strictEqual(unknown?.ok, false, 'Unknown Run outcome reported success');
  const unknownReason = unknown?.reason;
  assert.strictEqual(unknownRunAttempts, 1, 'Synthetic unknown Run outcome was not reached');
  throwFromRun = false;
  const unknownDuplicate = await dispatchGrafanaApply(
    unknownHarness,
    'unknown-run-outcome',
    'unknown outcome query',
    true,
    unknownDeadline
  );
  assert.strictEqual(unknownDuplicate?.reason, unknownReason, 'Unknown Run outcome did not retain its final result');
  assert.strictEqual(unknownRunAttempts, 1, 'Unknown Run outcome was executed again automatically');
}

async function settleGrafanaOperationWithTimers(pending, timers, description) {
  let settled = false;
  let outcome;
  let failure;
  pending.then(
    (value) => { settled = true; outcome = value; },
    (error) => { settled = true; failure = error; }
  );

  for (let turn = 0; turn < 20 && !settled; turn += 1) {
    await flushMicrotasks();
    const callback = timers.shift();
    if (callback) callback();
  }
  await flushMicrotasks();
  if (failure) throw failure;
  assert.ok(settled, `${description} did not settle after all deterministic timers were released`);
  return outcome;
}

async function waitForGrafanaTimer(timers, description) {
  for (let turn = 0; turn < 10 && !timers.length; turn += 1) {
    await flushMicrotasks();
  }
  assert.ok(timers.length, `${description} did not reach the expected deferred validation`);
}

async function testGrafanaMonacoUsesVisibleEditorModelBinding() {
  const visible = createTrackedMonacoModel('up');
  const hidden = createTrackedMonacoModel('rate(hidden_total[5m])');
  const dom = createMonacoDom();
  const visibleEditor = {
    getDomNode: () => dom.root,
    getModel: () => visible.api
  };
  let getModelsCalls = 0;
  const rig = createGrafanaMonacoHarness({
    doms: [dom],
    editors: [visibleEditor],
    getModels() {
      getModelsCalls += 1;
      return [visible.api, hidden.api];
    }
  });

  const result = await dispatchGrafanaApply(
    rig.harness,
    'visible-editor-model-binding',
    'sum(new_metric)',
    true
  );

  assert.deepStrictEqual(
    {
      visibleValue: visible.value,
      hiddenValue: hidden.value,
      runClicks: rig.runClicks,
      resultOk: result?.ok
    },
    {
      visibleValue: 'sum(new_metric)',
      hiddenValue: 'rate(hidden_total[5m])',
      runClicks: 1,
      resultOk: true
    },
    'Grafana must mutate and run only the model proven to belong to the visible Monaco editor'
  );
  assert.strictEqual(getModelsCalls, 0, 'Monaco model ownership fell back to getModels() heuristics');
}

async function testGrafanaMonacoRejectsMissingBindingApis() {
  {
    const model = createTrackedMonacoModel('up');
    const dom = createMonacoDom();
    const harness = createGrafanaPageContext({
      monaco: { editor: { getModels: () => [model.api] } },
      querySelectorAll(selector) {
        if (selector.includes('textarea.inputarea')) return [dom.textarea];
        if (selector === '.monaco-editor') return [dom.root];
        return [];
      }
    });
    const result = await dispatchGrafanaApply(
      harness,
      'missing-get-editors',
      'sum(new_metric)',
      true
    );
    assert.strictEqual(model.value, 'up', 'Missing getEditors() still mutated a Monaco model');
    assert.strictEqual(result?.ok, false, 'Missing getEditors() reported success');
  }

  for (const testCase of [
    {
      name: 'missing-dom-node',
      createEditor: (model) => ({ getModel: () => model })
    },
    {
      name: 'null-dom-node',
      createEditor: (model) => ({ getDomNode: () => null, getModel: () => model })
    },
    {
      name: 'missing-get-model',
      createEditor: (_model, dom) => ({ getDomNode: () => dom.root })
    },
    {
      name: 'null-model',
      createEditor: (_model, dom) => ({ getDomNode: () => dom.root, getModel: () => null })
    }
  ]) {
    const model = createTrackedMonacoModel('up');
    const dom = createMonacoDom();
    const editor = testCase.createEditor(model.api, dom);
    const rig = createGrafanaMonacoHarness({
      doms: [dom],
      editors: [editor],
      models: [model.api]
    });
    const result = await dispatchGrafanaApply(
      rig.harness,
      `binding-api-${testCase.name}`,
      'sum(new_metric)',
      true
    );
    assert.strictEqual(model.value, 'up', `${testCase.name} mutated the only Monaco model`);
    assert.strictEqual(rig.runClicks, 0, `${testCase.name} clicked Run queries`);
    assert.strictEqual(result?.ok, false, `${testCase.name} reported success`);
  }
}

async function testGrafanaMonacoRejectsMismatchedDomBinding() {
  const model = createTrackedMonacoModel('up');
  const visibleDom = createMonacoDom();
  const unrelatedDom = createMonacoDom();
  const editor = {
    getDomNode: () => unrelatedDom.root,
    getModel: () => model.api
  };
  const rig = createGrafanaMonacoHarness({
    doms: [visibleDom],
    editors: [editor],
    models: [model.api]
  });
  const result = await dispatchGrafanaApply(
    rig.harness,
    'mismatched-editor-dom',
    'sum(new_metric)',
    true
  );
  assert.strictEqual(model.value, 'up', 'Editor attached to an unrelated DOM root mutated a model');
  assert.strictEqual(rig.runClicks, 0, 'Editor attached to an unrelated DOM root clicked Run queries');
  assert.strictEqual(result?.ok, false);
}

async function testGrafanaMonacoRejectsMultipleVisibleEditorInstances() {
  const first = createTrackedMonacoModel('up');
  const second = createTrackedMonacoModel('other_metric');
  const firstDom = createMonacoDom();
  const secondDom = createMonacoDom();
  const rig = createGrafanaMonacoHarness({
    doms: [firstDom, secondDom],
    editors: [
      { getDomNode: () => firstDom.root, getModel: () => first.api },
      { getDomNode: () => secondDom.root, getModel: () => second.api }
    ],
    models: [first.api, second.api]
  });
  const result = await dispatchGrafanaApply(
    rig.harness,
    'multiple-visible-monaco-editors',
    'sum(new_metric)',
    true
  );
  assert.deepStrictEqual([first.value, second.value], ['up', 'other_metric']);
  assert.strictEqual(rig.runClicks, 0, 'Multiple visible Monaco editors clicked Run queries');
  assert.strictEqual(result?.ok, false);
}

async function testGrafanaMonacoRejectsUninspectableVisibleEditorInstances() {
  for (const kind of ['missing-dom-api', 'mismatched-dom', 'throwing-model', 'null-model']) {
    const selected = createTrackedMonacoModel('up');
    const other = createTrackedMonacoModel('other_metric');
    const dom = createMonacoDom();
    const unrelatedDom = createMonacoDom();
    const validEditor = {
      getDomNode: () => dom.root,
      getModel: () => selected.api
    };
    let unsafeEditor;
    if (kind === 'missing-dom-api') {
      unsafeEditor = { getModel: () => other.api };
    } else if (kind === 'mismatched-dom') {
      unsafeEditor = { getDomNode: () => unrelatedDom.root, getModel: () => other.api };
    } else if (kind === 'throwing-model') {
      unsafeEditor = {
        getDomNode: () => dom.root,
        getModel() { throw new Error('synthetic getModel failure'); }
      };
    } else {
      unsafeEditor = { getDomNode: () => dom.root, getModel: () => null };
    }
    const rig = createGrafanaMonacoHarness({
      doms: [dom],
      editors: [validEditor, unsafeEditor],
      models: [selected.api, other.api]
    });
    const result = await dispatchGrafanaApply(
      rig.harness,
      `uninspectable-visible-editor-${kind}`,
      'sum(new_metric)',
      true
    );
    assert.deepStrictEqual(
      [selected.value, other.value],
      ['up', 'other_metric'],
      `${kind} did not fail closed before Monaco mutation`
    );
    assert.strictEqual(rig.runClicks, 0, `${kind} clicked Run queries`);
    assert.strictEqual(result?.ok, false, `${kind} reported success`);
  }
}

async function testGrafanaMonacoRejectsBindingChangeBeforeMutation() {
  for (const kind of ['model', 'dom']) {
    const initial = createTrackedMonacoModel('up');
    const replacement = createTrackedMonacoModel('rate(hidden_total[5m])');
    const dom = createMonacoDom();
    const unrelatedDom = createMonacoDom();
    let getModelCalls = 0;
    let getDomNodeCalls = 0;
    const editor = {
      getDomNode() {
        getDomNodeCalls += 1;
        return kind === 'dom' && getDomNodeCalls > 1 ? unrelatedDom.root : dom.root;
      },
      getModel() {
        getModelCalls += 1;
        return kind === 'model' && getModelCalls > 1 ? replacement.api : initial.api;
      }
    };
    const rig = createGrafanaMonacoHarness({
      doms: [dom],
      editors: [editor],
      models: [initial.api, replacement.api]
    });
    const result = await dispatchGrafanaApply(
      rig.harness,
      `${kind}-binding-change-before-mutation`,
      'sum(new_metric)',
      true
    );
    assert.deepStrictEqual(
      [initial.value, replacement.value],
      ['up', 'rate(hidden_total[5m])'],
      `A changed pre-mutation ${kind} binding still mutated Monaco state`
    );
    assert.strictEqual(
      rig.runClicks,
      0,
      `A changed pre-mutation ${kind} binding clicked Run queries`
    );
    assert.strictEqual(result?.ok, false);
  }
}

async function testGrafanaMonacoRejectsBindingChangeBeforeRun() {
  for (const kind of ['model', 'dom']) {
    const timers = [];
    const initial = createTrackedMonacoModel('up');
    const replacement = createTrackedMonacoModel('rate(hidden_total[5m])');
    const dom = createMonacoDom();
    const unrelatedDom = createMonacoDom();
    let currentModel = initial.api;
    let currentDom = dom.root;
    const editor = {
      getDomNode: () => currentDom,
      getModel: () => currentModel
    };
    const rig = createGrafanaMonacoHarness({
      doms: [dom],
      editors: [editor],
      models: [initial.api, replacement.api],
      setTimeout(callback) { timers.push(callback); return timers.length; }
    });
    const pending = dispatchGrafanaApply(
      rig.harness,
      `${kind}-binding-change-before-run`,
      'sum(new_metric)',
      true
    );
    await waitForGrafanaTimer(timers, `Monaco ${kind}-binding-change race`);
    if (kind === 'model') currentModel = replacement.api;
    else currentDom = unrelatedDom.root;
    const result = await settleGrafanaOperationWithTimers(
      pending,
      timers,
      `Monaco ${kind}-binding-change race`
    );
    assert.deepStrictEqual(
      [initial.value, replacement.value],
      ['up', 'rate(hidden_total[5m])'],
      `A changed post-mutation ${kind} binding was not safely rolled back`
    );
    assert.strictEqual(
      rig.runClicks,
      0,
      `A changed post-mutation ${kind} binding clicked Run queries`
    );
    assert.strictEqual(result?.ok, false);
  }
}

async function testGrafanaMonacoRejectsConcurrentModelChangeBeforeRun() {
  const timers = [];
  const visible = createTrackedMonacoModel('up');
  const dom = createMonacoDom();
  const editor = {
    getDomNode: () => dom.root,
    getModel: () => visible.api
  };
  const rig = createGrafanaMonacoHarness({
    doms: [dom],
    editors: [editor],
    models: [visible.api],
    setTimeout(callback) { timers.push(callback); return timers.length; }
  });
  const pending = dispatchGrafanaApply(
    rig.harness,
    'concurrent-model-change-before-run',
    'sum(new_metric)',
    true
  );
  await waitForGrafanaTimer(timers, 'Monaco concurrent-edit race');
  visible.replace('concurrent_user_query');
  const result = await settleGrafanaOperationWithTimers(
    pending,
    timers,
    'Monaco concurrent-edit race'
  );
  assert.strictEqual(
    visible.value,
    'concurrent_user_query',
    'Concurrent Monaco text/version change was overwritten during failure handling'
  );
  assert.strictEqual(rig.runClicks, 0, 'Concurrent Monaco text/version change still clicked Run queries');
  assert.strictEqual(result?.ok, false);
}

async function testGrafanaRejectsAmbiguousMonacoModels() {
  const values = ['old query', 'old query'];
  const models = values.map((_value, index) => ({
    getValue: () => values[index],
    getVersionId: () => 1,
    setValue(next) { values[index] = next; }
  }));
  const dom = createMonacoDom();
  const harness = createGrafanaMonacoHarness({
    doms: [dom],
    editors: models.map((model) => ({
      getDomNode: () => dom.root,
      getModel: () => model
    })),
    models
  });

  const result = await dispatchGrafanaApply(harness.harness, 'ambiguous-models', 'new query', false);
  assert.deepStrictEqual(values, ['old query', 'old query'], 'Ambiguous Monaco models were mutated');
  assert.strictEqual(result?.ok, false);

  let modelValue = 'old query';
  const singleModel = {
    getValue: () => modelValue,
    getVersionId: () => 1,
    setValue(next) { modelValue = next; }
  };
  const codeMirrorEditors = [
    { innerText: 'first', textContent: 'first', closest: () => null },
    { innerText: 'second', textContent: 'second', closest: () => null }
  ];
  const singleDom = createMonacoDom();
  const singleEditor = {
    getDomNode: () => singleDom.root,
    getModel: () => singleModel
  };
  const ambiguousDom = createGrafanaPageContext({
    monaco: { editor: { getEditors: () => [singleEditor], getModels: () => [singleModel] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [singleDom.textarea];
      if (selector === '.monaco-editor') return [singleDom.root];
      if (selector.includes('.cm-content')) return codeMirrorEditors;
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
  const monacoDom = createMonacoDom();
  const model = {
    getValue: () => modelText,
    getVersionId: () => 1,
    setValue(next) { modelText = next; }
  };
  const monacoEditor = {
    getDomNode: () => monacoDom.root,
    getModel: () => model
  };
  const mixed = createGrafanaPageContext({
    monaco: { editor: { getEditors: () => [monacoEditor], getModels: () => [model] } },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [monacoDom.textarea];
      if (selector === '.monaco-editor') return [monacoDom.root];
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
    const dom = createMonacoDom();
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
    const editor = { getDomNode: () => dom.root, getModel: () => model };
    const harness = createGrafanaPageContext({
      monaco: { editor: { getEditors: () => [editor], getModels: () => [model] } },
      querySelectorAll(selector) {
        if (selector.includes('textarea.inputarea')) return [dom.textarea];
        if (selector === '.monaco-editor') return [dom.root];
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
  const normalizedDom = createMonacoDom();
  const normalizedEditor = {
    getDomNode: () => normalizedDom.root,
    getModel: () => normalizedModel
  };
  const normalizedHarness = createGrafanaPageContext({
    monaco: {
      editor: {
        getEditors: () => [normalizedEditor],
        getModels: () => [normalizedModel]
      }
    },
    querySelectorAll(selector) {
      if (selector.includes('textarea.inputarea')) return [normalizedDom.textarea];
      if (selector === '.monaco-editor') return [normalizedDom.root];
      return [];
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
  const focusedCase = process.env.BOSUN_HELPER_REGRESSION_CASE || '';
  if (focusedCase) {
    const focusedCases = {
      A05: testRefreshCoordinatorRejoinTracksRotatedToken,
      A13: testSoundUnlockAndNotificationRacesRestoreMuteState
    };
    assert.ok(focusedCases[focusedCase], `Unknown focused regression case: ${focusedCase}`);
    await focusedCases[focusedCase]();
    console.log(`Regression test passed (${focusedCase})`);
    return;
  }
  await testRefreshCoordinatorLeaderFailoverAndStop();
  await testRefreshCoordinatorRejoinTracksRotatedToken();
  await testHiddenFollowerDefersSnapshotsUntilVisible();
  await testHiddenFollowerRejectsSnapshotFromExpiredLeader();
  await testCoordinatorStopAbortsActiveFetch();
  await testSoundUnlockAndNotificationRacesRestoreMuteState();
  await testAlertsDataBoundsAndAbort();
  testAlertsDataRejectsAmbiguousChildIdentities();
  await testRefreshCoordinatorResumesFromBfcache();
  await testVisibleFollowerImmediatelyTakesLeadership();
  await testNewAlertTrackerPersistsUntilNote();
  await testNewAlertTrackerUsesStructuredLastActionType();
  await testNewAlertTrackerRestoreRaceAndSaveRetry();
  await testGrafanaRetriesSafePreMutationFailureForSameOperation();
  await testGrafanaMonacoUsesVisibleEditorModelBinding();
  await testGrafanaMonacoRejectsMissingBindingApis();
  await testGrafanaMonacoRejectsMismatchedDomBinding();
  await testGrafanaMonacoRejectsMultipleVisibleEditorInstances();
  await testGrafanaMonacoRejectsUninspectableVisibleEditorInstances();
  await testGrafanaMonacoRejectsBindingChangeBeforeMutation();
  await testGrafanaMonacoRejectsBindingChangeBeforeRun();
  await testGrafanaMonacoRejectsConcurrentModelChangeBeforeRun();
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
