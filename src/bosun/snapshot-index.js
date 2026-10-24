(() => {
  'use strict';

  function rebuildAlertDataIndex(payload, options, {
    snapshotState, priorityApi, alertsDataApi, groupIdentityApi, needAckSeverityApi, sharedUtils,
    buildChildMarkerKeyFromData, buildGroupMarkerKeyFromData, hasStrongChildMarkerIdentityFromData,
    isFeatureEnabled, getSettingsSnapshot, rebuildGrafanaQueryIndex, Map, Set
  }) {
    const {
      childOldNoNoteById, childOldNoNoteByKey, childHasNoteById,
      childHasNoteByKey, childHasUserCommentById, childHasUserCommentByKey,
      childPriorityById, childPriorityByKey, ambiguousChildIds,
      ambiguousChildKeys, groupHasOldNoNoteByKey, groupHasAnyNoteByKey,
      groupHasPriorityByKey, groupHasAnyUserCommentByKey, groupHasOldNoNoteBySubject,
      groupHasAnyNoteBySubject, groupHasPriorityBySubject, groupHasAnyUserCommentBySubject,
      groupHasStrongIdentityBySubject, groupCountBySubject
    } = snapshotState;
    snapshotState.priorityRuleIdentityIndex = priorityApi?.buildRuleIdentityIndex?.(payload) || null;
    const helpers = {
      buildChildMarkerKeyFromData,
      buildGroupMarkerKeyFromData,
      hasStrongChildMarkerIdentityFromData,
      classifyPriorityChild: (child, group) => priorityApi?.classify?.({
        identity: 'resolved',
        alertName: priorityApi.getRuleAlertName(child),
        severity: needAckSeverityApi?.getNeedAckSeverityBucket?.(child, group) || 'unknown'
      }, getSettingsSnapshot())?.priority === true,
      normalizeNeedAckChildren: (raw) => {
        if (sharedUtils?.normalizeNeedAckChildren) {
          return sharedUtils.normalizeNeedAckChildren(raw);
        }
        if (raw == null) return [];
        return Array.isArray(raw) ? raw : [raw];
      }
    };
    const nextIndex = alertsDataApi?.rebuildAlertDataIndex?.(payload, helpers) || {
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
    childOldNoNoteById.clear();
    childOldNoNoteByKey.clear();
    childHasNoteById.clear();
    childHasNoteByKey.clear();
    childHasUserCommentById.clear();
    childHasUserCommentByKey.clear();
    childPriorityById.clear();
    childPriorityByKey.clear();
    ambiguousChildIds.clear();
    ambiguousChildKeys.clear();
    groupHasOldNoNoteByKey.clear();
    groupHasAnyNoteByKey.clear();
    groupHasPriorityByKey.clear();
    groupHasAnyUserCommentByKey.clear();
    groupHasOldNoNoteBySubject.clear();
    groupHasAnyNoteBySubject.clear();
    groupHasPriorityBySubject.clear();
    groupHasAnyUserCommentBySubject.clear();
    groupHasStrongIdentityBySubject.clear();
    groupCountBySubject.clear();
    for (const [key, value] of nextIndex.childOldNoNoteById) childOldNoNoteById.set(key, value);
    for (const [key, value] of nextIndex.childOldNoNoteByKey) childOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteById) childHasNoteById.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteByKey) childHasNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasUserCommentById || []) childHasUserCommentById.set(key, value);
    for (const [key, value] of nextIndex.childHasUserCommentByKey || []) childHasUserCommentByKey.set(key, value);
    for (const [key, value] of nextIndex.childPriorityById || []) childPriorityById.set(key, value);
    for (const [key, value] of nextIndex.childPriorityByKey || []) childPriorityByKey.set(key, value);
    for (const key of nextIndex.ambiguousChildIds || []) ambiguousChildIds.add(key);
    for (const key of nextIndex.ambiguousChildKeys || []) ambiguousChildKeys.add(key);
    for (const [key, value] of nextIndex.groupHasOldNoNoteByKey) groupHasOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteByKey) groupHasAnyNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasPriorityByKey || []) groupHasPriorityByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyUserCommentByKey || []) groupHasAnyUserCommentByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteBySubject) groupHasOldNoNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteBySubject) groupHasAnyNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasPriorityBySubject || []) groupHasPriorityBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyUserCommentBySubject || []) groupHasAnyUserCommentBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasStrongIdentityBySubject || []) {
      groupHasStrongIdentityBySubject.set(key, value);
    }
    for (const [key, value] of nextIndex.groupCountBySubject || []) groupCountBySubject.set(key, value);
    snapshotState.acknowledgedPriorityIndex = isFeatureEnabled('priorityAlerts')
      ? alertsDataApi?.rebuildAlertDataIndex?.(payload, helpers, 'Acknowledged') || null
      : null;
    snapshotState.alertDataIndexReady = true;
    snapshotState.alertMarkerIndexGeneration += 1;
    snapshotState.modelGroupSnapshotIndexes = groupIdentityApi?.buildSnapshotIndexes(payload, buildGroupMarkerKeyFromData) || null;
    if (!options.skipGrafanaQueryIndex) rebuildGrafanaQueryIndex(payload);
  }

  globalThis.BosunHelperSnapshotIndex = Object.freeze({ rebuildAlertDataIndex });
})();
