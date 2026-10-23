'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runPriorityActionScenarios({ client, settingsSource, settingsUiSource, singleAlertAgeSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource }) {
  const collapsedGroupNoteIndicatorResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${alertsDataSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const note = { Type: 'Note', User: 'operator', Message: 'synthetic note' };

    function mountGroup(subject, children = []) {
      document.body.innerHTML = '';
      const root = document.createElement('div');
      root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
      const list = document.createElement('div');
      list.className = 'panel-group';
      const group = document.createElement('div');
      group.className = 'panel';
      const groupHeading = document.createElement('div');
      groupHeading.className = 'panel-heading';
      const groupTitle = document.createElement('div');
      groupTitle.className = 'panel-title';
      const groupSubject = document.createElement('span');
      groupSubject.setAttribute('ng-bind', 'group.Subject');
      groupSubject.textContent = subject;
      groupTitle.appendChild(groupSubject);
      groupHeading.appendChild(groupTitle);
      group.appendChild(groupHeading);

      for (const child of children) {
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('ng-repeat', 'child in group.Children');
        const heading = document.createElement('div');
        heading.className = 'panel-heading';
        heading.setAttribute('ng-click', 'toggle()');
        const title = document.createElement('div');
        title.className = 'panel-title';
        const id = document.createElement('span');
        id.setAttribute('ng-show', 'state.Id');
        id.textContent = '#' + child.id;
        const childSubject = document.createElement('span');
        childSubject.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
        childSubject.textContent = child.subject;
        const ago = document.createElement('span');
        ago.setAttribute('ts-since', 'child.Ago');
        ago.textContent = child.ago;
        title.append(id, childSubject, ago);
        heading.appendChild(title);
        panel.appendChild(heading);
        group.appendChild(panel);
      }

      list.appendChild(group);
      root.appendChild(list);
      document.body.appendChild(root);
      return group;
    }

    function child(id, subject, actions = []) {
      return { Subject: subject, Ago: '1m', State: { Id: id, Actions: actions } };
    }

    const singleCollapsed = mountGroup('single note');
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'single note',
      Children: [child(101, 'noted child', [note])]
    }] } });
    const singleCollapsedIcons = singleCollapsed.querySelectorAll(
      '.bosun-has-note-icon.bosun-parent-marker'
    ).length;

    const multiCollapsed = mountGroup('multi note');
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'multi note',
      Children: [child(201, 'plain child'), child(202, 'noted child', [note])]
    }] } });
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const multiCollapsedIcons = multiCollapsed.querySelectorAll(
      '.bosun-has-note-icon.bosun-parent-marker'
    ).length;

    const noNote = mountGroup('no note');
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'no note',
      Children: [child(301, 'plain child')]
    }] } });
    const noNoteIcons = noNote.querySelectorAll('.bosun-has-note-icon.bosun-parent-marker').length;

    const ambiguous = mountGroup('ambiguous');
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'ambiguous',
      Children: [child(401, 'first'), child(401, 'second', [note])]
    }] } });
    const ambiguousIcons = ambiguous.querySelectorAll(
      '.bosun-has-note-icon.bosun-parent-marker'
    ).length;

    const mismatch = mountGroup('mismatch', [{ id: 502, subject: 'child', ago: '1m' }]);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{
      Subject: 'mismatch',
      Children: [child(501, 'child', [note])]
    }] } });
    const mismatchIcons = mismatch.querySelectorAll('.bosun-has-note-icon').length;

    const expanded = mountGroup('expanded', [
      { id: 601, subject: 'noted child', ago: '1m' },
      { id: 602, subject: 'plain child', ago: '1m' }
    ]);
    const expandedPayload = { Groups: { NeedAck: [{
      Subject: 'expanded',
      Children: [child(601, 'noted child', [note]), child(602, 'plain child')]
    }] } };
    hooks.applyAlertsPayload(expandedPayload);
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const expandedGroupIcons = expanded.querySelectorAll(
      ':scope > .panel-heading .bosun-has-note-icon.bosun-parent-marker'
    ).length;
    const expandedChildren = expanded.querySelectorAll('[ng-repeat="child in group.Children"]');
    const notedChildIcons = expandedChildren[0].querySelectorAll(
      '.bosun-has-note-icon:not(.bosun-parent-marker)'
    ).length;
    const plainChildIcons = expandedChildren[1].querySelectorAll(
      '.bosun-has-note-icon:not(.bosun-parent-marker)'
    ).length;

    expandedChildren.forEach((panel) => panel.remove());
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const collapsedAfterExpandIcons = expanded.querySelectorAll(
      '.bosun-has-note-icon.bosun-parent-marker'
    ).length;
    expandedChildren.forEach((panel) => expanded.appendChild(panel));
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const reexpandedGroupIcons = expanded.querySelectorAll(
      ':scope > .panel-heading .bosun-has-note-icon.bosun-parent-marker'
    ).length;
    const reexpandedNotedChildIcons = expandedChildren[0].querySelectorAll(
      '.bosun-has-note-icon:not(.bosun-parent-marker)'
    ).length;
    const reexpandedPlainChildIcons = expandedChildren[1].querySelectorAll(
      '.bosun-has-note-icon:not(.bosun-parent-marker)'
    ).length;

    return {
      singleCollapsedIcons,
      multiCollapsedIcons,
      noNoteIcons,
      ambiguousIcons,
      mismatchIcons,
      expandedGroupIcons,
      notedChildIcons,
      plainChildIcons,
      collapsedAfterExpandIcons,
      reexpandedGroupIcons,
      reexpandedNotedChildIcons,
      reexpandedPlainChildIcons
    };
  })()`);
  assert.deepStrictEqual(collapsedGroupNoteIndicatorResult, {
    singleCollapsedIcons: 1,
    multiCollapsedIcons: 1,
    noNoteIcons: 0,
    ambiguousIcons: 0,
    mismatchIcons: 0,
    expandedGroupIcons: 1,
    notedChildIcons: 1,
    plainChildIcons: 0,
    collapsedAfterExpandIcons: 1,
    reexpandedGroupIcons: 1,
    reexpandedNotedChildIcons: 1,
    reexpandedPlainChildIcons: 0
  }, 'Collapsed group Note indicator did not preserve safe child identity semantics');

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 600, height: 800, deviceScaleFactor: 1, mobile: false
  });
  const priorityRowActions = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise((resolve) => { frame.onload = resolve; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    const data = { bosunSettingsSchemaVersion: 1,
      'bosunSettingsV1:features.priorityAlerts': true,
      'bosunSettingsV1:preferences.priorityCritical': false,
      'bosunSettingsV1:priorityRules.exactAlertNames': ['keep.first', 'Case.Name', 'keep.last'] };
    const listeners = new Set(); let failWrite = false, requests = 0;
    const storage = {
      get(keys, callback) {
        const result = {}; for (const key of keys === null ? Object.keys(data) : keys) {
          if (key in data) result[key] = data[key];
        } callback(result);
      },
      set(values, callback) {
        if (failWrite) {
          win.chrome.runtime.lastError = { message: 'synthetic write failure' };
          callback(); win.chrome.runtime.lastError = null; return;
        }
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: value }; data[key] = value;
        }
        callback(); for (const listener of listeners) listener(changes, 'local');
      },
      remove(keys, callback) { for (const key of keys) delete data[key]; callback(); }
    };
    win.chrome = { runtime: { lastError: null }, storage: { local: storage,
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } } };
    win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    win.fetch = () => { requests += 1; throw new Error('Row actions must not fetch'); };
    win.BosunHelperRefreshCoordinator = { createRefreshCoordinator() {
      return { start() {}, stop() {}, requestRefresh() {} };
    } };
    win.eval(${JSON.stringify(settingsSource)}); win.eval(${JSON.stringify(settingsUiSource)});
    win.eval(${JSON.stringify(alertsDataSource)}); win.eval(${JSON.stringify(needAckSeveritySource)});
    win.eval(${JSON.stringify(prioritySource)}); win.eval(${JSON.stringify(singleAlertAgeSource)});
    win.eval(${JSON.stringify(stylesSource)}); win.eval(${JSON.stringify(contentSource)});
    const hooks = win.__BosunHelperBrowserTest;
    const store = await hooks.startPriorityActionSettings(); hooks.injectStyles();
    const toolbar = doc.createElement('div'); toolbar.id = 'row-test-toolbar'; doc.body.appendChild(toolbar);
    const ui = win.BosunHelperSettingsUi.createSettingsUi({ settingsStore: store,
      schema: win.BosunHelperSettings.SCHEMA, toolbarId: toolbar.id }); ui.mount(toolbar); ui.open();
    const settle = () => new Promise((resolve) => win.setTimeout(resolve, 350));
    const childData = (id, name = 'example.alert', severity = 'warning') => ({ Alert: name,
      AlertKey: name + '{host=demo,env=test}', Subject: name + '{host=demo,env=test}',
      Ago: new Date(Date.now() - 60000).toISOString(), State: { Id: id, CurrentStatus: severity } });
    const records = [childData(8101), childData(8102), childData(8103, 'other.alert'),
      childData(8104, 'case.name'), childData(8105, 'auto.critical', 'critical'),childData(8106)];
    const ackRecord = childData(8101, 'ack.example');
    for(const [row,key] of [[records[0],'example.alert{cluster=two words,disk-name=/,host=node-one}'],
      [records[1],'example.alert{cloud.zone=synthetic,cluster=two  words,host=node-two}'],
      [records[5],'example.alert{cluster=three words,host=node-three,rack/slot=synthetic}'],
      [ackRecord,'ack.example{cluster=ack words,host=node-ack,rack/slot=synthetic}']]) {
      row.AlertKey=key;row.State.AlertKey=key;row.State.Alert=row.Alert;
    }
    records[0].State.Actions=[{Type:'Note'}];
    let payload = { Groups: { NeedAck: records.map((row, i) => ({ Subject: 'group ' + i, Children: [row] })),
      Acknowledged: [{ Subject: 'ack group', Children: [ackRecord] }] } };
    function root(section) {
      const node = doc.createElement('div'); node.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
      node.innerHTML = '<div class="panel-group"></div>'; doc.body.appendChild(node); return node;
    }
    const needRoot = root('NeedAck'), ackRoot = root('Acknowledged');
    let nativeClicks = 0;
    function mount(root, subject, rows) {
      const group = doc.createElement('div'); group.className = 'panel';
      group.innerHTML = '<div class="panel-heading"><h4 class="panel-title"><span ng-bind="group.Subject"></span>' +
        '<span class="pull-right ng-binding">' + rows.length + ' alerts</span><input type="checkbox"></h4></div>' +
        '<div class="panel-body panel-group"></div>';
      group.querySelector('[ng-bind]').textContent = subject;
      group.querySelector('.panel-heading').addEventListener('click', () => nativeClicks++);
      for (const row of rows) {
        const child = doc.createElement('div'); child.className = 'panel'; child.setAttribute('ng-repeat', 'child in group.Children');
        child.innerHTML = '<div class="panel-heading"><h4 class="panel-title"><span ng-show="state.Id">#' + row.State.Id +
          '</span><span ng-bind="child.Subject || child.AlertKey"></span><span ts-since="child.Ago">1m-ago</span>' +
          '<input type="checkbox"></h4></div>';
        child.querySelector('[ng-bind]').textContent = row.Subject;
        child.querySelector('.panel-heading').addEventListener('click', () => nativeClicks++);
        group.querySelector('.panel-body').appendChild(child);
      }
      root.querySelector('.panel-group').appendChild(group); return group;
    }
    const groups = records.map((row, i) => mount(needRoot, 'group ' + i, [row]));
    const ack = mount(ackRoot, 'ack group', [ackRecord]);
    const child = groups[0].querySelector('[ng-repeat]');
    const button = (panel) => panel.querySelector(':scope > .panel-heading .bosun-priority-action');
    const flag = (panel) => !!panel.querySelector(':scope > .panel-heading .bosun-priority-marker');
    const rules = () => store.getSnapshot().priorityRules.exactAlertNames;
    const details = {};
    hooks.applyAlertsPayload(payload, { source: 'follower' }); hooks.startObserver(); await settle();
    details.addLabel = button(child)?.getAttribute('aria-label');
    details.singleGroup = !button(groups[0]);
    details.addText = button(child)?.textContent;
    details.allInstanceButtons=[groups[0],groups[1],groups[5]].every(group=>!!button(group.querySelector('[ng-repeat]')));
    const copyButton = child.querySelector('.bosun-copy-alert-btn');
    const copied = [];
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true,
      value: { writeText: async (text) => { copied.push(text); } } });
    details.placement = button(child)?.previousElementSibling === copyButton;
    copyButton.click(); await Promise.resolve();
    details.copyWorks = copied[0] === records[0].Subject;
    hooks.installSelectionCopySanitizer();
    const selection=win.getSelection(),range=doc.createRange();
    const selectionHeading=child.querySelector(':scope > .panel-heading');
    const excludedLabel=button(child).textContent;
    range.selectNodeContents(selectionHeading);selection.removeAllRanges();selection.addRange(range);
    details.selectionCss=win.getComputedStyle(button(child)).userSelect;
    details.pointerInteractive=win.getComputedStyle(button(child)).pointerEvents!=='none'&&!button(child).disabled;
    details.selectedSubject=selection.toString().includes(records[0].Subject);
    details.selectedPriority=selection.toString().includes(excludedLabel);
    const clipboardData=new win.DataTransfer();
    doc.dispatchEvent(new win.ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData}));
    details.copiedSubject=clipboardData.getData('text/plain').includes(records[0].Subject);
    details.copiedPriority=clipboardData.getData('text/plain').includes(excludedLabel);
    const controlOnly=doc.createElement('span');controlOnly.textContent='synthetic-priority-control-only';button(child).append(controlOnly);
    range.selectNodeContents(needRoot);selection.removeAllRanges();selection.addRange(range);
    const bulkClipboard=new win.DataTransfer();
    const bulkCopyEvent=new win.ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:bulkClipboard});
    doc.dispatchEvent(bulkCopyEvent);details.copySanitized=bulkCopyEvent.defaultPrevented&&bulkClipboard.types.length===1&&bulkClipboard.types[0]==='text/plain';
    const normalizeSpaces=text=>text.replace(/\\s+/g,' ').trim();
    details.bulkSelection=records.every(row=>normalizeSpaces(selection.toString()).includes(normalizeSpaces(row.Subject)));
    details.bulkCopy=records.every(row=>normalizeSpaces(bulkClipboard.getData('text/plain')).includes(normalizeSpaces(row.Subject)));
    details.bulkExcluded=[selection.toString(),bulkClipboard.getData('text/plain')].every(text=>
      !text.includes(excludedLabel)&&!text.includes(controlOnly.textContent)&&!text.includes('⚑'));
    controlOnly.remove();
    selection.removeAllRanges();
    button(child).focus();details.keyboardFocusable=doc.activeElement===button(child)&&button(child).tabIndex===0;
    // A repaint also removes a leftover button from the previous group UI.
    const obsolete = doc.createElement('button'); obsolete.className = 'bosun-priority-action';
    groups[0].querySelector('.panel-title').appendChild(obsolete);
    hooks.ensurePriorityActions(); details.parentCleanup = !button(groups[0]);
    button(child).click(); await settle();
    details.addRules = rules(); details.addFlag = flag(child) && flag(groups[0]);
    details.instanceFlags=[groups[0],groups[1],groups[5],groups[2]].map(group=>flag(group)&&flag(group.querySelector('[ng-repeat]')));
    details.removeLabel = button(child)?.getAttribute('aria-label');
    details.removeText = button(child)?.textContent;
    details.groupAccent = groups[0].querySelector('.panel-heading').classList.contains('bosun-priority-row') && !button(groups[0]);
    details.settingsValue = doc.querySelector('[data-setting-path="priorityRules.exactAlertNames"]').value;
    details.keyRejections=[];
    for(const change of [
      row=>{row.State.AlertKey='example.alert{disk-name=/,host=different-instance}';},
      row=>{row.State.AlertKey='example.alert{broken}';},
      row=>{row.AlertKey='example.alert{host=one,host=two}';}
    ]){
      const invalid=JSON.parse(JSON.stringify(payload));change(invalid.Groups.NeedAck[0].Children[0]);
      hooks.applyAlertsPayload(invalid,{source:'follower'});await settle();
      details.keyRejections.push(!button(child)&&!flag(child)&&!flag(groups[0])&&
        !!child.querySelector('.bosun-has-note-icon')&&flag(groups[1]));
    }
    hooks.applyAlertsPayload(payload,{source:'follower'});await settle();
    const reopenedStore = win.BosunHelperSettings.createSettingsStore({ storage, storageChanges: win.chrome.storage.onChanged });
    await reopenedStore.start(); details.persistedRules = reopenedStore.getSnapshot().priorityRules.exactAlertNames;
    reopenedStore.destroy();
    button(child).click(); await settle(); details.removeRules = rules(); details.removedFlag = !flag(child) && !flag(groups[0]);
    details.removedInstanceFlags=[groups[0],groups[1],groups[5]].every(group=>!flag(group)&&!flag(group.querySelector('[ng-repeat]')));
    for (let i = 0; i < 3; i++) hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    details.duplicates = child.querySelectorAll('.bosun-priority-action').length;
    details.nativeClicks = nativeClicks;
    const checkbox = child.querySelector('input'); checkbox.click(); details.checkbox = checkbox.checked;
    const oldId = child.querySelector('[ng-show]'); oldId.textContent = '#8999'; await settle();
    details.strongMismatch = !button(child) && !button(groups[0]);
    oldId.textContent = '#8101'; await settle();
    const subjectNode = child.querySelector('[ng-bind]');
    subjectNode.textContent = 'other.alert{host=demo,env=test}'; await settle();
    details.subjectConflict = !button(child) && !button(groups[0]);
    subjectNode.textContent = records[0].Subject; await settle();
    const duplicatePayload = JSON.parse(JSON.stringify(payload));
    duplicatePayload.Groups.NeedAck[0].Children.push(records[0]);
    hooks.applyAlertsPayload(duplicatePayload, { source: 'follower' }); await settle();
    details.snapshotAmbiguous = !button(child) && !button(groups[0]);
    const conflictPayload = JSON.parse(JSON.stringify(payload));
    conflictPayload.Groups.NeedAck[0].Children[0].Alert = 'conflicting.name';
    hooks.applyAlertsPayload(conflictPayload, { source: 'follower' }); await settle();
    details.nameConflict = !button(child) && !button(groups[0]);
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle();
    const originalHeading = child.querySelector(':scope > .panel-heading');
    const freshHeading = originalHeading.cloneNode(true); freshHeading.querySelectorAll('.bosun-priority-action').forEach((node) => node.remove());
    originalHeading.replaceWith(freshHeading); await settle(); details.repaint = !!button(child);
    // Even a stale detached button cannot mutate the rules for a changed row identity.
    const staleButton = button(child); child.querySelector('[ng-show]').textContent = '#8999';
    staleButton.click(); await settle(); details.staleRules = rules();
    child.querySelector('[ng-show]').textContent = '#8101'; await settle();
    const duplicate = child.cloneNode(true); groups[0].querySelector('.panel-body').appendChild(duplicate); await settle();
    details.duplicateIdentity = !button(child) && !button(duplicate) && !button(groups[0]); duplicate.remove(); await settle();
    // All rendered children must safely resolve to one name; no first-child selection.
    const same = mount(needRoot, 'same group', [records[0], records[1]]);
    groups[0].remove(); groups[1].remove();
    payload.Groups.NeedAck = [{ Subject: 'same group', Children: [records[0], records[1]] }, ...payload.Groups.NeedAck.slice(2)];
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle(); details.sameNameGroup = !button(same) && Array.from(same.querySelectorAll('[ng-repeat]')).every(panel => !!button(panel));
    const body = same.querySelector('.panel-body'); body.remove(); await settle(); details.collapsed = !button(same) && same.querySelectorAll('.bosun-priority-action').length === 0;
    same.appendChild(body); await settle(); details.expanded = !button(same) && body.querySelectorAll('.bosun-priority-action').length === 2;
    const mixed = mount(needRoot, 'mixed group', [records[0], records[2]]); same.remove(); groups[2].remove();
    payload.Groups.NeedAck = [{ Subject: 'mixed group', Children: [records[0], records[2]] }, ...payload.Groups.NeedAck.slice(2)];
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle(); details.mixedNames = !button(mixed);
    mixed.querySelector('[ng-show]').textContent = '#8999'; await settle(); details.unresolvedGroup = !button(mixed);
    const ackBody = ack.querySelector('.panel-body');
    ackBody.remove(); hooks.ensurePriorityActions(); details.ackCollapsed = !button(ack);
    ack.appendChild(ackBody); hooks.ensurePriorityActions();
    details.ackHiddenPresentation = !button(ack) && !!button(ack.querySelector('[ng-repeat]')) && !flag(ack);
    button(ack.querySelector('[ng-repeat]')).click(); await settle(); details.ackRules = rules();
    details.ackStillHidden = flag(ack) && flag(ack.querySelector('[ng-repeat]'));
    details.caseSensitive = button(groups[3].querySelector('[ng-repeat]'))?.title === 'Добавить алерт в приоритетные';
    await new Promise(resolve=>storage.set({ 'bosunSettingsV1:preferences.priorityCritical': true },resolve)); await settle();
    details.criticalSeparate = !flag(groups[4]) && button(groups[4].querySelector('[ng-repeat]'))?.title === 'Добавить алерт в приоритетные';
    const ruleActionToggle = doc.querySelector('[data-setting-path="preferences.priorityRuleAction"]');
    const exactEditor = doc.querySelector('[data-setting-path="priorityRules.exactAlertNames"]');
    const noteEditor = doc.querySelector('[data-setting-path="actionTemplates.note"]');
    const visualState = () => Array.from(doc.querySelectorAll('.panel-heading')).map(heading => [
      heading.classList.contains('bosun-priority-row'), heading.querySelectorAll('.bosun-priority-marker').length]);
    const beforeToggle = visualState(), beforeRules = JSON.stringify(rules());
    const oldButton = button(ack.querySelector('[ng-repeat]'));
    const beforeNote = noteEditor.value;
    exactEditor.value = 'unsaved exact draft'; noteEditor.value = 'unsaved note draft';
    details.toggleDefault = ruleActionToggle.checked;
    ruleActionToggle.click(); await settle();
    hooks.runDomRefreshPass({ preserveExistingOnNone: true }); ui.mount(toolbar);
    details.toggleOff = doc.querySelectorAll('.bosun-priority-action').length === 0 && !ruleActionToggle.checked;
    oldButton.click(); await settle();
    details.toggleRulesUnchanged = JSON.stringify(rules()) === beforeRules;
    details.togglePresentationUnchanged = JSON.stringify(visualState()) === JSON.stringify(beforeToggle);
    const restored = win.BosunHelperSettings.createSettingsStore({ storage, storageChanges: win.chrome.storage.onChanged });
    await restored.start(); details.togglePersisted = restored.get('preferences.priorityRuleAction') === false;
    restored.destroy();
    ruleActionToggle.click(); await settle();
    hooks.runDomRefreshPass({ preserveExistingOnNone: true }); ui.mount(toolbar);
    details.toggleOn = !!button(ack.querySelector('[ng-repeat]')) &&
      groups[4].querySelectorAll('[ng-repeat] .bosun-priority-action').length === 1 &&
      !button(ack) && groups.every(group => !button(group));
    details.toggleDrafts = exactEditor.value === 'unsaved exact draft' && noteEditor.value === 'unsaved note draft';
    exactEditor.value = rules().join('\\n'); noteEditor.value = beforeNote;
    failWrite = true; button(groups[3].querySelector('[ng-repeat]')).click(); await settle();
    details.failedRules = rules(); details.failedButtonEnabled = !button(groups[3].querySelector('[ng-repeat]')).disabled;
    failWrite = false;
    // AlertKey-only structured identity: rule editing must not depend on Alert.
    const fallbackRow = childData(9101, 'fallback.example'); delete fallbackRow.Alert;
    const fallbackGroup = mount(needRoot, 'fallback group', [fallbackRow]);
    payload.Groups.NeedAck.push({ Subject: 'fallback group', Children: [fallbackRow] });
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle();
    details.alertKeyOnlyAction = !!button(fallbackGroup.querySelector('[ng-repeat]'));
    button(fallbackGroup.querySelector('[ng-repeat]')).click(); await settle();
    details.alertKeyOnlyRules = rules();
    details.alertKeyOnlyPriority = flag(fallbackGroup) && flag(fallbackGroup.querySelector('[ng-repeat]'));
    button(fallbackGroup.querySelector('[ng-repeat]')).click(); await settle();
    const collapsedChecks = {};
    const cases = [
      ['single', [childData(9201)]],
      ['multi', [childData(9202), childData(9203)]],
      ['mixed', [childData(9204), childData(9205, 'other.example')]],
      ['missingId', [childData(null)]],
      ['duplicate', [childData(9206), childData(9206)]],
      ['invalidKey', [{ ...childData(9207), AlertKey: 'example.alert{broken}' }]],
      ['subjectOnly', [{ Subject: 'example.alert{host=demo}', State: { Id: 9208 } }]],
      ['stateAlert', [{ ...childData(9209), Alert: undefined, State: { Id: 9209, Alert: 'example.alert' } }]]
    ];
    for (const [kind, rows] of cases) {
      const subject = 'collapsed ' + kind;
      const panel = mount(needRoot, subject, rows), body = panel.querySelector('.panel-body'); body.remove();
      payload.Groups.NeedAck.push({ Subject: subject, Children: rows });
      hooks.applyAlertsPayload(payload, { source: 'follower' }); hooks.ensurePriorityActions();
      collapsedChecks[kind] = !!button(panel);
      panel.appendChild(body); hooks.ensurePriorityActions();
      collapsedChecks[kind + 'Expanded'] = !!button(panel);
      collapsedChecks[kind + 'Children'] = Array.from(body.querySelectorAll('[ng-repeat]')).map(child => !!button(child));
      body.remove(); hooks.ensurePriorityActions();
      collapsedChecks[kind + 'Recollapsed'] = !!button(panel);
    }
    const duplicateSubjectRows = [childData(9210)];
    const duplicateSubject = mount(needRoot, 'collapsed duplicate subject', duplicateSubjectRows);
    duplicateSubject.querySelector('.panel-body').remove();
    payload.Groups.NeedAck.push({ Subject: 'collapsed duplicate subject', Children: duplicateSubjectRows },
      { Subject: 'collapsed duplicate subject', Children: [childData(9211)] });
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle();
    collapsedChecks.duplicateSubject = !!button(duplicateSubject);
    // Identical group Subject across sections must still select its own snapshot.
    const needSection = mount(needRoot, 'shared section subject', [childData(9212, 'section.need')]);
    const ackSection = mount(ackRoot, 'shared section subject', [childData(9212, 'section.ack')]);
    // Same Subject and ID across sections must not mix child rule names.
    payload.Groups.NeedAck.push({ Subject: 'shared section subject', Children: [childData(9212, 'section.need')] });
    payload.Groups.Acknowledged.push({ Subject: 'shared section subject', Children: [childData(9212, 'section.ack')] });
    hooks.applyAlertsPayload(payload, { source: 'follower' }); await settle();
    collapsedChecks.sectionNames = [button(needSection.querySelector('[ng-repeat]'))?.dataset.alertName, button(ackSection.querySelector('[ng-repeat]'))?.dataset.alertName];
    button(ackSection.querySelector('[ng-repeat]')).click(); await settle(); collapsedChecks.sectionRules = rules();
    details.collapsedChecks = collapsedChecks;
    details.noRequests = requests;
    const widthWithActions = doc.documentElement.scrollWidth;
    doc.querySelectorAll('.bosun-priority-action').forEach((node) => { node.style.display = 'none'; });
    details.narrow = widthWithActions <= Math.max(doc.documentElement.clientWidth, doc.documentElement.scrollWidth);
    ui.destroy(); store.destroy(); frame.remove();
    return details;
  })()`);
  const initialRowRules = ['keep.first', 'Case.Name', 'keep.last'];
  assert.strictEqual(priorityRowActions.addLabel, 'Добавить алерт в приоритетные');
  assert.strictEqual(priorityRowActions.removeLabel, 'Убрать алерт из приоритетных');
  assert.strictEqual(priorityRowActions.addText, '⚑ В приоритетные');
  assert.strictEqual(priorityRowActions.removeText, '⚑ Убрать из приоритетных');
  assert.strictEqual(priorityRowActions.parentCleanup, true);
  assert.strictEqual(priorityRowActions.groupAccent, true);
  assert.strictEqual(priorityRowActions.placement, true);
  assert.strictEqual(priorityRowActions.copyWorks, true);
  assert.strictEqual(priorityRowActions.selectionCss,'none');
  assert.strictEqual(priorityRowActions.selectedSubject,true);
  assert.strictEqual(priorityRowActions.selectedPriority,false);
  assert.strictEqual(priorityRowActions.copiedSubject,true);
  assert.strictEqual(priorityRowActions.copiedPriority,false);
  assert.strictEqual(priorityRowActions.keyboardFocusable,true);
  assert.strictEqual(priorityRowActions.pointerInteractive,true);
  assert.strictEqual(priorityRowActions.copySanitized,true);
  assert.strictEqual(priorityRowActions.bulkSelection,true);
  assert.strictEqual(priorityRowActions.bulkCopy,true);
  assert.strictEqual(priorityRowActions.bulkExcluded,true);
  assert.strictEqual(priorityRowActions.ackCollapsed, true);
  for (const field of ['toggleDefault', 'toggleOff', 'toggleOn', 'togglePersisted',
    'toggleRulesUnchanged', 'togglePresentationUnchanged', 'toggleDrafts']) {
    assert.strictEqual(priorityRowActions[field], true, 'Priority rule-action setting: ' + field);
  }
  assert.deepStrictEqual(priorityRowActions.addRules, [...initialRowRules, 'example.alert']);
  assert.strictEqual(priorityRowActions.allInstanceButtons,true,'All three spaced-value instances have a safely resolved child action');
  assert.deepStrictEqual(priorityRowActions.instanceFlags,[true,true,true,false], 'One exact rule covers distinct spaced-value instances without affecting other names');
  assert.strictEqual(priorityRowActions.removedInstanceFlags,true);
  assert.deepStrictEqual(priorityRowActions.keyRejections,[true,true,true], 'Conflicting/malformed keys suppress marker and action while Note and other instances remain intact');
  assert.deepStrictEqual(priorityRowActions.persistedRules, priorityRowActions.addRules);
  assert.strictEqual(priorityRowActions.settingsValue, priorityRowActions.addRules.join('\n'));
  assert.deepStrictEqual(priorityRowActions.removeRules, initialRowRules);
  assert.deepStrictEqual(priorityRowActions.staleRules, initialRowRules);
  assert.deepStrictEqual(priorityRowActions.ackRules, [...initialRowRules, 'ack.example']);
  assert.deepStrictEqual(priorityRowActions.failedRules, priorityRowActions.ackRules);
  assert.strictEqual(priorityRowActions.alertKeyOnlyAction, true);
  assert.deepStrictEqual(priorityRowActions.alertKeyOnlyRules, [...priorityRowActions.ackRules, 'fallback.example']);
  assert.deepStrictEqual(priorityRowActions.collapsedChecks, {
    single: false, singleExpanded: false, singleRecollapsed: false, singleChildren: [true],
    multi: false, multiExpanded: false, multiRecollapsed: false, multiChildren: [true, true],
    mixed: false, mixedExpanded: false, mixedRecollapsed: false, mixedChildren: [true, true],
    missingId: false, missingIdExpanded: false, missingIdRecollapsed: false, missingIdChildren: [false],
    duplicate: false, duplicateExpanded: false, duplicateRecollapsed: false, duplicateChildren: [false, false],
    invalidKey: false, invalidKeyExpanded: false, invalidKeyRecollapsed: false, invalidKeyChildren: [false],
    subjectOnly: false, subjectOnlyExpanded: false, subjectOnlyRecollapsed: false, subjectOnlyChildren: [false],
    stateAlert: false, stateAlertExpanded: false, stateAlertRecollapsed: false, stateAlertChildren: [true],
    duplicateSubject: false, sectionNames: ['section.need', 'section.ack'],
    sectionRules: [...priorityRowActions.ackRules, 'section.ack']
  });
  for (const key of ['singleGroup', 'addFlag', 'removedFlag', 'checkbox', 'strongMismatch', 'repaint',
    'subjectConflict', 'snapshotAmbiguous', 'nameConflict',
    'duplicateIdentity', 'sameNameGroup', 'collapsed', 'expanded', 'mixedNames', 'unresolvedGroup',
    'ackHiddenPresentation', 'ackStillHidden', 'caseSensitive', 'criticalSeparate', 'failedButtonEnabled', 'narrow']) {
    assert.strictEqual(priorityRowActions[key], true, 'Priority row action: ' + key);
  }
  assert.strictEqual(priorityRowActions.duplicates, 1);
  assert.strictEqual(priorityRowActions.nativeClicks, 0);
  assert.strictEqual(priorityRowActions.noRequests, 0);

  return { priorityRowActions };
};
