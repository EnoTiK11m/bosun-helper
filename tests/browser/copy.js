'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runCopyAssertions({ client, copySource }) {
  const result = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe');
    await new Promise(resolve => { frame.onload = resolve; frame.src = '/'; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    try {
      doc.body.innerHTML = '<div id="need"><div class="panel" id="group"><div class="panel-heading"><div class="panel-title">' +
        '<span class="group"> group subject </span><span class="count">2 alerts</span></div></div>' +
        '<div class="panel" id="child"><div class="panel-heading"><span class="child" ng-bind="child.Subject || child.AlertKey"> child one </span></div></div>' +
        '<div class="panel"><div class="panel-heading"><span class="child" ng-bind="child.Subject || child.AlertKey"> child two </span></div></div></div></div>' +
        '<div id="ack"><div class="panel"><div class="panel-heading"><div class="panel-title">' +
        '<span class="group">ack subject</span><span class="count">1 alert</span></div></div></div></div><p id="outside">outside</p>';
      win.eval(${JSON.stringify(copySource)});
      let enabled = true;
      const writes = [], feedback = [], timers = new Map(), installed = [];
      let timerId = 0, finish;
      const originalAdd = doc.addEventListener.bind(doc);
      doc.addEventListener = (type, listener, capture) => { installed.push([type, capture]); originalAdd(type, listener, capture); };
      const group = doc.getElementById('group'), child = doc.getElementById('child');
      const options = {
        window: win, document: doc, navigator: { clipboard: { async writeText(text) { writes.push(text); } } },
        setTimeout(callback, delay) {
          const id = ++timerId; timers.set(id, { callback, delay }); feedback.push(delay); finish?.(); return id;
        },
        clearTimeout(id) { timers.delete(id); },
        isFeatureEnabled: () => enabled, clearToolbarStatus() {},
        getGroupSubjectNode: panel => panel.querySelector(':scope > .panel-heading .group'),
        getChildSubjectNode: panel => panel.querySelector(':scope > .panel-heading .child'),
        isGroupPanel: panel => !!panel.querySelector(':scope > .panel-heading .group'),
        getPanelTitle: panel => panel.querySelector(':scope > .panel-heading .panel-title'),
        getGroupCountNode: panel => panel.querySelector(':scope > .panel-heading .count'),
        parseGroupAlertCount: panel => Number(panel.querySelector(':scope > .panel-heading .count')?.textContent.split(' ')[0] || 0),
        getAcknowledgedPanels: () => [...doc.querySelectorAll('#ack > .panel')],
        getGroupPanels: () => [group],
        getChildAlertPanels: () => [...group.querySelectorAll('.panel')],
        copyButtonClass: 'bosun-copy-alert-btn', copyAllButtonClass: 'bosun-copy-all-alerts-btn'
      };
      const api = win.BosunHelperCopy.createCopyEnhancements(options);
      const inert = installed.length === 0 && timers.size === 0;
      api.ensureCopyButtons();
      const button = group.querySelector('.bosun-copy-alert-btn');
      const all = group.querySelector('.bosun-copy-all-alerts-btn');
      api.ensureCopyButtons();
      const dom = { singles: doc.querySelectorAll('.bosun-copy-alert-btn').length,
        all: doc.querySelectorAll('.bosun-copy-all-alerts-btn').length,
        stable: group.querySelector('.bosun-copy-alert-btn') === button,
        afterSubject: button.previousElementSibling.className,
        afterCount: all.previousElementSibling.className, type: button.type, title: button.title,
        text: button.textContent, unselectable: button.getAttribute('unselectable') };
      let bubbled = 0;
      group.addEventListener('click', () => { bubbled += 1; });
      async function clickAndWait(node) {
        const pending = new Promise(resolve => { finish = resolve; });
        const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(click);
        await pending;
        return click.defaultPrevented;
      }
      const active = api;
      group.querySelector('.group').textContent = ' changed subject ';
      const prevented = await clickAndWait(group.querySelector('.bosun-copy-alert-btn'));
      child.querySelector('.child').textContent = ' changed child ';
      await clickAndWait(group.querySelector('.bosun-copy-all-alerts-btn'));
      const copiedBubbled = bubbled;
      for (const node of group.querySelectorAll('.child')) node.remove();
      await clickAndWait(group.querySelector('.bosun-copy-all-alerts-btn'));
      const emptyTitle = group.querySelector('.bosun-copy-all-alerts-btn').title;
      group.querySelector('.count').textContent = '1 alert';
      active.ensureCopyButtons();
      const allRemoved = !group.querySelector('.bosun-copy-all-alerts-btn');
      enabled = false;
      const before = doc.body.innerHTML;
      active.ensureCopyButtons();
      const featureOff = doc.body.innerHTML === before;
      enabled = true;
      active.installSelectionGuard(); active.installSelectionCopySanitizer();
      active.installSelectionGuard(); active.installSelectionCopySanitizer();
      win.BosunHelperCopy.createCopyEnhancements(options).installSelectionGuard();
      win.BosunHelperCopy.createCopyEnhancements(options).installSelectionCopySanitizer();
      const heading = group.querySelector('.panel-heading'), subject = group.querySelector('.group');
      subject.style.whiteSpace = 'pre';
      subject.textContent = String.fromCharCode(160) + ' Alpha ' + String.fromCharCode(10) + ' Beta  ';
      function select(node) {
        const selection = win.getSelection(), range = doc.createRange(); range.selectNodeContents(node);
        selection.removeAllRanges(); selection.addRange(range);
      }
      select(subject);
      let sanitized = null;
      const copy = new win.Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copy, 'clipboardData', { value: { setData(type, text) { sanitized = [type, text]; } } });
      subject.dispatchEvent(copy);
      function mouse(type, x, y, target = subject) {
        const event = new win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
        target.dispatchEvent(event); return event.defaultPrevented;
      }
      mouse('mousedown', 10, 10); mouse('mousemove', 14, 14);
      const thresholdClick = mouse('click', 14, 14);
      mouse('mousemove', 15, 10);
      const dragClick = mouse('click', 15, 10);
      mouse('mouseup', 15, 10);
      for (const [id, timer] of timers) if (timer.delay === 0) { timer.callback(); timers.delete(id); }
      const afterMouseup = mouse('click', 15, 10);
      select(doc.getElementById('outside'));
      const outside = new win.Event('copy', { bubbles: true, cancelable: true });
      doc.getElementById('outside').dispatchEvent(outside);
      select(subject);
      const fallback = new win.Event('copy', { bubbles: true, cancelable: true });
      subject.dispatchEvent(fallback);
      win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
      win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
      active.installSelectionGuard(); active.installSelectionCopySanitizer();
      return { inert, dom, writes, feedback, prevented, copiedBubbled,
        emptyTitle, allRemoved, featureOff, installed, sanitized, copyPrevented: copy.defaultPrevented,
        thresholdClick, dragClick, afterMouseup, outsidePrevented: outside.defaultPrevented,
        fallbackPrevented: fallback.defaultPrevented, flags: [win.__bosunSelectionGuardInstalled, win.__bosunSelectionCopySanitizerInstalled] };
    } finally { frame.remove(); }
  })()`);
  assert.deepStrictEqual(result.dom, { singles: 4, all: 1, stable: true, afterSubject: 'group', afterCount: 'count',
    type: 'button', title: 'Скопировать текст алерта', text: 'Копировать', unselectable: 'on' });
  assert.strictEqual(result.inert, true);
  assert.deepStrictEqual(result.writes, ['changed subject', 'changed child\nchild two', 'Alpha\nBeta']);
  assert.deepStrictEqual(result.feedback, [1200, 1200, 2500, 0]);
  assert.strictEqual(result.prevented, true);
  assert.strictEqual(result.copiedBubbled, 0);
  assert.strictEqual(result.emptyTitle, 'Внимание! Сначала раскрой и проверь!');
  assert.strictEqual(result.allRemoved, true);
  assert.strictEqual(result.featureOff, true);
  assert.deepStrictEqual(result.installed, [['mousedown', true], ['mousemove', true], ['mouseup', true], ['click', true], ['copy', true]]);
  assert.deepStrictEqual(result.sanitized, ['text/plain', 'Alpha\nBeta']);
  assert.strictEqual(result.copyPrevented, true);
  assert.strictEqual(result.thresholdClick, false);
  assert.strictEqual(result.dragClick, true);
  assert.strictEqual(result.afterMouseup, false);
  assert.strictEqual(result.outsidePrevented, false);
  assert.strictEqual(result.fallbackPrevented, false);
  assert.deepStrictEqual(result.flags, [true, true]);
};
