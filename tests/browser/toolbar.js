'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runToolbarAssertions({ client, contentSource }) {
  const result = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe');
    await new Promise(resolve => { frame.onload = resolve; frame.src = '/'; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    try {
      win.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
      win.Date.now = () => 5000;
      const timers = new Map(), observations = [], settingsMounts = [];
      let nextTimer = 0, statusReporter;
      win.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
      win.clearTimeout = id => timers.delete(Number(id));
      const Observer = win.MutationObserver;
      win.MutationObserver = class extends Observer {
        constructor(callback) { super(callback); this.record = { observed: 0, disconnected: 0 }; observations.push(this.record); }
        observe(...args) { this.record.observed += 1; return super.observe(...args); }
        disconnect() { this.record.disconnected += 1; return super.disconnect(); }
      };
      win.BosunHelperSettingsUi = { createSettingsUi(options) {
        statusReporter = options.reportStatus;
        return { mount(node) { settingsMounts.push(node.className); }, close() {}, destroy() {} };
      } };
      win.eval(${JSON.stringify(contentSource)});
      const hooks = win.__BosunHelperBrowserTest;
      const settle = () => new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      const inert = observations.length === 0 && timers.size === 0 && !doc.getElementById('bosun-top-controls-bar');
      hooks.scheduleTopBarMount(); hooks.scheduleTopBarMount();
      const waitingObservers = observations.length;
      const container = doc.createElement('div'); container.className = 'container'; doc.body.appendChild(container);
      await settle();
      const bar = doc.getElementById('bosun-top-controls-bar');
      const lateMount = !!bar && bar.nextElementSibling === container;
      hooks.ensureToggleExists(); hooks.ensureToggleExists();
      const original = bar.outerHTML;
      hooks.ensureToggleExists();
      const idempotent = original === bar.outerHTML;
      const firstToggle = doc.getElementById('bosun-silence-toggle');
      const firstSound = doc.getElementById('bosun-sound-alerts-toggle');
      const initialPressed = firstToggle.getAttribute('aria-pressed');
      let bubbled = 0;
      bar.addEventListener('click', () => { bubbled += 1; });
      const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
      firstToggle.dispatchEvent(click);
      const afterFirstClick = hooks.runtimeSettings().showSilenced;
      hooks.ensureToggleExists(); firstToggle.click();
      const afterSecondClick = hooks.runtimeSettings().showSilenced;
      firstSound.click();
      const soundAfterClick = hooks.runtimeSettings().soundAlertsEnabled;
      hooks.setFeature('soundNotifications', false);
      const disabledRemoved = !doc.getElementById('bosun-sound-alerts-toggle');
      hooks.setFeature('soundNotifications', true);
      hooks.ensureToggleExists();
      const soundRestored = doc.querySelectorAll('#bosun-sound-alerts-toggle').length === 1;
      hooks.setPreference('autoRefreshIdleSeconds', 90);
      const input = doc.getElementById('bosun-auto-refresh-idle-seconds');
      input.focus(); input.value = '137'; hooks.ensureToggleExists();
      const focusPreserved = doc.activeElement === input && input.value === '137';
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
      const savedIdle = hooks.runtimeSettings().autoRefreshIdleSeconds;
      hooks.setNewAlertNoticeCounts({ warning: 2, critical: 3, unknown: 4 });
      const notice = doc.getElementById('bosun-new-alerts-notice');
      const noticeState = { text: notice.textContent, role: notice.getAttribute('role'),
        live: notice.getAttribute('aria-live'), critical: notice.classList.contains('is-critical') };
      statusReporter('settings warning', 'warn', 'details');
      const status = doc.getElementById('bosun-top-controls-status');
      const aria = { label: status.getAttribute('aria-label'), role: status.getAttribute('role'),
        live: status.getAttribute('aria-live'), tabIndex: status.tabIndex, warning: status.classList.contains('is-warn') };
      hooks.setToolbarStatus('old', 'timed', 'info', { ttlMs: 1 });
      const id = hooks.runtimeSettings().toolbarStatusTimer, stale = timers.get(id);
      hooks.setToolbarStatus('new', 'sticky', 'error', { sticky: true });
      stale.callback();
      const guarded = { source: hooks.runtimeSettings().toolbarStatusSource,
        text: status.textContent, timer: hooks.runtimeSettings().toolbarStatusTimer, oldTimerRemoved: !timers.has(id) };
      hooks.clearToolbarStatus('new');
      const cleared = status.hidden && !status.hasAttribute('aria-label') && !status.hasAttribute('tabindex');
      const dom = bar.outerHTML;
      win.history.replaceState({}, '', '/action?type=note'); hooks.handleRouteChange();
      const routeRemoved = !doc.getElementById('bosun-top-controls-bar');
      win.history.replaceState({}, '', '/'); hooks.handleRouteChange(); await settle();
      const returnMounted = doc.querySelectorAll('#bosun-top-controls-bar').length === 1;
      doc.getElementById('bosun-top-controls-bar').remove(); container.remove();
      hooks.scheduleTopBarMount();
      win.history.replaceState({}, '', '/action?type=note'); hooks.handleRouteChange();
      doc.body.appendChild(container); await settle();
      const cancelledMount = !doc.getElementById('bosun-top-controls-bar');
      win.history.replaceState({}, '', '/'); hooks.handleRouteChange(); await settle();
      for (let i = 0; i < 2; i += 1) {
        win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
        win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
        hooks.ensureToggleExists();
      }
      hooks.disconnectTopBarMountObserver();
      return { inert, waitingObservers, lateMount, idempotent, initialPressed, afterFirstClick, afterSecondClick,
        prevented: click.defaultPrevented, bubbled, soundAfterClick, disabledRemoved, soundRestored,
        focusPreserved, savedIdle, noticeState, aria, guarded, cleared, minimumTtl: stale.delay,
        routeRemoved, returnMounted, cancelledMount, observations, settingsMounts,
        finalBars: doc.querySelectorAll('#bosun-top-controls-bar').length, dom };
    } finally { frame.remove(); }
  })()`);
  assert.strictEqual(result.inert, true);
  assert.strictEqual(result.waitingObservers, 1);
  assert.strictEqual(result.lateMount, true);
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(result.initialPressed, 'false');
  assert.strictEqual(result.afterFirstClick, true);
  assert.strictEqual(result.afterSecondClick, false);
  assert.strictEqual(result.prevented, true);
  assert.strictEqual(result.soundAfterClick, false);
  assert.strictEqual(result.disabledRemoved, true);
  assert.strictEqual(result.soundRestored, true);
  assert.strictEqual(result.focusPreserved, true);
  assert.strictEqual(result.savedIdle, 137);
  assert.deepStrictEqual(result.noticeState, { text: 'Новые алерты: Warn: 2, Crit: 3, Unk: 4', role: 'status', live: 'polite', critical: true });
  assert.deepStrictEqual(result.aria, { label: 'settings warning. Подробности: details', role: 'status', live: 'polite', tabIndex: 0, warning: true });
  assert.deepStrictEqual(result.guarded, { source: 'new', text: 'sticky', timer: null, oldTimerRemoved: true });
  assert.strictEqual(result.cleared, true);
  assert.strictEqual(result.minimumTtl, 1000);
  assert.strictEqual(result.routeRemoved, true);
  assert.strictEqual(result.returnMounted, true);
  assert.strictEqual(result.cancelledMount, true);
  assert.deepStrictEqual(result.observations, [{ observed: 1, disconnected: 1 }, { observed: 1, disconnected: 1 }]);
  assert.strictEqual(result.finalBars, 1);
  assert.ok(result.settingsMounts.every(name => name === 'bosun-toolbar-utility-group'));
  return result;
};
