'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { loadConfigFile } = require('./scripts/config-sync');

const runtimeConfig = loadConfigFile('config.js');

function createConfiguredGrafanaUrl(searchParams = {}) {
  const url = new URL(runtimeConfig.grafanaPanelUrl);
  Object.entries(searchParams).forEach(([name, value]) => {
    url.searchParams.set(name, value);
  });
  return url.toString();
}

function createElement(tag = 'div') {
  const attributes = new Map();
  const children = [];
  const classNames = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    dataset: {},
    style: {},
    hidden: false,
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    parentElement: null,
    parentNode: null,
    nextElementSibling: null,
    firstChild: null,
    children,
    classList: {
      add(...names) { names.forEach((name) => classNames.add(name)); },
      remove(...names) { names.forEach((name) => classNames.delete(name)); },
      contains(name) { return classNames.has(name); },
      toggle(name, force) {
        const enabled = typeof force === 'boolean' ? force : !classNames.has(name);
        if (enabled) classNames.add(name);
        else classNames.delete(name);
        return enabled;
      }
    },
    appendChild(child) {
      child.parentElement = this;
      child.parentNode = this;
      children.push(child);
      this.firstChild ||= child;
      return child;
    },
    insertBefore(child) { return this.appendChild(child); },
    insertAdjacentElement(_position, child) { return this.appendChild(child); },
    remove() {},
    close() {},
    focus() {},
    click() {},
    pause() {},
    select() {},
    setSelectionRange() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    removeAttribute(name) { attributes.delete(name); },
    matches() { return false; },
    closest() { return null; },
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 10, height: 10 }; }
  };
}

