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
    const children = [];
    const elementListeners = {};
    return {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      children,
      parentElement: null,
      nextElementSibling: null,
      appendChild(child) {
        child.parentElement = this;
        children.push(child);
        return child;
      },
      remove() {},
      focus() {},
      setSelectionRange() {},
      dispatchEvent() {},
      addEventListener(name, fn) {
        (elementListeners[name] ||= []).push(fn);
      },
      __listeners: elementListeners,
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
  'settings.js',
  'diagnostics.js',
  'sound.js',
  'alerts-data.js',
  'single-alert-age.js',
  'needack-baseline.js',
  'needack-severity.js',
  'promql.js',
  'bosun-rule-graph.js',
  'page-utils.js',
  'styles.js',
  'activity.js',
  'action-templates.js',
  'grafana-handoff.js',
  'new-alert-tracker.js',
  'refresh-coordinator.js',
  'content.js'
]) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(code, context, { filename: file });
}

const checks = [
  ['shared-utils', !!context.BosunSilenceHiderSharedUtils],
  ['settings', !!context.BosunHelperSettings],
  ['diagnostics', !!context.BosunSilenceHiderDiagnostics],
  ['sound', !!context.BosunSilenceHiderSound],
  ['alerts-data', !!context.BosunSilenceHiderAlertsData],
  ['single-alert-age', !!context.BosunHelperSingleAlertAge],
  ['needack-baseline', !!context.BosunSilenceHiderNeedAckBaseline],
  ['needack-severity', !!context.BosunSilenceHiderNeedAckSeverity],
  ['promql', !!context.BosunHelperPromQL],
  ['page-utils', !!context.BosunSilenceHiderPageUtils],
  ['styles', !!context.BosunSilenceHiderStyles],
  ['activity', !!context.BosunSilenceHiderActivity],
  ['action-templates', !!context.BosunHelperActionTemplates],
  ['grafana-handoff', !!context.BosunHelperGrafanaHandoff],
  ['new-alert-tracker', !!context.BosunHelperNewAlertTracker],
  ['refresh-coordinator', !!context.BosunHelperRefreshCoordinator],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('FAILED', failed);
  process.exit(1);
}

{
  const fixedNow = Date.parse('2026-08-20T12:00:00Z');
  assert.strictEqual(
    context.BosunHelperSingleAlertAge.SINGLE_ALERT_AGE_DEBUG,
    false,
    'Production single-alert-age diagnostics must be disabled'
  );
  const ageApi = context.BosunHelperSingleAlertAge.createSingleAlertAge({ now: () => fixedNow });
  assert.strictEqual(ageApi.formatAge('2026-08-20T11:17:00Z'), '43m-ago');
  assert.strictEqual(ageApi.formatAge('2026-08-20T10:00:00Z'), '2h-ago');
  assert.strictEqual(ageApi.formatAge('2026-08-18T12:00:00Z'), '2d-ago');
  assert.strictEqual(ageApi.formatAge('invalid'), null);
  assert.strictEqual(ageApi.formatAge('2026-08-20T11:59:15Z'), '1m-ago');
  assert.strictEqual(ageApi.formatAge('2026-08-19T14:00:00Z'), '1d-ago');

  let disabledDebugCalls = 0;
  const quietAgeApi = context.BosunHelperSingleAlertAge.createSingleAlertAge({
    debug: false,
    debugLogger() { disabledDebugCalls += 1; }
  });
  quietAgeApi.update({ Groups: { NeedAck: [], Acknowledged: [] } });
  quietAgeApi.refresh();
  assert.strictEqual(disabledDebugCalls, 0, 'Disabled single-alert-age diagnostics must stay silent');

  const throwingLoggerApi = context.BosunHelperSingleAlertAge.createSingleAlertAge({
    debug: true,
    debugLogger() { throw new Error('simulated diagnostics failure'); }
  });
  assert.doesNotThrow(() => {
    throwingLoggerApi.update({ Groups: { NeedAck: [], Acknowledged: [] } });
    throwingLoggerApi.refresh();
  }, 'Diagnostics failures must not affect single-alert-age behavior');
}

