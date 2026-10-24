'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const scalars = ['priorityRuleIdentityIndex', 'alertsPayloadApplyVersion', 'alertDataIndexReady',
  'alertMarkerIndexGeneration', 'latestAlertsPayload', 'modelGroupSnapshotIndexes',
  'latestAlertsTrackerOwner', 'acknowledgedPriorityIndex'];
const collections = ['childOldNoNoteById', 'childOldNoNoteByKey', 'childHasNoteById', 'childHasNoteByKey',
  'childHasUserCommentById', 'childHasUserCommentByKey', 'childPriorityById', 'childPriorityByKey',
  'ambiguousChildIds', 'ambiguousChildKeys', 'groupHasOldNoNoteByKey', 'groupHasAnyNoteByKey',
  'groupHasPriorityByKey', 'groupHasAnyUserCommentByKey', 'groupHasOldNoNoteBySubject',
  'groupHasAnyNoteBySubject', 'groupHasPriorityBySubject', 'groupHasAnyUserCommentBySubject',
  'groupHasStrongIdentityBySubject', 'groupCountBySubject', 'grafanaQueryById', 'grafanaQueryByKey',
  'ambiguousGrafanaIds', 'ambiguousGrafanaKeys'];
const plain = value => JSON.parse(JSON.stringify(value));

function createHarness(source = fs.readFileSync(path.join(root, 'src/bosun/content.js'), 'utf8')) {
  let fault = '', sequence = 0;
  const trace = [], storage = new Map(), timers = new Map();
  const context = {
    console: { warn() {} },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: { location: { host: 'unused.invalid', hostname: 'unused.invalid', href: 'https://unused.invalid/', origin: 'https://unused.invalid', pathname: '/' },
      sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } },
    document: { readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    __phase(name) { trace.push(name); if (fault === name) throw Error('synthetic ' + name); },
    BosunHelperPriorityAlerts: { buildRuleIdentityIndex(payload) { context.__phase('rule'); return { id: payload.id || 'empty' }; } },
    BosunHelperGroupIdentity: { buildSnapshotIndexes(payload) { context.__phase('model'); return { id: payload.id || 'empty' }; } },
    BosunSilenceHiderAlertsData: { createAlertsData: () => ({ rebuildAlertDataIndex(payload, helpers, section = 'NeedAck') {
      context.__phase('domain:' + section);
      const result = {};
      for (const name of collections.slice(0, 20)) {
        result[name] = name.startsWith('ambiguous') ? new Set([payload.id || 'empty']) : new Map([[payload.id || 'empty', name === 'groupCountBySubject' ? 2 : true]]);
      }
      if (fault === 'fill') result.childHasNoteById = {
        *[Symbol.iterator]() { yield ['partial', true]; context.__phase('fill'); }
      };
      return result;
    } }) }
  };
  for (const file of ['snapshot-state', 'alert-marker-cache']) {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/' + file + '.js'), 'utf8'), context);
  }
  const stateName = source.includes('const snapshotState =') ? 'snapshotState.' : '';
  const hook = `
    const originalGrafanaRebuild = rebuildGrafanaQueryIndex;
    rebuildGrafanaQueryIndex = (...args) => { __phase('grafana'); return originalGrafanaRebuild(...args); };
    globalThis.__snapshotTest = {
      rebuildAlertDataIndex, applyAlertsPayload, clearAlertDerivedState, restoreAlertMarkerCacheFromSession,
      flushAlertMarkerCacheToSession,
      collections: { ${collections.join(', ')} },
      read() { return { ${scalars.map(name => name + ': ' + stateName + name).join(', ')},
        ruleGraphLifecycleGeneration, visualTrackerLifecycleGeneration, markerPresentationLifecycle }; },
      enablePriority(value) { settingsSnapshot.features.priorityAlerts = value; },
      settingsRebuild() { rebuildAlertDataIndex(${stateName}latestAlertsPayload); }
    };
  `;
  const closing = source.lastIndexOf('})();'); assert.ok(closing > 0);
  vm.runInNewContext(source.slice(0, closing) + hook + source.slice(closing), context);
  const api = context.__snapshotTest;
  const references = { ...api.collections };
  return {
    api, trace, timers, storage,
    set fault(value) { fault = value; },
    read() { return plain({ ...api.read(), collections: Object.fromEntries(Object.entries(api.collections).map(([name, value]) => [name, [...value]])) }); },
    assertReferences() { for (const [name, value] of Object.entries(references)) assert.strictEqual(api.collections[name], value, name + ': collection identity changed'); }
  };
}