function createHarness(url, options = {}) {
  const parsedUrl = new URL(url);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storageData = options.storageData || {};
  const postedMessages = [];
  const styleNodes = [];
  const timeoutCallbacks = [];
  const intervalCallbacks = [];
  const clearedIntervals = new Set();
  let fetchCount = 0;
  let observerCount = 0;
  let reloadCount = 0;
  let storageGetCount = 0;

  const body = createElement('body');
  const head = createElement('head');
  head.appendChild = (node) => {
    styleNodes.push(node);
    return node;
  };

  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    activeElement: null,
    body,
    head,
    documentElement: createElement('html'),
    currentScript: null,
    createElement,
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    createRange() {
      return {
        selectNodeContents() {}
      };
    },
    execCommand() { return true; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(name, listener) {
      const list = documentListeners.get(name) || [];
      list.push(listener);
      documentListeners.set(name, list);
    },
    removeEventListener(name, listener) {
      const list = documentListeners.get(name) || [];
      documentListeners.set(name, list.filter((candidate) => candidate !== listener));
    }
  };

  const location = {
    href: parsedUrl.toString(),
    hostname: parsedUrl.hostname,
    host: parsedUrl.host,
    origin: parsedUrl.origin,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
    reload() { reloadCount += 1; }
  };

  const window = {
    document,
    location,
    localStorage: {
      getItem(key) { return storageData[key] ?? null; },
      setItem(key, value) { storageData[key] = String(value); },
      removeItem(key) { delete storageData[key]; }
    },
    sessionStorage: {
      getItem(key) { return storageData[`session:${key}`] ?? null; },
      setItem(key, value) { storageData[`session:${key}`] = String(value); },
      removeItem(key) { delete storageData[`session:${key}`]; },
      get length() {
        return Object.keys(storageData).filter((key) => key.startsWith('session:')).length;
      },
      key(index) {
        const key = Object.keys(storageData).filter((candidate) => candidate.startsWith('session:'))[index];
        return key ? key.slice('session:'.length) : null;
      }
    },
    getSelection() {
      return {
        rangeCount: 0,
        isCollapsed: true,
        toString() { return ''; },
        removeAllRanges() {},
        addRange() {}
      };
    },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
    addEventListener(name, listener) {
      const list = windowListeners.get(name) || [];
      list.push(listener);
      windowListeners.set(name, list);
    },
    removeEventListener(name, listener) {
      const list = windowListeners.get(name) || [];
      windowListeners.set(name, list.filter((candidate) => candidate !== listener));
    },
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin });
    },
    open() { return null; }
  };
  const history = {
    state: null,
    replacedUrls: [],
    replaceState(state, _title, nextUrl) {
      this.state = state;
      this.replacedUrls.push(String(nextUrl));
    }
  };
  window.history = history;
  window.window = window;

  const chrome = {
    runtime: {
      getURL(resource) { return `chrome-extension://test/${resource}`; },
      lastError: null
    },
    storage: {
      local: {
        get(keys, callback) {
          storageGetCount += 1;
          if (keys === null) {
            callback({ ...storageData });
            return;
          }
          const result = {};
          for (const key of keys || []) result[key] = storageData[key];
          callback(result);
        },
        set(values, callback) {
          Object.assign(storageData, values);
          callback?.();
        },
        remove(keys, callback) {
          if (!options.storageRemoveError) {
            for (const key of keys || []) delete storageData[key];
            callback?.();
            return;
          }
          chrome.runtime.lastError = { message: 'synthetic remove failure' };
          callback?.();
          chrome.runtime.lastError = null;
        }
      },
      onChanged: {
        addListener() {}
      }
    }
  };

  function MutationObserver() {
    this.observe = () => { observerCount += 1; };
    this.disconnect = () => {};
  }

  function Audio() {
    this.currentTime = 0;
    this.muted = false;
    this.volume = 1;
    this.play = () => Promise.resolve();
    this.pause = () => {};
  }

  const context = {
    console,
    globalThis: null,
    window,
    document,
    chrome,
    navigator: {
      clipboard: { writeText: async () => {} }
    },
    location,
    history,
    URL,
    URLSearchParams,
    Map,
    Set,
    WeakMap,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    RegExp,
    Array,
    Object,
    Promise,
    Error,
    Audio,
    MutationObserver,
    Event: function Event(name, init) { this.type = name; Object.assign(this, init || {}); },
    InputEvent: function InputEvent(name, init) { this.type = name; Object.assign(this, init || {}); },
    KeyboardEvent: function KeyboardEvent(name, init) { this.type = name; Object.assign(this, init || {}); },
    AbortController,
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ Groups: { NeedAck: [] } })
      };
    },
    XMLHttpRequest: function XMLHttpRequest() {},
    requestAnimationFrame(callback) {
      callback?.();
      return 1;
    },
    setTimeout(callback, delay) {
      timeoutCallbacks.push({ callback, delay });
      return timeoutCallbacks.length;
    },
    clearTimeout() {},
    setInterval(callback, delay) {
      intervalCallbacks.push({ callback, delay });
      return intervalCallbacks.length;
    },
    clearInterval(id) { clearedIntervals.add(id); }
  };
  context.globalThis = context;
  window.chrome = chrome;
  window.navigator = context.navigator;
  window.fetch = context.fetch;
  window.MutationObserver = MutationObserver;
  window.Event = context.Event;
  window.InputEvent = context.InputEvent;
  window.KeyboardEvent = context.KeyboardEvent;
  window.requestAnimationFrame = context.requestAnimationFrame;

  return {
    context,
    document,
    window,
    location,
    history,
    documentListeners,
    windowListeners,
    postedMessages,
    storageData,
    styleNodes,
    timeoutCallbacks,
    intervalCallbacks,
    get fetchCount() { return fetchCount; },
    get reloadCount() { return reloadCount; },
    get storageGetCount() { return storageGetCount; },
    get observerCount() { return observerCount; },
    get clearedIntervals() { return clearedIntervals; }
  };
}

