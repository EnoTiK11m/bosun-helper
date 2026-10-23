'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runSettingsLayoutScenarios({ client, contentSource }) {
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
    const collapsedGroupHeight = details.getBoundingClientRect().height;
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
    body.scrollTop = body.scrollHeight;
    const verticalContentReachable = body.scrollHeight <= body.clientHeight ||
      (['auto', 'scroll'].includes(getComputedStyle(body).overflowY) &&
        body.scrollTop >= body.scrollHeight - body.clientHeight - 1);
    globalThis.__settingsLayoutTest = { api, store, subscribers };
    return {
      columnCount: getComputedStyle(body).columnCount,
      distinctColumns: new Set(groupLefts).size,
      integrationHeight: integration.height,
      templatesHeight: templates.height,
      collapsedHeight,
      expandedHeight: panel.getBoundingClientRect().height,
      collapsedGroupHeight,
      expandedGroupHeight: details.getBoundingClientRect().height,
      panelFitsViewport: panel.getBoundingClientRect().height <= window.innerHeight - 20,
      verticalContentReachable,
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
  assert.ok(wideSettingsLayout.collapsedGroupHeight < wideSettingsLayout.expandedGroupHeight);
  assert.strictEqual(wideSettingsLayout.panelFitsViewport, true);
  assert.strictEqual(wideSettingsLayout.verticalContentReachable, true);
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
};
