'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runMarkerCacheAssertions({ client, contentSource }) {
  const results = await evaluate(client, `(async () => {
    const results = [];
    const key = 'bosunAlertMarkerCacheV1';
    const previous = sessionStorage.getItem(key);
    try {
      for (const transition of ['hide', 'persisted', 'route']) {
        sessionStorage.removeItem(key);
        const frame = document.createElement('iframe'); frame.src = '/';
        await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
        const win = frame.contentWindow;
        try {
          let now = 1000000, nextId = 0;
          const timers = new Map();
          win.Date.now = () => now;
          win.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; };
          win.clearTimeout = id => timers.delete(id);
          win.fetch = () => new Promise(() => {});
          win.BosunHelperLocalConfig = { bosunHosts: [win.location.host] };
          win.BosunHelperSettings = { createSettingsStore: () => ({
            start: () => new Promise(() => {}), subscribe() {}
          }) };
          const payload = { version: 2, savedAt: now, maps: {} };
          win.eval(${JSON.stringify(contentSource)});
          const hooks = win.__BosunHelperBrowserTest;
          const maps = hooks.markerCacheMaps();
          for (const name of Object.keys(maps)) payload.maps[name] = [];
          payload.maps.childHasNoteById = [['cached-alert', true]];
          sessionStorage.setItem(key, JSON.stringify(payload));
          const restore = hooks.restoreMarkerCache();
          const reference = maps.childHasNoteById;
          hooks.scheduleMarkerCache(); hooks.scheduleMarkerCache();
          const cacheTimers = [...timers.values()].filter(timer => timer.delay === 5000).length;
          await Promise.resolve().then(() => maps.childHasNoteById.set('late-result', true));
          if (transition === 'route') {
            win.history.pushState({}, '', '/action?type=ack'); hooks.handleRouteChange();
          } else {
            win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: transition === 'persisted' }));
          }
          const saved = JSON.parse(sessionStorage.getItem(key));
          const pendingAfterTransition = timers.size;
          const sameReference = hooks.markerCacheMaps().childHasNoteById === reference;
          const beforeRepeat = sessionStorage.getItem(key);
          if (transition !== 'route') win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: transition === 'persisted' }));
          const repeatedHideIsInert = transition === 'route' || beforeRepeat === sessionStorage.getItem(key);
          let resumed = true;
          if (transition === 'persisted') {
            win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
            maps.childHasNoteById.set('after-restore', true); hooks.scheduleMarkerCache();
            const [id, timer] = [...timers].find(([, timer]) => timer.delay === 30000);
            timers.delete(id); now += timer.delay; timer.callback();
            resumed = JSON.parse(sessionStorage.getItem(key)).maps.childHasNoteById.some(([id]) => id === 'after-restore');
          }
          results.push({ transition, restore, cacheTimers, savedNote: saved.maps.childHasNoteById,
            pendingAfterTransition, sameReference, repeatedHideIsInert, resumed });
        } finally { frame.remove(); }
        const fresh = document.createElement('iframe'); fresh.src = '/';
        await new Promise(resolve => { fresh.onload = resolve; document.body.appendChild(fresh); });
        try {
          const win = fresh.contentWindow;
          win.Date.now = () => 1030000;
          win.setTimeout = () => 1; win.clearTimeout = () => {};
          win.fetch = () => new Promise(() => {});
          win.BosunHelperLocalConfig = { bosunHosts: [win.location.host] };
          win.BosunHelperSettings = { createSettingsStore: () => ({ start: () => new Promise(() => {}), subscribe() {} }) };
          win.eval(${JSON.stringify(contentSource)});
          results[results.length - 1].startupRestore = win.__BosunHelperBrowserTest.markerState();
        } finally { fresh.remove(); }
      }
    } finally {
      if (previous === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, previous);
    }
    return results;
  })()`);
  for (const result of results) {
    assert.deepStrictEqual(result.restore, { restored: true, note: true, warning: false });
    assert.strictEqual(result.cacheTimers, 1, result.transition + ': duplicate delayed persistence');
    assert.deepStrictEqual(result.savedNote, [['cached-alert', true], ['late-result', true]], result.transition + ': cleanup must flush current data before clearing indexes');
    assert.strictEqual(result.pendingAfterTransition, 0, result.transition + ': cleanup changed pending timers');
    assert.strictEqual(result.sameReference, true, 'Cache must preserve map ownership and references');
    assert.strictEqual(result.repeatedHideIsInert, true);
    assert.strictEqual(result.resumed, true);
    assert.deepStrictEqual(result.startupRestore, { ready: true, note: true }, result.transition + ': new document must restore session cache during init');
  }
};