function runFiles(harness, files) {
  for (const file of files) {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), harness.context, {
      filename: file
    });
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function testBosunInitialization() {
  const configuredHost = loadConfigFile('config.js').bosunHosts[0];
  const harness = createHarness(`https://${configuredHost}/`);
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  runFiles(harness, manifest.content_scripts[0].js);

  const domReadyListeners = harness.documentListeners.get('DOMContentLoaded') || [];
  assert.strictEqual(domReadyListeners.length, 1, 'Bosun init listener was not installed');
  domReadyListeners[0]();
  await flushMicrotasks();

  assert.strictEqual(harness.fetchCount, 1, 'Initial alerts request was not sent exactly once');
  assert.ok(harness.observerCount >= 1, 'Dashboard MutationObserver was not installed');
  assert.ok(harness.styleNodes.some((node) => node.id === 'bosun-silence-hider-styles'));
  assert.strictEqual(harness.intervalCallbacks.length, 1, 'Only the activity interval should be active');

  const oneSecondFallback = harness.timeoutCallbacks.find((entry) => entry.delay === 1000);
  const timeoutCountBeforeFallback = harness.timeoutCallbacks.length;
  oneSecondFallback?.callback();
  const queuedRefresh = harness.timeoutCallbacks
    .slice(timeoutCountBeforeFallback)
    .find((entry) => entry.delay === 100);
  queuedRefresh?.callback();
  await flushMicrotasks();
  assert.strictEqual(
    harness.fetchCount,
    1,
    'Successful initial snapshot must not be followed by an unconditional one-second fetch'
  );

  const soundOptions = {
    alertFile: 'alert.wav',
    softFile: 'soft.wav',
    getEnabled: () => true,
    reportDiagnostics() {},
    crossTabStorageKey: 'integration-sound-claim'
  };
  const firstSound = harness.context.BosunSilenceHiderSound.createSound(soundOptions);
  const secondSound = harness.context.BosunSilenceHiderSound.createSound(soundOptions);
  assert.strictEqual(firstSound.claimCrossTabPlayback('alert'), true);
  assert.strictEqual(secondSound.claimCrossTabPlayback('alert'), false);
  harness.window.localStorage.setItem(
    soundOptions.crossTabStorageKey,
    JSON.stringify({ at: Date.now() + 60_000, kind: 'alert', token: 'poisoned' })
  );
  const recoveredSound = harness.context.BosunSilenceHiderSound.createSound(soundOptions);
  assert.strictEqual(recoveredSound.claimCrossTabPlayback('alert'), true, 'Future timestamp must not suppress sound');

  let autoRefreshEnabled = true;
  let activityAt = Date.now();
  const timeoutCountBeforeToggle = harness.timeoutCallbacks.length;
  const activity = harness.context.BosunSilenceHiderActivity.createActivityTracker({
    pageUtils: { isDashboardHome: () => true },
    getAutoRefreshEnabled: () => autoRefreshEnabled,
    setAutoRefreshEnabled: (value) => { autoRefreshEnabled = value; },
    getAutoRefreshIdleSeconds: () => 60,
    getLastUserActivityTs: () => activityAt,
    setLastUserActivityTs: (value) => { activityAt = value; },
    getLastKnownUrl: () => harness.location.href,
    setLastKnownUrl() {},
    saveAutoRefreshState() {},
    updateAutoRefreshControls() {},
    autoRefreshForceReenableMs: 0
  });
  activity.handleCountdownClick();
  assert.strictEqual(autoRefreshEnabled, false);
  assert.strictEqual(
    harness.timeoutCallbacks.length,
    timeoutCountBeforeToggle,
    'Permanent auto-refresh off must not schedule forced re-enable'
  );
  activity.handleCountdownClick();
  assert.strictEqual(autoRefreshEnabled, true);
  activityAt = Date.now() - 61_000;
  activity.startAutoRefreshLoop(() => {});
  const autoRefreshTick = harness.intervalCallbacks.at(-1).callback;
  harness.document.visibilityState = 'hidden';
  autoRefreshTick();
  assert.strictEqual(harness.reloadCount, 0, 'Hidden dashboard must not auto-reload');
  harness.document.visibilityState = 'visible';
  autoRefreshTick();
  assert.strictEqual(harness.reloadCount, 1, 'Visible idle dashboard must still auto-reload');
}

async function testGrafanaContentIsolation() {
  const harness = createHarness(createConfiguredGrafanaUrl());
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  runFiles(harness, manifest.content_scripts[1].js);

  const domReadyListeners = harness.documentListeners.get('DOMContentLoaded') || [];
  assert.strictEqual(domReadyListeners.length, 1, 'Grafana init listener was not installed');
  domReadyListeners[0]();
  await flushMicrotasks();

  assert.strictEqual(harness.fetchCount, 0, 'Grafana page must not call the Bosun API');
  assert.strictEqual(harness.observerCount, 0, 'Grafana page must not install Bosun observers');
  assert.strictEqual(harness.intervalCallbacks.length, 0, 'Grafana page must not start Bosun intervals');
  assert.strictEqual(harness.styleNodes.length, 0, 'Grafana page must not inject Bosun styles');
}

async function testGrafanaContentRequiresExactConfiguredPanel() {
  const configuredUrl = new URL(createConfiguredGrafanaUrl({ bosunHelperRequest: 'request-1' }));
  const wrongUrl = new URL(configuredUrl);
  const configuredPanelId = configuredUrl.searchParams.get('editPanel');
  wrongUrl.searchParams.set('editPanel', configuredPanelId === '999999' ? '999998' : '999999');

  const wrongPanel = createHarness(wrongUrl.toString());
  runFiles(wrongPanel, ['config.js', 'grafana-content.js']);
  wrongPanel.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await flushMicrotasks();
  assert.strictEqual(wrongPanel.storageGetCount, 0, 'Wrong Grafana panel must not read pending query storage');

  const configuredPanel = createHarness(configuredUrl.toString());
  runFiles(configuredPanel, ['config.js', 'grafana-content.js']);
  configuredPanel.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await flushMicrotasks();
  assert.strictEqual(configuredPanel.storageGetCount, 1, 'Configured Grafana panel must load its pending query');
}

