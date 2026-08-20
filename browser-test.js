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

async function removeTemporaryProfile(profileDirectory) {
  const resolvedProfile = path.resolve(profileDirectory);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedProfile).startsWith('bosun-helper-browser-'),
    `Refusing to remove unexpected browser profile path: ${resolvedProfile}`
  );
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error('Temporary browser profile cleanup failed');
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
  globalThis.__BosunHelperBrowserTest = {
    ensureStateIcon,
    ensureParentStateIcon,
    ensureAutoRefreshControls,
    ensureLastActionCopyButtons,
    getLastActionMessageText,
    applyAlertsPayload,
    flashCopyButtonState,
    handleRouteChange,
    startObserver,
    singleAlertAge: singleAlertAgeApi,
    refreshIntervals: { visible: DATA_REFRESH_MS, hidden: DATA_REFRESH_HIDDEN_MS },
    seedMarkerCache(id, state) {
      for (const map of Object.values(getAlertMarkerCacheMaps())) map.clear();
      if (state === 'note') childHasNoteById.set(id, true);
      if (state === 'warning') childOldNoNoteById.set(id, true);
      alertDataIndexReady = true;
      persistAlertMarkerCacheToSession();
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
  const actionSource = fs.readFileSync(path.join(root, 'action-templates.js'), 'utf8');
  const singleAlertAgeSource = fs.readFileSync(path.join(root, 'single-alert-age.js'), 'utf8');
  const pageUtilsSource = fs.readFileSync(path.join(root, 'page-utils.js'), 'utf8');
  const stylesSource = fs.readFileSync(path.join(root, 'styles.js'), 'utf8');
  const handoffSource = fs.readFileSync(path.join(root, 'grafana-handoff.js'), 'utf8');
  const contentSource = instrumentContentSource(fs.readFileSync(path.join(root, 'content.js'), 'utf8'));

  const actionResult = await evaluate(client, `(() => {
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
    const browserExited = new Promise((resolve) => browser.once('exit', resolve));
    try {
      const closeRequest = client?.send('Browser.close').catch(() => undefined);
      if (closeRequest) await Promise.race([closeRequest, delay(1000)]);
    } catch (_) {}
    client?.close();
    if (browser.exitCode == null) browser.kill();
    await Promise.race([browserExited, delay(2000)]);
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
