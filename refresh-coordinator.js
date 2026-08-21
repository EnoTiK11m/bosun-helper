(() => {
  'use strict';

  function createRefreshCoordinator(options) {
    const {
      fetchSnapshot,
      applySnapshot,
      isVisible = () => document.visibilityState !== 'hidden',
      reportDiagnostics = () => {},
      visiblePollMs = 6000,
      hiddenPollMs = 30000,
      leaseMs = 12000,
      heartbeatMs = 3500,
      deferFollowerSnapshotsWhileHidden = true,
      shouldRun = () => true,
      storageKeyPrefix = 'bosunAlertsCoordinatorV1'
    } = options;

    const storage = globalThis.chrome?.storage?.local;
    const storageChanges = globalThis.chrome?.storage?.onChanged;
    const runtime = globalThis.chrome?.runtime;
    const origin = globalThis.location?.origin || globalThis.window?.location?.origin || 'unknown-origin';
    const leaseKey = `${storageKeyPrefix}:lease:${origin}`;
    const tokenKey = `${storageKeyPrefix}:token:${origin}`;
    const tabId = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    let started = false;
    let stopped = true;
    let channel = null;
    let term = '';
    let role = 'stopped';
    let sequence = 0;
    let lastAcceptedTerm = '';
    let lastAcceptedSequence = 0;
    let lastSnapshot = null;
    let heartbeatTimer = null;
    let pollTimer = null;
    let refreshTimer = null;
    let fetchInFlight = false;
    let refreshQueued = false;
    let visibilityListener = null;
    let pageHideListener = null;
    let fallbackMode = false;
    let lifecycleGeneration = 0;
    let channelMessageQueue = Promise.resolve();
    let rejoinTimer = null;
    let rejoinAttempts = 0;
    let currentChannelToken = '';
    let storageChangeListener = null;
    let pageShowListener = null;
    let deferredFollowerSnapshot = null;
    let activeFetchController = null;

    function abortActiveFetch() {
      try { activeFetchController?.abort?.(); } catch (_) {}
      activeFetchController = null;
    }

    async function applyDeferredFollowerSnapshot() {
      const snapshot = deferredFollowerSnapshot;
      deferredFollowerSnapshot = null;
      if (!snapshot || !isVisible()) return false;
      const fetchedAt = Number(snapshot.fetchedAt);
      if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > Math.max(hiddenPollMs * 2, 60000)) {
        return false;
      }
      const lease = await readLease();
      if (
        stopped ||
        role !== 'follower' ||
        !isVisible() ||
        !validLease(lease) ||
        lease.tabId !== snapshot.leaderTabId ||
        lease.term !== snapshot.term ||
        snapshot.term !== lastAcceptedTerm ||
        snapshot.seq !== lastAcceptedSequence
      ) return false;
      applySnapshot(snapshot.payload, {
        source: 'follower',
        reason: 'visibility-buffer',
        fetchedAt
      });
      return true;
    }

    function getLastError() {
      return runtime?.lastError || null;
    }

    function storageGet(keys) {
      return new Promise((resolve, reject) => {
        if (!storage?.get) {
          reject(new Error('chrome.storage.local.get unavailable'));
          return;
        }
        storage.get(keys, (items) => {
          const error = getLastError();
          if (error) reject(new Error(error.message || String(error)));
          else resolve(items || {});
        });
      });
    }

    function storageSet(values) {
      return new Promise((resolve, reject) => {
        if (!storage?.set) {
          reject(new Error('chrome.storage.local.set unavailable'));
          return;
        }
        storage.set(values, () => {
          const error = getLastError();
          if (error) reject(new Error(error.message || String(error)));
          else resolve();
        });
      });
    }

    function storageRemove(keys) {
      return new Promise((resolve) => {
        if (!storage?.remove) {
          resolve();
          return;
        }
        storage.remove(keys, () => resolve());
      });
    }

    function validLease(lease, now = Date.now()) {
      return lease &&
        lease.version === 1 &&
        typeof lease.tabId === 'string' &&
        typeof lease.term === 'string' &&
        Number.isFinite(Number(lease.expiresAt)) &&
        Number(lease.expiresAt) > now;
    }

    async function readLease() {
      const items = await storageGet([leaseKey]);
      return items[leaseKey] || null;
    }

    async function stillOwnsLease() {
      if (!term) return false;
      const lease = await readLease();
      return validLease(lease) && lease.tabId === tabId && lease.term === term;
    }

    function clearTimer(name) {
      const value = name === 'heartbeat' ? heartbeatTimer :
        name === 'poll' ? pollTimer : refreshTimer;
      if (value) clearTimeout(value);
      if (name === 'heartbeat') heartbeatTimer = null;
      else if (name === 'poll') pollTimer = null;
      else refreshTimer = null;
    }

    function clearRejoinTimer() {
      if (rejoinTimer) clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }

    function post(message) {
      try {
        channel?.postMessage?.({ version: 1, ...message });
        return Boolean(channel);
      } catch (error) {
        reportDiagnostics('refresh-channel-send-failed', error?.message || 'unknown-error');
        return false;
      }
    }

    function schedulePoll(delayMs) {
      clearTimer('poll');
      if (stopped || role !== 'leader') return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        performRefresh('poll');
      }, Math.max(0, delayMs));
    }

    async function performRefresh(reason, expectedGeneration = lifecycleGeneration) {
      if (stopped || role !== 'leader' || expectedGeneration !== lifecycleGeneration) return;
      if (fetchInFlight) {
        refreshQueued = true;
        return;
      }
      fetchInFlight = true;
      const refreshController = typeof AbortController === 'function'
        ? new AbortController()
        : null;
      activeFetchController = refreshController;
      try {
        if (!fallbackMode && !(await stillOwnsLease())) {
          becomeFollower('lease-lost-before-fetch');
          return;
        }
        if (stopped || role !== 'leader' || expectedGeneration !== lifecycleGeneration) return;
        const payload = await fetchSnapshot({
          signal: refreshController?.signal,
          reason,
          generation: expectedGeneration
        });
        if (stopped || role !== 'leader' || expectedGeneration !== lifecycleGeneration) return;
        if (!fallbackMode && !(await stillOwnsLease())) {
          becomeFollower('lease-lost-after-fetch');
          return;
        }
        sequence += 1;
        lastAcceptedSequence = sequence;
        lastSnapshot = {
          type: 'snapshot',
          leaderTabId: tabId,
          term,
          seq: sequence,
          fetchedAt: Date.now(),
          payload
        };
        applySnapshot(payload, { source: 'leader', reason, fetchedAt: lastSnapshot.fetchedAt });
        if (!fallbackMode && !post(lastSnapshot)) {
          enterFallback(new Error('refresh snapshot channel unavailable'));
          return;
        }
      } catch (error) {
        if (
          error?.name === 'AbortError' &&
          (refreshController?.signal?.aborted || stopped || expectedGeneration !== lifecycleGeneration || role !== 'leader')
        ) return;
        reportDiagnostics('refresh-coordinator-fetch-failed', error?.message || 'unknown-error');
      } finally {
        if (activeFetchController === refreshController) activeFetchController = null;
        if (expectedGeneration !== lifecycleGeneration) return;
        fetchInFlight = false;
        const queued = refreshQueued;
        refreshQueued = false;
        if (!stopped && role === 'leader') {
          schedulePoll(queued ? 50 : (isVisible() ? visiblePollMs : hiddenPollMs));
        }
      }
    }

    function scheduleHeartbeat() {
      clearTimer('heartbeat');
      if (stopped || fallbackMode) return;
      const expectedGeneration = lifecycleGeneration;
      heartbeatTimer = setTimeout(async () => {
        heartbeatTimer = null;
        if (stopped || expectedGeneration !== lifecycleGeneration) return;
        try {
          if (role === 'leader') {
            if (!(await stillOwnsLease())) {
              becomeFollower('lease-lost');
            } else {
              await storageSet({
                [leaseKey]: {
                  version: 1,
                  tabId,
                  term,
                  visible: Boolean(isVisible()),
                  expiresAt: Date.now() + leaseMs
                }
              });
              if (stopped || expectedGeneration !== lifecycleGeneration) return;
            }
          } else {
            const lease = await readLease();
            if (stopped || expectedGeneration !== lifecycleGeneration) return;
            if (!validLease(lease)) await tryBecomeLeader(expectedGeneration);
          }
        } catch (error) {
          if (stopped || expectedGeneration !== lifecycleGeneration) return;
          enterFallback(error);
          return;
        }
        if (expectedGeneration === lifecycleGeneration) scheduleHeartbeat();
      }, heartbeatMs);
    }

    function becomeFollower(reason) {
      if (stopped || fallbackMode) return;
      if (role === 'leader') abortActiveFetch();
      role = 'follower';
      term = '';
      clearTimer('poll');
      reportDiagnostics('refresh-role', `follower:${reason}`);
      scheduleHeartbeat();
      post({ type: 'snapshot-request', tabId });
    }

    async function tryBecomeLeader(expectedGeneration = lifecycleGeneration) {
      if (stopped || fallbackMode || expectedGeneration !== lifecycleGeneration) return false;
      const existing = await readLease();
      if (stopped || expectedGeneration !== lifecycleGeneration) return false;
      if (validLease(existing) && existing.tabId !== tabId) {
        becomeFollower('active-peer');
        return false;
      }

      const candidateTerm = globalThis.crypto?.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const candidate = {
        version: 1,
        tabId,
        term: candidateTerm,
        visible: Boolean(isVisible()),
        expiresAt: Date.now() + leaseMs
      };
      await storageSet({ [leaseKey]: candidate });
      const confirmed = await readLease();
      if (stopped || expectedGeneration !== lifecycleGeneration) return false;
      if (confirmed?.tabId !== tabId || confirmed?.term !== candidateTerm) {
        becomeFollower('election-lost');
        return false;
      }

      role = 'leader';
      deferredFollowerSnapshot = null;
      term = candidateTerm;
      sequence = 0;
      lastAcceptedTerm = candidateTerm;
      lastAcceptedSequence = 0;
      reportDiagnostics('refresh-role', 'leader');
      post({ type: 'leader', tabId, term, expiresAt: candidate.expiresAt });
      scheduleHeartbeat();
      performRefresh('leader-start', expectedGeneration);
      return true;
    }

    async function validateSnapshot(message) {
      if (!message || message.type !== 'snapshot' || message.version !== 1) return false;
      if (typeof message.term !== 'string' || !message.term) return false;
      if (!Number.isInteger(message.seq) || message.seq <= 0) return false;
      const fetchedAt = Number(message.fetchedAt);
      if (!Number.isFinite(fetchedAt) || fetchedAt > Date.now() + 5000) return false;
      if (Date.now() - fetchedAt > Math.max(hiddenPollMs * 2, 60000)) return false;
      const lease = await readLease();
      return validLease(lease) &&
        lease.tabId === message.leaderTabId &&
        lease.term === message.term;
    }

    async function handleChannelMessage(event, expectedGeneration) {
      const message = event?.data;
      if (
        !message ||
        message.version !== 1 ||
        stopped ||
        expectedGeneration !== lifecycleGeneration
      ) return;
      try {
        if (message.type === 'snapshot') {
          if (role === 'leader' || !(await validateSnapshot(message))) return;
          if (stopped || expectedGeneration !== lifecycleGeneration || role === 'leader') return;
          if (
            message.term === lastAcceptedTerm &&
            message.seq <= lastAcceptedSequence
          ) return;
          lastAcceptedTerm = message.term;
          lastAcceptedSequence = message.seq;
          if (deferFollowerSnapshotsWhileHidden && !isVisible()) {
            deferredFollowerSnapshot = message;
            return;
          }
          deferredFollowerSnapshot = null;
          applySnapshot(message.payload, {
            source: 'follower',
            fetchedAt: message.fetchedAt
          });
          return;
        }
        if (message.type === 'refresh-request' && role === 'leader') {
          requestRefresh(message.reason || 'peer');
          return;
        }
        if (message.type === 'snapshot-request' && role === 'leader' && lastSnapshot) {
          if (!post(lastSnapshot)) enterFallback(new Error('refresh snapshot channel unavailable'));
          return;
        }
        if (message.type === 'hello') {
          if (role === 'leader' && !isVisible() && message.visible) {
            await releaseLease();
            if (stopped || expectedGeneration !== lifecycleGeneration || role !== 'leader') return;
            post({ type: 'leader-yielded', tabId });
            becomeFollower('visible-peer');
          } else if (role === 'follower' && isVisible() && message.visible === false) {
            // A leader that has just become hidden announces itself. Reply so
            // it can immediately yield instead of keeping the 30s cadence.
            post({ type: 'hello', tabId, visible: true });
          }
          return;
        }
        if (message.type === 'leader-yielded' && role === 'follower' && isVisible()) {
          await tryBecomeLeader(expectedGeneration);
        }
      } catch (error) {
        reportDiagnostics('refresh-channel-message-failed', error?.message || 'unknown-error');
      }
    }

    function onChannelMessage(event) {
      const expectedGeneration = lifecycleGeneration;
      channelMessageQueue = channelMessageQueue
        .catch(() => undefined)
        .then(() => handleChannelMessage(event, expectedGeneration));
    }

    async function getOrCreateChannelToken() {
      let items = await storageGet([tokenKey]);
      let token = typeof items[tokenKey] === 'string' ? items[tokenKey] : '';
      if (!token) {
        token = globalThis.crypto?.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await storageSet({ [tokenKey]: token });
        items = await storageGet([tokenKey]);
        token = typeof items[tokenKey] === 'string' ? items[tokenKey] : '';
      }
      if (!token) throw new Error('refresh coordination token unavailable');
      return token;
    }

    function scheduleRejoin() {
      if (stopped || !fallbackMode || rejoinTimer || rejoinAttempts >= 5) return;
      const delay = Math.min(60000, 5000 * (2 ** rejoinAttempts));
      rejoinTimer = setTimeout(() => {
        rejoinTimer = null;
        attemptRejoin();
      }, delay);
    }

    async function attemptRejoin() {
      if (stopped || !fallbackMode || rejoinAttempts >= 5) return;
      const expectedGeneration = lifecycleGeneration;
      rejoinAttempts += 1;
      try {
        if (typeof globalThis.BroadcastChannel !== 'function') {
          throw new Error('BroadcastChannel unavailable');
        }
        const token = await getOrCreateChannelToken();
        if (stopped || expectedGeneration !== lifecycleGeneration || !fallbackMode) return;
        const nextChannel = new globalThis.BroadcastChannel(`bosun-helper-alerts:${token}`);
        nextChannel.addEventListener('message', onChannelMessage);
        channel = nextChannel;
        fallbackMode = false;
        role = 'starting';
        term = '';
        clearTimer('poll');
        post({ type: 'hello', tabId, visible: Boolean(isVisible()) });
        await tryBecomeLeader(expectedGeneration);
        if (stopped || expectedGeneration !== lifecycleGeneration) return;
        rejoinAttempts = 0;
        reportDiagnostics('refresh-coordinator-rejoined', 'coordination-restored');
      } catch (error) {
        try { channel?.removeEventListener?.('message', onChannelMessage); } catch (_) {}
        try { channel?.close?.(); } catch (_) {}
        channel = null;
        fallbackMode = false;
        enterFallback(error);
      }
    }

    function enterFallback(error) {
      if (stopped) return;
      if (fallbackMode) {
        scheduleRejoin();
        return;
      }
      fallbackMode = true;
      role = 'leader';
      deferredFollowerSnapshot = null;
      term = `fallback:${tabId}`;
      try { channel?.close?.(); } catch (_) {}
      channel = null;
      clearTimer('heartbeat');
      reportDiagnostics('refresh-coordinator-fallback', error?.message || 'coordination-unavailable');
      performRefresh('fallback-start');
      scheduleRejoin();
    }

    async function initialize(expectedGeneration) {
      try {
        if (typeof globalThis.BroadcastChannel !== 'function') {
          throw new Error('BroadcastChannel unavailable');
        }
        const token = await getOrCreateChannelToken();
        if (stopped || expectedGeneration !== lifecycleGeneration) return;
        currentChannelToken = token;
        channel = new globalThis.BroadcastChannel(`bosun-helper-alerts:${token}`);
        channel.addEventListener('message', onChannelMessage);
        post({ type: 'hello', tabId, visible: Boolean(isVisible()) });
        await tryBecomeLeader(expectedGeneration);
      } catch (error) {
        if (stopped || expectedGeneration !== lifecycleGeneration) return;
        enterFallback(error);
      }
    }

    function requestRefresh(reason = 'manual') {
      if (stopped) return;
      if (role === 'leader') {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          performRefresh(reason);
        }, 100);
      } else {
        post({ type: 'refresh-request', tabId, reason });
      }
    }

    async function releaseLease(ownedTerm = term) {
      if (fallbackMode || !ownedTerm) return;
      try {
        const lease = await readLease();
        if (lease?.tabId === tabId && lease?.term === ownedTerm) {
          await storageRemove([leaseKey]);
        }
      } catch (_) {}
    }

    function start() {
      if (started && !stopped) return;
      if (!shouldRun()) return;
      started = true;
      stopped = false;
      lifecycleGeneration += 1;
      const expectedGeneration = lifecycleGeneration;
      channelMessageQueue = Promise.resolve();
      lastAcceptedTerm = '';
      lastAcceptedSequence = 0;
      rejoinAttempts = 0;
      clearRejoinTimer();
      fallbackMode = false;
      role = 'starting';
      deferredFollowerSnapshot = null;

      visibilityListener = async () => {
        post({ type: 'hello', tabId, visible: Boolean(isVisible()) });
        if (isVisible()) {
          try {
            await applyDeferredFollowerSnapshot();
          } catch (error) {
            reportDiagnostics('refresh-buffer-apply-failed', error?.message || 'unknown-error');
          } finally {
            requestRefresh('visibility');
          }
        }
      };
      pageShowListener ||= (event) => {
        if (event?.persisted && stopped && shouldRun()) start();
      };
      pageHideListener = (event) => {
        const resumeFromCache = event?.persisted === true;
        stop();
        if (resumeFromCache) {
          globalThis.addEventListener?.('pageshow', pageShowListener, { once: true });
        }
      };
      storageChangeListener = (changes, areaName) => {
        if (stopped || areaName !== 'local' || !changes?.[tokenKey]) return;
        const nextToken = typeof changes[tokenKey].newValue === 'string'
          ? changes[tokenKey].newValue
          : '';
        if (!currentChannelToken || nextToken === currentChannelToken) return;
        // Token creation is intentionally race-tolerant: if another tab wins
        // the last write, restart against that shared value.
        setTimeout(() => {
          if (stopped) return;
          stop();
          start();
        }, 0);
      };
      document?.addEventListener?.('visibilitychange', visibilityListener, { passive: true });
      globalThis.addEventListener?.('pagehide', pageHideListener, { once: true });
      globalThis.addEventListener?.('pageshow', pageShowListener);
      storageChanges?.addListener?.(storageChangeListener);
      initialize(expectedGeneration);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      lifecycleGeneration += 1;
      abortActiveFetch();
      clearTimer('heartbeat');
      clearTimer('poll');
      clearTimer('refresh');
      clearRejoinTimer();
      document?.removeEventListener?.('visibilitychange', visibilityListener);
      globalThis.removeEventListener?.('pagehide', pageHideListener);
      globalThis.removeEventListener?.('pageshow', pageShowListener);
      storageChanges?.removeListener?.(storageChangeListener);
      try { channel?.removeEventListener?.('message', onChannelMessage); } catch (_) {}
      try { channel?.close?.(); } catch (_) {}
      channel = null;
      currentChannelToken = '';
      deferredFollowerSnapshot = null;
      void releaseLease(term);
      role = 'stopped';
      term = '';
      fetchInFlight = false;
      refreshQueued = false;
    }

    return {
      start,
      stop,
      requestRefresh,
      getRole: () => role,
      getTabId: () => tabId
    };
  }

  globalThis.BosunHelperRefreshCoordinator = {
    createRefreshCoordinator
  };
})();
