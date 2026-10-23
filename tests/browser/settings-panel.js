'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSettingsPanelScenarios({ client, focusedAuditCase, settingsSource, settingsUiSource, stylesSource, contentSource }) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  });
  const settingsUiResult = await evaluate(client, `(async () => {
    document.body.innerHTML = '<div id="bosun-top-controls"><div class="bosun-top-controls-actions"></div></div>';
    ${settingsSource}
    ${settingsUiSource}
    ${stylesSource}
    const subscribers = new Set();
    const calls = { updates: [], resets: 0, confirms: 0 };
    let snapshot = JSON.parse(JSON.stringify(BosunHelperSettings.DEFAULTS));
    snapshot.features.copyButtons = false;
    snapshot.features.grafanaIntegration = true;
    snapshot.features.lastActionEnhancements = true;
    snapshot.preferences.autoRefreshIdleSeconds = 45;
    snapshot.actionTemplates.note = ['browser note'];
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const writePath = (target, path, value) => {
      const [section, name] = path.split('.');
      target[section][name] = value;
    };
    const store = {
      getSnapshot: () => clone(snapshot),
      async update(values) {
        calls.updates.push(clone(values));
        const previous = clone(snapshot);
        for (const [path, value] of Object.entries(values)) writePath(snapshot, path, value);
        const changedPaths = Object.keys(values);
        for (const subscriber of Array.from(subscribers)) subscriber(clone(snapshot), previous, changedPaths);
        return clone(snapshot);
      },
      async reset() {
        calls.resets += 1;
        const previous = clone(snapshot);
        snapshot = clone(BosunHelperSettings.DEFAULTS);
        const changedPaths = BosunHelperSettings.SCHEMA.map((entry) => entry.path);
        for (const subscriber of Array.from(subscribers)) subscriber(clone(snapshot), previous, changedPaths);
        return clone(snapshot);
      },
      subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); }
    };
    const api = BosunHelperSettingsUi.createSettingsUi({
      settingsStore: store,
      schema: BosunHelperSettings.SCHEMA,
      toolbarId: 'bosun-top-controls',
      confirmReset() { calls.confirms += 1; return true; }
    });
    const actions = document.querySelector('.bosun-top-controls-actions');
    api.mount(actions);
    api.mount(actions);
    const button = document.querySelector('#bosun-settings-button');
    button.focus();
    button.click();
    const panel = document.querySelector('.bosun-settings-panel');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    const focusTrapWrapsBackward = document.activeElement === document.querySelector('#bosun-settings-reset');
    document.querySelector('#bosun-settings-close').focus();
    const initial = {
      buttonCount: document.querySelectorAll('#bosun-settings-button').length,
      dialogCount: document.querySelectorAll('#bosun-settings-modal').length,
      copyButtons: document.querySelector('[data-setting-path="features.copyButtons"]').checked,
      idleSeconds: document.querySelector('[data-setting-path="preferences.autoRefreshIdleSeconds"]').value,
      note: document.querySelector('[data-setting-path="actionTemplates.note"]').value,
      reloadHint: Boolean(document.querySelector('.bosun-settings-reload-hint')),
      focusInside: panel.contains(document.activeElement),
      focusTrapWrapsBackward,
      panelFitsViewport: panel.getBoundingClientRect().width <= document.documentElement.clientWidth,
      noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth
    };

    const copyToggle = document.querySelector('[data-setting-path="features.copyButtons"]');
    copyToggle.focus();
    copyToggle.click();
    await Promise.resolve();
    await Promise.resolve();
    const saveFocusPreserved = document.activeElement === copyToggle;

    const grafanaToggle = document.querySelector('[data-setting-path="features.grafanaIntegration"]');
    const soundToggle = document.querySelector('[data-setting-path="features.soundNotifications"]');
    grafanaToggle.click();
    await Promise.resolve();
    await Promise.resolve();
    const soundUnaffected = soundToggle.checked;

    const previous = clone(snapshot);
    snapshot.features.copyButtons = false;
    for (const subscriber of Array.from(subscribers)) {
      subscriber(clone(snapshot), previous, ['features.copyButtons']);
    }
    await Promise.resolve();
    const externalUpdateReflected = copyToggle.checked === false;

    const drafts = [];
    const priorityDraft = document.querySelector('[data-setting-path="priorityRules.exactAlertNames"]');
    const templateDraft = document.querySelector('[data-setting-path="actionTemplates.note"]');
    priorityDraft.value = 'synthetic.draft'; templateDraft.value = 'draft note';
    priorityDraft.focus();
    priorityDraft.dispatchEvent(new Event('input', { bubbles: true }));
    templateDraft.dispatchEvent(new Event('input', { bubbles: true }));
    api.mount(actions); api.mount(actions);
    drafts.push([priorityDraft.value, templateDraft.value, document.activeElement === priorityDraft]);
    async function externalDraftUpdate(path, value) {
      const before = clone(snapshot); writePath(snapshot, path, value);
      for (const subscriber of subscribers) subscriber(clone(snapshot), before, [path]);
      await Promise.resolve();
    }
    await externalDraftUpdate('features.soundNotifications', false);
    drafts.push([priorityDraft.value, templateDraft.value]);
    await externalDraftUpdate('priorityRules.exactAlertNames', ['external']);
    drafts.push([priorityDraft.value, templateDraft.value]);
    await externalDraftUpdate('actionTemplates.close', ['pristine']);
    const pristineDraftUpdate = document.querySelector('[data-setting-path="actionTemplates.close"]').value;
    priorityDraft.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    drafts.push([priorityDraft.value, templateDraft.value, snapshot.priorityRules.exactAlertNames[0]]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escapeClosed = !api.isOpen() && document.activeElement === button;
    button.click();
    document.querySelector('#bosun-settings-modal').click();
    const outsideClosed = !api.isOpen() && document.activeElement === button;

    button.click();
    const resetButton = document.querySelector('#bosun-settings-reset');
    resetButton.focus();
    resetButton.click();
    await Promise.resolve();
    await Promise.resolve();
    const resetApplied = calls.resets === 1 &&
      document.querySelector('[data-setting-path="features.copyButtons"]').checked === true;
    const resetFocusPreserved = document.activeElement === resetButton;
    const resetDraftsCleared = priorityDraft.value === BosunHelperSettings.DEFAULTS.priorityRules.exactAlertNames.join('\\n') && templateDraft.value === '';
    const templateAccessibility = ['note', 'ack', 'close'].every((type) => {
      const textarea = document.querySelector('[data-setting-path="actionTemplates.' + type + '"]');
      const defaultButton = document.querySelector('[data-template-default-path="actionTemplates.' + type + '"]');
      const describedBy = textarea.getAttribute('aria-describedby');
      const label = type[0].toUpperCase() + type.slice(1);
      return defaultButton.getAttribute('aria-label') === 'Вернуть встроенные шаблоны: ' + label &&
        Boolean(describedBy) && document.getElementById(describedBy);
    });

    api.destroy();
    const destroyed = !document.querySelector('#bosun-settings-button') &&
      !document.querySelector('#bosun-settings-modal') && subscribers.size === 0;
    const remountApi = BosunHelperSettingsUi.createSettingsUi({
      settingsStore: store,
      schema: BosunHelperSettings.SCHEMA,
      toolbarId: 'bosun-top-controls'
    });
    remountApi.mount(actions);
    const remounted = document.querySelectorAll('#bosun-settings-button').length === 1;
    remountApi.destroy();
    return {
      initial,
      drafts, pristineDraftUpdate, resetDraftsCleared,
      updates: calls.updates,
      saveFocusPreserved,
      soundUnaffected,
      externalUpdateReflected,
      escapeClosed,
      outsideClosed,
      resetApplied,
      resetFocusPreserved,
      templateAccessibility,
      confirms: calls.confirms,
      destroyed,
      remounted,
      finalSubscribers: subscribers.size
    };
  })()`);
  await client.send('Emulation.clearDeviceMetricsOverride');
  assert.deepStrictEqual(settingsUiResult.initial, {
    buttonCount: 1,
    dialogCount: 1,
    copyButtons: false,
    idleSeconds: '45',
    note: 'browser note',
    reloadHint: true,
    focusInside: true,
    focusTrapWrapsBackward: true,
    panelFitsViewport: true,
    noHorizontalOverflow: true
  });
  assert.ok(
    settingsUiResult.updates.some((call) => call['features.copyButtons'] === true),
    'Settings UI did not persist the copy-buttons toggle'
  );
  assert.strictEqual(settingsUiResult.saveFocusPreserved, true, 'Async save lost keyboard focus');
  assert.ok(
    settingsUiResult.updates.some((call) => call['features.grafanaIntegration'] === false),
    'Settings UI did not persist the Grafana toggle'
  );
  assert.strictEqual(settingsUiResult.soundUnaffected, true, 'Grafana toggle changed an unrelated feature');
  assert.strictEqual(settingsUiResult.externalUpdateReflected, true);
  assert.strictEqual(settingsUiResult.escapeClosed, true);
  assert.strictEqual(settingsUiResult.outsideClosed, true);
  assert.strictEqual(settingsUiResult.resetApplied, true);
  assert.strictEqual(settingsUiResult.resetFocusPreserved, true, 'Reset lost keyboard focus');
  assert.strictEqual(settingsUiResult.templateAccessibility, true);
  assert.strictEqual(settingsUiResult.confirms, 1);
  assert.strictEqual(settingsUiResult.destroyed, true);
  assert.strictEqual(settingsUiResult.remounted, true);
  assert.strictEqual(settingsUiResult.finalSubscribers, 0);
  assert.deepStrictEqual(settingsUiResult.drafts, [
    ['synthetic.draft', 'draft note', true], ['synthetic.draft', 'draft note'],
    ['synthetic.draft', 'draft note'], ['synthetic.draft', 'draft note', 'synthetic.draft']
  ], 'A23: actual DOM repaint must preserve drafts until explicit save/reset');
  assert.strictEqual(settingsUiResult.pristineDraftUpdate, 'pristine');
  assert.strictEqual(settingsUiResult.resetDraftsCleared, true);

  const settingsBfcacheLifecycle = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe');
    frame.src = location.origin + '/';
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('BFCache test frame failed to load')), { once: true });
    });
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    doc.body.innerHTML = '<nav class="navbar navbar-default navbar-static-top"></nav><main class="container"></main>';
    const storageData = { bosunSettingsSchemaVersion: 1 };
    const storageListeners = new Set();
    const storage = {
      get(keys, callback) {
        const result = {};
        if (keys === null) Object.assign(result, storageData);
        else for (const key of keys || []) {
          if (Object.prototype.hasOwnProperty.call(storageData, key)) result[key] = storageData[key];
        }
        callback(result);
      },
      set(values, callback) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: storageData[key], newValue: value };
          storageData[key] = value;
        }
        callback?.();
        for (const listener of Array.from(storageListeners)) listener(changes, 'local');
      },
      remove(keys, callback) {
        const changes = {};
        for (const key of keys || []) {
          changes[key] = { oldValue: storageData[key], newValue: undefined };
          delete storageData[key];
        }
        callback?.();
        for (const listener of Array.from(storageListeners)) listener(changes, 'local');
      }
    };
    win.chrome = {
      runtime: { lastError: null, getURL: (file) => 'chrome-extension://test/' + file },
      storage: {
        local: storage,
        onChanged: {
          addListener(listener) { storageListeners.add(listener); },
          removeListener(listener) { storageListeners.delete(listener); }
        }
      }
    };
    win.BosunHelperLocalConfig = {
      bosunHosts: [win.location.host],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    win.eval(${JSON.stringify(settingsSource)});
    win.eval(${JSON.stringify(settingsUiSource)});
    win.eval(${JSON.stringify(contentSource)});
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => win.setTimeout(resolve, 0));

    const transition = (type, persisted) => {
      const event = new win.Event(type);
      Object.defineProperty(event, 'persisted', { value: persisted });
      win.dispatchEvent(event);
    };
    const initialButton = doc.querySelector('#bosun-settings-button');
    initialButton?.click();
    const initialOpen = doc.querySelector('#bosun-settings-modal')?.classList.contains('is-open') === true;
    doc.querySelector('#bosun-settings-close')?.click();

    const cycleCounts = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      transition('pagehide', true);
      transition('pageshow', true);
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      cycleCounts.push({
        buttons: doc.querySelectorAll('#bosun-settings-button').length,
        dialogs: doc.querySelectorAll('#bosun-settings-modal').length
      });
    }

    const resumedButton = doc.querySelector('#bosun-settings-button');
    resumedButton?.click();
    const resumedOpen = doc.querySelector('#bosun-settings-modal')?.classList.contains('is-open') === true;
    storageData['bosunSettingsV1:features.copyButtons'] = false;
    for (const listener of Array.from(storageListeners)) {
      listener({
        'bosunSettingsV1:features.copyButtons': { oldValue: true, newValue: false }
      }, 'local');
    }
    await Promise.resolve();
    const syncAfterResume =
      doc.querySelector('[data-setting-path="features.copyButtons"]')?.checked === false;

    transition('pagehide', false);
    const normalHideDestroyed = doc.querySelector('#bosun-settings-button') === null &&
      doc.querySelector('#bosun-settings-modal') === null;
    const result = {
      initialOpen,
      cycleCounts,
      resumedOpen,
      syncAfterResume,
      normalHideDestroyed
    };
    frame.remove();
    return result;
  })()`);
  if (!focusedAuditCase || focusedAuditCase === 'A04') {
    assert.deepStrictEqual(settingsBfcacheLifecycle, {
      initialOpen: true,
      cycleCounts: [
        { buttons: 1, dialogs: 1 },
        { buttons: 1, dialogs: 1 }
      ],
      resumedOpen: true,
      syncAfterResume: true,
      normalHideDestroyed: true
    });
  }
};