{
  function createAgeHistoryHarness() {
    let currentNow = Date.parse('2026-08-20T12:00:00Z');
    const roots = {
      NeedAck: { panels: [] },
      Acknowledged: { panels: [] }
    };
    const api = context.BosunHelperSingleAlertAge.createSingleAlertAge({
      now: () => currentNow,
      debug: false,
      normalizeChildren: (value) => Array.isArray(value) ? value : [],
      buildGroupKeyFromData: (group) => group.Key || null,
      buildGroupKeyFromDom: (panel) => panel.key || null,
      getRoots: () => [
        { type: 'NeedAck', root: roots.NeedAck },
        { type: 'Acknowledged', root: roots.Acknowledged }
      ],
      getGroupPanels: (root) => root.panels,
      getGroupSubject: (panel) => panel.subject,
      getGroupCountNode: (panel) => panel.countNode,
      getDomChildCount: (panel) => panel.domChildCount || 0,
      hasStrongDomIdentity: (panel) => panel.strong === true
    });
    return {
      api,
      roots,
      setNow(value) { currentNow = value; },
      panel(subject, key = null) {
        return { subject, key, countNode: { textContent: '1 alerts', dataset: {} } };
      },
      group(subject, ago, children = 1, key = null) {
        return {
          Subject: subject,
          Key: key,
          Children: Array.from({ length: children }, (_, index) => ({
            Ago: index === 0 ? ago : '2026-08-20T10:00:00Z'
          }))
        };
      },
      apply(needAck = [], acknowledged = []) {
        api.update({ Groups: { NeedAck: needAck, Acknowledged: acknowledged } });
        api.refresh();
      }
    };
  }

  const history = createAgeHistoryHarness();
  const stable = history.panel('stable');
  history.roots.NeedAck.panels = [stable];
  history.apply([history.group('stable', '2026-08-20T11:17:00Z')]);
  assert.strictEqual(stable.countNode.textContent, '43m-ago');
  assert.strictEqual(history.api.getHistoryStats().entries, 1);

  history.setNow(Date.parse('2026-08-20T12:00:05Z'));
  history.apply([]);
  assert.strictEqual(stable.countNode.textContent, '43m-ago', 'Missing candidate must use the cached timestamp during grace');
  assert.strictEqual(stable.countNode.dataset.bosunSingleAlertAgeDecision, 'preserve-last-valid-match');
  for (let index = 0; index < 25; index += 1) history.api.refresh();
  assert.strictEqual(history.api.getHistoryStats().entries, 1, 'Repeated missing snapshots must not grow history');

  history.apply([]);
  assert.strictEqual(stable.countNode.textContent, '43m-ago', 'Second missing snapshot must remain inside grace');
  history.apply([]);
  assert.strictEqual(stable.countNode.textContent, '1 alerts', 'Expired snapshot grace must restore the counter');
  assert.strictEqual(history.api.getHistoryStats().entries, 0, 'Expired snapshot grace must clear history');

  history.apply([history.group('stable', '2026-08-20T10:00:00Z')]);
  assert.strictEqual(stable.countNode.textContent, '2h-ago', 'Recovered snapshot must replace cached age');

  history.roots.NeedAck.panels = [];
  history.api.refresh();
  assert.strictEqual(history.api.getHistoryStats().entries, 0, 'Removed panels must clear history');
  history.roots.NeedAck.panels = [stable];
  history.apply([]);
  assert.strictEqual(stable.countNode.textContent, '1 alerts', 'Removed panel history must not be restored');

  const fresh = history.panel('stable');
  history.roots.NeedAck.panels = [fresh];
  history.apply([]);
  assert.strictEqual(fresh.countNode.textContent, '1 alerts', 'History must not transfer to a new panel');

  const multiHistory = createAgeHistoryHarness();
  const changingCount = multiHistory.panel('changing count');
  multiHistory.roots.NeedAck.panels = [changingCount];
  multiHistory.apply([multiHistory.group('changing count', '2026-08-20T11:17:00Z')]);
  multiHistory.apply([multiHistory.group('changing count', '2026-08-20T11:17:00Z', 2)]);
  assert.strictEqual(changingCount.countNode.textContent, '2 alerts');
  assert.strictEqual(multiHistory.api.getHistoryStats().entries, 0, 'Multi-alert groups must clear single history');
  multiHistory.apply([]);
  assert.strictEqual(changingCount.countNode.textContent, '2 alerts', 'Cleared single history must not return');

  const ambiguousHistory = createAgeHistoryHarness();
  const ambiguousPanel = ambiguousHistory.panel('duplicate');
  ambiguousHistory.roots.Acknowledged.panels = [ambiguousPanel];
  ambiguousHistory.apply([], [ambiguousHistory.group('duplicate', '2026-08-20T11:17:00Z')]);
  ambiguousHistory.apply([], [
    ambiguousHistory.group('duplicate', '2026-08-20T11:17:00Z'),
    ambiguousHistory.group('duplicate', '2026-08-20T10:00:00Z')
  ]);
  assert.strictEqual(ambiguousPanel.countNode.textContent, '1 alerts');
  assert.strictEqual(ambiguousHistory.api.getHistoryStats().entries, 0, 'Ambiguous match must clear history');
  ambiguousHistory.apply([], []);
  assert.strictEqual(ambiguousPanel.countNode.textContent, '1 alerts');

  const identityHistory = createAgeHistoryHarness();
  const reusedPanel = identityHistory.panel('old identity');
  identityHistory.roots.NeedAck.panels = [reusedPanel];
  identityHistory.apply([identityHistory.group('old identity', '2026-08-20T11:17:00Z')]);
  reusedPanel.subject = 'new identity';
  identityHistory.apply([]);
  assert.strictEqual(reusedPanel.countNode.textContent, '1 alerts', 'History must not survive a panel identity change');
  assert.strictEqual(identityHistory.api.getHistoryStats().entries, 0);

  const strongIdentityHistory = createAgeHistoryHarness();
  const strongPanel = strongIdentityHistory.panel('same subject', 'key-a');
  strongPanel.strong = true;
  strongIdentityHistory.roots.NeedAck.panels = [strongPanel];
  strongIdentityHistory.apply([
    strongIdentityHistory.group('same subject', '2026-08-20T11:17:00Z', 1, 'key-a')
  ]);
  strongPanel.key = 'key-b';
  strongIdentityHistory.apply([]);
  assert.strictEqual(strongPanel.countNode.textContent, '1 alerts', 'Strong identity changes must invalidate history');
  assert.strictEqual(strongIdentityHistory.api.getHistoryStats().entries, 0);

  const timedHistory = createAgeHistoryHarness();
  const timedPanel = timedHistory.panel('timed grace');
  timedHistory.roots.NeedAck.panels = [timedPanel];
  timedHistory.apply([timedHistory.group('timed grace', '2026-08-20T11:17:00Z')]);
  timedHistory.setNow(Date.parse('2026-08-20T12:00:16Z'));
  timedHistory.apply([]);
  assert.strictEqual(timedPanel.countNode.textContent, '1 alerts', 'Expired time grace must restore the counter');
}