async function testGrafanaContentPassesCreatedAtHardDeadline() {
  const createdAt = Date.now() - 115_000;
  const requestId = 'deadline-request';
  const harness = createHarness(createConfiguredGrafanaUrl({ bosunHelperRequest: requestId }));
  harness.storageData[`bosunGrafanaPendingQueryV2:${requestId}`] = {
    query: 'up',
    run: true,
    createdAt
  };
  runFiles(harness, ['config.js', 'grafana-content.js']);
  harness.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await flushMicrotasks();

  const applyMessage = harness.postedMessages.find(({ message }) => {
    return message.type === 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  })?.message;
  assert.ok(applyMessage, 'Grafana content bridge did not send apply request');
  assert.strictEqual(
    applyMessage.deadlineAt,
    createdAt + 120_000,
    'Page bridge did not receive the hard deadline derived from pending createdAt'
  );
}

async function testGrafanaContentConsumesOnceAndVerifiesUniqueVisibleRoot() {
  function createEditorNode(text, options = {}) {
    const ancestor = options.hiddenAncestor ? { hidden: true, parentElement: null } : null;
    const root = {
      hidden: false,
      isConnected: true,
      parentElement: ancestor,
      getAttribute() { return null; },
      getClientRects() { return [{}]; }
    };
    const node = {
      innerText: text,
      textContent: text,
      isConnected: true,
      parentElement: root,
      getAttribute() { return null; },
      getClientRects() { return [{}]; },
      closest() { return root; }
    };
    return { node, root };
  }

  async function reportApplySuccess(harness) {
    await flushMicrotasks();
    const apply = harness.postedMessages.find(({ message }) => {
      return message.type === 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
    })?.message;
    assert.ok(apply, 'Expected Grafana APPLY message');
    for (const listener of harness.windowListeners.get('message') || []) {
      listener({
        source: harness.window,
        origin: harness.location.origin,
        data: {
          type: 'BOSUN_HELPER_GRAFANA_QUERY_RESULT',
          channelToken: apply.channelToken,
          requestId: apply.requestId,
          operationId: apply.operationId,
          result: { ok: true }
        }
      });
    }
    await flushMicrotasks();
    return apply;
  }

  const sharedStorage = {};
  const requestId = 'consume-once';
  const pendingKey = `bosunGrafanaPendingQueryV2:${requestId}`;
  const markerNow = Date.now();
  for (let index = 0; index < 55; index += 1) {
    sharedStorage[`session:bosunGrafanaConsumedRequestV2:older-${index}`] = JSON.stringify({
      consumedAt: markerNow - 1000 + index,
      expiresAt: markerNow + 60_000
    });
  }
  sharedStorage[pendingKey] = { query: 'up', run: true, createdAt: markerNow };
  const targetUrl = createConfiguredGrafanaUrl({ bosunHelperRequest: requestId });
  const first = createHarness(targetUrl, {
    storageData: sharedStorage,
    storageRemoveError: true
  });
  const visible = createEditorNode('up');
  const hidden = createEditorNode('up', { hiddenAncestor: true });
  const zeroRect = createEditorNode('up');
  zeroRect.node.getClientRects = () => [];
  first.document.querySelectorAll = (selector) => {
    return selector.includes('.cm-content') ? [visible.node, hidden.node, zeroRect.node] : [];
  };
  runFiles(first, ['config.js', 'grafana-content.js']);
  const firstInit = first.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await reportApplySuccess(first);
  await firstInit;

  const consumedEntries = Object.entries(sharedStorage).filter(([key]) => {
    return key.startsWith('session:bosunGrafanaConsumedRequestV2:');
  });
  assert.strictEqual(consumedEntries.length, 50, 'Consumed request markers were not physically bounded');
  assert.ok(
    consumedEntries.some(([key]) => key.endsWith(`:${requestId}`)),
    'Successful request was not logically consumed'
  );
  assert.ok(
    consumedEntries.every(([, value]) => !value.includes('up')),
    'Consumed marker stored query data'
  );
  assert.ok(sharedStorage[pendingKey], 'Synthetic remove failure did not preserve pending record');
  assert.strictEqual(first.history.replacedUrls.length, 1, 'Request URL was not sanitized');
  assert.ok(!first.history.replacedUrls[0].includes('bosunHelperRequest='));

  const reload = createHarness(targetUrl, {
    storageData: sharedStorage,
    storageRemoveError: true
  });
  reload.document.querySelectorAll = first.document.querySelectorAll;
  runFiles(reload, ['config.js', 'grafana-content.js']);
  await reload.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await flushMicrotasks();
  assert.strictEqual(
    reload.postedMessages.some(({ message }) => message.type === 'BOSUN_HELPER_APPLY_GRAFANA_QUERY'),
    false,
    'Logically consumed request was applied again after reload'
  );

  const ambiguousRequest = 'ambiguous-visible-roots';
  const ambiguousKey = `bosunGrafanaPendingQueryV2:${ambiguousRequest}`;
  sharedStorage[ambiguousKey] = { query: 'up', run: false, createdAt: Date.now() };
  const ambiguous = createHarness(
    targetUrl.replace(requestId, ambiguousRequest),
    { storageData: sharedStorage }
  );
  const secondVisible = createEditorNode('different');
  ambiguous.document.querySelectorAll = (selector) => {
    if (selector.includes('.cm-content')) return [visible.node];
    if (selector.includes('textarea.inputarea')) return [secondVisible.node];
    return [];
  };
  runFiles(ambiguous, ['config.js', 'grafana-content.js']);
  ambiguous.documentListeners.get('DOMContentLoaded')?.[0]?.();
  await reportApplySuccess(ambiguous);
  assert.ok(sharedStorage[ambiguousKey], 'Multiple visible editor roots produced false success');
}

