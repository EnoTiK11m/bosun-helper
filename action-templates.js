(() => {
  'use strict';

  const DEFAULT_TEMPLATES = Object.freeze({
    note: Object.freeze(['пройдет', 'пройдет через час', 'смотрю', 'в работе', 'норма', 'моргнуло', 'сдано в ']),
    ack: Object.freeze(['пройдет', 'пройдет через час', 'норма', 'моргнуло', 'сдано в ']),
    close: Object.freeze([])
  });

  function createActionTemplates(options = {}) {
    const {
      isActionPage = () => false,
      templatesByType = DEFAULT_TEMPLATES,
      wrapClass = 'bosun-action-templates',
      titleClass = 'bosun-action-templates-title',
      buttonsClass = 'bosun-action-templates-buttons',
      buttonClass = 'bosun-action-template-btn'
    } = options;

    function getActionType() {
      try {
        return new URLSearchParams(window.location.search).get('type') || '';
      } catch (_) {
        return '';
      }
    }

    function getTemplatesForType(type) {
      const templates = templatesByType?.[type];
      return Array.isArray(templates) ? templates : [];
    }

    function findMessageTextarea() {
      const areas = Array.from(document.querySelectorAll('textarea'));
      if (!areas.length) return null;
      return areas.find((element) => element.offsetParent !== null) || areas[0] || null;
    }

    function setNativeTextareaValue(textarea, value) {
      if (!textarea) return;

      const proto = Object.getPrototypeOf(textarea);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      const setter = descriptor && typeof descriptor.set === 'function' ? descriptor.set : null;

      if (setter) {
        setter.call(textarea, value);
        return;
      }

      textarea.value = value;
    }

    function moveCursorToEnd(textarea) {
      if (!textarea) return;
      const position = (textarea.value || '').length;
      try {
        textarea.setSelectionRange(position, position);
      } catch (_) {}
    }

    function insertTemplate(value) {
      // Bosun can replace the textarea without replacing its parent. Resolve it at
      // click time so buttons never retain a detached Angular-controlled element.
      const textarea = findMessageTextarea();
      if (!textarea || !textarea.parentElement) return false;

      const current = textarea.value || '';
      const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${value}` : value;

      setNativeTextareaValue(textarea, next);
      textarea.focus();
      moveCursorToEnd(textarea);
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText'
      }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
      textarea.focus();
      moveCursorToEnd(textarea);
      return true;
    }

    function refresh() {
      const existing = document.querySelector(`.${wrapClass}`);
      if (!isActionPage()) {
        existing?.remove();
        return;
      }

      const type = getActionType();
      const templates = getTemplatesForType(type);
      if (!templates.length) {
        existing?.remove();
        return;
      }

      const textarea = findMessageTextarea();
      if (!textarea || !textarea.parentElement) return;

      let wrap = existing;
      const signature = `${type}::${templates.join('|')}`;
      const alreadyBuilt = wrap
        && wrap.dataset.templateSignature === signature
        && wrap.parentElement === textarea.parentElement
        && wrap.nextElementSibling === textarea;

      if (alreadyBuilt) return;

      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = wrapClass;
      }

      if (wrap.parentElement !== textarea.parentElement || wrap.nextElementSibling !== textarea) {
        textarea.parentElement.insertBefore(wrap, textarea);
      }

      wrap.textContent = '';
      wrap.dataset.templateSignature = signature;

      const title = document.createElement('div');
      title.className = titleClass;
      title.textContent = 'Частые комментарии';
      wrap.appendChild(title);

      const buttons = document.createElement('div');
      buttons.className = buttonsClass;
      templates.forEach((template) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = buttonClass;
        button.textContent = template;
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
        });
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          insertTemplate(template);
        });
        buttons.appendChild(button);
      });
      wrap.appendChild(buttons);
    }

    function destroy() {
      document.querySelector(`.${wrapClass}`)?.remove();
    }

    return {
      refresh,
      destroy
    };
  }

  globalThis.BosunHelperActionTemplates = {
    createActionTemplates
  };
})();