assert.ok(context.BosunHelperActionTemplates.DEFAULT_TEMPLATES.note.length > 0);
assert.ok(context.BosunHelperActionTemplates.DEFAULT_TEMPLATES.ack.length > 0);
assert.strictEqual(context.BosunHelperActionTemplates.DEFAULT_TEMPLATES.note.at(-1), 'сдано в ');
assert.deepStrictEqual(Array.from(context.BosunHelperActionTemplates.DEFAULT_TEMPLATES.close), []);
assert.strictEqual(context.BosunHelperActionTemplates.MAX_TEMPLATES_PER_TYPE, 50);
assert.strictEqual(context.BosunHelperActionTemplates.MAX_TEMPLATE_LENGTH, 500);

{
  const originalSearch = context.window.location.search;
  const originalQuerySelector = documentStub.querySelector;
  const originalQuerySelectorAll = documentStub.querySelectorAll;
  let currentTextarea = documentStub.createElement('textarea');
  let templateWrap = null;
  const textareaParent = {
    insertBefore(node, textarea) {
      templateWrap = node;
      node.parentElement = this;
      node.nextElementSibling = textarea;
    }
  };
  currentTextarea.parentElement = textareaParent;
  currentTextarea.offsetParent = {};
  context.window.location.search = '?type=note';
  documentStub.querySelector = (selector) => selector === '.bosun-action-templates' ? templateWrap : null;
  documentStub.querySelectorAll = (selector) => selector === 'textarea' ? [currentTextarea] : [];

  const templates = context.BosunHelperActionTemplates.createActionTemplates({
    isActionPage: () => true,
    templatesByType: { note: ['template'] }
  });
  templates.refresh();
  const button = templateWrap.children[1].children[0];
  const detachedTextarea = currentTextarea;
  currentTextarea = documentStub.createElement('textarea');
  currentTextarea.parentElement = textareaParent;
  currentTextarea.offsetParent = {};
  templateWrap.nextElementSibling = currentTextarea;
  button.__listeners.click[0]({ preventDefault() {}, stopPropagation() {} });

  assert.strictEqual(detachedTextarea.value, '', 'Detached action textarea must not be updated');
  assert.strictEqual(currentTextarea.value, 'template', 'Template must target the current action textarea');

  context.window.location.search = originalSearch;
  documentStub.querySelector = originalQuerySelector;
  documentStub.querySelectorAll = originalQuerySelectorAll;
}

