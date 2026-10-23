'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function instrumentContentSource(source) {
  const closing = source.lastIndexOf('})();');
  assert.ok(closing > 0, 'Unable to instrument content.js for browser assertions');
  return `${source.slice(0, closing)}
  let browserTestScheduledDomRefreshes = 0;
  let browserTestScheduledDataRefreshes = 0;
  const browserTestOriginalScheduleRefresh = scheduleRefresh;
  const browserTestOriginalScheduleAlertsDataRefresh = scheduleAlertsDataRefresh;
  scheduleRefresh = (...args) => {
    browserTestScheduledDomRefreshes += 1;
    return browserTestOriginalScheduleRefresh(...args);
  };
  scheduleAlertsDataRefresh = (...args) => {
    browserTestScheduledDataRefreshes += 1;
    return browserTestOriginalScheduleAlertsDataRefresh(...args);
  };
  globalThis.__BosunHelperBrowserTest = {
    ensureStateIcon,
    ensureParentStateIcon,
    injectStyles,
    ensureToggleExists,
    setToolbarStatus,
    clearToolbarStatus,
    updateToolbarStatus,
    scheduleTopBarMount,
    disconnectTopBarMountObserver,
    destroySettingsUi: () => settingsUi?.destroy?.(),
    ensureAutoRefreshControls,
    ensureLastActionCopyButtons,
    ensureGrafanaQueryButtons,
    ensurePriorityActions,
    async startPriorityActionSettings() {
      await settingsStore.start();
      installStorageChangeTracking();
      applySettingsSnapshot(settingsStore.getSnapshot(), { initial: true });
      return settingsStore;
    },
    runDomRefreshPass,
    getLastActionMessageText,
    applyAlertsPayload,
    startupState: () => ({ version: alertsPayloadApplyVersion, ready: alertDataIndexReady,
      owner: latestAlertsTrackerOwner, role: refreshCoordinatorApi?.getRole?.() }),
    applySettingsSnapshot,
    rebuildAlertDataIndex,
    resolveChildState,
    resolveGroupState,
    resolveChildIndexedState,
    applyNeedsAckMarkersFromData,
    buildGroupMarkerKeyFromDom,
    buildGroupMarkerKeyFromData,
    resolveChildHasUserComment,
    rebuildGrafanaQueryIndex,
    refreshRuleGraphDefinitions,
    ruleGraphResolver,
    getGrafanaQueryForPanel,
    flashCopyButtonState,
    handleRouteChange,
    installSelectionCopySanitizer,
    startObserver,
    setExtensionClass,
    isFeatureEnabled,
    setFeature(name, enabled) {
      const previous = JSON.parse(JSON.stringify(settingsSnapshot));
      const next = JSON.parse(JSON.stringify(settingsSnapshot));
      next.features[name] = Boolean(enabled);
      applySettingsSnapshot(next, {
        previous,
        changedPaths: ['features.' + name],
        initial: false
      });
    },
    setPreference(name, value) {
      const previous = JSON.parse(JSON.stringify(settingsSnapshot));
      const next = JSON.parse(JSON.stringify(settingsSnapshot));
      next.preferences ||= {};
      next.preferences[name] = value;
      applySettingsSnapshot(next, {
        previous,
        changedPaths: ['preferences.' + name],
        initial: false
      });
    },
    handleSoundAlertsToggle,
    applyActionPageTweaks,
    loadState,
    runtimeSettings() {
      return {
        soundAlertsEnabled,
        showSilenced,
        autoRefreshEnabled,
        autoRefreshIdleSeconds,
        userCommentFilterEnabled,
        acknowledgedCollapseEnabled,
        toolbarStatusSource,
        toolbarStatusMessage,
        toolbarStatusTimer
      };
    },
    singleAlertAge: singleAlertAgeApi,
    refreshIntervals: { visible: DATA_REFRESH_MS, hidden: DATA_REFRESH_HIDDEN_MS },
    resetLifecycleCounters() {
      browserTestScheduledDomRefreshes = 0;
      browserTestScheduledDataRefreshes = 0;
    },
    getLifecycleCounters() {
      return {
        domRefreshes: browserTestScheduledDomRefreshes,
        dataRefreshes: browserTestScheduledDataRefreshes
      };
    },
    seedMarkerCache(id, state) {
      for (const map of Object.values(getAlertMarkerCacheMaps())) map.clear();
      if (state === 'note') childHasNoteById.set(id, true);
      if (state === 'warning') childOldNoNoteById.set(id, true);
      alertDataIndexReady = true;
      flushAlertMarkerCacheToSession();
    },
    clearMarkerState() {
      for (const map of Object.values(getAlertMarkerCacheMaps())) map.clear();
      alertDataIndexReady = false;
    },
    scheduleMarkerCache: persistAlertMarkerCacheToSession,
    markerCacheMaps: getAlertMarkerCacheMaps,
    restoreMarkerCache() {
      const restored = restoreAlertMarkerCacheFromSession();
      return {
        restored,
        note: childHasNoteById.get('cached-alert') === true,
        warning: childOldNoNoteById.get('cached-alert') === true
      };
    },
    markerState() {
      return {
        ready: alertDataIndexReady,
        note: childHasNoteById.get('cached-alert') === true
      };
    },
    setNewAlertNoticeCounts(counts) {
      newAlertNoticeCounts = counts;
      ensureNewAlertNotice();
    }
  };
${source.slice(closing)}`;
}

function createScriptLoader(root) {
  function readTestScript(file) {
    return fs.readFileSync(path.join(root, file), 'utf8');
  }
  return {
    readTestScript,
    instrumentContentSource(source) {
      return `${readTestScript('src/bosun/alert-marker-cache.js')}\n${readTestScript('src/bosun/toolbar-status.js')}\n${readTestScript('src/bosun/toolbar.js')}\n${readTestScript('src/bosun/copy.js')}\n${readTestScript('src/bosun/last-action.js')}\n${instrumentContentSource(source)}`;
    }
  };
}

module.exports = { createScriptLoader };
