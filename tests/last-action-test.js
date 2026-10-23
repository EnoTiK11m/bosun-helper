'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/bosun/last-action.js'), 'utf8');
const effects = [];
const context = {
  document: new Proxy({}, { get(_target, name) { throw new Error(`Unexpected DOM access: ${String(name)}`); } }),
  setTimeout() { throw new Error('Unexpected timer'); },
  setInterval() { throw new Error('Unexpected interval'); },
  fetch() { throw new Error('Unexpected request'); }
};
vm.runInNewContext(source, context, { filename: 'src/bosun/last-action.js' });
assert.deepStrictEqual(Object.keys(context.BosunHelperLastAction), ['createLastActionEnhancements']);
const api = context.BosunHelperLastAction.createLastActionEnhancements({
  isFeatureEnabled(name) { effects.push(name); return false; },
  copyTextToClipboard() { throw new Error('Unexpected clipboard write'); },
  flashCopyButtonState() { throw new Error('Unexpected feedback'); },
  copyLastActionButtonClass: 'bosun-copy-last-action-btn',
  lastActionLinkClass: 'bosun-last-action-link',
  lastActionTimeTextClass: 'bosun-last-action-time-text',
  lastActionMessageSelector: '[ng-show="state.LastAction.Message"], [ng-bind="state.LastAction.Message"]'
});
assert.deepStrictEqual(effects, [], 'Factory must not install DOM handlers or start work');
api.ensureLastActionCopyButtons();
assert.deepStrictEqual(effects, ['lastActionEnhancements']);
assert.strictEqual(api.getLastActionMessageText(null), '');
assert.strictEqual(api.getLastActionMessageText({ innerText: ': first\r\nsecond\rthird ', textContent: 'wrong' }),
  'first\nsecond\nthird');
assert.strictEqual(api.getLastActionMessageText({ textContent: ': fallback ' }), 'fallback');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const entries = manifest.content_scripts.filter(entry => entry.js?.includes('src/bosun/last-action.js'));
assert.strictEqual(entries.length, 1);
const entry = entries[0];
assert.notStrictEqual(entry.world, 'MAIN');
assert.strictEqual(entry.run_at, 'document_end');
assert.strictEqual(entry.js.filter(file => file === 'src/bosun/last-action.js').length, 1);
assert.ok(entry.js.indexOf('src/bosun/last-action.js') < entry.js.indexOf('src/bosun/content.js'));
console.log('Last Action tests passed (inert factory, feature gate, text normalization, manifest provider order).');
