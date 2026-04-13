(() => {
  'use strict';

  function createAlertsData(options) {
    const { oldNoNoteMinutes } = options;
    const DEFAULT_REQUEST_TIMEOUT_MS = 4500;
    const DEFAULT_RETRY_DELAY_MS = 350;
    const DEFAULT_RETRY_ATTEMPTS = 2;

    function isOlderThanThreshold(agoValue) {
      if (!agoValue) return false;
      const ts = Date.parse(agoValue);
      if (!Number.isFinite(ts)) return false;
      return (Date.now() - ts) >= oldNoNoteMinutes * 60 * 1000;
    }

    function hasNoteFromActions(actions) {
      if (!Array.isArray(actions)) return false;
      return actions.some((action) => {
        return action &&
          action.Type === 'Note' &&
          typeof action.Message === 'string' &&
          action.Message.trim().length > 0 &&
          action.Cancelled !== true;
      });
    }

    function rebuildAlertDataIndex(payload, helpers) {
      const {
        buildChildMarkerKeyFromData,
        buildGroupMarkerKeyFromData
      } = helpers;

      const nextIndex = {
        childOldNoNoteById: new Map(),
        childOldNoNoteByKey: new Map(),
        childHasNoteById: new Map(),
        childHasNoteByKey: new Map(),
        groupHasOldNoNoteByKey: new Map(),
        groupHasAnyNoteByKey: new Map(),
        groupHasOldNoNoteBySubject: new Map(),
        groupHasAnyNoteBySubject: new Map()
      };

      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) return nextIndex;

      for (const group of groups) {
        let groupHasOldNoNote = false;
        let groupHasAnyNote = false;

        const children = Array.isArray(group?.Children) ? group.Children : [];
        for (const child of children) {
          const childId = child?.State?.Id != null ? String(child.State.Id) : null;
          const childKey = buildChildMarkerKeyFromData(child, group);

          const oldEnough = isOlderThanThreshold(child?.Ago);
          const hasNote = hasNoteFromActions(child?.State?.Actions);
          const oldNoNote = oldEnough && !hasNote;

          if (childId) {
            nextIndex.childOldNoNoteById.set(childId, oldNoNote);
            nextIndex.childHasNoteById.set(childId, hasNote);
          }
          if (childKey) {
            nextIndex.childOldNoNoteByKey.set(childKey, oldNoNote);
            nextIndex.childHasNoteByKey.set(childKey, hasNote);
          }

          if (oldNoNote) groupHasOldNoNote = true;
          if (hasNote) groupHasAnyNote = true;
        }

        const groupKey = buildGroupMarkerKeyFromData(group);
        if (groupKey) {
          const prevOld = nextIndex.groupHasOldNoNoteByKey.get(groupKey) === true;
          const prevNote = nextIndex.groupHasAnyNoteByKey.get(groupKey) === true;
          nextIndex.groupHasOldNoNoteByKey.set(groupKey, prevOld || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteByKey.set(groupKey, prevNote || groupHasAnyNote);
        }

        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        if (groupSubject) {
          const prevOldBySubject = nextIndex.groupHasOldNoNoteBySubject.get(groupSubject) === true;
          const prevNoteBySubject = nextIndex.groupHasAnyNoteBySubject.get(groupSubject) === true;
          nextIndex.groupHasOldNoNoteBySubject.set(groupSubject, prevOldBySubject || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteBySubject.set(groupSubject, prevNoteBySubject || groupHasAnyNote);
        }
      }

      return nextIndex;
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function createTimeoutError(source, timeoutMs) {
      return new Error(`${source} timed out after ${timeoutMs}ms`);
    }

    async function fetchAlertsDataViaFetch(options = {}) {
      const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1, Number(options.timeoutMs))
        : DEFAULT_REQUEST_TIMEOUT_MS;
      const controller = typeof AbortController === 'function'
        ? new AbortController()
        : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

      try {
        const resp = await fetch('/api/alerts?filter=', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller?.signal
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        return await resp.json();
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw createTimeoutError('fetch', timeoutMs);
        }
        throw err;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    function fetchAlertsDataViaXHR(options = {}) {
      return new Promise((resolve, reject) => {
        const timeoutMs = Number.isFinite(Number(options.timeoutMs))
          ? Math.max(1, Number(options.timeoutMs))
          : DEFAULT_REQUEST_TIMEOUT_MS;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/alerts?filter=', true);
        xhr.withCredentials = true;
        xhr.timeout = timeoutMs;
        xhr.setRequestHeader('Accept', 'application/json');

        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(`HTTP ${xhr.status}`));
            return;
          }

          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(err);
          }
        };

        xhr.onerror = function () {
          reject(new Error('XMLHttpRequest network error'));
        };

        xhr.ontimeout = function () {
          reject(createTimeoutError('XMLHttpRequest', timeoutMs));
        };

        xhr.send();
      });
    }

    async function fetchAlertsDataWithRetry(options = {}) {
      const attempts = Number.isFinite(Number(options.attempts))
        ? Math.max(1, Math.round(Number(options.attempts)))
        : DEFAULT_RETRY_ATTEMPTS;
      const retryDelayMs = Number.isFinite(Number(options.retryDelayMs))
        ? Math.max(0, Math.round(Number(options.retryDelayMs)))
        : DEFAULT_RETRY_DELAY_MS;
      const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1, Number(options.timeoutMs))
        : DEFAULT_REQUEST_TIMEOUT_MS;

      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await fetchAlertsDataViaFetch({ timeoutMs });
        } catch (fetchErr) {
          lastError = fetchErr;
          try {
            return await fetchAlertsDataViaXHR({ timeoutMs });
          } catch (xhrErr) {
            lastError = xhrErr;
          }
        }

        if (attempt < attempts && retryDelayMs > 0) {
          await delay(retryDelayMs);
        }
      }

      throw lastError || new Error('Failed to fetch alerts data');
    }

    return {
      rebuildAlertDataIndex,
      fetchAlertsDataViaFetch,
      fetchAlertsDataViaXHR,
      fetchAlertsDataWithRetry
    };
  }

  globalThis.BosunSilenceHiderAlertsData = {
    createAlertsData
  };
})();
