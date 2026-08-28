'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDomHarness() {
  class EventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((value) => value !== listener));
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      event.currentTarget = this;
      for (const listener of (this.listeners.get(event.type) || []).slice()) listener.call(this, event);
      if (event.bubbles && !event.propagationStopped && this.parentElement) this.parentElement.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    listenerCount(type) { return (this.listeners.get(type) || []).length; }
  }

  class ClassList {
    constructor(owner) { this.owner = owner; this.values = new Set(); }
    set(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
    add(...values) { values.forEach((value) => this.values.add(value)); }
    remove(...values) { values.forEach((value) => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
      const enabled = force === undefined ? !this.contains(value) : Boolean(force);
      if (enabled) this.add(value); else this.remove(value);
      return enabled;
    }
    toString() { return Array.from(this.values).join(' '); }
  }

  function dataName(attribute) {
    return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  }

  function matches(element, selector) {
    selector = selector.trim();
    if (!selector) return false;
    const notDisabled = selector.endsWith(':not([disabled])');
    const notNegativeTab = selector.endsWith(':not([tabindex="-1"])');
    if (notDisabled) selector = selector.slice(0, -16);
    if (notNegativeTab) selector = selector.slice(0, -22);
    if ((notDisabled && element.disabled) || (notNegativeTab && String(element.tabIndex) === '-1')) return false;
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
    const attributeMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attributeMatch) {
      const [, name, expected] = attributeMatch;
      const actual = name.startsWith('data-') ? element.dataset[dataName(name)] : element.getAttribute(name);
      return expected === undefined ? actual !== undefined && actual !== null : String(actual) === expected;
    }
    return element.tagName === selector.toUpperCase();
  }

  function descendants(root) {
    const result = [];
    for (const child of root.children) {
      result.push(child, ...descendants(child));
    }
    return result;
  }

  class Element extends EventTarget {
    constructor(tagName, document) {
      super();
      this.ownerDocument = document;
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.classList = new ClassList(this);
      this.dataset = {};
      this.attributes = new Map();
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.type = '';
      this.id = '';
      this.tabIndex = 0;
      this.textContent = '';
    }
    get className() { return this.classList.toString(); }
    set className(value) { this.classList.set(value); }
    get firstChild() { return this.children[0] || null; }
    get isConnected() {
      for (let node = this; node; node = node.parentElement) if (node === this.ownerDocument.body) return true;
      return false;
    }
    appendChild(child) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }
    contains(candidate) {
      return candidate === this || descendants(this).includes(candidate);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
      if (name === 'tabindex') this.tabIndex = Number(value);
    }
    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name === 'tabindex') return String(this.tabIndex);
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map((value) => value.trim());
      return descendants(this).filter((candidate) => selectors.some((value) => matches(candidate, value)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
      return null;
    }
    focus() { this.ownerDocument.activeElement = this; }
    click() {
      if (this.disabled) return;
      if (this.type === 'checkbox') this.checked = !this.checked;
      this.dispatchEvent(createEvent('click', { bubbles: true }));
      if (this.type === 'checkbox') this.dispatchEvent(createEvent('change', { bubbles: true }));
    }
  }

  class Document extends EventTarget {
    constructor() {
      super();
      this.body = new Element('body', this);
      this.activeElement = this.body;
    }
    createElement(tagName) { return new Element(tagName, this); }
    getElementById(id) { return [this.body, ...descendants(this.body)].find((node) => node.id === id) || null; }
    querySelectorAll(selector) {
      const descendantSelector = selector.match(/^#([^ ]+) (.+)$/);
      if (descendantSelector) return this.getElementById(descendantSelector[1])?.querySelectorAll(descendantSelector[2]) || [];
      return this.body.querySelectorAll(selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  function createEvent(type, options = {}) {
    return {
      type,
      key: options.key,
      shiftKey: Boolean(options.shiftKey),
      bubbles: Boolean(options.bubbles),
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }
    };
  }

  const document = new Document();
  const toolbar = document.createElement('div');
  toolbar.id = 'toolbar';
  const actions = document.createElement('div');
  actions.className = 'bosun-top-controls-actions';
  toolbar.appendChild(actions);
  document.body.appendChild(toolbar);
  return { document, actions, createEvent };
}

function loadSettingsUi(harness) {
  const context = {
    console,
    document: harness.document,
    confirm: () => false,
    globalThis: null,
    Object,
    Array,
    Set,
    Map,
    Promise
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'settings-ui.js'), 'utf8'),
    context,
    { filename: 'settings-ui.js' }
  );
  return context.BosunHelperSettingsUi;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createStore(defaults) {
  let snapshot = clone(defaults);
  const subscribers = new Set();
  const updates = [];
  let resetCalls = 0;
  let rejectNextUpdate = false;
  let delayNextReset = false;
  let releaseReset = null;
  const write = (path, value) => {
    const [section, name] = path.split('.');
    snapshot[section][name] = value;
  };
  return {
    getSnapshot: () => clone(snapshot),
    async update(values) {
      updates.push(clone(values));
      if (rejectNextUpdate) {
        rejectNextUpdate = false;
        throw new Error('synthetic settings write failure');
      }
      const previous = clone(snapshot);
      for (const [path, value] of Object.entries(values)) write(path, value);
      for (const subscriber of Array.from(subscribers)) subscriber(clone(snapshot), previous, Object.keys(values));
      return clone(snapshot);
    },
    async reset() {
      resetCalls += 1;
      if (delayNextReset) {
        delayNextReset = false;
        await new Promise((resolve) => { releaseReset = resolve; });
      }
      const previous = clone(snapshot);
      snapshot = clone(defaults);
      for (const subscriber of Array.from(subscribers)) subscriber(clone(snapshot), previous, []);
      return clone(snapshot);
    },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    external(path, value) {
      const previous = clone(snapshot);
      write(path, value);
      for (const subscriber of Array.from(subscribers)) subscriber(clone(snapshot), previous, [path]);
    },
    updates,
    failNextUpdate() { rejectNextUpdate = true; },
    delayNextReset() { delayNextReset = true; },
    releaseReset() {
      releaseReset?.();
      releaseReset = null;
    },
    subscriberCount: () => subscribers.size,
    resetCalls: () => resetCalls
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  const harness = createDomHarness();
  const api = loadSettingsUi(harness);
  assert.strictEqual(api.createSettingsUi({}), null, 'Incomplete settings store must fail closed');

  const defaults = {
    features: {
      copyButtons: false,
      lastActionEnhancements: true,
      soundNotifications: true,
      grafanaIntegration: true
    },
    preferences: { autoRefreshIdleSeconds: 45 },
    actionTemplates: { note: ['synthetic note'], ack: null, close: [] }
  };
  const schema = [
    'features.copyButtons',
    'features.lastActionEnhancements',
    'features.soundNotifications',
    'features.grafanaIntegration',
    'preferences.autoRefreshIdleSeconds',
    'actionTemplates.note',
    'actionTemplates.ack',
    'actionTemplates.close'
  ].map((path) => ({ path }));
  const store = createStore(defaults);
  let confirmations = 0;
  let allowReset = false;
  const ui = api.createSettingsUi({
    settingsStore: store,
    schema,
    toolbarId: 'toolbar',
    confirmReset() { confirmations += 1; return allowReset; }
  });

  ui.mount(harness.actions);
  ui.mount(harness.actions);
  assert.strictEqual(harness.document.querySelectorAll('#bosun-settings-button').length, 1);
  assert.strictEqual(harness.document.querySelectorAll('#bosun-settings-modal').length, 1);
  assert.strictEqual(store.subscriberCount(), 1);

  const button = harness.document.getElementById('bosun-settings-button');
  button.focus();
  button.click();
  assert.strictEqual(ui.isOpen(), true);
  assert.strictEqual(harness.document.activeElement, harness.document.getElementById('bosun-settings-close'));
  const copyToggle = harness.document.querySelector('[data-setting-path="features.copyButtons"]');
  const grafanaToggle = harness.document.querySelector('[data-setting-path="features.grafanaIntegration"]');
  const soundToggle = harness.document.querySelector('[data-setting-path="features.soundNotifications"]');
  assert.strictEqual(copyToggle.checked, false, 'Initial value must come from the store snapshot');
  assert.ok(harness.document.querySelector('.bosun-settings-reload-hint'));

  copyToggle.click();
  await flush();
  assert.deepStrictEqual(store.updates[0], { 'features.copyButtons': true });
  grafanaToggle.click();
  await flush();
  assert.deepStrictEqual(store.updates[1], { 'features.grafanaIntegration': false });
  assert.strictEqual(soundToggle.checked, true, 'Grafana update must not alter unrelated runtime controls');

  store.external('features.copyButtons', false);
  assert.strictEqual(copyToggle.checked, false, 'External-tab update must render in an open panel');
  store.failNextUpdate();
  copyToggle.click();
  await flush();
  assert.strictEqual(copyToggle.checked, false, 'Failed persistence must restore the store-backed value');
  assert.strictEqual(harness.document.getElementById('bosun-settings-status').hidden, false);

  harness.document.dispatchEvent(harness.createEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(ui.isOpen(), false);
  assert.strictEqual(harness.document.activeElement, button, 'Escape must restore focus to the opener');
  button.click();
  harness.document.getElementById('bosun-settings-modal').click();
  assert.strictEqual(ui.isOpen(), false, 'Clicking the overlay must close the panel');

  button.click();
  harness.document.getElementById('bosun-settings-reset').click();
  await flush();
  assert.strictEqual(confirmations, 1);
  assert.strictEqual(store.resetCalls(), 0, 'Cancelled reset must not touch the settings store');
  allowReset = true;
  store.delayNextReset();
  harness.document.getElementById('bosun-settings-reset').click();
  await flush();
  const templateDefault = harness.document.querySelector('[data-template-default-path="actionTemplates.note"]');
  assert.strictEqual(templateDefault.disabled, true, 'Template updates must be blocked during reset');
  const updatesBeforeBlockedClick = store.updates.length;
  templateDefault.click();
  assert.strictEqual(store.updates.length, updatesBeforeBlockedClick, 'Reset must not race a template update');
  store.releaseReset();
  await flush();
  assert.strictEqual(store.resetCalls(), 1);

  ui.destroy();
  assert.strictEqual(store.subscriberCount(), 0);
  assert.strictEqual(harness.document.listenerCount('keydown'), 0, 'Destroy must remove the global key listener');
  assert.strictEqual(harness.document.getElementById('bosun-settings-button'), null);
  assert.strictEqual(harness.document.getElementById('bosun-settings-modal'), null);

  const remounted = api.createSettingsUi({ settingsStore: store, schema, toolbarId: 'toolbar' });
  remounted.mount();
  assert.strictEqual(harness.document.querySelectorAll('#bosun-settings-button').length, 1);
  assert.strictEqual(store.subscriberCount(), 1);
  remounted.destroy();
  assert.strictEqual(store.subscriberCount(), 0);
  assert.strictEqual(harness.document.listenerCount('keydown'), 0);
  console.log('Settings UI test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
