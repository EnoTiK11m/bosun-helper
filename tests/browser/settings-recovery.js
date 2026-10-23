'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSettingsRecoveryScenarios({ client, contentSource }) {
  const preferenceWriteRollback = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    const defaults = {
      schemaVersion: 1,
      features: {
        singleAlertAge: true, checkboxImprovements: true, copyButtons: true,
        lastActionEnhancements: true, silencedFilter: true, noCommentFilter: true,
        acknowledgedCollapse: true, soundNotifications: true,
        visualNewAlertNotifications: true, autoRefresh: true,
        actionTemplates: true, grafanaIntegration: true
      },
      preferences: {
        showSilenced: false, noCommentFilterActive: false, acknowledgedCollapsed: false,
        soundEnabled: true, autoRefreshEnabled: true, autoRefreshIdleSeconds: 60
      },
      actionTemplates: { note: null, ack: null, close: null },
      internal: { diagnosticsEnabled: false }
    };
    globalThis.BosunHelperSettings = {
      DEFAULTS: defaults,
      createSettingsStore() {
        return {
          start: async () => defaults,
          subscribe() { return () => {}; },
          getSnapshot() { return JSON.parse(JSON.stringify(defaults)); },
          update() { return Promise.reject(new Error('synthetic preference write failure')); }
        };
      }
    };
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.handleSoundAlertsToggle();
    await Promise.resolve();
    await Promise.resolve();
    return hooks.runtimeSettings();
  })()`);
  assert.strictEqual(preferenceWriteRollback.soundAlertsEnabled, true);
  assert.strictEqual(preferenceWriteRollback.toolbarStatusSource, 'storage-write');
  assert.strictEqual(preferenceWriteRollback.toolbarStatusTimer, null, 'storage failure warning must be sticky');

  const settingsLoadRecovery = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    let failLoad = true;
    const defaults = {
      schemaVersion: 1,
      features: {
        singleAlertAge: true, checkboxImprovements: true, copyButtons: true,
        lastActionEnhancements: true, silencedFilter: true, noCommentFilter: true,
        acknowledgedCollapse: true, soundNotifications: true,
        visualNewAlertNotifications: true, autoRefresh: true,
        actionTemplates: true, grafanaIntegration: true
      },
      preferences: {
        showSilenced: false, noCommentFilterActive: false, acknowledgedCollapsed: false,
        soundEnabled: true, autoRefreshEnabled: true, autoRefreshIdleSeconds: 60
      },
      actionTemplates: { note: null, ack: null, close: null },
      internal: { diagnosticsEnabled: false }
    };
    globalThis.BosunHelperSettings = {
      DEFAULTS: defaults,
      createSettingsStore() {
        return {
          start() { return failLoad ? Promise.reject(new Error('synthetic initial get failure')) : Promise.resolve(defaults); },
          subscribe() { return () => {}; },
          getSnapshot() { return JSON.parse(JSON.stringify(defaults)); },
          update: async () => defaults
        };
      }
    };
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    await new Promise((resolve) => hooks.loadState(resolve));
    const failed = hooks.runtimeSettings();
    failLoad = false;
    await new Promise((resolve) => hooks.loadState(resolve));
    const recovered = hooks.runtimeSettings();
    return { failed, recovered };
  })()`);
  assert.strictEqual(settingsLoadRecovery.failed.toolbarStatusSource, 'storage-read');
  assert.strictEqual(settingsLoadRecovery.failed.toolbarStatusTimer, null);
  assert.strictEqual(settingsLoadRecovery.recovered.toolbarStatusSource, '');
};
