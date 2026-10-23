'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {
  const root = path.resolve(__dirname, '..');
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/bosun/copy.js'), 'utf8'), context);
  const writes = [], fallback = [], timers = new Map(), cleared = [], feedback = [];
  let sequence = 0, rejectClipboard = false, execResult = true, throwExec = false;
  const navigator = { clipboard: { async writeText(text) {
    if (rejectClipboard) throw new Error('Synthetic clipboard denial');
    writes.push(text);
  } } };
  const document = {
    createElement(type) {
      assert.strictEqual(type, 'textarea');
      return { style: {}, setAttribute(name, value) { fallback.push([name, value]); },
        select() { fallback.push('select'); }, remove() { fallback.push('remove'); } };
    },
    body: { appendChild(node) {
      assert.strictEqual(node.style.position, 'fixed');
      assert.strictEqual(node.style.left, '-9999px');
      fallback.push(node.value);
    } },
    execCommand(command) { assert.strictEqual(command, 'copy'); if (throwExec) throw new Error('Synthetic failure'); return execResult; },
    querySelectorAll() { throw new Error('Feature-off must not scan DOM'); }
  };
  const api = context.BosunHelperCopy.createCopyEnhancements({
    window: {}, document, navigator,
    setTimeout(callback, milliseconds) { const id = ++sequence; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { cleared.push(id); timers.delete(id); },
    isFeatureEnabled: () => false,
    clearToolbarStatus: source => feedback.push(source),
    getAcknowledgedPanels() { throw new Error('Unexpected panel scan'); },
    copyButtonClass: 'bosun-copy-alert-btn', copyAllButtonClass: 'bosun-copy-all-alerts-btn'
  });
  assert.strictEqual(timers.size, 0, 'Factory must be inert');
  api.ensureCopyButtons();
  assert.strictEqual(await api.copyTextToClipboard(''), false);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(await api.copyTextToClipboard('native text'), true);
  assert.deepStrictEqual(writes, ['native text']);
  rejectClipboard = true;
  assert.strictEqual(await api.copyTextToClipboard('fallback text'), true);
  assert.deepStrictEqual(fallback, [['readonly', ''], 'fallback text', 'select', 'remove']);
  execResult = false;
  assert.strictEqual(await api.copyTextToClipboard('denied'), false);
  throwExec = true;
  assert.strictEqual(await api.copyTextToClipboard('error'), false);
  const button = { dataset: {}, title: 'original title', textContent: 'Копировать' };
  api.flashCopyButtonState(button, true);
  const firstId = Number(button.dataset.flashTimer);
  assert.strictEqual(timers.get(firstId).milliseconds, 1200);
  api.flashCopyButtonState(button, false, 'custom error');
  assert.deepStrictEqual(cleared, [firstId]);
  const secondId = Number(button.dataset.flashTimer);
  assert.strictEqual(timers.get(secondId).milliseconds, 2500);
  assert.strictEqual(button.title, 'custom error');
  timers.get(secondId).callback();
  assert.deepStrictEqual(button, { dataset: {}, title: 'original title', textContent: 'Копировать' });
  assert.deepStrictEqual(feedback, ['action-feedback', 'action-feedback']);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const entries = manifest.content_scripts.filter(entry => entry.js?.includes('src/bosun/copy.js'));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].js.filter(file => file === 'src/bosun/copy.js').length, 1);
  assert.notStrictEqual(entries[0].world, 'MAIN');
  assert.strictEqual(entries[0].run_at, 'document_end');
  assert.ok(entries[0].js.indexOf('src/bosun/copy.js') < entries[0].js.indexOf('src/bosun/content.js'));
  console.log('Copy tests passed (clipboard fallback/errors, feedback timers, inert factory, feature-off and manifest order).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
