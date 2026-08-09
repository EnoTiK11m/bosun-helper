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
    applyAlertsPayload,
    flashCopyButtonState,
    handleRouteChange,
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

  const accessibilityResult = await evaluate(client, `(() => {
    document.body.innerHTML = '<div id="actions"></div><div id="child-title"></div>' +
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
