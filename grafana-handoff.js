(() => {
  'use strict';

  const DEFAULT_STORAGE_PREFIX = 'bosunGrafanaPendingQueryV2:';
  const DEFAULT_LEGACY_STORAGE_KEY = 'bosunGrafanaPendingQueryV1';
  const DEFAULT_REQUEST_PARAM = 'bosunHelperRequest';
  const DEFAULT_TTL_MS = 2 * 60 * 1000;
  const DEFAULT_MAX_QUERY_LENGTH = 16 * 1024;

  function createGrafanaHandoff(options = {}) {
    const {
      config = {},
      getStorage = () => globalThis.chrome?.storage?.local || null,
      getLastError = () => globalThis.chrome?.runtime?.lastError || null,
      reportDiagnostics = () => {},
      showFeedback = () => {},
      storagePrefix = DEFAULT_STORAGE_PREFIX,
      legacyStorageKey = DEFAULT_LEGACY_STORAGE_KEY,
      requestParam = DEFAULT_REQUEST_PARAM,
      ttlMs = DEFAULT_TTL_MS,
      maxQueryLength = DEFAULT_MAX_QUERY_LENGTH
    } = options;

    const cleanupTimers = new Map();
    let activeDialog = null;
    let openPromise = null;
    let activeOperation = null;
    let lifecycleGeneration = 0;

    function getStorageKey(requestId) {
      return requestId ? `${storagePrefix}${requestId}` : '';
    }

    function createRequestId() {
      return globalThis.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function buildPanelUrl(requestId) {
      if (!requestId) return '';
      try {
        const expectedHost = String(config.grafanaHost || '').trim().toLowerCase();
        const url = new URL(String(config.grafanaPanelUrl || ''));
        if (
          !expectedHost ||
          url.protocol !== 'https:' ||
          url.host.toLowerCase() !== expectedHost
        ) {
          return '';
        }
        url.searchParams.set(requestParam, requestId);
        return url.toString();
      } catch (_) {
        return '';
      }
    }

    function clearCleanupTimer(requestId) {
      const timerId = cleanupTimers.get(requestId);
      if (timerId == null) return;
      clearTimeout(timerId);
      cleanupTimers.delete(requestId);
    }

    function clearPendingQuery(requestId) {
      const storageKey = getStorageKey(requestId);
      if (!storageKey) return;
      clearCleanupTimer(requestId);

      try {
        const storage = getStorage();
        if (!storage?.remove) return;
        storage.remove([storageKey], () => {
          const error = getLastError();
          if (error) {
            reportDiagnostics('grafana-query-clear-failed', error.message || 'unknown-error');
          }
        });
      } catch (error) {
        reportDiagnostics('grafana-query-clear-failed', error?.message || 'unknown-error');
      }
    }

    function schedulePendingQueryCleanup(requestId) {
      clearCleanupTimer(requestId);
      const timerId = setTimeout(() => {
        cleanupTimers.delete(requestId);
        clearPendingQuery(requestId);
      }, ttlMs + 1000);
      cleanupTimers.set(requestId, timerId);
    }

    function cleanupExpired() {
      const storage = getStorage();
      if (!storage?.get || !storage?.remove) return;

      try {
        storage.get(null, (items) => {
          if (getLastError() || !items || typeof items !== 'object') return;
          const now = Date.now();
          const expiredKeys = Object.entries(items)
            .filter(([key, value]) => {
              if (key === legacyStorageKey) return true;
              if (!key.startsWith(storagePrefix)) return false;
              const createdAt = Number(value?.createdAt || 0);
              return !Number.isFinite(createdAt) ||
                createdAt > now + 5000 ||
                now - createdAt > ttlMs;
            })
            .map(([key]) => key);
          if (expiredKeys.length) storage.remove(expiredKeys);
        });
      } catch (error) {
        reportDiagnostics('grafana-query-cleanup-failed', error?.message || 'unknown-error');
      }
    }

    function savePendingQuery(requestId, query, run = false, expectedGeneration = lifecycleGeneration) {
      const storageKey = getStorageKey(requestId);
      const payload = { query, run: run === true, createdAt: Date.now() };

      return new Promise((resolve) => {
        try {
          const storage = getStorage();
          if (storageKey && storage?.set) {
            storage.set({ [storageKey]: payload }, () => {
              const error = getLastError();
              if (!error) {
                if (expectedGeneration !== lifecycleGeneration) {
                  clearPendingQuery(requestId);
                  resolve(false);
                  return;
                }
                schedulePendingQueryCleanup(requestId);
                resolve(true);
                return;
              }

              console.warn('[Bosun Helper] Failed to save Grafana pending query:', error.message || error);
              reportDiagnostics('grafana-query-save-failed', error.message || 'unknown-error');
              resolve(false);
            });
            return;
          }
        } catch (error) {
          reportDiagnostics('grafana-query-save-failed', error?.message || 'unknown-error');
        }
        resolve(false);
      });
    }

    function chooseRunMode(query, opener) {
      if (
        typeof document?.createElement !== 'function' ||
        typeof globalThis.HTMLDialogElement !== 'function'
      ) {
        return Promise.resolve(
          typeof window.confirm === 'function'
            ? (window.confirm(`Вставить и выполнить этот запрос в Grafana?\n\n${query}`) ? true : null)
            : null
        );
      }

      if (activeDialog) {
        activeDialog.dialog.focus?.();
        return activeDialog.promise;
      }

      const dialog = document.createElement('dialog');
      dialog.className = 'bosun-grafana-preview-dialog';
      const title = document.createElement('h2');
      title.id = `bosun-grafana-preview-title-${createRequestId()}`;
      title.textContent = 'Запрос Grafana';
      dialog.setAttribute('aria-labelledby', title.id);

      const description = document.createElement('p');
      description.textContent = 'Проверьте запрос и выберите безопасный режим открытия.';
      const preview = document.createElement('pre');
      preview.className = 'bosun-grafana-preview-query';
      preview.textContent = query;
      preview.tabIndex = 0;

      const actions = document.createElement('div');
      actions.className = 'bosun-grafana-preview-actions';
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = 'Отмена';
      const insertButton = document.createElement('button');
      insertButton.type = 'button';
      insertButton.textContent = 'Вставить';
      const runButton = document.createElement('button');
      runButton.type = 'button';
      runButton.textContent = 'Вставить и выполнить';
      runButton.className = 'is-primary';
      actions.append(cancelButton, insertButton, runButton);
      dialog.append(title, description, preview, actions);

      let resolveChoice;
      const promise = new Promise((resolve) => { resolveChoice = resolve; });
      const finish = (choice) => {
        if (activeDialog?.dialog !== dialog) return;
        activeDialog = null;
        try { dialog.close(); } catch (_) {}
        dialog.remove();
        opener?.focus?.();
        resolveChoice(choice);
      };
      cancelButton.addEventListener('click', () => finish(null));
      insertButton.addEventListener('click', () => finish(false));
      runButton.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(null);
      });
      document.body.appendChild(dialog);
      activeDialog = { dialog, promise, finish };
      dialog.showModal();
      cancelButton.focus();
      return promise;
    }

    function closeOperationPopup(operation) {
      if (!operation?.popup || operation.popupClosed) return;
      operation.popupClosed = true;
      try { operation.popup.close?.(); } catch (_) {}
    }

    async function performOpenQuery(query, button, generation) {
      const normalizedQuery = typeof query === 'string' ? query.trim() : '';
      if (!normalizedQuery) {
        showFeedback(button, 'Запрос для Grafana не найден', false);
        return false;
      }
      if (
        normalizedQuery.length > maxQueryLength ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalizedQuery)
      ) {
        showFeedback(button, 'Запрос Grafana отклонён: некорректный или слишком длинный', false);
        return false;
      }

      const runMode = await chooseRunMode(normalizedQuery, button);
      if (generation !== lifecycleGeneration) return false;
      if (runMode === null) {
        showFeedback(button, 'Открытие Grafana отменено', true);
        return false;
      }

      let popup = null;
      try {
        popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
      } catch (_) {}
      if (!popup) {
        showFeedback(button, 'Разрешите всплывающие окна для открытия Grafana', false);
        return false;
      }

      const operation = { generation, popup, popupClosed: false, requestId: '' };
      activeOperation = operation;
      const requestId = createRequestId();
      operation.requestId = requestId;
      const saved = await savePendingQuery(requestId, normalizedQuery, runMode, generation);
      if (generation !== lifecycleGeneration) {
        clearPendingQuery(requestId);
        closeOperationPopup(operation);
        if (activeOperation === operation) activeOperation = null;
        return false;
      }
      if (!saved) {
        closeOperationPopup(operation);
        if (activeOperation === operation) activeOperation = null;
        showFeedback(button, 'Не удалось сохранить запрос Grafana', false);
        return false;
      }

      cleanupExpired();
      const targetUrl = buildPanelUrl(requestId);
      if (!targetUrl) {
        clearPendingQuery(requestId);
        closeOperationPopup(operation);
        if (activeOperation === operation) activeOperation = null;
        showFeedback(button, 'Ошибка конфигурации Grafana', false);
        return false;
      }

      try {
        popup.location.replace(targetUrl);
        if (activeOperation === operation) activeOperation = null;
        return true;
      } catch (error) {
        clearPendingQuery(requestId);
        closeOperationPopup(operation);
        if (activeOperation === operation) activeOperation = null;
        reportDiagnostics('grafana-window-navigation-failed', error?.message || 'unknown-error');
        showFeedback(button, 'Не удалось открыть Grafana', false);
        return false;
      }
    }

    async function openQuery(query, button) {
      if (openPromise) {
        activeDialog?.dialog?.focus?.();
        showFeedback(button, 'Окно проверки Grafana уже открыто', false);
        return false;
      }
      const currentPromise = performOpenQuery(query, button, lifecycleGeneration);
      openPromise = currentPromise;
      try {
        return await currentPromise;
      } finally {
        if (openPromise === currentPromise) openPromise = null;
      }
    }

    function destroy() {
      lifecycleGeneration += 1;
      for (const requestId of Array.from(cleanupTimers.keys())) clearPendingQuery(requestId);
      activeDialog?.finish?.(null);
      if (activeOperation?.requestId) clearPendingQuery(activeOperation.requestId);
      closeOperationPopup(activeOperation);
      activeOperation = null;
      openPromise = null;
    }

    return {
      getStorageKey,
      createRequestId,
      buildPanelUrl,
      clearPendingQuery,
      cleanupExpired,
      savePendingQuery,
      openQuery,
      destroy
    };
  }

  globalThis.BosunHelperGrafanaHandoff = {
    createGrafanaHandoff
  };
})();
