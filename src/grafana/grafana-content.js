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
  const CONSUMED_PREFIX = 'bosunGrafanaConsumedRequestV2:';
  const MAX_CONSUMED_MARKERS = 50;
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

  function getConsumedKey(requestId) {
    return requestId ? `${CONSUMED_PREFIX}${requestId}` : '';
  }

  function parseConsumedMarker(raw, now) {
    if (!raw || raw.length > 256) return null;
    try {
      const marker = JSON.parse(raw);
      const consumedAt = Number(marker?.consumedAt);
      const expiresAt = Number(marker?.expiresAt);
      if (
        !Number.isFinite(consumedAt) ||
        !Number.isFinite(expiresAt) ||
        consumedAt > now + 5000 ||
        expiresAt <= now ||
        expiresAt - consumedAt > PENDING_TTL_MS + 5000
      ) return null;
      return { consumedAt, expiresAt };
    } catch (_) {
      return null;
    }
  }

  function pruneConsumedMarkers(now = Date.now()) {
    const storage = window.sessionStorage;
    if (!storage || !Number.isFinite(storage.length) || typeof storage.key !== 'function') return;
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === 'string' && key.startsWith(CONSUMED_PREFIX)) keys.push(key);
      }
      const valid = [];
      for (const key of keys) {
        const marker = parseConsumedMarker(storage.getItem(key), now);
        if (!marker) storage.removeItem(key);
        else valid.push({ key, consumedAt: marker.consumedAt });
      }
      valid.sort((left, right) => left.consumedAt - right.consumedAt);
      for (const entry of valid.slice(0, Math.max(0, valid.length - MAX_CONSUMED_MARKERS))) {
        storage.removeItem(entry.key);
      }
    } catch (_) {}
  }

  function isRequestConsumed(requestId, now = Date.now()) {
    const key = getConsumedKey(requestId);
    if (!key) return false;
    try {
      const raw = window.sessionStorage?.getItem(key);
      if (!parseConsumedMarker(raw, now)) {
        window.sessionStorage?.removeItem(key);
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function markRequestConsumed(requestId, expiresAt, now = Date.now()) {
    const key = getConsumedKey(requestId);
    if (
      !key ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + PENDING_TTL_MS + 5000
    ) return false;
    try {
      pruneConsumedMarkers(now);
      window.sessionStorage?.setItem(key, JSON.stringify({
        consumedAt: now,
        expiresAt
      }));
      pruneConsumedMarkers(now);
      return isRequestConsumed(requestId, now);
    } catch (_) {
      return false;
    }
  }

  function removeRequestParamFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(REQUEST_PARAM)) return true;
      url.searchParams.delete(REQUEST_PARAM);
      window.history?.replaceState?.(window.history.state, '', url.toString());
      return true;
    } catch (_) {
      return false;
    }
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

  function captureTargetIdentity() {
    try {
      const url = new URL(window.location.href);
      // Freeze the panel and organization, not mutable time range or UI parameters.
      return Object.freeze({ origin: url.origin, pathname: url.pathname,
        editPanel: url.searchParams.get('editPanel'), orgId: url.searchParams.get('orgId') });
    } catch (_) { return null; }
  }

  function matchesTarget(target) {
    const current = captureTargetIdentity();
    return Boolean(target && current && Object.keys(target).every((key) => target[key] === current[key]));
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

  function isVisibleConnectedNode(node) {
    if (!node || node.isConnected === false) return false;
    let current = node;
    while (current) {
      if (current.hidden === true || current.getAttribute?.('aria-hidden') === 'true') return false;
      try {
        const style = window.getComputedStyle?.(current);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      } catch (_) {}
      current = current.parentElement || null;
    }
    try {
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) {
        return false;
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  function isQueryVisible(query) {
    const expected = normalizeText(query);
    if (!expected) return false;

    const selectors = [
      '.cm-editor .cm-content[contenteditable="true"]',
      '.monaco-editor .view-lines',
      'textarea.inputarea.monaco-mouse-cursor-text[role="textbox"]'
    ];
    const valuesByRoot = new Map();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!isVisibleConnectedNode(node)) continue;
        const root = node.closest?.('.cm-editor, .monaco-editor') || node;
        if (!isVisibleConnectedNode(root)) continue;
        const text = 'value' in node
          ? node.value
          : node.innerText || node.textContent || '';
        const values = valuesByRoot.get(root) || [];
        values.push(normalizeText(text));
        valuesByRoot.set(root, values);
      }
    }
    if (valuesByRoot.size !== 1) return false;
    return Array.from(valuesByRoot.values())[0].some((text) => text === expected);
  }

  async function waitForVisibleQuery(query, deadlineAt, target) {
    while (Date.now() < deadlineAt) {
      if (!matchesTarget(target)) return false;
      if (isQueryVisible(query)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return matchesTarget(target) && isQueryVisible(query);
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
    script.src = chrome.runtime.getURL('src/grafana/grafana-page.js');
    script.addEventListener('error', () => {
      console.warn('[Bosun Helper] Failed to load the Grafana page bridge.');
      script.remove();
    }, { once: true });
    (document.documentElement || document.head || document.body).appendChild(script);
    return true;
  }

  function applyViaBridge(query, run, operationId, deadlineAt, target) {
    return new Promise((resolve) => {
      if (!matchesTarget(target)) { resolve('target_changed'); return; }
      if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt || !ensureBridge()) {
        resolve(false);
        return;
      }

      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(false);
      }, Math.max(0, Math.min(2500, deadlineAt - Date.now())));

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
        resolve(!matchesTarget(target) || event.data.result?.reason === 'target_changed'
          ? 'target_changed' : event.data.result?.ok === true);
      }

      window.addEventListener('message', onMessage);
      if (!matchesTarget(target)) {
        clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve('target_changed');
        return;
      }
      window.postMessage({
        type: APPLY_MESSAGE,
        channelToken: bridgeToken,
        requestId,
        operationId,
        query,
        run,
        deadlineAt,
        targetIdentity: target
      }, window.location.origin);
    });
  }

  async function applyWithDeadline(query, run, deadlineAt, operationId, target) {
    while (Date.now() < deadlineAt) {
      if (!matchesTarget(target)) return 'target_changed';
      const pageReportedSuccess = await applyViaBridge(query, run, operationId, deadlineAt, target);
      if (!matchesTarget(target) || pageReportedSuccess === 'target_changed') return 'target_changed';
      // Same-page scripts can observe and forge postMessage traffic, including
      // the channel token. Treat the page-world result as advisory and verify
      // the rendered editor value independently before deleting storage.
      if (
        pageReportedSuccess === true &&
        await waitForVisibleQuery(query, Math.min(deadlineAt, Date.now() + 2000), target) &&
        matchesTarget(target)
      ) return true;
      if (!matchesTarget(target)) return 'target_changed';
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async function init() {
    if (!isConfiguredPanelPage()) return;
    const target = captureTargetIdentity();
    if (!target) return;

    const requestId = getRequestId();
    if (!requestId) return;
    if (isRequestConsumed(requestId)) {
      removeRequestParamFromUrl();
      clearPendingQuery(requestId);
      return;
    }
    const payload = await loadPendingQuery(requestId);
    if (!matchesTarget(target)) {
      clearPendingQuery(requestId);
      console.warn('[Bosun Helper] Grafana handoff cancelled: target_changed.');
      return;
    }
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
    const hardDeadlineAt = Math.min(
      createdAt + PENDING_TTL_MS,
      now + APPLY_DEADLINE_MS
    );
    const applied = await applyWithDeadline(
      query,
      run,
      hardDeadlineAt,
      operationId,
      target
    );
    if (applied === true && matchesTarget(target)) {
      clearTimeout(expiryTimer);
      if (!markRequestConsumed(requestId, createdAt + PENDING_TTL_MS)) {
        console.warn('[Bosun Helper] Failed to mark the Grafana request as consumed.');
      }
      removeRequestParamFromUrl();
      clearPendingQuery(requestId);
    } else if (applied === 'target_changed' || !matchesTarget(target)) {
      clearTimeout(expiryTimer);
      clearPendingQuery(requestId);
      console.warn('[Bosun Helper] Grafana handoff cancelled: target_changed.');
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
