const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const listeners = {};
const documentStub = {
  readyState: 'loading',
  head: { appendChild() {} },
  body: { querySelector() { return null; } },
  documentElement: {},
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      className: '',
      innerHTML: '',
      textContent: '',
      appendChild() {},
      remove() {},
      addEventListener() {},
      setAttribute() {},
      querySelector() { return null; },
      querySelectorAll() { return []; }
    };
  },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener(name, fn) { listeners[name] = fn; }
};

const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
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
  document: documentStub,
  window: {
    location: { href: 'https://bosun.edna.ru/', pathname: '/', search: '', origin: 'https://bosun.edna.ru' },
    addEventListener() {},
    removeEventListener() {},
    getSelection() { return { toString() { return ''; } }; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  },
  chrome: { storage: { local: { get(_keys, cb) { cb({}); }, set() {} } }, runtime: { getURL: (x) => x } },
  fetch: async () => ({ ok: true, json: async () => ({ Groups: { NeedAck: [] } }) }),
  XMLHttpRequest: function () { this.open=()=>{}; this.setRequestHeader=()=>{}; this.send=()=>{ this.status=200; this.responseText='{"Groups":{"NeedAck":[]}}'; this.onload && this.onload(); }; },
  MutationObserver: function () { this.observe=()=>{}; this.disconnect=()=>{}; },
  Event: function(name, init){ this.type=name; Object.assign(this, init||{}); },
  InputEvent: function(name, init){ this.type=name; Object.assign(this, init||{}); },
  navigator: { clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 1; },
};
context.globalThis = context;
context.window.window = context.window;
context.window.document = context.document;
context.window.chrome = context.chrome;
context.window.fetch = context.fetch;
context.window.XMLHttpRequest = context.XMLHttpRequest;
context.window.MutationObserver = context.MutationObserver;
context.window.Event = context.Event;
context.window.InputEvent = context.InputEvent;
context.window.navigator = context.navigator;
context.window.requestAnimationFrame = context.requestAnimationFrame;

for (const file of [
  'shared-utils.js',
  'diagnostics.js',
  'sound.js',
  'alerts-data.js',
  'needack-baseline.js',
  'needack-severity.js',
  'page-utils.js',
  'styles.js',
  'activity.js',
  'content.js'
]) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(code, context, { filename: file });
}

const checks = [
  ['shared-utils', !!context.BosunSilenceHiderSharedUtils],
  ['diagnostics', !!context.BosunSilenceHiderDiagnostics],
  ['sound', !!context.BosunSilenceHiderSound],
  ['alerts-data', !!context.BosunSilenceHiderAlertsData],
  ['needack-baseline', !!context.BosunSilenceHiderNeedAckBaseline],
  ['needack-severity', !!context.BosunSilenceHiderNeedAckSeverity],
  ['page-utils', !!context.BosunSilenceHiderPageUtils],
  ['styles', !!context.BosunSilenceHiderStyles],
  ['activity', !!context.BosunSilenceHiderActivity],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('FAILED', failed);
  process.exit(1);
}

const severityApi = context.BosunSilenceHiderNeedAckSeverity.createNeedAckSeverity({
  normalizeNeedAckChildren(raw) {
    if (raw == null) return [];
    return Array.isArray(raw) ? raw : [raw];
  }
});

assert.strictEqual(severityApi.parseNeedAckStatusToBucket('Critical'), 'critical');
assert.strictEqual(severityApi.parseNeedAckStatusToBucket('warning-high'), 'warning');
assert.strictEqual(severityApi.parseNeedAckStatusToBucket('normal'), 'unknown');
assert.strictEqual(
  severityApi.needAckStableKey({ State: { Id: '42' } }, {}),
  'id:42'
);
assert.strictEqual(
  severityApi.needAckStableKey(
    { AlertKey: 'cpu.high', State: { Tags: 'host=db01' } },
    {}
  ),
  'ak:cpu.high|tags:host=db01'
);
assert.strictEqual(
  severityApi.needAckStableKey(
    { Subject: 'child alert', Ago: '2026-04-23T00:00:00Z' },
    { Subject: 'group alert' }
  ),
  'g:group alert|c:child alert|ago:2026-04-23T00:00:00Z'
);

console.log('Smoke test passed');
