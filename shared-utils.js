(() => {
  'use strict';

  function uniqueNodes(nodes) {
    const seen = new Set();
    const result = [];

    for (const node of nodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }

    return result;
  }

  function normalizeAutoRefreshIdleSeconds(value, bounds) {
    const { min, max, fallback } = bounds;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numericValue)));
  }

  function formatDiagnosticsTimestamp(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function normalizeNeedAckChildren(raw) {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    return [raw];
  }

  globalThis.BosunSilenceHiderSharedUtils = {
    uniqueNodes,
    normalizeAutoRefreshIdleSeconds,
    formatDiagnosticsTimestamp,
    normalizeNeedAckChildren
  };
})();