{
  const originalSearch = context.window.location.search;
  const originalQuerySelector = documentStub.querySelector;
  const originalQuerySelectorAll = documentStub.querySelectorAll;
  let currentTextarea = documentStub.createElement('textarea');
  let templateWrap = null;
  let storageGets = 0;
  let storedNoteTemplates = ['a|b', 'c'];
  const textareaParent = {
    insertBefore(node, textarea) {
      templateWrap = node;
      node.parentElement = this;
      node.nextElementSibling = textarea;
    }
  };
  currentTextarea.parentElement = textareaParent;
  currentTextarea.offsetParent = {};
  context.window.location.search = '?type=note';
  documentStub.querySelector = (selector) => selector === '.bosun-action-templates' ? templateWrap : null;
  documentStub.querySelectorAll = (selector) => selector === 'textarea' ? [currentTextarea] : [];

  const templates = context.BosunHelperActionTemplates.createActionTemplates({
    isActionPage: () => true,
    getStorage: () => ({
      get(_keys, callback) {
        storageGets += 1;
        callback({ bosunActionTemplatesV1: undefined, 'bosunActionTemplatesV1:note': storedNoteTemplates });
      }
    })
  });
  const normalized = templates.normalizeTemplates([
    ...Array.from({ length: 55 }, (_, index) => `template-${index}`),
    'template-0',
    'x'.repeat(context.BosunHelperActionTemplates.MAX_TEMPLATE_LENGTH + 1)
  ]);
  assert.ok(normalized.length <= context.BosunHelperActionTemplates.MAX_TEMPLATES_PER_TYPE);
  assert.ok(normalized.every((item) => item.length <= context.BosunHelperActionTemplates.MAX_TEMPLATE_LENGTH));
  assert.ok(
    normalized.reduce((total, item) => total + item.length, 0) <=
      context.BosunHelperActionTemplates.MAX_TOTAL_TEMPLATE_TEXT_LENGTH
  );
  const totalLimited = templates.normalizeTemplates(
    Array.from({ length: 30 }, (_, index) => `${String(index).padStart(3, '0')}${'x'.repeat(397)}`)
  );
  assert.ok(totalLimited.length < 30, 'Template normalization must enforce the total text limit');
  assert.ok(
    totalLimited.reduce((total, item) => total + item.length, 0) <=
      context.BosunHelperActionTemplates.MAX_TOTAL_TEMPLATE_TEXT_LENGTH
  );

  templates.refresh();
  const firstSignature = templateWrap.dataset.templateSignature;
  templates.destroy();
  storedNoteTemplates = ['a', 'b|c'];
  templates.refresh();
  const secondSignature = templateWrap.dataset.templateSignature;
  assert.strictEqual(storageGets, 2, 'Action templates must reload storage after destroy/SPA return');
  assert.notStrictEqual(firstSignature, secondSignature, 'Template signature must not collide on pipe characters');

  templates.destroy();
  context.window.location.search = originalSearch;
  documentStub.querySelector = originalQuerySelector;
  documentStub.querySelectorAll = originalQuerySelectorAll;
}

