'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const key = 'bosunAlertMarkerCacheV1';

function loadFactory() {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/alert-marker-cache.js'), 'utf8'), context);
  return context.BosunHelperAlertMarkerCache.createAlertMarkerCache;
}

function harness(create = loadFactory()) {
  let now = 1000000, nextTimer = 0, restored = 0, fault = '';
  let maps = { first: new Map(), second: new Map() };
  const timers = new Map(), storage = new Map(), trace = [];
  const cache = create({
    window: { get sessionStorage() {
      if (fault === 'access') throw Error('blocked');
      return {
        getItem(name) { if (fault === 'read') throw Error('read'); return storage.get(name) || null; },
        setItem(name, value) { if (fault === 'write') throw Error('quota'); storage.set(name, value); trace.push(['write', name, JSON.parse(value)]); },
        removeItem(name) { if (fault === 'remove') throw Error('remove'); storage.delete(name); trace.push(['remove', name]); }
      };
    } },
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); trace.push(['timer', delay]); return id; },
    clearTimeout(id) { assert.ok(timers.delete(id)); trace.push(['cancel']); },
    getAlertMarkerCacheMaps: () => maps,
    onRestored() { restored++; },
    reportDiagnostics(event, message) { trace.push(['error', event, message]); }
  });
  return {
    cache, timers, storage, trace,
    get maps() { return maps; }, set maps(value) { maps = value; },
    get now() { return now; }, set now(value) { now = value; },
    get restored() { return restored; }, set fault(value) { fault = value; },
    seed(overrides = {}) { storage.set(key, JSON.stringify({ version: 2, savedAt: now, maps: { first: [['a', true]], second: [[7, 2]] }, ...overrides })); },
    fire() {
      assert.strictEqual(timers.size, 1);
      const [id, timer] = [...timers][0]; timers.delete(id); now += timer.delay; timer.callback();
    }
  };
}