async function testGrafanaBridgeAuthenticationAndSingleton() {
  const harness = createHarness('https://grafana.example.com/d/test?editPanel=1');
  const bridgeScript = createElement('script');
  bridgeScript.dataset.channelToken = 'secret-token';
  harness.document.currentScript = bridgeScript;

  runFiles(harness, ['grafana-page.js']);
  harness.document.currentScript = bridgeScript;
  runFiles(harness, ['grafana-page.js']);

  const listeners = harness.windowListeners.get('message') || [];
  assert.strictEqual(listeners.length, 1, 'Grafana bridge must install only one message listener');

  const baseEvent = {
    source: harness.window,
    origin: harness.location.origin,
    data: {
      type: 'BOSUN_HELPER_APPLY_GRAFANA_QUERY',
      requestId: 'request-1',
      query: 'up'
    }
  };

  await listeners[0]({
    ...baseEvent,
    data: { ...baseEvent.data, channelToken: 'wrong-token' }
  });
  const beforeValidRequest = harness.postedMessages.length;

  await listeners[0]({
    ...baseEvent,
    data: { ...baseEvent.data, channelToken: 'secret-token' }
  });
  await flushMicrotasks();

  assert.strictEqual(
    harness.postedMessages.length,
    beforeValidRequest + 1,
    'Authenticated bridge request must produce one response'
  );
  const response = harness.postedMessages.at(-1);
  assert.strictEqual(response.targetOrigin, harness.location.origin);
  assert.strictEqual(response.message.channelToken, 'secret-token');
  assert.strictEqual(response.message.requestId, 'request-1');
}

