'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runPriorityRenderingScenarios({ client, settingsSource, alertsDataSource, needAckSeveritySource, prioritySource, stylesSource, contentSource }) {
  const priorityMarkers = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'], grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${settingsSource}
    ${alertsDataSource}
    ${needAckSeveritySource}
    ${prioritySource}
    ${stylesSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.injectStyles();
    const snapshot = JSON.parse(JSON.stringify(BosunHelperSettings.DEFAULTS));
    snapshot.features.priorityAlerts = true;
    snapshot.priorityRules.exactAlertNames = ['critical.alert'];
    const change = (path, value) => {
      const before = JSON.parse(JSON.stringify(snapshot));
      const [section, name] = path.split('.');
      snapshot[section][name] = value;
      hooks.applySettingsSnapshot(JSON.parse(JSON.stringify(snapshot)), { previous: before, changedPaths: [path] });
    };
    hooks.applySettingsSnapshot(snapshot, { initial: true });
    function child(id, alert, status, note = false) {
      return { Alert: alert, Subject: alert, Ago: '1m', State: {
        Id: id, CurrentStatus: status,
        Actions: note ? [{ Type: 'Note', User: 'operator', Message: 'synthetic' }] : []
      } };
    }
    function mount(subject, rows = [], acknowledged = false, preserve = false) {
      if (!preserve) document.body.innerHTML = '';
      const root = document.createElement('div');
      root.setAttribute('ts-ack-group', acknowledged ? 'schedule.Groups.Acknowledged' : 'schedule.Groups.NeedAck');
      const list = document.createElement('div'); list.className = 'panel-group';
      const group = document.createElement('div'); group.className = 'panel';
      const heading = document.createElement('div'); heading.className = 'panel-heading';
      heading.style.backgroundColor = 'rgb(255, 220, 220)';
      const title = document.createElement('div'); title.className = 'panel-title';
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'group.Subject'); subjectNode.textContent = subject;
      title.appendChild(subjectNode); heading.appendChild(title); group.appendChild(heading);
      const children = rows.map((row) => {
        const panel = document.createElement('div'); panel.className = 'panel';
        panel.setAttribute('ng-repeat', 'child in group.Children');
        const h = document.createElement('div'); h.className = 'panel-heading'; h.setAttribute('ng-click', 'toggle()');
        h.style.backgroundColor = row.State.CurrentStatus === 'critical'
          ? 'rgb(255, 220, 220)' : 'rgb(255, 245, 210)';
        const t = document.createElement('div'); t.className = 'panel-title';
        const id = document.createElement('span'); id.setAttribute('ng-show', 'state.Id'); id.textContent = '#' + row.State.Id;
        const name = document.createElement('span'); name.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
        name.textContent = row.Subject;
        const ago = document.createElement('span'); ago.setAttribute('ts-since', 'child.Ago'); ago.textContent = row.Ago;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        t.append(id, name, ago, checkbox); h.appendChild(t); panel.appendChild(h); return panel;
      });
      list.appendChild(group); root.appendChild(list); document.body.appendChild(root);
      return { group, children, expand() { children.forEach((panel) => group.appendChild(panel)); },
        collapse() { children.forEach((panel) => panel.remove()); } };
    }
    const count = (element, parent = false) => {
      const markers = element.querySelectorAll(
        parent ? ':scope > .panel-heading .bosun-priority-marker.bosun-parent-marker'
          : ':scope > .panel-heading .bosun-priority-marker:not(.bosun-parent-marker)'
      );
      const heading = element.querySelector(':scope > .panel-heading');
      if (heading.classList.contains('bosun-priority-row') !== (markers.length > 0)) {
        throw new Error('Priority accent must follow marker on every repaint/toggle');
      }
      if (Array.from(markers).some((marker) => marker.textContent !== '⚑')) {
        throw new Error('Priority marker must use a flag');
      }
      return markers.length;
    };
    const critical = child(101, 'critical.alert', 'critical', true);
    const warning = child(102, 'warning.alert', 'warning');
    const mounted = mount('priority group', [critical, warning]);
    const payload = { Groups: { NeedAck: [{ Subject: 'priority group', Children: [critical, warning] }] } };
    hooks.applyAlertsPayload(payload);
    const collapsed = count(mounted.group, true);
    mounted.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const childCounts = mounted.children.map((panel) => count(panel));
    const noteCoexist = mounted.children[0].querySelectorAll('.bosun-has-note-icon').length;
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    mounted.collapse(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    mounted.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const repeated = [count(mounted.group, true), ...mounted.children.map((panel) => count(panel))];
    const marker = mounted.children[0].querySelector('.bosun-priority-marker');
    const label = [marker?.title, marker?.getAttribute('aria-label')];
    const narrowStyle = [Math.ceil(marker.getBoundingClientRect().width) <= 24,
      getComputedStyle(marker).pointerEvents === 'none'];
    const markerStyle = getComputedStyle(marker);
    const flagPresentation = [markerStyle.borderWidth, markerStyle.backgroundColor,
      markerStyle.padding, markerStyle.fontSize, markerStyle.fontWeight, markerStyle.lineHeight];
    const priorityHeading = mounted.children[0].querySelector('.panel-heading');
    const checkbox = mounted.children[0].querySelector('input');
    const geometry = () => [priorityHeading.getBoundingClientRect().height,
      checkbox.getBoundingClientRect().left, checkbox.getBoundingClientRect().top];
    const flagGeometry = geometry();
    marker.textContent = '★';
    const starGeometry = geometry();
    marker.textContent = '⚑';
    const flagLayoutStable = flagGeometry.every((value, index) => Math.abs(value - starGeometry[index]) <= 2);
    const overlay = getComputedStyle(priorityHeading, '::after');
    const visualStyle = {
      background: getComputedStyle(priorityHeading).backgroundColor,
      tint: overlay.backgroundColor, outline: overlay.boxShadow, pointerEvents: overlay.pointerEvents,
      noOverflow: priorityHeading.scrollWidth <= priorityHeading.clientWidth,
      groupTint: getComputedStyle(mounted.group.querySelector(':scope > .panel-heading'), '::after').backgroundColor
    };
    let rowClicks = 0;
    priorityHeading.addEventListener('click', () => { rowClicks += 1; });
    let clicks = 0; mounted.children[0].querySelector('input').addEventListener('click', () => { clicks += 1; });
    mounted.children[0].querySelector('input').click();
    priorityHeading.click();
    const nativeClickState = [rowClicks, checkbox.checked];
    change('features.priorityAlerts', false);
    const disabled = [count(mounted.group, true), ...mounted.children.map((panel) => count(panel))];
    const disabledStyle = [getComputedStyle(priorityHeading).backgroundColor,
      getComputedStyle(priorityHeading, '::after').content];
    change('features.priorityAlerts', true);
    const reenabled = [count(mounted.group, true), ...mounted.children.map((panel) => count(panel))];
    change('preferences.priorityCritical', false);
    const criticalOff = [count(mounted.group, true), count(mounted.children[0])];
    change('priorityRules.exactAlertNames', ['warning.alert']);
    const exactOn = [count(mounted.group, true), ...mounted.children.map((panel) => count(panel))];
    const warningHeading = mounted.children[1].querySelector('.panel-heading');
    const warningStyle = [getComputedStyle(warningHeading).backgroundColor,
      getComputedStyle(warningHeading, '::after').backgroundColor];
    change('priorityRules.exactAlertNames', []);
    const exactOff = [count(mounted.group, true), ...mounted.children.map((panel) => count(panel))];
    change('preferences.priorityCritical', true);
    change('priorityRules.exactAlertNames', ['critical.alert']);
    const remounted = mount('priority group', [critical, warning]);
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    remounted.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const domReplacement = [count(remounted.group, true), ...remounted.children.map((panel) => count(panel))];
    const replacement = mount('replacement', [child(201, 'other.alert', 'warning')]);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{ Subject: 'replacement', Children: [child(201, 'other.alert', 'warning')] }] } });
    replacement.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const replaced = [count(replacement.group, true), count(replacement.children[0])];
    change('priorityRules.exactAlertNames', ['first.alert','second.alert','same.alert']);
    const ambiguous = mount('ambiguous', [child(301, 'first.alert', 'critical')]);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{ Subject: 'ambiguous', Children: [
      child(301, 'first.alert', 'critical'), child(301, 'second.alert', 'critical')
    ] }] } });
    ambiguous.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ambiguousCounts = [count(ambiguous.group, true), count(ambiguous.children[0])];
    const mismatch = mount('mismatch', [child(402, 'same.alert', 'critical')]);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{ Subject: 'mismatch', Children: [child(401, 'same.alert', 'critical')] }] } });
    mismatch.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const mismatchCounts = [count(mismatch.group, true), count(mismatch.children[0])];
    const acknowledged = mount('acknowledged', [child(501, 'ack.alert', 'critical')], true);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{ Subject: 'acknowledged', Children: [child(501, 'ack.alert', 'critical')] }] } });
    acknowledged.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const acknowledgedCounts = [count(acknowledged.group, true), count(acknowledged.children[0])];
    const needLiveChild = child(601, 'need.live', 'critical');
    const ackLiveCritical = child(601, 'ack.critical', 'critical', true);
    const ackLiveWarning = child(602, 'ack.warning', 'warning');
    const needLive = mount('need live', [needLiveChild]);
    const ackLive = mount('ack live', [ackLiveCritical, ackLiveWarning], true, true);
    const dualPayload = { Groups: {
      NeedAck: [{ Subject: 'need live', Children: [needLiveChild] }],
      Acknowledged: [{ Subject: 'ack live', Children: [ackLiveCritical, ackLiveWarning] }]
    } };
    change('priorityRules.exactAlertNames', ['need.live','ack.critical']);
    hooks.applyAlertsPayload(dualPayload);
    const ackDefaultOff = [count(needLive.group, true), count(ackLive.group, true)];
    change('preferences.priorityShowAcknowledged', true);
    const ackEnabledCollapsed = [count(needLive.group, true), count(ackLive.group, true)];
    ackLive.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackExpanded = [count(ackLive.group, true), ...ackLive.children.map((panel) => count(panel))];
    const ackTint = getComputedStyle(ackLive.children[0].querySelector('.panel-heading'), '::after').backgroundColor;
    const ackNote = ackLive.children[0].querySelectorAll('.bosun-has-note-icon').length;
    let ackClicks = 0;
    ackLive.children[0].querySelector('input').addEventListener('click', () => { ackClicks += 1; });
    ackLive.children[0].querySelector('input').click();
    ackLive.collapse(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    ackLive.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackRepeated = [count(ackLive.group, true), ...ackLive.children.map((panel) => count(panel))];
    change('preferences.priorityCritical', false);
    const bothCriticalOff = [count(needLive.group, true), count(ackLive.group, true)];
    change('priorityRules.exactAlertNames', ['ack.warning']);
    const ackExactOn = [count(needLive.group, true), count(ackLive.group, true),
      ...ackLive.children.map((panel) => count(panel))];
    change('priorityRules.exactAlertNames', []);
    change('preferences.priorityCritical', true);
    change('preferences.priorityShowAcknowledged', false);
    change('priorityRules.exactAlertNames', ['need.live','ack.critical']);
    const ackToggledOff = [count(needLive.group, true), count(ackLive.group, true),
      ...ackLive.children.map((panel) => count(panel))];
    change('preferences.priorityShowAcknowledged', true);
    change('features.priorityAlerts', false);
    const bothDisabled = [count(needLive.group, true), count(ackLive.group, true),
      ...ackLive.children.map((panel) => count(panel))];
    change('features.priorityAlerts', true);
    const ackReplacement = mount('ack live', [ackLiveCritical, ackLiveWarning], true);
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    ackReplacement.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackRemount = [count(ackReplacement.group, true), ...ackReplacement.children.map((panel) => count(panel))];
    change('priorityRules.exactAlertNames', ['first','second','same']);
    const ackAmbiguous = mount('ack ambiguous', [child(701, 'first', 'critical')], true);
    hooks.applyAlertsPayload({ Groups: { Acknowledged: [{ Subject: 'ack ambiguous', Children: [
      child(701, 'first', 'critical'), child(701, 'second', 'critical')
    ] }] } });
    ackAmbiguous.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackAmbiguousCounts = [count(ackAmbiguous.group, true), count(ackAmbiguous.children[0])];
    const ackMismatch = mount('ack mismatch', [child(802, 'same', 'critical')], true);
    hooks.applyAlertsPayload({ Groups: { Acknowledged: [{ Subject: 'ack mismatch', Children: [child(801, 'same', 'critical')] }] } });
    ackMismatch.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackMismatchCounts = [count(ackMismatch.group, true), count(ackMismatch.children[0])];
    hooks.applyAlertsPayload({ Groups: { Acknowledged: [] } });
    const ackDisappeared = [count(ackMismatch.group, true), count(ackMismatch.children[0])];
    change('priorityRules.exactAlertNames', ['need.collision']);
    const needCollisionChild = child(901, 'need.collision', 'critical');
    const ackCollisionChild = child(901, 'ack.collision', 'warning');
    const needCollision = mount('need collision', [needCollisionChild]);
    const ackCollision = mount('ack collision', [ackCollisionChild], true, true);
    hooks.applyAlertsPayload({ Groups: {
      NeedAck: [{ Subject: 'need collision', Children: [needCollisionChild] }],
      Acknowledged: [{ Subject: 'ack collision', Children: [ackCollisionChild] }]
    } });
    needCollision.expand(); ackCollision.expand();
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const sectionCollision = [count(needCollision.group, true), count(needCollision.children[0]),
      count(ackCollision.group, true), count(ackCollision.children[0])];
    needCollision.group.querySelector('[ng-bind="group.Subject"]').textContent = 'synthetic need regrouped';
    ackCollision.group.querySelector('[ng-bind="group.Subject"]').textContent = 'synthetic ack regrouped';
    hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const sectionCollisionSkew = [count(needCollision.group, true), count(needCollision.children[0]),
      count(ackCollision.group, true), count(ackCollision.children[0])];
    const ackAmbiguousKey = mount('ack duplicate key', [child(null, 'same', 'critical')], true);
    hooks.applyAlertsPayload({ Groups: { Acknowledged: [{ Subject: 'ack duplicate key', Children: [
      child(null, 'same', 'critical'), child(null, 'same', 'warning')
    ] }] } });
    ackAmbiguousKey.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackAmbiguousKeyCounts = [count(ackAmbiguousKey.group, true), count(ackAmbiguousKey.children[0])];
    const conflictingChild = child(931, 'first.name', 'critical');
    conflictingChild.State.Alert = 'second.name';
    const ackConflicting = mount('ack conflicting name', [conflictingChild], true);
    hooks.applyAlertsPayload({ Groups: { Acknowledged: [{ Subject: 'ack conflicting name', Children: [conflictingChild] }] } });
    ackConflicting.expand(); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
    const ackConflictingCounts = [count(ackConflicting.group, true), count(ackConflicting.children[0])];
    const unknown = child(941, 'unknown.priority', 'unknown');
    const unknownMounted = mount('unknown priority', [unknown]);
    unknownMounted.expand();
    const unknownHeading = unknownMounted.children[0].querySelector('.panel-heading');
    unknownHeading.style.backgroundColor = 'rgb(232, 232, 232)';
    change('priorityRules.exactAlertNames', ['unknown.priority']);
    hooks.applyAlertsPayload({ Groups: { NeedAck: [{ Subject: 'unknown priority', Children: [unknown] }] } });
    const unknownCount = count(unknownMounted.children[0]);
    const unknownStyle = [getComputedStyle(unknownHeading).backgroundColor,
      getComputedStyle(unknownHeading, '::after').backgroundColor];
    history.replaceState({}, '', '/action?type=note');
    hooks.handleRouteChange();
    const routeCleanup = document.querySelectorAll('.bosun-priority-marker, .bosun-priority-row').length;
    return { collapsed, childCounts, noteCoexist, repeated, label, narrowStyle, clicks, disabled, reenabled,
      flagLayoutStable, flagPresentation, visualStyle, disabledStyle, nativeClickState, ackTint, warningStyle,
      unknownCount, unknownStyle, routeCleanup,
      criticalOff, exactOn, exactOff, domReplacement, replaced, ambiguousCounts, mismatchCounts, acknowledgedCounts,
      ackDefaultOff, ackEnabledCollapsed, ackExpanded, ackNote, ackClicks, ackRepeated, bothCriticalOff,
      ackExactOn, ackToggledOff, bothDisabled, ackRemount, ackAmbiguousCounts, ackMismatchCounts, ackDisappeared,
      sectionCollision, sectionCollisionSkew, ackAmbiguousKeyCounts, ackConflictingCounts };
  })()`);
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepStrictEqual(priorityMarkers, {
    collapsed: 1, childCounts: [1, 0], noteCoexist: 1, repeated: [1, 1, 0],
    label: ['Приоритетный алерт', 'Приоритетный алерт'], narrowStyle: [true, true], clicks: 1,
    flagLayoutStable: true,
    flagPresentation: ['0px', 'rgba(0, 0, 0, 0)', '0px', '14px', '600', '14px'],
    visualStyle: { background: 'rgb(255, 220, 220)', tint: 'rgba(49, 93, 156, 0.1)',
      outline: 'rgba(49, 93, 156, 0.35) 0px 0px 0px 1px inset', pointerEvents: 'none',
      noOverflow: true, groupTint: 'rgba(49, 93, 156, 0.1)' },
    disabledStyle: ['rgb(255, 220, 220)', 'none'], nativeClickState: [2, true],
    ackTint: 'rgba(49, 93, 156, 0.1)',
    warningStyle: ['rgb(255, 245, 210)', 'rgba(49, 93, 156, 0.1)'],
    unknownCount: 1, unknownStyle: ['rgb(232, 232, 232)', 'rgba(49, 93, 156, 0.1)'], routeCleanup: 0,
    disabled: [0, 0, 0], reenabled: [1, 1, 0], criticalOff: [1, 1],
    exactOn: [1, 0, 1], exactOff: [0, 0, 0], domReplacement: [1, 1, 0], replaced: [0, 0],
    ambiguousCounts: [0, 0], mismatchCounts: [0, 0], acknowledgedCounts: [0, 0],
    ackDefaultOff: [1, 1], ackEnabledCollapsed: [1, 1], ackExpanded: [1, 1, 0],
    ackNote: 0, ackClicks: 1, ackRepeated: [1, 1, 0], bothCriticalOff: [1, 1],
    ackExactOn: [0, 1, 0, 1], ackToggledOff: [1, 1, 1, 0], bothDisabled: [0, 0, 0, 0],
    ackRemount: [1, 1, 0], ackAmbiguousCounts: [0, 0], ackMismatchCounts: [0, 0], ackDisappeared: [0, 0],
    sectionCollision: [1, 1, 0, 0], sectionCollisionSkew: [1, 1, 0, 0],
    ackAmbiguousKeyCounts: [0, 0], ackConflictingCounts: [0, 0]
  }, 'Priority markers must follow resolved NeedAck children and live settings');
};
