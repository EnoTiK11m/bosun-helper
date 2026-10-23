'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runMarkerLifecycleScenarios({ client, settingsSource, singleAlertAgeSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource, priorityRowActions }) {
  const markerRepaintLifecycle = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise((resolve) => { frame.onload = resolve; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    let requests = 0;
    win.BosunHelperRefreshCoordinator = { createRefreshCoordinator() {
      return { start() {}, stop() {}, requestRefresh() { requests += 1; } };
    } };
    win.eval(${JSON.stringify(settingsSource)});
    win.eval(${JSON.stringify(alertsDataSource)});
    win.eval(${JSON.stringify(needAckSeveritySource)});
    win.eval(${JSON.stringify(prioritySource)});
    win.eval(${JSON.stringify(singleAlertAgeSource)});
    win.eval(${JSON.stringify(stylesSource)});
    win.eval(${JSON.stringify(contentSource)});
    const hooks = win.__BosunHelperBrowserTest;
    const settings = JSON.parse(JSON.stringify(win.BosunHelperSettings.DEFAULTS));
    settings.features.priorityAlerts = true;
    settings.priorityRules.exactAlertNames = ['synthetic.repaint'];
    hooks.applySettingsSnapshot(settings, { initial: true }); hooks.injectStyles();
    const row = { Alert: 'synthetic.repaint', Subject: 'synthetic.repaint{host=demo}',
      AlertKey: 'synthetic.repaint{host=demo}', Ago: new Date(Date.now() - 17 * 60 * 1000).toISOString(), State: {
        Id: 7101, CurrentStatus: 'critical', Actions: [{ Type: 'Note', User: 'operator', Message: 'synthetic' }]
      } };
    const root = doc.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    root.innerHTML = '<div class="panel-group"><div class="panel"><div class="panel-heading"><h4 class="panel-title">' +
      '<a><span ng-bind="group.Subject">synthetic repaint group</span><span class="pull-right ng-binding">1 alerts</span></a>' +
      '<label><input type="checkbox"></label></h4></div><div class="panel-body panel-group">' +
      '<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading"><h4 class="panel-title">' +
      '<span ng-show="state.Id">#7101</span><span ng-bind="child.Subject || child.AlertKey">synthetic.repaint{host=demo}</span>' +
      '<span ts-since="child.Ago">17m-ago</span><input type="checkbox"></h4></div></div></div></div></div>';
    doc.body.appendChild(root);
    const group = root.querySelector('.panel'), child = root.querySelector('[ng-repeat]');
    const pristineGroup = group.querySelector(':scope > .panel-heading').cloneNode(true);
    const pristineChild = child.querySelector(':scope > .panel-heading').cloneNode(true);
    const payload = { Groups: { NeedAck: [{ Subject: 'synthetic repaint group', Children: [row] }] } };
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    hooks.startObserver();
    const settle = () => new Promise((resolve) => win.setTimeout(resolve, 350));
    function state(panel) {
      const h = panel.querySelector(':scope > .panel-heading');
      return { note: h.querySelectorAll('.bosun-has-note-icon').length,
        priority: h.querySelectorAll('.bosun-priority-marker').length, accent: h.classList.contains('bosun-priority-row') };
    }
    const states = {};
    await settle(); states.initial = [state(group), state(child)];
    // Native Bosun can render a differently grouped/filtered response while the
    // extension retains its unfiltered snapshot. The child ID is unchanged.
    const liveHeading = group.querySelector(':scope > .panel-heading');
    const liveSubject = liveHeading.querySelector('[ng-bind="group.Subject"]');
    liveSubject.textContent = 'warning: synthetic filtered subject';
    await settle();
    const liveMismatch = {
      rows: [state(group), state(child)],
      headingSame: group.querySelector(':scope > .panel-heading') === liveHeading,
      headingConnected: liveHeading.isConnected,
      repeatCount: group.querySelectorAll('[ng-repeat="child in group.Children"]').length,
      groupKeyMatches: hooks.buildGroupMarkerKeyFromDom(group) === hooks.buildGroupMarkerKeyFromData(payload.Groups.NeedAck[0]),
      subjectComponentEqual: liveSubject.textContent === payload.Groups.NeedAck[0].Subject,
      childIdComponentEqual: child.querySelector('span[ng-show="state.Id"]').textContent === '#' + row.State.Id,
      childResolvedPriority: hooks.resolveChildIndexedState(child, group)?.priority === true,
      groupNoteState: hooks.resolveGroupState(group)
    };
    const liveSafety = {};
    const liveId = child.querySelector('span[ng-show="state.Id"]');
    liveId.textContent = '#7102'; await settle(); liveSafety.unknownId = state(group).priority;
    liveId.textContent = '#7101'; await settle(); liveSafety.restoredId = state(group).priority;
    const duplicateChild = child.cloneNode(true); child.parentElement.appendChild(duplicateChild);
    await settle(); liveSafety.duplicateDomId = state(group).priority;
    duplicateChild.remove(); await settle();
    const unresolvedChild = child.cloneNode(true);
    unresolvedChild.querySelector('span[ng-show="state.Id"]').textContent = '#7199';
    child.parentElement.appendChild(unresolvedChild);
    await settle(); liveSafety.mixedUnresolved = state(group).priority;
    unresolvedChild.remove(); await settle();
    const savedId = liveId.cloneNode(true); liveId.remove();
    await settle(); liveSafety.noStableId = state(group).priority;
    child.querySelector('.panel-title').prepend(savedId); await settle();
    const childBodyForSkew = group.querySelector(':scope > .panel-body');
    childBodyForSkew.remove(); await settle(); liveSafety.collapsedMismatch = state(group).priority;
    group.appendChild(childBodyForSkew); await settle(); liveSafety.reexpanded = state(group).priority;
    hooks.setFeature('priorityAlerts', false); await settle(); liveSafety.disabled = state(group).priority;
    hooks.setFeature('priorityAlerts', true); await settle(); liveSafety.reenabled = state(group).priority;
    liveSubject.textContent = 'synthetic repaint group';
    await settle();
    requests = 0; hooks.resetLifecycleCounters();
    child.querySelector('[ts-since]').textContent = '18m-ago';
    await settle(); states.time = [state(group), state(child)];
    group.querySelector('.pull-right.ng-binding').textContent = '1 alerts';
    await settle(); states.counter = [state(group), state(child)];
    group.querySelector(':scope > .panel-heading').replaceWith(pristineGroup.cloneNode(true));
    await settle(); states.group = [state(group), state(child)];
    child.querySelector(':scope > .panel-heading').replaceWith(pristineChild.cloneNode(true));
    await settle(); states.child = [state(group), state(child)];
    const count = group.querySelector('.pull-right.ng-binding');
    const childHeading = child.querySelector(':scope > .panel-heading');
    function restoredCountState() {
      return { rows: [state(group), state(child)], text: count.textContent,
        expected: count.dataset.bosunSingleAlertExpectedText,
        managedAge: count.dataset.bosunSingleAlertAge || null,
        originalCount: count.dataset.bosunOriginalAlertCount || null,
        decision: count.dataset.bosunSingleAlertAgeDecision || null,
        stableChildHeading: child.querySelector(':scope > .panel-heading') === childHeading,
        childId: childHeading.querySelector('span[ng-show="state.Id"]').textContent,
        copy: group.querySelectorAll(':scope > .panel-heading .bosun-copy-alert-btn').length };
    }
    // The actual age cleanup must only restore the counter, never the heading baseline.
    settings.features.singleAlertAge = false;
    hooks.applySettingsSnapshot(settings, { changedPaths: ['features.singleAlertAge'] });
    await settle(); const ageCleanup = restoredCountState();
    settings.features.singleAlertAge = true;
    hooks.applySettingsSnapshot(settings, { changedPaths: ['features.singleAlertAge'] });
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    await settle(); states.afterCleanup = [state(group), state(child)];
    // A new snapshot can retain child identity while invalidating the composite group key.
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'synthetic different group', Children: [row]
    }] } }, { source: 'follower' });
    await settle(); const groupMismatch = restoredCountState();
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    await settle(); states.afterMismatch = [state(group), state(child)];
    settings.priorityRules.exactAlertNames = ['synthetic.repaint'];
    hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
    const warningRow = JSON.parse(JSON.stringify(row));
    warningRow.State.CurrentStatus = 'warning';
    const warningPayload = { Groups: { NeedAck: [{ Subject: 'synthetic repaint group',
      Status: 'warning', CurrentStatus: 'warning', Children: [warningRow] }] } };
    group.setAttribute('ng-repeat', 'group in groups');
    group.setAttribute('ng-class', 'panelClass(group.Status)');
    const groupHeading = group.querySelector(':scope > .panel-heading');
    groupHeading.setAttribute('ng-class', "panelClass(group.CurrentStatus)+'-box'");
    groupHeading.setAttribute('ng-click', 'collapse(idx)');
    for (let pass = 0; pass < 3; pass += 1) {
      groupHeading.className = 'panel-heading panel-warning-box';
      hooks.applyAlertsPayload(JSON.parse(JSON.stringify(warningPayload)), { source: 'follower' });
      await settle(); states['warningSnapshot' + pass] = [state(group), state(child)];
    }
    const snapshotFieldChanges = [];
    for (const change of [
      {}, { Status: 'critical', CurrentStatus: 'unknown' },
      { child: { Subject: 'synthetic.repaint{host=other}', AlertKey: 'synthetic.repaint{host=other}',
        Tags: 'host=other', Ago: new Date(Date.now() - 16 * 60 * 1000).toISOString() } }
    ]) {
      const next = JSON.parse(JSON.stringify(warningPayload));
      const nextGroup = next.Groups.NeedAck[0];
      if (change.child) Object.assign(nextGroup.Children[0], change.child);
      else Object.assign(nextGroup, change);
      hooks.applyAlertsPayload(next, { source: 'follower' });
      await settle(); snapshotFieldChanges.push([state(group), state(child)]);
    }
    const childBody = group.querySelector(':scope > .panel-body');
    childBody.remove();
    await settle(); const collapsedPriority = state(group);
    group.appendChild(childBody);
    await settle(); const expandedPriority = state(group);
    // Control: selectively lost Priority must repaint without replacing either heading
    // or requesting a snapshot; this is not a claim about the live mutation's cause.
    groupHeading.classList.remove('bosun-priority-row');
    groupHeading.querySelector('.bosun-priority-marker').remove();
    const partialPriorityLoss = restoredCountState();
    await settle(); const priorityRepaint = restoredCountState();
    const nativeChildAge = child.querySelector('[ts-since="child.Ago"]').textContent;
    const counters = hooks.getLifecycleCounters();
    frame.remove();
    return { states, liveMismatch, liveSafety, ageCleanup, groupMismatch, snapshotFieldChanges, collapsedPriority, expandedPriority,
      partialPriorityLoss, priorityRepaint, nativeChildAge, counters, requests };
  })()`);
  const decoratedRepaintRow = { note: 1, priority: 1, accent: true };
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.groupKeyMatches, false);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.childResolvedPriority, true);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.groupNoteState, 'note');
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.headingSame, true);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.headingConnected, true);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.repeatCount, 1);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.subjectComponentEqual, false);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.childIdComponentEqual, true);
  assert.strictEqual(markerRepaintLifecycle.liveMismatch.rows[0].note, 1);
  assert.deepStrictEqual(markerRepaintLifecycle.liveMismatch.rows, [decoratedRepaintRow, decoratedRepaintRow],
    'LIVE equivalent: group Subject skew must not strip Priority aggregated from its safely resolved ID child');
  assert.deepStrictEqual(markerRepaintLifecycle.liveSafety, {
    unknownId: 0, restoredId: 1, duplicateDomId: 0, mixedUnresolved: 0, noStableId: 0,
    collapsedMismatch: 0, reexpanded: 1, disabled: 0, reenabled: 1
  });
  assert.deepStrictEqual(markerRepaintLifecycle.states, {
    initial: [decoratedRepaintRow, decoratedRepaintRow], time: [decoratedRepaintRow, decoratedRepaintRow],
    counter: [decoratedRepaintRow, decoratedRepaintRow],
    group: [decoratedRepaintRow, decoratedRepaintRow], child: [decoratedRepaintRow, decoratedRepaintRow],
    afterCleanup: [decoratedRepaintRow, decoratedRepaintRow], afterMismatch: [decoratedRepaintRow, decoratedRepaintRow],
    warningSnapshot0: [decoratedRepaintRow, decoratedRepaintRow],
    warningSnapshot1: [decoratedRepaintRow, decoratedRepaintRow],
    warningSnapshot2: [decoratedRepaintRow, decoratedRepaintRow]
  }, 'Native time/header mutations must restore Note and Priority without a new snapshot');
  const nativeCountState = { text: '1 alerts', expected: '1 alerts', managedAge: null,
    originalCount: null, decision: null, stableChildHeading: true, childId: '#7101', copy: 1 };
  assert.deepStrictEqual(markerRepaintLifecycle.ageCleanup, {
    rows: [decoratedRepaintRow, decoratedRepaintRow], ...nativeCountState
  }, 'Single-alert-age cleanup must preserve group and child Note/Priority decorations');
  assert.deepStrictEqual(markerRepaintLifecycle.groupMismatch, {
    rows: [decoratedRepaintRow, decoratedRepaintRow], ...nativeCountState
  }, 'Group-key mismatch must keep native age while Note and Priority aggregate proven visible children');
  // В последнем снимке Ago намеренно изменён; штатный дочерний текст остаётся старым.
  assert.strictEqual(markerRepaintLifecycle.nativeChildAge, '17m-ago');
  const liveAgeState = { ...nativeCountState, text: '16m-ago', expected: '16m-ago',
    managedAge: 'true', originalCount: '1 alerts', decision: 'use-live-match' };
  assert.deepStrictEqual(markerRepaintLifecycle.partialPriorityLoss, {
    rows: [{ note: 1, priority: 0, accent: false }, decoratedRepaintRow], ...liveAgeState
  }, 'Selective Priority loss control must retain age, Note, copy and child identity');
  assert.deepStrictEqual(markerRepaintLifecycle.priorityRepaint, {
    rows: [decoratedRepaintRow, decoratedRepaintRow], ...liveAgeState
  }, 'The observer must restore selectively lost group Priority from the cached safe warning snapshot');
  for (const rows of markerRepaintLifecycle.snapshotFieldChanges) {
    assert.deepStrictEqual(rows, [decoratedRepaintRow, decoratedRepaintRow],
      'Snapshot field changes must preserve Priority/Note for the same safely resolved child ID');
  }
  assert.deepStrictEqual(markerRepaintLifecycle.collapsedPriority, decoratedRepaintRow);
  assert.deepStrictEqual(markerRepaintLifecycle.expandedPriority, decoratedRepaintRow);
  assert.strictEqual(markerRepaintLifecycle.requests, 0);
  assert.strictEqual(priorityRowActions.alertKeyOnlyPriority, true,
    'Adding a canonical AlertKey-only exact rule must also classify the resolved child and group as Priority');

  const collapsedPriorityIdentity = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    win.eval(${JSON.stringify(settingsSource)}); win.eval(${JSON.stringify(alertsDataSource)});
    win.eval(${JSON.stringify(needAckSeveritySource)}); win.eval(${JSON.stringify(prioritySource)});
    win.eval(${JSON.stringify(contentSource)});
    const hooks = win.__BosunHelperBrowserTest;
    const settings = JSON.parse(JSON.stringify(win.BosunHelperSettings.DEFAULTS));
    settings.features.priorityAlerts = true;
    settings.preferences.priorityCritical = false;
    settings.preferences.priorityShowAcknowledged = true;
    settings.priorityRules.exactAlertNames = ['synthetic.collapse'];
    hooks.applySettingsSnapshot(settings, { initial: true });
    const payload = { Groups: { NeedAck: [], Acknowledged: [] } }, groups = [];
    for (const section of ['NeedAck', 'Acknowledged']) {
      const root = doc.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
      const list = doc.createElement('div'); list.className = 'panel-group'; root.appendChild(list); doc.body.appendChild(root);
      for (const { size, skew, duplicateSubject = false } of [
        { size: 1, skew: false }, { size: 1, skew: true }, { size: 2, skew: false }, { size: 2, skew: true },
        { size: 1, skew: false, duplicateSubject: true }, { size: 1, skew: false, duplicateSubject: true }
      ]) {
        const subject = duplicateSubject ? 'synthetic duplicate group' : 'synthetic group ' + size + '-' + skew;
        const panel = doc.createElement('div'); panel.className = 'panel';
        panel.innerHTML = '<div class="panel-heading"><h4 class="panel-title"><span ng-bind="group.Subject"></span></h4></div>';
        panel.querySelector('[ng-bind]').textContent = skew ? 'native ' + subject : subject;
        list.appendChild(panel);
        const body = doc.createElement('div'); body.className = 'panel-body panel-group';
        const rows = [];
        for (let child = 0; child < size; child += 1) {
          const id = 8500 + groups.length * 10 + child;
          rows.push({ Alert: 'synthetic.collapse', Subject: 'synthetic child ' + id, Ago: '1m',
            State: { Id: id, CurrentStatus: 'warning', Actions: [{ Type: 'Note' }] } });
          const childPanel = doc.createElement('div'); childPanel.className = 'panel';
          childPanel.setAttribute('ng-repeat', 'child in group.Children');
          childPanel.innerHTML = '<div class="panel-heading" ng-click="toggle()"><h4 class="panel-title">' +
            '<span ng-show="state.Id">#' + id + '</span><span ng-bind="child.Subject || child.AlertKey">synthetic child ' + id + '</span>' +
            '<span ts-since="child.Ago">1m</span></h4></div>';
          body.appendChild(childPanel);
        }
        const snapshotGroup = { Subject: subject, Children: rows };
        payload.Groups[section].push(snapshotGroup);
        groups.push({ section, size, skew, duplicateSubject, panel, body, snapshotGroup });
      }
    }
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    const state = panel => {
      const heading = panel.querySelector(':scope > .panel-heading');
      return !!heading.querySelector('.bosun-priority-marker') && heading.classList.contains('bosun-priority-row');
    };
    const cases = groups.map(group => ({ section: group.section, size: group.size, skew: group.skew, duplicateSubject: group.duplicateSubject,
      initiallyCollapsed: state(group.panel) }));
    for (let pass = 0; pass < 2; pass += 1) {
      groups.forEach(group => group.panel.appendChild(group.body));
      hooks.runDomRefreshPass({ preserveExistingOnNone: true });
      groups.forEach((group, i) => {
        cases[i]['expanded' + pass] = [state(group.panel), ...Array.from(group.body.children).map(state)];
        cases[i].expandedKeyMatches = hooks.buildGroupMarkerKeyFromDom(group.panel) === hooks.buildGroupMarkerKeyFromData(group.snapshotGroup);
        cases[i].expandedNote = !!group.panel.querySelector(':scope > .panel-heading .bosun-has-note-icon');
      });
      groups.forEach(group => { group.body.hidden = true; });
      hooks.runDomRefreshPass({ preserveExistingOnNone: true });
      groups.forEach((group, i) => { cases[i].hiddenChildDom = state(group.panel); group.body.hidden = false; });
      groups.forEach(group => group.body.remove());
      hooks.runDomRefreshPass({ preserveExistingOnNone: true });
      groups.forEach((group, i) => {
        cases[i]['collapsed' + pass] = state(group.panel);
        cases[i].remainingChildNodes = group.panel.querySelectorAll('[ng-repeat]').length;
        cases[i].collapsedKeyMatches = hooks.buildGroupMarkerKeyFromDom(group.panel) === hooks.buildGroupMarkerKeyFromData(group.snapshotGroup);
        cases[i].parentAction = !!group.panel.querySelector('.bosun-priority-action');
      });
      hooks.applyAlertsPayload(JSON.parse(JSON.stringify(payload)), { source: 'follower' });
      groups.forEach((group, i) => { cases[i]['repeatedSnapshot' + pass] = state(group.panel); });
    }
    settings.priorityRules.exactAlertNames = [];
    hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
    const exactRemoved = groups.map(group => state(group.panel));
    settings.preferences.priorityCritical = true;
    hooks.applySettingsSnapshot(settings, { changedPaths: ['preferences.priorityCritical'] });
    groups.forEach(group => group.snapshotGroup.Children.forEach(child => { child.State.CurrentStatus = 'critical'; }));
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    const critical = groups.map(group => state(group.panel));
    hooks.setPreference('priorityShowAcknowledged', false);
    const ackOff = groups.map(group => state(group.panel));
    hooks.setPreference('priorityShowAcknowledged', true);
    const ackOn = groups.map(group => state(group.panel));
    groups.forEach(group => group.snapshotGroup.Children.forEach(child => { child.State.CurrentStatus = 'warning'; }));
    hooks.applyAlertsPayload(payload, { source: 'follower' });
    const snapshotRemoved = groups.map(group => state(group.panel));
    frame.remove(); return { cases, exactRemoved, critical, ackOff, ackOn, snapshotRemoved };
  })()`);
  for (const testCase of collapsedPriorityIdentity.cases) {
    // Несопоставленный или неоднозначный свёрнутый заголовок только с Subject не имеет штатного
    // ID группы или дочерней идентичности. Это явный блокер, а не использование кеша
    // Priority: разные алерты могут иметь неотличимые заголовки.
    const provableWhenCollapsed = !testCase.skew && !testCase.duplicateSubject;
    assert.strictEqual(testCase.initiallyCollapsed, provableWhenCollapsed);
    assert.strictEqual(testCase.remainingChildNodes, 0);
    assert.strictEqual(testCase.collapsedKeyMatches, false);
    assert.strictEqual(testCase.expandedKeyMatches, !testCase.skew);
    assert.strictEqual(testCase.hiddenChildDom, true, 'Hiding children without deleting their identity must retain Priority');
    assert.strictEqual(testCase.parentAction, false);
    assert.strictEqual(testCase.expandedNote, testCase.section === 'NeedAck');
    for (let pass = 0; pass < 2; pass += 1) {
      assert.deepStrictEqual(testCase['expanded' + pass], Array(testCase.size + 1).fill(true));
      assert.strictEqual(testCase['collapsed' + pass], provableWhenCollapsed);
      assert.strictEqual(testCase['repeatedSnapshot' + pass], provableWhenCollapsed);
    }
  }
  const expectedCollapsed = collapsedPriorityIdentity.cases.map(testCase => !testCase.skew && !testCase.duplicateSubject);
  assert.deepStrictEqual(collapsedPriorityIdentity.exactRemoved, expectedCollapsed.map(() => false));
  assert.deepStrictEqual(collapsedPriorityIdentity.snapshotRemoved, expectedCollapsed.map(() => false));
  assert.deepStrictEqual(collapsedPriorityIdentity.critical, expectedCollapsed.map(()=>false));
  assert.deepStrictEqual(collapsedPriorityIdentity.ackOn, expectedCollapsed.map(()=>false));
  assert.deepStrictEqual(collapsedPriorityIdentity.ackOff,
    expectedCollapsed.map(()=>false));
  const indicatorLifecycle = await evaluate(client, `(async () => {
    const results = {};
    for (const mode of ['normal']) {
      const frame = document.createElement('iframe'); frame.src = '/';
      await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
      const win = frame.contentWindow, doc = frame.contentDocument;
      let requests = 0;
      win.BosunHelperRefreshCoordinator = { createRefreshCoordinator() {
        return { start() {}, stop() {}, requestRefresh() { requests += 1; } };
      } };
      win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
      win.eval(${JSON.stringify(settingsSource)}); win.eval(${JSON.stringify(alertsDataSource)});
      win.eval(${JSON.stringify(needAckSeveritySource)}); win.eval(${JSON.stringify(prioritySource)});
      win.eval(${JSON.stringify(contentSource)});
      const hooks = win.__BosunHelperBrowserTest;
      const settings = JSON.parse(JSON.stringify(win.BosunHelperSettings.DEFAULTS));
      settings.features.priorityAlerts = true;
      settings.preferences.priorityCritical = false;
      settings.preferences.priorityShowAcknowledged = true;
      settings.priorityRules.exactAlertNames = ['synthetic.private.alert'];
      hooks.applySettingsSnapshot(settings, { initial: true });
      const row = { Alert: 'synthetic.private.alert', AlertKey: 'synthetic.private.alert{host=private-canary}',
        Subject: 'private-subject-canary', Ago: '1m', State: { Id: 8101, Alert: 'synthetic.private.alert',
          Actions: [{ Type: 'Note', User: 'private-user-canary', Message: 'private-note-canary' }] } };
      const ackRow = { ...row, Alert: 'synthetic.ack', AlertKey: 'synthetic.ack{host=private-canary}',
        State: { Id: 8101, Alert: 'synthetic.ack', Actions: [] } };
      function mount(section) {
        const root = doc.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
        root.innerHTML = '<div class="panel-group"><div class="panel"><div class="panel-heading"><h4 class="panel-title">' +
          '<span ng-bind="group.Subject">DOM group</span></h4></div><div class="panel-body">' +
          '<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading"><h4 class="panel-title">' +
          '<span ng-show="state.Id">#8101</span><span ng-bind="child.Subject || child.AlertKey">private-subject-canary</span>' +
          '<span ts-since="child.Ago">1m</span></h4></div></div></div></div></div>';
        doc.body.appendChild(root);
        return { root, group: root.querySelector('.panel'), child: root.querySelector('[ng-repeat]') };
      }
      const need = mount('NeedAck'), ack = mount('Acknowledged');
      function payload(rows = [row], subject = 'Snapshot group') {
        return { Groups: { NeedAck: [{ Subject: subject, Children: rows }],
          Acknowledged: [{ Subject: 'Snapshot group', Children: [ackRow] }] } };
      }
      const apply = (rows, subject) => hooks.applyAlertsPayload(payload(rows, subject), { source: 'follower' });
      const state = panel => {
        const heading = panel.querySelector(':scope > .panel-heading');
        return [!!heading.querySelector('.bosun-has-note-icon'), !!heading.querySelector('.bosun-priority-marker'),
          heading.classList.contains('bosun-priority-row')];
      };
      const pair = () => [state(need.group), state(need.child)];
      const details = {};
      apply(); details.initial = pair();
      apply(); hooks.runDomRefreshPass({ preserveExistingOnNone: true }); details.sameSnapshot = pair();
      hooks.startObserver();
      const heading = need.child.querySelector(':scope > .panel-heading');
      const replacement = heading.cloneNode(true);
      replacement.querySelectorAll('.bosun-has-note-icon, .bosun-priority-marker').forEach(node => node.remove());
      replacement.classList.remove('bosun-priority-row'); heading.replaceWith(replacement);
      await new Promise(resolve => win.setTimeout(resolve, 350)); details.replaced = pair();
      details.sectionIsolation = [state(ack.group), state(ack.child)];
      // Ordinary Acknowledged collapse/expand and full Angular panel replacement
      // must restore markers using the current snapshot and the new node identity.
      settings.priorityRules.exactAlertNames.push('synthetic.ack');
      hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
      const ackBody = ack.group.querySelector(':scope > .panel-body');
      ackBody.remove();
      await new Promise(resolve => win.setTimeout(resolve, 350));
      ack.group.appendChild(ackBody);
      await new Promise(resolve => win.setTimeout(resolve, 350));
      details.ackExpanded = [state(ack.group), state(ack.child)];
      const newChild = ack.child.cloneNode(true);
      newChild.querySelector('.bosun-priority-marker').remove();
      newChild.querySelector('.panel-heading').classList.remove('bosun-priority-row');
      ack.child.replaceWith(newChild); ack.child = newChild;
      await new Promise(resolve => win.setTimeout(resolve, 350));
      details.ackReplaced = [state(ack.group), state(ack.child)];
      const wrongChild = newChild.cloneNode(true);
      wrongChild.querySelector('[ng-show]').textContent = '#8199';
      wrongChild.querySelector('.bosun-priority-marker').remove();
      wrongChild.querySelector('.panel-heading').classList.remove('bosun-priority-row');
      newChild.replaceWith(wrongChild); ack.child = wrongChild;
      await new Promise(resolve => win.setTimeout(resolve, 350));
      details.ackUnknownReplacement = state(wrongChild);
      wrongChild.replaceWith(newChild); ack.child = newChild;
      await new Promise(resolve => win.setTimeout(resolve, 350));
      ackBody.remove();
      await new Promise(resolve => win.setTimeout(resolve, 350));
      settings.priorityRules.exactAlertNames = ['synthetic.private.alert'];
      hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
      const afterIndexChild = newChild.cloneNode(true);
      afterIndexChild.querySelector('.bosun-priority-marker').remove();
      afterIndexChild.querySelector('.panel-heading').classList.remove('bosun-priority-row');
      newChild.replaceWith(afterIndexChild); ack.child = afterIndexChild;
      ack.group.appendChild(ackBody);
      await new Promise(resolve => win.setTimeout(resolve, 350));
      details.ackAfterIndexChange = state(ack.child);
      apply([{ ...row, State: { ...row.State, Actions: [] } }]); details.noteRemoved = pair();
      apply();
      settings.priorityRules.exactAlertNames = [];
      hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
      details.priorityRemoved = pair();
      settings.priorityRules.exactAlertNames = ['synthetic.private.alert'];
      hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
      details.priorityRestored = pair();
      details.nameConflicts = [];
      for (const conflict of [
        { Alert: 'different.alert' }, { State: { ...row.State, Alert: 'different.alert' } },
        { AlertKey: 'different.alert{host=private-canary}' },
        { State: { ...row.State, AlertKey: 'different.alert{host=private-canary}' } },
        { AlertKey: 'synthetic.private.alert{malformed}' }
      ]) { apply([{ ...row, ...conflict }]); details.nameConflicts.push(pair()); }
      apply([row, { ...row }]); details.duplicateSnapshot = pair();
      apply();
      const duplicate = need.child.cloneNode(true); need.child.parentElement.appendChild(duplicate);
      hooks.applyNeedsAckMarkersFromData(); details.duplicateDomNote = hooks.resolveGroupState(need.group);
      duplicate.remove();
      const unknown = need.child.cloneNode(true); unknown.querySelector('[ng-show]').textContent = '#8199';
      need.child.parentElement.appendChild(unknown); hooks.applyNeedsAckMarkersFromData();
      details.mixedUnknown = state(need.group); unknown.remove();
      // A temporarily unmatched snapshot must fail closed, then recover on the next valid one.
      apply([{ ...row, State: { ...row.State, Id: 8199 } }]); details.unmatchedSnapshot = pair();
      apply(); details.recovered = pair();
      const id = need.child.querySelector('[ng-show]'); id.remove();
      const noId = { ...row, State: { ...row.State, Id: undefined } };
      apply([noId, { ...noId }], 'DOM group'); details.duplicateKeys = state(need.child);
      need.child.querySelector('.panel-title').prepend(id); apply();
      need.group.querySelector(':scope > .panel-heading .bosun-has-note-icon').remove();
      need.group.querySelector(':scope > .panel-heading .bosun-priority-marker').remove();
      need.group.querySelector(':scope > .panel-heading').classList.remove('bosun-priority-row');
      await new Promise(resolve => win.setTimeout(resolve, 350)); details.selectiveLossRestored = pair();
      const body = need.group.querySelector(':scope > .panel-body'); body.remove();
      await new Promise(resolve => win.setTimeout(resolve, 350)); need.group.appendChild(body);
      await new Promise(resolve => win.setTimeout(resolve, 350)); details.expanded = pair();
      details.requests = requests;
      results[mode] = details;
      frame.remove();
    }
    return results;
  })()`);
  for (const mode of ['normal']) {
    const result = indicatorLifecycle[mode], both = [[true, true, true], [true, true, true]];
    for (const key of ['initial', 'sameSnapshot', 'priorityRestored', 'recovered', 'replaced', 'selectiveLossRestored', 'expanded']) {
      assert.deepStrictEqual(result[key], both, 'Note/Priority lifecycle: ' + mode + '/' + key);
    }
    assert.deepStrictEqual(result.sectionIsolation, [[false, false, false], [false, false, false]]);
    assert.deepStrictEqual(result.ackExpanded, [[false, true, true], [false, true, true]]);
    assert.deepStrictEqual(result.ackReplaced, [[false, true, true], [false, true, true]]);
    assert.deepStrictEqual(result.ackUnknownReplacement, [false, false, false], 'A new unresolved node must not inherit stale state');
    assert.deepStrictEqual(result.ackAfterIndexChange, [false, false, false]);
    assert.deepStrictEqual(result.noteRemoved, [[false, true, true], [false, true, true]]);
    assert.deepStrictEqual(result.priorityRemoved, [[true, false, false], [true, false, false]]);
    for (const conflict of result.nameConflicts) {
      assert.deepStrictEqual(conflict, [[true, false, false], [true, false, false]], 'Structured name conflicts fail closed');
    }
    assert.deepStrictEqual(result.duplicateSnapshot, [[false, false, false], [false, false, false]]);
    assert.strictEqual(result.duplicateDomNote, 'none');
    assert.deepStrictEqual(result.mixedUnknown, [false, false, false]);
    assert.deepStrictEqual(result.unmatchedSnapshot, [[false, false, false], [false, false, false]]);
    assert.deepStrictEqual(result.duplicateKeys, [false, false, false]);
    assert.strictEqual(result.requests, 0, 'Indicator repaints must not request a new API snapshot');
  }
};