function createActionPageHarness() {
  let currentTextarea = null;
  let templateWrap = null;
  let observerCallback = null;
  const scheduled = [];

  function element(tag = 'div') {
    const listeners = new Map();
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      dataset: {},
      style: {},
      className: '',
      value: '',
      checked: false,
      offsetParent: {},
      parentElement: null,
      parentNode: null,
      nextElementSibling: null,
      children: [],
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; }
      },
      appendChild(child) {
        child.parentElement = this;
        child.parentNode = this;
        this.children.push(child);
        relink(this);
        return child;
      },
      insertBefore(child, reference) {
        const previousParent = child.parentElement;
        if (previousParent) {
          previousParent.children = previousParent.children.filter((item) => item !== child);
          relink(previousParent);
        }
        const index = this.children.indexOf(reference);
        child.parentElement = this;
        child.parentNode = this;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        if (child.className === 'bosun-action-templates') templateWrap = child;
        relink(this);
        return child;
      },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
          relink(this.parentElement);
        }
        this.parentElement = null;
        this.parentNode = null;
      },
      addEventListener(name, listener) {
        const list = listeners.get(name) || [];
        list.push(listener);
        listeners.set(name, list);
      },
      dispatchEvent(event) {
        event.target ||= this;
        event.preventDefault ||= () => {};
        event.stopPropagation ||= () => {};
        for (const listener of listeners.get(event.type) || []) listener.call(this, event);
        return true;
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      focus() { document.activeElement = this; },
      setSelectionRange() {},
      setAttribute() {},
      getAttribute() { return null; },
      removeAttribute() {},
      matches() { return false; },
      closest() { return null; },
      contains(candidate) {
        return this.children.includes(candidate) || this.children.some((child) => child.contains?.(candidate));
      },
      querySelector(selector) {
        return findDescendant(this, (candidate) => matchesSelector(candidate, selector));
      },
      querySelectorAll(selector) {
        return findAllDescendants(this, (candidate) => matchesSelector(candidate, selector));
      }
    };
    Object.defineProperty(node, 'textContent', {
      get() { return this._textContent || ''; },
      set(value) {
        this._textContent = String(value);
        if (value === '') {
          for (const child of this.children) {
            child.parentElement = null;
            child.parentNode = null;
          }
          this.children = [];
          relink(this);
        }
      }
    });
    return node;
  }

  function relink(parent) {
    parent.children.forEach((child, index) => {
      child.nextElementSibling = parent.children[index + 1] || null;
    });
  }

  function matchesSelector(node, selector) {
    if (selector === '.bosun-action-templates') return node.className === 'bosun-action-templates';
    if (selector === '.bosun-action-template-btn') return node.className === 'bosun-action-template-btn';
    return false;
  }

  function findDescendant(root, predicate) {
    for (const child of root.children) {
      if (predicate(child)) return child;
      const nested = findDescendant(child, predicate);
      if (nested) return nested;
    }
    return null;
  }

  function findAllDescendants(root, predicate) {
    const result = [];
    for (const child of root.children) {
      if (predicate(child)) result.push(child);
      result.push(...findAllDescendants(child, predicate));
    }
    return result;
  }

  const body = element('body');
  const documentElement = element('html');
  const textareaParent = element('div');
  currentTextarea = element('textarea');
  textareaParent.appendChild(currentTextarea);
  body.appendChild(textareaParent);

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    body,
    documentElement,
    head: element('head'),
    createElement(tag) {
      const created = element(tag);
      if (String(tag).toLowerCase() === 'div') {
        const originalAppend = created.appendChild;
        created.appendChild = function appendAndTrack(child) {
          const result = originalAppend.call(this, child);
          if (this.className === 'bosun-action-templates') templateWrap = this;
          return result;
        };
      }
      return created;
    },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    getElementById() { return null; },
    querySelector(selector) {
      if (selector === '.bosun-action-templates') return templateWrap?.parentElement ? templateWrap : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') return currentTextarea ? [currentTextarea] : [];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; }
  };

  const location = {
    href: 'https://bosun.example.test/action?type=note',
    host: 'bosun.example.test',
    hostname: 'bosun.example.test',
    origin: 'https://bosun.example.test',
    pathname: '/action',
    search: '?type=note',
    reload() {}
  };
  const window = {
    document,
    location,
    addEventListener() {},
    removeEventListener() {},
    getSelection() { return { toString() { return ''; } }; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    open() { return null; }
  };
  window.window = window;

  const chrome = {
    runtime: { lastError: null, getURL: (value) => value },
    storage: {
      local: {
        get(keys, callback) { callback(keys === null ? {} : {}); },
        set(_values, callback) { callback?.(); },
        remove(_keys, callback) { callback?.(); }
      },
      onChanged: { addListener() {} }
    }
  };
  function MutationObserver(callback) {
    observerCallback = callback;
    this.observe = () => {};
    this.disconnect = () => {};
  }

  const context = {
    console: { ...console, warn() {} },
    globalThis: null,
    window,
    document,
    location,
    chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    Map,
    Set,
    WeakMap,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    RegExp,
    Array,
    Object,
    Promise,
    Error,
    MutationObserver,
    Event: function Event(type, init) { this.type = type; Object.assign(this, init || {}); },
    InputEvent: function InputEvent(type, init) { this.type = type; Object.assign(this, init || {}); },
    requestAnimationFrame(callback) { callback?.(); return 1; },
    setTimeout(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ Groups: { NeedAck: [] } }) }),
    XMLHttpRequest: function XMLHttpRequest() {},
    AbortController
  };
  context.globalThis = context;
  context.BosunHelperLocalConfig = {
    bosunHosts: ['bosun.example.test'],
    grafanaHost: 'grafana.example.test',
    grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
  };
  context.BosunSilenceHiderPageUtils = {
    createPageUtils() {
      return {
        isActionPage: () => true,
        isDashboardHome: () => false,
        applyActionPageTweaks() {}
      };
    }
  };
  context.BosunHelperRefreshCoordinator = {
    createRefreshCoordinator() {
      return { start() {}, stop() {}, requestRefresh() {} };
    }
  };
  window.chrome = chrome;
  window.navigator = context.navigator;
  window.MutationObserver = MutationObserver;
  window.Event = context.Event;
  window.InputEvent = context.InputEvent;
  window.requestAnimationFrame = context.requestAnimationFrame;

  return {
    context,
    body,
    textareaParent,
    scheduled,
    get textarea() { return currentTextarea; },
    get wrap() { return templateWrap; },
    replaceTextarea() {
      const old = currentTextarea;
      old.remove();
      currentTextarea = element('textarea');
      textareaParent.appendChild(currentTextarea);
      observerCallback?.([{
        type: 'childList',
        target: body,
        addedNodes: [currentTextarea],
        removedNodes: [old]
      }]);
      return { old, replacement: currentTextarea };
    }
  };
}

