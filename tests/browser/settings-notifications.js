'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSettingsNotificationScenarios({ client, focusedAuditCase, needAckBaselineSource, newAlertTrackerSource, alertsDataSource, pageUtilsSource, contentSource }) {
  const settingsLifecycleResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML =
      '<button class="bosun-copy-alert-btn"></button>' +
      '<button class="bosun-copy-all-alerts-btn"></button>' +
      '<button class="bosun-copy-last-action-btn"></button>' +
      '<button class="bosun-grafana-query-btn"></button>' +
      '<div class="bosun-silence-hidden"><span class="bosun-silenced-badge"></span></div>' +
      '<div class="bosun-user-comment-hidden"></div>' +
      '<div class="bosun-acknowledged-collapsed"></div>' +
      '<div id="bosun-new-alerts-notice"></div>' +
      '<div class="bosun-sound-alerts-wrap"></div>' +
      '<div class="bosun-auto-refresh-group"></div>' +
      '<div class="bosun-action-templates"></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('copyButtons', false);
    const independentAfterCopyDisable = {
      copy: document.querySelectorAll('.bosun-copy-alert-btn, .bosun-copy-all-alerts-btn').length,
      lastAction: document.querySelectorAll('.bosun-copy-last-action-btn').length,
      grafana: document.querySelectorAll('.bosun-grafana-query-btn').length
    };
    hooks.setFeature('grafanaIntegration', false);
    hooks.setFeature('silencedFilter', false);
    hooks.setFeature('noCommentFilter', false);
    hooks.setFeature('acknowledgedCollapse', false);
    hooks.setFeature('soundNotifications', false);
    hooks.setFeature('visualNewAlertNotifications', false);
    hooks.setFeature('autoRefresh', false);
    hooks.setFeature('actionTemplates', false);
    hooks.setFeature('checkboxImprovements', false);
    const disabled = {
      grafana: document.querySelectorAll('.bosun-grafana-query-btn').length,
      hidden: document.querySelectorAll('.bosun-silence-hidden').length,
      silencedBadge: document.querySelectorAll('.bosun-silenced-badge').length,
      noComment: document.querySelectorAll('.bosun-user-comment-hidden').length,
      acknowledged: document.querySelectorAll('.bosun-acknowledged-collapsed').length,
      sound: document.querySelectorAll('.bosun-sound-alerts-wrap').length,
      visual: document.querySelectorAll('#bosun-new-alerts-notice').length,
      autoRefresh: document.querySelectorAll('.bosun-auto-refresh-group').length,
      actionTemplates: document.querySelectorAll('.bosun-action-templates').length,
      checkboxStyleDisabled: document.body.classList.contains('bosun-checkbox-improvements-disabled')
    };
    hooks.setFeature('checkboxImprovements', true);
    hooks.setFeature('lastActionEnhancements', false);
    return {
      independentAfterCopyDisable,
      disabled,
      checkboxStyleReenabled: !document.body.classList.contains('bosun-checkbox-improvements-disabled'),
      lastActionRequiresReload: document.querySelectorAll('.bosun-copy-last-action-btn').length === 1
    };
  })()`);
  assert.deepStrictEqual(settingsLifecycleResult, {
    independentAfterCopyDisable: { copy: 0, lastAction: 1, grafana: 1 },
    disabled: {
      grafana: 0,
      hidden: 0,
      silencedBadge: 0,
      noComment: 0,
      acknowledged: 0,
      sound: 0,
      visual: 0,
      autoRefresh: 0,
      actionTemplates: 0,
      checkboxStyleDisabled: true
    },
    checkboxStyleReenabled: true,
    lastActionRequiresReload: true
  });

  const soundVisualIndependence = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    const trackerAdds = [];
    const played = [];
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunSilenceHiderNeedAckSeverity = {
      createNeedAckSeverity() {
        return {
          collectCurrentIdsAndSeverity(payload) {
            const currentIds = new Set();
            const idToSeverity = new Map();
            for (const group of payload?.Groups?.NeedAck || []) {
              for (const child of group.Children || []) {
                const id = String(child.State.Id);
                currentIds.add(id);
                idToSeverity.set(id, 'warning');
              }
            }
            return { currentIds, idToSeverity };
          },
          needAckStableKey(child) { return String(child?.State?.Id || ''); },
          needAckGroupStableKey() { return ''; }
        };
      }
    };
    globalThis.BosunSilenceHiderSound = {
      createSound() {
        return {
          playNeedAckChime(kind) { played.push(kind); },
          destroy() {}, installAudioUnlockTracking() {}, ensureAudioObjects() {}
        };
      }
    };
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() {}, destroy() {}, reconcile() {},
          add(ids) { trackerAdds.push(ids.slice()); }
        };
      }
    };
    ${needAckBaselineSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const payload = (ids) => ({ Groups: { NeedAck: [{
      Subject: 'group',
      Children: ids.map((id) => ({ Subject: 'alert-' + id, State: { Id: id } }))
    }] } });
    hooks.applyAlertsPayload(payload(['A']), { source: 'leader' });
    hooks.setPreference('soundEnabled', false);
    hooks.applyAlertsPayload(payload(['A', 'B']), { source: 'leader' });
    await Promise.resolve();
    return { trackerAdds, played };
  })()`);
  assert.deepStrictEqual(soundVisualIndependence, { trackerAdds: [['B']], played: [] });

  const visualTrackerLifecycle = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    const calls = { start: 0, destroy: 0, add: 0, reconcile: [] };
    globalThis.BosunHelperRefreshCoordinator = undefined;
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() { calls.start += 1; return Promise.resolve(); },
          destroy() { calls.destroy += 1; },
          add() { calls.add += 1; },
          reconcile(payload) { calls.reconcile.push(payload.marker); }
        };
      }
    };
    globalThis.BosunSilenceHiderNeedAckBaseline = {
      createNeedAckBaseline() { return { process() {}, reset() {}, restoreFromSession() {} }; }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('visualNewAlertNotifications', false);
    hooks.applyAlertsPayload({ marker: 'latest', Groups: { NeedAck: [] } }, { source: 'leader' });
    hooks.setFeature('visualNewAlertNotifications', true);
    await Promise.resolve();
    await Promise.resolve();
    return calls;
  })()`);
  assert.deepStrictEqual(visualTrackerLifecycle, {
    start: 1,
    destroy: 1,
    add: 0,
    reconcile: ['latest']
  });

  const sharedVisualTracker = await evaluate(client, `(async () => {
    const key = 'bosunNewAlertsAwaitingNoteV1:' + location.origin;
    const stored = {};
    const listeners = new Set();
    let writes = 0;
    const storage = {
      get(keys, callback) { callback(Object.fromEntries(keys.map((key) => [key, stored[key]]))); },
      set(values, callback) {
        writes += 1;
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: stored[key], newValue: value };
          stored[key] = value;
        }
        callback?.();
        for (const listener of listeners) listener(changes, 'local');
      }
    };
    const settle = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };
    const payload = (ids, noted = []) => ({ Groups: { NeedAck: [{
      Subject: 'synthetic-group', Children: ids.map((id) => ({
        Subject: 'synthetic-' + id,
        State: { Id: id, Actions: noted.includes(id) ? [{ Type: 'Note' }] : [] }
      }))
    }] } });
    const frames = [];
    async function createTab(role, hidden, coordinated = true) {
      const frame = document.createElement('iframe');
      frame.src = location.origin + '/';
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      document.body.appendChild(frame);
      frames.push(frame);
      await loaded;
      const win = frame.contentWindow;
      win.document.body.innerHTML = '<nav class="navbar navbar-default navbar-static-top"></nav>';
      const tab = { role, hidden, snapshot: null, pendingRestore: null, delayRestore: false };
      Object.defineProperty(win.document, 'visibilityState', { get: () => tab.hidden ? 'hidden' : 'visible' });
      win.chrome = {
        runtime: { lastError: null },
        storage: {
          local: {
            get(keys, callback) {
              if (tab.delayRestore && keys.includes(key)) tab.pendingRestore = () => storage.get(keys, callback);
              else storage.get(keys, callback);
            },
            set: storage.set
          },
          onChanged: {
            addListener(listener) { listeners.add(listener); },
            removeListener(listener) { listeners.delete(listener); }
          }
        }
      };
      win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
      win.BosunHelperRefreshCoordinator = {
        createRefreshCoordinator() {
          return { getRole: () => tab.role,
            ownsSnapshot: (snapshot) => tab.role === 'leader' && snapshot === tab.snapshot };
        }
      };
      if (!coordinated) win.BosunHelperRefreshCoordinator = undefined;
      win.BosunSilenceHiderNeedAckSeverity = {
        createNeedAckSeverity() {
          return {
            collectCurrentIdsAndSeverity(value) {
              const ids = value.Groups.NeedAck.flatMap((group) => group.Children.map((child) => child.State.Id));
              return { currentIds: new Set(ids), idToSeverity: new Map(ids.map((id) => [id, 'warning'])) };
            },
            needAckStableKey: (child) => child.State.Id
          };
        }
      };
      // The tracker receives the real alerts-data Note predicate through content.js.
      win.eval(${JSON.stringify(alertsDataSource)});
      win.eval(${JSON.stringify(needAckBaselineSource)});
      win.eval(${JSON.stringify(newAlertTrackerSource)});
      win.eval(${JSON.stringify(contentSource)});
      tab.hooks = win.__BosunHelperBrowserTest;
      tab.apply = (value, source = tab.role) => {
        if (source === 'leader') tab.snapshot = value;
        tab.hooks.applyAlertsPayload(value, { source });
      };
      tab.enable = async () => { tab.hooks.setFeature('visualNewAlertNotifications', true); await settle(); };
      tab.disable = () => tab.hooks.setFeature('visualNewAlertNotifications', false);
      tab.notice = () => win.document.querySelector('#bosun-new-alerts-notice')?.textContent || '';
      tab.disable();
      return tab;
    }
    try {
      const leader = await createTab('leader', false);
      const follower = await createTab('follower', true);
      leader.apply(payload(['A']));
      follower.apply(payload(['A']));
      await leader.enable();
      leader.apply(payload(['A', 'B']));
      await settle();
      const ids = () => stored[key].alerts.map((item) => item.id);
      const requireB = (stage) => {
        if (!ids().includes('B')) throw new Error('A15: tracked B lost ' + stage + ': ' + JSON.stringify(ids()));
      };
      requireB('after detection');
      leader.disable();
      await leader.enable();
      requireB('after leader enable');
      const beforeFollowerWrites = writes;
      await follower.enable();
      requireB('after stale hidden follower enable');
      const followerRestored = follower.notice().includes('1');
      const followerReadOnly = writes === beforeFollowerWrites;
      leader.apply(payload(['A', 'B']));
      await settle();
      requireB('after next leader reconcile');

      // Losing ownership while restore is pending must invalidate cleanup.
      follower.disable();
      follower.role = 'leader';
      follower.apply(payload(['A']));
      follower.delayRestore = true;
      follower.hooks.setFeature('visualNewAlertNotifications', true);
      follower.role = 'follower';
      follower.pendingRestore();
      await settle();
      requireB('after ownership loss during restore');

      // Becoming visible/leader does not make an old snapshot authoritative.
      follower.disable();
      follower.delayRestore = false;
      follower.hidden = false;
      follower.role = 'leader';
      follower.snapshot = null;
      await follower.enable();
      requireB('after visible leadership transition without fresh snapshot');
      follower.apply(payload(['A', 'B']));
      await settle();
      requireB('after new owner fresh snapshot');
      follower.apply(payload(['A']));
      follower.role = 'follower';
      await settle();
      requireB('after ownership loss during reconcile await');
      follower.role = 'leader';
      follower.apply(payload(['A']));
      await settle();
      const removedByOwner = ids().length === 0 && !leader.notice().includes('1');
      follower.apply(payload(['A', 'C']));
      await settle();
      const detectedC = ids().includes('C');
      follower.apply(payload(['A', 'C'], ['C']));
      await settle();
      const removedByNote = ids().length === 0;
      follower.apply(payload(['A', 'D']));
      await settle();
      if (!ids().includes('D')) throw new Error('A15: acknowledgement fixture was not tracked');
      follower.apply({ Groups: { NeedAck: [], Acknowledged: [{ Children: [{ State: { Id: 'D' } }] }] } });
      await settle();
      const removedByAcknowledgement = ids().length === 0;
      follower.apply(payload(['A', 'E']));
      await settle();
      follower.disable();
      follower.apply(payload(['A']));
      await follower.enable();
      const removedOnOwnerEnable = ids().length === 0;
      leader.disable();
      follower.disable();
      const single = await createTab('leader', false, false);
      single.apply(payload(['S']));
      await single.enable();
      single.apply(payload(['S', 'T']));
      await settle();
      single.disable();
      await single.enable();
      const singleTabRestored = ids().includes('T') && single.notice().includes('1');
      single.apply(payload(['S']));
      await settle();
      const singleTabCleanup = ids().length === 0;
      single.disable();
      return { followerRestored, followerReadOnly, removedByOwner, detectedC, removedByNote,
        removedByAcknowledgement, removedOnOwnerEnable, singleTabRestored, singleTabCleanup,
        listenersAfterDisable: listeners.size };
    } finally { for (const frame of frames) frame.remove(); }
  })()`);
  assert.deepStrictEqual(sharedVisualTracker, {
    followerRestored: true, followerReadOnly: true, removedByOwner: true,
    detectedC: true, removedByNote: true, removedByAcknowledgement: true,
    removedOnOwnerEnable: true, singleTabRestored: true, singleTabCleanup: true,
    listenersAfterDisable: 0
  });

  const checkboxActionGate = await evaluate(client, `(() => {
    history.replaceState({}, '', '/action?type=note');
    document.body.innerHTML = '<input id="notify" type="checkbox" ng-model="state.Notify" checked>';
    const notify = document.querySelector('#notify');
    let clicks = 0;
    notify.addEventListener('click', () => { clicks += 1; });
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${pageUtilsSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('checkboxImprovements', false);
    hooks.applyActionPageTweaks();
    return { checked: notify.checked, clicks };
  })()`);
  assert.deepStrictEqual(checkboxActionGate, { checked: true, clicks: 0 });

  const notifyChoiceLifecycle = await evaluate(client, `(() => {
    history.replaceState({}, '', '/action?type=note');
    document.body.innerHTML =
      '<form id="action-form"><input id="notify-choice" type="checkbox" ng-model="state.Notify" checked></form>';
    const api = BosunSilenceHiderPageUtils.createPageUtils();
    const first = document.querySelector('#notify-choice');
    let firstClicks = 0;
    first.addEventListener('click', () => { firstClicks += 1; });
    api.applyActionPageTweaks();
    const initialDefaultApplied = first.checked === false && firstClicks === 1;

    first.click();
    const explicitUserChoice = first.checked === true;
    document.querySelector('#action-form').appendChild(document.createElement('span'));
    api.applyActionPageTweaks();
    const sameFormPreserved = first.checked === true && firstClicks === 2;

    const replacement = document.createElement('input');
    replacement.id = 'notify-choice';
    replacement.type = 'checkbox';
    replacement.checked = true;
    replacement.setAttribute('ng-model', 'state.Notify');
    let replacementClicks = 0;
    replacement.addEventListener('click', () => { replacementClicks += 1; });
    first.replaceWith(replacement);
    api.applyActionPageTweaks();
    const sameFormRepaintPreserved = replacement.checked === true && replacementClicks === 0;

    const newForm = document.createElement('form');
    newForm.id = 'replacement-action-form';
    const newFormNotify = document.createElement('input');
    newFormNotify.type = 'checkbox';
    newFormNotify.checked = true;
    newFormNotify.setAttribute('ng-model', 'state.Notify');
    let newFormClicks = 0;
    newFormNotify.addEventListener('click', () => { newFormClicks += 1; });
    newForm.appendChild(newFormNotify);
    document.querySelector('#action-form').replaceWith(newForm);
    api.applyActionPageTweaks();
    const newFormReceivedDefault = newFormNotify.checked === false && newFormClicks === 1;

    api.applyActionPageTweaks();
    return {
      initialDefaultApplied,
      explicitUserChoice,
      sameFormPreserved,
      sameFormRepaintPreserved,
      newFormReceivedDefault,
      repeatedNewFormPassStable: newFormNotify.checked === false && newFormClicks === 1
    };
  })()`);
  if (!focusedAuditCase || focusedAuditCase === 'A06') {
    assert.deepStrictEqual(notifyChoiceLifecycle, {
      initialDefaultApplied: true,
      explicitUserChoice: true,
      sameFormPreserved: true,
      sameFormRepaintPreserved: true,
      newFormReceivedDefault: true,
      repeatedNewFormPassStable: true
    });
  }
};
