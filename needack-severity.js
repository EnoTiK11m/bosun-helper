(() => {
  'use strict';

  function createNeedAckSeverity(options) {
    const { normalizeNeedAckChildren } = options;

    function parseNeedAckStatusToBucket(raw) {
      const s = String(raw ?? '').toLowerCase().trim();
      if (s === 'critical') return 'critical';
      if (s === 'warning') return 'warning';
      if (s === 'unknown') return 'unknown';
      if (s === 'normal' || s === 'none' || !s) return 'unknown';
      if (s.includes('crit')) return 'critical';
      if (s.includes('warn')) return 'warning';
      return 'unknown';
    }

    function getNeedAckSeverityBucket(child, group) {
      const state = child?.State || {};
      const events = Array.isArray(state.Events) ? state.Events : [];
      const lastEv = events.length ? events[events.length - 1] : null;
      const fromChild =
        state.CurrentStatus ??
        state.WorstStatus ??
        state.LastAbnormalStatus ??
        lastEv?.Status ??
        '';
      let bucket = parseNeedAckStatusToBucket(fromChild);
      if (bucket === 'unknown' && !String(fromChild).trim() && group) {
        const fromGroup =
          group.CurrentStatus ??
          group.WorstStatus ??
          group.Status ??
          '';
        bucket = parseNeedAckStatusToBucket(fromGroup);
      }
      return bucket;
    }

    function getNeedAckSeverityFromGroupOnly(group) {
      const raw =
        group?.CurrentStatus ??
        group?.WorstStatus ??
        group?.Status ??
        '';
      return parseNeedAckStatusToBucket(raw);
    }

    function needAckStableKey(child, group) {
      const state = child?.State || {};
      const id = state?.Id;
      if (id != null && String(id).trim() !== '') {
        return `id:${String(id).trim()}`;
      }

      const alertKey =
        (typeof child?.AlertKey === 'string' && child.AlertKey.trim()) ||
        (typeof state?.Alert === 'string' && state.Alert.trim()) ||
        '';
      const tags =
        typeof state?.Tags === 'string' && state.Tags.trim()
          ? state.Tags.trim()
          : '';

      if (alertKey && tags) return `ak:${alertKey}|tags:${tags}`;
      if (alertKey) return `ak:${alertKey}`;

      const groupSub =
        typeof group?.Subject === 'string' && group.Subject.trim()
          ? group.Subject.trim()
          : '';
      const childSub =
        typeof child?.Subject === 'string' && child.Subject.trim()
          ? child.Subject.trim()
          : '';
      const ago =
        typeof child?.Ago === 'string' && child.Ago.trim()
          ? child.Ago.trim()
          : '';

      if (groupSub && childSub && ago) return `g:${groupSub}|c:${childSub}|ago:${ago}`;
      if (groupSub && childSub) return `g:${groupSub}|c:${childSub}`;
      if (childSub) return `c:${childSub}`;
      if (groupSub) return `g:${groupSub}`;
      return null;
    }

    function collectCurrentIdsAndSeverity(payload) {
      const groups = payload?.Groups?.NeedAck;
      const currentIds = new Set();
      const idToSeverity = new Map();
      if (!Array.isArray(groups)) return { currentIds, idToSeverity };

      for (const group of groups) {
        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        const children = normalizeNeedAckChildren(group?.Children);

        if (!children.length && groupSubject) {
          const key = `grp:${groupSubject}`;
          currentIds.add(key);
          idToSeverity.set(key, getNeedAckSeverityFromGroupOnly(group));
          continue;
        }

        let anyChildKey = false;
        for (const child of children) {
          const key = needAckStableKey(child, group);
          if (!key) continue;
          anyChildKey = true;
          currentIds.add(key);
          idToSeverity.set(key, getNeedAckSeverityBucket(child, group));
        }
        if (!anyChildKey && groupSubject) {
          const key = `grp:${groupSubject}`;
          currentIds.add(key);
          idToSeverity.set(key, getNeedAckSeverityFromGroupOnly(group));
        }
      }

      return { currentIds, idToSeverity };
    }

    return {
      parseNeedAckStatusToBucket,
      getNeedAckSeverityBucket,
      getNeedAckSeverityFromGroupOnly,
      needAckStableKey,
      collectCurrentIdsAndSeverity
    };
  }

  globalThis.BosunSilenceHiderNeedAckSeverity = {
    createNeedAckSeverity
  };
})();
