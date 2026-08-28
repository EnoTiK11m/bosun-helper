'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = __dirname;
const CDP_TIMEOUT_MS = 15_000;

if (typeof WebSocket !== 'function') {
  throw new Error('Browser tests require Node.js with global WebSocket support (Node.js 22+ recommended).');
}

function executableFromCommand(command) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [command], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '';
}

function findBrowserExecutable() {
  const configured = String(process.env.BOSUN_HELPER_BROWSER || '').trim();
  if (configured) {
    const resolved = fs.existsSync(configured) ? configured : executableFromCommand(configured);
    if (resolved) return resolved;
    throw new Error(`BOSUN_HELPER_BROWSER does not resolve to an executable: ${configured}`);
  }

  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    : [
        executableFromCommand('google-chrome'),
        executableFromCommand('google-chrome-stable'),
        executableFromCommand('chromium'),
        executableFromCommand('chromium-browser'),
        '/usr/bin/google-chrome',
        '/usr/bin/chromium'
      ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Chrome/Chromium/Edge was not found. Install one or set BOSUN_HELPER_BROWSER to its executable.'
  );
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTemporaryProfile(profileDirectory, options = {}) {
  const resolvedProfile = path.resolve(profileDirectory);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedProfile).startsWith('bosun-helper-browser-'),
    `Refusing to remove unexpected browser profile path: ${resolvedProfile}`
  );
  const remove = options.remove || ((target) => fs.promises.rm(target, {
    recursive: true,
    force: true
  }));
  const wait = options.wait || delay;
  const maxAttempts = options.maxAttempts || 12;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await remove(resolvedProfile);
      return;
    } catch (error) {
      lastError = error;
      if (!['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      if (attempt + 1 < maxAttempts) {
        await wait(Math.min(1000, 100 * (2 ** attempt)));
      }
    }
  }
  throw lastError || new Error('Temporary browser profile cleanup failed');
}

async function testTemporaryProfileCleanupRetry() {
  const attemptedDelays = [];
  let removeAttempts = 0;
  await removeTemporaryProfile(
    path.join(os.tmpdir(), 'bosun-helper-browser-cleanup-test'),
    {
      maxAttempts: 4,
      async remove() {
        removeAttempts += 1;
        if (removeAttempts < 3) {
          const error = new Error('simulated Windows profile lock');
          error.code = 'EPERM';
          throw error;
        }
      },
      async wait(milliseconds) { attemptedDelays.push(milliseconds); }
    }
  );
  assert.strictEqual(removeAttempts, 3, 'Temporary profile cleanup did not retry EPERM');
  assert.deepStrictEqual(attemptedDelays, [100, 200]);
}

function waitForBrowserExit(browser, timeoutMs) {
  if (browser.exitCode != null || browser.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeoutId);
      resolve(true);
    };
    const timeoutId = setTimeout(() => {
      browser.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    browser.once('exit', onExit);
  });
}