function runContract(create = loadFactory()) {
  const traces = [];
  {
    const first = harness(create), second = harness(create);
    first.cache.persistAlertMarkerCacheToSession();
    second.cache.flushPending();
    assert.strictEqual(first.timers.size, 1, 'Instances must not share lifecycle state');
    assert.strictEqual(second.trace.length, 0);
    first.cache.flushPending();
    assert.strictEqual(second.storage.size, 0);
    traces.push(first.trace, second.trace);
  }
  {
    const h = harness(create), originalMaps = h.maps;
    assert.deepStrictEqual(h.trace, [], 'Factory must remain inert');
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), false);
    h.seed(); h.maps.first.set('old', false);
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), true);
    assert.strictEqual(h.maps, originalMaps);
    assert.deepStrictEqual([...h.maps.first], [['a', true]]);
    assert.deepStrictEqual([...h.maps.second], [[7, 2]]);
    assert.strictEqual(h.restored, 1);
    h.cache.flushAlertMarkerCacheToSession();
    assert.strictEqual(h.trace.length, 0, 'Restored unchanged data must not be rewritten');
    h.now += 300000; h.cache.flushAlertMarkerCacheToSession();
    assert.strictEqual(h.trace.length, 1, 'Unchanged cache must renew after five minutes');
    traces.push(h.trace);
  }
  for (const change of [
    { version: 1 }, { savedAt: 399999 }, { savedAt: 1000001 }, { savedAt: 'invalid' },
    { maps: null }, { maps: { first: [] } },
    { maps: { first: [['good', true]], second: [['broken']] } },
    { maps: { first: [['x'.repeat(1001), true]], second: [] } },
    { maps: { first: [['x', 'true']], second: [] } },
    { maps: { first: [[{}, true]], second: [] } }
  ]) {
    const h = harness(create); h.seed(change); h.maps.first.set('unchanged', true);
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), false);
    assert.deepStrictEqual([...h.maps.first], [['unchanged', true]], 'Invalid cache must not partially mutate live maps');
    assert.strictEqual(h.restored, 0);
    assert.strictEqual(h.storage.has(key), false);
    traces.push(h.trace);
  }
  for (const age of [0, 600000]) {
    const h = harness(create); h.seed({ savedAt: h.now - age });
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), true, 'TTL boundaries must remain inclusive');
  }
  for (const raw of ['{', 'x'.repeat(5 * 1024 * 1024 + 1)]) {
    const h = harness(create); h.storage.set(key, raw);
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), false);
    assert.strictEqual(h.storage.has(key), false);
    traces.push(h.trace);
  }
  {
    const h = harness(create);
    h.maps.first.set('x'.repeat(1001), true); h.maps.first.set('text', 'bad');
    h.maps.first.set('nan', NaN); h.maps.first.set('infinite', Infinity); h.maps.first.set({}, true);
    h.maps.first.set('x'.repeat(1000), false); h.maps.first.set(3, 0);
    for (let i = 0; i < 2100; i++) h.maps.first.set('item-' + i, true);
    h.cache.flushAlertMarkerCacheToSession();
    const saved = JSON.parse(h.storage.get(key));
    assert.strictEqual(saved.maps.first.length, 2000);
    assert.deepStrictEqual(saved.maps.first.slice(0, 2), [['x'.repeat(1000), false], [3, 0]]);
    assert.strictEqual(h.maps.first.size, 2107, 'Serialization must not truncate live indexes');
    h.seed({ maps: { first: Array.from({ length: 2001 }, (_, i) => [i, true]), second: [] } });
    assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), true);
    assert.strictEqual(h.maps.first.size, 2000);
    assert.strictEqual(h.maps.first.has(2000), false);
    traces.push(h.trace);
  }
  {
    const h = harness(create);
    h.cache.persistAlertMarkerCacheToSession(); h.cache.persistAlertMarkerCacheToSession();
    assert.strictEqual(h.timers.size, 1);
    assert.strictEqual([...h.timers.values()][0].delay, 5000);
    h.maps = { first: new Map([['latest', true]]), second: new Map() };
    h.fire();
    assert.deepStrictEqual(JSON.parse(h.storage.get(key)).maps.first, [['latest', true]], 'Deferred write must use current maps');
    h.cache.persistAlertMarkerCacheToSession();
    assert.strictEqual([...h.timers.values()][0].delay, 30000);
    h.maps.first.set('before-cleanup', false);
    h.cache.flushPending();
    assert.strictEqual(h.timers.size, 0);
    assert.strictEqual(JSON.parse(h.storage.get(key)).maps.first.length, 2);
    const traceCount = h.trace.length;
    h.cache.flushPending();
    assert.strictEqual(h.trace.length, traceCount, 'Cleanup without pending write must remain inert');
    h.cache.persistAlertMarkerCacheToSession(); h.fire();
    assert.strictEqual(h.timers.size, 0, 'Cache must remain usable after persisted pagehide');
    traces.push(h.trace);
  }
  for (const fault of ['access', 'read', 'remove', 'write']) {
    const h = harness(create); h.seed({ version: 1 }); h.fault = fault;
    if (fault === 'write') {
      h.cache.persistAlertMarkerCacheToSession(); h.fire();
      assert.strictEqual(h.timers.size, 0);
      assert.ok(h.trace.some(row => row[1] === 'alert-marker-cache-save-failed'));
      h.fault = ''; h.cache.persistAlertMarkerCacheToSession();
      assert.strictEqual([...h.timers.values()][0].delay, 30000, 'Failed attempts must preserve throttling');
      h.fire(); assert.ok(h.storage.has(key));
    } else {
      assert.strictEqual(h.cache.restoreAlertMarkerCacheFromSession(), false);
      assert.strictEqual(h.restored, 0);
      assert.ok(h.trace.some(row => row[1] === 'alert-marker-cache-restore-failed'));
    }
    traces.push(h.trace);
  }
  return traces;
}

if (require.main === module) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const file = 'src/bosun/alert-marker-cache.js';
  const entries = manifest.content_scripts.filter(entry => entry.js?.includes(file));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].js.filter(name => name === file).length, 1);
  assert.ok(entries[0].js.indexOf(file) < entries[0].js.indexOf('src/bosun/content.js'));
  assert.ok(!entries[0].all_frames);
  runContract();
  console.log('Alert marker cache tests passed');
}

module.exports = { harness, runContract };
