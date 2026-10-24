'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSnapshotStateAssertions({ client, contentSource, alertsDataSource }) {
  const result = await evaluate(client, `(async () => {
    const key = 'bosunAlertMarkerCacheV1', previous = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    const frame = document.createElement('iframe'); frame.src = '/';
    await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
    try {
      const win = frame.contentWindow, timers = new Map(); let next = 0;
      win.setTimeout = (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; };
      win.clearTimeout = id => timers.delete(id);
      win.fetch = () => new Promise(() => {});
      win.BosunHelperLocalConfig = { bosunHosts: [win.location.host] };
      win.BosunHelperSettings = { createSettingsStore: () => ({ start: () => new Promise(() => {}), subscribe() {} }) };
      win.eval(${JSON.stringify(alertsDataSource)});
      win.eval(${JSON.stringify(contentSource)});
      const hooks = win.__BosunHelperBrowserTest, owner = hooks.snapshotStateForTest();
      const references = Object.fromEntries(Object.entries(owner).filter(([, value]) => value instanceof win.Map || value instanceof win.Set));
      const identity = () => Object.entries(references).every(([name, value]) => hooks.snapshotStateForTest()[name] === value);
      const generations = () => [owner.alertsPayloadApplyVersion, owner.alertMarkerIndexGeneration];
      const states = [generations()];
      const child = (id, host) => ({ Alert: 'synthetic.state', AlertKey: 'synthetic.state{host=' + host + '}', Subject: 'synthetic child',
        State: { Id: id, CurrentStatus: 'warning', Actions: [{ Type: 'Note', User: 'synthetic', Message: 'synthetic note' }] } });
      const payload = { Groups: { NeedAck: [{ Subject: 'synthetic group', Children: [child(7, 'one')] }], Acknowledged: [] } };
      hooks.rebuildAlertDataIndex(payload); states.push(generations());
      const firstContents = JSON.stringify([...owner.childHasNoteById]);
      const firstNote = owner.childHasNoteById.get('7') === true;
      hooks.rebuildAlertDataIndex(payload); states.push(generations());
      const repeated = firstContents === JSON.stringify([...owner.childHasNoteById]);
      hooks.applyAlertsPayload(payload, { source: 'follower' }); states.push(generations());
      const payloadReference = owner.latestAlertsPayload === payload;
      const follower = owner.latestAlertsTrackerOwner === false;
      hooks.seedMarkerCache('cached-alert', 'note');
      hooks.clearMarkerState();
      const restored = hooks.restoreMarkerCache(); states.push(generations());
      const beforeHide = { payload: owner.latestAlertsPayload, ready: owner.alertDataIndexReady, generation: generations() };
      const hides = [];
      for (let i = 0; i < 2; i++) {
        win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
        win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
        hides.push(beforeHide.payload === owner.latestAlertsPayload && beforeHide.ready === owner.alertDataIndexReady &&
          JSON.stringify(beforeHide.generation) === JSON.stringify(generations()) && identity());
      }
      win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: false }));
      const ordinaryHide = JSON.stringify(beforeHide.generation) === JSON.stringify(generations()) && beforeHide.payload === owner.latestAlertsPayload;
      const duplicate = { Groups: { NeedAck: [{ Subject: 'conflicting group', Children: [child(8, 'one'), child(8, 'two')] }], Acknowledged: [] } };
      hooks.rebuildAlertDataIndex(duplicate); states.push(generations());
      const ambiguous = owner.ambiguousChildIds.has('8') && !owner.childHasNoteById.has('8');
      const query = hooks.getGrafanaQueryForPanel(win.document.createElement('div'));
      win.history.pushState({}, '', '/action?type=ack'); hooks.handleRouteChange(); states.push(generations());
      const clear = owner.latestAlertsPayload === null && owner.alertDataIndexReady === false;
      return { states, references: Object.keys(references).length, identity: identity(), firstNote, repeated, payloadReference, follower,
        restored, hides, ordinaryHide, ambiguous, query, clear };
    } finally {
      frame.remove(); if (previous === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, previous);
    }
  })()`);
  assert.deepStrictEqual(result.states, [[0, 0], [0, 1], [0, 2], [1, 3], [1, 3], [1, 4], [2, 5]]);
  assert.strictEqual(result.references, 24);
  for (const name of ['identity', 'firstNote', 'repeated', 'payloadReference', 'follower', 'ordinaryHide', 'ambiguous', 'clear']) assert.strictEqual(result[name], true, name);
  assert.deepStrictEqual(result.restored, { restored: true, note: true, warning: false });
  assert.deepStrictEqual(result.hides, [true, true]);
  assert.strictEqual(result.query, '', 'Unproven editor/group identity must not expose a Grafana action');
  return result;
};
