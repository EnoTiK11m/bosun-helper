'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = function createMarkerStartupScenarios({ readTestScript, instrumentContentSource }) {
async function runPrimeMarkerStartupAssertions(client) {
  const sources = Object.fromEntries(Object.entries({
    settings: 'src/settings/settings.js', alerts: 'src/bosun/alerts-data.js',
    severity: 'src/bosun/needack-severity.js', priority: 'src/bosun/priority-alerts.js',
    coordinator: 'src/shared/refresh-coordinator.js'
  }).map(([key, file]) => [key, readTestScript(file)]));
  sources.content = instrumentContentSource(readTestScript('src/bosun/content.js'));
  const results = await evaluate(client, `(${(async function (sources) {
    const results = {};
    for (const scenario of ['orphan', 'single', 'active-peer', 'late-settings', 'expired-settings', 'expired-fetch',
      'newer-snapshot', 'route', 'route-return', 'pagehide', 'invalid-payload', 'ambiguous']) {
      const frame = document.createElement('iframe'); frame.src = '/';
      await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
      const win = frame.contentWindow, doc = frame.contentDocument;
      win.sessionStorage.removeItem('bosunAlertMarkerCacheV1');
      let now = 0, nextTimer = 0, dropNextRead = false, releaseSettings;
      const timers = new Map(), stored = {}, requests = [], writes = [];
      const effects = { baseline: 0, sound: 0, add: 0, reconcile: 0, published: 0 };
      const drain = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
      const advance = async target => {
        await drain();
        for (;;) {
          const next = [...timers].filter(([, timer]) => timer.at <= target)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          timers.delete(next[0]); now = next[1].at; next[1].fn(); await drain();
        }
        now = target; await drain();
      };
      win.setTimeout = (fn, delay = 0) => {
        timers.set(++nextTimer, { fn, at: now + Number(delay) }); return nextTimer;
      };
      win.clearTimeout = id => timers.delete(id);
      const RealDate = win.Date;
      win.Date = class extends RealDate { static now() { return now; } };
      const storage = {
        get(keys, callback) {
          if (dropNextRead) { dropNextRead = false; return; }
          callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
        },
        set(values, callback) { Object.assign(stored, values); writes.push(...Object.keys(values)); callback?.(); },
        remove(keys, callback) { keys.forEach(key => delete stored[key]); callback?.(); }
      };
      Object.defineProperty(win, 'chrome', { configurable: true, value: {
        runtime: { lastError: null }, storage: { local: storage, onChanged: { addListener() {}, removeListener() {} } }
      } });
      // Пустой синтетический канал моделирует неработающую вкладку; активная вкладка
      // продолжает продлевать настоящую аренду. Реальные вкладки и рабочие данные не участвуют.
      win.BroadcastChannel = class {
        addEventListener() {} removeEventListener() {} close() {}
        postMessage(message) { if (message.type === 'snapshot') effects.published++; }
      };
      win.eval(sources.coordinator);
      const old = win.BosunHelperRefreshCoordinator.createRefreshCoordinator({
        fetchSnapshot: async () => ({ Groups: { NeedAck: [] } }), applySnapshot() {},
        visiblePollMs: 4000, hiddenPollMs: 10000
      });
      old.start(); await drain(); await advance(800);
      if (scenario !== 'active-peer') {
        dropNextRead = scenario !== 'single';
        win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: false }));
        await drain();
      }
      const leaseKey = Object.keys(stored).find(key => key.includes(':lease:'));
      const originalLease = JSON.stringify(stored[leaseKey]);
      const rows = [1, 2, 3].map(n => ({ Alert: 'synthetic.startup', Subject: 'synthetic child ' + n, Ago: '1m',
        AlertKey: 'synthetic.startup{cluster=two words,disk-name=/,host=node' + n + '}',
        State: { Id: 7000 + n, Alert: 'synthetic.startup',
          AlertKey: 'synthetic.startup{host=node' + n + ',disk-name=/,cluster=two words}',
          CurrentStatus: 'warning', Actions: [{ Type: 'Note' }] } }));
      const ack = { ...rows[0], Subject: 'synthetic acknowledged', State: { ...rows[0].State, Id: 7010 },
        AlertKey: 'synthetic.startup{host=ack}', };
      ack.State.AlertKey = ack.AlertKey;
      const payload = { Groups: { NeedAck: rows.map((row, i) => ({ Subject: 'synthetic group ' + i, Children: [row] })),
        Acknowledged: [{ Subject: 'synthetic acknowledged group', Children: [ack] }] } };
      if (scenario === 'ambiguous') {
        payload.Groups.NeedAck[1].Children[0].State.Id = rows[0].State.Id;
        rows[2].State.AlertKey = 'synthetic.startup{malformed}';
      }
      const bodies = [];
      for (const section of ['NeedAck', 'Acknowledged']) {
        const root = doc.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
        const list = doc.createElement('div'); list.className = 'panel-group'; root.appendChild(list); doc.body.appendChild(root);
        for (const group of payload.Groups[section]) {
          const panel = doc.createElement('div'); panel.className = 'panel';
          panel.innerHTML = '<div class="panel-heading"><h4 class="panel-title"><span ng-bind="group.Subject"></span></h4></div>';
          panel.querySelector('[ng-bind]').textContent = group.Subject; list.appendChild(panel);
          const body = doc.createElement('div'); body.className = 'panel-body';
          const row = group.Children[0];
          body.innerHTML = '<div class="panel" ng-repeat="child in group.Children"><div class="panel-heading" ng-click="toggle()"><h4 class="panel-title">' +
            '<span ng-show="state.Id">#' + row.State.Id + '</span><span ng-bind="child.Subject || child.AlertKey">' + row.Subject +
            '</span><span ts-since="child.Ago">1m</span></h4></div></div>';
          bodies.push({ panel, body });
        }
      }
      win.fetch = () => new Promise(resolve => {
        requests.push(now);
        win.setTimeout(() => resolve({ ok: true, headers: { get: () => null },
          text: async () => JSON.stringify(scenario === 'invalid-payload' ? { Groups: { NeedAck: {} } } : payload)
        }), scenario === 'expired-fetch' ? 4100 : requests.length === 1 ? 790 : 812);
      });
      win.eval(sources.settings); win.eval(sources.alerts); win.eval(sources.severity); win.eval(sources.priority);
      const settings = JSON.parse(JSON.stringify(win.BosunHelperSettings.DEFAULTS));
      Object.keys(settings.features).forEach(key => { settings.features[key] = false; });
      Object.assign(settings.features, { priorityAlerts: true, soundNotifications: true, visualNewAlertNotifications: true });
      Object.assign(settings.preferences, { priorityCritical: false, priorityShowAcknowledged: true, priorityRuleAction: true });
      settings.priorityRules.exactAlertNames = ['synthetic.startup'];
      win.BosunHelperSettings = { ...win.BosunHelperSettings, createSettingsStore: () => ({
        start: () => new Promise(resolve => { releaseSettings = resolve; }), getSnapshot: () => settings, subscribe() {},
        update() { throw Error('Startup must not write settings'); }
      }) };
      win.BosunSilenceHiderSound = { createSound: () => ({ playNeedAckChime() { effects.sound++; } }) };
      win.BosunSilenceHiderNeedAckBaseline = { createNeedAckBaseline: () => ({ process() { effects.baseline++; } }) };
      win.BosunHelperNewAlertTracker = { createNewAlertTracker: () => ({ start() {}, add() { effects.add++; },
        reconcile(_payload, allowed) { if (allowed()) effects.reconcile++; } }) };
      win.BosunHelperLocalConfig = { bosunHosts: [win.location.host] };
      await advance(810); win.eval(sources.content);
      const hooks = win.__BosunHelperBrowserTest;
      const state = () => ({ ...hooks.startupState(), priority: doc.querySelectorAll('.bosun-priority-marker').length,
        note: doc.querySelectorAll('.bosun-has-note-icon').length });
      if (scenario === 'route' || scenario === 'route-return') {
        win.history.pushState({}, '', '/action?type=note'); hooks.handleRouteChange();
        if (scenario === 'route-return') win.history.pushState({}, '', '/');
      }
      if (scenario === 'pagehide') win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: false }));
      if (scenario === 'newer-snapshot') hooks.applyAlertsPayload({ Groups: { NeedAck: [], Acknowledged: [] } }, { source: 'follower' });
      if (!['late-settings', 'expired-settings'].includes(scenario)) { await advance(1020); releaseSettings(); await drain(); }
      await advance(1600); const beforeSettings = state();
      if (scenario === 'late-settings') { await advance(2000); releaseSettings(); await drain(); }
      if (scenario === 'expired-settings') { await advance(4900); releaseSettings(); await drain(); }
      if (scenario === 'expired-fetch') await advance(4910);
      const early = state(), earlyEffects = { ...effects }, earlyRequests = requests.slice();
      const leaseUnchanged = JSON.stringify(stored[leaseKey]) === originalLease;
      if (scenario === 'orphan') {
        if (early.priority !== 4) throw Error('FAIL-BEFORE: fresh prime at 1600ms, expected 4 Priority markers, actual ' + early.priority);
        for (let pass = 0; pass < 2; pass++) {
          bodies.forEach(({ panel, body }) => panel.appendChild(body)); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
          if (state().priority !== 8 || doc.querySelectorAll('.bosun-priority-action').length !== 4) {
            throw Error('Expanded prime identity/actions: ' + JSON.stringify({ state: state(), actions: doc.querySelectorAll('.bosun-priority-action').length }));
          }
          bodies.forEach(({ body }) => body.remove()); hooks.runDomRefreshPass({ preserveExistingOnNone: true });
          if (state().priority !== 4) throw Error('Collapsed prime markers');
        }
        hooks.setPreference('priorityShowAcknowledged', false);
        if (state().priority !== 4) throw Error('Retired Acknowledged preference must be ignored');
        hooks.setPreference('priorityShowAcknowledged', true);
        settings.priorityRules.exactAlertNames = [];
        hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
        if (state().priority !== 0 || state().note !== 3) throw Error('Prime rule removal must preserve Note');
        settings.priorityRules.exactAlertNames = ['synthetic.startup'];
        hooks.applySettingsSnapshot(settings, { changedPaths: ['priorityRules.exactAlertNames'] });
        await advance(15832);
      }
      if (scenario === 'active-peer') {
        await advance(16000);
        if (old.getRole() !== 'leader' || state().role !== 'follower') throw Error('Prime must not steal an active peer lease');
      }
      results[scenario] = { beforeSettings, early, earlyEffects, earlyRequests, leaseUnchanged,
        afterRefresh: state(), requests: requests.slice(), effects: { ...effects } };
      old.stop(); win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: false })); frame.remove();
    }
    return results;
  }).toString()})(${JSON.stringify(sources)})`);
  for (const scenario of ['orphan', 'active-peer', 'late-settings']) {
    assert.strictEqual(results[scenario].early.priority, 4, scenario + ': fresh prime must paint before lease expiry');
    assert.strictEqual(results[scenario].early.note, 3, scenario + ': NeedAck Note must paint from fresh prime');
    assert.strictEqual(results[scenario].early.owner, false);
    assert.strictEqual(results[scenario].early.role, 'follower');
    assert.deepStrictEqual(results[scenario].earlyEffects, { baseline: 0, sound: 0, add: 0, reconcile: 0, published: 1 });
    assert.deepStrictEqual(results[scenario].earlyRequests, [810]);
    assert.strictEqual(results[scenario].leaseUnchanged, true);
  }
  assert.strictEqual(results['late-settings'].beforeSettings.priority, 0);
  assert.strictEqual(results.orphan.afterRefresh.priority, 4);
  assert.strictEqual(results.orphan.afterRefresh.note, 3);
  assert.strictEqual(results.orphan.afterRefresh.owner, true);
  assert.deepStrictEqual(results.orphan.requests, [810, 15020]);
  assert.strictEqual(results.orphan.effects.baseline, 1);
  assert.strictEqual(results.orphan.effects.reconcile, 1);
  assert.deepStrictEqual(results.single.earlyRequests, [810], 'Leader must reuse the existing in-flight prime');
  assert.strictEqual(results.single.early.priority, 4);
  assert.strictEqual(results.single.earlyEffects.baseline, 1, 'Only normal coordinator acceptance may process baseline');
  for (const scenario of ['expired-settings', 'expired-fetch', 'newer-snapshot', 'route', 'route-return', 'pagehide', 'invalid-payload']) {
    assert.strictEqual(results[scenario].early.priority, 0, scenario + ': rejected prime must not paint');
  }
  assert.strictEqual(results.ambiguous.early.priority, 1, 'Only the independent Acknowledged group remains Priority');
  assert.strictEqual(results.ambiguous.early.note, 1, 'Duplicate IDs fail closed; a malformed rule key must not change independent Note');
  console.log('Prime marker startup browser regression passed (1600ms instead of 15832ms)');
}

  return runPrimeMarkerStartupAssertions;
};
