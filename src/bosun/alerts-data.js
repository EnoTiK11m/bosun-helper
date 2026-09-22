(() => {
  'use strict';

  function createAlertsData(options) {
    const { oldNoNoteMinutes } = options;
    const DEFAULT_REQUEST_TIMEOUT_MS = 4500;
    const DEFAULT_RETRY_DELAY_MS = 350;
    const DEFAULT_RETRY_ATTEMPTS = 3;
    // Large Bosun installations can legitimately return more than 10 MiB here.
    // Keep a generous safety bound so a malformed endpoint cannot grow memory
    // without limit, while allowing normal alert snapshots through.
    const MAX_ALERTS_RESPONSE_CHARS = 64 * 1024 * 1024;

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
      const rawType = action.Type ?? action.type ?? action.ActionType ?? action.actionType;
      const rawTypeText = String(rawType ?? '').trim().toLowerCase();
      const type = rawTypeText === '6' || /^(?:note|comment|commented\s+on)$/.test(rawTypeText)
        ? 'note'
        : rawTypeText;
      const message = action.Message ?? action.message ?? action.Text ?? action.text ?? action.Comment ?? action.comment;
      const user = typeof action.User === 'string' ? action.User : action.user;
      const cancelled = action.Cancelled === true || action.cancelled === true;

      return {
        type,
        message: typeof message === 'string' ? message.trim() : '',
        user: typeof user === 'string' ? user.trim() : '',
        cancelled
      };
    }

    function isActiveNote(action) {
      const normalized = normalizeAction(action);
      return normalized?.type === 'note' &&
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
      return actions.some((action) => (
        isActiveNote(action) ||
        (typeof action === 'string' && Boolean(parseLastActionText(action)))
      ));
    }

    function hasUserNoteFromActions(actions) {
      if (!Array.isArray(actions)) return false;
      return actions.some(isActiveUserNote);
    }

    function parseLastActionText(value) {
      if (typeof value !== 'string') return null;
      const text = value.replace(/\s+/g, ' ').trim();
      const match = text.match(/^Note\s+by\s+(\S+)\s+at\s+.+?\)\s*:\s*(.*)$/i) ||
        text.match(/^(?:Note|Commented\s+On)\s+by\s+(\S+)\b.*?:\s*(.*)$/i) ||
        text.match(/^\s*(?:Note|Commented\s+On)\b\s*:\s*(.*)$/i);
      if (!match) return null;
      return {
        Type: 'Note',
        User: match.length >= 3 ? match[1] : '',
        Message: match.length >= 3 ? match[2] : match[1]
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
        hasStrongChildMarkerIdentityFromData,
        normalizeNeedAckChildren
      } = helpers;

      const nextIndex = {
        childOldNoNoteById: new Map(),
        childOldNoNoteByKey: new Map(),
        childHasNoteById: new Map(),
        childHasNoteByKey: new Map(),
        childHasUserCommentById: new Map(),
        childHasUserCommentByKey: new Map(),
        childPriorityById: new Map(),
        childPriorityByKey: new Map(),
        ambiguousChildIds: new Set(),
        ambiguousChildKeys: new Set(),
        groupHasOldNoNoteByKey: new Map(),
        groupHasAnyNoteByKey: new Map(),
        groupHasPriorityByKey: new Map(),
        groupHasAnyUserCommentByKey: new Map(),
        groupHasOldNoNoteBySubject: new Map(),
        groupHasAnyNoteBySubject: new Map(),
        groupHasPriorityBySubject: new Map(),
        groupHasAnyUserCommentBySubject: new Map(),
        groupHasStrongIdentityBySubject: new Map(),
        groupCountBySubject: new Map()
      };

      function registerChildIdentity(key, ambiguousKeys, entries) {
        if (!key || ambiguousKeys.has(key)) return;
        if (entries.some(([map]) => map.has(key))) {
          for (const [map] of entries) map.delete(key);
          ambiguousKeys.add(key);
          return;
        }
        for (const [map, value] of entries) map.set(key, value);
      }

      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) return nextIndex;

      const priorityGroupKeyCounts = new Map();
      for (const group of groups) {
        let groupHasOldNoNote = false;
        let groupHasAnyUserComment = false;
        let groupHasStrongIdentity = false;

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
          const rawLastAction = child?.State?.LastAction ??
            child?.State?.lastAction ??
            child?.LastAction ??
            child?.lastAction;
          const lastAction = typeof rawLastAction === 'string'
            ? parseLastActionText(rawLastAction)
            : rawLastAction;
          if (lastAction) allActions.push(lastAction);
          const hasNote = hasNoteFromActions(allActions);
          const hasLastActionUserComment = hasUserComment(child);
          const oldNoNote = oldEnough && !hasNote;

          if (childId) {
            registerChildIdentity(childId, nextIndex.ambiguousChildIds, [
              [nextIndex.childOldNoNoteById, oldNoNote],
              [nextIndex.childHasNoteById, hasNote],
              [nextIndex.childHasUserCommentById, hasLastActionUserComment]
            ]);
          }
          if (childKey) {
            registerChildIdentity(childKey, nextIndex.ambiguousChildKeys, [
              [nextIndex.childOldNoNoteByKey, oldNoNote],
              [nextIndex.childHasNoteByKey, hasNote],
              [nextIndex.childHasUserCommentByKey, hasLastActionUserComment]
            ]);
          }

          if (oldNoNote) groupHasOldNoNote = true;
          if (hasLastActionUserComment) groupHasAnyUserComment = true;
          if (hasStrongChildMarkerIdentityFromData?.(child, group)) {
            groupHasStrongIdentity = true;
          }
        }

        const groupKey = buildGroupMarkerKeyFromData(group);
        if (groupKey) {
          priorityGroupKeyCounts.set(groupKey, (priorityGroupKeyCounts.get(groupKey) || 0) + 1);
          const prevOld = nextIndex.groupHasOldNoNoteByKey.get(groupKey) === true;
          const prevUserComment = nextIndex.groupHasAnyUserCommentByKey.get(groupKey) === true;
          nextIndex.groupHasOldNoNoteByKey.set(groupKey, prevOld || groupHasOldNoNote);
          nextIndex.groupHasAnyUserCommentByKey.set(groupKey, prevUserComment || groupHasAnyUserComment);
        }

        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        if (groupSubject) {
          nextIndex.groupCountBySubject.set(
            groupSubject,
            (nextIndex.groupCountBySubject.get(groupSubject) || 0) + 1
          );
          const prevOldBySubject = nextIndex.groupHasOldNoNoteBySubject.get(groupSubject) === true;
          const prevUserCommentBySubject = nextIndex.groupHasAnyUserCommentBySubject.get(groupSubject) === true;
          const prevStrongIdentityBySubject = nextIndex.groupHasStrongIdentityBySubject.get(groupSubject) === true;
          nextIndex.groupHasOldNoNoteBySubject.set(groupSubject, prevOldBySubject || groupHasOldNoNote);
          nextIndex.groupHasAnyUserCommentBySubject.set(groupSubject, prevUserCommentBySubject || groupHasAnyUserComment);
          nextIndex.groupHasStrongIdentityBySubject.set(
            groupSubject,
            prevStrongIdentityBySubject || groupHasStrongIdentity
          );
        }
      }

      function readResolvedChildState(key, identityType) {
        if (!key) return null;
        const maps = identityType === 'id'
          ? [
              nextIndex.childOldNoNoteById,
              nextIndex.childHasNoteById,
              nextIndex.childHasUserCommentById
            ]
          : [
              nextIndex.childOldNoNoteByKey,
              nextIndex.childHasNoteByKey,
              nextIndex.childHasUserCommentByKey
            ];
        if (!maps.every((map) => map.has(key))) return null;
        return maps.map((map) => map.get(key) === true);
      }

      function resolvedChildHasNote(child, group) {
        const childId = child?.State?.Id != null ? String(child.State.Id) : null;
        const childKey = buildChildMarkerKeyFromData(child, group);
        if (childId) {
          if (
            nextIndex.ambiguousChildIds.has(childId) ||
            !childKey ||
            nextIndex.ambiguousChildKeys.has(childKey)
          ) return false;
          const byId = readResolvedChildState(childId, 'id');
          const byKey = readResolvedChildState(childKey, 'key');
          if (!byId || !byKey || byId.some((value, index) => value !== byKey[index])) return false;
          return byId[1] === true;
        }

        if (!childKey || nextIndex.ambiguousChildKeys.has(childKey)) return false;
        return readResolvedChildState(childKey, 'key')?.[1] === true;
      }

      function resolvedChildIdentity(child, group) {
        const childId = child?.State?.Id != null ? String(child.State.Id) : null;
        const childKey = buildChildMarkerKeyFromData(child, group);
        if (childId) {
          if (!childKey || nextIndex.ambiguousChildIds.has(childId) ||
            nextIndex.ambiguousChildKeys.has(childKey)) return null;
          const byId = readResolvedChildState(childId, 'id');
          const byKey = readResolvedChildState(childKey, 'key');
          if (!byId || !byKey || byId.some((value, index) => value !== byKey[index])) return null;
          return { childId, childKey };
        }
        return childKey && !nextIndex.ambiguousChildKeys.has(childKey) &&
          readResolvedChildState(childKey, 'key') ? { childId: null, childKey } : null;
      }

      // Group Note markers must aggregate only child states that survived the
      // final ambiguity checks above. Raw action data must not bypass child
      // identity resolution merely because the group row is collapsed.
      nextIndex.groupHasAnyNoteByKey.clear();
      nextIndex.groupHasAnyNoteBySubject.clear();
      for (const group of groups) {
        const children = typeof normalizeNeedAckChildren === 'function'
          ? normalizeNeedAckChildren(group?.Children)
          : (Array.isArray(group?.Children) ? group.Children : []);
        const hasResolvedNote = children.some((child) => resolvedChildHasNote(child, group));
        let hasResolvedPriority = false;
        for (const child of children) {
          const identity = resolvedChildIdentity(child, group);
          if (!identity) continue;
          const priority = helpers.classifyPriorityChild?.(child, group) === true;
          if (identity.childId) nextIndex.childPriorityById.set(identity.childId, priority);
          nextIndex.childPriorityByKey.set(identity.childKey, priority);
          if (priority) hasResolvedPriority = true;
        }
        const groupKey = buildGroupMarkerKeyFromData(group);
        if (groupKey) {
          nextIndex.groupHasAnyNoteByKey.set(
            groupKey,
            nextIndex.groupHasAnyNoteByKey.get(groupKey) === true || hasResolvedNote
          );
          nextIndex.groupHasPriorityByKey.set(
            groupKey,
            nextIndex.groupHasPriorityByKey.get(groupKey) === true || hasResolvedPriority
          );
        }
        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        if (groupSubject) {
          nextIndex.groupHasAnyNoteBySubject.set(
            groupSubject,
            nextIndex.groupHasAnyNoteBySubject.get(groupSubject) === true || hasResolvedNote
          );
          nextIndex.groupHasPriorityBySubject.set(
            groupSubject,
            nextIndex.groupHasPriorityBySubject.get(groupSubject) === true || hasResolvedPriority
          );
        }
      }

      // Duplicate group keys cannot identify a single collapsed row.
      for (const [key, count] of priorityGroupKeyCounts) {
        if (count > 1) nextIndex.groupHasPriorityByKey.delete(key);
      }

      return nextIndex;
    }

    function createAbortError() {
      const error = new Error('Alerts request aborted');
      error.name = 'AbortError';
      return error;
    }

    function throwIfAborted(signal) {
      if (signal?.aborted) throw createAbortError();
    }

    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        throwIfAborted(signal);
        let timer = null;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          reject(createAbortError());
        };
        timer = setTimeout(() => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        }, ms);
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }

    function ensureResponseSizeAllowed(length) {
      if (Number(length) > MAX_ALERTS_RESPONSE_CHARS) {
        throw createResponseTooLargeError();
      }
    }

    function createResponseTooLargeError() {
      const error = new Error('Alerts response is too large');
      error.code = 'ERESPONSETOOLARGE';
      return error;
    }

    async function readBoundedResponseText(response) {
      const reader = response.body?.getReader?.();
      if (!reader || typeof TextDecoder !== 'function') {
        const text = await response.text();
        ensureResponseSizeAllowed(text.length);
        return text;
      }
      const decoder = new TextDecoder();
      const chunks = [];
      let receivedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += Number(value?.byteLength || 0);
        if (receivedBytes > MAX_ALERTS_RESPONSE_CHARS) {
          try { await reader.cancel(); } catch (_) {}
          throw createResponseTooLargeError();
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      const text = chunks.join('');
      ensureResponseSizeAllowed(text.length);
      return text;
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
      const externalSignal = options.signal;
      throwIfAborted(externalSignal);
      let timedOut = false;
      const onExternalAbort = () => controller?.abort();
      externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
      const timeoutId = controller
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;

      try {
        const resp = await fetch('/api/alerts?filter=', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller?.signal || externalSignal
        });

        if (!resp.ok) {
          throw createHttpError(resp.status);
        }

        ensureResponseSizeAllowed(resp.headers?.get?.('content-length'));
        if (typeof resp.text !== 'function') return await resp.json();
        const text = await readBoundedResponseText(resp);
        return JSON.parse(text);
      } catch (err) {
        if (err?.name === 'AbortError') {
          if (externalSignal?.aborted && !timedOut) throw createAbortError();
          throw createTimeoutError('fetch', timeoutMs);
        }
        throw err;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
      }
    }

    function fetchAlertsDataViaXHR(options = {}) {
      return new Promise((resolve, reject) => {
        const timeoutMs = Number.isFinite(Number(options.timeoutMs))
          ? Math.max(1, Number(options.timeoutMs))
          : DEFAULT_REQUEST_TIMEOUT_MS;
        const xhr = new XMLHttpRequest();
        const externalSignal = options.signal;
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          externalSignal?.removeEventListener?.('abort', onExternalAbort);
          callback(value);
        };
        const onExternalAbort = () => {
          try { xhr.abort(); } catch (_) {}
          finish(reject, createAbortError());
        };
        try {
          throwIfAborted(externalSignal);
        } catch (error) {
          reject(error);
          return;
        }
        externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) {
            finish(reject, createHttpError(xhr.status));
            return;
          }

          try {
            ensureResponseSizeAllowed(xhr.responseText.length);
            finish(resolve, JSON.parse(xhr.responseText));
          } catch (err) {
            finish(reject, err);
          }
        };

        xhr.onerror = function () {
          finish(reject, new Error('XMLHttpRequest network error'));
        };

        xhr.ontimeout = function () {
          finish(reject, createTimeoutError('XMLHttpRequest', timeoutMs));
        };

        xhr.onprogress = function (event) {
          if (Number(event?.loaded || 0) <= MAX_ALERTS_RESPONSE_CHARS) return;
          finish(reject, createResponseTooLargeError());
          try { xhr.abort(); } catch (_) {}
        };

        xhr.onabort = function () {
          finish(reject, createAbortError());
        };

        try {
          xhr.open('GET', '/api/alerts?filter=', true);
          xhr.withCredentials = true;
          xhr.timeout = timeoutMs;
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.send();
        } catch (error) {
          finish(reject, error);
        }
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
        throwIfAborted(options.signal);
        try {
          if (typeof fetch === 'function') {
            return await fetchAlertsDataViaFetch({ timeoutMs, signal: options.signal });
          }
          return await fetchAlertsDataViaXHR({ timeoutMs, signal: options.signal });
        } catch (requestError) {
          lastError = requestError;
          if (!isRetryableError(requestError)) throw requestError;
        }

        if (attempt < attempts && retryDelayMs > 0) {
          const exponentialDelay = retryDelayMs * (2 ** (attempt - 1));
          const jitter = Math.round(exponentialDelay * Math.random() * 0.25);
          await delay(exponentialDelay + jitter, options.signal);
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
