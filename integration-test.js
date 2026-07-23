'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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

function createHarness(url) {
  const parsedUrl = new URL(url);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storageData = {};
  const postedMessages = [];
  const styleNodes = [];
  const timeoutCallbacks = [];
  const intervalCallbacks = [];
  let fetchCount = 0;
  let observerCount = 0;

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
    removeEventListener() {}
  };

  const location = {
    href: parsedUrl.toString(),
    hostname: parsedUrl.hostname,
    host: parsedUrl.host,
    origin: parsedUrl.origin,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
    reload() {}
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
      removeItem(key) { delete storageData[`session:${key}`]; }
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
  window.window = window;

  const chrome = {
    runtime: {
      getURL(resource) { return `chrome-extension://test/${resource}`; },
      lastError: null
    },
    storage: {
      local: {
        get(keys, callback) {
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
          for (const key of keys || []) delete storageData[key];
          callback?.();
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
    clearInterval() {}
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
    documentListeners,
    windowListeners,
    postedMessages,
    styleNodes,
    timeoutCallbacks,
    intervalCallbacks,
    get fetchCount() { return fetchCount; },
    get observerCount() { return observerCount; }
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function testBosunInitialization() {
  const harness = createHarness('https://bosun.example.com/');
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
}

async function testGrafanaContentIsolation() {
  const harness = createHarness(
    'https://grafana.example.com/d/example/example?editPanel=1'
  );
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

(async () => {
  await testBosunInitialization();
  await testGrafanaContentIsolation();
  await testGrafanaBridgeAuthenticationAndSingleton();
  console.log('Integration test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
