(() => {
  'use strict';

  const STORAGE_KEY = 'bosunActionTemplatesV1';
  const ACTION_TYPES = Object.freeze(['note', 'ack', 'close']);
  const MAX_TEMPLATES_PER_TYPE = 50;
  const MAX_TEMPLATE_LENGTH = 500;
  const MAX_TOTAL_TEMPLATE_TEXT_LENGTH = 10000;
  const DEFAULT_TEMPLATES = Object.freeze({
    note: Object.freeze(['пройдет', 'пройдет через час', 'смотрю', 'в работе', 'норма', 'моргнуло', 'сдано в ']),
    ack: Object.freeze(['пройдет', 'пройдет через час', 'норма', 'моргнуло', 'сдано в ']),
    close: Object.freeze([])
  });

  function createActionTemplates(options = {}) {
    const {
      isActionPage = () => false,
      templatesByType = DEFAULT_TEMPLATES,
      getStorage = () => globalThis.chrome?.storage?.local || null,
      getLastError = () => globalThis.chrome?.runtime?.lastError || null,
      settingsStore = null,
      storageKey = STORAGE_KEY,
      wrapClass = 'bosun-action-templates',
      titleClass = 'bosun-action-templates-title',
      buttonsClass = 'bosun-action-templates-buttons',
      buttonClass = 'bosun-action-template-btn'
    } = options;

    let storedTemplates = {};
    let storageLoaded = false;
    let storageLoadStarted = false;
    let editorOpen = false;
    let editorType = '';
    let draftTemplates = [];
    let renderVersion = 0;
    let storageStatus = '';
    let storageStatusIsError = false;
    let storageChangeTrackingInstalled = false;
    let storageChangeListener = null;
    let storageChangesApi = null;
    let storageWritePending = false;
    let storageLoadGeneration = 0;

    function getActionType() {
      try {
        return new URLSearchParams(window.location.search).get('type') || '';
      } catch (_) {
        return '';
      }
    }

    function isSupportedType(type) {
      return ACTION_TYPES.includes(type);
    }

    function normalizeTemplates(value) {
      if (!Array.isArray(value)) return null;
      const result = [];
      const seen = new Set();
      let totalLength = 0;
      let scannedItems = 0;
      for (const item of value) {
        scannedItems += 1;
        if (scannedItems > MAX_TEMPLATES_PER_TYPE * 4 || result.length >= MAX_TEMPLATES_PER_TYPE) break;
        if (typeof item !== 'string') continue;
        const text = item.trim();
        if (
          !text ||
          text.length > MAX_TEMPLATE_LENGTH ||
          seen.has(text) ||
          totalLength + text.length > MAX_TOTAL_TEMPLATE_TEXT_LENGTH
        ) continue;
        seen.add(text);
        result.push(text);
        totalLength += text.length;
      }
      return result;
    }

    function getDefaultTemplates(type) {
      const templates = templatesByType?.[type];
      if (!Array.isArray(templates)) return [];
      return templates.filter((item) => typeof item === 'string' && item.trim());
    }

    function getTemplatesForType(type) {
      if (Object.prototype.hasOwnProperty.call(storedTemplates, type)) {
        return storedTemplates[type].slice();
      }
      return getDefaultTemplates(type);
    }

    function warnStorage(message, error) {
      console.warn(`[Bosun plugin] ${message}`, error || '');
    }

    function setStorageStatus(message, isError) {
      storageStatus = message;
      storageStatusIsError = isError === true;
    }

    function installStorageChangeTracking() {
      if (storageChangeTrackingInstalled) return;
      if (settingsStore?.subscribe) {
        storageChangeTrackingInstalled = true;
        storageChangeListener = settingsStore.subscribe((next, _previous, changedPaths) => {
          const relevant = ACTION_TYPES.filter((type) => changedPaths.includes(`actionTemplates.${type}`));
          if (!relevant.length) return;
          for (const type of relevant) {
            const templates = next?.actionTemplates?.[type];
            if (Array.isArray(templates)) storedTemplates[type] = templates.slice();
            else delete storedTemplates[type];
            if (editorOpen && editorType === type && !storageWritePending) {
              setStorageStatus('Шаблоны изменены в другой вкладке', false);
            }
          }
          if (storageWritePending) return;
          const focusState = captureEditorFocus();
          renderVersion += 1;
          refresh();
          restoreEditorFocus(focusState);
        });
        return;
      }
      const onChanged = globalThis.chrome?.storage?.onChanged;
      if (!onChanged?.addListener) return;
      storageChangesApi = onChanged;
      storageChangeTrackingInstalled = true;
      storageChangeListener = (changes, areaName) => {
        if (areaName !== 'local' || !changes) return;
        let changed = false;
        for (const type of ACTION_TYPES) {
          const change = changes[`${storageKey}:${type}`];
          if (!change) continue;
          const templates = normalizeTemplates(change.newValue);
          if (templates) storedTemplates[type] = templates;
          else delete storedTemplates[type];
          if (editorOpen && editorType === type && !storageWritePending) {
            setStorageStatus('Шаблоны изменены в другой вкладке', false);
          }
          changed = true;
        }
        if (!changed) return;
        if (storageWritePending) return;
        const focusState = captureEditorFocus();
        renderVersion += 1;
        refresh();
        restoreEditorFocus(focusState);
      };
      onChanged.addListener(storageChangeListener);
    }

    function ensureStorageLoaded() {
      installStorageChangeTracking();
      if (storageLoadStarted) return;
      storageLoadStarted = true;
      storageLoaded = false;
      const loadGeneration = ++storageLoadGeneration;
      if (settingsStore?.start) {
        settingsStore.start().then(() => {
          if (loadGeneration !== storageLoadGeneration) return;
          const loaded = {};
          for (const type of ACTION_TYPES) {
            const templates = settingsStore.get(`actionTemplates.${type}`);
            if (Array.isArray(templates)) loaded[type] = templates.slice();
          }
          storedTemplates = loaded;
          storageLoaded = true;
          renderVersion += 1;
          refresh();
        }).catch((error) => {
          if (loadGeneration !== storageLoadGeneration) return;
          storageLoaded = true;
          warnStorage('Failed to load action templates; using defaults.', error);
          refresh();
        });
        return;
      }
      const storage = getStorage();
      if (!storage?.get) {
        if (loadGeneration === storageLoadGeneration) storageLoaded = true;
        return;
      }

      try {
        const keys = ACTION_TYPES.map((type) => `${storageKey}:${type}`);
        storage.get(keys, (result) => {
          if (loadGeneration !== storageLoadGeneration) return;
          const error = getLastError();
          if (error) {
            warnStorage('Failed to load action templates; using defaults.', error);
            setStorageStatus('Не удалось загрузить сохранённые шаблоны', true);
          } else {
            const loaded = {};
            for (const type of ACTION_TYPES) {
              const templates = normalizeTemplates(result?.[`${storageKey}:${type}`]);
              if (templates) loaded[type] = templates;
            }
            storedTemplates = loaded;
          }
          storageLoaded = true;
          renderVersion += 1;
          refresh();
        });
      } catch (error) {
        if (loadGeneration !== storageLoadGeneration) return;
        storageLoaded = true;
        warnStorage('Failed to load action templates; using defaults.', error);
      }
    }

    function persistTemplates(type, templates, successMessage, onSuccess) {
      if (settingsStore?.update && isSupportedType(type)) {
        const writeGeneration = storageLoadGeneration;
        settingsStore.update({ [`actionTemplates.${type}`]: templates }).then(() => {
          if (writeGeneration !== storageLoadGeneration) return;
          storageWritePending = false;
          onSuccess();
          setStorageStatus(successMessage, false);
          closeEditor();
        }).catch((error) => {
          if (writeGeneration !== storageLoadGeneration) return;
          storageWritePending = false;
          warnStorage('Failed to save action templates.', error);
          setStorageStatus('Не удалось сохранить шаблоны', true);
          rerenderEditor();
          focusEditorInput(0);
        });
        return;
      }
      const storage = getStorage();
      if (!storage || !isSupportedType(type)) {
        storageWritePending = false;
        setStorageStatus('Не удалось сохранить шаблоны', true);
        rerenderEditor();
        return;
      }
      const key = `${storageKey}:${type}`;
      const writeGeneration = storageLoadGeneration;
      const finishWithError = (error) => {
        if (writeGeneration !== storageLoadGeneration) return;
        storageWritePending = false;
        warnStorage('Failed to save action templates.', error);
        setStorageStatus('Не удалось сохранить шаблоны', true);
        rerenderEditor();
        focusEditorInput(0);
      };
      try {
        const callback = () => {
          if (writeGeneration !== storageLoadGeneration) return;
          const error = getLastError();
          if (error) {
            finishWithError(error);
            return;
          }
          storageWritePending = false;
          onSuccess();
          setStorageStatus(successMessage, false);
          closeEditor();
        };
        if (templates) {
          if (!storage.set) throw new Error('chrome.storage.local.set is unavailable');
          storage.set({ [key]: templates.slice() }, callback);
        } else {
          if (!storage.remove) throw new Error('chrome.storage.local.remove is unavailable');
          storage.remove([key], callback);
        }
      } catch (error) {
        finishWithError(error);
      }
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
      if (setter) setter.call(textarea, value);
      else textarea.value = value;
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

    function createButton(text, className, title, onClick, preserveTextareaFocus = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      if (title) {
        button.title = title;
        button.setAttribute('aria-label', title);
      }
      if (preserveTextareaFocus) {
        button.addEventListener('mousedown', (event) => event.preventDefault());
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return button;
    }

    function captureEditorFocus() {
      const editor = getEditorNode();
      const active = document.activeElement;
      if (!editor || !active || !editor.contains?.(active)) return null;
      const focusable = Array.from(editor.querySelectorAll('input, button'));
      const index = focusable.indexOf(active);
      if (index < 0) return null;
      return {
        index,
        selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
        selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null
      };
    }

    function restoreEditorFocus(state) {
      if (!state) return;
      const editor = getEditorNode();
      const focusable = Array.from(editor?.querySelectorAll?.('input, button') || []);
      const target = focusable[Math.max(0, Math.min(state.index, focusable.length - 1))];
      target?.focus?.();
      if (state.selectionStart !== null && typeof target?.setSelectionRange === 'function') {
        const length = String(target.value || '').length;
        target.setSelectionRange(
          Math.min(state.selectionStart, length),
          Math.min(state.selectionEnd, length)
        );
      }
    }

    function rerenderEditor(options = {}) {
      const focusState = options.preserveFocus === true ? captureEditorFocus() : null;
      renderVersion += 1;
      refresh();
      restoreEditorFocus(focusState);
    }

    function getEditorNode() {
      return document.querySelector(`.${wrapClass} .bosun-action-templates-editor`);
    }

    function focusEditorInput(index) {
      const editor = getEditorNode();
      const inputs = editor?.querySelectorAll?.('.bosun-action-template-input') || [];
      const target = inputs[Math.max(0, Math.min(index, inputs.length - 1))];
      if (target) target.focus();
      else editor?.querySelector?.('.bosun-action-template-editor-btn')?.focus?.();
    }

    function focusSettingsButton() {
      document.querySelector(`.${wrapClass} .bosun-action-templates-settings`)?.focus?.();
    }

    function setEditorBusy(isBusy) {
      const editor = getEditorNode();
      if (!editor) return;
      editor.setAttribute('aria-busy', String(isBusy));
      editor.querySelectorAll?.('.bosun-action-template-input').forEach((input) => {
        input.readOnly = isBusy;
        input.setAttribute('aria-disabled', String(isBusy));
      });
      editor.querySelectorAll?.('button').forEach((button) => {
        button.setAttribute('aria-disabled', String(isBusy));
      });
    }

    function openEditor(type) {
      if (!storageLoaded) return;
      editorOpen = true;
      editorType = type;
      draftTemplates = getTemplatesForType(type);
      rerenderEditor();
      focusEditorInput(0);
    }

    function closeEditor() {
      storageWritePending = false;
      editorOpen = false;
      editorType = '';
      draftTemplates = [];
      rerenderEditor();
      focusSettingsButton();
    }

    function saveEditor() {
      if (!isSupportedType(editorType) || storageWritePending) return;
      const type = editorType;
      const nonEmptyDrafts = draftTemplates.map((item) => String(item || '').trim()).filter(Boolean);
      const duplicateCount = nonEmptyDrafts.length - new Set(nonEmptyDrafts).size;
      const totalLength = nonEmptyDrafts.reduce((total, item) => total + item.length, 0);
      if (duplicateCount > 0 || totalLength > MAX_TOTAL_TEMPLATE_TEXT_LENGTH) {
        setStorageStatus(
          duplicateCount > 0
            ? 'Удалите одинаковые шаблоны перед сохранением'
            : `Общий текст шаблонов не должен превышать ${MAX_TOTAL_TEMPLATE_TEXT_LENGTH} символов`,
          true
        );
        rerenderEditor({ preserveFocus: true });
        return;
      }
      const templates = normalizeTemplates(draftTemplates) || [];
      storageWritePending = true;
      setEditorBusy(true);
      persistTemplates(type, templates, 'Шаблоны сохранены', () => {
        storedTemplates[type] = templates;
      });
    }

    function resetEditor() {
      if (!isSupportedType(editorType) || storageWritePending) return;
      const type = editorType;
      storageWritePending = true;
      setEditorBusy(true);
      persistTemplates(type, null, 'Шаблоны сброшены', () => {
        delete storedTemplates[type];
      });
    }

    function renderEditor(parent) {
      const editor = document.createElement('div');
      editor.className = 'bosun-action-templates-editor';
      editor.id = 'bosun-action-templates-editor';
      editor.setAttribute('role', 'group');
      editor.setAttribute('aria-label', 'Редактор частых комментариев');
      editor.setAttribute('aria-busy', String(storageWritePending));

      const hint = document.createElement('div');
      hint.className = 'bosun-action-template-limit-hint';
      hint.id = 'bosun-action-template-limit-hint';
      hint.textContent = `До ${MAX_TEMPLATES_PER_TYPE} шаблонов, до ${MAX_TEMPLATE_LENGTH} символов каждый, без дубликатов, общий объём до ${MAX_TOTAL_TEMPLATE_TEXT_LENGTH} символов`;
      editor.appendChild(hint);

      const rows = document.createElement('div');
      rows.className = 'bosun-action-template-rows';
      draftTemplates.forEach((template, index) => {
        const row = document.createElement('div');
        row.className = 'bosun-action-template-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'bosun-action-template-input';
        input.maxLength = MAX_TEMPLATE_LENGTH;
        input.value = template;
        input.readOnly = storageWritePending;
        input.setAttribute('aria-label', `Текст шаблона ${index + 1}`);
        input.setAttribute('aria-describedby', hint.id);
        input.setAttribute('aria-disabled', String(storageWritePending));
        input.addEventListener('input', () => {
          if (storageWritePending) return;
          draftTemplates[index] = input.value;
        });
        row.appendChild(input);

        const controls = document.createElement('div');
        controls.className = 'bosun-action-template-row-actions';
        const up = createButton('↑', 'bosun-action-template-icon-btn', `Переместить шаблон ${index + 1} выше`, () => {
          if (storageWritePending) return;
          if (index < 1) return;
          [draftTemplates[index - 1], draftTemplates[index]] = [draftTemplates[index], draftTemplates[index - 1]];
          rerenderEditor();
          focusEditorInput(index - 1);
        });
        up.disabled = index === 0;
        controls.appendChild(up);

        const down = createButton('↓', 'bosun-action-template-icon-btn', `Переместить шаблон ${index + 1} ниже`, () => {
          if (storageWritePending) return;
          if (index >= draftTemplates.length - 1) return;
          [draftTemplates[index], draftTemplates[index + 1]] = [draftTemplates[index + 1], draftTemplates[index]];
          rerenderEditor();
          focusEditorInput(index + 1);
        });
        down.disabled = index === draftTemplates.length - 1;
        controls.appendChild(down);
        controls.appendChild(createButton('×', 'bosun-action-template-icon-btn is-danger', `Удалить шаблон ${index + 1}`, () => {
          if (storageWritePending) return;
          draftTemplates.splice(index, 1);
          rerenderEditor();
          focusEditorInput(index);
        }));
        row.appendChild(controls);
        rows.appendChild(row);
      });
      editor.appendChild(rows);

      const actions = document.createElement('div');
      actions.className = 'bosun-action-template-editor-actions';
      const addButton = createButton('+ Добавить', 'bosun-action-template-editor-btn', '', () => {
        if (storageWritePending) return;
        if (draftTemplates.length >= MAX_TEMPLATES_PER_TYPE) return;
        draftTemplates.push('');
        rerenderEditor();
        focusEditorInput(draftTemplates.length - 1);
      });
      addButton.disabled = storageWritePending || draftTemplates.length >= MAX_TEMPLATES_PER_TYPE;
      if (draftTemplates.length >= MAX_TEMPLATES_PER_TYPE) {
        addButton.title = `Достигнут лимит: ${MAX_TEMPLATES_PER_TYPE} шаблонов`;
      }
      actions.appendChild(addButton);
      const saveButton = createButton('Сохранить', 'bosun-action-template-editor-btn is-primary', '', saveEditor);
      saveButton.disabled = storageWritePending;
      actions.appendChild(saveButton);
      const resetButton = createButton('Сбросить', 'bosun-action-template-editor-btn', 'Сбросить шаблоны этого типа', resetEditor);
      resetButton.disabled = storageWritePending;
      actions.appendChild(resetButton);
      actions.appendChild(createButton('Отмена', 'bosun-action-template-editor-btn', '', () => {
        if (!storageWritePending) closeEditor();
      }));
      editor.appendChild(actions);
      parent.appendChild(editor);
    }

    function refresh() {
      let existing = document.querySelector(`.${wrapClass}`);
      if (!isActionPage()) {
        existing?.remove();
        return;
      }

      const type = getActionType();
      if (!isSupportedType(type)) {
        existing?.remove();
        return;
      }
      ensureStorageLoaded();
      existing = document.querySelector(`.${wrapClass}`);
      if (editorOpen && editorType !== type) {
        editorOpen = false;
        editorType = '';
        draftTemplates = [];
      }

      const templates = getTemplatesForType(type);
      const textarea = findMessageTextarea();
      if (!textarea || !textarea.parentElement) return;

      let wrap = existing;
      const signature = JSON.stringify({
        type,
        templates,
        editor: editorOpen ? renderVersion : 'closed',
        storageLoaded
      });
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

      const titleRow = document.createElement('div');
      titleRow.className = 'bosun-action-templates-title-row';
      const title = document.createElement('div');
      title.className = titleClass;
      title.textContent = 'Частые комментарии';
      titleRow.appendChild(title);
      const settingsButton = createButton('⚙', 'bosun-action-templates-settings', 'Настроить частые комментарии', () => {
        if (storageWritePending) return;
        if (editorOpen) closeEditor();
        else openEditor(type);
      });
      settingsButton.disabled = !storageLoaded;
      settingsButton.setAttribute('aria-expanded', String(editorOpen));
      settingsButton.setAttribute('aria-controls', 'bosun-action-templates-editor');
      titleRow.appendChild(settingsButton);
      wrap.appendChild(titleRow);

      if (storageStatus) {
        const status = document.createElement('div');
        status.className = `bosun-action-template-status${storageStatusIsError ? ' is-error' : ''}`;
        status.setAttribute('role', storageStatusIsError ? 'alert' : 'status');
        status.textContent = storageStatus;
        wrap.appendChild(status);
      }

      if (templates.length) {
        const buttons = document.createElement('div');
        buttons.className = buttonsClass;
        templates.forEach((template) => {
          buttons.appendChild(createButton(template, buttonClass, '', () => insertTemplate(template), true));
        });
        wrap.appendChild(buttons);
      }

      if (editorOpen) renderEditor(wrap);
    }

    function destroy() {
      document.querySelector(`.${wrapClass}`)?.remove();
      if (storageChangeTrackingInstalled && storageChangeListener) {
        if (settingsStore?.subscribe) storageChangeListener();
        else storageChangesApi?.removeListener?.(storageChangeListener);
      }
      storageChangeTrackingInstalled = false;
      storageChangeListener = null;
      storageChangesApi = null;
      editorOpen = false;
      editorType = '';
      draftTemplates = [];
      storageWritePending = false;
      storageLoadGeneration += 1;
      storageLoadStarted = false;
      storageLoaded = false;
    }

    return {
      refresh,
      destroy,
      getTemplatesForType,
      normalizeTemplates
    };
  }

  globalThis.BosunHelperActionTemplates = {
    STORAGE_KEY,
    DEFAULT_TEMPLATES,
    MAX_TEMPLATES_PER_TYPE,
    MAX_TEMPLATE_LENGTH,
    MAX_TOTAL_TEMPLATE_TEXT_LENGTH,
    createActionTemplates
  };
})();
