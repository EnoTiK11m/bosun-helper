'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runAlertIdentityScenarios({ client, singleAlertAgeSource, alertsDataSource, promqlSource, contentSource }) {
  const ambiguousGrafanaIdentityResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${promqlSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    function childPanel(id, subject, ago) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      if (id) {
        const idNode = document.createElement('span');
        idNode.setAttribute('ng-show', 'state.Id');
        idNode.textContent = '#' + id;
        heading.appendChild(idNode);
      }
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subjectNode.textContent = subject;
      heading.appendChild(subjectNode);
      const agoNode = document.createElement('span');
      agoNode.setAttribute('ts-since', 'child.Ago');
      agoNode.textContent = ago;
      heading.appendChild(agoNode);
      panel.appendChild(heading);
      return panel;
    }

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'id group',
      Children: [
        { Subject: 'first', Ago: '1m', State: { Id: 42, Expr: "promras('''first_metric''')" } },
        { Subject: 'second', Ago: '2m', State: { Id: 42, Expr: "promras('''second_metric''')" } }
      ]
    }] } });
    const duplicateIdQuery = hooks.getGrafanaQueryForPanel(childPanel('42', 'first', '1m'));

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'same group',
      Children: [
        { Subject: 'same child', Ago: '1m', Expr: "promras('''first_metric''')" },
        { Subject: 'same child', Ago: '1m', Expr: "promras('''second_metric''')" }
      ]
    }] } });
    const groupPanel = document.createElement('div');
    groupPanel.className = 'panel';
    const groupHeading = document.createElement('div');
    groupHeading.className = 'panel-heading';
    const groupSubject = document.createElement('span');
    groupSubject.setAttribute('ng-bind', 'group.Subject');
    groupSubject.textContent = 'same group';
    groupHeading.appendChild(groupSubject);
    groupPanel.appendChild(groupHeading);
    const duplicateKeyPanel = childPanel('', 'same child', '1m');
    groupPanel.appendChild(duplicateKeyPanel);
    const duplicateKeyQuery = hooks.getGrafanaQueryForPanel(duplicateKeyPanel);

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'unique group',
      Children: [{
        Subject: 'unique child',
        AlertKey: 'unique.alert{host=web-1}',
        Ago: '3m',
        State: {
          Id: 77,
          AlertKey: 'unique.alert{host=web-1}',
          Tags: 'host=web-1',
          Expr: "promras('''unique_metric''', '2m', '2h', '')"
        }
      }]
    }] } });
    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const uniquePanel = childPanel('77', 'unique child', '3m');
    uniquePanel.querySelector('.panel-heading').setAttribute('ng-click', 'toggle()');
    root.appendChild(uniquePanel);
    document.body.appendChild(root);
    hooks.ensureGrafanaQueryButtons();
    return {
      duplicateIdQuery,
      duplicateKeyQuery,
      grafanaDefaultEnabled: hooks.isFeatureEnabled('grafanaIntegration'),
      uniqueButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
    };
  })()`);
  assert.deepStrictEqual(ambiguousGrafanaIdentityResult, {
    duplicateIdQuery: '',
    duplicateKeyQuery: '',
    grafanaDefaultEnabled: true,
    uniqueButtonCount: 1
  });

  const ageStrongIdentityResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    globalThis.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
    globalThis.BosunHelperRefreshCoordinator = undefined;
    globalThis.BosunHelperNewAlertTracker = undefined;
    ${singleAlertAgeSource}
    ${alertsDataSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const ago = new Date(Date.now() - 17 * 60 * 1000).toISOString();
    const snapshotChild = (subject, id) => ({ Subject: subject, Ago: ago, State: { Id: id } });
    function mount(type, children = [], count = 1) {
      document.body.innerHTML = '<div ts-ack-group="schedule.Groups.' + type + '"><div class="panel-group"></div></div>';
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = '<div class="panel-heading"><div class="panel-title">' +
        '<span ng-bind="group.Subject">same unique group</span>' +
        '<span class="pull-right ng-binding">' + count + ' alerts</span></div></div>';
      for (const child of children) {
        const node = document.createElement('div');
        node.className = 'panel';
        node.setAttribute('ng-repeat', 'child in group.Children');
        node.innerHTML = '<div class="panel-heading"><div class="panel-title"></div></div>';
        const title = node.querySelector('.panel-title');
        if (child.id) {
          const id = document.createElement('span');
          id.setAttribute('ng-show', 'state.Id');
          id.textContent = '#' + child.id;
          title.appendChild(id);
        }
        const subject = document.createElement('span');
        subject.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
        subject.textContent = child.subject || '';
        title.appendChild(subject);
        panel.appendChild(node);
      }
      document.querySelector('.panel-group').appendChild(panel);
      return panel;
    }
    const group = (children) => ({ Subject: 'same unique group', Children: children });
    const apply = (type, groups) => hooks.applyAlertsPayload({ Groups: { [type]: groups } });
    const text = (panel) => panel.querySelector('.pull-right.ng-binding').textContent;
    const result = {};
    for (const type of ['NeedAck', 'Acknowledged']) {
      const cases = {};
      let panel = mount(type, [{ subject: 'child-B' }]);
      apply(type, [group([snapshotChild('child-A')])]);
      cases.subjectConflict = text(panel);
      if (cases.subjectConflict !== '1 alerts') {
        throw new Error('A16: ' + type + ' child Subject conflict applied snapshot age: ' + cases.subjectConflict);
      }
      panel = mount(type, [{ subject: 'child-A' }]);
      // Numeric Ago is valid age data and does not add a string Ago suffix to the identity key.
      const matchingNoId = snapshotChild('child-A');
      matchingNoId.Ago = Date.parse(ago);
      apply(type, [group([matchingNoId])]);
      cases.matchWithoutId = text(panel);
      // Repaint the same panel with conflicting child identity: cached age must be discarded.
      panel.querySelector('[ng-bind="child.Subject || child.AlertKey"]').textContent = 'child-B';
      hooks.singleAlertAge.refresh();
      cases.repaintConflict = text(panel);
      panel = mount(type, [{ subject: 'child-A', id: 101 }]);
      apply(type, [group([snapshotChild('child-A', 101)])]);
      cases.matchId = text(panel);
      const replacement = mount(type, [{ subject: 'child-B', id: 202 }]);
      hooks.singleAlertAge.refresh();
      cases.replacementConflict = text(replacement);
      apply(type, [group([snapshotChild('child-B', 101)])]);
      cases.idConflict = text(replacement);
      panel = mount(type, [{ subject: 'synthetic.alert{host=B}' }]);
      const keyed = snapshotChild(undefined);
      keyed.AlertKey = 'synthetic.alert{host=A}';
      apply(type, [group([keyed])]);
      cases.alertKeyConflict = text(panel);
      panel = mount(type, [{ subject: 'child-A' }]);
      apply(type, [group([matchingNoId]), group([matchingNoId])]);
      cases.ambiguousKey = text(panel);
      panel = mount(type);
      apply(type, [group([snapshotChild('child-A', 101)])]);
      cases.collapsed = text(panel);
      panel = mount(type, [{ subject: 'child-A' }, { subject: 'child-B' }], 2);
      apply(type, [group([snapshotChild('child-A'), snapshotChild('child-B')])]);
      cases.multiple = text(panel);
      result[type] = cases;
    }
    return result;
  })()`);
  for (const type of ['NeedAck', 'Acknowledged']) {
    assert.deepStrictEqual(ageStrongIdentityResult[type], {
      subjectConflict: '1 alerts', matchWithoutId: '17m-ago', repaintConflict: '1 alerts',
      matchId: '17m-ago', replacementConflict: '1 alerts', idConflict: '1 alerts',
      alertKeyConflict: '1 alerts', ambiguousKey: '1 alerts', collapsed: '17m-ago', multiple: '2 alerts'
    }, 'A16: age identity contract failed in ' + type);
  }

  const strongIdentityMismatchResult = await evaluate(client, `(() => {
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

    function childPanel(id, subject, ago) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('ng-repeat', 'child in group.Children');
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      if (id) {
        const idNode = document.createElement('span');
        idNode.setAttribute('ng-show', 'state.Id');
        idNode.textContent = '#' + id;
        heading.appendChild(idNode);
      }
      if (subject) {
        const subjectNode = document.createElement('span');
        subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
        subjectNode.textContent = subject;
        heading.appendChild(subjectNode);
      }
      if (ago) {
        const agoNode = document.createElement('span');
        agoNode.setAttribute('ts-since', 'child.Ago');
        agoNode.textContent = ago;
        heading.appendChild(agoNode);
      }
      panel.appendChild(heading);
      return panel;
    }

    function groupPanel(subject, children) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'group.Subject');
      subjectNode.textContent = subject;
      heading.appendChild(subjectNode);
      panel.appendChild(heading);
      for (const child of children || []) panel.appendChild(child);
      return panel;
    }

    const note = { Type: 'Note', User: 'operator', Message: 'synthetic note' };
    function resolve(groups, panel) {
      hooks.rebuildAlertDataIndex({ Groups: { NeedAck: groups } });
      return hooks.resolveGroupState(panel);
    }

    const idMismatch = resolve([{
      Subject: 'Same Subject',
      Children: [{ Subject: 'same child', Ago: '1m', State: { Id: 101, Actions: [note] } }]
    }], groupPanel('Same Subject', [childPanel('202', 'same child', '1m')]));

    const keyMismatch = resolve([{
      Subject: 'Key Subject',
      Children: [{ Subject: 'snapshot child', Ago: '1m', State: { Actions: [note] } }]
    }], groupPanel('Key Subject', [childPanel('', 'different child', '1m')]));

    const collapsedKnownGroup = resolve([{
      Subject: 'Known Group',
      Children: [{ Subject: 'snapshot child', Ago: '1m', State: { Id: 301, Actions: [note] } }]
    }], groupPanel('Known Group', []));

    const subjectOnlyFallback = resolve([{
      Subject: 'Subject Only',
      Children: [{ State: { Actions: [note] } }]
    }], groupPanel('Subject Only', []));

    const ambiguousSubject = resolve([
      {
        Subject: 'Repeated Subject',
        Children: [{ Subject: 'first', Ago: '1m', State: { Id: 401, Actions: [note] } }]
      },
      {
        Subject: 'Repeated Subject',
        Children: [{ Subject: 'second', Ago: '1m', State: { Id: 402, Actions: [] } }]
      }
    ], groupPanel('Repeated Subject', [childPanel('499', 'other', '1m')]));

    const exactStrongIdentity = resolve([{
      Subject: 'Exact Subject',
      Children: [{ Subject: 'exact child', Ago: '1m', State: { Id: 501, Actions: [note] } }]
    }], groupPanel('Exact Subject', [childPanel('501', 'exact child', '1m')]));

    const staleIconPanel = groupPanel('Stale Icon Subject', [
      childPanel('602', 'stale child', '1m')
    ]);
    const staleIcon = document.createElement('span');
    staleIcon.className = 'bosun-has-note-icon';
    staleIconPanel.querySelector('[ng-repeat="child in group.Children"] .panel-heading')
      .appendChild(staleIcon);
    const staleIconStrongMismatch = resolve([{
      Subject: 'Stale Icon Subject',
      Children: [{ Subject: 'stale child', Ago: '1m', State: { Id: 601, Actions: [note] } }]
    }], staleIconPanel);

    const duplicateDerivedKey = resolve([{
      Subject: 'Duplicate Key Subject',
      Children: [
        { Subject: 'same key', Ago: '1m', State: { Actions: [] } },
        { Subject: 'same key', Ago: '1m', State: { Actions: [note] } }
      ]
    }], groupPanel('Duplicate Key Subject', [childPanel('', 'same key', '1m')]));

    return {
      idMismatch,
      keyMismatch,
      collapsedKnownGroup,
      subjectOnlyFallback,
      ambiguousSubject,
      exactStrongIdentity,
      staleIconStrongMismatch,
      duplicateDerivedKey
    };
  })()`);
  assert.deepStrictEqual(strongIdentityMismatchResult, {
    idMismatch: 'none',
    keyMismatch: 'none',
    collapsedKnownGroup: 'note',
    subjectOnlyFallback: 'note',
    ambiguousSubject: 'none',
    exactStrongIdentity: 'note',
    staleIconStrongMismatch: 'none',
    duplicateDerivedKey: 'none'
  }, 'Group marker resolution fell back to Subject after a strong identity mismatch');
};
