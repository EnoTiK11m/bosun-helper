(() => {
  'use strict';

  function createLastActionEnhancements({
    isFeatureEnabled, copyTextToClipboard, flashCopyButtonState,
    copyLastActionButtonClass: COPY_LAST_ACTION_BUTTON_CLASS,
    lastActionLinkClass: LAST_ACTION_LINK_CLASS,
    lastActionTimeTextClass: LAST_ACTION_TIME_TEXT_CLASS,
    lastActionMessageSelector: LAST_ACTION_MESSAGE_SELECTOR
  }) {
  function getLastActionMessageText(messageNode) {
    if (!messageNode) return '';
    const text = typeof messageNode.innerText === 'string'
      ? messageNode.innerText
      : (messageNode.textContent || '');
    return text
      .replace(/\r\n?/g, '\n')
      .trim()
      .replace(/^:\s*/, '');
  }

  function getLastActionMessageNode(container) {
    return container?.querySelector(
      ':scope > [ng-show="state.LastAction.Message"], ' +
      ':scope > [ng-bind="state.LastAction.Message"]'
    ) || null;
  }

  function trimUrlEnd(rawUrl) {
    let url = rawUrl;
    let suffix = '';
    while (/[.,;:!?]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
    let changed = true;
    while (changed && url) {
      changed = false;
      for (const [open, close] of pairs) {
        if (!url.endsWith(close)) continue;
        const openCount = url.split(open).length - 1;
        const closeCount = url.split(close).length - 1;
        if (closeCount > openCount) {
          suffix = close + suffix;
          url = url.slice(0, -1);
          changed = true;
          break;
        }
      }
    }
    return { url, suffix };
  }

  function linkifyLastActionMessage(messageNode) {
    if (!messageNode) return;
    const textNodes = [];
    const walker = document.createTreeWalker(messageNode, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      if (!textNode.parentElement?.closest('a')) textNodes.push(textNode);
      textNode = walker.nextNode();
    }

    for (const node of textNodes) {
      const source = node.nodeValue || '';
      const pattern = /\bhttps?:\/\/[^\s<>"']+/gi;
      let match = pattern.exec(source);
      if (!match) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let linked = false;
      do {
        const rawUrl = match[0];
        const { url, suffix } = trimUrlEnd(rawUrl);
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch (_) {}

        fragment.appendChild(document.createTextNode(source.slice(cursor, match.index)));
        if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
          const link = document.createElement('a');
          link.className = LAST_ACTION_LINK_CLASS;
          link.href = parsed.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = url;
          link.title = 'Открыть ссылку в новой вкладке';
          fragment.appendChild(link);
          linked = true;
          if (suffix) fragment.appendChild(document.createTextNode(suffix));
        } else {
          fragment.appendChild(document.createTextNode(rawUrl));
        }
        cursor = pattern.lastIndex;
        match = pattern.exec(source);
      } while (match);
      fragment.appendChild(document.createTextNode(source.slice(cursor)));
      if (linked) node.replaceWith(fragment);
    }
  }

  function disableLastActionTimeLinks() {
    document
      .querySelectorAll('[ts-time="state.LastAction.Time"] a')
      .forEach((link) => {
        const text = document.createElement('span');
        text.className = LAST_ACTION_TIME_TEXT_CLASS;
        text.style.color = getComputedStyle(link).color;
        while (link.firstChild) text.appendChild(link.firstChild);
        link.replaceWith(text);
      });
  }

  function ensureLastActionCopyButtons() {
    if (!isFeatureEnabled('lastActionEnhancements')) return;
    disableLastActionTimeLinks();
    document
      .querySelectorAll(`.${COPY_LAST_ACTION_BUTTON_CLASS}[data-bosun-message-copy]`)
      .forEach((button) => {
        const currentMessage = getLastActionMessageNode(button.parentElement);
        if (!getLastActionMessageText(currentMessage)) button.remove();
      });

    document
      .querySelectorAll(LAST_ACTION_MESSAGE_SELECTOR)
      .forEach((messageNode) => {
        linkifyLastActionMessage(messageNode);
        const existing = messageNode.parentElement?.querySelector(
          `:scope > .${COPY_LAST_ACTION_BUTTON_CLASS}[data-bosun-message-copy]`
        );
        if (!getLastActionMessageText(messageNode)) {
          existing?.remove();
          return;
        }
        if (existing) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = COPY_LAST_ACTION_BUTTON_CLASS;
        btn.dataset.bosunMessageCopy = 'true';
        btn.textContent = 'Копировать';
        btn.title = 'Скопировать текст заметки';
        btn.setAttribute('aria-label', 'Скопировать текст заметки');
        btn.setAttribute('unselectable', 'on');

        btn.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentMessage = getLastActionMessageNode(btn.parentElement);
          const text = getLastActionMessageText(currentMessage);
          const ok = await copyTextToClipboard(text);
          flashCopyButtonState(btn, ok, 'Не удалось скопировать заметку');
        });

        messageNode.insertAdjacentElement('afterend', btn);
      });
  }

    return { getLastActionMessageText, ensureLastActionCopyButtons };
  }

  globalThis.BosunHelperLastAction = { createLastActionEnhancements };
})();