function runContract(source) {
  const traces = [], h = createHarness(source);
  assert.deepStrictEqual(h.trace, [], 'Construction must not invoke domain builders');
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.storage.size, 0);
  assert.strictEqual(h.api.read().alertsPayloadApplyVersion, 0);
  assert.strictEqual(h.api.read().alertMarkerIndexGeneration, 0);
  h.api.enablePriority(true);
  for (const id of ['first', 'second', 'second']) {
    const before = h.api.read();
    assert.strictEqual(h.api.rebuildAlertDataIndex({ id }), undefined);
    const after = h.api.read();
    assert.strictEqual(after.alertsPayloadApplyVersion, before.alertsPayloadApplyVersion);
    assert.strictEqual(after.alertMarkerIndexGeneration, before.alertMarkerIndexGeneration + 1);
    assert.deepStrictEqual(plain([...h.api.collections.childHasNoteById]), [[id, true]]);
    h.assertReferences(); traces.push(h.read());
  }
  assert.deepStrictEqual(h.trace.slice(0, 5), ['rule', 'domain:NeedAck', 'domain:Acknowledged', 'model', 'grafana']);
  const beforeApply = h.api.read();
  const payload = { id: 'snapshot' };
  assert.strictEqual(h.api.applyAlertsPayload(payload, { source: 'follower' }), undefined);
  const afterApply = h.api.read();
  assert.strictEqual(afterApply.alertsPayloadApplyVersion, beforeApply.alertsPayloadApplyVersion + 1);
  assert.strictEqual(afterApply.alertMarkerIndexGeneration, beforeApply.alertMarkerIndexGeneration + 1);
  assert.strictEqual(afterApply.latestAlertsTrackerOwner, false);
  assert.strictEqual(afterApply.latestAlertsPayload.id, 'snapshot');
  assert.strictEqual(afterApply.latestAlertsPayload, payload, 'Snapshot must not be cloned');
  h.api.settingsRebuild();
  assert.strictEqual(h.api.read().alertsPayloadApplyVersion, afterApply.alertsPayloadApplyVersion);
  assert.strictEqual(h.api.read().alertMarkerIndexGeneration, afterApply.alertMarkerIndexGeneration + 1);
  h.api.flushAlertMarkerCacheToSession();
  h.api.collections.childHasNoteById.clear();
  const beforeRestore = h.api.read();
  assert.strictEqual(h.api.restoreAlertMarkerCacheFromSession(), true);
  assert.strictEqual(h.api.read().alertsPayloadApplyVersion, beforeRestore.alertsPayloadApplyVersion);
  assert.strictEqual(h.api.read().alertMarkerIndexGeneration, beforeRestore.alertMarkerIndexGeneration);
  h.assertReferences(); traces.push(h.read());
  const beforeRepeat = h.api.read();
  h.api.applyAlertsPayload(payload, { source: 'direct' });
  assert.strictEqual(h.api.read().alertsPayloadApplyVersion, beforeRepeat.alertsPayloadApplyVersion + 1);
  assert.strictEqual(h.api.read().alertMarkerIndexGeneration, beforeRepeat.alertMarkerIndexGeneration + 1);
  assert.strictEqual(h.api.read().latestAlertsTrackerOwner, true);
  assert.strictEqual(h.api.read().latestAlertsPayload, payload);
  const beforeClear = h.api.read();
  assert.strictEqual(h.api.clearAlertDerivedState(), undefined);
  const afterClear = h.api.read();
  assert.strictEqual(afterClear.alertsPayloadApplyVersion, beforeClear.alertsPayloadApplyVersion + 1);
  assert.strictEqual(afterClear.alertMarkerIndexGeneration, beforeClear.alertMarkerIndexGeneration + 1);
  assert.strictEqual(afterClear.alertDataIndexReady, false);
  assert.strictEqual(afterClear.latestAlertsPayload, null);
  assert.strictEqual(afterClear.modelGroupSnapshotIndexes.id, 'empty', 'Cleanup must retain the original rebuild result');
  h.assertReferences(); traces.push(h.read());
  for (const phase of ['rule', 'domain:NeedAck', 'fill', 'domain:Acknowledged', 'model', 'grafana']) {
    const f = createHarness(source); f.api.enablePriority(true);
    f.api.rebuildAlertDataIndex({ id: 'old' }); f.trace.length = 0;
    const before = f.api.read(); f.fault = phase;
    assert.throws(() => f.api.rebuildAlertDataIndex({ id: 'new' }), /synthetic/);
    const after = f.api.read();
    assert.strictEqual(after.alertsPayloadApplyVersion, before.alertsPayloadApplyVersion);
    assert.strictEqual(after.alertMarkerIndexGeneration, before.alertMarkerIndexGeneration + (['model', 'grafana'].includes(phase) ? 1 : 0));
    assert.strictEqual(after.priorityRuleIdentityIndex.id, phase === 'rule' ? 'old' : 'new');
    assert.strictEqual(after.modelGroupSnapshotIndexes.id, phase === 'grafana' ? 'new' : 'old');
    assert.strictEqual([...f.api.collections.childHasNoteById][0][0], phase === 'fill' ? 'partial' : ['rule', 'domain:NeedAck'].includes(phase) ? 'old' : 'new');
    if (phase === 'fill') assert.strictEqual(f.api.collections.groupHasAnyNoteByKey.size, 0, 'Interrupted fill must preserve the original partial state');
    if (phase !== 'grafana') assert.strictEqual(after.modelGroupSnapshotIndexes, before.modelGroupSnapshotIndexes);
    f.assertReferences(); traces.push({ phase, trace: f.trace.slice(), state: f.read() });
    f.fault = ''; f.api.rebuildAlertDataIndex({ id: 'recovered' });
    f.assertReferences(); assert.strictEqual([...f.api.collections.childHasNoteById][0][0], 'recovered');
    const cold = createHarness(source); cold.api.enablePriority(true); cold.fault = phase;
    assert.throws(() => cold.api.rebuildAlertDataIndex({ id: 'initial' }), /synthetic/);
    assert.strictEqual(cold.api.read().alertDataIndexReady, ['model', 'grafana'].includes(phase), 'Initial failure must preserve the exact ready transition');
    traces.push({ phase, initialFailure: cold.read() });
  }
  return traces;
}

if (require.main === module) {
  const context = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/snapshot-state.js'), 'utf8'), context);
  const create = context.BosunHelperSnapshotState.createSnapshotState;
  const first = create({ Map, Set }), second = create({ Map, Set });
  assert.strictEqual(Object.keys(first).length, 32);
  for (const name of collections) {
    assert.notStrictEqual(first[name], second[name]);
    assert.throws(() => { first[name] = new Map(); }, TypeError);
  }
  first.alertsPayloadApplyVersion++;
  assert.strictEqual(first.alertMarkerIndexGeneration, 0);
  assert.strictEqual(second.alertsPayloadApplyVersion, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const file = 'src/bosun/snapshot-state.js', entries = manifest.content_scripts.filter(entry => entry.js?.includes(file));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].js.filter(value => value === file).length, 1);
  assert.ok(entries[0].js.indexOf(file) < entries[0].js.indexOf('src/bosun/content.js'));
  assert.strictEqual(entries[0].run_at, 'document_end');
  assert.ok(!entries[0].all_frames);
  runContract();
  console.log('Snapshot state tests passed (references, independent generations, repeated updates, restore/cleanup and six error stages).');
}

module.exports = { createHarness, runContract, collections, scalars };
