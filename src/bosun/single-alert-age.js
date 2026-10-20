(() => {
  'use strict';

  // Temporary live-Bosun diagnostics. Set to false to disable all logs below.
  const SINGLE_ALERT_AGE_DEBUG = false;
  const SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS = 20;
  const MISSING_CANDIDATE_GRACE_SNAPSHOTS = 2;
  const MISSING_CANDIDATE_GRACE_MS = 15000;
  const DEBUG_PREFIX = '[BosunHelper][single-alert-age-problem]';

  function createSingleAlertAge(options = {}) {
    const {
      normalizeChildren = (value) => Array.isArray(value) ? value : (value == null ? [] : [value]),
      buildGroupKeyFromData = () => null,
      buildGroupKeyFromDom = () => null,
      getRoots = () => [],
      getGroupPanels = () => [],
      getGroupSubject = () => null,
      getRawGroupSubject = getGroupSubject,
      getGroupCountNode = () => null,
      getRenderedChildAge = () => null,
      getDomChildCount = () => 0,
      hasStrongDomIdentity = () => false,
      readModelIdentity = () => null,
      readExpandedModelIdentity = () => null,
      sanitizeExpandedReaderReason = () => 'unknown',
      buildModelSnapshotIndexes = null,
      now = () => Date.now(),
      debug = SINGLE_ALERT_AGE_DEBUG,
      debugLogger = (...args) => console.debug(...args)
    } = options;

    let groupsByType = new Map();
    let modelSnapshotIndexes = null;
    let modelIndexReason = 'not-built';
    let currentPayload = null;
    const lastValidByPanel = new Map();
    let snapshotId = 0;
    let problemCount = 0;
    let latestSnapshotSource = 'other';
    let latestSnapshotGroups = 0;

    // Opt-in, bounded, memory-only recorder. No operational strings enter it.
    let trace = null;
    let traceObserver = null;
    let traceTimer = null;
    let tracePanels = new WeakMap();
    let traceNodes = new WeakMap();
    let traceWrites = new WeakMap();
    const sourceCode = value => ['prime', 'regular', 'leader', 'follower', 'direct'].includes(value) ? value : 'other';
    const countGroups = payload => ['NeedAck', 'Acknowledged'].reduce((sum, type) =>
      sum + (Array.isArray(payload?.Groups?.[type]) ? payload.Groups[type].length : 0), 0);
    const textState = text => /^\d+(?:s|m|h|d|n|y)-ago$/i.test(String(text || '').trim()) ? 'age'
      : (/^\d+\s+alerts?$/i.test(String(text || '').trim()) ? 'count' : 'other');
    const traceActive = () => trace?.active === true;
    function traceEvent(event) {
      if (!traceActive()) return;
      if (trace.events.length >= 2000) { trace.events.splice(50, 1); trace.droppedEvents += 1; }
      trace.events.push({ sequence: ++trace.sequence, generation: snapshotId, ...event });
    }
    function tracePanel(panel, node) {
      if (!traceActive()) return null;
      let entry = tracePanels.get(panel);
      if (!entry) {
        if (trace.panelCount >= 512) { trace.panelLimitReached = true; return null; }
        entry = { number: ++trace.panelCount };
        tracePanels.set(panel, entry);
      }
      if (node) {
        traceNodes.set(node, entry.number);
        for (const child of node.childNodes || []) traceNodes.set(child, entry.number);
      }
      return entry;
    }
    // Comparison only: normalized candidates never participate in resolution.
    function traceCandidates(indexes, type, panel) {
      const subject = getGroupSubject(panel) || '';
      const rawSubject = String(getRawGroupSubject(panel) || '').trim();
      const key = buildGroupKeyFromDom(panel);
      const canonical = value => String(value || '').replace(/\s+/g, ' ').trim();
      const current = indexes.get(type);
      const other = indexes.get(type === 'NeedAck' ? 'Acknowledged' : 'NeedAck');
      const count = index => subject ? index?.bySubject.get(subject)?.length || 0 : 0;
      const normalizedCount = index => subject ? Array.from(index?.bySubject || []).reduce((sum, [text, rows]) =>
        sum + (canonical(text) === canonical(subject) ? rows.length : 0), 0) : 0;
      return {
        domSubjectPresent: Boolean(subject), exactSubjectMatch: count(current) > 0,
        rawDomSubjectExactMatch: Boolean(rawSubject && current?.bySubject.has(rawSubject)),
        whitespaceNormalizedMatch: normalizedCount(current) > 0,
        candidateInOtherSection: count(other) > 0,
        candidateCountInCurrentSection: count(current), candidateCountInOtherSection: count(other),
        candidateCountAfterNormalization: normalizedCount(current),
        normalizedCandidateCountInOtherSection: normalizedCount(other),
        domGroupKeyPresent: Boolean(key), snapshotGroupKeyMatch: Boolean(key && current?.byKey.has(key)),
        strongDomIdentityPresent: Boolean(hasStrongDomIdentity(panel))
      };
    }
    function traceStableChildren(previous, type, previousPayload, payload, next) {
      // IDs and group objects exist only during this read-only call, never in trace state.
      const stableId = child => {
        const value = child?.State?.Id;
        if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9]\d*$/.test(value))) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
      };
      const previousGroups = Array.isArray(previousPayload?.Groups?.[type]) ? previousPayload.Groups[type] : [];
      const oldGroups = previousGroups.filter(group =>
        (typeof group?.Subject === 'string' ? group.Subject.trim() : '') === previous.subject &&
        (buildGroupKeyFromData(group) || null) === previous.groupKey &&
        normalizeChildren(group?.Children).length === previous.count);
      const children = oldGroups.length === 1 ? normalizeChildren(oldGroups[0].Children) : [];
      const ids = children.map(stableId).filter(Boolean);
      const uniqueIds = new Set(ids);
      const foundIds = new Set();
      let complete = children.length > 0 && ids.length === children.length && uniqueIds.size === ids.length;
      let matchCount = 0, destinationGroups = 0, differentSubject = false, differentSection = false;
      let groupKeyChanged = false, additionalChildren = false;
      let newAgo = null;
      const occurrences = new Map();
      for (const section of ['NeedAck', 'Acknowledged']) {
        const list = payload?.Groups?.[section];
        if (!Array.isArray(list)) { complete = false; continue; }
        for (const group of list) {
          const nextChildren = normalizeChildren(group?.Children);
          const nextIds = nextChildren.map(stableId);
          if (!nextIds.length || nextIds.some(id => !id)) complete = false;
          const matches = nextIds.filter(id => id && uniqueIds.has(id));
          if (!matches.length) continue;
          if (children.length === 1 && uniqueIds.size === 1) newAgo = parseTimestamp(nextChildren.find(child => uniqueIds.has(stableId(child)))?.Ago);
          destinationGroups += 1;
          matchCount += matches.length;
          for (const id of matches) { foundIds.add(id); occurrences.set(id, (occurrences.get(id) || 0) + 1); }
          differentSubject ||= (typeof group?.Subject === 'string' ? group.Subject.trim() : '') !== previous.subject;
          differentSection ||= section !== type;
          groupKeyChanged ||= (buildGroupKeyFromData(group) || null) !== previous.groupKey;
          additionalChildren ||= nextChildren.length > children.length || nextIds.some(id => id && !uniqueIds.has(id));
        }
      }
      const oldSubjectPresent = ['NeedAck', 'Acknowledged'].some(section => next.get(section)?.bySubject.has(previous.subject));
      const oldKeyPresent = previous.groupKey && ['NeedAck', 'Acknowledged'].some(section => next.get(section)?.byKey.has(previous.groupKey));
      const oldAgo = children.length === 1 ? parseTimestamp(children[0]?.Ago) : null;
      const agoComparable = children.length === 1 && uniqueIds.size === 1 && matchCount === 1 && oldAgo != null && newAgo != null;
      return { previousStableChildIdAvailable: ids.length > 0, previousStableChildIdCount: uniqueIds.size,
        stableChildAgoComparable: agoComparable, stableChildAgoChanged: agoComparable && oldAgo !== newAgo,
        stableChildAgoMovedForward: agoComparable && newAgo > oldAgo,
        stableChildComparisonComplete: complete, stableChildFoundInNewSnapshot: matchCount > 0,
        stableChildMatchCount: matchCount, stableChildDestinationGroupCount: destinationGroups,
        stableChildIdAmbiguous: uniqueIds.size !== ids.length || Array.from(occurrences.values()).some(count => count > 1),
        allPreviousStableChildrenFound: uniqueIds.size > 0 && foundIds.size === uniqueIds.size,
        sameStableChildDifferentSubject: differentSubject, sameStableChildDifferentSection: differentSection,
        sameStableChildDifferentGroupKey: groupKeyChanged, stableChildDestinationHasAdditionalChildren: additionalChildren,
        previousGroupDisappeared: Boolean(complete && matchCount === 0 && !oldSubjectPresent && !oldKeyPresent) };
    }
    function traceIndexChange(next, payload, previousPayload) {
      if (!traceActive()) return;
      for (const { type, root } of getRoots() || []) {
        if (!root || !type) continue;
        for (const panel of getGroupPanels(root)) {
          const entry = tracePanel(panel, getGroupCountNode(panel));
          if (!entry) continue;
          const previous = inspectResolution(type, panel);
          const subject = getGroupSubject(panel) || '';
          const currentRows = next.get(type)?.bySubject.get(subject) || [];
          const current = currentRows.length === 1 ? currentRows[0] : null;
          const other = next.get(type === 'NeedAck' ? 'Acknowledged' : 'NeedAck');
          const comparable = Boolean(previous.record && current);
          // Ordinary unchanged generations already have panel-decision events.
          if (!previous.record || (current && previous.record.count === current.count &&
              previous.record.groupKey === current.groupKey && previous.record.agoTimestamp === current.agoTimestamp)) continue;
          traceEvent({ event: 'snapshot-index-comparison', panel: entry.number, source: latestSnapshotSource,
            section: type === 'NeedAck' ? 'NeedAck' : 'Acknowledged',
            previousIdentityReason: previous.reason, previousRecordFound: Boolean(previous.record),
            previousSubjectMatch: Boolean(subject && groupsByType.get(type)?.bySubject.has(subject)),
            previousGroupKeyInOtherSection: Boolean(previous.record?.groupKey && other?.byKey.has(previous.record.groupKey)),
            childCompositionComparable: comparable,
            childCountChanged: comparable && previous.record.count !== current.count,
            groupKeyRepresentationChanged: comparable && previous.record.groupKey !== current.groupKey,
            sameGroupKeyAgoComparable: Boolean(comparable && previous.record.groupKey && previous.record.groupKey === current.groupKey &&
              Number.isFinite(previous.record.agoTimestamp) && Number.isFinite(current.agoTimestamp)),
            sameGroupKeyAgoTimestampChanged: Boolean(comparable && previous.record.groupKey && previous.record.groupKey === current.groupKey &&
              Number.isFinite(previous.record.agoTimestamp) && Number.isFinite(current.agoTimestamp) && previous.record.agoTimestamp !== current.agoTimestamp),
            ...traceStableChildren(previous.record, type, previousPayload, payload, next),
            ...traceCandidates(next, type, panel) });
        }
      }
    }
    function traceGrace(type, panel) {
      const cached = lastValidByPanel.get(panel);
      return { cachedMappingPresent: Boolean(cached),
        cachedPanelIdentityMatches: Boolean(cached && cached.section === type && cached.identity === getPanelIdentity(type, panel)),
        graceSnapshotLimitExceeded: Boolean(cached && snapshotId - cached.snapshotId > MISSING_CANDIDATE_GRACE_SNAPSHOTS),
        graceTimeLimitExceeded: Boolean(cached && Number(now()) - cached.matchedAt > MISSING_CANDIDATE_GRACE_MS) };
    }
    function traceAgeEvidence(type, record, panel) {
      const list = currentPayload?.Groups?.[type];
      const groups = record?.groupKey && Array.isArray(list) ? list.filter(group => buildGroupKeyFromData(group) === record.groupKey) : [];
      const children = groups.length === 1 ? normalizeChildren(groups[0]?.Children) : [];
      const child = children.length === 1 ? children[0] : null;
      const events = child?.State?.Events;
      const last = Array.isArray(events) && events.length ? parseTimestamp(events[events.length - 1]?.Time) : null;
      const ago = parseTimestamp(child?.Ago), start = parseTimestamp(child?.State?.Start);
      const rendered = String(getRenderedChildAge(panel) || '').replace(/\s+/g, ' ').trim();
      return { snapshotChildAgoPresent: ago != null, snapshotGroupAgoPresent: Boolean(groups.length === 1 && parseTimestamp(groups[0].Ago) != null),
        snapshotLastEventTimePresent: last != null,
        snapshotChildAgoMatchesLastEvent: ago != null && last != null && ago === last,
        snapshotIncidentStartPresent: start != null, snapshotChildAgoMatchesIncidentStart: ago != null && start != null && ago === start,
        renderedAgeTextEqualsSnapshot: Boolean(rendered && record && rendered === formatAge(record.agoTimestamp)) };
    }
    function traceModelFallback(type, panel, resolved, models, indexReason, generation) {
      if (!traceActive()) return null;
      trace.totals.modelFallbacks = (trace.totals.modelFallbacks || 0) + 1;
      const entry = tracePanel(panel, getGroupCountNode(panel));
      if (!entry) return null;
      let reason = 'unavailable';
      const identity = resolved?.identity, child = identity?.children?.length === 1 ? identity.children[0] : null;
      if (resolved?.status === 'stale') reason = 'stale-state';
      else if (resolved?.status === 'read') {
        if (identity?.rejected) reason = 'reader-rejected';
        else if (!identity || !Array.isArray(identity.children)) reason = 'invalid-model';
        else if (identity.section !== type) reason = 'section-mismatch';
        else if (identity.children.length !== 1) reason = 'model-child-count';
        else if (!child || typeof child !== 'object') reason = 'invalid-model';
        else if (typeof child.id !== 'string' || !/^[1-9]\d{0,15}$/.test(child.id) || !Number.isSafeInteger(Number(child.id))) reason = 'invalid-model';
        else if (typeof child.key !== 'string' || !child.key) reason = 'invalid-model';
        else if (!models) reason = 'index-unavailable';
        else {
          // Counts only: this diagnostic scan never supplies a rendering record.
          let idCount = 0, keyCount = 0, sameSection = false, sameKey = false, childCount = 0;
          for (const section of ['NeedAck','Acknowledged']) for (const group of currentPayload?.Groups?.[section] || []) {
            const children = normalizeChildren(group?.Children);
            for (const row of children) {
              if (String(row?.State?.Id) === child.id) {
                idCount++; sameSection = section === type; childCount = children.length;
                sameKey = (row?.AlertKey ?? row?.State?.AlertKey) === child.key;
              }
              if ((row?.AlertKey ?? row?.State?.AlertKey) === child.key) keyCount++;
            }
          }
          if (idCount > 1 || keyCount > 1) reason = 'duplicate';
          else if (!idCount) reason = 'id-mismatch';
          else if (!sameSection) reason = 'section-mismatch';
          else if (!sameKey) reason = 'alertkey-mismatch';
          else if (childCount !== 1) reason = 'snapshot-child-count';
          else {
            const model = models[type]?.get(child.id);
            const records = model ? groupsByType.get(type)?.byKey.get(model.key) : null;
            const record = records?.length === 1 ? records[0] : null;
            reason = record && groupsByType.get(type)?.bySubject.get(record.subject)?.length === 1 ? 'matched' : 'duplicate-or-unindexed';
          }
        }
      }
      if (resolved?.compositeMismatch) reason = 'composite-key-mismatch';
      if (resolved?.expandedSubjectConflict) reason = 'subject-conflict';
      const row = { fallbackAttempted: true, fallbackReason: reason,
        fallbackReaderCalled: entry.readerCalled === true, fallbackReaderReason: entry.readerStage || 'adapter-unavailable',
        expandedReaderReason: entry.expandedReaderReason || 'not-reported',
        modelIndexAvailable: Boolean(models), modelIndexReason: indexReason };
      traceEvent({ event: 'model-fallback', panel: entry.number, section: type, attemptGeneration: generation, ...row });
      return row;
    }
    function traceDecision(type, panel, node, inspection, details = {}) {
      if (!traceActive()) return;
      const entry = tracePanel(panel, node);
      if (!entry) return;
      const record = details.modelRecord || inspection.record;
      const previous = trace.panels[entry.number];
      const row = { panel: entry.number, section: type === 'NeedAck' ? 'NeedAck' : 'Acknowledged',
        generation: snapshotId, source: latestSnapshotSource, domPresent: true,
        sectionChanged: Boolean(previous && previous.section !== type),
        ...traceCandidates(groupsByType, type, panel),
        ...(details.grace || traceGrace(type, panel)),
        ...traceAgeEvidence(type, record, panel),
        ageSource: details.ageSource || 'not-repainted',
        ...(details.fallback || { fallbackAttempted: false, fallbackReason: 'not-attempted', fallbackReaderCalled: false,
          fallbackReaderReason: 'not-called', modelIndexAvailable: Boolean(modelSnapshotIndexes), modelIndexReason }),
        identityReason: inspection.reason,
        presentationReason: node ? (details.presentationReason || 'not-repainted') : 'count-node-missing',
        recordFound: Boolean(inspection.record), modelIdentityMatched: details.modelIdentityMatched === true,
        snapshotMatches: inspection.snapshotMatches,
        snapshotChildCount: record?.count || 0, domChildCount: Number(getDomChildCount(panel)) || 0,
        agoValid: Boolean(record && Number.isFinite(record.agoTimestamp) && formatAge(record.agoTimestamp)),
        renderedAgePresent: Boolean(String(getRenderedChildAge(panel) || '').trim()),
        state: node ? textState(node.textContent) : 'missing',
        repaintAttempted: details.repaintAttempted === true,
        restoreCountCalled: details.restoreCountCalled === true,
        restoreCountApplied: details.restoreCountApplied === true,
        result: node && textState(node.textContent) === 'age' ? 'age-displayed' : 'age-not-displayed' };
      trace.panels[entry.number] = row;
      if (JSON.stringify(previous) !== JSON.stringify(row)) {
        traceEvent({ event: 'panel-decision', ...row });
      }
      if (details.repaintAttempted) {
        trace.summary.domPanels += 1;
        if (inspection.result === 'matched' || details.modelIdentityMatched) trace.summary.identityMatches += 1;
        if (row.state === 'age') trace.summary.agesDisplayed += 1;
        if (row.restoreCountCalled) trace.totals.restoreCountCalls += 1;
        if (row.restoreCountApplied) trace.totals.restoreCountApplied += 1;
        const reasons = trace.summary.identityReasons;
        reasons[row.identityReason] = (reasons[row.identityReason] || 0) + 1;
        const presentations = trace.summary.presentationReasons;
        presentations[row.presentationReason] = (presentations[row.presentationReason] || 0) + 1;
      }
    }
    function traceSample() {
      if (!traceActive()) return;
      const present = new Set();
      let found = 0;
      for (const { type, root } of getRoots() || []) {
        if (!root || !type) continue;
        for (const panel of getGroupPanels(root)) {
          found += 1;
          const node = getGroupCountNode(panel);
          const entry = tracePanel(panel, node);
          if (!entry) continue;
          present.add(entry.number);
          const previous = trace.panels[entry.number];
          // A read-only sample never claims that refresh has run.
          if (!previous || previous.section !== type || previous.generation !== snapshotId || previous.state !== (node ? textState(node.textContent) : 'missing')) {
            const inspection = inspectResolution(type, panel);
            traceDecision(type, panel, node, inspection, { presentationReason:
              node && textState(node.textContent) === 'age' && inspection.result === 'matched'
                ? (node.dataset?.bosunSingleAlertAgeDecision === 'preserve-last-valid-match' ? 'preserved-mapping' : 'matched')
                : 'not-repainted' });
          }
        }
      }
      trace.domPanelsFound = found;
      for (const row of Object.values(trace.panels)) {
        if (row.domPresent && !present.has(row.panel)) {
          row.domPresent = false;
          traceEvent({ event: 'panel-removed', panel: row.panel });
        }
      }
    }
    function traceMutation(mutation) {
      let number = traceNodes.get(mutation.target) || traceNodes.get(mutation.target?.parentElement);
      if (!number) {
        for (const node of [...(mutation.removedNodes || []), ...(mutation.addedNodes || [])]) {
          number = traceNodes.get(node);
          if (number) break;
        }
      }
      if (!number) return;
      const before = mutation.type === 'characterData' ? textState(mutation.oldValue)
        : textState(Array.from(mutation.removedNodes || [], node => node.textContent || '').join(''));
      const after = mutation.type === 'characterData' ? textState(mutation.target.data)
        : textState(Array.from(mutation.addedNodes || [], node => node.textContent || '').join(''));
      const owner = mutation.type === 'characterData' ? mutation.target.parentElement : mutation.target;
      const pending = owner && traceWrites.get(owner);
      const sameNodes = (left, right) => left && right && left.length === right.length &&
        Array.from(left).every((node, index) => node === right[index]);
      const index = mutation.type === 'childList' ? (pending?.findIndex(write =>
        sameNodes(mutation.removedNodes, write.removed) && sameNodes(mutation.addedNodes, write.added)) ?? -1) : -1;
      const own = index >= 0;
      if (own) pending.splice(index, 1);
      trace.totals.mutations += 1;
      traceEvent({ event: 'count-mutation', panel: number,
        mutationType: mutation.type === 'characterData' ? 'characterData' : 'childList',
        before, after, origin: own ? 'extension-write' : 'observed-dom-write' });
    }
    function stopTrace() {
      if (!trace) return false;
      for (const mutation of traceObserver?.takeRecords?.() || []) traceMutation(mutation);
      traceSample();
      traceObserver?.disconnect(); traceObserver = null;
      globalThis.removeEventListener?.('pagehide', stopTrace);
      if (traceTimer != null) clearTimeout(traceTimer);
      traceTimer = null;
      trace.active = false;
      tracePanels = new WeakMap(); traceNodes = new WeakMap(); traceWrites = new WeakMap();
      return true;
    }
    const diagnostics = Object.freeze({
      start(options = {}) {
        stopTrace();
        const requested = Number(options.durationMs);
        const durationMs = Number.isFinite(requested) ? Math.min(120000, Math.max(1000, requested)) : 90000;
        tracePanels = new WeakMap(); traceNodes = new WeakMap(); traceWrites = new WeakMap();
        trace = { active: true, durationMs, generation: snapshotId, sequence: 0, panelCount: 0, panelLimitReached: false,
          droppedEvents: 0, events: [], panels: {}, domPanelsFound: 0,
          snapshotReceived: snapshotId > 0, snapshotApplied: snapshotId > 0,
          snapshotGroups: latestSnapshotGroups, source: latestSnapshotSource,
          totals: { received: 0, applied: 0, refreshes: 0, mutations: 0, restoreCountCalls: 0, restoreCountApplied: 0 },
          summary: { domPanels: 0, identityMatches: 0, agesDisplayed: 0, identityReasons: {}, presentationReasons: {} } };
        traceSample();
        if (globalThis.MutationObserver && globalThis.document?.body) {
          traceObserver = new MutationObserver(mutations => {
            if (!traceActive()) return;
            for (const mutation of mutations) traceMutation(mutation);
            traceSample();
          });
          traceObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
        }
        traceTimer = setTimeout(stopTrace, durationMs);
        globalThis.addEventListener?.('pagehide', stopTrace);
        return { active: true, durationMs };
      },
      stop: stopTrace,
      report() {
        if (traceActive()) for (const mutation of traceObserver?.takeRecords?.() || []) traceMutation(mutation);
        traceSample();
        return trace ? JSON.parse(JSON.stringify(trace)) : { active: false };
      },
      clear() { stopTrace(); trace = null; tracePanels = new WeakMap(); traceNodes = new WeakMap(); traceWrites = new WeakMap(); },
      received(payload, source) {
        if (!traceActive()) return;
        trace.snapshotReceived = true;
        trace.snapshotApplied = false;
        trace.totals.received += 1;
        traceEvent({ event: 'snapshot-received', source: sourceCode(source), snapshotReceived: true,
          snapshotApplied: false, groups: countGroups(payload),
          needAckGroups: Array.isArray(payload?.Groups?.NeedAck) ? payload.Groups.NeedAck.length : 0,
          acknowledgedGroups: Array.isArray(payload?.Groups?.Acknowledged) ? payload.Groups.Acknowledged.length : 0 });
      },
      failed(source) {
        if (!traceActive()) return;
        trace.snapshotReceived = false; trace.snapshotApplied = false;
        traceEvent({ event: 'snapshot-fetch-failed', source: sourceCode(source),
          snapshotReceived: false, snapshotApplied: false });
      },
      repaint(phase) {
        if (!traceActive()) return;
        traceEvent({ event: phase === 'start' ? 'dom-repaint-start' : 'dom-repaint-end',
          agesDisplayed: trace.summary.agesDisplayed });
      },
      modelReader(panel, stage, mainReason = null) {
        if (!traceActive()) return;
        const entry = tracePanel(panel, getGroupCountNode(panel));
        if (!entry) return;
        const codes = ['adapter-entered','reader-unavailable','stale-before-read','reader-called','reader-threw',
          'stale-after-read','unexpected-promise','reader-empty','reader-rejected','reader-returned'];
        entry.readerStage = codes.includes(stage) ? stage : 'other';
        if (stage === 'adapter-entered') { entry.readerCalled = false; entry.expandedReaderReason = 'not-reported'; }
        if (stage === 'reader-called') entry.readerCalled = true;
        if (stage === 'reader-rejected' && mainReason != null) {
          const code = sanitizeExpandedReaderReason(mainReason);
          entry.expandedReaderReason = code;
          const counts = trace.totals.expandedReaderReasons || (trace.totals.expandedReaderReasons = {});
          counts[code] = (counts[code] || 0) + 1;
        }
      }
    });

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
      if (node.textContent !== text) {
        let diagnosticWrite = null;
        if (traceActive()) {
          const writes = traceWrites.get(node) || [];
          if (writes.length >= 16) writes.shift();
          diagnosticWrite = { removed: Array.from(node.childNodes || []), added: [] };
          writes.push(diagnosticWrite);
          traceWrites.set(node, writes);
          const number = traceNodes.get(node);
          for (const child of node.childNodes || []) if (number) traceNodes.set(child, number);
        }
        node.textContent = text;
        if (diagnosticWrite) diagnosticWrite.added = Array.from(node.childNodes || []);
      }
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

    function buildCompleteModelIndexes(payload) {
      modelIndexReason = 'index-builder-unavailable';
      if (typeof buildModelSnapshotIndexes !== 'function') return null;
      for (const section of ['NeedAck', 'Acknowledged']) {
        // Bosun omits empty sections; null also denotes an empty section.
        // Normalize only for this index. Never mutate the source snapshot.
        const groups = payload?.Groups?.[section] ?? [];
        if (!Array.isArray(groups)) {
          modelIndexReason = 'snapshot-section-invalid';
          return null;
        }
        for (const group of groups) {
          const children = group?.Children;
          if (!Array.isArray(children) || !children.length || children.length > 100) {
            modelIndexReason = !Array.isArray(children) ? 'snapshot-children-invalid' : (!children.length ? 'snapshot-children-empty' : 'snapshot-child-limit');
            return null;
          }
          for (const child of children) {
            const id = child?.State?.Id;
            const key = child?.AlertKey ?? child?.State?.AlertKey;
            if (!['string', 'number'].includes(typeof id) || !/^[1-9]\d{0,15}$/.test(String(id)) ||
              !Number.isSafeInteger(Number(id)) || typeof key !== 'string' || !key || key.length > 2048 ||
              (child?.AlertKey != null && child?.State?.AlertKey != null && child.AlertKey !== child.State.AlertKey)) {
              modelIndexReason = !['string','number'].includes(typeof id) || !/^[1-9]\d{0,15}$/.test(String(id)) || !Number.isSafeInteger(Number(id))
                ? 'snapshot-invalid-id' : (typeof key !== 'string' || !key || key.length > 2048 ? 'snapshot-invalid-alertkey' : 'snapshot-conflicting-alertkey');
              return null;
            }
          }
        }
      }
      modelIndexReason = 'ready';
      return buildModelSnapshotIndexes(payload, buildGroupKeyFromData);
    }

    function update(payload, metadata = {}) {
      currentPayload = payload;
      modelSnapshotIndexes = null;
      modelIndexReason = 'not-built';
      snapshotId += 1;
      latestSnapshotSource = sourceCode(metadata.source);
      latestSnapshotGroups = countGroups(payload);
      if (traceActive()) {
        trace.generation = snapshotId;
        trace.snapshotReceived = true; trace.snapshotApplied = true;
        trace.source = latestSnapshotSource; trace.snapshotGroups = latestSnapshotGroups;
        trace.totals.applied += 1;
        traceEvent({ event: 'snapshot-applied', source: latestSnapshotSource, snapshotReceived: true,
          snapshotApplied: true, groups: latestSnapshotGroups,
          needAckGroups: Array.isArray(payload?.Groups?.NeedAck) ? payload.Groups.NeedAck.length : 0,
          acknowledgedGroups: Array.isArray(payload?.Groups?.Acknowledged) ? payload.Groups.Acknowledged.length : 0 });
      }
      const next = new Map();
      const groups = payload?.Groups;
      if (!groups || typeof groups !== 'object') {
        traceIndexChange(next, payload, metadata.previousPayload);
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

      traceIndexChange(next, payload, metadata.previousPayload);
      groupsByType = next;
      modelSnapshotIndexes = buildCompleteModelIndexes(payload);
      if (traceActive()) traceEvent({ event: 'model-index', modelIndexAvailable: Boolean(modelSnapshotIndexes), modelIndexReason });
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
      const snapshotDistance = snapshotId - Number(cached?.snapshotId);
      const elapsedSinceMatch = Number(now()) - Number(cached?.matchedAt);
      if (
        !cached ||
        cached.section !== type ||
        !identity ||
        cached.identity !== identity ||
        !Number.isFinite(cached.agoTimestamp) ||
        !Number.isInteger(snapshotDistance) ||
        snapshotDistance < 0 ||
        snapshotDistance > MISSING_CANDIDATE_GRACE_SNAPSHOTS ||
        !Number.isFinite(elapsedSinceMatch) ||
        elapsedSinceMatch < 0 ||
        elapsedSinceMatch > MISSING_CANDIDATE_GRACE_MS ||
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
      if (traceActive()) {
        trace.totals.refreshes += 1;
        trace.summary = { domPanels: 0, identityMatches: 0, agesDisplayed: 0, identityReasons: {}, presentationReasons: {} };
      }
      const rootEntries = Array.from(getRoots() || []);
      sweepRemovedPanels(rootEntries);
      for (const entry of rootEntries) {
        const type = entry?.type;
        const root = entry?.root;
        if (!type || !root) continue;

        for (const panel of getGroupPanels(root)) {
          const node = getGroupCountNode(panel);
          if (!node) {
            if (traceActive()) traceDecision(type, panel, node, inspectResolution(type, panel), { repaintAttempted: true });
            continue;
          }
          const inspection = inspectResolution(type, panel);
          const diagnosticGrace = traceActive() ? traceGrace(type, panel) : null;
          if (traceActive()) tracePanel(panel, node);
          let record = inspection.record;
          const domChildCount = Number(getDomChildCount(panel)) || 0;
          let result = inspection.result;
          let reason = inspection.reason;
          let modelMatched = false;
          const expandedSubjectCandidate = reason === 'strong-key-mismatch' && domChildCount === 1;
          let diagnosticFallback = traceActive() ? { fallbackAttempted: false, fallbackReaderCalled: false,
            fallbackReaderReason: 'not-called', modelIndexAvailable: Boolean(modelSnapshotIndexes), modelIndexReason,
            fallbackReason: reason !== 'missing-candidate' ? 'identity-ineligible'
              : (domChildCount !== 0 ? 'dom-not-collapsed' : (currentPayload == null ? 'snapshot-unavailable' : 'not-attempted')) } : null;
          if (((reason === 'missing-candidate' && domChildCount === 0) || expandedSubjectCandidate) && currentPayload != null) {
            const generation = snapshotId, indexes = groupsByType, models = modelSnapshotIndexes, payload = currentPayload;
            const diagnosticIndexReason = modelIndexReason;
            diagnostics.modelReader(panel, 'adapter-entered');
            let resolved = null;
            try {
              resolved = (expandedSubjectCandidate ? readExpandedModelIdentity : readModelIdentity)(type, panel, node, payload);
            } catch (_) { /* Unavailable: fail closed; existing collapsed grace only. */ }
            // The current bridge is synchronous, but page code may reenter update/clear.
            if (snapshotId !== generation || groupsByType !== indexes || currentPayload !== payload || resolved?.status === 'stale') {
              traceModelFallback(type, panel, { status: 'stale' }, models, diagnosticIndexReason, generation);
              return;
            }
            if (resolved?.status === 'read') {
              const identity = resolved.identity;
              const child = identity?.children?.length === 1 ? identity.children[0] : null;
              const model = identity?.section === type && !identity.rejected && child ? models?.[type]?.get(child.id) : null;
              const candidates = model ? indexes.get(type)?.byKey.get(model.key) : null;
              const candidate = candidates?.length === 1 ? candidates[0] : null;
              let subjectOnlyDifference = !expandedSubjectCandidate;
              if (expandedSubjectCandidate && candidate && model) {
                const groups = payload?.Groups?.[type];
                const source = Array.isArray(groups) ? groups.filter(group => buildGroupKeyFromData(group) === model.key) : [];
                const domKey = buildGroupKeyFromDom(panel);
                subjectOnlyDifference = source.length === 1 && Boolean(domKey) && domKey !== model.key &&
                  buildGroupKeyFromData({ ...source[0], Subject: getGroupSubject(panel) }) === domKey;
                if (!subjectOnlyDifference) resolved.compositeMismatch = true;
                // This path repairs the missing old Subject, not a collision with
                // another current group. Preserve the existing ambiguity refusal.
                if (indexes.get(type).bySubject.has(getGroupSubject(panel))) {
                  subjectOnlyDifference = false; resolved.expandedSubjectConflict = true;
                }
              }
              if (subjectOnlyDifference && candidate?.count === 1 && model.children.length === 1 &&
                  model.children[0].id === child.id && model.children[0].key === child.key &&
                  indexes.get(type)?.bySubject.get(candidate.subject)?.length === 1) {
                record = candidate; result = 'matched';
                reason = expandedSubjectCandidate ? 'expanded-model-identity-match' : 'model-identity-match'; modelMatched = true;
              } else {
                record = null; result = 'no-match'; reason = 'model-identity-mismatch';
              }
            }
            diagnosticFallback = traceModelFallback(type, panel, resolved, models, diagnosticIndexReason, generation);
          }
          if (domChildCount > 0 && record?.count !== domChildCount) {
            record = null;
            result = 'no-match';
            reason = 'dom-child-count-mismatch';
          }
          let age = record?.count === 1 ? formatAge(record.agoTimestamp) || '' : '';
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
          let decision = modelMatched ? 'use-model-match' : 'use-live-match';
          if (validLiveMapping) {
            age = formatAge(record.agoTimestamp) || '';
            lastValidByPanel.set(panel, {
              section: type,
              identity,
              agoTimestamp: record.agoTimestamp,
              snapshotGroupKey: record.groupKey || null,
              strongDomKey: hasStrongDomIdentity(panel) ? buildGroupKeyFromDom(panel) : null,
              snapshotId,
              matchedAt: Number(now())
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

          const restoreRequested = record?.count !== 1 || !age;
          const restoreApplied = restoreRequested && node.dataset.bosunSingleAlertAge === 'true';
          if (restoreRequested) {
            restoreCount(node, record || (domChildCount > 1 ? { section: type, count: domChildCount } : null));
          } else {
            if (node.dataset.bosunSingleAlertAge !== 'true') {
              node.dataset.bosunOriginalAlertCount = node.textContent || '1 alerts';
            }
            node.dataset.bosunSingleAlertAge = 'true';
            setExpectedText(node, age);
            node.dataset.bosunSingleAlertAgeDecision = decision;
          }
          if (traceActive()) traceDecision(type, panel, node, inspection, {
            fallback: diagnosticFallback,
            ageSource: restoreRequested ? 'count' : (decision === 'preserve-last-valid-match' ? 'preserved-snapshot-child'
              : 'snapshot-child'),
            modelRecord: modelMatched ? record : null, modelIdentityMatched: modelMatched,
            grace: diagnosticGrace,
            repaintAttempted: true, restoreCountCalled: restoreRequested, restoreCountApplied: restoreApplied,
            presentationReason: decision === 'preserve-last-valid-match' ? 'preserved-mapping'
              : (reason === 'dom-child-count-mismatch' || reason === 'age-unavailable' ? reason
                : (restoreRequested ? 'restore-count' : (modelMatched ? reason : 'matched')))
          });
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
            const age = record?.count === 1 ? formatAge(record.agoTimestamp) || '' : '';
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
      modelSnapshotIndexes = null;
      currentPayload = null;
      modelIndexReason = 'not-built';
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
      getHistoryStats,
      diagnostics
    };
  }

  globalThis.BosunHelperSingleAlertAge = {
    SINGLE_ALERT_AGE_DEBUG,
    SINGLE_ALERT_AGE_DEBUG_MAX_PROBLEMS,
    MISSING_CANDIDATE_GRACE_SNAPSHOTS,
    MISSING_CANDIDATE_GRACE_MS,
    createSingleAlertAge
  };
})();
