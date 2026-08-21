(() => {
  'use strict';

  const STORAGE_PREFIX = 'bosunGrafanaPendingQueryV2:';
  const REQUEST_PARAM = 'bosunHelperRequest';
  const PENDING_TTL_MS = 2 * 60 * 1000;
  const BRIDGE_MARKER_ID = 'bosun-helper-grafana-page-bridge';
  const APPLY_MESSAGE = 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  const RESULT_MESSAGE = 'BOSUN_HELPER_GRAFANA_QUERY_RESULT';
  const APPLY_DEADLINE_MS = 20000;
  const MAX_REQUEST_ID_LENGTH = 128;
  const MAX_QUERY_LENGTH = 16 * 1024;
  const config = globalThis.BosunHelperLocalConfig || {};

  let bridgeToken = '';

  function getStorageLastError() {
    return globalThis.chrome?.runtime?.lastError || null;
  }

  function getRequestId() {
    try {
      const requestId = new URL(window.location.href).searchParams.get(REQUEST_PARAM) || '';
      return requestId.length <= MAX_REQUEST_ID_LENGTH && /^[a-zA-Z0-9-]+$/.test(requestId)
        ? requestId
        : '';
    } catch (_) {
      return '';
    }
  }

  function getStorageKey(requestId) {
    return requestId ? `${STORAGE_PREFIX}${requestId}` : '';
  }

  function isConfiguredPanelPage() {
    if (window.location.host.toLowerCase() !== String(config.grafanaHost || '').toLowerCase()) return false;
    try {
      const configuredUrl = new URL(config.grafanaPanelUrl);
      const currentUrl = new URL(window.location.href);
      const configuredPanel = configuredUrl.searchParams.get('editPanel');
      const currentPanel = currentUrl.searchParams.get('editPanel');
      const configuredOrg = configuredUrl.searchParams.get('orgId');
      return configuredUrl.protocol === 'https:' &&
        configuredUrl.host.toLowerCase() === window.location.host.toLowerCase() &&
        configuredUrl.pathname === window.location.pathname &&
        Boolean(configuredPanel) &&
        currentPanel === configuredPanel &&
        (configuredOrg === null || currentUrl.searchParams.get('orgId') === configuredOrg);
    } catch (_) {
      return false;
    }
  }

  function loadPendingQuery(requestId) {
    return new Promise((resolve) => {
      const storageKey = getStorageKey(requestId);
      if (!storageKey || !chrome?.storage?.local?.get) {
        resolve(null);
        return;
      }

      chrome.storage.local.get([storageKey], (items) => {
        const error = getStorageLastError();
        if (error) {
          console.warn('[Bosun Helper] Failed to load Grafana query:', error.message || error);
          resolve(null);
          return;
        }
        resolve(items?.[storageKey] || null);
      });
    });
  }

  function clearPendingQuery(requestId) {
    const storageKey = getStorageKey(requestId);
    if (!storageKey || !chrome?.storage?.local?.remove) return;
    chrome.storage.local.remove([storageKey], () => {
      const error = getStorageLastError();
      if (error) {
        console.warn('[Bosun Helper] Failed to clear Grafana query:', error.message || error);
      }
    });
  }

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim();
  }

  function isQueryVisible(query) {
    const expected = normalizeText(query);
    if (!expected) return false;

    const selectors = [
      '.cm-editor .cm-content[contenteditable="true"]',
      '.monaco-editor .view-lines',
      'textarea.inputarea.monaco-mouse-cursor-text[role="textbox"]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = 'value' in node
          ? node.value
          : node.innerText || node.textContent || '';
        if (normalizeText(text) === expected) return true;
      }
    }
    return false;
  }

  async function waitForVisibleQuery(query, deadlineAt) {
    while (Date.now() < deadlineAt) {
      if (isQueryVisible(query)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return isQueryVisible(query);
  }

  function ensureBridge() {
    const existing = document.getElementById(BRIDGE_MARKER_ID);
    if (existing) {
      // A marker that predates this isolated-world instance is not ours. Do not
      // adopt its page-visible token; replace it with a fresh bridge instance.
      if (bridgeToken) return true;
      existing.remove();
    }

    bridgeToken = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const script = document.createElement('script');
    script.id = BRIDGE_MARKER_ID;
    script.dataset.channelToken = bridgeToken;
    script.src = chrome.runtime.getURL('grafana-page.js');
    script.addEventListener('error', () => {
      console.warn('[Bosun Helper] Failed to load the Grafana page bridge.');
      script.remove();
    }, { once: true });
    (document.documentElement || document.head || document.body).appendChild(script);
    return true;
  }

  function applyViaBridge(query, run, operationId) {
    return new Promise((resolve) => {
      if (!ensureBridge()) {
        resolve(false);
        return;
      }

      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(false);
      }, 2500);

      function onMessage(event) {
        if (
          event.source !== window ||
          event.origin !== window.location.origin ||
          event.data?.type !== RESULT_MESSAGE ||
          event.data?.channelToken !== bridgeToken ||
          event.data?.requestId !== requestId ||
          event.data?.operationId !== operationId
        ) {
          return;
        }

        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve(event.data.result?.ok === true);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({
        type: APPLY_MESSAGE,
        channelToken: bridgeToken,
        requestId,
        operationId,
        query,
        run
      }, window.location.origin);
    });
  }

  async function applyWithDeadline(query, run, deadlineAt, operationId) {
    while (Date.now() < deadlineAt) {
      const pageReportedSuccess = await applyViaBridge(query, run, operationId);
      // Same-page scripts can observe and forge postMessage traffic, including
      // the channel token. Treat the page-world result as advisory and verify
      // the rendered editor value independently before deleting storage.
      if (
        pageReportedSuccess &&
        await waitForVisibleQuery(query, Math.min(deadlineAt, Date.now() + 2000))
      ) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async function init() {
    if (!isConfiguredPanelPage()) return;

    const requestId = getRequestId();
    if (!requestId) return;
    const payload = await loadPendingQuery(requestId);
    const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
    const run = payload?.run === true;
    const createdAt = Number(payload?.createdAt || 0);
    const now = Date.now();

    if (
      !query ||
      query.length > MAX_QUERY_LENGTH ||
      !Number.isFinite(createdAt) ||
      createdAt > now + 5000 ||
      now - createdAt > PENDING_TTL_MS
    ) {
      clearPendingQuery(requestId);
      return;
    }

    const expiresIn = Math.max(0, createdAt + PENDING_TTL_MS - now);
    const expiryTimer = setTimeout(() => clearPendingQuery(requestId), expiresIn);
    const operationId = globalThis.crypto?.randomUUID?.() ||
      `${now}-${Math.random().toString(16).slice(2)}`;
    const applied = await applyWithDeadline(
      query,
      run,
      now + APPLY_DEADLINE_MS,
      operationId
    );
    if (applied) {
      clearTimeout(expiryTimer);
      clearPendingQuery(requestId);
    } else {
      console.warn('[Bosun Helper] Grafana query editor was not ready before timeout.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
