'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function runAcknowledgedCompactAssertions({ client, evaluate, instrumentContentSource, root }) {
  const source = name => fs.readFileSync(path.join(root, name), 'utf8');
  const main = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: source('src/bosun/group-identity-page.js')
  });
  const isolated = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: source('src/bosun/group-identity.js'), worldName: 'bh-ack-compact-world'
  });
  const frameId = 'bh-ack-compact-test';
  let contextId;
  const run = async expression => {
    const result = await client.send('Runtime.evaluate', {
      expression, contextId, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const mutate = expression => evaluate(client,
    `document.getElementById('${frameId}').contentWindow.eval(${JSON.stringify(expression)})`);
  try {
    await evaluate(client, `(async () => {
      const frame = document.createElement('iframe'); frame.id = '${frameId}'; frame.src = '/?ack-compact-test';
      await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
      const win = frame.contentWindow;
      const nativeStyles = win.document.createElement('style');
      nativeStyles.textContent = 'body{font:14px/1.42857143 Arial,sans-serif;color:#333;background:#fff}' +
        '.clearfix::after{content:"";display:table;clear:both}.pull-left{float:left}.pull-right{float:right}' +
        '.clearfix h3{font:24px/1.1 sans-serif;margin:20px 0 10px}' +
        '.clearfix button[data-native]{font:12px/1.5 sans-serif;padding:1px 5px;border:1px solid #ccc;border-radius:3px;background:#fff;color:#333}';
      win.document.head.append(nativeStyles);
      win.fixtureScopes = new WeakMap(); win.fixtureGroups = { NeedAck: [], Acknowledged: [] };
      win.angular = { element(node) { return {
        scope: () => win.fixtureScopes.get(node),
        isolateScope: () => ({ groups: win.fixtureGroups[node.getAttribute('ts-ack-group').split('.').at(-1)] })
      }; } };
      win.savedAngular = win.angular;
      win.mountFixture = (groups, expanded) => {
        win.fixtureGroups = groups; win.fixtureEntries = [];
        win.document.body.innerHTML = '<div id="fixture"></div>';
        const container = win.document.getElementById('fixture');
        for (const section of ['NeedAck', 'Acknowledged']) {
          const root = win.document.createElement('div'); root.setAttribute('ts-ack-group', 'schedule.Groups.' + section);
          const list = win.document.createElement('div'); list.className = 'panel-group'; root.append(list); container.append(root);
          // The native heading is INSIDE the directive; ng-bind owns its text.
          const header = win.document.createElement('div'); header.className = 'clearfix';
          header.innerHTML = '<h3 class="pull-left" ng-bind="ack"></h3>' +
            '<button type="button" class="btn btn-default btn-xs" data-native="expand">expand</button>' +
            '<span class="pull-right">select ' +
            '<button type="button" data-native="select">all</button> ' +
            '<button type="button" data-native="severity">normal</button> ' +
            '<button type="button" data-native="severity">warning</button> ' +
            '<button type="button" data-native="severity">critical</button> ' +
            '<button type="button" data-native="severity">unknown</button> ' +
            '<button type="button" data-native="select">none</button></span>';
          const heading = header.querySelector('h3');
          heading.textContent = section === 'NeedAck' ? 'Needs Acknowledgement' : 'Acknowledged';
          list.append(header);
          if (section === 'Acknowledged') {
            win.nativeHeader = header; win.nativeHeading = heading;
            win.nativeButtons = [...header.querySelectorAll('button')];
            win.nativeClicks = { expand: 0, select: 0, severity: 0, header: 0 };
            for (const button of win.nativeButtons) button.addEventListener('click', () => win.nativeClicks[button.dataset.native]++);
            header.addEventListener('click', () => win.nativeClicks.header++);
          }
          for (const group of groups[section] || []) {
            const panel = win.document.createElement('div'); panel.className = 'panel';
            panel.setAttribute('ng-repeat', 'group in groups');
            panel.innerHTML = '<div class="panel-heading"><h4 class="panel-title"><span ng-bind="group.Subject"></span>' +
              '<span class="pull-right ng-binding"></span></h4></div>';
            panel.querySelector('[ng-bind]').textContent = group.Subject;
            panel.querySelector('.pull-right').textContent = group.Children.length + ' alerts';
            const body = win.document.createElement('div'); body.className = 'panel-body panel-group';
            for (const row of group.Children) {
              const child = win.document.createElement('div'); child.className = 'panel';
              child.setAttribute('ng-repeat', 'child in group.Children');
              child.innerHTML = '<div class="panel-heading" ng-click="toggle()"><h4 class="panel-title">' +
                '<span ng-show="state.Id"></span><span ng-bind="child.Subject || child.AlertKey"></span>' +
                '<span ts-since="child.Ago"></span><input type="checkbox"></h4></div>';
              child.querySelector('[ng-show]').textContent = '#' + row.State.Id + ':';
              child.querySelector('[ng-bind]').textContent = row.Subject;
              child.querySelector('[ts-since]').textContent = '1m-ago';
              body.append(child);
            }
            if (expanded) panel.append(body);
            list.append(panel); win.fixtureScopes.set(panel, { group });
            win.fixtureEntries.push({ section, panel, body, group });
          }
        }
      };
    })()`);
    const tree = await client.send('Page.getFrameTree');
    const frame = tree.frameTree.childFrames.find(entry => entry.frame.url.includes('ack-compact-test'));
    ({ executionContextId: contextId } = await client.send('Page.createIsolatedWorld', {
      frameId: frame.frame.id, worldName: 'bh-ack-compact-world'
    }));
    const install = `
      globalThis.BosunHelperLocalConfig = { bosunHosts: ['not-current.invalid'] };
      globalThis.requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Unexpected request'); };
      globalThis.savedSettings = { bosunSettingsSchemaVersion: 2,
        'bosunSettingsV1:features.noCommentFilter': true,
        'bosunSettingsV1:preferences.noCommentFilterActive': true,
        'bosunSettingsV1:features.acknowledgedCollapse': false,
        'bosunSettingsV1:features.singleAlertAge': false,
        'bosunSettingsV1:features.grafanaIntegration': false,
        'bosunSettingsV1:features.autoRefresh': false,
        'bosunSettingsV1:features.soundNotifications': false,
        'bosunSettingsV1:features.visualNewAlertNotifications': false,
        'bosunSettingsV1:priorityRules.exactAlertNames': ['synthetic.priority'] };
      const listeners = new Set();
      globalThis.chrome = { runtime: {}, storage: {
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
        local: {
          get(keys, callback) { callback(Object.fromEntries(keys.filter(key => key in savedSettings).map(key => [key, savedSettings[key]]))); },
          set(items, callback) {
            const changes = {};
            for (const [key, value] of Object.entries(items)) { changes[key] = { oldValue: savedSettings[key], newValue: value }; savedSettings[key] = value; }
            for (const fn of listeners) fn(changes, 'local'); callback?.();
          },
          remove(keys, callback) { for (const key of keys) delete savedSettings[key]; callback?.(); }
        }
      } };
      ${source('src/settings/settings.js')}
      ${source('src/bosun/needack-severity.js')}
      ${source('src/bosun/priority-alerts.js')}
      ${source('src/bosun/alerts-data.js')}
      ${source('src/shared/styles.js')}
      ${instrumentContentSource(source('src/bosun/content.js'))}
      globalThis.hooks = __BosunHelperBrowserTest;
      globalThis.store = await hooks.startPriorityActionSettings();
      hooks.injectStyles();
      globalThis.refresh = () => hooks.runDomRefreshPass({ preserveExistingOnNone: true });
      globalThis.state = () => {
        const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
        const groups = [...root.querySelectorAll(':scope > .panel-group > .panel')];
        const hidden = node => node.classList.contains('bosun-acknowledged-collapsed');
        const button = document.getElementById('bosun-acknowledged-collapse-toggle');
        return { groups: groups.map(hidden), children: groups.map(group => [...group.querySelectorAll('[ng-repeat="child in group.Children"]')].map(hidden)),
          rootHidden: hidden(root), summary: document.querySelector('.bosun-ack-summary').textContent,
          label: button.textContent, pressed: button.getAttribute('aria-pressed'), disabled: button.disabled,
          controls: document.querySelectorAll('#bosun-acknowledged-controls').length };
      };
      globalThis.toggle = async () => {
        document.getElementById('bosun-acknowledged-collapse-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 0)); return state();
      };
    `;
    await run(`(async () => { ${install} })()`);
    const child = (id, priority = false) => {
      const name = priority ? 'synthetic.priority' : 'synthetic.ordinary';
      const key = name + '{instance=demo' + id + '}';
      return { Alert: name, AlertKey: key, Subject: key, Ago: '2020-01-01T00:00:00Z',
        State: { Id: id, Alert: name, AlertKey: key, CurrentStatus: 'critical', Actions: [] } };
    };
    const group = (name, children) => ({ Subject: name, Children: children });
    const mount = async (groups, expanded = false, need = []) => {
      const payload = { Groups: { NeedAck: need, Acknowledged: groups } };
      await mutate(`mountFixture(${JSON.stringify(payload.Groups)}, ${expanded})`);
      await run(`hooks.applyAlertsPayload(${JSON.stringify(payload)}); refresh()`);
      return run('state()');
    };
    const ordinary = group('ordinary group', [child(1101), child(1102)]);
    const priority = group('priority group', [child(1201, true), child(1202, true)]);
    const mixed = group('mixed group', [child(1301), child(1302, true)]);
    assert.deepStrictEqual((await mount([ordinary])).groups, [false]);
    assert.strictEqual(await mutate('nativeHeading.nextElementSibling === nativeButtons[0]'), true,
      'Extension controls must not separate Acknowledged from native expand');
    assert.strictEqual(await run(`(() => {
      const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
      const native = root.querySelector('h3[ng-bind="ack"]'), controls = document.getElementById('bosun-acknowledged-controls');
      return controls?.parentElement === native?.parentElement && getComputedStyle(native).display !== 'none' &&
        document.querySelectorAll('h3').length === 2 && !controls.querySelector('h3');
    })()`), true, 'Controls must share the native header row without a second Acknowledged heading');
    assert.strictEqual(await run(`document.querySelector('.bosun-ack-summary').hidden && !state().summary`), true,
      'Full mode has no extra status text');
    assert.strictEqual((await run('state()')).label, 'Скрыть обычные');
    const fullButtonStyle = await run(`(() => { const style = getComputedStyle(document.getElementById('bosun-acknowledged-collapse-toggle'));
      return [style.height, style.padding, style.borderRadius]; })()`);
    assert.strictEqual(await mutate(`nativeHeader === document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .clearfix') &&
      nativeHeading === nativeHeader.querySelector('h3') && nativeButtons.every(button => nativeHeader.contains(button))`), true,
      'Native header, bindings and controls retain node identity');
    await mutate('nativeButtons.forEach(button => button.click())');
    assert.deepStrictEqual(await mutate('nativeClicks'), { expand: 1, select: 2, severity: 4, header: 7 });
    let actual = await run('toggle()');
    assert.deepStrictEqual(await mutate('nativeClicks'), { expand: 1, select: 2, severity: 4, header: 7 },
      'The extension button does not trigger native header handlers');
    assert.deepStrictEqual(actual.groups, [true]);
    assert.strictEqual(actual.rootHidden, false);
    assert.strictEqual(actual.label, 'Показать все');
    assert.deepStrictEqual(await run(`(() => { const style = getComputedStyle(document.getElementById('bosun-acknowledged-collapse-toggle'));
      return [style.height, style.padding, style.borderRadius]; })()`), fullButtonStyle, 'Both actions share the same Bootstrap sizing');
    assert.strictEqual(await run(`document.querySelector('.bosun-ack-priority .fa-flag').getAttribute('aria-hidden')`), 'true');
    assert.ok(actual.summary.includes('2 скрыто'));
    await mutate(`nativeHeading.textContent = 'Acknowledged'`); await run('refresh()');
    assert.strictEqual((await run('state()')).controls, 1, 'ng-bind text updates cannot erase sibling controls');
    assert.deepStrictEqual((await mount([priority])).groups, [false]);
    assert.deepStrictEqual((await mount([mixed])).groups, [false], 'Collapsed mixed group must remain accessible');
    for (let attempt = 0; attempt < 3; attempt++) {
      await mutate('fixtureEntries[0].panel.append(fixtureEntries[0].body)'); await run('refresh()');
      assert.deepStrictEqual((await run('state()')).children, [[true, false]]);
      await mutate('fixtureEntries[0].body.remove()'); await run('refresh()');
      assert.deepStrictEqual((await run('state()')).groups, [false]);
    }
    assert.deepStrictEqual((await mount([])).groups, [], 'An empty section retains its own restore control');
    assert.strictEqual((await run('state()')).controls, 1);
    actual = await mount([ordinary, priority, mixed], true);
    assert.deepStrictEqual(actual.groups, [true, false, false]);
    assert.deepStrictEqual(actual.children, [[true, true], [false, false], [true, false]]);
    assert.ok(actual.summary.includes('3 приоритетных'));
    assert.ok(actual.summary.includes('3 скрыто'));
    for (const [number, expected] of [[0,'0 приоритетных'],[1,'1 приоритетный'],[2,'2 приоритетных'],
      [3,'3 приоритетных'],[4,'4 приоритетных'],[5,'5 приоритетных'],[11,'11 приоритетных'],
      [12,'12 приоритетных'],[14,'14 приоритетных'],[21,'21 приоритетный'],[22,'22 приоритетных'],
      [25,'25 приоритетных'],[101,'101 приоритетный'],[111,'111 приоритетных'],[121,'121 приоритетный']]) {
      const rows = Array.from({ length: number }, (_, index) => child(20000 + index, true));
      const groups = [];
      for (let offset = 0; offset < rows.length; offset += 50) groups.push(group('synthetic count ' + offset, rows.slice(offset, offset + 50)));
      await mount(groups);
      assert.strictEqual(await run(`document.querySelector('.bosun-ack-priority-label').textContent`), expected);
    }
    await mount([ordinary, priority, mixed], true);
    assert.strictEqual(await run(`document.querySelectorAll('[ts-ack-group] input').length`), 6, 'Native controls stay in place');
    assert.strictEqual(await run(`document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel-heading .pull-right').textContent`), '2 alerts');
    await run(`store.update({ 'priorityRules.exactAlertNames': ['synthetic.ordinary'] })`);
    actual = await run('state()');
    assert.deepStrictEqual(actual.groups, [false, true, false]);
    assert.deepStrictEqual(actual.children, [[false, false], [true, true], [false, true]]);
    await run(`store.update({ 'features.priorityAlerts': false })`);
    actual = await run('state()');
    assert.deepStrictEqual(actual.groups, [false, false, false]);
    assert.ok(actual.children.flat().every(value => !value));
    assert.strictEqual(actual.disabled, true);
    await run(`store.update({ 'features.priorityAlerts': true, 'priorityRules.exactAlertNames': ['synthetic.priority'] })`);
    assert.deepStrictEqual((await run('state()')).groups, [true, false, false]);
    actual = await run('toggle()');
    assert.ok(actual.groups.every(value => !value));
    assert.ok(actual.children.flat().every(value => !value));
    assert.strictEqual(await run(`document.querySelector('.bosun-ack-summary').getAttribute('aria-label')`), null,
      'Full mode must not announce stale compact counters');
    await run('toggle()');
    assert.strictEqual(await run(`savedSettings['bosunSettingsV1:preferences.acknowledgedCollapsed']`), true);
    await run(`(async () => {
      const reloaded = BosunHelperSettings.createSettingsStore({ storage: chrome.storage.local });
      await reloaded.start(); hooks.applySettingsSnapshot(reloaded.getSnapshot(), { initial: true });
      reloaded.destroy();
    })()`);
    assert.deepStrictEqual((await run('state()')).groups, [true, false, false], 'Persisted mode survives a new settings store');
    await mount([ordinary], false);
    await mutate('window.angular = undefined'); await run('refresh()');
    assert.deepStrictEqual((await run('state()')).groups, [false], 'Unavailable model is fail-open');
    await mutate('window.angular = savedAngular'); await run('refresh()');
    assert.deepStrictEqual((await run('state()')).groups, [true]);
    const duplicate = group('duplicate IDs', [child(1401), child(1401)]);
    assert.deepStrictEqual((await mount([duplicate], true)).groups, [false]);
    assert.deepStrictEqual((await run('state()')).children, [[false, false]]);
    const crossSection = group('cross section duplicate', [child(1501)]);
    assert.deepStrictEqual((await mount([crossSection], true, [group('other section', [child(1501, true)])])).groups, [false]);
    await mount([ordinary], true);
    await mutate(`fixtureEntries[0].body.querySelector('[ng-bind]').textContent = 'different synthetic subject'`);
    await run('refresh()'); assert.deepStrictEqual((await run('state()')).groups, [false]);
    await mount([ordinary], true);
    await mutate('fixtureEntries[0].body.lastElementChild.remove()'); await run('refresh()');
    assert.deepStrictEqual((await run('state()')).groups, [false], 'Partial child rendering cannot hide a group');
    await mount([ordinary], true);
    await run(`hooks.applyAlertsPayload({ Groups: { NeedAck: [], Acknowledged: [] } })`);
    actual = await run('state()');
    assert.deepStrictEqual(actual.groups, [false], 'A removed snapshot group must not stay hidden');
    assert.deepStrictEqual(actual.children, [[false, false]]);
    const changed = group('new subject', [child(1101, true), child(1102)]);
    await run(`hooks.applyAlertsPayload(${JSON.stringify({ Groups: { NeedAck: [], Acknowledged: [changed] } })})`);
    assert.deepStrictEqual((await run('state()')).groups, [false], 'A stale DOM/API identity is fail-open');
    await mount([changed], true);
    assert.deepStrictEqual((await run('state()')).children, [[false, true]], 'A rebuilt DOM uses the new snapshot and Priority');
    await mount([ordinary], false);
    await mutate(`(() => {
      const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
      root.parentElement.append(root.cloneNode(true));
    })()`); await run('refresh()');
    assert.deepStrictEqual((await run('state()')).groups, [false], 'Duplicate section roots are fail-open');
    const hiddenInAnySection = () => run(`document.querySelectorAll('[ts-ack-group="schedule.Groups.Acknowledged"] .bosun-acknowledged-collapsed').length`);
    assert.strictEqual(await hiddenInAnySection(), 0, 'Every duplicated section must clear stale hiding, not just the first');
    for (const first of [false, true]) {
      await mount([ordinary], true);
      await mutate(`(() => {
        const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
        const clone = root.cloneNode(true);
        root.parentElement.${first ? 'prepend' : 'append'}(clone);
      })()`);
      await run('refresh()');
      assert.strictEqual(await hiddenInAnySection(), 0, 'Expanded duplicate cleanup covers groups and children in either DOM order');
    }
    await mount([ordinary], true);
    await mutate(`(() => { const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]'); root.after(root.cloneNode(true)); })()`);
    await run(`store.update({ 'features.priorityAlerts': false })`);
    assert.strictEqual(await hiddenInAnySection(), 0, 'Disabling Priority restores all duplicated sections');
    await run(`store.update({ 'features.priorityAlerts': true })`);
    await mount([ordinary], true);
    await mutate(`(() => { const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]'); root.after(root.cloneNode(true)); })()`);
    await run('toggle()');
    assert.strictEqual(await hiddenInAnySection(), 0, 'Show all restores every duplicated section');
    await run('toggle()');
    const noted = group('noted need group', [child(1601)]);
    noted.Children[0].State.Actions = [{ Type: 'Note', User: 'operator', Message: 'synthetic note' }];
    await mount([mixed], true, [noted]);
    await run(`document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"] .panel').classList.add('bosun-user-comment-hidden'); refresh()`);
    assert.strictEqual(await run(`document.querySelectorAll('.bosun-user-comment-hidden, .bosun-user-comment-filter-wrap').length`), 0);
    assert.strictEqual(await run(`hooks.isFeatureEnabled('noCommentFilter')`), false);
    assert.strictEqual(await run(`hooks.isFeatureEnabled('acknowledgedCollapse')`), true);
    await mutate(`fixtureEntries.find(entry => entry.section === 'Acknowledged').panel.querySelector('.panel-title').insertAdjacentHTML('beforeend', '<i class="fa fa-volume-off"></i>')`);
    await run('refresh()');
    assert.strictEqual(await run(`document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel').classList.contains('bosun-silence-hidden')`), true);
    assert.strictEqual(await run(`document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"] .panel').classList.contains('bosun-acknowledged-collapsed')`), false);
    await run(`hooks.setPreference('showSilenced', true); refresh()`);
    assert.strictEqual(await run(`document.querySelectorAll('.bosun-silence-hidden').length`), 0);
    assert.strictEqual(await run(`getComputedStyle(document.querySelector('#bosun-acknowledged-controls button')).userSelect`), 'none');
    assert.strictEqual(await run(`(() => {
      hooks.installSelectionCopySanitizer();
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(document.getElementById('fixture'));
      selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      const label = document.getElementById('bosun-acknowledged-collapse-toggle').textContent;
      const valid = !selection.toString().includes(label) && !data.getData('text/plain').includes(label) &&
        data.getData('text/plain').includes('synthetic.priority'); selection.removeAllRanges(); return valid;
    })()`), true, 'Compact controls do not pollute bulk selection/copy');
    for (const [color, background] of [['rgb(230, 230, 230)', '#202020'], ['rgb(30, 30, 30)', '#ffffff']]) {
      assert.strictEqual(await run(`(() => { document.body.style.color = ${JSON.stringify(color)};
        document.body.style.background = ${JSON.stringify(background)};
        return getComputedStyle(document.getElementById('bosun-acknowledged-collapse-toggle')).color; })()`), color);
    }
    assert.strictEqual(await run(`(() => { const button = document.getElementById('bosun-acknowledged-collapse-toggle');
      button.focus(); return document.activeElement === button && !!document.getElementById(button.getAttribute('aria-controls')); })()`), true);
    await client.send('Page.bringToFront');
    await mutate(`document.getElementById('bosun-acknowledged-collapse-toggle').focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await run('new Promise(resolve => setTimeout(resolve, 0))');
    assert.strictEqual((await run('state()')).pressed, 'false', 'Enter restores all Ack');
    assert.strictEqual(await run(`getComputedStyle(document.getElementById('bosun-acknowledged-collapse-toggle')).outlineWidth`), '2px');
    await run('toggle()');
    await run('hooks.startObserver(); hooks.resetLifecycleCounters()');
    await mutate(`fixtureEntries.find(entry => entry.section === 'Acknowledged').body.remove()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepStrictEqual((await run('state()')).groups, [false]);
    await mutate(`(() => {
      const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
      const replacement = root.cloneNode(true); root.replaceWith(replacement);
      fixtureScopes.set(replacement.querySelector('[ng-repeat="group in groups"]'),
        { group: fixtureGroups.Acknowledged[0] });
    })()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    actual = await run('state()');
    assert.strictEqual(actual.controls, 1, 'Root replacement retains one working header');
    assert.strictEqual(actual.rootHidden, false);
    assert.deepStrictEqual(actual.groups, [false]);
    assert.strictEqual((await run('toggle()')).pressed, 'false', 'Cloned root controls receive a live handler');
    await run('toggle()');
    // A header-only remount must also work for the legacy sibling layout,
    // without an API refresh or losing the original native controls.
    await mutate(`(() => {
      const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
      const header = root.querySelector('.clearfix'); root.insertAdjacentElement('beforebegin', header);
      const replacement = header.cloneNode(true); header.replaceWith(replacement);
      replacement.querySelector('#bosun-acknowledged-controls')?.remove();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.strictEqual((await run('state()')).controls, 1);
    assert.strictEqual(await run(`document.getElementById('bosun-acknowledged-controls').parentElement.matches('.clearfix')`), true);
    assert.strictEqual((await run('toggle()')).pressed, 'false', 'Header replacement preserves quick actions');
    await run('toggle()');
    for (const width of [320, 768, 1280]) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(client, `document.getElementById('${frameId}').style.width = (${width} - 32) + 'px';
        document.getElementById('${frameId}').style.height = '750px'`);
      assert.strictEqual(await run(`(() => {
        const controls = document.getElementById('bosun-acknowledged-controls');
        const row = controls.parentElement, button = controls.querySelector('button');
        const rect = row.getBoundingClientRect(), own = controls.getBoundingClientRect(), action = button.getBoundingClientRect();
        const native = [...row.querySelectorAll('[data-native]')];
        const separate = native.every(node => { const other = node.getBoundingClientRect();
          return own.right <= other.left + 1 || own.left >= other.right - 1 || own.bottom <= other.top + 1 || own.top >= other.bottom - 1; });
        const heading = row.querySelector('h3'), expand = row.querySelector('[data-native="expand"]');
        return separate && heading.nextElementSibling === expand && own.left >= rect.left - 1 && own.right <= rect.right + 1 && action.height <= 25 &&
          getComputedStyle(controls).backgroundColor === 'rgba(0, 0, 0, 0)' &&
          row.querySelectorAll('h3').length === 1 && row.querySelectorAll('[data-native]').length === 7;
      })()`), true, 'Inline controls fit the native row at width ' + width);
      if (process.env.BOSUN_HELPER_ACK_SCREENSHOTS_DIR) {
        const bounds = await run(`(() => { const rect = document.getElementById('bosun-acknowledged-controls').parentElement.getBoundingClientRect();
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; })()`);
        const frameBounds = await evaluate(client, `(() => { const frame = document.getElementById('${frameId}'), rect = frame.getBoundingClientRect();
          return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop }; })()`);
        const capture = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: bounds.x + frameBounds.x, y: bounds.y + frameBounds.y, width: bounds.width, height: bounds.height, scale: 1 } });
        fs.mkdirSync(process.env.BOSUN_HELPER_ACK_SCREENSHOTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.BOSUN_HELPER_ACK_SCREENSHOTS_DIR, 'ack-' + width + '.png'), Buffer.from(capture.data, 'base64'));
      }
    }
    await client.send('DOM.enable'); await client.send('CSS.enable');
    const treeForHover = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const findAction = node => {
      if (node.attributes?.some((value, index) => index % 2 === 0 && value === 'id' &&
        node.attributes[index + 1] === 'bosun-acknowledged-collapse-toggle')) return node;
      for (const child of [...(node.children || []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = findAction(child); if (found) return found;
      }
      return null;
    };
    const hoverAction = findAction(treeForHover.root);
    assert.ok(hoverAction, 'The mounted button is available for hover verification');
    await client.send('CSS.forcePseudoState', { nodeId: hoverAction.nodeId, forcedPseudoClasses: ['hover'] });
    assert.strictEqual(await run(`getComputedStyle(document.getElementById('bosun-acknowledged-collapse-toggle')).borderColor`), 'rgb(173, 173, 173)');
    await client.send('CSS.forcePseudoState', { nodeId: hoverAction.nodeId, forcedPseudoClasses: [] });
    await run('hooks.resetLifecycleCounters()');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepStrictEqual(await run('hooks.getLifecycleCounters()'), { domRefreshes: 0, dataRefreshes: 0 }, 'No idle observer loop');
    assert.strictEqual(await run('requests'), 0, 'Compact controls and repaints must not fetch');
    await mutate(`(() => { const root = document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]'); root.after(root.cloneNode(true)); })()`);
    await run(`history.replaceState({}, '', '/other'); hooks.handleRouteChange()`);
    assert.strictEqual(await run(`document.querySelectorAll('#bosun-acknowledged-controls, .bosun-acknowledged-collapsed').length`), 0);
    console.log('Acknowledged compact regressions passed (ordinary/priority/mixed, fail-open, storage, mutations, paused filter, Silenced, cleanup, no requests or idle loop)');
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: main.identifier });
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: isolated.identifier });
    await evaluate(client, `document.getElementById('${frameId}')?.remove()`);
  }
};
