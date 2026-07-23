(() => {
  'use strict';

  function createAlertsData(options) {
    const { oldNoNoteMinutes } = options;
    const DEFAULT_REQUEST_TIMEOUT_MS = 4500;
    const DEFAULT_RETRY_DELAY_MS = 350;
    const DEFAULT_RETRY_ATTEMPTS = 3;

    function isOlderThanThreshold(agoValue) {
      if (!agoValue) return false;
      const ts = Date.parse(agoValue);
      if (!Number.isFinite(ts)) return false;
      return (Date.now() - ts) >= oldNoNoteMinutes * 60 * 1000;
    }

    function isServiceUser(user) {
      if (typeof user !== 'string') return false;
      const normalized = user.trim().toLowerCase();
      return normalized === 'system' ||
        normalized === 'bosun' ||
        normalized === 'scheduler' ||
        normalized === 'service' ||
        normalized === 'auto' ||
        normalized === 'automation';
    }

    function normalizeAction(action) {
      if (!action || typeof action !== 'object') return null;
      const type = typeof action.Type === 'string' ? action.Type : action.type;
      const message = typeof action.Message === 'string' ? action.Message : action.message;
      const user = typeof action.User === 'string' ? action.User : action.user;
      const cancelled = action.Cancelled === true || action.cancelled === true;

      return {
        type: String(type || '').trim().toLowerCase(),
        message: typeof message === 'string' ? message.trim() : '',
        user: typeof user === 'string' ? user.trim() : '',
        cancelled
      };
    }

    function isActiveNote(action) {
      const normalized = normalizeAction(action);
      return normalized?.type === 'note' &&
        Boolean(normalized.message) &&
        !normalized.cancelled;
    }

    function isActiveUserNote(action) {
      const normalized = normalizeAction(action);
      return normalized?.type === 'note' &&
        Boolean(normalized.message) &&
        Boolean(normalized.user) &&
        !normalized.cancelled &&
        !isServiceUser(normalized.user);
    }

    function hasNoteFromActions(actions) {
      if (!Array.isArray(actions)) return false;
      return actions.some(isActiveNote);
    }

    function hasUserNoteFromActions(actions) {
      if (!Array.isArray(actions)) return false;
      return actions.some(isActiveUserNote);
    }

    function parseLastActionText(value) {
      if (typeof value !== 'string') return null;
      const text = value.replace(/\s+/g, ' ').trim();
      const match = text.match(/\bNote\s+by\s+(\S+)\s+at\s+.+?\)\s*:\s*(.+)$/i) ||
        text.match(/\bNote\s+by\s+(\S+)\b.*?:\s*(.+)$/i);
      if (!match) return null;
      return {
        Type: 'Note',
        User: match[1],
        Message: match[2]
      };
    }

    function hasUserComment(alert) {
      const state = alert?.State || alert?.state || {};
      const actions = [
        ...(Array.isArray(state.Actions) ? state.Actions : []),
        ...(Array.isArray(state.actions) ? state.actions : []),
        ...(Array.isArray(alert?.Actions) ? alert.Actions : []),
        ...(Array.isArray(alert?.actions) ? alert.actions : [])
      ];
      if (hasUserNoteFromActions(actions)) return true;

      const rawAction = state.LastAction || state.lastAction || alert?.LastAction || alert?.lastAction;
      const action = typeof rawAction === 'string' ? parseLastActionText(rawAction) : rawAction;
      return isActiveUserNote(action);
    }

    function rebuildAlertDataIndex(payload, helpers) {
      const {
        buildChildMarkerKeyFromData,
        buildGroupMarkerKeyFromData,
        normalizeNeedAckChildren
      } = helpers;

      const nextIndex = {
        childOldNoNoteById: new Map(),
        childOldNoNoteByKey: new Map(),
        childHasNoteById: new Map(),
        childHasNoteByKey: new Map(),
        childHasUserCommentById: new Map(),
        childHasUserCommentByKey: new Map(),
        groupHasOldNoNoteByKey: new Map(),
        groupHasAnyNoteByKey: new Map(),
        groupHasAnyUserCommentByKey: new Map(),
        groupHasOldNoNoteBySubject: new Map(),
        groupHasAnyNoteBySubject: new Map(),
        groupHasAnyUserCommentBySubject: new Map(),
        groupCountBySubject: new Map()
      };

      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) return nextIndex;

      for (const group of groups) {
        let groupHasOldNoNote = false;
        let groupHasAnyNote = false;
        let groupHasAnyUserComment = false;

        const children = typeof normalizeNeedAckChildren === 'function'
          ? normalizeNeedAckChildren(group?.Children)
          : (Array.isArray(group?.Children) ? group.Children : []);
        for (const child of children) {
          const childId = child?.State?.Id != null ? String(child.State.Id) : null;
          const childKey = buildChildMarkerKeyFromData(child, group);

          const oldEnough = isOlderThanThreshold(child?.Ago);
          const allActions = [
            ...(Array.isArray(child?.State?.Actions) ? child.State.Actions : []),
            ...(Array.isArray(child?.State?.actions) ? child.State.actions : []),
            ...(Array.isArray(child?.Actions) ? child.Actions : []),
            ...(Array.isArray(child?.actions) ? child.actions : [])
          ];
          const hasNote = hasNoteFromActions(allActions);
          const hasLastActionUserComment = hasUserComment(child);
          const oldNoNote = oldEnough && !hasNote;

          if (childId) {
            nextIndex.childOldNoNoteById.set(childId, oldNoNote);
            nextIndex.childHasNoteById.set(childId, hasNote);
            nextIndex.childHasUserCommentById.set(childId, hasLastActionUserComment);
          }
          if (childKey) {
            nextIndex.childOldNoNoteByKey.set(childKey, oldNoNote);
            nextIndex.childHasNoteByKey.set(childKey, hasNote);
            nextIndex.childHasUserCommentByKey.set(childKey, hasLastActionUserComment);
          }

          if (oldNoNote) groupHasOldNoNote = true;
          if (hasNote) groupHasAnyNote = true;
          if (hasLastActionUserComment) groupHasAnyUserComment = true;
        }

        const groupKey = buildGroupMarkerKeyFromData(group);
        if (groupKey) {
          const prevOld = nextIndex.groupHasOldNoNoteByKey.get(groupKey) === true;
          const prevNote = nextIndex.groupHasAnyNoteByKey.get(groupKey) === true;
          const prevUserComment = nextIndex.groupHasAnyUserCommentByKey.get(groupKey) === true;
          nextIndex.groupHasOldNoNoteByKey.set(groupKey, prevOld || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteByKey.set(groupKey, prevNote || groupHasAnyNote);
          nextIndex.groupHasAnyUserCommentByKey.set(groupKey, prevUserComment || groupHasAnyUserComment);
        }

        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        if (groupSubject) {
          nextIndex.groupCountBySubject.set(
            groupSubject,
            (nextIndex.groupCountBySubject.get(groupSubject) || 0) + 1
          );
          const prevOldBySubject = nextIndex.groupHasOldNoNoteBySubject.get(groupSubject) === true;
          const prevNoteBySubject = nextIndex.groupHasAnyNoteBySubject.get(groupSubject) === true;
          const prevUserCommentBySubject = nextIndex.groupHasAnyUserCommentBySubject.get(groupSubject) === true;
          nextIndex.groupHasOldNoNoteBySubject.set(groupSubject, prevOldBySubject || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteBySubject.set(groupSubject, prevNoteBySubject || groupHasAnyNote);
          nextIndex.groupHasAnyUserCommentBySubject.set(groupSubject, prevUserCommentBySubject || groupHasAnyUserComment);
        }
      }

      return nextIndex;
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function createTimeoutError(source, timeoutMs) {
      const error = new Error(`${source} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      return error;
    }

    function createHttpError(status) {
      const error = new Error(`HTTP ${status}`);
      error.status = Number(status);
      return error;
    }

    function isRetryableError(error) {
      const status = Number(error?.status || 0);
      if (status) return status === 408 || status === 429 || status >= 500;
      return error?.code === 'ETIMEDOUT' ||
        error?.name === 'TypeError' ||
        /network|failed to fetch|load failed/i.test(String(error?.message || ''));
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
          throw createHttpError(resp.status);
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
            reject(createHttpError(xhr.status));
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
          if (typeof fetch === 'function') {
            return await fetchAlertsDataViaFetch({ timeoutMs });
          }
          return await fetchAlertsDataViaXHR({ timeoutMs });
        } catch (requestError) {
          lastError = requestError;
          if (!isRetryableError(requestError)) throw requestError;
        }

        if (attempt < attempts && retryDelayMs > 0) {
          const exponentialDelay = retryDelayMs * (2 ** (attempt - 1));
          const jitter = Math.round(exponentialDelay * Math.random() * 0.25);
          await delay(exponentialDelay + jitter);
        }
      }

      throw lastError || new Error('Failed to fetch alerts data');
    }

    return {
      hasNoteFromActions,
      hasUserNoteFromActions,
      hasUserComment,
      rebuildAlertDataIndex,
      fetchAlertsDataViaFetch,
      fetchAlertsDataViaXHR,
      isRetryableError,
      fetchAlertsDataWithRetry
    };
  }

  globalThis.BosunSilenceHiderAlertsData = {
    createAlertsData
  };
})();