async function waitForJson(url, browserProcess, stderr) {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode != null) {
      throw new Error(`Browser exited with code ${browserProcess.exitCode}: ${stderr.value.trim()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Browser debugging endpoint did not become ready: ${lastError?.message || 'timeout'}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.events.get(message.method) || []) listener(message.params || {});
    });
    const rejectPending = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP WebSocket closed'));
      this.pending.clear();
    };
    this.socket.addEventListener('close', rejectPending);
    this.socket.addEventListener('error', rejectPending);
  }

  async send(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve(value) { clearTimeout(timeoutId); resolve(value); },
        reject(error) { clearTimeout(timeoutId); reject(error); }
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  once(method) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        reject(new Error(`CDP event timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      const listener = (params) => {
        clearTimeout(timeoutId);
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        resolve(params);
      };
      const listeners = this.events.get(method) || [];
      listeners.push(listener);
      this.events.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

function instrumentContentSource(source) {
  const closing = source.lastIndexOf('})();');
  assert.ok(closing > 0, 'Unable to instrument content.js for browser assertions');
  return `${source.slice(0, closing)}
  let browserTestScheduledDomRefreshes = 0;
  let browserTestScheduledDataRefreshes = 0;
  const browserTestOriginalScheduleRefresh = scheduleRefresh;
  const browserTestOriginalScheduleAlertsDataRefresh = scheduleAlertsDataRefresh;
  scheduleRefresh = (...args) => {
    browserTestScheduledDomRefreshes += 1;
    return browserTestOriginalScheduleRefresh(...args);
  };
  scheduleAlertsDataRefresh = (...args) => {
    browserTestScheduledDataRefreshes += 1;
    return browserTestOriginalScheduleAlertsDataRefresh(...args);
  };
  globalThis.__BosunHelperBrowserTest = {
    ensureStateIcon,
    ensureParentStateIcon,
    ensureToggleExists,
    destroySettingsUi: () => settingsUi?.destroy?.(),
    ensureAutoRefreshControls,
    ensureLastActionCopyButtons,
    ensureGrafanaQueryButtons,
    runDomRefreshPass,
    getLastActionMessageText,
    applyAlertsPayload,
    rebuildGrafanaQueryIndex,
    refreshRuleGraphDefinitions,
    ruleGraphResolver,
    getGrafanaQueryForPanel,
    flashCopyButtonState,
    handleRouteChange,
    startObserver,
    setExtensionClass,
    isFeatureEnabled,
    setFeature(name, enabled) {
      const previous = JSON.parse(JSON.stringify(settingsSnapshot));
      const next = JSON.parse(JSON.stringify(settingsSnapshot));
      next.features[name] = Boolean(enabled);
      applySettingsSnapshot(next, {
        previous,
        changedPaths: ['features.' + name],
        initial: false
      });
    },
    setPreference(name, value) {
      const previous = JSON.parse(JSON.stringify(settingsSnapshot));
      const next = JSON.parse(JSON.stringify(settingsSnapshot));
      next.preferences ||= {};
      next.preferences[name] = value;
      applySettingsSnapshot(next, {
        previous,
        changedPaths: ['preferences.' + name],
        initial: false
      });
    },
    handleSoundAlertsToggle,
    applyActionPageTweaks,
    loadState,
    runtimeSettings() {
      return {
        soundAlertsEnabled,
        showSilenced,
        autoRefreshEnabled,
        autoRefreshIdleSeconds,
        userCommentFilterEnabled,
        acknowledgedCollapseEnabled,
        toolbarStatusSource,
        toolbarStatusMessage,
        toolbarStatusTimer
      };
    },
    singleAlertAge: singleAlertAgeApi,
    refreshIntervals: { visible: DATA_REFRESH_MS, hidden: DATA_REFRESH_HIDDEN_MS },
    resetLifecycleCounters() {
      browserTestScheduledDomRefreshes = 0;
      browserTestScheduledDataRefreshes = 0;
    },
    getLifecycleCounters() {
      return {
        domRefreshes: browserTestScheduledDomRefreshes,
        dataRefreshes: browserTestScheduledDataRefreshes
      };
    },
    seedMarkerCache(id, state) {
      for (const map of Object.values(getAlertMarkerCacheMaps())) map.clear();
      if (state === 'note') childHasNoteById.set(id, true);
      if (state === 'warning') childOldNoNoteById.set(id, true);
      alertDataIndexReady = true;
      flushAlertMarkerCacheToSession();
    },
    clearMarkerState() {
      for (const map of Object.values(getAlertMarkerCacheMaps())) map.clear();
      alertDataIndexReady = false;
    },
    restoreMarkerCache() {
      const restored = restoreAlertMarkerCacheFromSession();
      return {
        restored,
        note: childHasNoteById.get('cached-alert') === true,
        warning: childOldNoNoteById.get('cached-alert') === true
      };
    },
    markerState() {
      return {
        ready: alertDataIndexReady,
        note: childHasNoteById.get('cached-alert') === true
      };
    },
    setNewAlertNoticeCounts(counts) {
      newAlertNoticeCounts = counts;
      ensureNewAlertNotice();
    }
  };
${source.slice(closing)}`;
}

async function runBrowserAssertions(client) {
  const settingsSource = fs.readFileSync(path.join(root, 'settings.js'), 'utf8');
  const settingsUiSource = fs.readFileSync(path.join(root, 'settings-ui.js'), 'utf8');
  const actionSource = fs.readFileSync(path.join(root, 'action-templates.js'), 'utf8');
  const needAckBaselineSource = fs.readFileSync(path.join(root, 'needack-baseline.js'), 'utf8');
  const singleAlertAgeSource = fs.readFileSync(path.join(root, 'single-alert-age.js'), 'utf8');
  const pageUtilsSource = fs.readFileSync(path.join(root, 'page-utils.js'), 'utf8');
  const stylesSource = fs.readFileSync(path.join(root, 'styles.js'), 'utf8');
  const handoffSource = fs.readFileSync(path.join(root, 'grafana-handoff.js'), 'utf8');
  const grafanaPageSource = JSON.stringify(fs.readFileSync(path.join(root, 'grafana-page.js'), 'utf8'));
  const promqlSource = fs.readFileSync(path.join(root, 'promql.js'), 'utf8');
  const ruleGraphSource = fs.readFileSync(path.join(root, 'bosun-rule-graph.js'), 'utf8');
  const contentSource = instrumentContentSource(fs.readFileSync(path.join(root, 'content.js'), 'utf8'));

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

  const normalizedSettingsUiResult = await evaluate(client, `(async () => {
    document.body.innerHTML = '<div id="normalized-toolbar"><div class="bosun-top-controls-actions"></div></div>';
    const data = {
      bosunSettingsSchemaVersion: 1,
      'bosunSettingsV1:features.copyButtons': 'corrupt',
      'bosunSettingsV1:preferences.autoRefreshIdleSeconds': 'not-a-number'
    };
    const listeners = new Set();
    const storage = {
      get(keys, callback) {
        const result = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
        queueMicrotask(() => callback(result));
      },
      set(values, callback) { Object.assign(data, values); queueMicrotask(() => callback?.()); },
      remove(keys, callback) {
        for (const key of keys) delete data[key];
        queueMicrotask(() => callback?.());
      }
    };
    const storageChanges = {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    };
    const store = BosunHelperSettings.createSettingsStore({
      storage,
      storageChanges,
      getLastError: () => null
    });
    await store.start();
    const api = BosunHelperSettingsUi.createSettingsUi({
      settingsStore: store,
      schema: BosunHelperSettings.SCHEMA,
      toolbarId: 'normalized-toolbar'
    });
    api.mount(document.querySelector('.bosun-top-controls-actions'));
    api.open();
    const result = {
      copyButtons: document.querySelector('[data-setting-path="features.copyButtons"]').checked,
      idleSeconds: document.querySelector('[data-setting-path="preferences.autoRefreshIdleSeconds"]').value
    };
    api.destroy();
    store.destroy();
    result.listenersAfterDestroy = listeners.size;
    return result;
  })()`);
  assert.deepStrictEqual(normalizedSettingsUiResult, {
    copyButtons: true,
    idleSeconds: '60',
    listenersAfterDestroy: 0
  });

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  const wideSettingsLayout = await evaluate(client, `(async () => {
    document.body.innerHTML = '<div id="layout-toolbar"><div class="bosun-top-controls-actions"></div></div>';
    document.getElementById('bosun-silence-hider-styles')?.remove();
    BosunSilenceHiderStyles.injectStyles({
      hiddenClass: 'layout-hidden', userCommentFilterHiddenClass: 'layout-user-hidden',
      acknowledgedCollapsedClass: 'layout-ack-hidden', copyButtonClass: 'layout-copy',
      copyAllButtonClass: 'layout-copy-all', copyLastActionButtonClass: 'layout-copy-last',
      grafanaQueryButtonClass: 'layout-grafana', noSelectClass: 'layout-no-select',
      silencedBadgeClass: 'layout-silenced', oldNoNoteIconClass: 'layout-old-note',
      hasNoteIconClass: 'layout-has-note', topBarId: 'layout-toolbar',
      topBarStatusId: 'layout-status', toggleId: 'layout-toggle',
      toggleCounterId: 'layout-counter', autoRefreshToggleId: 'layout-auto-toggle',
      autoRefreshInputId: 'layout-auto-input', autoRefreshCountdownId: 'layout-countdown',
      soundAlertsToggleId: 'layout-sound', diagnosticsModalId: 'layout-diagnostics',
      diagnosticsLogListId: 'layout-diagnostics-list'
    });
    const clone = (value) => JSON.parse(JSON.stringify(value));
    let snapshot = clone(BosunHelperSettings.DEFAULTS);
    snapshot.actionTemplates.note = ['draft template'];
    const subscribers = new Set();
    const store = {
      getSnapshot: () => clone(snapshot),
      async update(values) {
        const previous = clone(snapshot);
        for (const [path, value] of Object.entries(values)) {
          const [section, name] = path.split('.');
          snapshot[section][name] = value;
        }
        for (const listener of Array.from(subscribers)) listener(clone(snapshot), previous, Object.keys(values));
        return clone(snapshot);
      },
      async reset() { return clone(snapshot); },
      subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); }
    };
    const api = BosunHelperSettingsUi.createSettingsUi({
      settingsStore: store,
      schema: BosunHelperSettings.SCHEMA,
      toolbarId: 'layout-toolbar'
    });
    api.mount(document.querySelector('.bosun-top-controls-actions'));
    api.open();
    const details = document.querySelector('.bosun-settings-group-collapsible');
    const summary = details.querySelector('summary');
    const panel = document.querySelector('.bosun-settings-panel');
    const body = document.querySelector('.bosun-settings-body');
    const collapsedHeight = panel.getBoundingClientRect().height;
    summary.focus();
    summary.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const note = document.querySelector('[data-setting-path="actionTemplates.note"]');
    note.value = 'unsaved visual draft';
    const groupByTitle = (title) => Array.from(document.querySelectorAll('.bosun-settings-group')).find((group) => {
      return group.querySelector('.bosun-settings-group-title')?.textContent === title;
    });
    const integration = groupByTitle('Интеграции').getBoundingClientRect();
    const templates = groupByTitle('Шаблоны').getBoundingClientRect();
    const groupLefts = Array.from(document.querySelectorAll('.bosun-settings-group'), (group) => {
      return Math.round(group.getBoundingClientRect().left);
    });
    summary.click();
    summary.click();
    const draftPreserved = note.value === 'unsaved visual draft';
    globalThis.__settingsLayoutTest = { api, store, subscribers };
    return {
      columnCount: getComputedStyle(body).columnCount,
      distinctColumns: new Set(groupLefts).size,
      integrationHeight: integration.height,
      templatesHeight: templates.height,
      collapsedHeight,
      expandedHeight: panel.getBoundingClientRect().height,
      templatesOpen: details.open,
      summaryFocusedBeforeToggle: document.activeElement === summary,
      draftPreserved,
      noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth
    };
  })()`);

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 600,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  const narrowSettingsLayout = await evaluate(client, `(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const body = document.querySelector('.bosun-settings-body');
    const panel = document.querySelector('.bosun-settings-panel');
    const lefts = Array.from(document.querySelectorAll('.bosun-settings-group'), (group) => {
      return Math.round(group.getBoundingClientRect().left);
    });
    const result = {
      columnCount: getComputedStyle(body).columnCount,
      distinctColumns: new Set(lefts).size,
      fitsViewport: panel.getBoundingClientRect().width <= document.documentElement.clientWidth,
      noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth,
      draftPreserved: document.querySelector('[data-setting-path="actionTemplates.note"]').value === 'unsaved visual draft'
    };
    __settingsLayoutTest.api.destroy();
    result.subscribersAfterDestroy = __settingsLayoutTest.subscribers.size;
    delete globalThis.__settingsLayoutTest;
    document.getElementById('bosun-silence-hider-styles')?.remove();
    return result;
  })()`);
  await client.send('Emulation.clearDeviceMetricsOverride');

  assert.strictEqual(wideSettingsLayout.columnCount, '2');
  assert.ok(wideSettingsLayout.distinctColumns >= 2, 'Wide settings panel did not retain two columns');
  assert.ok(
    wideSettingsLayout.integrationHeight + 40 < wideSettingsLayout.templatesHeight,
    'Integration card was stretched to match the templates card'
  );
  assert.ok(wideSettingsLayout.collapsedHeight < wideSettingsLayout.expandedHeight);
  assert.strictEqual(wideSettingsLayout.templatesOpen, true);
  assert.strictEqual(wideSettingsLayout.summaryFocusedBeforeToggle, true);
  assert.strictEqual(wideSettingsLayout.draftPreserved, true);
  assert.strictEqual(wideSettingsLayout.noHorizontalOverflow, true);
  assert.deepStrictEqual(narrowSettingsLayout, {
    columnCount: '1',
    distinctColumns: 1,
    fitsViewport: true,
    noHorizontalOverflow: true,
    draftPreserved: true,
    subscribersAfterDestroy: 0
  });

  const toolbarLayouts = [];
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '<nav class="navbar navbar-default navbar-static-top"></nav><main class="container"></main>';
    document.getElementById('bosun-silence-hider-styles')?.remove();
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${contentSource}
    BosunSilenceHiderStyles.injectStyles({
      hiddenClass: 'bosun-silence-hidden', userCommentFilterHiddenClass: 'bosun-user-comment-hidden',
      acknowledgedCollapsedClass: 'bosun-acknowledged-collapsed', copyButtonClass: 'bosun-copy-alert-btn',
      copyAllButtonClass: 'bosun-copy-all-alerts-btn', copyLastActionButtonClass: 'bosun-copy-last-action-btn',
      grafanaQueryButtonClass: 'bosun-grafana-query-btn', noSelectClass: 'bosun-no-select',
      silencedBadgeClass: 'bosun-silenced-badge', oldNoNoteIconClass: 'bosun-old-no-note-icon',
      hasNoteIconClass: 'bosun-has-note-icon', topBarId: 'bosun-top-controls-bar',
      topBarStatusId: 'bosun-top-controls-status', toggleId: 'bosun-silence-toggle',
      toggleCounterId: 'bosun-silence-toggle-counter', autoRefreshToggleId: 'bosun-auto-refresh-toggle',
      autoRefreshInputId: 'bosun-auto-refresh-idle-seconds', autoRefreshCountdownId: 'bosun-auto-refresh-countdown',
      soundAlertsToggleId: 'bosun-sound-alerts-toggle', diagnosticsModalId: 'bosun-diagnostics-modal',
      diagnosticsLogListId: 'bosun-diagnostics-log-list'
    });
    __BosunHelperBrowserTest.ensureToggleExists();
    globalThis.__measureToolbarLayout = () => {
      const actions = document.querySelector('.bosun-top-controls-actions');
      const utility = document.querySelector('.bosun-toolbar-utility-group');
      const silenced = document.querySelector('#bosun-silence-toggle');
      const settings = document.querySelector('#bosun-settings-button');
      const first = document.querySelector('.bosun-sound-alerts-wrap');
      const status = document.querySelector('#bosun-top-controls-status');
      const actionsRect = actions.getBoundingClientRect();
      const utilityRect = utility.getBoundingClientRect();
      const silencedRect = silenced.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        utilityChildren: Array.from(utility.children, (node) => node.id),
        utilityWrap: getComputedStyle(utility).flexWrap,
        sameUtilityLine: Math.abs(silencedRect.top - settingsRect.top) <= 1,
        settingsAfterSilenced: settingsRect.left >= silencedRect.right,
        sameAsFirstLine: Math.abs(utilityRect.top - firstRect.top) <= 1,
        rightAligned: Math.abs(utilityRect.right - actionsRect.right) <= 1,
        insideActions: utilityRect.left >= actionsRect.left && utilityRect.right <= actionsRect.right + 1,
        statusHidden: getComputedStyle(status).display === 'none' && statusRect.width === 0 && statusRect.height === 0,
        noHorizontalOverflow: actions.scrollWidth <= actions.clientWidth
      };
    };
  })()`);

  try {
    for (const width of [1920, 1200, 900, 600]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
      });
      const layout = await evaluate(client, `(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return __measureToolbarLayout();
      })()`);
      toolbarLayouts.push({ width, ...layout });
    }
  } finally {
    await evaluate(client, `(() => {
      __BosunHelperBrowserTest.destroySettingsUi();
      delete globalThis.__measureToolbarLayout;
      document.getElementById('bosun-silence-hider-styles')?.remove();
    })()`);
    await client.send('Emulation.clearDeviceMetricsOverride');
  }

  for (const layout of toolbarLayouts) {
    assert.deepStrictEqual(layout.utilityChildren, ['bosun-silence-toggle', 'bosun-settings-button']);
    assert.strictEqual(layout.utilityWrap, 'nowrap');
    assert.strictEqual(layout.sameUtilityLine, true);
    assert.strictEqual(layout.settingsAfterSilenced, true);
    assert.strictEqual(layout.rightAligned, true);
    assert.strictEqual(layout.insideActions, true);
    assert.strictEqual(layout.statusHidden, true, `Empty toolbar status was visible at ${layout.width}px`);
    assert.strictEqual(layout.noHorizontalOverflow, true, `Toolbar overflowed at ${layout.width}px`);
  }
  assert.strictEqual(toolbarLayouts.find((layout) => layout.width === 1920).sameAsFirstLine, true);
  assert.strictEqual(toolbarLayouts.find((layout) => layout.width === 1200).sameAsFirstLine, true);
  assert.strictEqual(toolbarLayouts.find((layout) => layout.width === 600).sameAsFirstLine, false);

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
    document.body.innerHTML = '<div><textarea></textarea></div>';
    let pendingSave = null;
    let pendingValues = null;
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
      getLastError: () => null
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
    pendingSave?.();
    return {
      focusedWhilePending,
      busyWhilePending,
      readOnlyWhilePending,
      limitHint,
      savedWhilePending: pendingValues?.['delayed:note'],
      focusedAfterSave: document.activeElement?.classList.contains('bosun-action-templates-settings') === true
    };
  })()`);
  assert.deepStrictEqual(delayedTemplateSaveResult, {
    focusedWhilePending: true,
    busyWhilePending: 'true',
    readOnlyWhilePending: true,
    limitHint: 'До 50 шаблонов, до 500 символов каждый, без дубликатов, общий объём до 10000 символов',
    savedWhilePending: ['changed'],
    focusedAfterSave: true
  });

  const singleAlertAgeResult = await evaluate(client, `(() => {
    ${singleAlertAgeSource}
    const fixedNow = Date.parse('2026-08-20T12:00:00Z');
    document.body.innerHTML =
      '<div id="need">' +
        '<div class="panel" data-key="need-single" data-subject="single"><span class="count">1 alerts</span><span class="child-age">43m-ago</span><input type="checkbox" checked></div>' +
        '<div class="panel" data-key="need-multi" data-subject="multi"><span class="count">2 alerts</span></div>' +
        '<div class="panel" data-key="need-unknown" data-subject="unknown"><span class="count">1 alerts</span></div>' +
      '</div>' +
      '<div id="ack"><div class="panel" data-key="ack-single" data-subject="ack single"><span class="count">1 alerts</span></div></div>';
    let countClicks = 0;
    const singleCountNode = document.querySelector('[data-key="need-single"] .count');
    singleCountNode.addEventListener('click', () => { countClicks += 1; });
    const api = BosunHelperSingleAlertAge.createSingleAlertAge({
      now: () => fixedNow,
      normalizeChildren: (value) => Array.isArray(value) ? value : [],
      buildGroupKeyFromData: (group) => group.Key,
      buildGroupKeyFromDom: (panel) => panel.dataset.key,
      getRoots: () => [
        { type: 'NeedAck', root: document.querySelector('#need') },
        { type: 'Acknowledged', root: document.querySelector('#ack') }
      ],
      getGroupPanels: (root) => root.querySelectorAll('.panel'),
      getGroupSubject: (panel) => panel.dataset.subject,
      getGroupCountNode: (panel) => panel.querySelector('.count'),
      getRenderedChildAge: (panel) => panel.querySelector('.child-age')?.textContent
    });
    api.update({ Groups: {
      NeedAck: [
        { Key: 'need-single', Subject: 'single', Children: [{ Ago: '2026-08-20T11:17:00Z' }] },
        { Key: 'need-multi', Subject: 'multi', Children: [{ Ago: '2026-08-20T11:00:00Z' }, { Ago: '2026-08-20T10:00:00Z' }] },
        { Key: 'need-unknown', Subject: 'unknown', Children: [{ Ago: 'not-a-time' }] }
      ],
      Acknowledged: [
        { Key: 'ack-single', Subject: 'ack single', Children: [{ Ago: '2026-08-20T10:00:00Z' }] }
      ]
    }});
    api.refresh();
    const first = {
      single: singleCountNode.textContent,
      multi: document.querySelector('[data-key="need-multi"] .count').textContent,
      unknown: document.querySelector('[data-key="need-unknown"] .count').textContent,
      acknowledged: document.querySelector('[data-key="ack-single"] .count').textContent
    };
    singleCountNode.click();
    api.update({ Groups: {
      NeedAck: [{ Key: 'need-single', Subject: 'single', Children: [{ Ago: '2026-08-18T12:00:00Z' }] }],
      Acknowledged: [{ Key: 'ack-single', Subject: 'ack single', Children: [{ Ago: 'invalid' }] }]
    }});
    document.querySelector('[data-key="need-single"] .child-age').remove();
    api.refresh();
    return {
      first,
      updated: singleCountNode.textContent,
      acknowledgedFallback: document.querySelector('[data-key="ack-single"] .count').textContent,
      sameNodeAndHandler: countClicks === 1,
      checkboxPreserved: document.querySelector('[data-key="need-single"] input').checked
    };
  })()`);
  assert.deepStrictEqual(singleAlertAgeResult.first, {
    single: '43m-ago',
    multi: '2 alerts',
    unknown: '1 alerts',
    acknowledged: '2h-ago'
  });
  assert.strictEqual(singleAlertAgeResult.updated, '2d-ago');
  assert.strictEqual(singleAlertAgeResult.acknowledgedFallback, '1 alerts');
  assert.strictEqual(singleAlertAgeResult.sameNodeAndHandler, true);
  assert.strictEqual(singleAlertAgeResult.checkboxPreserved, true);

  let narrowGroupLayout;
  let wideGroupLayout;
  let checkboxBehavior;
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false
    });
    narrowGroupLayout = await evaluate(client, `(() => {
      ${stylesSource}
      BosunSilenceHiderStyles.injectStyles({
        hiddenClass: 'test-hidden',
        userCommentFilterHiddenClass: 'test-user-hidden',
        acknowledgedCollapsedClass: 'test-ack-collapsed',
        copyButtonClass: 'bosun-copy-alert-btn',
        copyAllButtonClass: 'bosun-copy-all-alerts-btn',
        copyLastActionButtonClass: 'test-copy-last-action',
        grafanaQueryButtonClass: 'test-grafana-query',
        noSelectClass: 'test-no-select',
        silencedBadgeClass: 'test-silenced',
        oldNoNoteIconClass: 'test-old-note',
        hasNoteIconClass: 'test-has-note',
        topBarId: 'test-top-bar',
        topBarStatusId: 'test-top-status',
        toggleId: 'test-toggle',
        toggleCounterId: 'test-toggle-counter',
        autoRefreshToggleId: 'test-auto-toggle',
        autoRefreshInputId: 'test-auto-input',
        autoRefreshCountdownId: 'test-auto-countdown',
        soundAlertsToggleId: 'test-sound-toggle',
        diagnosticsModalId: 'test-diagnostics-modal',
        diagnosticsLogListId: 'test-diagnostics-list'
      });
      document.body.innerHTML =
        '<style>' +
          'body{margin:8px;font:14px Arial,sans-serif}' +
          '.layout-root{width:calc(100vw - 16px)}' +
          '.panel-heading{padding:10px 15px;border:1px solid #ddd}' +
          '.panel-title{font-size:16px;line-height:1.2}' +
          '.panel-title>a{color:#333;text-decoration:none}' +
        '</style>' +
        '<button id="select-all-layout" type="button">Select all</button>' +
        '<div class="layout-root" ts-ack-group="schedule.Groups.Acknowledged">' +
          '<div class="panel-group"><div class="panel"><div class="panel-heading" id="age-heading"><div class="panel-title" id="age-title">' +
            '<label id="age-checkbox-label" class="pull-right select"><input id="age-checkbox" type="checkbox" aria-label="Select age group"></label>' +
            '<a href="#age"><span id="age-severity" class="fa fa-exclamation-circle" aria-hidden="true">!</span><span class="fa" aria-hidden="true"></span><span id="age-subject" ng-bind="group.Subject">warning: very long alert name with many descriptive words and identifiers that must be shortened on a narrow screen</span>' +
            '<button id="age-copy" class="bosun-copy-alert-btn">Копировать</button><span id="age-value" class="pull-right ng-binding">14h-ago</span></a>' +
          '</div></div></div></div>' +
        '</div>' +
        '<div class="layout-root" ts-ack-group="schedule.Groups.NeedAck">' +
          '<div class="panel-group"><div class="panel"><div class="panel-heading" id="count-heading"><div class="panel-title" id="count-title">' +
            '<label id="count-checkbox-label" class="pull-right select"><input id="count-checkbox" type="checkbox" aria-label="Select count group"></label>' +
            '<a href="#count"><span id="count-subject" ng-bind="group.Subject">critical: another extremely long grouped alert name with enough detail to require truncation at narrow widths</span>' +
            '<button id="count-copy" class="bosun-copy-alert-btn">Копировать</button><span id="count-value" class="pull-right ng-binding">6 alerts</span><button id="copy-all-layout" class="bosun-copy-all-alerts-btn">Копировать все</button></a>' +
          '</div></div></div></div>' +
        '</div>';

      globalThis.__measureBosunGroupLayout = () => {
        function measure(id) {
          const node = document.getElementById(id);
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const range = document.createRange();
          range.selectNodeContents(node);
          return {
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            fragmentCount: node.getClientRects().length,
            textRangeWidth: range.getBoundingClientRect().width,
            whiteSpace: style.whiteSpace,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            flexShrink: style.flexShrink,
            outlineWidth: style.outlineWidth,
            backgroundColor: style.backgroundColor
          };
        }
        return {
          ageHeading: measure('age-heading'),
          ageTitle: measure('age-title'),
          ageSeverity: measure('age-severity'),
          ageSubject: measure('age-subject'),
          ageCopy: measure('age-copy'),
          ageValue: measure('age-value'),
          ageCheckboxLabel: measure('age-checkbox-label'),
          ageCheckbox: measure('age-checkbox'),
          countHeading: measure('count-heading'),
          countTitle: measure('count-title'),
          countSubject: measure('count-subject'),
          countCopy: measure('count-copy'),
          countValue: measure('count-value'),
          countCheckboxLabel: measure('count-checkbox-label'),
          countCheckbox: measure('count-checkbox'),
          copyAll: measure('copy-all-layout')
        };
      };
      const originalAgeCheckbox = document.getElementById('age-checkbox');
      const originalCountCheckbox = document.getElementById('count-checkbox');
      ${pageUtilsSource}
      const checkboxPageUtils = BosunSilenceHiderPageUtils.createPageUtils();
      checkboxPageUtils.ensureDashboardGroupCheckboxHitAreaGuards();
      checkboxPageUtils.ensureDashboardGroupCheckboxHitAreaGuards();
      let headingClicks = 0;
      document.querySelectorAll('.panel-heading').forEach((heading) => {
        heading.addEventListener('click', () => { headingClicks += 1; });
      });
      document.querySelector('#age-title > a').addEventListener('click', (event) => event.preventDefault());
      for (const checkbox of [originalAgeCheckbox, originalCountCheckbox]) {
        checkbox.addEventListener('click', (event) => event.stopPropagation());
      }
      function hasCheckboxHoverRule(rules, insideHoverMedia = false) {
        for (const rule of Array.from(rules || [])) {
          const isHoverMedia = insideHoverMedia ||
            String(rule.media?.mediaText || '').includes('(hover: hover)');
          if (
            isHoverMedia &&
            rule.selectorText?.includes('label.pull-right.select:hover') &&
            Boolean(rule.style?.backgroundColor) &&
            rule.style.backgroundColor !== 'transparent'
          ) return true;
          if (rule.cssRules && hasCheckboxHoverRule(rule.cssRules, isHoverMedia)) return true;
        }
        return false;
      }
      const checkboxHoverRulePresent = hasCheckboxHoverRule(
        document.getElementById('bosun-silence-hider-styles')?.sheet?.cssRules
      );
      globalThis.__getBosunCheckboxState = () => {
        const ageCheckbox = document.getElementById('age-checkbox');
        const countCheckbox = document.getElementById('count-checkbox');
        const ageLabel = document.getElementById('age-checkbox-label');
        const headingStyle = getComputedStyle(document.querySelector('#age-title').parentElement);
        return {
          originalInputsPreserved: ageCheckbox === originalAgeCheckbox && countCheckbox === originalCountCheckbox,
          ageLabelSize: { width: ageLabel.getBoundingClientRect().width, height: ageLabel.getBoundingClientRect().height },
          ageInputSize: { width: ageCheckbox.getBoundingClientRect().width, height: ageCheckbox.getBoundingClientRect().height },
          ageChecked: ageCheckbox.checked,
          countChecked: countCheckbox.checked,
          outlineWidth: headingStyle.outlineWidth,
          outlineStyle: headingStyle.outlineStyle,
          labelBackground: getComputedStyle(ageLabel).backgroundColor,
          labelBoxShadow: getComputedStyle(ageLabel).boxShadow,
          hoverSupported: matchMedia('(hover: hover)').matches,
          hoverRulePresent: checkboxHoverRulePresent,
          headingClicks
        };
      };
      document.getElementById('select-all-layout').addEventListener('click', (event) => {
        const checked = event.currentTarget.dataset.checked !== 'true';
        event.currentTarget.dataset.checked = String(checked);
        for (const checkbox of [originalAgeCheckbox, originalCountCheckbox]) {
          checkbox.checked = checked;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      return __measureBosunGroupLayout();
    })()`);

    const labelRect = narrowGroupLayout.ageCheckboxLabel.rect;
    const hitAreaPoint = {
      x: labelRect.left + 2,
      y: labelRect.top + (labelRect.height / 2)
    };
    const hitAreaTarget = await evaluate(client, `(() => {
      const target = document.elementFromPoint(${hitAreaPoint.x}, ${hitAreaPoint.y});
      return { id: target?.id || '', tagName: target?.tagName || '' };
    })()`);
    async function clickCheckboxHitArea() {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y
      });
      await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y,
        button: 'left',
        clickCount: 1
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: hitAreaPoint.x,
        y: hitAreaPoint.y,
        button: 'left',
        clickCount: 1
      });
      await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await evaluate(client, `new Promise((resolve) => requestAnimationFrame(resolve))`);
    await evaluate(client, `document.querySelector('#age-title > a').click()`);
    const initialCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await clickCheckboxHitArea();
    const selectedCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await clickCheckboxHitArea();
    const uncheckedCheckboxState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('age-checkbox').focus()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    const keyboardCheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    });
    const keyboardUncheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('select-all-layout').click()`);
    const selectAllCheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    await evaluate(client, `document.getElementById('select-all-layout').click()`);
    const selectAllUncheckedState = await evaluate(client, `__getBosunCheckboxState()`);
    checkboxBehavior = {
      originalInputsPreserved: initialCheckboxState.originalInputsPreserved,
      hitAreaTarget,
      hitAreaOutsideInput: hitAreaPoint.x < narrowGroupLayout.ageCheckbox.rect.left,
      ageLabelSize: initialCheckboxState.ageLabelSize,
      ageInputSize: initialCheckboxState.ageInputSize,
      checkedAfterHitAreaClick: selectedCheckboxState.ageChecked,
      uncheckedAfterSecondClick: !uncheckedCheckboxState.ageChecked,
      hoverBackgroundChanged: selectedCheckboxState.labelBackground !== initialCheckboxState.labelBackground,
      hoverSupported: initialCheckboxState.hoverSupported,
      hoverRulePresent: initialCheckboxState.hoverRulePresent,
      checkedWithKeyboard: keyboardCheckedState.ageChecked,
      uncheckedWithKeyboard: !keyboardUncheckedState.ageChecked,
      keyboardFocusVisible: keyboardCheckedState.labelBoxShadow !== 'none',
      selectedOutlineWidth: selectedCheckboxState.outlineWidth,
      selectedOutlineStyle: selectedCheckboxState.outlineStyle,
      uncheckedOutlineStyle: uncheckedCheckboxState.outlineStyle,
      checkedAfterSelectAll: selectAllCheckedState.ageChecked && selectAllCheckedState.countChecked,
      uncheckedAfterSelectAll: !selectAllUncheckedState.ageChecked && !selectAllUncheckedState.countChecked,
      headingClicksBeforeHitArea: initialCheckboxState.headingClicks,
      headingClicksAfterInteractions: selectAllUncheckedState.headingClicks
    };

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    wideGroupLayout = await evaluate(client, `(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return __measureBosunGroupLayout();
    })()`);
  } finally {
    await client.send('Emulation.clearDeviceMetricsOverride');
  }

  function verticalOverlapRatio(first, second) {
    const overlap = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
    return overlap / Math.max(1, Math.min(first.height, second.height));
  }

  for (const value of [narrowGroupLayout.ageValue, narrowGroupLayout.countValue]) {
    assert.strictEqual(value.whiteSpace, 'nowrap');
    assert.strictEqual(value.flexShrink, '0');
    assert.strictEqual(value.fragmentCount, 1);
    assert.ok(value.rect.width + 1 >= value.textRangeWidth, 'Right-side text was clipped');
  }
  assert.strictEqual(checkboxBehavior.originalInputsPreserved, true);
  assert.strictEqual(checkboxBehavior.hitAreaTarget.id, 'age-checkbox-label');
  assert.strictEqual(checkboxBehavior.hitAreaOutsideInput, true);
  assert.ok(checkboxBehavior.ageLabelSize.width >= 27 && checkboxBehavior.ageLabelSize.height >= 27);
  assert.ok(checkboxBehavior.ageInputSize.width >= 15 && checkboxBehavior.ageInputSize.height >= 15);
  assert.ok(checkboxBehavior.ageLabelSize.width > checkboxBehavior.ageInputSize.width);
  assert.ok(narrowGroupLayout.ageTitle.rect.height < narrowGroupLayout.ageCheckboxLabel.rect.height);
  assert.ok(narrowGroupLayout.countTitle.rect.height < narrowGroupLayout.countCheckboxLabel.rect.height);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.top >= narrowGroupLayout.ageHeading.rect.top);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.bottom <= narrowGroupLayout.ageHeading.rect.bottom);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.top >= narrowGroupLayout.countHeading.rect.top);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.bottom <= narrowGroupLayout.countHeading.rect.bottom);
  assert.strictEqual(checkboxBehavior.checkedAfterHitAreaClick, true);
  assert.strictEqual(checkboxBehavior.uncheckedAfterSecondClick, true);
  assert.strictEqual(checkboxBehavior.hoverRulePresent, true);
  assert.strictEqual(
    checkboxBehavior.hoverBackgroundChanged,
    checkboxBehavior.hoverSupported,
    checkboxBehavior.hoverSupported
      ? 'Hover-capable browser did not show checkbox hit-area feedback'
      : 'Non-hover browser unexpectedly applied hover-only feedback'
  );
  assert.strictEqual(checkboxBehavior.checkedWithKeyboard, true);
  assert.strictEqual(checkboxBehavior.uncheckedWithKeyboard, true);
  assert.strictEqual(checkboxBehavior.keyboardFocusVisible, true);
  assert.strictEqual(checkboxBehavior.selectedOutlineWidth, '2px');
  assert.strictEqual(checkboxBehavior.selectedOutlineStyle, 'solid');
  assert.strictEqual(checkboxBehavior.uncheckedOutlineStyle, 'none');
  assert.strictEqual(checkboxBehavior.checkedAfterSelectAll, true);
  assert.strictEqual(checkboxBehavior.uncheckedAfterSelectAll, true);
  assert.strictEqual(checkboxBehavior.headingClicksBeforeHitArea, 1);
  assert.strictEqual(checkboxBehavior.headingClicksAfterInteractions, 1);
  for (const subject of [narrowGroupLayout.ageSubject, narrowGroupLayout.countSubject]) {
    assert.strictEqual(subject.whiteSpace, 'nowrap');
    assert.strictEqual(subject.overflow, 'hidden');
    assert.strictEqual(subject.textOverflow, 'ellipsis');
    assert.ok(subject.scrollWidth > subject.clientWidth + 1, 'Long subject was not truncated at narrow width');
    assert.strictEqual(subject.fragmentCount, 1);
  }
  assert.ok(verticalOverlapRatio(narrowGroupLayout.ageValue.rect, narrowGroupLayout.ageCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.countCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.ageValue.rect, narrowGroupLayout.ageCheckboxLabel.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.countCheckboxLabel.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(narrowGroupLayout.countValue.rect, narrowGroupLayout.copyAll.rect) >= 0.5);
  assert.ok(narrowGroupLayout.ageValue.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.countCheckbox.rect.right <= narrowGroupLayout.countTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.right <= narrowGroupLayout.ageTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.countCheckboxLabel.rect.right <= narrowGroupLayout.countTitle.rect.right + 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left <= narrowGroupLayout.ageCheckbox.rect.left);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.right >= narrowGroupLayout.ageCheckbox.rect.right);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.top <= narrowGroupLayout.ageCheckbox.rect.top);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.bottom >= narrowGroupLayout.ageCheckbox.rect.bottom);
  assert.ok(Math.abs(
    (narrowGroupLayout.ageCheckboxLabel.rect.left + narrowGroupLayout.ageCheckboxLabel.rect.width / 2) -
    (narrowGroupLayout.ageCheckbox.rect.left + narrowGroupLayout.ageCheckbox.rect.width / 2)
  ) <= 1);
  assert.ok(Math.abs(
    (narrowGroupLayout.ageCheckboxLabel.rect.top + narrowGroupLayout.ageCheckboxLabel.rect.height / 2) -
    (narrowGroupLayout.ageCheckbox.rect.top + narrowGroupLayout.ageCheckbox.rect.height / 2)
  ) <= 1);
  assert.ok(narrowGroupLayout.ageSubject.rect.right <= narrowGroupLayout.ageValue.rect.left + 1);
  assert.ok(narrowGroupLayout.countSubject.rect.right <= narrowGroupLayout.countValue.rect.left + 1);
  assert.ok(narrowGroupLayout.ageSubject.rect.left - narrowGroupLayout.ageSeverity.rect.right >= 3);
  assert.ok(narrowGroupLayout.ageSubject.rect.left - narrowGroupLayout.ageSeverity.rect.right <= 5);
  assert.ok(narrowGroupLayout.ageValue.rect.right <= narrowGroupLayout.ageCheckbox.rect.left + 1);
  assert.ok(narrowGroupLayout.ageValue.rect.left - narrowGroupLayout.ageCopy.rect.right >= 7);
  assert.ok(narrowGroupLayout.ageValue.rect.left - narrowGroupLayout.ageCopy.rect.right <= 10);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.left - narrowGroupLayout.ageValue.rect.right >= 7);
  assert.ok(narrowGroupLayout.ageCheckbox.rect.left - narrowGroupLayout.ageValue.rect.right <= 10);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left - narrowGroupLayout.ageValue.rect.right >= 1);
  assert.ok(narrowGroupLayout.ageCheckboxLabel.rect.left - narrowGroupLayout.ageValue.rect.right <= 3);
  assert.ok(narrowGroupLayout.countValue.rect.left - narrowGroupLayout.countCopy.rect.right >= 7);
  assert.ok(narrowGroupLayout.countValue.rect.left - narrowGroupLayout.countCopy.rect.right <= 10);
  assert.ok(narrowGroupLayout.countValue.rect.right <= narrowGroupLayout.copyAll.rect.left + 1);
  assert.ok(narrowGroupLayout.copyAll.rect.right <= narrowGroupLayout.countCheckbox.rect.left + 1);
  assert.ok(narrowGroupLayout.countCheckbox.rect.left - narrowGroupLayout.copyAll.rect.right >= 7);
  assert.ok(narrowGroupLayout.countCheckbox.rect.left - narrowGroupLayout.copyAll.rect.right <= 10);

  assert.ok(wideGroupLayout.ageSubject.rect.width > narrowGroupLayout.ageSubject.rect.width);
  assert.ok(wideGroupLayout.countSubject.rect.width > narrowGroupLayout.countSubject.rect.width);
  assert.ok(wideGroupLayout.ageSubject.scrollWidth <= wideGroupLayout.ageSubject.clientWidth + 1);
  assert.ok(wideGroupLayout.countSubject.scrollWidth <= wideGroupLayout.countSubject.clientWidth + 1);
  assert.ok(verticalOverlapRatio(wideGroupLayout.ageValue.rect, wideGroupLayout.ageCheckbox.rect) >= 0.5);
  assert.ok(verticalOverlapRatio(wideGroupLayout.countValue.rect, wideGroupLayout.countCheckbox.rect) >= 0.5);
  assert.ok(wideGroupLayout.ageValue.rect.left - wideGroupLayout.ageCopy.rect.right >= 7);
  assert.ok(wideGroupLayout.ageCheckbox.rect.left - wideGroupLayout.ageValue.rect.right >= 7);
  assert.ok(wideGroupLayout.countValue.rect.left - wideGroupLayout.countCopy.rect.right >= 7);
  assert.ok(wideGroupLayout.ageSubject.rect.left - wideGroupLayout.ageSeverity.rect.right >= 3);
  assert.ok(wideGroupLayout.ageSubject.rect.left - wideGroupLayout.ageSeverity.rect.right <= 5);
  assert.ok(Math.abs(wideGroupLayout.ageValue.rect.width - narrowGroupLayout.ageValue.rect.width) <= 2);
  assert.ok(Math.abs(wideGroupLayout.countValue.rect.width - narrowGroupLayout.countValue.rect.width) <= 2);
  assert.ok(Math.abs(wideGroupLayout.ageCheckboxLabel.rect.width - narrowGroupLayout.ageCheckboxLabel.rect.width) <= 1);
  assert.ok(Math.abs(wideGroupLayout.ageCheckbox.rect.width - narrowGroupLayout.ageCheckbox.rect.width) <= 1);

  const singleAlertLifecycleResult = await evaluate(client, `(async () => {
    const ageDebugLogs = [];
    const originalConsoleDebug = console.debug;
    console.debug = (prefix, details) => {
      if (prefix === '[BosunHelper][single-alert-age-problem]') ageDebugLogs.push(details);
      else originalConsoleDebug.call(console, prefix, details);
    };
    history.replaceState({}, '', '/');
    document.body.innerHTML =
      '<div id="need-root" ts-ack-group="schedule.Groups.NeedAck"><div class="panel-group"></div></div>' +
      '<div id="ack-root" ts-ack-group="schedule.Groups.Acknowledged"><div class="panel-group"></div></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const createSingleAlertAgeForDiagnostics = BosunHelperSingleAlertAge.createSingleAlertAge;
    BosunHelperSingleAlertAge.createSingleAlertAge = (options) =>
      createSingleAlertAgeForDiagnostics({ ...options, debug: true });
    globalThis.BosunSilenceHiderPageUtils = {
      createPageUtils() {
        return {
          isDashboardHome: () => location.pathname === '/',
          isActionPage: () => false,
          applyActionPageTweaks() {}
        };
      }
    };
    let refreshRequests = 0;
    globalThis.BosunHelperRefreshCoordinator = {
      createRefreshCoordinator() {
        return {
          start() {}, stop() {},
          requestRefresh() { refreshRequests += 1; }
        };
      }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const ago43m = new Date(Date.now() - 43 * 60 * 1000).toISOString();
    const ago2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const snapshot = { Groups: {
      NeedAck: [
        { Subject: 'existing single', Children: [{ Ago: ago43m, State: { Id: 901 } }] },
        { Subject: 'late single', Children: [{ Ago: ago43m, State: { Id: 902 } }] },
        { Subject: 'multi', Children: [{ Ago: ago43m, State: { Id: 903 } }, { Ago: ago2h, State: { Id: 904 } }] },
        { Subject: 'duplicate', Children: [{ Ago: ago43m, State: { Id: 905 } }] },
        { Subject: 'duplicate', Children: [{ Ago: ago2h, State: { Id: 906 } }] }
      ],
      Acknowledged: [
        { Subject: 'ack single', Children: [{ Ago: ago2h, State: { Id: 907 } }] }
      ]
    }};

    hooks.applyAlertsPayload(snapshot, { source: 'follower' });
    hooks.startObserver();

    function createGroup(subject, count, id) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = id;
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      const title = document.createElement('div');
      title.className = 'panel-title';
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'group.Subject');
      subjectNode.textContent = subject;
      const countNode = document.createElement('span');
      countNode.className = 'pull-right ng-binding';
      countNode.textContent = count + ' alerts';
      title.append(subjectNode, countNode);
      heading.appendChild(title);
      panel.appendChild(heading);
      return panel;
    }

    const needGroup = document.querySelector('#need-root .panel-group');
    const ackGroup = document.querySelector('#ack-root .panel-group');
    needGroup.append(
      createGroup('existing single', 1, 'existing-single'),
      createGroup('multi', 2, 'multi-group'),
      createGroup('duplicate', 1, 'ambiguous-group')
    );
    ackGroup.appendChild(createGroup('ack single', 1, 'ack-single'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const firstPass = {
      single: document.querySelector('#existing-single .pull-right').textContent,
      multi: document.querySelector('#multi-group .pull-right').textContent,
      acknowledged: document.querySelector('#ack-single .pull-right').textContent,
      ambiguous: document.querySelector('#ambiguous-group .pull-right').textContent
    };
    const requestsAfterInitialDom = refreshRequests;

    needGroup.appendChild(createGroup('late single', 1, 'late-single'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lateAge = document.querySelector('#late-single .pull-right').textContent;
    const normalMutationLogCount = ageDebugLogs.length;

    hooks.resetLifecycleCounters();
    const extensionManagedSubject = document.querySelector('#existing-single [ng-bind="group.Subject"]');
    for (let index = 0; index < 100; index += 1) {
      hooks.setExtensionClass(extensionManagedSubject, 'bosun-no-select', true);
      hooks.setExtensionClass(extensionManagedSubject, 'bosun-no-select', false);
    }
    await Promise.resolve();
    await Promise.resolve();
    const extensionMutationCounters = hooks.getLifecycleCounters();

    const externallyResetCount = document.querySelector('#multi-group .pull-right');
    hooks.setExtensionClass(externallyResetCount, 'bosun-no-select', true);
    await Promise.resolve();
    await Promise.resolve();
    hooks.resetLifecycleCounters();
    externallyResetCount.classList.remove('bosun-no-select');
    await Promise.resolve();
    await Promise.resolve();
    const externalClassResetCounters = hooks.getLifecycleCounters();

    hooks.resetLifecycleCounters();
    const unrelatedNode = document.createElement('span');
    unrelatedNode.textContent = 'unrelated';
    document.body.appendChild(unrelatedNode);
    await Promise.resolve();
    await Promise.resolve();
    const unrelatedMutationCounters = hooks.getLifecycleCounters();

    hooks.applyAlertsPayload({ Groups: { NeedAck: [], Acknowledged: [] } }, { source: 'follower' });
    const preservedAfterMissing = {
      existing: document.querySelector('#existing-single .pull-right').textContent,
      late: document.querySelector('#late-single .pull-right').textContent,
      acknowledged: document.querySelector('#ack-single .pull-right').textContent,
      multi: document.querySelector('#multi-group .pull-right').textContent,
      ambiguous: document.querySelector('#ambiguous-group .pull-right').textContent,
      historyEntries: hooks.singleAlertAge?.getHistoryStats?.().entries ?? null
    };

    const existingCount = document.querySelector('#existing-single .pull-right');
    const requestsBeforeReset = refreshRequests;
    existingCount.textContent = '1 alerts';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restoredAfterTextReset = existingCount.textContent;
    const resetTriggeredFetch = refreshRequests !== requestsBeforeReset;
    const resetLogCount = ageDebugLogs.length;
    const resetLog = ageDebugLogs[0] || null;

    const replacement = document.createElement('span');
    replacement.className = 'pull-right ng-binding';
    replacement.textContent = '1 alerts';
    existingCount.replaceWith(replacement);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restoredReplacement = replacement.textContent;

    hooks.applyAlertsPayload({ Groups: {
      NeedAck: [{ Subject: 'existing single', Children: [{ Ago: ago2h, State: { Id: 901 } }] }],
      Acknowledged: []
    }}, { source: 'follower' });
    const updatedFromSnapshot = replacement.textContent;

    for (let index = 0; index < 25; index += 1) {
      replacement.textContent = '1 alerts';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const primitiveLogsOnly = ageDebugLogs.every((entry) => (
      entry &&
      Object.getPrototypeOf(entry) === Object.prototype &&
      Object.values(entry).every((value) => (
        value === null || ['string', 'number', 'boolean'].includes(typeof value)
      ))
    ));
    const forbiddenDiagnosticKeys = ['mutation', 'target', 'addedNodes', 'removedNodes', 'payload', 'snapshot'];
    const forbiddenKeysAbsent = ageDebugLogs.every((entry) => (
      forbiddenDiagnosticKeys.every((key) => !Object.prototype.hasOwnProperty.call(entry, key))
    ));
    console.debug = originalConsoleDebug;
    return {
      firstPass,
      lateAge,
      preservedAfterMissing,
      restoredAfterTextReset,
      restoredReplacement,
      updatedFromSnapshot,
      resetTriggeredFetch,
      requestsAfterInitialDom,
      totalRefreshRequests: refreshRequests,
      extensionMutationCounters,
      externalClassResetCounters,
      unrelatedMutationCounters,
      normalMutationLogCount,
      resetLogCount,
      resetLog,
      debugLogCount: ageDebugLogs.length,
      debugMaxProblems: BosunHelperSingleAlertAge.SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS,
      primitiveLogsOnly,
      forbiddenKeysAbsent
    };
  })()`);
  assert.deepStrictEqual(singleAlertLifecycleResult.firstPass, {
    single: '43m-ago',
    multi: '2 alerts',
    acknowledged: '2h-ago',
    ambiguous: '1 alerts'
  });
  assert.strictEqual(singleAlertLifecycleResult.lateAge, '43m-ago');
  assert.deepStrictEqual(singleAlertLifecycleResult.preservedAfterMissing, {
    existing: '43m-ago',
    late: '43m-ago',
    acknowledged: '2h-ago',
    multi: '2 alerts',
    ambiguous: '1 alerts',
    historyEntries: 3
  });
  assert.strictEqual(singleAlertLifecycleResult.restoredAfterTextReset, '43m-ago');
  assert.strictEqual(singleAlertLifecycleResult.restoredReplacement, '43m-ago');
  assert.strictEqual(singleAlertLifecycleResult.updatedFromSnapshot, '2h-ago');
  assert.strictEqual(singleAlertLifecycleResult.resetTriggeredFetch, false);
  assert.ok(singleAlertLifecycleResult.requestsAfterInitialDom <= 1);
  assert.ok(singleAlertLifecycleResult.totalRefreshRequests <= 3, 'MutationObserver entered a refresh loop');
  assert.deepStrictEqual(
    singleAlertLifecycleResult.extensionMutationCounters,
    { domRefreshes: 0, dataRefreshes: 0 },
    'Extension-managed class mutations must not schedule a full DOM or data refresh'
  );
  assert.deepStrictEqual(
    singleAlertLifecycleResult.externalClassResetCounters,
    { domRefreshes: 1, dataRefreshes: 0 },
    'External removal of an extension class must schedule one repaint'
  );
  assert.deepStrictEqual(
    singleAlertLifecycleResult.unrelatedMutationCounters,
    { domRefreshes: 0, dataRefreshes: 0 },
    'Mutation outside scoped alert roots must not schedule refresh work'
  );
  assert.strictEqual(singleAlertLifecycleResult.normalMutationLogCount, 0);
  assert.strictEqual(singleAlertLifecycleResult.resetLogCount, 1);
  assert.deepStrictEqual({
    event: singleAlertLifecycleResult.resetLog.event,
    section: singleAlertLifecycleResult.resetLog.section,
    previousText: singleAlertLifecycleResult.resetLog.previousText,
    currentText: singleAlertLifecycleResult.resetLog.currentText,
    expectedText: singleAlertLifecycleResult.resetLog.expectedText,
    snapshotMatches: singleAlertLifecycleResult.resetLog.snapshotMatches,
    matchingResult: singleAlertLifecycleResult.resetLog.matchingResult,
    matchingReason: singleAlertLifecycleResult.resetLog.matchingReason,
    decision: singleAlertLifecycleResult.resetLog.decision,
    consideredOwn: singleAlertLifecycleResult.resetLog.consideredOwn,
    observerTriggered: singleAlertLifecycleResult.resetLog.observerTriggered,
    repaintAttempted: singleAlertLifecycleResult.resetLog.repaintAttempted,
    repaintResult: singleAlertLifecycleResult.resetLog.repaintResult,
    finalTextAfterRepaint: singleAlertLifecycleResult.resetLog.finalTextAfterRepaint
  }, {
    event: 'age-reset-to-counter',
    section: 'NeedAck',
    previousText: '43m-ago',
    currentText: '1 alerts',
    expectedText: '43m-ago',
    snapshotMatches: 0,
    matchingResult: 'no-match',
    matchingReason: 'missing-candidate',
    decision: 'preserve-last-valid-match',
    consideredOwn: false,
    observerTriggered: true,
    repaintAttempted: true,
    repaintResult: 'set-age',
    finalTextAfterRepaint: '43m-ago'
  });
  assert.strictEqual(singleAlertLifecycleResult.debugMaxProblems, 20);
  assert.strictEqual(singleAlertLifecycleResult.debugLogCount, 20);
  assert.strictEqual(singleAlertLifecycleResult.primitiveLogsOnly, true);
  assert.strictEqual(singleAlertLifecycleResult.forbiddenKeysAbsent, true);

  const ambiguousGrafanaIdentityResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${promqlSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    function childPanel(id, subject, ago) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      if (id) {
        const idNode = document.createElement('span');
        idNode.setAttribute('ng-show', 'state.Id');
        idNode.textContent = '#' + id;
        heading.appendChild(idNode);
      }
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subjectNode.textContent = subject;
      heading.appendChild(subjectNode);
      const agoNode = document.createElement('span');
      agoNode.setAttribute('ts-since', 'child.Ago');
      agoNode.textContent = ago;
      heading.appendChild(agoNode);
      panel.appendChild(heading);
      return panel;
    }

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'id group',
      Children: [
        { Subject: 'first', Ago: '1m', State: { Id: 42, Expr: "promras('''first_metric''')" } },
        { Subject: 'second', Ago: '2m', State: { Id: 42, Expr: "promras('''second_metric''')" } }
      ]
    }] } });
    const duplicateIdQuery = hooks.getGrafanaQueryForPanel(childPanel('42', 'first', '1m'));

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'same group',
      Children: [
        { Subject: 'same child', Ago: '1m', Expr: "promras('''first_metric''')" },
        { Subject: 'same child', Ago: '1m', Expr: "promras('''second_metric''')" }
      ]
    }] } });
    const groupPanel = document.createElement('div');
    groupPanel.className = 'panel';
    const groupHeading = document.createElement('div');
    groupHeading.className = 'panel-heading';
    const groupSubject = document.createElement('span');
    groupSubject.setAttribute('ng-bind', 'group.Subject');
    groupSubject.textContent = 'same group';
    groupHeading.appendChild(groupSubject);
    groupPanel.appendChild(groupHeading);
    const duplicateKeyPanel = childPanel('', 'same child', '1m');
    groupPanel.appendChild(duplicateKeyPanel);
    const duplicateKeyQuery = hooks.getGrafanaQueryForPanel(duplicateKeyPanel);

    hooks.rebuildGrafanaQueryIndex({ Groups: { NeedAck: [{
      Subject: 'unique group',
      Children: [{
        Subject: 'unique child',
        AlertKey: 'unique.alert{host=web-1}',
        Ago: '3m',
        State: {
          Id: 77,
          AlertKey: 'unique.alert{host=web-1}',
          Tags: 'host=web-1',
          Expr: "promras('''unique_metric''', '2m', '2h', '')"
        }
      }]
    }] } });
    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const uniquePanel = childPanel('77', 'unique child', '3m');
    uniquePanel.querySelector('.panel-heading').setAttribute('ng-click', 'toggle()');
    root.appendChild(uniquePanel);
    document.body.appendChild(root);
    hooks.ensureGrafanaQueryButtons();
    return {
      duplicateIdQuery,
      duplicateKeyQuery,
      grafanaDefaultEnabled: hooks.isFeatureEnabled('grafanaIntegration'),
      uniqueButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
    };
  })()`);
  assert.deepStrictEqual(ambiguousGrafanaIdentityResult, {
    duplicateIdQuery: '',
    duplicateKeyQuery: '',
    grafanaDefaultEnabled: true,
    uniqueButtonCount: 1
  });

  const usageGraphResolverResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const directConfig = ${JSON.stringify(`alert imsi.channel.success.response.percent.low {
  $q_pct = promras(''' sum by(zone,name)(rr_imsi_success_response_percent) ''', '5m', '2h', '')
  $usage_graph = $q_pct
  warn = $q_pct < 90
}`)};
    let activeHash = 'DIRECT-H1';
    let activeConfig = directConfig;
    let configFails = false;
    let configNetworkFails = false;
    let releaseDirectConfig;
    const directConfigGate = new Promise((resolve) => { releaseDirectConfig = resolve; });
    let waitForDirectConfig = true;
    let configFetchCount = 0;
    let hashFetchCount = 0;
    let releaseScheduledHash;
    const scheduledHashGate = new Promise((resolve) => { releaseScheduledHash = resolve; });
    let waitForScheduledHash = false;
    let syntheticNowOffset = 0;
    const nativeDateNow = Date.now;
    Date.now = () => nativeDateNow() + syntheticNowOffset;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        hashFetchCount += 1;
        if (waitForScheduledHash) await scheduledHashGate;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: activeHash }),
          json: async () => ({ Hash: activeHash })
        };
      }
      if (url === '/api/config?hash=') {
        configFetchCount += 1;
        if (waitForDirectConfig) await directConfigGate;
        if (configNetworkFails) throw new Error('synthetic config network failure');
        if (configFails) {
          return { ok: false, status: 500, headers: { get() { return null; } } };
        }
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => activeConfig
        };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };
    ${promqlSource}
    ${ruleGraphSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const panel = document.createElement('div');
    panel.className = 'panel';
    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    heading.setAttribute('ng-click', 'toggle()');
    const idNode = document.createElement('span');
    idNode.setAttribute('ng-show', 'state.Id');
    idNode.textContent = '#701';
    heading.appendChild(idNode);
    const subjectNode = document.createElement('span');
    subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
    subjectNode.textContent = 'imsi.channel.success.response.percent.low{name=bercut1,zone=smssrv28}';
    heading.appendChild(subjectNode);
    const agoNode = document.createElement('span');
    agoNode.setAttribute('ts-since', 'child.Ago');
    agoNode.textContent = '3m';
    heading.appendChild(agoNode);
    panel.appendChild(heading);
    root.appendChild(panel);
    document.body.appendChild(root);

    const payload = { Groups: { NeedAck: [{
      Subject: 'synthetic group',
      Children: [{
        Alert: 'imsi.channel.success.response.percent.low',
        AlertKey: 'imsi.channel.success.response.percent.low{name=bercut1,zone=smssrv28}',
        Subject: 'imsi.channel.success.response.percent.low{name=bercut1,zone=smssrv28}',
        Ago: '3m',
        State: {
          Id: 701,
          Alert: 'imsi.channel.success.response.percent.low',
          AlertKey: 'imsi.channel.success.response.percent.low{name=bercut1,zone=smssrv28}',
          Tags: 'name=bercut1,zone=smssrv28',
          Expr: "promras('''sum(rate(non_authoritative_total[5m]))''', '5m', '2h', '')"
        }
      }]
    }] } };
    hooks.applyAlertsPayload(payload);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const pendingQuery = hooks.getGrafanaQueryForPanel(panel);
    const buttonsWhileConfigPending = root.querySelectorAll('.bosun-grafana-query-btn').length;
    hooks.applyAlertsPayload(payload);
    waitForDirectConfig = false;
    releaseDirectConfig();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const directQuery = hooks.getGrafanaQueryForPanel(panel);
    const directButtons = root.querySelectorAll('.bosun-grafana-query-btn').length;
    const directConfigFetchCount = configFetchCount;
    const directHashFetchCount = hashFetchCount;
    hooks.applyAlertsPayload(payload);
    const cachedQueryDuringFreshInterval = hooks.getGrafanaQueryForPanel(panel);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const cachedHashFetchCount = hashFetchCount;
    syntheticNowOffset = 16000;
    waitForScheduledHash = true;
    hooks.applyAlertsPayload(payload);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const queryDuringUnchangedHashCheck = hooks.getGrafanaQueryForPanel(panel);
    waitForScheduledHash = false;
    releaseScheduledHash();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const queryAfterUnchangedHashCheck = hooks.getGrafanaQueryForPanel(panel);
    const unchangedHashFetchCount = hashFetchCount;

    activeHash = 'MULTI-H2';
    activeConfig = ${JSON.stringify(`alert imsi.channel.success.response.percent.low {
  $q1 = promras('''sum(rate(first_total[5m]))''', '5m', '2h', '')
  $q2 = promras('''sum(rate(second_total[5m]))''', '5m', '2h', '')
  $usage_graph = merge(addtags($q1, "side=first"), addtags($q2, "side=second"))
  warn = $q1 > 0
}`)};
    const multiRefresh = hooks.ruleGraphResolver.refresh(
      ['imsi.channel.success.response.percent.low'],
      { force: true }
    );
    const queryDuringHashCheck = hooks.getGrafanaQueryForPanel(panel);
    await multiRefresh;
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const rejectedQuery = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterUnsupportedHash = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'FAIL-H3';
    configFails = true;
    payload.Groups.NeedAck[0].Children[0].State.Expr =
      "promras('''sum(rate(fallback_total[5m]))''', '5m', '2h', '')";
    await hooks.ruleGraphResolver.refresh(['imsi.channel.success.response.percent.low'], { force: true });
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const safeFailureFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterSafeFallback = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'NETWORK-H4';
    configFails = false;
    configNetworkFails = true;
    await hooks.ruleGraphResolver.refresh(['imsi.channel.success.response.percent.low'], { force: true });
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const safeNetworkFailureFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterNetworkFallback = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'MALFORMED-H5';
    configNetworkFails = false;
    activeConfig = 'alert imsi.channel.success.response.percent.low {\\n  $usage_graph = promras(';
    const malformedSnapshot = await hooks.ruleGraphResolver.refresh(
      ['imsi.channel.success.response.percent.low'],
      { force: true }
    );
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const malformedRuleFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterMalformedRule = root.querySelectorAll('.bosun-grafana-query-btn').length;

    payload.Groups.NeedAck[0].Children[0].State.Alert = 'synthetic.conflicting.identity';
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    return {
      pendingQuery,
      buttonsWhileConfigPending,
      directQuery,
      directButtons,
      directConfigFetchCount,
      directHashFetchCount,
      cachedQueryDuringFreshInterval,
      cachedHashFetchCount,
      queryDuringUnchangedHashCheck,
      queryAfterUnchangedHashCheck,
      unchangedHashFetchCount,
      queryDuringHashCheck,
      rejectedQuery,
      buttonsAfterUnsupportedHash,
      safeFailureFallback,
      buttonsAfterSafeFallback,
      safeNetworkFailureFallback,
      buttonsAfterNetworkFallback,
      malformedSnapshotReason: malformedSnapshot.reason,
      malformedRuleFallback,
      buttonsAfterMalformedRule,
      conflictingIdentityQuery: hooks.getGrafanaQueryForPanel(panel),
      buttonsAfterConflictingIdentity: root.querySelectorAll('.bosun-grafana-query-btn').length
    };
  })()`);
  assert.deepStrictEqual(usageGraphResolverResult, {
    pendingQuery: '',
    buttonsWhileConfigPending: 0,
    directQuery: 'sum by(zone,name)(rr_imsi_success_response_percent{name="bercut1", zone="smssrv28"})',
    directButtons: 1,
    directConfigFetchCount: 1,
    directHashFetchCount: 2,
    cachedQueryDuringFreshInterval: 'sum by(zone,name)(rr_imsi_success_response_percent{name="bercut1", zone="smssrv28"})',
    cachedHashFetchCount: 2,
    queryDuringUnchangedHashCheck: 'sum by(zone,name)(rr_imsi_success_response_percent{name="bercut1", zone="smssrv28"})',
    queryAfterUnchangedHashCheck: 'sum by(zone,name)(rr_imsi_success_response_percent{name="bercut1", zone="smssrv28"})',
    unchangedHashFetchCount: 3,
    queryDuringHashCheck: '',
    rejectedQuery: '',
    buttonsAfterUnsupportedHash: 0,
    safeFailureFallback: 'sum(rate(fallback_total{name="bercut1", zone="smssrv28"}[5m]))',
    buttonsAfterSafeFallback: 1,
    safeNetworkFailureFallback: 'sum(rate(fallback_total{name="bercut1", zone="smssrv28"}[5m]))',
    buttonsAfterNetworkFallback: 1,
    malformedSnapshotReason: 'rule_index_unavailable',
    malformedRuleFallback: '',
    buttonsAfterMalformedRule: 0,
    conflictingIdentityQuery: '',
    buttonsAfterConflictingIdentity: 0
  });

  const concurrentRuleSnapshotResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const names = Array.from({ length: 20 }, (_unused, index) => 'synthetic.browser.concurrent.' + index);
    const configText = names.map((name, index) => [
      'alert ' + name + ' {',
      "  $usage_graph = promras('''browser_concurrent_metric_" + index + "''', '5m', '2h', '')",
      '  warn = 1',
      '}'
    ].join('\\n')).join('\\n\\n');
    let configFetchCount = 0;
    let hashFetchCount = 0;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        hashFetchCount += 1;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: 'BROWSER-CONCURRENT-H1' })
        };
      }
      if (url === '/api/config?hash=') {
        configFetchCount += 1;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => configText
        };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };
    ${promqlSource}
    ${ruleGraphSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    await Promise.all(names.map((name) => hooks.ruleGraphResolver.refresh([name])));

    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const children = names.map((name, index) => {
      const alertKey = name + '{zone=z' + index + '}';
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      heading.setAttribute('ng-click', 'toggle()');
      const idNode = document.createElement('span');
      idNode.setAttribute('ng-show', 'state.Id');
      idNode.textContent = '#' + (800 + index);
      heading.appendChild(idNode);
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subjectNode.textContent = alertKey;
      heading.appendChild(subjectNode);
      const agoNode = document.createElement('span');
      agoNode.setAttribute('ts-since', 'child.Ago');
      agoNode.textContent = '1m';
      heading.appendChild(agoNode);
      panel.appendChild(heading);
      root.appendChild(panel);
      return {
        Alert: name,
        AlertKey: alertKey,
        Subject: alertKey,
        Ago: '1m',
        State: {
          Id: 800 + index,
          Alert: name,
          AlertKey: alertKey,
          Tags: 'zone=z' + index,
          Expr: ''
        }
      };
    });
    document.body.appendChild(root);
    const payload = { Groups: { NeedAck: [{ Subject: 'concurrent group', Children: children }] } };
    hooks.applyAlertsPayload(payload);
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    return {
      configFetchCount,
      hashFetchCount,
      actionCount: root.querySelectorAll('.bosun-grafana-query-btn').length,
      allQueriesPresent: Array.from(root.querySelectorAll('.panel')).every((panel, index) => {
        return hooks.getGrafanaQueryForPanel(panel) ===
          'browser_concurrent_metric_' + index + '{zone="z' + index + '"}';
      })
    };
  })()`);
  assert.deepStrictEqual(concurrentRuleSnapshotResult, {
    configFetchCount: 1,
    hashFetchCount: 2,
    actionCount: 20,
    allQueriesPresent: true
  });

  const settingsLifecycleResult = await evaluate(client, `(() => {
    history.replaceState({}, '', '/');
    document.body.innerHTML =
      '<button class="bosun-copy-alert-btn"></button>' +
      '<button class="bosun-copy-all-alerts-btn"></button>' +
      '<button class="bosun-copy-last-action-btn"></button>' +
      '<button class="bosun-grafana-query-btn"></button>' +
      '<div class="bosun-silence-hidden"><span class="bosun-silenced-badge"></span></div>' +
      '<div class="bosun-user-comment-hidden"></div>' +
      '<div class="bosun-acknowledged-collapsed"></div>' +
      '<div id="bosun-new-alerts-notice"></div>' +
      '<div class="bosun-sound-alerts-wrap"></div>' +
      '<div class="bosun-auto-refresh-group"></div>' +
      '<div class="bosun-action-templates"></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('copyButtons', false);
    const independentAfterCopyDisable = {
      copy: document.querySelectorAll('.bosun-copy-alert-btn, .bosun-copy-all-alerts-btn').length,
      lastAction: document.querySelectorAll('.bosun-copy-last-action-btn').length,
      grafana: document.querySelectorAll('.bosun-grafana-query-btn').length
    };
    hooks.setFeature('grafanaIntegration', false);
    hooks.setFeature('silencedFilter', false);
    hooks.setFeature('noCommentFilter', false);
    hooks.setFeature('acknowledgedCollapse', false);
    hooks.setFeature('soundNotifications', false);
    hooks.setFeature('visualNewAlertNotifications', false);
    hooks.setFeature('autoRefresh', false);
    hooks.setFeature('actionTemplates', false);
    hooks.setFeature('checkboxImprovements', false);
    const disabled = {
      grafana: document.querySelectorAll('.bosun-grafana-query-btn').length,
      hidden: document.querySelectorAll('.bosun-silence-hidden').length,
      silencedBadge: document.querySelectorAll('.bosun-silenced-badge').length,
      noComment: document.querySelectorAll('.bosun-user-comment-hidden').length,
      acknowledged: document.querySelectorAll('.bosun-acknowledged-collapsed').length,
      sound: document.querySelectorAll('.bosun-sound-alerts-wrap').length,
      visual: document.querySelectorAll('#bosun-new-alerts-notice').length,
      autoRefresh: document.querySelectorAll('.bosun-auto-refresh-group').length,
      actionTemplates: document.querySelectorAll('.bosun-action-templates').length,
      checkboxStyleDisabled: document.body.classList.contains('bosun-checkbox-improvements-disabled')
    };
    hooks.setFeature('checkboxImprovements', true);
    hooks.setFeature('lastActionEnhancements', false);
    return {
      independentAfterCopyDisable,
      disabled,
      checkboxStyleReenabled: !document.body.classList.contains('bosun-checkbox-improvements-disabled'),
      lastActionRequiresReload: document.querySelectorAll('.bosun-copy-last-action-btn').length === 1
    };
  })()`);
  assert.deepStrictEqual(settingsLifecycleResult, {
    independentAfterCopyDisable: { copy: 0, lastAction: 1, grafana: 1 },
    disabled: {
      grafana: 0,
      hidden: 0,
      silencedBadge: 0,
      noComment: 0,
      acknowledged: 0,
      sound: 0,
      visual: 0,
      autoRefresh: 0,
      actionTemplates: 0,
      checkboxStyleDisabled: true
    },
    checkboxStyleReenabled: true,
    lastActionRequiresReload: true
  });

  const soundVisualIndependence = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    const trackerAdds = [];
    const played = [];
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunSilenceHiderNeedAckSeverity = {
      createNeedAckSeverity() {
        return {
          collectCurrentIdsAndSeverity(payload) {
            const currentIds = new Set();
            const idToSeverity = new Map();
            for (const group of payload?.Groups?.NeedAck || []) {
              for (const child of group.Children || []) {
                const id = String(child.State.Id);
                currentIds.add(id);
                idToSeverity.set(id, 'warning');
              }
            }
            return { currentIds, idToSeverity };
          },
          needAckStableKey(child) { return String(child?.State?.Id || ''); },
          needAckGroupStableKey() { return ''; }
        };
      }
    };
    globalThis.BosunSilenceHiderSound = {
      createSound() {
        return {
          playNeedAckChime(kind) { played.push(kind); },
          destroy() {}, installAudioUnlockTracking() {}, ensureAudioObjects() {}
        };
      }
    };
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() {}, destroy() {}, reconcile() {},
          add(ids) { trackerAdds.push(ids.slice()); }
        };
      }
    };
    ${needAckBaselineSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const payload = (ids) => ({ Groups: { NeedAck: [{
      Subject: 'group',
      Children: ids.map((id) => ({ Subject: 'alert-' + id, State: { Id: id } }))
    }] } });
    hooks.applyAlertsPayload(payload(['A']), { source: 'leader' });
    hooks.setPreference('soundEnabled', false);
    hooks.applyAlertsPayload(payload(['A', 'B']), { source: 'leader' });
    await Promise.resolve();
    return { trackerAdds, played };
  })()`);
  assert.deepStrictEqual(soundVisualIndependence, { trackerAdds: [['B']], played: [] });

  const visualTrackerLifecycle = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    const calls = { start: 0, destroy: 0, add: 0, reconcile: [] };
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() { calls.start += 1; return Promise.resolve(); },
          destroy() { calls.destroy += 1; },
          add() { calls.add += 1; },
          reconcile(payload) { calls.reconcile.push(payload.marker); }
        };
      }
    };
    globalThis.BosunSilenceHiderNeedAckBaseline = {
      createNeedAckBaseline() { return { process() {}, reset() {}, restoreFromSession() {} }; }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('visualNewAlertNotifications', false);
    hooks.applyAlertsPayload({ marker: 'latest', Groups: { NeedAck: [] } }, { source: 'leader' });
    hooks.setFeature('visualNewAlertNotifications', true);
    await Promise.resolve();
    await Promise.resolve();
    return calls;
  })()`);
  assert.deepStrictEqual(visualTrackerLifecycle, {
    start: 1,
    destroy: 1,
    add: 0,
    reconcile: ['latest']
  });

  const checkboxActionGate = await evaluate(client, `(() => {
    history.replaceState({}, '', '/action?type=note');
    document.body.innerHTML = '<input id="notify" type="checkbox" ng-model="state.Notify" checked>';
    const notify = document.querySelector('#notify');
    let clicks = 0;
    notify.addEventListener('click', () => { clicks += 1; });
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    ${pageUtilsSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    hooks.setFeature('checkboxImprovements', false);
    hooks.applyActionPageTweaks();
    return { checked: notify.checked, clicks };
  })()`);
  assert.deepStrictEqual(checkboxActionGate, { checked: true, clicks: 0 });

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

  const accessibilityResult = await evaluate(client, `(() => {
    document.body.innerHTML = '<div id="actions"></div><div id="child-title"></div>' +
      '<div id="last-action">Note by operator at <span ts-time="state.LastAction.Time">' +
      '<a href="https://www.timeanddate.com/worldclock/converter.html">now</a></span>: ' +
      '<span ng-show="state.LastAction.Message">: первая строка<br>' +
      'https://example.test/runbook.<br>третья строка</span></div>' +
      '<div><span id="invalid-last-action-url" ng-show="state.LastAction.Message">http://.</span></div>' +
      '<div class="container" style="width: 95%"></div>' +
      '<div id="group" class="panel"><div class="panel-heading"><div class="panel-title"></div></div></div>';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    const trackerReconciles = [];
    globalThis.BosunHelperNewAlertTracker = {
      createNewAlertTracker() {
        return {
          start() {},
          add() {},
          reconcile(payload) { trackerReconciles.push(payload); }
        };
      }
    };
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const lastActionMessage = document.querySelector('[ng-show="state.LastAction.Message"]');
    hooks.ensureLastActionCopyButtons();
    const lastActionTime = document.querySelector('[ts-time="state.LastAction.Time"]');
    const lastActionTimeState = {
      hasLink: Boolean(lastActionTime.querySelector('a')),
      text: lastActionTime.textContent,
      replacementClass: lastActionTime.firstElementChild?.className,
      color: lastActionTime.firstElementChild?.style.color
    };
    const invalidUrlMessage = document.querySelector('#invalid-last-action-url');
    const invalidUrlTextNode = invalidUrlMessage.firstChild;
    hooks.ensureLastActionCopyButtons();
    const invalidUrlStayedStable =
      invalidUrlMessage.firstChild === invalidUrlTextNode &&
      !invalidUrlMessage.querySelector('a');
    const lastActionCopyButton = document.querySelector('.bosun-copy-last-action-btn');
    const lastActionLink = lastActionMessage.querySelector('.bosun-last-action-link');
    const lastActionCopy = {
      text: hooks.getLastActionMessageText(lastActionMessage),
      buttonCount: lastActionMessage.parentElement.querySelectorAll('.bosun-copy-last-action-btn').length,
      buttonText: lastActionCopyButton?.textContent,
      buttonTitle: lastActionCopyButton?.title,
      buttonLabel: lastActionCopyButton?.getAttribute('aria-label'),
      linkText: lastActionLink?.textContent,
      linkHref: lastActionLink?.href,
      linkTarget: lastActionLink?.target,
      linkRel: lastActionLink?.rel
    };
    const replacementMessage = document.createElement('span');
    replacementMessage.setAttribute('ng-show', 'state.LastAction.Message');
    replacementMessage.textContent = ': заменённая заметка';
    lastActionMessage.replaceWith(replacementMessage);
    hooks.ensureLastActionCopyButtons();
    const replacementState = {
      text: hooks.getLastActionMessageText(replacementMessage),
      buttonCount: replacementMessage.parentElement.querySelectorAll('.bosun-copy-last-action-btn').length
    };
    replacementMessage.remove();
    hooks.ensureLastActionCopyButtons();
    const orphanButtonRemoved = !lastActionCopyButton.isConnected;
    const childTitle = document.querySelector('#child-title');
    hooks.ensureStateIcon(childTitle, 'note');
    const note = childTitle.querySelector('.bosun-has-note-icon');
    const noteSemantics = {
      role: note?.getAttribute('role'),
      label: note?.getAttribute('aria-label'),
      title: note?.title
    };
    hooks.ensureStateIcon(childTitle, 'warning');
    const warning = childTitle.querySelector('.bosun-old-no-note-icon');

    const group = document.querySelector('#group');
    hooks.ensureParentStateIcon(group, 'note');
    const parent = group.querySelector('.bosun-parent-marker');

    const actions = document.querySelector('#actions');
    hooks.ensureAutoRefreshControls(actions);
    const input = actions.querySelector('#bosun-auto-refresh-idle-seconds');
    const hint = document.getElementById(input?.getAttribute('aria-describedby'));
    const copyFeedbackButton = document.createElement('button');
    copyFeedbackButton.textContent = 'Копировать';
    copyFeedbackButton.title = 'Скопировать текст алерта';
    actions.appendChild(copyFeedbackButton);
    hooks.flashCopyButtonState(copyFeedbackButton, true);
    const copyFeedback = {
      text: copyFeedbackButton.textContent,
      title: copyFeedbackButton.title,
      copied: copyFeedbackButton.dataset.copied,
      toolbarText: document.querySelector('#bosun-top-status')?.textContent || ''
    };
    history.replaceState({}, '', '/');
    hooks.setNewAlertNoticeCounts({ warning: 3, critical: 1, unknown: 4 });
    hooks.applyAlertsPayload({ Groups: { NeedAck: [] }, marker: 'follower' }, { source: 'follower' });
    hooks.applyAlertsPayload({ Groups: { NeedAck: [] }, marker: 'leader' }, { source: 'leader' });
    const newAlertNotice = document.querySelector('#bosun-new-alerts-notice');
    const allSeverityNoticeText = newAlertNotice?.textContent;
    const allSeverityNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 0, critical: 5, unknown: 0 });
    const criticalOnlyNoticeText = newAlertNotice?.textContent;
    const criticalOnlyNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 2, critical: 0, unknown: 4 });
    const warningAndUnknownNoticeClass = newAlertNotice?.className;
    hooks.setNewAlertNoticeCounts({ warning: 0, critical: 0, unknown: 3 });
    const unknownOnlyNoticeClass = newAlertNotice?.className;
    const warningCountBeforeRoute = childTitle.querySelectorAll('.bosun-old-no-note-icon').length;
    hooks.seedMarkerCache('cached-alert', 'note');
    hooks.clearMarkerState();
    const restoredMarker = hooks.restoreMarkerCache();
    history.replaceState({}, '', '/action?type=note');
    hooks.handleRouteChange();
    const markerOnActionRoute = hooks.markerState();
    history.replaceState({}, '', '/');
    hooks.handleRouteChange();
    const markerAfterDashboardReturn = hooks.markerState();
    return {
      noteSemantics,
      noteRemovedAfterTransition: !childTitle.querySelector('.bosun-has-note-icon'),
      warningCount: warningCountBeforeRoute,
      warningRole: warning?.getAttribute('role'),
      warningLabel: warning?.getAttribute('aria-label'),
      parentRole: parent?.getAttribute('role'),
      parentLabel: parent?.getAttribute('aria-label'),
      inputAccessibleName: input?.getAttribute('aria-label'),
      inputHintText: hint?.textContent.trim(),
      describedBy: input?.getAttribute('aria-describedby'),
      copyFeedback,
      lastActionCopy,
      replacementState,
      orphanButtonRemoved,
      invalidUrlStayedStable,
      lastActionTimeState,
      allSeverityNoticeText,
      allSeverityNoticeClass,
      criticalOnlyNoticeText,
      criticalOnlyNoticeClass,
      warningAndUnknownNoticeClass,
      unknownOnlyNoticeClass,
      newAlertNoticeUnderTools: newAlertNotice?.previousElementSibling?.classList.contains('bosun-top-controls-inner') === true,
      trackerReconcileMarkers: trackerReconciles.map((payload) => payload.marker),
      refreshIntervals: hooks.refreshIntervals,
      restoredMarker,
      markerOnActionRoute,
      markerAfterDashboardReturn
    };
  })()`);

  assert.strictEqual(accessibilityResult.noteSemantics.role, 'img');
  assert.ok(accessibilityResult.noteSemantics.label);
  assert.strictEqual(accessibilityResult.noteSemantics.label, accessibilityResult.noteSemantics.title);
  assert.strictEqual(accessibilityResult.noteRemovedAfterTransition, true);
  assert.strictEqual(accessibilityResult.warningCount, 1);
  assert.strictEqual(accessibilityResult.warningRole, 'img');
  assert.ok(accessibilityResult.warningLabel);
  assert.strictEqual(accessibilityResult.parentRole, 'img');
  assert.ok(accessibilityResult.parentLabel);
  assert.ok(accessibilityResult.inputAccessibleName);
  assert.ok(accessibilityResult.describedBy);
  assert.ok(accessibilityResult.inputHintText);
  assert.deepStrictEqual(accessibilityResult.copyFeedback, {
    text: 'Скопировано',
    title: 'Скопировано',
    copied: 'true',
    toolbarText: ''
  });
  assert.deepStrictEqual(accessibilityResult.lastActionCopy, {
    text: 'первая строка\nhttps://example.test/runbook.\nтретья строка',
    buttonCount: 1,
    buttonText: 'Копировать',
    buttonTitle: 'Скопировать текст заметки',
    buttonLabel: 'Скопировать текст заметки',
    linkText: 'https://example.test/runbook',
    linkHref: 'https://example.test/runbook',
    linkTarget: '_blank',
    linkRel: 'noopener noreferrer'
  });
  assert.deepStrictEqual(accessibilityResult.replacementState, {
    text: 'заменённая заметка',
    buttonCount: 1
  });
  assert.strictEqual(accessibilityResult.orphanButtonRemoved, true);
  assert.strictEqual(accessibilityResult.invalidUrlStayedStable, true);
  assert.deepStrictEqual(accessibilityResult.lastActionTimeState, {
    hasLink: false,
    text: 'now',
    replacementClass: 'bosun-last-action-time-text',
    color: 'rgb(0, 0, 238)'
  });
  assert.strictEqual(accessibilityResult.allSeverityNoticeText, 'Новые алерты: Warn: 3, Crit: 1, Unk: 4');
  assert.strictEqual(accessibilityResult.criticalOnlyNoticeText, 'Новые алерты: Crit: 5');
  assert.match(accessibilityResult.allSeverityNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.criticalOnlyNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.warningAndUnknownNoticeClass, /\bis-warning\b/);
  assert.doesNotMatch(accessibilityResult.warningAndUnknownNoticeClass, /\bis-critical\b/);
  assert.match(accessibilityResult.unknownOnlyNoticeClass, /\bis-unknown\b/);
  assert.strictEqual(accessibilityResult.newAlertNoticeUnderTools, true);
  assert.deepStrictEqual(accessibilityResult.trackerReconcileMarkers, ['leader']);
  assert.deepStrictEqual(accessibilityResult.refreshIntervals, { visible: 4000, hidden: 10000 });
  assert.deepStrictEqual(accessibilityResult.restoredMarker, {
    restored: true,
    note: true,
    warning: false
  });
  assert.deepStrictEqual(accessibilityResult.markerOnActionRoute, { ready: false, note: false });
  assert.deepStrictEqual(accessibilityResult.markerAfterDashboardReturn, { ready: true, note: true });

  const ambiguousGrafanaEditorResult = await evaluate(client, `(async () => {
    document.body.innerHTML =
      '<div class="query-row">' +
        '<button id="grafana-code-toggle" type="button">Code</button>' +
        '<div id="grafana-editor-one" class="cm-editor" style="min-height:24px">' +
          '<div class="cm-content" contenteditable="true" style="min-height:20px">first query</div>' +
        '</div>' +
        '<div id="grafana-editor-two" class="cm-editor" style="min-height:24px">' +
          '<div class="cm-content" contenteditable="true" style="min-height:20px">second query</div>' +
        '</div>' +
        '<button id="grafana-run" type="button">Run queries</button>' +
      '</div>';

    function createView(initialText) {
      let text = initialText;
      let dispatchCount = 0;
      const view = {
        state: { doc: { toString: () => text } },
        dispatch(transaction) {
          dispatchCount += 1;
          text = transaction.changes.insert;
          this.state.doc = { toString: () => text };
        }
      };
      return {
        view,
        getText: () => text,
        getDispatchCount: () => dispatchCount
      };
    }

    const first = createView('first query');
    const second = createView('second query');
    document.getElementById('grafana-editor-one').cmView = first.view;
    document.getElementById('grafana-editor-two').cmView = second.view;
    const secondContent = document.querySelector('#grafana-editor-two .cm-content');
    secondContent.focus();

    let runClicks = 0;
    document.getElementById('grafana-run').addEventListener('click', () => { runClicks += 1; });
    const channelToken = 'browser-ambiguous-editor-token';
    const requestId = 'browser-ambiguous-editor-request';
    const operationId = 'browser-ambiguous-editor-operation';
    const response = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Timed out waiting for the Grafana page bridge result'));
      }, 1000);
      function onMessage(event) {
        if (
          event.source !== window ||
          event.origin !== window.location.origin ||
          event.data?.type !== 'BOSUN_HELPER_GRAFANA_QUERY_RESULT' ||
          event.data?.requestId !== requestId
        ) return;
        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve(event.data.result);
      }
      window.addEventListener('message', onMessage);
    });

    const bridgeScript = document.createElement('script');
    bridgeScript.dataset.channelToken = channelToken;
    bridgeScript.textContent = ${grafanaPageSource};
    document.documentElement.appendChild(bridgeScript);
    window.postMessage({
      type: 'BOSUN_HELPER_APPLY_GRAFANA_QUERY',
      channelToken,
      requestId,
      operationId,
      query: 'replacement query',
      run: true,
      deadlineAt: Date.now() + 5000
    }, window.location.origin);

    const result = await response;
    return {
      result,
      runClicks,
      firstText: first.getText(),
      secondText: second.getText(),
      firstDispatches: first.getDispatchCount(),
      secondDispatches: second.getDispatchCount(),
      firstDomText: document.querySelector('#grafana-editor-one .cm-content').textContent,
      secondDomText: secondContent.textContent,
      activeEditorPreserved: document.activeElement === secondContent
    };
  })()`);
  assert.deepStrictEqual(ambiguousGrafanaEditorResult, {
    result: { ok: false, reason: 'ambiguous-editor-dom', terminal: true },
    runClicks: 0,
    firstText: 'first query',
    secondText: 'second query',
    firstDispatches: 0,
    secondDispatches: 0,
    firstDomText: 'first query',
    secondDomText: 'second query',
    activeEditorPreserved: true
  });

  const handoffResult = await evaluate(client, `(async () => {
    ${handoffSource}
    const saved = [];
    const navigated = [];
    const popup = { opener: window, location: { replace(value) { navigated.push(value); } }, close() {} };
    const storage = {
      set(values, callback) { saved.push(Object.values(values)[0]); callback(); },
      get(_keys, callback) { callback({}); },
      remove(_keys, callback) { callback?.(); }
    };
    const api = BosunHelperGrafanaHandoff.createGrafanaHandoff({
      config: {
        grafanaHost: 'grafana.example.test',
        grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
      },
      getStorage: () => storage,
      getLastError: () => null
    });
    const originalOpen = window.open;
    window.open = () => popup;
    const query = 'sum(rate(metric{label="<img src=x onerror=alert(1)>"}[5m]))';
    let previewSnapshot = null;
    setTimeout(() => {
      const dialog = document.querySelector('.bosun-grafana-preview-dialog');
      previewSnapshot = {
        text: dialog?.querySelector('pre')?.textContent || '',
        imageCount: dialog?.querySelectorAll('img').length || 0
      };
      Array.from(dialog?.querySelectorAll('button') || [])
        .find((button) => button.textContent === 'Вставить')?.click();
    }, 0);
    const inserted = await api.openQuery(query, document.body);
    setTimeout(() => {
      const dialog = document.querySelector('.bosun-grafana-preview-dialog');
      Array.from(dialog?.querySelectorAll('button') || [])
        .find((button) => button.textContent === 'Вставить и выполнить')?.click();
    }, 0);
    const executed = await api.openQuery('up', document.body);
    window.open = originalOpen;
    api.destroy();
    return { inserted, executed, previewSnapshot, saved, navigated, openerCleared: popup.opener === null };
  })()`);
  assert.strictEqual(handoffResult.inserted, true);
  assert.strictEqual(handoffResult.executed, true);
  assert.strictEqual(handoffResult.previewSnapshot.imageCount, 0);
  assert.ok(handoffResult.previewSnapshot.text.includes('<img src=x'));
  assert.strictEqual(handoffResult.saved[0].run, false);
  assert.strictEqual(handoffResult.saved[1].run, true);
  assert.strictEqual(handoffResult.navigated.length, 2);
  assert.strictEqual(handoffResult.openerCleared, true);
}