async function testActionTemplatesFollowTextareaRemount() {
  const harness = createActionPageHarness();
  runFiles(harness, ['settings.js', 'action-templates.js', 'content.js']);
  await flushMicrotasks();

  const initialWrap = harness.wrap;
  assert.ok(initialWrap, 'Action templates were not mounted');
  assert.strictEqual(initialWrap.nextElementSibling, harness.textarea);

  const { old, replacement } = harness.replaceTextarea();
  const refresh = harness.scheduled.find((entry) => entry.delay === 120);
  assert.ok(refresh, 'Textarea replacement did not schedule a DOM refresh');
  refresh.callback();

  assert.strictEqual(harness.wrap, initialWrap, 'Template wrapper should be reused');
  assert.strictEqual(harness.wrap.nextElementSibling, replacement);
  const buttons = harness.wrap.querySelectorAll('.bosun-action-template-btn');
  assert.ok(buttons.length > 0, 'Template buttons were not rebuilt');
  buttons[0].click();

  assert.strictEqual(old.value, '', 'Detached textarea was modified');
  assert.strictEqual(replacement.value, buttons[0].textContent, 'Replacement textarea did not receive the template');
  assert.strictEqual(harness.context.document.activeElement, replacement);
}

async function testFeatureModuleLifecycleCleanup() {
  const activityHarness = createHarness('https://bosun.example.com/');
  runFiles(activityHarness, ['activity.js']);
  let enabled = true;
  let lastActivity = Date.now();
  let lastUrl = activityHarness.location.href;
  const activity = activityHarness.context.BosunSilenceHiderActivity.createActivityTracker({
    pageUtils: { isDashboardHome: () => true },
    getAutoRefreshEnabled: () => enabled,
    setAutoRefreshEnabled(value) { enabled = value; },
    getAutoRefreshIdleSeconds: () => 60,
    getLastUserActivityTs: () => lastActivity,
    setLastUserActivityTs(value) { lastActivity = value; },
    getLastKnownUrl: () => lastUrl,
    setLastKnownUrl(value) { lastUrl = value; },
    autoRefreshForceReenableMs: 0
  });
  activity.installUserActivityTracking();
  activity.installUserActivityTracking();
  activity.startAutoRefreshLoop(() => {});
  activity.startAutoRefreshLoop(() => {});
  for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']) {
    assert.strictEqual((activityHarness.windowListeners.get(eventName) || []).length, 1, `${eventName} listener duplicated`);
  }
  assert.strictEqual(activityHarness.intervalCallbacks.length, 1, 'Auto-refresh interval duplicated');
  activity.destroy();
  for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']) {
    assert.strictEqual((activityHarness.windowListeners.get(eventName) || []).length, 0, `${eventName} listener leaked`);
  }
  assert.strictEqual((activityHarness.documentListeners.get('visibilitychange') || []).length, 0);
  assert.ok(activityHarness.clearedIntervals.has(1), 'Auto-refresh interval was not cleared');

  const soundHarness = createHarness('https://bosun.example.com/');
  runFiles(soundHarness, ['sound.js']);
  const sound = soundHarness.context.BosunSilenceHiderSound.createSound({
    alertFile: 'alert.wav',
    softFile: 'soft.wav',
    getEnabled: () => true,
    reportDiagnostics() {}
  });
  sound.installAudioUnlockTracking();
  sound.installAudioUnlockTracking();
  sound.scheduleNeedAckChimeRetry('alert', 'NotAllowedError');
  assert.strictEqual((soundHarness.windowListeners.get('pointerdown') || []).length, 2);
  assert.strictEqual((soundHarness.windowListeners.get('keydown') || []).length, 2);
  sound.destroy();
  assert.strictEqual((soundHarness.windowListeners.get('pointerdown') || []).length, 0);
  assert.strictEqual((soundHarness.windowListeners.get('keydown') || []).length, 0);
}

