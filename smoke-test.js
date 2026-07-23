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
    location: { href: 'https://bosun.example.com/', pathname: '/', search: '', origin: 'https://bosun.example.com' },
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
  'config.js',
  'shared-utils.js',
  'diagnostics.js',
  'sound.js',
  'alerts-data.js',
  'needack-baseline.js',
  'needack-severity.js',
  'promql.js',
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
  ['promql', !!context.BosunHelperPromQL],
  ['page-utils', !!context.BosunSilenceHiderPageUtils],
  ['styles', !!context.BosunSilenceHiderStyles],
  ['activity', !!context.BosunSilenceHiderActivity],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('FAILED', failed);
  process.exit(1);
}

const alertsDataApi = context.BosunSilenceHiderAlertsData.createAlertsData({
  oldNoNoteMinutes: 0
});

assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: { Type: 'Ack', Message: 'ack text', User: 'operator' } } }),
  false
);
assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: { Type: 'Note', Message: '   ', User: 'operator' } } }),
  false
);
assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: { Type: 'Note', Message: 'user text', User: 'operator', Cancelled: true } } }),
  false
);
assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: { Type: 'Note', Message: 'user text', User: 'system' } } }),
  false
);
assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: { Type: 'Note', Message: 'user text', User: 'operator' } } }),
  true
);
assert.strictEqual(
  alertsDataApi.hasUserComment({ State: { LastAction: 'Note by akharyunina at 2026/06/08-20:50:36 MSK (1h19m51s ago) : migration note' } }),
  true
);
assert.strictEqual(
  alertsDataApi.hasUserComment({
    State: {
      LastAction: { Type: 'Ack', Message: 'ack', User: 'operator' },
      Actions: [{ Type: 'note', Message: 'earlier user note', User: 'operator' }]
    }
  }),
  true
);
assert.strictEqual(
  alertsDataApi.hasUserComment({
    State: {
      Actions: [{ Type: 'Note', Message: 'automated note', User: 'system' }]
    }
  }),
  false
);
assert.strictEqual(
  alertsDataApi.hasNoteFromActions([
    { type: 'note', message: 'active', user: 'system' }
  ]),
  true
);
assert.strictEqual(
  alertsDataApi.hasNoteFromActions([
    { type: 'note', message: 'cancelled', user: 'operator', cancelled: true }
  ]),
  false
);
assert.strictEqual(alertsDataApi.isRetryableError({ status: 503 }), true);
assert.strictEqual(alertsDataApi.isRetryableError({ status: 429 }), true);
assert.strictEqual(alertsDataApi.isRetryableError({ status: 404 }), false);
assert.strictEqual(alertsDataApi.isRetryableError({ code: 'ETIMEDOUT' }), true);

const commentIndex = alertsDataApi.rebuildAlertDataIndex({
  Groups: {
    NeedAck: [
      {
        Subject: 'commented group',
        Children: [
          { Subject: 'without comment', State: { Id: 101, LastAction: { Type: 'Ack', Message: 'ack', User: 'operator' }, Actions: [] } },
          { Subject: 'with comment', State: { Id: 102, LastAction: { Type: 'Note', Message: 'looking', User: 'operator' }, Actions: [{ Type: 'Note', Message: 'looking' }] } }
        ]
      }
    ]
  }
}, {
  buildChildMarkerKeyFromData(child, group) {
    return `g:${group.Subject}|c:${child.Subject}`;
  },
  buildGroupMarkerKeyFromData(group) {
    return `group:${group.Subject}`;
  },
  normalizeNeedAckChildren(raw) {
    if (raw == null) return [];
    return Array.isArray(raw) ? raw : [raw];
  }
});

assert.strictEqual(commentIndex.childHasUserCommentById.get('101'), false);
assert.strictEqual(commentIndex.childHasUserCommentById.get('102'), true);
assert.strictEqual(commentIndex.childHasUserCommentByKey.get('g:commented group|c:without comment'), false);
assert.strictEqual(commentIndex.childHasUserCommentByKey.get('g:commented group|c:with comment'), true);
assert.strictEqual(commentIndex.groupHasAnyUserCommentByKey.get('group:commented group'), true);
assert.strictEqual(commentIndex.groupCountBySubject.get('commented group'), 1);

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
    { State: { AlertKey: 'cpu.high', Tags: { zone: 'a', host: 'db01' } } },
    {}
  ),
  'ak:cpu.high|tags:host=db01,zone=a'
);
assert.strictEqual(
  severityApi.needAckStableKey(
    { Subject: 'child alert', Ago: '2026-04-23T00:00:00Z' },
    { Subject: 'group alert' }
  ),
  'g:group alert|c:child alert|ago:2026-04-23T00:00:00Z'
);

const promqlApi = context.BosunHelperPromQL;
assert.strictEqual(
  promqlApi.extractPromrasQuery("promras('''metric{label=\"a  b\"}\n  + other''')"),
  'metric{label="a  b"}\n  + other'
);
assert.deepStrictEqual(
  Array.from(promqlApi.parseAlertTags('host="db,primary",env="prod"'), (tag) => ({ ...tag })),
  [
    { name: 'host', value: 'db,primary' },
    { name: 'env', value: 'prod' }
  ]
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('sum($metric)', { host: 'db' }),
  'sum($metric)'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('metric{host!="db"}', { host: 'web', env: 'prod' }),
  'metric{host!="db", env="prod"}'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('sum by (host) (rate(cpu_total[5m]))', { host: 'db' }),
  'sum by (host) (rate(cpu_total{host="db"}[5m]))'
);

function createBaselineHarness() {
  const events = [];
  const api = context.BosunSilenceHiderNeedAckBaseline.createNeedAckBaseline({
    sessionKey: 'test-baseline',
    isSoundEnabled: () => true,
    reportDiagnostics(event, details) {
      events.push({ event, details });
    },
    playNeedAckChime(kind) {
      events.push({ event: 'chime', details: kind });
    },
    collectCurrentIdsAndSeverity(payload) {
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      return {
        currentIds: new Set(ids),
        idToSeverity: new Map(ids.map((id) => [id, payload.severity || 'critical']))
      };
    }
  });
  return { api, events };
}

{
  const { api, events } = createBaselineHarness();
  api.process({ Groups: { NeedAck: [] }, ids: ['a', 'b', 'c', 'd', 'e'] });
  events.length = 0;
  api.process({
    Groups: { NeedAck: [] },
    ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
  });
  assert.ok(events.some((entry) => entry.event === 'chime' && entry.details === 'alert'));
  assert.ok(events.some((entry) => entry.event === 'new-alerts'));
}

{
  const { api, events } = createBaselineHarness();
  api.process({ Groups: { NeedAck: [] }, ids: ['a', 'b'], severity: 'warning' });
  events.length = 0;
  api.process({ Groups: { NeedAck: [] }, ids: [], severity: 'warning' });
  api.process({ Groups: { NeedAck: [] }, ids: ['a', 'b'], severity: 'warning' });
  assert.ok(events.some((entry) => entry.event === 'empty-snapshot-pending'));
  assert.ok(!events.some((entry) => entry.event === 'chime'));
}

console.log('Smoke test passed');
