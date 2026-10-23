'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSingleAlertAgeLifecycleScenarios({ client, singleAlertAgeSource, contentSource }) {
  const singleAlertLifecycleResult = await evaluate(client, `(async () => {
    const ageDebugLogs = [];
    const originalConsoleDebug = console.debug;
    console.debug = (prefix, details) => {
      if (prefix === '[BosunHelper][single-alert-age-problem]') ageDebugLogs.push(details);
      else originalConsoleDebug.call(console, prefix, details);
    };
    history.replaceState({}, '', '/');
    document.body.innerHTML =
      '<div id="need-root" ts-ack-group="schedule.Groups.NeedAck"><div class="panel-group"></div></div>' +
      '<div id="ack-root" ts-ack-group="schedule.Groups.Acknowledged"><div class="panel-group"></div></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const createSingleAlertAgeForDiagnostics = BosunHelperSingleAlertAge.createSingleAlertAge;
    BosunHelperSingleAlertAge.createSingleAlertAge = (options) =>
      createSingleAlertAgeForDiagnostics({ ...options, debug: true });
    globalThis.BosunSilenceHiderPageUtils = {
      createPageUtils() {
        return {
          isDashboardHome: () => location.pathname === '/',
          isActionPage: () => false,
          applyActionPageTweaks() {}
        };
      }
    };
    let refreshRequests = 0;
    globalThis.BosunHelperRefreshCoordinator = {
      createRefreshCoordinator() {
        return {
          start() {}, stop() {},
          requestRefresh() { refreshRequests += 1; }
        };
      }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const ago43m = new Date(Date.now() - 43 * 60 * 1000).toISOString();
    const ago2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const snapshot = { Groups: {
      NeedAck: [
        { Subject: 'existing single', Children: [{ Ago: ago43m, State: { Id: 901 } }] },
        { Subject: 'late single', Children: [{ Ago: ago43m, State: { Id: 902 } }] },
        { Subject: 'multi', Children: [{ Ago: ago43m, State: { Id: 903 } }, { Ago: ago2h, State: { Id: 904 } }] },
        { Subject: 'duplicate', Children: [{ Ago: ago43m, State: { Id: 905 } }] },
        { Subject: 'duplicate', Children: [{ Ago: ago2h, State: { Id: 906 } }] }
      ],
      Acknowledged: [
        { Subject: 'ack single', Children: [{ Ago: ago2h, State: { Id: 907 } }] }
      ]
    }};

    hooks.applyAlertsPayload(snapshot, { source: 'follower' });
    hooks.startObserver();

    function createGroup(subject, count, id) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = id;
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      const title = document.createElement('div');
      title.className = 'panel-title';
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'group.Subject');
      subjectNode.textContent = subject;
      const countNode = document.createElement('span');
      countNode.className = 'pull-right ng-binding';
      countNode.textContent = count + ' alerts';
      title.append(subjectNode, countNode);
      heading.appendChild(title);
      panel.appendChild(heading);
      return panel;
    }

    const needGroup = document.querySelector('#need-root .panel-group');
    const ackGroup = document.querySelector('#ack-root .panel-group');
    needGroup.append(
      createGroup('existing single', 1, 'existing-single'),
      createGroup('multi', 2, 'multi-group'),
      createGroup('duplicate', 1, 'ambiguous-group')
    );
    ackGroup.appendChild(createGroup('ack single', 1, 'ack-single'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const firstPass = {
      single: document.querySelector('#existing-single .pull-right').textContent,
      multi: document.querySelector('#multi-group .pull-right').textContent,
      acknowledged: document.querySelector('#ack-single .pull-right').textContent,
      ambiguous: document.querySelector('#ambiguous-group .pull-right').textContent
    };
    const requestsAfterInitialDom = refreshRequests;

    needGroup.appendChild(createGroup('late single', 1, 'late-single'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lateAge = document.querySelector('#late-single .pull-right').textContent;
    const normalMutationLogCount = ageDebugLogs.length;

    // A native writer can mutate the existing Text node instead of replacing it.
    // Identity, child count and snapshot remain valid; another group is the control.
    const characterDataCount = document.querySelector('#existing-single .pull-right');
    characterDataCount.firstChild.data = '1 alerts';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const characterDataReset = {
      repainted: characterDataCount.textContent,
      control: document.querySelector('#late-single .pull-right').textContent
    };
    // Isolate the regression from the following lifecycle/grace assertions.
    hooks.singleAlertAge.refresh();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    hooks.resetLifecycleCounters();
    const extensionManagedSubject = document.querySelector('#existing-single [ng-bind="group.Subject"]');
    for (let index = 0; index < 100; index += 1) {
      hooks.setExtensionClass(extensionManagedSubject, 'bosun-no-select', true);
      hooks.setExtensionClass(extensionManagedSubject, 'bosun-no-select', false);
    }
    await Promise.resolve();
    await Promise.resolve();
    const extensionMutationCounters = hooks.getLifecycleCounters();

    const externallyResetCount = document.querySelector('#multi-group .pull-right');
    hooks.setExtensionClass(externallyResetCount, 'bosun-no-select', true);
    await Promise.resolve();
    await Promise.resolve();
    hooks.resetLifecycleCounters();
    externallyResetCount.classList.remove('bosun-no-select');
    await Promise.resolve();
    await Promise.resolve();
    const externalClassResetCounters = hooks.getLifecycleCounters();

    hooks.resetLifecycleCounters();
    const unrelatedNode = document.createElement('span');
    unrelatedNode.textContent = 'unrelated';
    document.body.appendChild(unrelatedNode);
    await Promise.resolve();
    await Promise.resolve();
    const unrelatedMutationCounters = hooks.getLifecycleCounters();

    hooks.applyAlertsPayload({ Groups: { NeedAck: [], Acknowledged: [] } }, { source: 'follower' });
    const preservedAfterMissing = {
      existing: document.querySelector('#existing-single .pull-right').textContent,
      late: document.querySelector('#late-single .pull-right').textContent,
      acknowledged: document.querySelector('#ack-single .pull-right').textContent,
      multi: document.querySelector('#multi-group .pull-right').textContent,
      ambiguous: document.querySelector('#ambiguous-group .pull-right').textContent,
      historyEntries: hooks.singleAlertAge?.getHistoryStats?.().entries ?? null
    };

    const existingCount = document.querySelector('#existing-single .pull-right');
    const requestsBeforeReset = refreshRequests;
    existingCount.textContent = '1 alerts';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restoredAfterTextReset = existingCount.textContent;
    const resetTriggeredFetch = refreshRequests !== requestsBeforeReset;
    const resetLogCount = ageDebugLogs.length;
    const resetLog = ageDebugLogs[0] || null;

    const replacement = document.createElement('span');
    replacement.className = 'pull-right ng-binding';
    replacement.textContent = '1 alerts';
    existingCount.replaceWith(replacement);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restoredReplacement = replacement.textContent;

    hooks.applyAlertsPayload({ Groups: {
      NeedAck: [{ Subject: 'existing single', Children: [{ Ago: ago2h, State: { Id: 901 } }] }],
      Acknowledged: []
    }}, { source: 'follower' });
    const updatedFromSnapshot = replacement.textContent;

    for (let index = 0; index < 25; index += 1) {
      replacement.textContent = '1 alerts';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const primitiveLogsOnly = ageDebugLogs.every((entry) => (
      entry &&
      Object.getPrototypeOf(entry) === Object.prototype &&
      Object.values(entry).every((value) => (
        value === null || ['string', 'number', 'boolean'].includes(typeof value)
      ))
    ));
    const forbiddenDiagnosticKeys = ['mutation', 'target', 'addedNodes', 'removedNodes', 'payload', 'snapshot'];
    const forbiddenKeysAbsent = ageDebugLogs.every((entry) => (
      forbiddenDiagnosticKeys.every((key) => !Object.prototype.hasOwnProperty.call(entry, key))
    ));
    console.debug = originalConsoleDebug;
    return {
      firstPass,
      lateAge,
      preservedAfterMissing,
      restoredAfterTextReset,
      restoredReplacement,
      updatedFromSnapshot,
      resetTriggeredFetch,
      requestsAfterInitialDom,
      totalRefreshRequests: refreshRequests,
      extensionMutationCounters,
      externalClassResetCounters,
      unrelatedMutationCounters,
      normalMutationLogCount,
      characterDataReset,
      resetLogCount,
      resetLog,
      debugLogCount: ageDebugLogs.length,
      debugMaxProblems: BosunHelperSingleAlertAge.SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS,
      primitiveLogsOnly,
      forbiddenKeysAbsent
    };
  })()`);
  assert.deepStrictEqual(singleAlertLifecycleResult.firstPass, {
    single: '43m-ago',
    multi: '2 alerts',
    acknowledged: '2h-ago',
    ambiguous: '1 alerts'
  });
  assert.strictEqual(singleAlertLifecycleResult.lateAge, '43m-ago');
  assert.deepStrictEqual(singleAlertLifecycleResult.characterDataReset, {
    repainted: '43m-ago', control: '43m-ago'
  }, 'Single Alert Age must repaint native Text.data changes with an unchanged verified snapshot');
  assert.deepStrictEqual(singleAlertLifecycleResult.preservedAfterMissing, {
    existing: '43m-ago',
    late: '43m-ago',
    acknowledged: '2h-ago',
    multi: '2 alerts',
    ambiguous: '1 alerts',
    historyEntries: 3
  });
  assert.strictEqual(singleAlertLifecycleResult.restoredAfterTextReset, '43m-ago');
  assert.strictEqual(singleAlertLifecycleResult.restoredReplacement, '43m-ago');
  assert.strictEqual(singleAlertLifecycleResult.updatedFromSnapshot, '2h-ago');
  assert.strictEqual(singleAlertLifecycleResult.resetTriggeredFetch, false);
  assert.ok(singleAlertLifecycleResult.requestsAfterInitialDom <= 1);
  assert.ok(singleAlertLifecycleResult.totalRefreshRequests <= 3, 'MutationObserver entered a refresh loop');
  assert.deepStrictEqual(
    singleAlertLifecycleResult.extensionMutationCounters,
    { domRefreshes: 0, dataRefreshes: 0 },
    'Extension-managed class mutations must not schedule a full DOM or data refresh'
  );
  assert.deepStrictEqual(
    singleAlertLifecycleResult.externalClassResetCounters,
    { domRefreshes: 1, dataRefreshes: 0 },
    'External removal of an extension class must schedule one repaint'
  );
  assert.deepStrictEqual(
    singleAlertLifecycleResult.unrelatedMutationCounters,
    { domRefreshes: 0, dataRefreshes: 0 },
    'Mutation outside scoped alert roots must not schedule refresh work'
  );
  assert.strictEqual(singleAlertLifecycleResult.normalMutationLogCount, 0);
  assert.strictEqual(singleAlertLifecycleResult.resetLogCount, 1);
  assert.deepStrictEqual({
    event: singleAlertLifecycleResult.resetLog.event,
    section: singleAlertLifecycleResult.resetLog.section,
    previousText: singleAlertLifecycleResult.resetLog.previousText,
    currentText: singleAlertLifecycleResult.resetLog.currentText,
    expectedText: singleAlertLifecycleResult.resetLog.expectedText,
    snapshotMatches: singleAlertLifecycleResult.resetLog.snapshotMatches,
    matchingResult: singleAlertLifecycleResult.resetLog.matchingResult,
    matchingReason: singleAlertLifecycleResult.resetLog.matchingReason,
    decision: singleAlertLifecycleResult.resetLog.decision,
    consideredOwn: singleAlertLifecycleResult.resetLog.consideredOwn,
    observerTriggered: singleAlertLifecycleResult.resetLog.observerTriggered,
    repaintAttempted: singleAlertLifecycleResult.resetLog.repaintAttempted,
    repaintResult: singleAlertLifecycleResult.resetLog.repaintResult,
    finalTextAfterRepaint: singleAlertLifecycleResult.resetLog.finalTextAfterRepaint
  }, {
    event: 'age-reset-to-counter',
    section: 'NeedAck',
    previousText: '43m-ago',
    currentText: '1 alerts',
    expectedText: '43m-ago',
    snapshotMatches: 0,
    matchingResult: 'no-match',
    matchingReason: 'missing-candidate',
    decision: 'preserve-last-valid-match',
    consideredOwn: false,
    observerTriggered: true,
    repaintAttempted: true,
    repaintResult: 'set-age',
    finalTextAfterRepaint: '43m-ago'
  });
  assert.strictEqual(singleAlertLifecycleResult.debugMaxProblems, 20);
  assert.strictEqual(singleAlertLifecycleResult.debugLogCount, 20);
  assert.strictEqual(singleAlertLifecycleResult.primitiveLogsOnly, true);
  assert.strictEqual(singleAlertLifecycleResult.forbiddenKeysAbsent, true);

  const ageTextMutationResult = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    let refreshRequests = 0, apiRequests = 0;
    win.BosunHelperRefreshCoordinator = { createRefreshCoordinator() {
      return { start() {}, stop() {}, requestRefresh() { refreshRequests += 1; } };
    } };
    win.fetch = () => { apiRequests += 1; return Promise.reject(new Error('Unexpected synthetic fetch')); };
    win.eval(${JSON.stringify(singleAlertAgeSource)});
    win.eval(${JSON.stringify(contentSource)});
    const hooks = win.__BosunHelperBrowserTest;
    const settle = () => new Promise(resolve => win.setTimeout(resolve, 180));
    const ago = new Date(Date.now() - 43 * 60000).toISOString();
    const payload = { Groups: { NeedAck: [
      { Subject: 'synthetic repaint A', Children: [{ Ago: ago, State: { Id: 101 } }] },
      { Subject: 'synthetic repaint B', Children: [{ Ago: ago, State: { Id: 102 } }] }
    ] } };
    doc.body.innerHTML = '<div ts-ack-group="schedule.Groups.NeedAck"><div class="panel-group"></div></div>';
    const list = doc.querySelector('.panel-group');
    function panel(subject, id) {
      const node = doc.createElement('div'); node.className = 'panel';
      node.innerHTML = '<div class="panel-heading"><div class="panel-title">' +
        '<span ng-bind="group.Subject"></span><span class="pull-right ng-binding">1 alerts</span></div></div>' +
        '<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading">' +
        '<span ng-show="state.Id"></span></div></div>';
      node.querySelector('[ng-bind="group.Subject"]').textContent = subject;
      node.querySelector('[ng-show="state.Id"]').textContent = '#' + id;
      return node;
    }
    let group = panel('synthetic repaint A', 101);
    const control = panel('synthetic repaint B', 102);
    const count = node => node.querySelector('.pull-right.ng-binding');
    list.append(group, control);
    hooks.applyAlertsPayload(payload, { source: 'follower' }); hooks.startObserver();
    await settle();
    let repaintCalls = 0;
    const originalRefresh = hooks.singleAlertAge.refresh;
    hooks.singleAlertAge.refresh = (...args) => { repaintCalls += 1; return originalRefresh(...args); };
    const diagnostic = win.BosunHelperSingleAlertAgeDiagnostics;
    const beforeDiagnostic = count(group).textContent;
    diagnostic.start({ durationMs: 10000 });
    const startChangedDisplay = count(group).textContent !== beforeDiagnostic;
    const startRepaintCalls = repaintCalls;
    const requestsBefore = refreshRequests;
    const texts = [];
    for (let pass = 0; pass < 4; pass += 1) {
      for (const writer of ['data', 'nodeValue', 'textContent']) {
        const node = count(group);
        if (writer === 'textContent') node.textContent = '1 alerts';
        else node.firstChild[writer] = '1 alerts';
        await settle();
        texts.push({ writer, text: count(group).textContent, control: count(control).textContent,
          sameCountNode: count(group) === node });
      }
    }
    const callsAfterWrites = repaintCalls;
    await settle(); await settle();
    const idleCalls = repaintCalls - callsAfterWrites;
    const mutationRefreshRequests = refreshRequests - requestsBefore;
    const replacement = doc.createElement('span'); replacement.className = 'pull-right ng-binding';
    replacement.textContent = '1 alerts'; count(group).replaceWith(replacement);
    await settle(); const afterCountReplacement = replacement.textContent;
    const nextPanel = panel('synthetic repaint A', 101); group.replaceWith(nextPanel); group = nextPanel;
    await settle(); const afterPanelReplacement = count(group).textContent;
    payload.Groups.NeedAck[0].Children[0].Ago = new Date(Date.now() - 2 * 3600000).toISOString();
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    await settle(); const afterSnapshot = count(group).textContent;
    const childId = group.querySelector('[ng-show="state.Id"]');
    childId.firstChild.data = '#999';
    await settle(); const identityConflict = count(group).textContent;
    count(group).firstChild.nodeValue = '1 alerts';
    await settle(); const conflictAfterRepaint = count(group).textContent;
    childId.firstChild.nodeValue = '#101';
    await settle(); const afterIdentityRestored = count(group).textContent;
    const controlFinal = count(control).textContent;
    // Diagnostic observation must not repair presentation on its own.
    const liveRefresh = hooks.singleAlertAge.refresh;
    hooks.singleAlertAge.refresh = () => {};
    count(group).firstChild.data = '1 alerts';
    await settle();
    const unrepainted = diagnostic.report();
    const observedWithoutRepair = count(group).textContent;
    hooks.singleAlertAge.refresh = liveRefresh;
    liveRefresh(); await settle();
    diagnostic.stop();
    const diagnosticReport = diagnostic.report();
    const serializedReport = JSON.stringify(diagnosticReport);
    frame.remove();
    return { texts, callsAfterWrites, idleCalls, mutationRefreshRequests, apiRequests,
      afterCountReplacement, afterPanelReplacement, afterSnapshot, identityConflict,
      conflictAfterRepaint, afterIdentityRestored, controlFinal, startChangedDisplay, startRepaintCalls,
      observedWithoutRepair, unrepainted, diagnosticReport, serializedReport };
  })()`);
  assert.strictEqual(ageTextMutationResult.texts.length, 12);
  assert.ok(ageTextMutationResult.texts.every(row => row.text === '43m-ago' &&
    row.control === '43m-ago' && row.sameCountNode), 'Every native text writer must repaint only verified age');
  assert.ok(ageTextMutationResult.callsAfterWrites >= 12 && ageTextMutationResult.callsAfterWrites <= 14,
    'Native writes must cause bounded repaint work');
  assert.strictEqual(ageTextMutationResult.idleCalls, 0, 'Own age writes must not sustain an observer loop');
  assert.strictEqual(ageTextMutationResult.mutationRefreshRequests, 0, 'Text changes must not request a snapshot');
  assert.strictEqual(ageTextMutationResult.apiRequests, 0, 'Repaint must not call an API');
  assert.strictEqual(ageTextMutationResult.afterCountReplacement, '43m-ago');
  assert.strictEqual(ageTextMutationResult.afterPanelReplacement, '43m-ago');
  assert.strictEqual(ageTextMutationResult.afterSnapshot, '2h-ago');
  assert.strictEqual(ageTextMutationResult.identityConflict, '1 alerts');
  assert.strictEqual(ageTextMutationResult.conflictAfterRepaint, '1 alerts');
  assert.strictEqual(ageTextMutationResult.afterIdentityRestored, '2h-ago');
  assert.strictEqual(ageTextMutationResult.controlFinal, '43m-ago');
  assert.strictEqual(ageTextMutationResult.startChangedDisplay, false);
  assert.strictEqual(ageTextMutationResult.startRepaintCalls, 0);
  assert.strictEqual(ageTextMutationResult.observedWithoutRepair, '1 alerts');
  assert.ok(Object.values(ageTextMutationResult.unrepainted.panels).some(row =>
    row.identityReason === 'group-key' && row.state === 'count' && row.repaintAttempted === false));
  const diagnosticEvents = ageTextMutationResult.diagnosticReport.events;
  assert.ok(diagnosticEvents.some(row => row.identityReason === 'strong-key-mismatch' &&
    row.presentationReason === 'dom-child-count-mismatch' && row.restoreCountApplied === true));
  assert.ok(diagnosticEvents.some(row => row.event === 'count-mutation' && row.before === 'age' &&
    row.after === 'count' && row.origin === 'observed-dom-write'));
  assert.ok(diagnosticEvents.some(row => row.event === 'count-mutation' && row.before === 'age' &&
    row.after === 'count' && row.origin === 'extension-write'));
  assert.strictEqual(ageTextMutationResult.diagnosticReport.active, false);
  for (const forbidden of ['synthetic repaint', 'not-current.invalid', 'subjectHash', 'groupKeyHash', 'AlertKey']) {
    assert.ok(!ageTextMutationResult.serializedReport.includes(forbidden), 'Diagnostic report leaked operational text');
  }

  // Исследовательские сценарии проверяют существующий безопасный отказ, а не недоказанное исправление.
  const ageSnapshotSkewResult = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    let apiRequests = 0;
    win.fetch = () => { apiRequests += 1; throw new Error('Unexpected synthetic fetch'); };
    win.BosunHelperRefreshCoordinator = { createRefreshCoordinator() {
      return { start() {}, stop() {}, requestRefresh() {} };
    } };
    win.eval(${JSON.stringify(singleAlertAgeSource)});
    let clock = Date.now();
    const baseClock = clock;
    const create = win.BosunHelperSingleAlertAge.createSingleAlertAge;
    win.BosunHelperSingleAlertAge.createSingleAlertAge = options => create({ ...options, now: () => clock });
    win.eval(${JSON.stringify(contentSource)});
    const hooks = win.__BosunHelperBrowserTest, diag = win.BosunHelperSingleAlertAgeDiagnostics;
    const ago = new Date(clock - 14 * 60000).toISOString();
    doc.body.innerHTML = '<div ts-ack-group="schedule.Groups.NeedAck"><div class="panel-group"></div></div>' +
      '<div ts-ack-group="schedule.Groups.Acknowledged"><div class="panel-group"></div></div>';
    const lists = doc.querySelectorAll('.panel-group');
    function panel(subject) {
      const node = doc.createElement('div'); node.className = 'panel';
      node.innerHTML = '<div class="panel-heading"><div class="panel-title"><span ng-bind="group.Subject"></span>' +
        '<span class="pull-right ng-binding">1 alerts</span></div></div>';
      node.querySelector('[ng-bind="group.Subject"]').textContent = subject;
      return node;
    }
    const group = panel('synthetic skew A'), control = panel('synthetic skew B');
    lists[0].append(group, control);
    const count = node => node.querySelector('.pull-right.ng-binding').textContent;
    const data = (subject = 'synthetic skew A', id = 201) => ({ Subject: subject,
      Children: [{ Ago: ago, State: { Id: id } }] });
    const payload = (first, moved = false, extra = false) => ({ Groups: {
      NeedAck: [...(moved ? [] : [first]), data('synthetic skew B', 202), ...(extra ? [data('synthetic skew C', 203)] : [])],
      Acknowledged: moved ? [first] : [] } });
    const apply = (value, source = 'follower') => hooks.applyAlertsPayload(value, { source });
    const row = () => diag.report().panels[1];
    const cases = [];
    for (const source of ['follower', 'leader']) {
      for (const variant of ['subject', 'section', 'whitespace', 'removed']) {
        clock = baseClock;
        diag.clear();
        apply(payload(data()), 'prime'); diag.start({ durationMs: 120000 });
        const initial = row();
        const changed = variant === 'subject' ? payload(data('synthetic skew changed'))
          : variant === 'section' ? payload(data(), true)
          : variant === 'whitespace' ? payload(data('synthetic  skew A'))
          : { Groups: { NeedAck: [data('synthetic skew B', 202)], Acknowledged: [] } };
        apply(changed, source);
        const preserved = row();
        // Advance only injected domain time, avoiding real waits or changed grace limits.
        clock += 16000; apply(changed, source);
        const expired = row();
        apply(changed, source);
        const persistent = row();
        const comparison = diag.report().events.find(event => event.event === 'snapshot-index-comparison' &&
          event.panel === 1 && event.previousRecordFound && !event.exactSubjectMatch);
        const states = [count(group), count(control)];
        apply(payload(data()), source);
        cases.push({ source, variant, initial, preserved, expired, persistent, comparison, states, recovered: row() });
      }
    }
    diag.clear(); apply(payload(data()), 'prime'); diag.start();
    apply(payload(data('synthetic skew A', 999)));
    const childIdOnly = row();
    const childChange = diag.report().events.filter(event => event.event === 'snapshot-index-comparison' && event.panel === 1).at(-1);
    const two = data(); two.Children.push({ Ago: ago, State: { Id: 204 } }); apply(payload(two));
    const childCountChange = { row: row(), text: count(group) };
    apply(payload(data(), false, true));
    const increasedGroupCount = { row: row(), groups: diag.report().snapshotGroups, panels: diag.report().domPanelsFound };
    // Native DOM advances first; the old snapshot cannot confirm its new subject.
    group.querySelector('[ng-bind="group.Subject"]').textContent = 'synthetic skew newer';
    hooks.singleAlertAge.refresh(); const domFirst = row();
    apply(payload(data('synthetic skew newer'))); const synchronized = row();
    // Section changes of the same DOM object are observable without matching by order.
    lists[1].append(group); hooks.singleAlertAge.refresh(); const domSectionChange = row();
    apply(payload(data('synthetic skew newer'), true)); const synchronizedSection = row();
    diag.stop(); const serialized = JSON.stringify(diag.report()); frame.remove();
    return { cases, childIdOnly, childChange, childCountChange, increasedGroupCount,
      domFirst, synchronized, domSectionChange, synchronizedSection, serialized, apiRequests };
  })()`);
  for (const scenario of ageSnapshotSkewResult.cases) {
    assert.strictEqual(scenario.initial.identityReason, 'unique-subject');
    assert.strictEqual(scenario.initial.domChildCount, 0, 'Collapsed children are valid');
    assert.strictEqual(scenario.initial.state, 'age');
    assert.strictEqual(scenario.preserved.identityReason, 'missing-candidate');
    assert.strictEqual(scenario.preserved.presentationReason, 'preserved-mapping');
    assert.strictEqual(scenario.expired.presentationReason, 'restore-count');
    assert.strictEqual(scenario.expired.graceTimeLimitExceeded, true);
    assert.strictEqual(scenario.expired.restoreCountApplied, true);
    assert.strictEqual(scenario.persistent.identityReason, 'missing-candidate');
    assert.strictEqual(scenario.persistent.state, 'count');
    assert.deepStrictEqual(scenario.states, ['1 alerts', '14m-ago']);
    assert.strictEqual(scenario.comparison.previousIdentityReason, 'unique-subject');
    assert.strictEqual(scenario.comparison.previousSubjectMatch, true);
    assert.strictEqual(scenario.comparison.previousStableChildIdAvailable, true);
    assert.strictEqual(scenario.comparison.stableChildFoundInNewSnapshot, scenario.variant !== 'removed');
    assert.strictEqual(scenario.comparison.stableChildMatchCount, scenario.variant === 'removed' ? 0 : 1);
    assert.strictEqual(scenario.comparison.sameStableChildDifferentSubject,
      scenario.variant === 'subject' || scenario.variant === 'whitespace');
    assert.strictEqual(scenario.comparison.sameStableChildDifferentSection, scenario.variant === 'section');
    assert.strictEqual(scenario.comparison.previousGroupDisappeared, scenario.variant === 'removed');
    assert.strictEqual(scenario.comparison.candidateInOtherSection, scenario.variant === 'section');
    assert.strictEqual(scenario.comparison.previousGroupKeyInOtherSection, scenario.variant === 'section');
    assert.strictEqual(scenario.comparison.whitespaceNormalizedMatch, scenario.variant === 'whitespace');
    assert.strictEqual(scenario.recovered.identityReason, 'unique-subject');
    assert.strictEqual(scenario.recovered.state, 'age');
  }
  assert.strictEqual(ageSnapshotSkewResult.childIdOnly.identityReason, 'unique-subject');
  assert.strictEqual(ageSnapshotSkewResult.childIdOnly.state, 'age');
  assert.strictEqual(ageSnapshotSkewResult.childChange.groupKeyRepresentationChanged, true);
  assert.strictEqual(ageSnapshotSkewResult.childCountChange.row.identityReason, 'unique-subject');
  assert.strictEqual(ageSnapshotSkewResult.childCountChange.text, '2 alerts');
  assert.strictEqual(ageSnapshotSkewResult.increasedGroupCount.groups, 3);
  assert.strictEqual(ageSnapshotSkewResult.increasedGroupCount.panels, 2);
  assert.strictEqual(ageSnapshotSkewResult.increasedGroupCount.row.state, 'age');
  assert.strictEqual(ageSnapshotSkewResult.domFirst.identityReason, 'missing-candidate');
  assert.strictEqual(ageSnapshotSkewResult.domFirst.state, 'count');
  assert.strictEqual(ageSnapshotSkewResult.synchronized.state, 'age');
  assert.strictEqual(ageSnapshotSkewResult.domSectionChange.sectionChanged, true);
  assert.strictEqual(ageSnapshotSkewResult.domSectionChange.identityReason, 'missing-candidate');
  assert.strictEqual(ageSnapshotSkewResult.synchronizedSection.state, 'age');
  assert.strictEqual(ageSnapshotSkewResult.apiRequests, 0);
  assert.ok(!ageSnapshotSkewResult.serialized.includes('synthetic skew'));
};
