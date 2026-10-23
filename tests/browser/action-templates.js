'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runActionTemplateScenarios({ client, focusedAuditCase, actionSource }) {
  const actionResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/action?type=note');
    document.body.innerHTML = '<div id="action-host"><textarea id="old-message"></textarea></div>';
    ${actionSource}
    const api = BosunHelperActionTemplates.createActionTemplates({
      isActionPage: () => true,
      templatesByType: { note: ['browser template'] }
    });
    api.refresh();
    const oldTextarea = document.querySelector('#old-message');
    const replacement = document.createElement('textarea');
    replacement.id = 'new-message';
    const events = [];
    for (const name of ['input', 'change', 'blur']) {
      replacement.addEventListener(name, () => events.push(name));
    }
    oldTextarea.replaceWith(replacement);
    document.querySelector('.bosun-action-template-btn').click();
    return {
      oldValue: oldTextarea.value,
      replacementValue: replacement.value,
      events,
      focused: document.activeElement === replacement,
      selectionAtEnd: replacement.selectionStart === replacement.value.length &&
        replacement.selectionEnd === replacement.value.length,
      wrapperCount: document.querySelectorAll('.bosun-action-templates').length,
      wrapperBeforeReplacement: replacement.previousElementSibling?.classList.contains('bosun-action-templates') === true
    };
  })()`);
  assert.deepStrictEqual(actionResult, {
    oldValue: '',
    replacementValue: 'browser template',
    events: ['input', 'change', 'blur'],
    focused: true,
    selectionAtEnd: true,
    wrapperCount: 1,
    wrapperBeforeReplacement: true
  });

  const templateSettingsResult = await evaluate(client, `(() => {
    document.body.innerHTML = '<div id="settings-host"><textarea id="settings-message"></textarea></div>';
    const storageData = {
      'testTemplates:note': [' custom ', '', 'custom', 'second'],
      'testTemplates:ack': ['saved ack'],
      'testTemplates:close': ['saved close']
    };
    const storage = {
      get(keys, callback) {
        const result = {};
        for (const key of keys) result[key] = storageData[key];
        callback(result);
      },
      set(values, callback) { Object.assign(storageData, values); callback?.(); },
      remove(keys, callback) { for (const key of keys) delete storageData[key]; callback?.(); }
    };
    const defaults = { note: ['default note'], ack: ['default ack'], close: [] };
    const api = BosunHelperActionTemplates.createActionTemplates({
      isActionPage: () => true,
      templatesByType: defaults,
      storageKey: 'testTemplates',
      getStorage: () => storage,
      getLastError: () => null
    });
    api.refresh();
    const loaded = Array.from(document.querySelectorAll('.bosun-action-template-btn'), (node) => node.textContent);
    const loadedAck = api.getTemplatesForType('ack');
    const loadedClose = api.getTemplatesForType('close');
    document.querySelector('.bosun-action-templates-settings').click();
    const focusAfterOpen = document.activeElement?.classList.contains('bosun-action-template-input') === true;
    const expandedAfterOpen = document.querySelector('.bosun-action-templates-settings').getAttribute('aria-expanded');
    let rows = Array.from(document.querySelectorAll('.bosun-action-template-row'));
    rows[0].querySelector('input').value = 'edited';
    rows[0].querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('.bosun-action-template-editor-btn'))
      .find((node) => node.textContent.includes('Добавить')).click();
    rows = Array.from(document.querySelectorAll('.bosun-action-template-row'));
    rows[2].querySelector('input').value = 'new';
    rows[2].querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
    rows[2].querySelector('[aria-label="Переместить шаблон 3 выше"]').click();
    const focusAfterMove = document.activeElement?.value;
    rows = Array.from(document.querySelectorAll('.bosun-action-template-row'));
    rows[2].querySelector('[aria-label="Удалить шаблон 3"]').click();
    const focusAfterDelete = document.activeElement?.value;
    Array.from(document.querySelectorAll('.bosun-action-template-editor-btn'))
      .find((node) => node.textContent === 'Сохранить').click();
    const afterSave = Array.from(document.querySelectorAll('.bosun-action-template-btn'), (node) => node.textContent);
    const savedBeforeReset = storageData['testTemplates:note'].slice();
    const textareaAfterEditing = document.querySelector('#settings-message').value;
    const focusAfterSave = document.activeElement?.classList.contains('bosun-action-templates-settings') === true;

    document.querySelector('.bosun-action-templates-settings').click();
    Array.from(document.querySelectorAll('.bosun-action-template-editor-btn'))
      .find((node) => node.textContent === 'Сбросить').click();
    const afterReset = Array.from(document.querySelectorAll('.bosun-action-template-btn'), (node) => node.textContent);

    const corruptStorage = {
      get(keys, callback) {
        callback({
          'corrupt:note': 'broken',
          'corrupt:ack': [null, '', ' ok ', 'ok', 42]
        });
      }
    };
    const corruptApi = BosunHelperActionTemplates.createActionTemplates({
      isActionPage: () => true,
      templatesByType: defaults,
      storageKey: 'corrupt',
      getStorage: () => corruptStorage,
      getLastError: () => null
    });
    const corruptNote = corruptApi.getTemplatesForType('note');
    corruptApi.refresh();
    const sanitizedAck = corruptApi.getTemplatesForType('ack');

    return {
      defaults: BosunHelperActionTemplates.DEFAULT_TEMPLATES,
      loaded,
      loadedAck,
      loadedClose,
      focusAfterOpen,
      expandedAfterOpen,
      focusAfterMove,
      focusAfterDelete,
      focusAfterSave,
      saved: savedBeforeReset,
      afterSave,
      textareaAfterEditing,
      afterReset,
      resetRemoved: !Object.prototype.hasOwnProperty.call(storageData, 'testTemplates:note'),
      ackUnchanged: storageData['testTemplates:ack'],
      corruptNote,
      sanitizedAck
    };
  })()`);
  assert.deepStrictEqual(templateSettingsResult.loaded, ['custom', 'second']);
  assert.deepStrictEqual(templateSettingsResult.loadedAck, ['saved ack']);
  assert.deepStrictEqual(templateSettingsResult.loadedClose, ['saved close']);
  assert.strictEqual(templateSettingsResult.focusAfterOpen, true);
  assert.strictEqual(templateSettingsResult.expandedAfterOpen, 'true');
  assert.strictEqual(templateSettingsResult.focusAfterMove, 'new');
  assert.strictEqual(templateSettingsResult.focusAfterDelete, 'new');
  assert.strictEqual(templateSettingsResult.focusAfterSave, true);
  assert.deepStrictEqual(templateSettingsResult.saved, ['edited', 'new']);
  assert.deepStrictEqual(templateSettingsResult.afterSave, ['edited', 'new']);
  assert.strictEqual(templateSettingsResult.textareaAfterEditing, '');
  assert.deepStrictEqual(templateSettingsResult.afterReset, ['default note']);
  assert.strictEqual(templateSettingsResult.resetRemoved, true);
  assert.deepStrictEqual(templateSettingsResult.ackUnchanged, ['saved ack']);
  assert.deepStrictEqual(templateSettingsResult.corruptNote, ['default note']);
  assert.deepStrictEqual(templateSettingsResult.sanitizedAck, ['ok']);
  assert.ok(templateSettingsResult.defaults.note.length > 0);
  assert.ok(Array.isArray(templateSettingsResult.defaults.close));

  const delayedTemplateSaveResult = await evaluate(client, `(() => {
    document.body.innerHTML = '<div><textarea id="bosun-message"></textarea></div>';
    let pendingSave = null;
    let pendingValues = null;
    let lastError = null;
    const storage = {
      get(_keys, callback) { callback({ 'delayed:note': ['first'] }); },
      set(values, callback) { pendingValues = values; pendingSave = callback; },
      remove(_keys, callback) { callback?.(); }
    };
    const api = BosunHelperActionTemplates.createActionTemplates({
      isActionPage: () => true,
      templatesByType: { note: ['default'], ack: [], close: [] },
      storageKey: 'delayed',
      getStorage: () => storage,
      getLastError: () => lastError
    });
    api.refresh();
    document.querySelector('.bosun-action-templates-settings').click();
    const input = document.querySelector('.bosun-action-template-input');
    input.value = 'changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const save = Array.from(document.querySelectorAll('.bosun-action-template-editor-btn'))
      .find((node) => node.textContent === 'Сохранить');
    save.focus();
    save.click();
    const focusedWhilePending = document.activeElement === save;
    const busyWhilePending = document.querySelector('.bosun-action-templates-editor')
      ?.getAttribute('aria-busy');
    const readOnlyWhilePending = input.readOnly;
    const describedBy = input.getAttribute('aria-describedby');
    const limitHint = document.getElementById(describedBy)?.textContent || '';
    input.value = 'late change';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const bosunMessage = document.querySelector('#bosun-message');
    bosunMessage.focus();
    pendingSave?.();
    const successPreservedExternalFocus = document.activeElement === bosunMessage;
    const savedWhilePending = pendingValues?.['delayed:note'];

    document.querySelector('.bosun-action-templates-settings').click();
    const retryInput = document.querySelector('.bosun-action-template-input');
    retryInput.value = 'failed change';
    retryInput.dispatchEvent(new Event('input', { bubbles: true }));
    const retrySave = Array.from(document.querySelectorAll('.bosun-action-template-editor-btn'))
      .find((node) => node.textContent === 'Сохранить');
    retrySave.click();
    bosunMessage.focus();
    lastError = { message: 'synthetic delayed save failure' };
    pendingSave?.();
    lastError = null;
    const failurePreservedExternalFocus = document.activeElement === bosunMessage;
    return {
      focusedWhilePending,
      busyWhilePending,
      readOnlyWhilePending,
      limitHint,
      savedWhilePending,
      successPreservedExternalFocus,
      failurePreservedExternalFocus
    };
  })()`);
  if (!focusedAuditCase || focusedAuditCase === 'A12') {
    assert.deepStrictEqual(delayedTemplateSaveResult, {
      focusedWhilePending: true,
      busyWhilePending: 'true',
      readOnlyWhilePending: true,
      limitHint: 'До 50 шаблонов, до 500 символов каждый, без дубликатов, общий объём до 10000 символов',
      savedWhilePending: ['changed'],
      successPreservedExternalFocus: true,
      failurePreservedExternalFocus: true
    });
  }
};