async function testNewAlertTrackerDestroyInvalidatesAsyncWork() {
  const restoreHarness = createHarness('https://bosun.example.com/');
  let restoreCallback = null;
  restoreHarness.context.chrome.storage.local.get = (_keys, callback) => { restoreCallback = callback; };
  const restoreNotifications = [];
  runFiles(restoreHarness, ['new-alert-tracker.js']);
  const restoring = restoreHarness.context.BosunHelperNewAlertTracker.createNewAlertTracker({
    onChange(value) { restoreNotifications.push(value); }
  });
  const restorePromise = restoring.start();
  restoring.destroy();
  restoreCallback({ bosunNewAlertsAwaitingNoteV1: {
    version: 1,
    alerts: [{ id: 'late', severity: 'warning', detectedAt: Date.now() }]
  } });
  await restorePromise;
  assert.strictEqual(restoreNotifications.length, 0, 'Late restore mutated tracker after destroy');

  const writeHarness = createHarness('https://bosun.example.com/');
  const setCallbacks = [];
  let storageWrites = 0;
  writeHarness.context.chrome.storage.local.get = (_keys, callback) => callback({});
  writeHarness.context.chrome.storage.local.set = (_values, callback) => {
    storageWrites += 1;
    setCallbacks.push(callback);
  };
  runFiles(writeHarness, ['new-alert-tracker.js']);
  const writing = writeHarness.context.BosunHelperNewAlertTracker.createNewAlertTracker();
  await writing.start();
  await writing.add(['A'], new Map([['A', 'warning']]));
  await writing.add(['B'], new Map([['B', 'critical']]));
  assert.strictEqual(storageWrites, 1);
  writing.destroy();
  setCallbacks[0]();
  await flushMicrotasks();
  assert.strictEqual(storageWrites, 1, 'Late write callback flushed queued tracker state after destroy');
}

async function testGrafanaHandoffDestroyCancelsDelayedSave() {
  const harness = createHarness('https://bosun.example.com/');
  const pending = {};
  let saveCallback = null;
  const removed = [];
  let popupClosed = 0;
  let navigated = 0;
  harness.window.confirm = () => true;
  harness.window.open = () => ({
    opener: harness.window,
    close() { popupClosed += 1; },
    location: { replace() { navigated += 1; } }
  });
  harness.context.chrome.storage.local.set = (values, callback) => {
    Object.assign(pending, values);
    saveCallback = callback;
  };
  harness.context.chrome.storage.local.remove = (keys, callback) => {
    removed.push(...keys);
    for (const key of keys) delete pending[key];
    callback?.();
  };
  runFiles(harness, ['grafana-handoff.js']);
  const handoff = harness.context.BosunHelperGrafanaHandoff.createGrafanaHandoff({
    config: {
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    },
    getStorage: () => harness.context.chrome.storage.local,
    getLastError: () => null
  });
  const opening = handoff.openQuery('up', null);
  while (!saveCallback) await Promise.resolve();
  const requestKey = Object.keys(pending).find((key) => key.startsWith('bosunGrafanaPendingQueryV2:'));
  assert.ok(requestKey, 'Delayed Grafana request was not staged');
  handoff.destroy();
  saveCallback();
  assert.strictEqual(await opening, false);
  assert.strictEqual(popupClosed, 1, 'In-flight Grafana popup was not closed');
  assert.strictEqual(navigated, 0, 'Disabled Grafana integration navigated after delayed save');
  assert.ok(removed.includes(requestKey), 'Disabled Grafana integration did not clean the staged request');
}

(async () => {
  await testBosunInitialization();
  await testGrafanaContentIsolation();
  await testGrafanaContentRequiresExactConfiguredPanel();
  await testGrafanaContentPassesCreatedAtHardDeadline();
  await testGrafanaContentConsumesOnceAndVerifiesUniqueVisibleRoot();
  await testGrafanaBridgeAuthenticationAndSingleton();
  await testActionTemplatesFollowTextareaRemount();
  await testFeatureModuleLifecycleCleanup();
  await testNewAlertTrackerDestroyInvalidatesAsyncWork();
  await testGrafanaHandoffDestroyCancelsDelayedSave();
  console.log('Integration test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
