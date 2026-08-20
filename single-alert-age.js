(() => {
  'use strict';

  // Temporary live-Bosun diagnostics. Set to false to disable all logs below.
  const SINGLE_ALERT_AGE_DEBUG = true;
  const SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS = 20;
  const DEBUG_PREFIX = '[BosunHelper][single-alert-age-problem]';

  function createSingleAlertAge(options = {}) {
    const {
      normalizeChildren = (value) => Array.isArray(value) ? value : (value == null ? [] : [value]),
      buildGroupKeyFromData = () => null,
      buildGroupKeyFromDom = () => null,
      getRoots = () => [],
      getGroupPanels = () => [],
      getGroupSubject = () => null,
      getGroupCountNode = () => null,
      getRenderedChildAge = () => null,
      getDomChildCount = () => 0,
      hasStrongDomIdentity = () => false,
      now = () => Date.now(),
      debug = SINGLE_ALERT_AGE_DEBUG,
      debugLogger = (...args) => console.debug(...args)
    } = options;

    let groupsByType = new Map();
    const lastValidByPanel = new Map();
    let snapshotId = 0;
    let problemCount = 0;

    function timestamp() {
      try {
        return new Date(Number(now())).toISOString();
      } catch (_) {
        return new Date().toISOString();
      }
    }

    function fingerprint(value, label) {
      if (typeof value !== 'string' || !value) return null;
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return `${label}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    function getManagedNode(node) {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      if (!element) return null;
      if (element.dataset?.bosunSingleAlertExpectedText != null) return element;
      return element.closest?.('[data-bosun-single-alert-expected-text]') || null;
    }

    function isManagedNode(node) {
      return Boolean(getManagedNode(node));
    }

    function isSynchronizedMutationNode(node) {
      const managed = getManagedNode(node);
      if (!managed) return false;
      return managed.textContent === managed.dataset.bosunSingleAlertExpectedText;
    }

    function setExpectedText(node, text) {
      node.dataset.bosunSingleAlertExpectedText = text;
      if (node.textContent !== text) node.textContent = text;
    }

    function parseTimestamp(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 100000000000 ? value * 1000 : value;
      }
      if (typeof value !== 'string' || !value.trim()) return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function formatAge(value) {
      const timestamp = parseTimestamp(value);
      const currentTime = Number(now());
      if (timestamp == null || !Number.isFinite(currentTime) || timestamp > currentTime) return null;

      const seconds = Math.round((currentTime - timestamp) / 1000);
      const minutes = Math.round(seconds / 60);
      const hours = Math.round(minutes / 60);
      const days = Math.round(hours / 24);
      const months = Math.round(days / 30);
      const years = Math.round(days / 365);

      if (seconds < 45) return `${seconds}s-ago`;
      if (seconds < 90) return '1m-ago';
      if (minutes < 45) return `${minutes}m-ago`;
      if (minutes < 90) return '1h-ago';
      if (hours < 22) return `${hours}h-ago`;
      if (hours < 36) return '1d-ago';
      if (days < 26) return `${days}d-ago`;
      if (days < 46) return '1n-ago';
      if (days < 345) return `${months}n-ago`;
      if (years === 1) return '1y-ago';
      return `${years}y-ago`;
    }

    function update(payload, metadata = {}) {
      snapshotId += 1;
      const next = new Map();
      const groups = payload?.Groups;
      if (!groups || typeof groups !== 'object') {
        groupsByType = next;
        return;
      }

      for (const type of ['NeedAck', 'Acknowledged']) {
        const list = Array.isArray(groups[type]) ? groups[type] : [];
        const byKey = new Map();
        const bySubject = new Map();

        for (const group of list) {
          const children = normalizeChildren(group?.Children);
          const subject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
          const record = {
            section: type,
            subject,
            groupKey: null,
            count: children.length,
            agoTimestamp: children.length === 1 ? parseTimestamp(children[0]?.Ago) : null,
            age: children.length === 1 ? formatAge(children[0]?.Ago) : null
          };
          const key = buildGroupKeyFromData(group);
          record.groupKey = key || null;
          if (key) {
            const records = byKey.get(key) || [];
            records.push(record);
            byKey.set(key, records);
          }
          if (subject) {
            const records = bySubject.get(subject) || [];
            records.push(record);
            bySubject.set(subject, records);
          }
        }

        next.set(type, { byKey, bySubject });

      }

      groupsByType = next;
    }

    function inspectResolution(type, panel) {
      const index = groupsByType.get(type);
      const groupKey = buildGroupKeyFromDom(panel) || null;
      const subject = getGroupSubject(panel) || null;
      if (!index) {
        return { record: null, result: 'no-match', reason: 'section-not-indexed', groupKey, subject, snapshotMatches: 0 };
      }

      const keyedRecords = groupKey ? index.byKey.get(groupKey) : null;
      if (keyedRecords?.length === 1) {
        return { record: keyedRecords[0], result: 'matched', reason: 'group-key', groupKey, subject, snapshotMatches: 1 };
      }
      if (keyedRecords?.length > 1) {
        return { record: null, result: 'ambiguous', reason: 'duplicate-group-key', groupKey, subject, snapshotMatches: keyedRecords.length };
      }
      if (hasStrongDomIdentity(panel)) {
        return { record: null, result: 'no-match', reason: 'strong-key-mismatch', groupKey, subject, snapshotMatches: 0 };
      }

      const subjectRecords = subject ? index.bySubject.get(subject) : null;
      if (subjectRecords?.length === 1) {
        return { record: subjectRecords[0], result: 'matched', reason: 'unique-subject', groupKey, subject, snapshotMatches: 1 };
      }
      if (subjectRecords?.length > 1) {
        return { record: null, result: 'ambiguous', reason: 'duplicate-subject', groupKey, subject, snapshotMatches: subjectRecords.length };
      }
      return { record: null, result: 'no-match', reason: 'missing-candidate', groupKey, subject, snapshotMatches: 0 };
    }

    function restoreCount(node, record) {
      if (node?.dataset?.bosunSingleAlertAge !== 'true') return;
      const currentText = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      const countText = record && Number.isInteger(record.count) && record.count > 0
        ? `${record.count} alerts`
        : (/^\d+\s+alerts?$/i.test(currentText)
            ? currentText
            : (node.dataset.bosunOriginalAlertCount || '1 alerts'));
      setExpectedText(node, countText, {
        section: record?.section || null,
        subject: record?.subject || null,
        groupKey: record?.groupKey || null,
        decision: 'restore-count',
        ageSource: 'fallback'
      });
      delete node.dataset.bosunSingleAlertAge;
      delete node.dataset.bosunOriginalAlertCount;
      delete node.dataset.bosunSingleAlertAgeDecision;
    }

    function getPanelIdentity(type, panel) {
      const subject = String(getGroupSubject(panel) || '').replace(/\s+/g, ' ').trim();
      if (subject) return `${type}|subject:${subject}`;
      const groupKey = buildGroupKeyFromDom(panel);
      return groupKey ? `${type}|key:${groupKey}` : null;
    }

    function getPreservedMapping(type, panel, inspection, domChildCount) {
      if (inspection.result !== 'no-match' || inspection.reason !== 'missing-candidate') return null;
      if (domChildCount > 1) return null;
      const cached = lastValidByPanel.get(panel);
      const identity = getPanelIdentity(type, panel);
      const strongDomIdentity = hasStrongDomIdentity(panel);
      const currentStrongKey = strongDomIdentity ? buildGroupKeyFromDom(panel) : null;
      if (
        !cached ||
        cached.section !== type ||
        !identity ||
        cached.identity !== identity ||
        !Number.isFinite(cached.agoTimestamp) ||
        (strongDomIdentity && (
          !currentStrongKey ||
          (cached.snapshotGroupKey !== currentStrongKey && cached.strongDomKey !== currentStrongKey)
        ))
      ) {
        return null;
      }
      return cached;
    }

    function sweepRemovedPanels(rootEntries) {
      const activePanels = new Set();
      const presentSections = new Set();
      for (const entry of rootEntries) {
        if (!entry?.type || !entry?.root) continue;
        presentSections.add(entry.type);
        for (const panel of getGroupPanels(entry.root)) activePanels.add(panel);
      }
      for (const [panel, cached] of lastValidByPanel) {
        if (presentSections.has(cached.section) && !activePanels.has(panel)) {
          lastValidByPanel.delete(panel);
        }
      }
    }

    function refresh() {
      const rootEntries = Array.from(getRoots() || []);
      sweepRemovedPanels(rootEntries);
      for (const entry of rootEntries) {
        const type = entry?.type;
        const root = entry?.root;
        if (!type || !root) continue;

        for (const panel of getGroupPanels(root)) {
          const node = getGroupCountNode(panel);
          if (!node) continue;
          const inspection = inspectResolution(type, panel);
          let record = inspection.record;
          const domChildCount = Number(getDomChildCount(panel)) || 0;
          let result = inspection.result;
          let reason = inspection.reason;
          if (domChildCount > 0 && record?.count !== domChildCount) {
            record = null;
            result = 'no-match';
            reason = 'dom-child-count-mismatch';
          }
          const renderedAge = record?.count === 1
            ? String(getRenderedChildAge(panel) || '').replace(/\s+/g, ' ').trim()
            : '';
          let age = renderedAge || record?.age || '';
          if (record?.count === 1 && !age) {
            result = 'invalid-age';
            reason = 'age-unavailable';
          }

          const identity = getPanelIdentity(type, panel);
          const validLiveMapping =
            result === 'matched' &&
            record?.count === 1 &&
            domChildCount <= 1 &&
            Number.isFinite(record.agoTimestamp) &&
            Boolean(identity) &&
            Boolean(formatAge(record.agoTimestamp));
          let decision = 'use-live-match';
          if (validLiveMapping) {
            age = renderedAge || formatAge(record.agoTimestamp) || '';
            lastValidByPanel.set(panel, {
              section: type,
              identity,
              agoTimestamp: record.agoTimestamp,
              snapshotGroupKey: record.groupKey || null,
              strongDomKey: hasStrongDomIdentity(panel) ? buildGroupKeyFromDom(panel) : null,
              snapshotId
            });
          } else {
            const preserved = getPreservedMapping(type, panel, { result, reason }, domChildCount);
            if (preserved) {
              age = formatAge(preserved.agoTimestamp) || '';
              record = { section: type, count: 1 };
              decision = 'preserve-last-valid-match';
            } else {
              lastValidByPanel.delete(panel);
            }
          }

          if (record?.count !== 1 || !age) {
            restoreCount(node, record || (domChildCount > 1 ? { section: type, count: domChildCount } : null));
          } else {
            if (node.dataset.bosunSingleAlertAge !== 'true') {
              node.dataset.bosunOriginalAlertCount = node.textContent || '1 alerts';
            }
            node.dataset.bosunSingleAlertAge = 'true';
            setExpectedText(node, age);
            node.dataset.bosunSingleAlertAgeDecision = decision;
          }
        }
      }
    }

    function getPanelContext(node) {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      if (!element) return null;
      for (const entry of getRoots()) {
        if (!entry?.root) continue;
        for (const panel of getGroupPanels(entry.root)) {
          if (panel === element || panel.contains?.(element)) {
            const inspection = inspectResolution(entry.type, panel);
            const countNode = getGroupCountNode(panel);
            const domChildCount = Number(getDomChildCount(panel)) || 0;
            let record = inspection.record;
            let matchResult = inspection.result;
            let matchReason = inspection.reason;
            if (domChildCount > 0 && record?.count !== domChildCount) {
              record = null;
              matchResult = 'no-match';
              matchReason = 'dom-child-count-mismatch';
            }
            const renderedAge = record?.count === 1
              ? String(getRenderedChildAge(panel) || '').replace(/\s+/g, ' ').trim()
              : '';
            const age = renderedAge || record?.age || '';
            if (record?.count === 1 && !age) {
              matchResult = 'invalid-age';
              matchReason = 'age-unavailable';
            }
            const preserved = getPreservedMapping(
              entry.type,
              panel,
              { result: matchResult, reason: matchReason },
              domChildCount
            );
            return {
              section: entry.type,
              subject: inspection.subject,
              groupKey: inspection.groupKey,
              snapshotMatches: inspection.snapshotMatches,
              matchResult,
              matchReason,
              snapshotAge: record?.age || null,
              decision: preserved ? 'preserve-last-valid-match' : 'use-live-result',
              domChildCount,
              countNode,
              expectedText: countNode?.dataset?.bosunSingleAlertExpectedText || null
            };
          }
        }
      }
      return null;
    }

    function normalizedText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function nodeText(nodes) {
      return normalizedText(Array.from(nodes || [], (node) => node?.textContent || '').join('')) || null;
    }

    function captureAgeReset(mutation, lifecycle = {}) {
      if (!debug || problemCount >= SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS || !mutation) return null;
      const addedElements = Array.from(mutation.addedNodes || []).filter((node) => node?.nodeType === 1);
      const removedElements = Array.from(mutation.removedNodes || []).filter((node) => node?.nodeType === 1);
      const targetManaged = getManagedNode(mutation.target);
      const findCountNode = (nodes) => {
        for (const node of nodes) {
          if (node.matches?.('.pull-right.ng-binding')) return node;
          const nested = node.querySelector?.('.pull-right.ng-binding');
          if (nested) return nested;
        }
        return null;
      };
      const addedCountElement = findCountNode(addedElements);
      const removedCountElement = findCountNode(removedElements);
      const addedCountNode = Boolean(addedCountElement);
      const removedCountNode = Boolean(removedCountElement);
      const previousText = removedCountElement
        ? normalizedText(removedCountElement.textContent)
        : nodeText(mutation.removedNodes);
      const directCurrentText = normalizedText(targetManaged?.textContent || addedCountElement?.textContent);
      if (!/^\d+(?:s|m|h|d|n|y)-ago$/i.test(previousText || '')) return null;
      if (!/^1\s+alerts?$/i.test(directCurrentText)) return null;

      const context = getPanelContext(mutation.target) ||
        addedElements.map(getPanelContext).find(Boolean) ||
        removedElements.map(getPanelContext).find(Boolean) || {};
      const managedNode = targetManaged ||
        getManagedNode(context.countNode) ||
        getManagedNode(addedCountElement) ||
        getManagedNode(removedCountElement);
      const currentText = normalizedText(context.countNode?.textContent || directCurrentText);
      const expectedText = context.expectedText ||
        targetManaged?.dataset?.bosunSingleAlertExpectedText ||
        removedCountElement?.dataset?.bosunSingleAlertExpectedText ||
        null;
      if (!/^1\s+alerts?$/i.test(currentText)) return null;

      const directCountReplacement = addedCountElement && removedCountElement &&
        addedElements.includes(addedCountElement) && removedElements.includes(removedCountElement);
      problemCount += 1;
      return {
        details: {
          timestamp: timestamp(),
          problemId: problemCount,
          event: 'age-reset-to-counter',
          section: context.section || null,
          subjectHash: fingerprint(context.subject, 'subject'),
          groupKeyHash: fingerprint(context.groupKey, 'group'),
          previousText,
          currentText,
          expectedText,
          snapshotId,
          snapshotAge: context.snapshotAge || null,
          snapshotMatches: context.snapshotMatches ?? null,
          matchingResult: context.matchResult || 'no-match',
          matchingReason: context.matchReason || 'group-context-unavailable',
          decision: context.decision || 'use-live-result',
          managed: Boolean(managedNode),
          synchronized: managedNode ? isSynchronizedMutationNode(managedNode) : false,
          consideredOwn: lifecycle.consideredOwn === true,
          countNodeReplaced: Boolean(addedCountNode && removedCountNode),
          parentNodeReplaced: Boolean(
            (addedElements.length || removedElements.length) &&
            !targetManaged &&
            !directCountReplacement
          ),
          observerTriggered: true,
          repaintAttempted: lifecycle.repaint === true,
          repaintResult: 'not-attempted',
          finalTextAfterRepaint: currentText
        },
        countNode: context.countNode || addedCountElement || null
      };
    }

    function completeAgeReset(problem, repaintAttempted = false) {
      if (!debug || !problem?.details) return false;
      const finalText = normalizedText(problem.countNode?.textContent);
      const details = {
        ...problem.details,
        repaintAttempted: Boolean(repaintAttempted),
        repaintResult: !repaintAttempted
          ? 'not-attempted'
          : (finalText === problem.details.expectedText
              ? 'set-age'
              : (/^1\s+alerts?$/i.test(finalText) ? 'remained-counter' : 'changed-other')),
        finalTextAfterRepaint: finalText || null
      };
      try {
        debugLogger(DEBUG_PREFIX, details);
      } catch (_) {}
      return true;
    }

    function isDebugEnabled() {
      return debug && problemCount < SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS;
    }

    function clear() {
      lastValidByPanel.clear();
      groupsByType = new Map();
      refresh();
    }

    function getHistoryStats() {
      return { entries: lastValidByPanel.size };
    }

    return {
      update,
      refresh,
      clear,
      formatAge,
      isManagedNode,
      isSynchronizedMutationNode,
      isDebugEnabled,
      captureAgeReset,
      completeAgeReset,
      getHistoryStats
    };
  }

  globalThis.BosunHelperSingleAlertAge = {
    SINGLE_ALERT_AGE_DEBUG,
    SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS,
    createSingleAlertAge
  };
})();