async function main() {
  await testTemporaryProfileCleanupRetry();
  const executable = findBrowserExecutable();
  const debugPort = await reservePort();
  const pagePort = await reservePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-browser-'));
  const pageServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Bosun Helper browser test</title></head><body></body></html>');
  });
  await new Promise((resolve, reject) => {
    pageServer.once('error', reject);
    pageServer.listen(pagePort, '127.0.0.1', resolve);
  });

  const stderr = { value: '' };
  const browser = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  browser.stderr.on('data', (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8000);
  });

  let client = null;
  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, browser, stderr);
    const pageUrl = `http://127.0.0.1:${pagePort}/action?type=note`;
    const targetResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' }
    );
    assert.ok(targetResponse.ok, `Unable to create browser target: HTTP ${targetResponse.status}`);
    const target = await targetResponse.json();
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url: pageUrl });
    await loaded;
    await runBrowserAssertions(client);
    console.log(`Browser test passed (${path.basename(executable)})`);
  } finally {
    try {
      const closeRequest = client?.send('Browser.close').catch(() => undefined);
      if (closeRequest) await Promise.race([closeRequest, delay(3000)]);
    } catch (_) {}
    client?.close();
    let exited = await waitForBrowserExit(browser, 5000);
    if (!exited && browser.exitCode == null && browser.signalCode == null) {
      browser.kill();
      exited = await waitForBrowserExit(browser, 5000);
    }
    await new Promise((resolve) => pageServer.close(resolve));
    try {
      await removeTemporaryProfile(profileDirectory);
    } catch (error) {
      console.warn(`Temporary browser profile could not be removed: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`Browser test failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
