(() => {
  'use strict';

  const STORAGE_PREFIX = 'bosunGrafanaPendingQueryV2:';
  const REQUEST_PARAM = 'bosunHelperRequest';
  const PENDING_TTL_MS = 2 * 60 * 1000;
  const BRIDGE_MARKER_ID = 'bosun-helper-grafana-page-bridge';
  const APPLY_MESSAGE = 'BOSUN_HELPER_APPLY_GRAFANA_QUERY';
  const RESULT_MESSAGE = 'BOSUN_HELPER_GRAFANA_QUERY_RESULT';
  const APPLY_DEADLINE_MS = 20000;
  const config = globalThis.BosunHelperLocalConfig || {};

  let bridgeToken = '';

  function getStorageLastError() {
    return globalThis.chrome?.runtime?.lastError || null;
  }

  function getRequestId() {
    try {
      return new URL(window.location.href).searchParams.get(REQUEST_PARAM) || '';
    } catch (_) {
      return '';
    }
  }

  function getStorageKey(requestId) {
    return requestId ? `${STORAGE_PREFIX}${requestId}` : '';
  }

  function isConfiguredPanelPage() {
    if (window.location.hostname !== config.grafanaHost) return false;
    if (!window.location.search.includes('editPanel=')) return false;
    try {
      const configuredUrl = new URL(config.grafanaPanelUrl);
      return configuredUrl.protocol === 'https:' &&
        configuredUrl.hostname === window.location.hostname &&
        configuredUrl.pathname === window.location.pathname;
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

  function ensureBridge() {
    const existing = document.getElementById(BRIDGE_MARKER_ID);
    if (existing) {
      bridgeToken ||= existing.dataset.channelToken || '';
      return Boolean(bridgeToken);
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

  function applyViaBridge(query) {
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
          event.data?.requestId !== requestId
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
        query
      }, window.location.origin);
    });
  }

  async function applyWithDeadline(query, deadlineAt) {
    while (Date.now() < deadlineAt) {
      if (await applyViaBridge(query)) return true;
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
    const createdAt = Number(payload?.createdAt || 0);
    const now = Date.now();

    if (
      !query ||
      !Number.isFinite(createdAt) ||
      createdAt > now + 5000 ||
      now - createdAt > PENDING_TTL_MS
    ) {
      clearPendingQuery(requestId);
      return;
    }

    const applied = await applyWithDeadline(query, now + APPLY_DEADLINE_MS);
    if (applied) {
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
