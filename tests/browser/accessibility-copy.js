'use strict';

const assert = require('assert');
const runLastActionAssertions = require('./last-action');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runAccessibilityCopyScenarios({ client, contentSource, lastActionSource }) {
  const accessibilityResult = await evaluate(client, `(() => {
    document.body.innerHTML = '<div id="actions"></div><div id="child-title"></div>' +
      '<div id="last-action">Note by operator at <span ts-time="state.LastAction.Time">' +
      '<a href="https://www.timeanddate.com/worldclock/converter.html">now</a></span>: ' +
      '<span ng-show="state.LastAction.Message">: первая строка<br>' +
      'https://example.test/runbook.<br>третья строка</span></div>' +
      '<div><span id="invalid-last-action-url" ng-show="state.LastAction.Message">http://.</span></div>' +
      '<div class="container" style="width: 95%"></div>' +
      '<div id="group" class="panel"><div class="panel-heading"><div class="panel-title"></div></div></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    const trackerReconciles = [];
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() {},
          add() {},
          reconcile(payload) { trackerReconciles.push(payload); }
        };
      }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const lastActionMessage = document.querySelector('[ng-show="state.LastAction.Message"]');
    hooks.ensureLastActionCopyButtons();
    const lastActionTime = document.querySelector('[ts-time="state.LastAction.Time"]');
    const lastActionTimeState = {
      hasLink: Boolean(lastActionTime.querySelector('a')),
      text: lastActionTime.textContent,
      replacementClass: lastActionTime.firstElementChild?.className,
      color: lastActionTime.firstElementChild?.style.color
    };
    const invalidUrlMessage = document.querySelector('#invalid-last-action-url');
    const invalidUrlTextNode = invalidUrlMessage.firstChild;
    hooks.ensureLastActionCopyButtons();
    const invalidUrlStayedStable =
      invalidUrlMessage.firstChild === invalidUrlTextNode &&
      !invalidUrlMessage.querySelector('a');
    const lastActionCopyButton = document.querySelector('.bosun-copy-last-action-btn');
    const lastActionLink = lastActionMessage.querySelector('.bosun-last-action-link');
    const lastActionCopy = {
      text: hooks.getLastActionMessageText(lastActionMessage),
      buttonCount: lastActionMessage.parentElement.querySelectorAll('.bosun-copy-last-action-btn').length,
      buttonText: lastActionCopyButton?.textContent,
      buttonTitle: lastActionCopyButton?.title,
      buttonLabel: lastActionCopyButton?.getAttribute('aria-label'),
      linkText: lastActionLink?.textContent,
      linkHref: lastActionLink?.href,
      linkTarget: lastActionLink?.target,
      linkRel: lastActionLink?.rel
    };
    const replacementMessage = document.createElement('span');
    replacementMessage.setAttribute('ng-show', 'state.LastAction.Message');
    replacementMessage.textContent = ': заменённая заметка';
    lastActionMessage.replaceWith(replacementMessage);
    hooks.ensureLastActionCopyButtons();
    const replacementState = {
      text: hooks.getLastActionMessageText(replacementMessage),
      buttonCount: replacementMessage.parentElement.querySelectorAll('.bosun-copy-last-action-btn').length
    };
    replacementMessage.remove();
    hooks.ensureLastActionCopyButtons();
    const orphanButtonRemoved = !lastActionCopyButton.isConnected;
    const childTitle = document.querySelector('#child-title');
    hooks.ensureStateIcon(childTitle, 'note');
    const note = childTitle.querySelector('.bosun-has-note-icon');
    const noteSemantics = {
      role: note?.getAttribute('role'),
      label: note?.getAttribute('aria-label'),
      title: note?.title
    };
    hooks.ensureStateIcon(childTitle, 'warning');
    const warning = childTitle.querySelector('.bosun-old-no-note-icon');

    const group = document.querySelector('#group');
    hooks.ensureParentStateIcon(group, 'note');
    const parent = group.querySelector('.bosun-parent-marker');

    const actions = document.querySelector('#actions');
    hooks.ensureAutoRefreshControls(actions);
    const input = actions.querySelector('#bosun-auto-refresh-idle-seconds');
    const hint = document.getElementById(input?.getAttribute('aria-describedby'));
    const copyFeedbackButton = document.createElement('button');
    copyFeedbackButton.textContent = 'Копировать';
    copyFeedbackButton.title = 'Скопировать текст алерта';
    actions.appendChild(copyFeedbackButton);
    hooks.flashCopyButtonState(copyFeedbackButton, true);
    const copyFeedback = {
      text: copyFeedbackButton.textContent,
      title: copyFeedbackButton.title,
      copied: copyFeedbackButton.dataset.copied,
      toolbarText: document.querySelector('#bosun-top-status')?.textContent || ''
    };
    history.replaceState({}, '', '/');
    hooks.setNewAlertNoticeCounts({ warning: 3, critical: 1, unknown: 4 });
    hooks.applyAlertsPayload({ Groups: { NeedAck: [] }, marker: 'follower' }, { source: 'follower' });
    hooks.applyAlertsPayload({ Groups: { NeedAck: [] }, marker: 'leader' }, { source: 'leader' });
    const newAlertNotice = document.querySelector('#bosun-new-alerts-notice');
    const allSeverityNoticeText = newAlertNotice?.textContent;
    const allSeverityNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 0, critical: 5, unknown: 0 });
    const criticalOnlyNoticeText = newAlertNotice?.textContent;
    const criticalOnlyNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 2, critical: 0, unknown: 4 });
    const warningAndUnknownNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 0, critical: 0, unknown: 3 });
    const unknownOnlyNoticeClass = newAlertNotice?.className;
    const warningCountBeforeRoute = childTitle.querySelectorAll('.bosun-old-no-note-icon').length;
    hooks.seedMarkerCache('cached-alert', 'note');
    hooks.clearMarkerState();
    const restoredMarker = hooks.restoreMarkerCache();
    history.replaceState({}, '', '/action?type=note');
    hooks.handleRouteChange();
    const markerOnActionRoute = hooks.markerState();
    history.replaceState({}, '', '/');
    hooks.handleRouteChange();
    const markerAfterDashboardReturn = hooks.markerState();
    sessionStorage.setItem('bosunAlertMarkerCacheV1', JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      maps: { childHasNoteById: [['cached-alert', true]] }
    }));
    hooks.clearMarkerState();
    const incompleteMarkerCache = hooks.restoreMarkerCache();
    return {
      noteSemantics,
      noteRemovedAfterTransition: !childTitle.querySelector('.bosun-has-note-icon'),
      warningCount: warningCountBeforeRoute,
      warningRole: warning?.getAttribute('role'),
      warningLabel: warning?.getAttribute('aria-label'),
      parentRole: parent?.getAttribute('role'),
      parentLabel: parent?.getAttribute('aria-label'),
      inputAccessibleName: input?.getAttribute('aria-label'),
      inputHintText: hint?.textContent.trim(),
      describedBy: input?.getAttribute('aria-describedby'),
      copyFeedback,
      lastActionCopy,
      replacementState,
      orphanButtonRemoved,
      invalidUrlStayedStable,
      lastActionTimeState,
      allSeverityNoticeText,
      allSeverityNoticeClass,
      criticalOnlyNoticeText,
      criticalOnlyNoticeClass,
      warningAndUnknownNoticeClass,
      unknownOnlyNoticeClass,
      newAlertNoticeUnderTools: newAlertNotice?.previousElementSibling?.classList.contains('bosun-top-controls-inner') === true,
      trackerReconcileMarkers: trackerReconciles.map((payload) => payload.marker),
      refreshIntervals: hooks.refreshIntervals,
      restoredMarker,
      markerOnActionRoute,
      markerAfterDashboardReturn,
      incompleteMarkerCache
    };
  })()`);

  assert.strictEqual(accessibilityResult.noteSemantics.role, 'img');
  assert.ok(accessibilityResult.noteSemantics.label);
  assert.strictEqual(accessibilityResult.noteSemantics.label, accessibilityResult.noteSemantics.title);
  assert.strictEqual(accessibilityResult.noteRemovedAfterTransition, true);
  assert.strictEqual(accessibilityResult.warningCount, 1);
  assert.strictEqual(accessibilityResult.warningRole, 'img');
  assert.ok(accessibilityResult.warningLabel);
  assert.strictEqual(accessibilityResult.parentRole, 'img');
  assert.ok(accessibilityResult.parentLabel);
  assert.ok(accessibilityResult.inputAccessibleName);
  assert.ok(accessibilityResult.describedBy);
  assert.ok(accessibilityResult.inputHintText);
  assert.deepStrictEqual(accessibilityResult.copyFeedback, {
    text: 'Скопировано',
    title: 'Скопировано',
    copied: 'true',
    toolbarText: ''
  });
  assert.deepStrictEqual(accessibilityResult.lastActionCopy, {
    text: 'первая строка\nhttps://example.test/runbook.\nтретья строка',
    buttonCount: 1,
    buttonText: 'Копировать',
    buttonTitle: 'Скопировать текст заметки',
    buttonLabel: 'Скопировать текст заметки',
    linkText: 'https://example.test/runbook',
    linkHref: 'https://example.test/runbook',
    linkTarget: '_blank',
    linkRel: 'noopener noreferrer'
  });
  assert.deepStrictEqual(accessibilityResult.replacementState, {
    text: 'заменённая заметка',
    buttonCount: 1
  });
  assert.strictEqual(accessibilityResult.orphanButtonRemoved, true);
  assert.strictEqual(accessibilityResult.invalidUrlStayedStable, true);
  assert.deepStrictEqual(accessibilityResult.lastActionTimeState, {
    hasLink: false,
    text: 'now',
    replacementClass: 'bosun-last-action-time-text',
    color: 'rgb(0, 0, 238)'
  });
  assert.strictEqual(accessibilityResult.allSeverityNoticeText, 'Новые алерты: Warn: 3, Crit: 1, Unk: 4');
  assert.strictEqual(accessibilityResult.criticalOnlyNoticeText, 'Новые алерты: Crit: 5');
  assert.match(accessibilityResult.allSeverityNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.criticalOnlyNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.warningAndUnknownNoticeClass, /\bis-warning\b/);
  assert.doesNotMatch(accessibilityResult.warningAndUnknownNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.unknownOnlyNoticeClass, /\bis-unknown\b/);
  assert.strictEqual(accessibilityResult.newAlertNoticeUnderTools, true);
  assert.deepStrictEqual(accessibilityResult.trackerReconcileMarkers, ['leader']);
  assert.deepStrictEqual(accessibilityResult.refreshIntervals, { visible: 4000, hidden: 10000 });
  assert.deepStrictEqual(accessibilityResult.restoredMarker, {
    restored: true,
    note: true,
    warning: false
  });
  assert.deepStrictEqual(accessibilityResult.markerOnActionRoute, { ready: false, note: false });
  assert.deepStrictEqual(accessibilityResult.markerAfterDashboardReturn, { ready: true, note: true });
  assert.deepStrictEqual(
    accessibilityResult.incompleteMarkerCache,
    { restored: false, note: false, warning: false },
    'Incomplete marker cache schema was restored instead of being rejected atomically'
  );
  await runLastActionAssertions({ client, lastActionSource });
};
