'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

module.exports = async function runLastActionAssertions({ client, lastActionSource }) {
  const moduleResult = await evaluate(client, `(async () => {
    const frame = document.createElement('iframe');
    await new Promise(resolve => { frame.onload = resolve; frame.src = '/'; document.body.appendChild(frame); });
    const win = frame.contentWindow, doc = frame.contentDocument;
    try {
      doc.body.innerHTML = '<div id="first"><span ts-time="state.LastAction.Time"><a href="#time">now</a></span>' +
        '<span ng-bind="state.LastAction.Message">: https://example.test/a_(b)). ' +
        '<a href="https://example.test/existing">existing</a> javascript:alert(1) http://.</span></div>' +
        '<div id="second"><span ng-show="state.LastAction.Message">: duplicate</span></div>';
      const effects = { timers: 0, listeners: 0, observers: 0 };
      for (const name of ['setTimeout', 'setInterval']) {
        const original = win[name].bind(win);
        win[name] = (...args) => { effects.timers += 1; return original(...args); };
      }
      for (const target of [win, doc]) {
        const original = target.addEventListener.bind(target);
        target.addEventListener = (...args) => { effects.listeners += 1; return original(...args); };
      }
      const Observer = win.MutationObserver;
      win.MutationObserver = class extends Observer { constructor(...args) { super(...args); effects.observers += 1; } };
      win.eval(${JSON.stringify(lastActionSource)});
      let enabled = false, copiedOk = true;
      const writes = [], feedback = [];
      let finishFeedback;
      const api = win.BosunHelperLastAction.createLastActionEnhancements({
        isFeatureEnabled(name) { if (name !== 'lastActionEnhancements') throw new Error('Wrong feature'); return enabled; },
        async copyTextToClipboard(text) { writes.push(text); return copiedOk; },
        flashCopyButtonState(button, ok, errorText) {
          feedback.push({ currentButton: button.isConnected, ok, errorText });
          finishFeedback?.();
        },
        copyLastActionButtonClass: 'bosun-copy-last-action-btn',
        lastActionLinkClass: 'bosun-last-action-link',
        lastActionTimeTextClass: 'bosun-last-action-time-text',
        lastActionMessageSelector: '[ng-show="state.LastAction.Message"], [ng-bind="state.LastAction.Message"]'
      });
      const initial = doc.body.innerHTML;
      api.ensureLastActionCopyButtons();
      const disabledInert = doc.body.innerHTML === initial;
      enabled = true;
      api.ensureLastActionCopyButtons();
      const first = doc.getElementById('first'), second = doc.getElementById('second');
      const button = first.querySelector('button');
      const secondButton = second.querySelector('button');
      const link = first.querySelector('.bosun-last-action-link');
      const linked = { href: link.href, text: link.textContent, rel: link.rel, target: link.target,
        originalLinks: first.querySelectorAll('a[href="https://example.test/existing"]').length,
        timeLinks: first.querySelector('[ts-time]').querySelectorAll('a').length,
        unsafeLinks: first.querySelectorAll('a[href^="javascript:"], a[href^="data:"]').length };
      const enhanced = doc.body.innerHTML;
      api.ensureLastActionCopyButtons();
      const repeatedStable = doc.body.innerHTML === enhanced && first.querySelector('button') === button;
      const replacement = doc.createElement('span');
      replacement.setAttribute('ng-bind', 'state.LastAction.Message');
      replacement.textContent = ': current replacement';
      first.querySelector('[ng-bind]').replaceWith(replacement);
      let bubbled = 0;
      first.addEventListener('click', () => { bubbled += 1; });
      const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
      const firstFeedback = new Promise(resolve => { finishFeedback = resolve; });
      button.dispatchEvent(click);
      await firstFeedback;
      copiedOk = false;
      const secondFeedback = new Promise(resolve => { finishFeedback = resolve; });
      secondButton.click();
      await secondFeedback;
      enabled = false;
      const disabledBefore = doc.body.innerHTML;
      api.ensureLastActionCopyButtons();
      const disabledKeepsExisting = doc.body.innerHTML === disabledBefore;
      enabled = true;
      win.dispatchEvent(new win.PageTransitionEvent('pagehide', { persisted: true }));
      win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
      api.ensureLastActionCopyButtons();
      const resumedStable = first.querySelectorAll('button').length === 1 && first.querySelector('button') === button;
      replacement.textContent = ':   ';
      api.ensureLastActionCopyButtons();
      const emptyRemoved = !button.isConnected;
      second.querySelector('[ng-show]').remove();
      api.ensureLastActionCopyButtons();
      return { disabledInert, repeatedStable, linked, writes, feedback,
        defaultPrevented: click.defaultPrevented, bubbled, disabledKeepsExisting, resumedStable,
        emptyRemoved, orphanRemoved: !secondButton.isConnected, effects };
    } finally { frame.remove(); }
  })()`);
  assert.deepStrictEqual(moduleResult, {
    disabledInert: true, repeatedStable: true,
    linked: { href: 'https://example.test/a_(b)', text: 'https://example.test/a_(b)',
      rel: 'noopener noreferrer', target: '_blank', originalLinks: 1, timeLinks: 0, unsafeLinks: 0 },
    writes: ['current replacement', 'duplicate'],
    feedback: [
      { currentButton: true, ok: true, errorText: 'Не удалось скопировать заметку' },
      { currentButton: true, ok: false, errorText: 'Не удалось скопировать заметку' }
    ],
    defaultPrevented: true, bubbled: 0, disabledKeepsExisting: true, resumedStable: true,
    emptyRemoved: true, orphanRemoved: true, effects: { timers: 0, listeners: 0, observers: 0 }
  });
};
