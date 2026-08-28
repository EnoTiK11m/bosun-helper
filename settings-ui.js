(() => {
  'use strict';

  const BUTTON_ID = 'bosun-settings-button';
  const MODAL_ID = 'bosun-settings-modal';
  const CLOSE_ID = 'bosun-settings-close';
  const RESET_ID = 'bosun-settings-reset';
  const STATUS_ID = 'bosun-settings-status';

  const GROUPS = Object.freeze([
    Object.freeze({
      title: 'Интерфейс',
      fields: Object.freeze([
        Object.freeze({ path: 'features.singleAlertAge', label: 'Возраст одиночного алерта' }),
        Object.freeze({ path: 'features.checkboxImprovements', label: 'Улучшенные checkbox' }),
        Object.freeze({ path: 'features.copyButtons', label: 'Кнопки копирования' }),
        Object.freeze({
          path: 'features.lastActionEnhancements',
          label: 'Last Action: ссылки и копирование',
          hint: 'Применится после перезагрузки страницы',
          reloadRequired: true
        })
      ])
    }),
    Object.freeze({
      title: 'Алерты',
      fields: Object.freeze([
        Object.freeze({ path: 'features.silencedFilter', label: 'Скрывать Silenced' }),
        Object.freeze({ path: 'features.noCommentFilter', label: 'Фильтр «Без комментария»' }),
        Object.freeze({ path: 'features.acknowledgedCollapse', label: 'Сворачивать Acknowledged' }),
        Object.freeze({ path: 'features.visualNewAlertNotifications', label: 'Визуальные уведомления о новых алертах' })
      ])
    }),
    Object.freeze({
      title: 'Уведомления',
      fields: Object.freeze([
        Object.freeze({ path: 'features.soundNotifications', label: 'Звуковые уведомления' })
      ])
    }),
    Object.freeze({
      title: 'Автообновление',
      fields: Object.freeze([
        Object.freeze({ path: 'features.autoRefresh', label: 'Включить автообновление' }),
        Object.freeze({
          path: 'preferences.autoRefreshIdleSeconds',
          label: 'Интервал бездействия',
          type: 'number',
          min: 10,
          max: 3600,
          suffix: 'сек.'
        })
      ])
    }),
    Object.freeze({
      title: 'Интеграции',
      fields: Object.freeze([
        Object.freeze({ path: 'features.grafanaIntegration', label: 'Интеграция с Grafana' })
      ])
    }),
    Object.freeze({
      title: 'Шаблоны',
      collapsible: true,
      fields: Object.freeze([
        Object.freeze({ path: 'features.actionTemplates', label: 'Шаблоны быстрых действий' }),
        Object.freeze({ path: 'actionTemplates.note', label: 'Note', type: 'templates' }),
        Object.freeze({ path: 'actionTemplates.ack', label: 'Ack', type: 'templates' }),
        Object.freeze({ path: 'actionTemplates.close', label: 'Close', type: 'templates' })
      ])
    })
  ]);

  function createElement(tagName, className = '', text = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function readPath(snapshot, path) {
    const [section, name] = String(path || '').split('.');
    return snapshot?.[section]?.[name];
  }

  function isThenable(value) {
    return value && typeof value.then === 'function';
  }

  function createSettingsUi(options = {}) {
    const settingsStore = options.settingsStore || null;
    if (
      !settingsStore ||
      typeof settingsStore.getSnapshot !== 'function' ||
      typeof settingsStore.update !== 'function' ||
      typeof settingsStore.reset !== 'function' ||
      typeof settingsStore.subscribe !== 'function'
    ) return null;

    const availablePaths = new Set(
      Array.isArray(options.schema)
        ? options.schema.map((entry) => entry?.path).filter((path) => typeof path === 'string')
        : []
    );
    const toolbarId = String(options.toolbarId || 'bosun-top-controls-bar');
    const reportStatus = typeof options.reportStatus === 'function' ? options.reportStatus : () => {};
    const confirmReset = typeof options.confirmReset === 'function'
      ? options.confirmReset
      : () => globalThis.confirm?.('Сбросить настройки Bosun Helper к значениям по умолчанию?') === true;

    let destroyed = false;
    let button = null;
    let modal = null;
    let panel = null;
    let status = null;
    let resetButton = null;
    let previousFocus = null;
    let unsubscribe = null;
    let resetOperation = 0;
    let updateSequence = 0;
    const pendingByPath = new Map();

    function isOpen() {
      return Boolean(modal?.classList.contains('is-open'));
    }

    function setStatus(message = '', level = '') {
      if (!status) return;
      status.textContent = String(message || '');
      status.classList.toggle('is-error', level === 'error');
    }

    function restoreOperationFocus(focusTarget) {
      if (
        !isOpen() ||
        !focusTarget?.isConnected ||
        (document.activeElement && document.activeElement !== document.body)
      ) return;
      focusTarget.focus?.();
    }

    function getFocusableElements() {
      if (!panel) return [];
      return Array.from(panel.querySelectorAll(
        'summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => {
        if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
        return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
      });
    }

    function renderSnapshot(snapshot = settingsStore.getSnapshot()) {
      if (destroyed || !modal || !snapshot) return;
      for (const control of modal.querySelectorAll('[data-setting-path]')) {
        const path = control.dataset.settingPath;
        const value = readPath(snapshot, path);
        if (control.type === 'checkbox') {
          control.checked = value === true;
        } else if (control.tagName === 'TEXTAREA') {
          control.value = Array.isArray(value) ? value.join('\n') : '';
          control.dataset.usesDefaults = value === null ? 'true' : 'false';
          const mode = modal.querySelector(`[data-template-mode-path="${path}"]`);
          if (mode) mode.textContent = value === null ? 'Используются встроенные значения' : '';
          const defaultButton = modal.querySelector(`[data-template-default-path="${path}"]`);
          if (defaultButton) {
            defaultButton.disabled = value === null || pendingByPath.has(path) || resetOperation !== 0;
          }
        } else {
          control.value = value == null ? '' : String(value);
        }
        control.disabled = pendingByPath.has(path) || resetOperation !== 0;
      }
      if (resetButton) resetButton.disabled = resetOperation !== 0 || pendingByPath.size > 0;
    }

    function reportSaveFailure(error) {
      setStatus('Не удалось сохранить настройку. Значение восстановлено.', 'error');
      reportStatus('Настройка не сохранена', 'error', error?.message || 'settings-update-failed');
    }

    async function updateSetting(path, value) {
      if (destroyed || resetOperation !== 0 || !availablePaths.has(path)) return;
      const focusTarget = document.activeElement;
      const operation = ++updateSequence;
      pendingByPath.set(path, operation);
      setStatus('Сохранение…');
      renderSnapshot();
      try {
        const next = await settingsStore.update({ [path]: value });
        if (destroyed || pendingByPath.get(path) !== operation) return;
        setStatus('Сохранено');
        renderSnapshot(next);
      } catch (error) {
        if (destroyed || pendingByPath.get(path) !== operation) return;
        reportSaveFailure(error);
        renderSnapshot();
      } finally {
        if (!destroyed && pendingByPath.get(path) === operation) {
          pendingByPath.delete(path);
          renderSnapshot();
          restoreOperationFocus(focusTarget);
        }
      }
    }

    function handleControlChange(event) {
      const control = event.target?.closest?.('[data-setting-path]');
      if (!control || !modal?.contains(control)) return;
      const path = control.dataset.settingPath;
      if (!availablePaths.has(path)) return;
      if (control.type === 'checkbox') {
        updateSetting(path, control.checked === true);
        return;
      }
      if (control.tagName === 'TEXTAREA') {
        const templates = control.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        updateSetting(path, templates);
        return;
      }
      updateSetting(path, control.value);
    }

    function handleTemplateDefault(event) {
      const defaultButton = event.target?.closest?.('[data-template-default-path]');
      if (!defaultButton || !modal?.contains(defaultButton)) return;
      updateSetting(defaultButton.dataset.templateDefaultPath, null);
    }

    function close(closeOptions = {}) {
      if (!isOpen()) return;
      modal.classList.remove('is-open');
      modal.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
      const focusTarget = closeOptions.restoreFocus === false ? null : previousFocus;
      previousFocus = null;
      if (focusTarget?.isConnected && typeof focusTarget.focus === 'function') focusTarget.focus();
      else if (closeOptions.restoreFocus !== false && button?.isConnected) button.focus();
    }

    function open() {
      if (destroyed) return;
      ensureModal();
      if (!modal || isOpen()) return;
      previousFocus = document.activeElement;
      renderSnapshot();
      setStatus();
      modal.hidden = false;
      modal.classList.add('is-open');
      button?.setAttribute('aria-expanded', 'true');
      document.getElementById(CLOSE_ID)?.focus();
    }

    function handleDocumentKeydown(event) {
      if (!isOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!panel?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    async function handleReset() {
      if (destroyed || resetOperation !== 0 || pendingByPath.size > 0) return;
      let confirmed = false;
      try {
        const result = confirmReset();
        confirmed = isThenable(result) ? await result : result;
      } catch (error) {
        reportSaveFailure(error);
        return;
      }
      if (!confirmed || destroyed) return;
      const operation = ++updateSequence;
      const focusTarget = document.activeElement;
      resetOperation = operation;
      setStatus('Сброс настроек…');
      renderSnapshot();
      try {
        const next = await settingsStore.reset();
        if (destroyed || resetOperation !== operation) return;
        setStatus('Настройки сброшены');
        reportStatus('Настройки сброшены', 'info');
        renderSnapshot(next);
      } catch (error) {
        if (destroyed || resetOperation !== operation) return;
        setStatus('Не удалось сбросить настройки.', 'error');
        reportStatus('Настройки не сброшены', 'error', error?.message || 'settings-reset-failed');
        renderSnapshot();
      } finally {
        if (!destroyed && resetOperation === operation) {
          resetOperation = 0;
          renderSnapshot();
          restoreOperationFocus(focusTarget);
        }
      }
    }

    function createBooleanField(field) {
      const label = createElement('label', 'bosun-settings-toggle');
      const input = createElement('input');
      input.type = 'checkbox';
      input.dataset.settingPath = field.path;
      const copy = createElement('span', 'bosun-settings-toggle-copy');
      copy.appendChild(createElement('span', 'bosun-settings-toggle-label', field.label));
      if (field.hint) {
        copy.appendChild(createElement(
          'span',
          field.reloadRequired ? 'bosun-settings-field-hint bosun-settings-reload-hint' : 'bosun-settings-field-hint',
          field.hint
        ));
      }
      label.appendChild(input);
      label.appendChild(copy);
      return label;
    }

    function createNumberField(field) {
      const label = createElement('label', 'bosun-settings-number-row');
      label.appendChild(createElement('span', 'bosun-settings-number-label', field.label));
      const valueWrap = createElement('span', 'bosun-settings-number-value');
      const input = createElement('input', 'bosun-settings-number-input');
      input.type = 'number';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = '1';
      input.inputMode = 'numeric';
      input.dataset.settingPath = field.path;
      input.setAttribute('aria-label', `${field.label}, секунд`);
      valueWrap.appendChild(input);
      valueWrap.appendChild(createElement('span', 'bosun-settings-number-suffix', field.suffix));
      label.appendChild(valueWrap);
      return label;
    }

    function createTemplateField(field) {
      const wrapper = createElement('div', 'bosun-settings-template');
      const titleRow = createElement('div', 'bosun-settings-template-title-row');
      const label = createElement('label', 'bosun-settings-template-label', field.label);
      const inputId = `bosun-settings-template-${field.path.split('.')[1]}`;
      label.htmlFor = inputId;
      const defaultButton = createElement('button', 'bosun-settings-small-button', 'Встроенные');
      defaultButton.type = 'button';
      defaultButton.dataset.templateDefaultPath = field.path;
      defaultButton.title = `Вернуть встроенные шаблоны ${field.label}`;
      defaultButton.setAttribute('aria-label', `Вернуть встроенные шаблоны: ${field.label}`);
      titleRow.appendChild(label);
      titleRow.appendChild(defaultButton);
      const textarea = createElement('textarea', 'bosun-settings-template-input');
      textarea.id = inputId;
      textarea.rows = 3;
      textarea.dataset.settingPath = field.path;
      textarea.placeholder = 'Один шаблон на строку';
      const mode = createElement('span', 'bosun-settings-template-mode');
      mode.id = `${inputId}-mode`;
      mode.dataset.templateModePath = field.path;
      textarea.setAttribute('aria-describedby', mode.id);
      wrapper.appendChild(titleRow);
      wrapper.appendChild(textarea);
      wrapper.appendChild(mode);
      return wrapper;
    }

    function createField(field) {
      if (field.type === 'number') return createNumberField(field);
      if (field.type === 'templates') return createTemplateField(field);
      return createBooleanField(field);
    }

    function ensureModal() {
      if (destroyed) return null;
      if (!modal) {
        modal = createElement('div', 'bosun-settings-modal');
        modal.id = MODAL_ID;
        modal.hidden = true;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'bosun-settings-title');

        panel = createElement('section', 'bosun-settings-panel');
        panel.tabIndex = -1;
        const header = createElement('header', 'bosun-settings-header');
        header.appendChild(createElement('h2', 'bosun-settings-title', 'Настройки Bosun Helper'));
        header.firstChild.id = 'bosun-settings-title';
        const closeButton = createElement('button', 'bosun-settings-close', '×');
        closeButton.id = CLOSE_ID;
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', 'Закрыть настройки');
        closeButton.addEventListener('click', () => close());
        header.appendChild(closeButton);
        panel.appendChild(header);

        const body = createElement('div', 'bosun-settings-body');
        for (const group of GROUPS) {
          const fields = group.fields.filter((field) => availablePaths.has(field.path));
          if (!fields.length) continue;
          const section = createElement(
            group.collapsible ? 'details' : 'fieldset',
            group.collapsible
              ? 'bosun-settings-group bosun-settings-group-collapsible'
              : 'bosun-settings-group'
          );
          section.appendChild(createElement(
            group.collapsible ? 'summary' : 'legend',
            'bosun-settings-group-title',
            group.title
          ));
          for (const field of fields) section.appendChild(createField(field));
          body.appendChild(section);
        }
        panel.appendChild(body);

        const footer = createElement('footer', 'bosun-settings-footer');
        status = createElement('span', 'bosun-settings-status');
        status.id = STATUS_ID;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        resetButton = createElement('button', 'bosun-settings-reset', 'Сбросить настройки');
        resetButton.id = RESET_ID;
        resetButton.type = 'button';
        resetButton.addEventListener('click', handleReset);
        footer.appendChild(status);
        footer.appendChild(resetButton);
        panel.appendChild(footer);
        modal.appendChild(panel);

        modal.addEventListener('change', handleControlChange);
        modal.addEventListener('click', (event) => {
          if (event.target === modal) close();
          else handleTemplateDefault(event);
        });
      }
      if (!modal.isConnected) document.body?.appendChild(modal);
      return modal;
    }

    function ensureButton(actions) {
      if (!button) {
        button = createElement('button', 'bosun-toolbar-btn bosun-settings-button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', MODAL_ID);
        button.setAttribute('aria-expanded', 'false');
        const icon = createElement('span', 'bosun-toolbar-btn-icon', '⚙');
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.appendChild(createElement('span', 'bosun-toolbar-btn-label', 'Настройки'));
        button.addEventListener('click', () => {
          if (isOpen()) close();
          else open();
        });
      }
      if (button.parentElement !== actions) actions.appendChild(button);
      return button;
    }

    function mount(actions) {
      if (destroyed) return null;
      const target = actions || document.querySelector(`#${toolbarId} .bosun-top-controls-actions`);
      if (!target) return null;
      ensureModal();
      ensureButton(target);
      renderSnapshot();
      return button;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      resetOperation = 0;
      pendingByPath.clear();
      unsubscribe?.();
      unsubscribe = null;
      document.removeEventListener('keydown', handleDocumentKeydown, true);
      modal?.remove();
      button?.remove();
      modal = null;
      panel = null;
      button = null;
      status = null;
      resetButton = null;
      previousFocus = null;
    }

    document.addEventListener('keydown', handleDocumentKeydown, true);
    unsubscribe = settingsStore.subscribe((next) => renderSnapshot(next));

    return Object.freeze({ mount, open, close, isOpen, destroy });
  }

  globalThis.BosunHelperSettingsUi = Object.freeze({
    BUTTON_ID,
    MODAL_ID,
    CLOSE_ID,
    RESET_ID,
    createSettingsUi
  });
})();