{
  let removedKeys = [];
  const now = Date.now();
  const storageItems = {
    bosunGrafanaPendingQueryV1: { query: 'legacy' },
    'bosunGrafanaPendingQueryV2:expired': { query: 'old', createdAt: now - 121000 },
    'bosunGrafanaPendingQueryV2:active': { query: 'current', createdAt: now },
    unrelated: { createdAt: 0 }
  };
  const handoff = context.BosunHelperGrafanaHandoff.createGrafanaHandoff({
    config: {
      grafanaHost: 'grafana.example.com:8443',
      grafanaPanelUrl: 'https://grafana.example.com:8443/d/test?editPanel=1'
    },
    getStorage: () => ({
      get(_keys, callback) { callback(storageItems); },
      remove(keys) { removedKeys = keys; }
    })
  });

  const panelUrl = new URL(handoff.buildPanelUrl('request-id'));
  assert.strictEqual(panelUrl.host, 'grafana.example.com:8443');
  assert.strictEqual(panelUrl.searchParams.get('bosunHelperRequest'), 'request-id');
  handoff.cleanupExpired();
  assert.deepStrictEqual(
    removedKeys.slice().sort(),
    ['bosunGrafanaPendingQueryV1', 'bosunGrafanaPendingQueryV2:expired'].sort(),
    'Grafana cleanup must remove only legacy and expired handoff records'
  );
  handoff.destroy();
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
    { Type: 'Note', Message: '', User: 'operator' }
  ]),
  true,
  'Bosun Note action must count even when Notify is disabled and Message is empty'
);
assert.strictEqual(
  alertsDataApi.hasNoteFromActions([
    { ActionType: 6, Text: 'legacy Bosun note', User: 'operator' }
  ]),
  true,
  'Numeric ActionNote from older/custom Bosun responses was not recognized'
);
assert.strictEqual(
  alertsDataApi.hasNoteFromActions([
    'Commented On by operator at (2026-01-01): checked'
  ]),
  true,
  'Human-readable Commented On action was not recognized'
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

const lastActionNoteIndex = alertsDataApi.rebuildAlertDataIndex({
  Groups: {
    NeedAck: [{
      Subject: 'last-action-note',
      Children: [{
        Ago: '2020-01-01T00:00:00Z',
        State: {
          Id: 777,
          Actions: [],
          LastAction: 'Note by operator at (2026-01-01): checked after reload'
        }
      }]
    }]
  }
}, {
  buildChildMarkerKeyFromData: (child) => `id:${child.State.Id}`,
  buildGroupMarkerKeyFromData: (group) => group.Subject,
  normalizeNeedAckChildren: (children) => children || []
});
assert.strictEqual(lastActionNoteIndex.childHasNoteById.get('777'), true);
assert.strictEqual(lastActionNoteIndex.childOldNoNoteById.get('777'), false);

const emptyLastActionNoteIndex = alertsDataApi.rebuildAlertDataIndex({
  Groups: {
    NeedAck: [{
      Subject: 'empty-last-action-note',
      Children: [{
        Ago: '2020-01-01T00:00:00Z',
        State: {
          Id: 778,
          Actions: [],
          LastAction: 'Note by operator at (2026-01-01):'
        }
      }]
    }]
  }
}, {
  buildChildMarkerKeyFromData: (child) => `id:${child.State.Id}`,
  buildGroupMarkerKeyFromData: (group) => group.Subject,
  normalizeNeedAckChildren: (children) => children || []
});
assert.strictEqual(emptyLastActionNoteIndex.childHasNoteById.get('778'), true);
assert.strictEqual(emptyLastActionNoteIndex.childOldNoNoteById.get('778'), false);

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
assert.strictEqual(
  promqlApi.extractPromrasQuery(
    "promras('''sum(rate(http_requests_total[5m])) by (service)''', \"2m\", \"2h\", \"\")"
  ),
  'sum(rate(http_requests_total[5m])) by (service)',
  'Canonical four-argument Bosun promras calls must expose their PromQL'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery(
    "promras('''up''', $step, duration(\"2h\", 1), \"\")"
  ),
  'up',
  'Promras duration arguments may contain variables and balanced nested calls'
);
for (const malformedPromras of [
  "promras('''up''', \"2m\", \"2h\")",
  "promras('''up''', \"2m\", , \"\")",
  "promras('''up''', \"2m\", \"2h\", \"\", \"extra\")",
  "promras('''up''', duration(\"2m\", 1), \"2h\", \"\""
]) {
  assert.strictEqual(
    promqlApi.extractPromrasQuery(malformedPromras),
    '',
    'Malformed or wrong-arity promras tails must fail closed'
  );
}
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
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'sum by(zone,name)(rr_imsi_success_response_percent)',
    'name=bercut1,zone=smssrv28'
  ),
  'sum by(zone,name)(rr_imsi_success_response_percent{name="bercut1", zone="smssrv28"})',
  'A live-shaped naked vector selector must receive only the alert matchers'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'left_metric / on(host) group_left(zone) right_metric offset 5m',
    { host: 'db' }
  ),
  'left_metric{host="db"} / on(host) group_left(zone) right_metric{host="db"} offset 5m'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'metric{pattern=~"a,b|c",host!="db"} # metric_in_comment\n+ other',
    { host: 'web', zone: 'a' }
  ),
  'metric{pattern=~"a,b|c",host!="db", zone="a"} # metric_in_comment\n+ other{host="web", zone="a"}'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'rate($metric[$__rate_interval])',
    { host: 'db' }
  ),
  'rate($metric[$__rate_interval])'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery(
    "promras('''first_metric''')\npromras('''second_metric''')"
  ),
  '',
  'Distinct promras calls must be rejected as ambiguous'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery(
    "promras('''same_metric''')\npromras('''same_metric''')"
  ),
  'same_metric',
  'Identical promras calls may deduplicate to one query'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery(
    "# promras('''comment_metric''')\n$message = \"promras('''string_metric''')\"\npromras('''real_metric''')"
  ),
  'real_metric',
  'Comment and quoted-string text must not create promras candidates'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery("promras('''unclosed_metric'''") ,
  '',
  'Malformed promras calls must be rejected'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    '{__name__=~"http_.*",job="api"}',
    { host: 'web' }
  ),
  '',
  'Naked selectors must fail closed until they are safely supported'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'left_metric atan2 right_metric',
    { host: 'web' }
  ),
  'left_metric{host="web"} atan2 right_metric{host="web"}',
  'atan2 must remain an operator'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'clamp(metric, -Inf, +Inf) + NaN',
    { host: 'web' }
  ),
  'clamp(metric{host="web"}, -Inf, +Inf) + NaN',
  'PromQL special float literals must not receive label matchers'
);
for (const malformedQuery of [
  'metric{host="web"',
  'metric{host="web}',
  'sum(metric',
  'metric)'
]) {
  assert.strictEqual(
    promqlApi.applyAlertTagsToPromQuery(malformedQuery, { env: 'prod' }),
    '',
    `Malformed PromQL must fail closed: ${malformedQuery}`
  );
}
for (const malformedTags of [
  'host=web-1,host=web-2',
  'host=web-1,broken,env=prod',
  'host="web-1'
]) {
  assert.strictEqual(
    promqlApi.applyAlertTagsToPromQuery('up', malformedTags),
    '',
    `Malformed or conflicting tags must fail closed: ${malformedTags}`
  );
}
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('up', 'host=web-1,host=web-1'),
  'up{host="web-1"}',
  'Identical duplicate tags may deduplicate'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'left_metric + label_replace(right_metric, "dst", `raw\\` , "src", "x") + tail_metric',
    { host: 'web' }
  ),
  'left_metric{host="web"} + label_replace(right_metric{host="web"}, "dst", `raw\\` , "src", "x") + tail_metric{host="web"}',
  'Backtick raw strings and the tokens after them must be preserved byte-for-byte'
);
assert.strictEqual(
  promqlApi.extractPromrasQuery(`promras('''${'m'.repeat(16 * 1024 + 1)}''')`),
  '',
  'Oversized extracted PromQL must fail closed'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('up', `host=${'x'.repeat(1025)}`),
  '',
  'Oversized tag values must fail closed'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('up', `${'n'.repeat(129)}=value`),
  '',
  'Oversized tag names must fail closed'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(
    'up',
    Array.from({ length: 65 }, (_unused, index) => `tag_${index}=x`).join(',')
  ),
  '',
  'Excessive tag counts must fail closed'
);
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery('m'.repeat(16 * 1024 + 1), { host: 'web' }),
  '',
  'Oversized source PromQL must fail closed'
);
const boundedTags = Array.from({ length: 64 }, (_unused, index) => {
  return `tag_${index}=${'x'.repeat(90)}`;
}).join(',');
const expandingQuery = Array.from({ length: 180 }, (_unused, index) => `metric_${index}`).join(' + ');
assert.ok(expandingQuery.length < 16 * 1024, 'Synthetic expansion input unexpectedly exceeds source bound');
assert.strictEqual(
  promqlApi.applyAlertTagsToPromQuery(expandingQuery, boundedTags),
  '',
  'Incremental tag expansion beyond the handoff limit must fail closed'
);

