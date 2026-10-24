(() => {
  'use strict';

  function createSnapshotState({ Map, Set }) {
    const state = {
      priorityRuleIdentityIndex: null,
      alertsPayloadApplyVersion: 0,
      alertDataIndexReady: false,
      alertMarkerIndexGeneration: 0,
      latestAlertsPayload: null,
      modelGroupSnapshotIndexes: null,
      latestAlertsTrackerOwner: false,
      acknowledgedPriorityIndex: null
    };
    // Коллекции сохраняют const-привязки; rebuild/restore изменяют только их содержимое.
    Object.defineProperties(state, {
      childOldNoNoteById: { value: new Map(), enumerable: true },
      childOldNoNoteByKey: { value: new Map(), enumerable: true },
      childHasNoteById: { value: new Map(), enumerable: true },
      childHasNoteByKey: { value: new Map(), enumerable: true },
      childHasUserCommentById: { value: new Map(), enumerable: true },
      childHasUserCommentByKey: { value: new Map(), enumerable: true },
      childPriorityById: { value: new Map(), enumerable: true },
      childPriorityByKey: { value: new Map(), enumerable: true },
      ambiguousChildIds: { value: new Set(), enumerable: true },
      ambiguousChildKeys: { value: new Set(), enumerable: true },
      groupHasOldNoNoteByKey: { value: new Map(), enumerable: true },
      groupHasAnyNoteByKey: { value: new Map(), enumerable: true },
      groupHasPriorityByKey: { value: new Map(), enumerable: true },
      groupHasAnyUserCommentByKey: { value: new Map(), enumerable: true },
      groupHasOldNoNoteBySubject: { value: new Map(), enumerable: true },
      groupHasAnyNoteBySubject: { value: new Map(), enumerable: true },
      groupHasPriorityBySubject: { value: new Map(), enumerable: true },
      groupHasAnyUserCommentBySubject: { value: new Map(), enumerable: true },
      groupHasStrongIdentityBySubject: { value: new Map(), enumerable: true },
      groupCountBySubject: { value: new Map(), enumerable: true },
      grafanaQueryById: { value: new Map(), enumerable: true },
      grafanaQueryByKey: { value: new Map(), enumerable: true },
      ambiguousGrafanaIds: { value: new Set(), enumerable: true },
      ambiguousGrafanaKeys: { value: new Set(), enumerable: true }
    });
    return state;
  }

  function getAlertMarkerCacheMaps(state) {
    return {
      childOldNoNoteById: state.childOldNoNoteById,
      childOldNoNoteByKey: state.childOldNoNoteByKey,
      childHasNoteById: state.childHasNoteById,
      childHasNoteByKey: state.childHasNoteByKey,
      childHasUserCommentById: state.childHasUserCommentById,
      childHasUserCommentByKey: state.childHasUserCommentByKey,
      groupHasOldNoNoteByKey: state.groupHasOldNoNoteByKey,
      groupHasAnyNoteByKey: state.groupHasAnyNoteByKey,
      groupHasAnyUserCommentByKey: state.groupHasAnyUserCommentByKey,
      groupHasOldNoNoteBySubject: state.groupHasOldNoNoteBySubject,
      groupHasAnyNoteBySubject: state.groupHasAnyNoteBySubject,
      groupHasAnyUserCommentBySubject: state.groupHasAnyUserCommentBySubject,
      groupHasStrongIdentityBySubject: state.groupHasStrongIdentityBySubject,
      groupCountBySubject: state.groupCountBySubject
    };
  }

  globalThis.BosunHelperSnapshotState = Object.freeze({ createSnapshotState, getAlertMarkerCacheMaps });
})();
