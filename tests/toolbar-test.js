'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const context = {};
for (const file of ['toolbar-status', 'toolbar']) {
  vm.runInNewContext(fs.readFileSync(path.join(root, `src/bosun/${file}.js`), 'utf8'), context);
}
let nextId = 0;
const timers = new Map(), cancelled = [], writes = [], classes = new Set(), attributes = new Map();
const node = {
  classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
  setAttribute(name, value) { attributes.set(name, value); },
  removeAttribute(name) { attributes.delete(name); }
};
const state = { toolbarStatusSource: '', toolbarStatusLevel: '', toolbarStatusMessage: '', toolbarStatusTitle: '', toolbarStatusTimer: null };
let mounted = true;
const status = context.BosunHelperToolbarStatus.createToolbarStatus({
  state, document: { getElementById: () => mounted ? node : null },
  TOP_BAR_STATUS_ID: 'status', STATUS_MESSAGE_TTL_MS: 8000,
  setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { cancelled.push(id); timers.delete(id); }
});
assert.strictEqual(timers.size, 0, 'Factory must not start timers');
status.setToolbarStatus('first', 'warning', 'warn', { ttlMs: 1, title: 'details' });
const firstId = state.toolbarStatusTimer, stale = timers.get(firstId).callback;
assert.strictEqual(timers.get(firstId).delay, 1000);
assert.strictEqual(node.textContent, 'warning');
assert.strictEqual(node.tabIndex, 0);
assert.ok(attributes.get('aria-label').includes('details'));
assert.ok(classes.has('is-warn'));
status.setToolbarStatus('second', 'storage failed', 'error', { sticky: true });
assert.ok(cancelled.includes(firstId));
assert.strictEqual(state.toolbarStatusTimer, null);
stale();
assert.strictEqual(state.toolbarStatusSource, 'second', 'A stale source must not clear the replacement');
status.clearToolbarStatus('first');
assert.strictEqual(node.textContent, 'storage failed');
state.toolbarStatusMessage = 'external current message';
status.updateToolbarStatus();
assert.strictEqual(node.textContent, 'external current message', 'Rendering must read current shared state');
status.clearToolbarStatus('second');
assert.strictEqual(node.hidden, true);
assert.strictEqual(attributes.has('aria-label'), false);
assert.strictEqual(attributes.has('tabindex'), false);
status.setToolbarStatus('third', 'timed');
const thirdId = state.toolbarStatusTimer;
assert.strictEqual(timers.get(thirdId).delay, 8000);
timers.get(thirdId).callback();
assert.strictEqual(state.toolbarStatusMessage, '');
assert.strictEqual(state.toolbarStatusTimer, null);
mounted = false;
status.updateToolbarStatus();

const viewState = { showSilenced: false, soundAlertsEnabled: false, autoRefreshIdleSeconds: 60, lastUserActivityTs: 500 };
const view = context.BosunHelperToolbar.createToolbar({
  state: viewState, document: { getElementById: () => null },
  Date: { now: () => 1500 }, activityApi: null,
  saveState: () => writes.push('save'), applyVisibility: () => writes.push('visibility'),
  markUserActivity: () => writes.push('activity'), saveSoundAlertsState: () => writes.push('sound'),
  normalizeAutoRefreshIdleSeconds: value => Math.max(10, Number(value)),
  saveAutoRefreshState: () => writes.push('auto')
});
assert.deepStrictEqual(writes, [], 'Toolbar factory must be inert');
const events = [];
view.handleToggleClick({ preventDefault: () => events.push('default'), stopPropagation: () => events.push('bubble'), stopImmediatePropagation: () => events.push('immediate') });
assert.deepStrictEqual(events, ['default', 'bubble', 'immediate']);
assert.strictEqual(viewState.showSilenced, true);
assert.deepStrictEqual(writes, ['save', 'visibility']);
view.handleSoundAlertsToggle();
assert.strictEqual(viewState.soundAlertsEnabled, true);
assert.deepStrictEqual(writes.slice(-2), ['activity', 'sound']);
view.handleAutoRefreshIdleInput({ target: { value: '14.7' } });
assert.strictEqual(viewState.autoRefreshIdleSeconds, 15);
view.handleAutoRefreshIdleInput({ target: { value: 'invalid' } });
assert.strictEqual(viewState.autoRefreshIdleSeconds, 15);
view.handleAutoRefreshIdleChange({ target: { value: '3' } });
assert.strictEqual(viewState.autoRefreshIdleSeconds, 10);
assert.strictEqual(view.getAutoRefreshRemainingSeconds(), 9);
assert.deepStrictEqual(writes.slice(-2), ['activity', 'auto']);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const file of ['src/bosun/toolbar.js', 'src/bosun/toolbar-status.js']) {
  const entries = manifest.content_scripts.filter(entry => entry.js?.includes(file));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].js.filter(value => value === file).length, 1);
  assert.strictEqual(entries[0].run_at, 'document_end');
  assert.notStrictEqual(entries[0].world, 'MAIN');
  assert.ok(entries[0].js.indexOf(file) < entries[0].js.indexOf('src/bosun/content.js'));
}
console.log('Toolbar tests passed (inert factories, live state, commands, status source/TTL/sticky/ARIA and provider order).');