function createBaselineHarness(options = {}) {
  const events = [];
  const api = context.BosunSilenceHiderNeedAckBaseline.createNeedAckBaseline({
    sessionKey: 'test-baseline',
    isSoundEnabled: () => options.soundEnabled !== false,
    reportDiagnostics(event, details) {
      events.push({ event, details });
    },
    playNeedAckChime(kind) {
      events.push({ event: 'chime', details: kind });
    },
    onNewAlerts(details) {
      events.push({
        event: 'visible-new-alerts',
        details: {
          newIds: Array.from(details.newIds),
          total: details.total,
          source: details.source
        }
      });
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
  const originalSessionStorage = context.window.sessionStorage;
  const writes = [];
  context.window.sessionStorage = {
    getItem() { return null; },
    setItem(key, value) { writes.push({ key, value }); },
    removeItem() {}
  };
  const { api } = createBaselineHarness();
  const payload = { Groups: { NeedAck: [] }, ids: ['same-a', 'same-b'] };
  api.process({ ...payload, ids: payload.ids.slice().reverse() });
  api.process(payload);
  assert.strictEqual(writes.length, 1, 'Unchanged NeedAck baseline must not be written twice');
  context.window.sessionStorage = originalSessionStorage;
}

{
  const originalSessionStorage = context.window.sessionStorage;
  const maxIds = context.BosunSilenceHiderNeedAckBaseline.MAX_RESTORED_IDS;
  const oversizedIds = Array.from({ length: maxIds + 1 }, (_, index) => `restored-${index}`);
  const writes = [];
  context.window.sessionStorage = {
    getItem() {
      return JSON.stringify({ ready: true, ids: oversizedIds, size: oversizedIds.length });
    },
    setItem(key, value) { writes.push({ key, value }); },
    removeItem() {}
  };
  const { api, events } = createBaselineHarness();
  api.restoreFromSession();
  events.length = 0;
  api.process({ Groups: { NeedAck: [] }, ids: oversizedIds });
  assert.ok(!events.some((entry) => entry.event === 'chime'), 'Truncated restore must establish a fresh baseline silently');
  const saved = JSON.parse(writes.at(-1).value);
  assert.strictEqual(saved.ids.length, maxIds, 'Persisted baseline must respect the restore limit');
  context.window.sessionStorage = originalSessionStorage;
}

{
  const { api, events } = createBaselineHarness({ soundEnabled: false });
  api.process({ Groups: { NeedAck: [] }, ids: ['existing'], severity: 'critical' });
  events.length = 0;
  api.process({
    Groups: { NeedAck: [] },
    ids: ['existing', 'new-critical'],
    severity: 'critical'
  });

  assert.ok(!events.some((entry) => entry.event === 'chime'));
  assert.deepStrictEqual(
    events.find((entry) => entry.event === 'visible-new-alerts')?.details,
    {
      newIds: ['new-critical'],
      total: 2,
      source: 'refresh'
    }
  );

  events.length = 0;
  api.process({
    Groups: { NeedAck: [] },
    ids: ['existing', 'new-critical'],
    severity: 'critical'
  });
  assert.ok(!events.some((entry) => entry.event === 'visible-new-alerts'));
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
