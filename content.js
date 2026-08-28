(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const AUTO_REFRESH_ENABLED_KEY = 'bosunAutoRefreshEnabled';
  const AUTO_REFRESH_IDLE_SECONDS_KEY = 'bosunAutoRefreshIdleSeconds';
  const USER_COMMENT_FILTER_ENABLED_KEY = 'bosunNoUserCommentFilterEnabled';
  const ACKNOWLEDGED_COLLAPSE_ENABLED_KEY = 'bosunAcknowledgedCollapseEnabled';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const USER_COMMENT_FILTER_HIDDEN_CLASS = 'bosun-user-comment-hidden';
  const ACKNOWLEDGED_COLLAPSED_CLASS = 'bosun-acknowledged-collapsed';
  const TOP_BAR_ID = 'bosun-top-controls-bar';
  const TOP_BAR_STATUS_ID = 'bosun-top-controls-status';
  const NEW_ALERT_NOTICE_ID = 'bosun-new-alerts-notice';
  const NEW_ALERT_TRACKER_STORAGE_KEY = 'bosunNewAlertsAwaitingNoteV1';
  const TOGGLE_ID = 'bosun-silence-toggle';
  const TOGGLE_COUNTER_ID = 'bosun-silence-toggle-counter';
  const AUTO_REFRESH_TOGGLE_ID = 'bosun-auto-refresh-toggle';
  const AUTO_REFRESH_INPUT_ID = 'bosun-auto-refresh-idle-seconds';
  const AUTO_REFRESH_COUNTDOWN_ID = 'bosun-auto-refresh-countdown';
  const USER_COMMENT_FILTER_TOGGLE_ID = 'bosun-user-comment-filter-toggle';
  const ACKNOWLEDGED_COLLAPSE_TOGGLE_ID = 'bosun-acknowledged-collapse-toggle';
  const SOUND_ALERTS_ENABLED_KEY = 'bosunSoundAlertsEnabled';
  const SOUND_ALERTS_TOGGLE_ID = 'bosun-sound-alerts-toggle';
  const DIAGNOSTICS_ENABLED_KEY = 'bosunDiagnosticsEnabled';
  const DIAGNOSTICS_TOGGLE_ID = 'bosun-diagnostics-toggle';
  const DIAGNOSTICS_OPEN_BUTTON_ID = 'bosun-diagnostics-open-button';
  const DIAGNOSTICS_MODAL_ID = 'bosun-diagnostics-modal';
  const DIAGNOSTICS_LOG_LIST_ID = 'bosun-diagnostics-log-list';

  const DIAGNOSTICS_LOG_STORAGE_KEY = 'bosunDiagnosticsLogV1';
  const NEED_ACK_SOUND_BASELINE_SESSION_KEY = 'bosunNeedAckSoundBaselineV1';
  const ALERT_MARKER_CACHE_SESSION_KEY = 'bosunAlertMarkerCacheV1';
  const ALERT_MARKER_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  const ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP = 2000;
  const ALERT_MARKER_CACHE_PERSIST_DELAY_MS = 5000;
  const ALERT_MARKER_CACHE_MIN_PERSIST_INTERVAL_MS = 30000;
  const ALERT_MARKER_CACHE_MAX_UNCHANGED_AGE_MS = 5 * 60 * 1000;
  const ALERT_MARKER_CACHE_MAX_RAW_LENGTH = 5 * 1024 * 1024;
  const ALERT_MARKER_CACHE_MAX_KEY_LENGTH = 1000;
  const SOUND_FILE_ALERT = 'bosun_notification_alert_chime.wav';
  const SOUND_FILE_SOFT = 'bosun_notification_soft_chime.wav';
  const COPY_BUTTON_CLASS = 'bosun-copy-alert-btn';
  const COPY_ALL_BUTTON_CLASS = 'bosun-copy-all-alerts-btn';
  const COPY_LAST_ACTION_BUTTON_CLASS = 'bosun-copy-last-action-btn';
  const LAST_ACTION_LINK_CLASS = 'bosun-last-action-link';
  const LAST_ACTION_TIME_TEXT_CLASS = 'bosun-last-action-time-text';
  const LAST_ACTION_MESSAGE_SELECTOR =
    '[ng-show="state.LastAction.Message"], [ng-bind="state.LastAction.Message"]';
  const GRAFANA_QUERY_BUTTON_CLASS = 'bosun-grafana-query-btn';
  const NO_SELECT_CLASS = 'bosun-no-select';
  const SILENCED_BADGE_CLASS = 'bosun-silenced-badge';
  const DEFAULT_EXTENSION_CONFIG = {
    bosunHosts: ['bosun.example.com', 'bosun-test.example.com'],
    grafanaHost: 'grafana.example.com',
    grafanaPanelUrl: 'https://grafana.example.com/d/example/example?orgId=1&from=now-1h&to=now&timezone=browser&editPanel=1'
  };

  function normalizeExtensionConfig(rawConfig) {
    const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const normalizeHost = (value) => {
      const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return /^[a-z0-9.-]+(?::\d+)?$/.test(host) ? host : '';
    };
    const configuredBosunHosts = Array.isArray(raw.bosunHosts)
      ? raw.bosunHosts.map(normalizeHost).filter(Boolean)
      : [];
    const bosunHosts = configuredBosunHosts.length
      ? Array.from(new Set(configuredBosunHosts))
      : DEFAULT_EXTENSION_CONFIG.bosunHosts;
    const grafanaHost = normalizeHost(raw.grafanaHost) || DEFAULT_EXTENSION_CONFIG.grafanaHost;

    let grafanaPanelUrl = '';
    try {
      const candidate = new URL(String(raw.grafanaPanelUrl || ''));
      if (candidate.protocol === 'https:' && candidate.host.toLowerCase() === grafanaHost) {
        grafanaPanelUrl = candidate.toString();
      }
    } catch (_) {}

    return Object.freeze({
      bosunHosts: Object.freeze(bosunHosts),
      grafanaHost,
      grafanaPanelUrl
    });
  }

  const extensionConfig = normalizeExtensionConfig(globalThis.BosunHelperLocalConfig);

  /**
   * Показывать ли в тулбаре блок «Диагностика» (чекбокс, кнопки «Открыть лог» / модалка журнала).
   * Сейчас выключено: в обычной работе UI отладки не нужен.
   *
   * Как включить снова:
   * — поставьте значение true ниже;
   * — перезагрузите расширение в chrome://extensions (кнопка «Обновить» у пакета).
   *
   * Запись в chrome.storage и внутренний diagnosticsApi при этом остаются; при скрытом UI
   * переключатель недоступен, но флаг из storage всё ещё читается при старте.
   */
  const DIAGNOSTICS_TOOLBAR_UI_ENABLED = false;

  let bosunSelectionDragState = null;

  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const HAS_NOTE_ICON_CLASS = 'bosun-has-note-icon';

  const DATA_REFRESH_MS = 4000;
  const DATA_REFRESH_HIDDEN_MS = 10000;
  const DATA_REFRESH_DEBOUNCE_MS = 250;
  const STATUS_MESSAGE_TTL_MS = 8000;
  const OLD_NO_NOTE_MINUTES = 0;
  const AUTO_REFRESH_DEFAULT_IDLE_SECONDS = 60;
  const AUTO_REFRESH_MIN_IDLE_SECONDS = 10;
  const AUTO_REFRESH_MAX_IDLE_SECONDS = 3600;
  const AUTO_REFRESH_FORCE_REENABLE_MS = 0;
  const CHECKBOX_IMPROVEMENTS_DISABLED_BODY_CLASS = 'bosun-checkbox-improvements-disabled';

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let syncScopedDomObservers = () => {};
  let hiddenCount = 0;

  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;
  let dataRefreshQueued = false;
  let dataRefreshDebounceTimer = null;
  let alertMarkerCachePersistTimer = null;
  let lastAlertMarkerCacheSerializedMaps = '';
  let lastAlertMarkerCachePersistAttemptAt = 0;
  let lastAlertMarkerCacheSavedAt = 0;
  let dataVisibilityTrackingInstalled = false;
  let primedAlertsPayload = null;
  let alertsPayloadApplyVersion = 0;
  let autoRefreshEnabled = true;
  let autoRefreshIdleSeconds = AUTO_REFRESH_DEFAULT_IDLE_SECONDS;
  let lastUserActivityTs = Date.now();
  let lastKnownUrl = window.location.href;
  let topBarMountObserver = null;
  let userCommentFilterEnabled = false;
  let acknowledgedCollapseEnabled = false;
  let soundAlertsEnabled = true;
  let diagnosticsEnabled = false;
  const settingsApi = globalThis.BosunHelperSettings || null;
  const settingsStore = settingsApi?.createSettingsStore?.({
    storage: globalThis.chrome?.storage?.local || null,
    storageChanges: globalThis.chrome?.storage?.onChanged || null,
    getLastError: () => globalThis.chrome?.runtime?.lastError || null,
    warn: (message, error) => console.warn(`[Bosun plugin] ${message}`, error || '')
  }) || null;
  let settingsSnapshot = settingsApi?.DEFAULTS
    ? JSON.parse(JSON.stringify(settingsApi.DEFAULTS))
    : {
        schemaVersion: 1,
        features: {
          singleAlertAge: true,
          checkboxImprovements: true,
          copyButtons: true,
          lastActionEnhancements: true,
          silencedFilter: true,
          noCommentFilter: true,
          acknowledgedCollapse: true,
          soundNotifications: true,
          visualNewAlertNotifications: true,
          autoRefresh: true,
          actionTemplates: true,
          grafanaIntegration: true
        }
      };
  const settingsUi = globalThis.BosunHelperSettingsUi?.createSettingsUi?.({
    settingsStore,
    schema: settingsApi?.SCHEMA || [],
    toolbarId: TOP_BAR_ID,
    reportStatus: (message, level = 'info', title = '') => {
      setToolbarStatus('settings-ui', message, level, { title });
    }
  }) || null;
  let toolbarStatusSource = '';
  let toolbarStatusLevel = '';
  let toolbarStatusMessage = '';
  let toolbarStatusTitle = '';
  let toolbarStatusTimer = null;
  let alertDataIndexReady = false;
  let newAlertNoticeCounts = { warning: 0, critical: 0, unknown: 0 };
  let newAlertTrackerMutationAllowed = true;
  let latestAlertsPayload = null;
  let visualTrackerLifecycleGeneration = 0;
  let ruleGraphLifecycleGeneration = 0;
  const DIAGNOSTICS_LOG_MAX_ENTRIES = 750;

  // child maps
  const childOldNoNoteById = new Map();
  const childOldNoNoteByKey = new Map();
  const childHasNoteById = new Map();
  const childHasNoteByKey = new Map();
  const childHasUserCommentById = new Map();
  const childHasUserCommentByKey = new Map();

  // group maps
  const groupHasOldNoNoteByKey = new Map();
  const groupHasAnyNoteByKey = new Map();
  const groupHasAnyUserCommentByKey = new Map();
  const groupHasOldNoNoteBySubject = new Map();
  const groupHasAnyNoteBySubject = new Map();
  const groupHasAnyUserCommentBySubject = new Map();
  const groupCountBySubject = new Map();
  const grafanaQueryById = new Map();
  const grafanaQueryByKey = new Map();
  const ambiguousGrafanaIds = new Set();
  const ambiguousGrafanaKeys = new Set();
  const expectedExtensionClassStates = new WeakMap();
  const expectedExtensionClassNodes = new Set();
  const sharedUtils = globalThis.BosunSilenceHiderSharedUtils || null;
  const promqlApi = globalThis.BosunHelperPromQL || null;
  const ruleGraphApi = globalThis.BosunHelperRuleGraph || null;
  const ruleGraphResolver = ruleGraphApi?.createRuleGraphResolver?.({
    onInvalidate: () => handleRuleGraphInvalidation()
  }) || null;
  const diagnosticsApi = globalThis.BosunSilenceHiderDiagnostics?.createDiagnostics?.({
    modalId: DIAGNOSTICS_MODAL_ID,
    logListId: DIAGNOSTICS_LOG_LIST_ID,
    logStorageKey: DIAGNOSTICS_LOG_STORAGE_KEY,
    maxEntries: DIAGNOSTICS_LOG_MAX_ENTRIES,
    getEnabled: () => diagnosticsEnabled
  }) || null;
  const soundApi = globalThis.BosunSilenceHiderSound?.createSound?.({
    alertFile: SOUND_FILE_ALERT,
    softFile: SOUND_FILE_SOFT,
    getEnabled: () => isFeatureEnabled('soundNotifications') && soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    crossTabStorageKey: 'bosunNeedAckSoundClaimV1'
  }) || null;
  const alertsDataApi = globalThis.BosunSilenceHiderAlertsData?.createAlertsData?.({
    oldNoNoteMinutes: OLD_NO_NOTE_MINUTES
  }) || null;
  const needAckSeverityApi = globalThis.BosunSilenceHiderNeedAckSeverity?.createNeedAckSeverity?.({
    normalizeNeedAckChildren: (raw) => {
      if (sharedUtils?.normalizeNeedAckChildren) {
        return sharedUtils.normalizeNeedAckChildren(raw);
      }
      if (raw == null) return [];
      if (Array.isArray(raw)) return raw;
      return [raw];
    }
  }) || null;
  const newAlertTrackerApi = globalThis.BosunHelperNewAlertTracker?.createNewAlertTracker?.({
    storageKey: `${NEW_ALERT_TRACKER_STORAGE_KEY}:${window.location.origin}`,
    getStorage: () => getChromeLocalStorage(),
    getLastError: () => getChromeStorageLastError(),
    collectCurrentIdsAndSeverity: (payload) =>
      needAckSeverityApi?.collectCurrentIdsAndSeverity?.(payload) ?? {
        currentIds: new Set(),
        idToSeverity: new Map()
      },
    normalizeChildren: (raw) => {
      if (sharedUtils?.normalizeNeedAckChildren) return sharedUtils.normalizeNeedAckChildren(raw);
      if (raw == null) return [];
      return Array.isArray(raw) ? raw : [raw];
    },
    getChildStableKey: (child, group) => needAckSeverityApi?.needAckStableKey?.(child, group) || null,
    getGroupStableKey: (group) => needAckSeverityApi?.needAckGroupStableKey?.(group) || null,
    hasNoteFromActions: (actions) => alertsDataApi?.hasNoteFromActions?.(actions) === true,
    onChange: ({ counts }) => {
      newAlertNoticeCounts = counts;
      if (isFeatureEnabled('visualNewAlertNotifications')) updateNewAlertNotice();
    },
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details)
  }) || null;
  const needAckBaselineApi = globalThis.BosunSilenceHiderNeedAckBaseline?.createNeedAckBaseline?.({
    sessionKey: NEED_ACK_SOUND_BASELINE_SESSION_KEY,
    isSoundEnabled: () => isFeatureEnabled('soundNotifications') && soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    playNeedAckChime: (kind) => soundApi?.playNeedAckChime?.(kind),
    onNewAlerts: ({ newIds, idToSeverity }) => {
      if (newAlertTrackerMutationAllowed && isFeatureEnabled('visualNewAlertNotifications')) {
        newAlertTrackerApi?.add?.(newIds, idToSeverity);
      }
    },
    collectCurrentIdsAndSeverity: (payload) =>
      needAckSeverityApi?.collectCurrentIdsAndSeverity?.(payload) ?? {
        currentIds: new Set(),
        idToSeverity: new Map()
      }
  }) || null;
  const refreshCoordinatorApi = globalThis.BosunHelperRefreshCoordinator?.createRefreshCoordinator?.({
    fetchSnapshot: (options) => consumeAlertsPayload(options),
    applySnapshot: (payload, metadata) => applyAlertsPayload(payload, metadata),
    isVisible: () => document.visibilityState !== 'hidden',
    shouldRun: () => isDashboardEnhancementsPage(),
    reportDiagnostics: (eventName, details = '') => {
      reportDiagnostics(eventName, details);
      if (eventName === 'refresh-coordinator-fetch-failed') {
        setToolbarStatus('refresh', 'Не удалось синхронизировать алерты', 'error', {
          title: details,
          ttlMs: 12000
        });
      }
    },
    visiblePollMs: DATA_REFRESH_MS,
    hiddenPollMs: DATA_REFRESH_HIDDEN_MS
  }) || null;

  if (
    isConfiguredBosunHost() &&
    (!soundApi || !needAckBaselineApi || !needAckSeverityApi || !alertsDataApi || !newAlertTrackerApi)
  ) {
    console.warn(
      '[Bosun plugin] One or more extension modules failed to load; sound, NeedAck baseline, severity, or alerts index may be disabled.',
      {
        soundApi: Boolean(soundApi),
        needAckBaselineApi: Boolean(needAckBaselineApi),
        needAckSeverityApi: Boolean(needAckSeverityApi),
        alertsDataApi: Boolean(alertsDataApi),
        newAlertTrackerApi: Boolean(newAlertTrackerApi)
      }
    );
  }

  const pageUtils = globalThis.BosunSilenceHiderPageUtils?.createPageUtils?.() || null;
  const stylesApi = globalThis.BosunSilenceHiderStyles || null;
  const singleAlertAgeApi = globalThis.BosunHelperSingleAlertAge?.createSingleAlertAge?.({
    normalizeChildren: (raw) => {
      if (sharedUtils?.normalizeNeedAckChildren) return sharedUtils.normalizeNeedAckChildren(raw);
      if (raw == null) return [];
      return Array.isArray(raw) ? raw : [raw];
    },
    buildGroupKeyFromData: buildGroupMarkerKeyFromData,
    buildGroupKeyFromDom: buildGroupMarkerKeyFromDom,
    getRoots: () => [
      { type: 'NeedAck', root: getNeedsAckRoot() },
      { type: 'Acknowledged', root: getAcknowledgedRoot() }
    ],
    getGroupPanels: (root) => Array.from(root.querySelectorAll('.panel-group > .panel'))
      .filter((panel) => isGroupPanel(panel)),
    getGroupSubject: (panel) => getGroupSubjectFromPanel(panel),
    getGroupCountNode: (panel) => getGroupCountNode(panel),
    getRenderedChildAge: (panel) => panel
      ?.querySelector('[ng-repeat="child in group.Children"] [ts-since="child.Ago"]')
      ?.textContent,
    getDomChildCount: (panel) => getGroupChildPanels(panel).length,
    hasStrongDomIdentity: (panel) => {
      const children = getGroupChildPanels(panel);
      return children.length > 0 && children.every((child) => Boolean(getPanelIdFromHeading(getChildHeading(child))));
    }
  }) || null;
  const actionTemplatesApi = globalThis.BosunHelperActionTemplates?.createActionTemplates?.({
    isActionPage: () => isActionPage(),
    settingsStore
  }) || null;
  const grafanaHandoffApi = globalThis.BosunHelperGrafanaHandoff?.createGrafanaHandoff?.({
    config: extensionConfig,
    getStorage: () => getChromeLocalStorage(),
    getLastError: () => getChromeStorageLastError(),
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    showFeedback: (button, message, ok) => flashButtonState(button, message, ok)
  }) || null;
  const activityApi = globalThis.BosunSilenceHiderActivity?.createActivityTracker?.({
    pageUtils: pageUtils || {
      isDashboardHome: () => window.location.pathname === '/',
      isActionPage: () => window.location.pathname === '/action'
    },
    getAutoRefreshEnabled: () => isFeatureEnabled('autoRefresh') && autoRefreshEnabled,
    setAutoRefreshEnabled: (value) => { autoRefreshEnabled = Boolean(value); },
    getAutoRefreshIdleSeconds: () => autoRefreshIdleSeconds,
    getLastUserActivityTs: () => lastUserActivityTs,
    setLastUserActivityTs: (value) => { lastUserActivityTs = value; },
    getLastKnownUrl: () => lastKnownUrl,
    setLastKnownUrl: (value) => { lastKnownUrl = value; },
    onActivity: () => updateAutoRefreshCountdown(),
    onUrlChanged: () => {
      resetNeedAckSoundBaseline();
      handleRouteChange();
    },
    saveAutoRefreshState: () => saveAutoRefreshState(),
    updateAutoRefreshControls: () => updateAutoRefreshControls(),
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    autoRefreshForceReenableMs: AUTO_REFRESH_FORCE_REENABLE_MS
  }) || null;

  function setExtensionClass(element, className, enabled) {
    if (!element?.classList || typeof className !== 'string' || !className) return;
    const expected = Boolean(enabled);
    if (element.classList.contains(className) === expected) return;
    let states = expectedExtensionClassStates.get(element);
    if (!states) {
      states = new Map();
      expectedExtensionClassStates.set(element, states);
    }
    states.set(className, expected);
    expectedExtensionClassNodes.add(element);
    element.classList.toggle(className, expected);
  }

  function isActionPage() {
    return pageUtils?.isActionPage?.() ?? (window.location.pathname === '/action' && window.location.search.includes('type='));
  }

  function isConfiguredBosunHost() {
    return Array.isArray(extensionConfig.bosunHosts) &&
      extensionConfig.bosunHosts.includes(window.location.host);
  }

  function isDashboardHome() {
    return pageUtils?.isDashboardHome?.() ?? window.location.pathname === '/';
  }

  function isFeatureEnabled(name) {
    return settingsSnapshot?.features?.[name] !== false;
  }

  function applyActionPageTweaks() {
    if (!isFeatureEnabled('checkboxImprovements')) return;
    if (pageUtils?.applyActionPageTweaks) {
      pageUtils.applyActionPageTweaks();
      return;
    }
  }

  function injectStyles() {
    if (!stylesApi?.injectStyles) return;

    stylesApi.injectStyles({
      hiddenClass: HIDDEN_CLASS,
      userCommentFilterHiddenClass: USER_COMMENT_FILTER_HIDDEN_CLASS,
      acknowledgedCollapsedClass: ACKNOWLEDGED_COLLAPSED_CLASS,
      copyButtonClass: COPY_BUTTON_CLASS,
      copyAllButtonClass: COPY_ALL_BUTTON_CLASS,
      copyLastActionButtonClass: COPY_LAST_ACTION_BUTTON_CLASS,
      grafanaQueryButtonClass: GRAFANA_QUERY_BUTTON_CLASS,
      noSelectClass: NO_SELECT_CLASS,
      silencedBadgeClass: SILENCED_BADGE_CLASS,
      oldNoNoteIconClass: OLD_NO_NOTE_ICON_CLASS,
      hasNoteIconClass: HAS_NOTE_ICON_CLASS,
      topBarId: TOP_BAR_ID,
      topBarStatusId: TOP_BAR_STATUS_ID,
      toggleId: TOGGLE_ID,
      toggleCounterId: TOGGLE_COUNTER_ID,
      autoRefreshToggleId: AUTO_REFRESH_TOGGLE_ID,
      autoRefreshInputId: AUTO_REFRESH_INPUT_ID,
      autoRefreshCountdownId: AUTO_REFRESH_COUNTDOWN_ID,
      soundAlertsToggleId: SOUND_ALERTS_TOGGLE_ID,
      diagnosticsToggleId: DIAGNOSTICS_TOGGLE_ID,
      diagnosticsOpenButtonId: DIAGNOSTICS_OPEN_BUTTON_ID,
      diagnosticsModalId: DIAGNOSTICS_MODAL_ID,
      diagnosticsLogListId: DIAGNOSTICS_LOG_LIST_ID,
      checkboxImprovementsDisabledClass: CHECKBOX_IMPROVEMENTS_DISABLED_BODY_CLASS
    });
  }

  function getGroupSubjectNode(groupPanel) {
    return getPanelHeading(groupPanel)?.querySelector('[ng-bind="group.Subject"]') || null;
  }

  function getChildSubjectNode(childPanel) {
    return getChildHeading(childPanel)?.querySelector('[ng-bind="child.Subject || child.AlertKey"]') || null;
  }

  function getPanelTitle(panel) {
    return getPanelHeading(panel)?.querySelector('.panel-title') || null;
  }

  function isGroupPanel(panel) {
    return !!getGroupSubjectNode(panel);
  }

  function getGroupCountNode(groupPanel) {
    return getPanelTitle(groupPanel)?.querySelector('.pull-right.ng-binding') || null;
  }

  function parseGroupAlertCount(groupPanel) {
    const countNode = getGroupCountNode(groupPanel);
    const text = countNode?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const match = text.match(/^(\d+)\s+alerts?$/i);
    return match ? Number(match[1]) : 0;
  }

  function getExpandedChildPanelsForGroup(groupPanel) {
    if (!groupPanel) return [];

    return Array.from(
      groupPanel.querySelectorAll('[ng-bind="child.Subject || child.AlertKey"]')
    );
  }

  function getChildAlertText(nodeOrPanel) {
    const node =
      nodeOrPanel?.getAttribute?.('ng-bind') === 'child.Subject || child.AlertKey'
        ? nodeOrPanel
        : getChildSubjectNode(nodeOrPanel);

    return node?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }

  function getAllChildAlertTextsForGroup(groupPanel) {
    const childNodes = getExpandedChildPanelsForGroup(groupPanel);
    if (!childNodes.length) return [];

    return childNodes
      .map((node) => getChildAlertText(node))
      .filter(Boolean);
  }

  function markNoSelectElements() {
    document
      .querySelectorAll('.panel-title > a > span.pull-right.ng-binding')
      .forEach((el) => setExtensionClass(el, NO_SELECT_CLASS, true));

    document
      .querySelectorAll('.panel-title > span.pull-right[ts-since="child.Ago"]')
      .forEach((el) => setExtensionClass(el, NO_SELECT_CLASS, true));

    document
      .querySelectorAll('.panel-title > span[ng-show="state.Id"], .panel-title > span.ng-binding')
      .forEach((el) => {
        if (/^#\d+:$/.test((el.textContent || '').trim())) {
          setExtensionClass(el, NO_SELECT_CLASS, true);
        }
      });
  }

  function getAlertTextFromPanel(panel) {
    const groupNode = getGroupSubjectNode(panel);
    if (groupNode) {
      return groupNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    const childNode = getChildSubjectNode(panel);
    if (childNode) {
      return childNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    return '';
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback для окружений без navigator.clipboard
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function flashCopyButtonState(button, ok, errorText = 'Не удалось скопировать') {
    if (!button) return;
    if (button.dataset.flashTimer) {
      clearTimeout(Number(button.dataset.flashTimer));
    }
    const originalTitle = button.dataset.originalTitle || button.title || '';
    const originalText = button.dataset.originalText || button.textContent || '';
    button.dataset.originalTitle = originalTitle;
    button.dataset.originalText = originalText;
    const message = ok ? 'Скопировано' : errorText;
    button.title = message;
    button.textContent = ok ? 'Скопировано' : 'Не скопировано';
    button.dataset.copied = ok ? 'true' : 'false';
    clearToolbarStatus('action-feedback');
    const timerId = setTimeout(() => {
      button.title = originalTitle;
      button.textContent = originalText;
      delete button.dataset.copied;
      delete button.dataset.originalTitle;
      delete button.dataset.originalText;
      delete button.dataset.flashTimer;
    }, ok ? 1200 : 2500);
    button.dataset.flashTimer = String(timerId);
  }

  function flashButtonState(button, text, ok = true) {
    if (!button) return;
    if (button.dataset.flashTimer) {
      clearTimeout(Number(button.dataset.flashTimer));
    }
    const originalTitle = button.dataset.originalTitle || button.title || '';
    button.dataset.originalTitle = originalTitle;
    button.title = text;
    button.dataset.copied = ok ? 'true' : 'false';
    setToolbarStatus('action-feedback', text, ok ? 'info' : 'error', {
      ttlMs: ok ? 1500 : 5000
    });
    const timerId = setTimeout(() => {
      button.title = originalTitle;
      delete button.dataset.copied;
      delete button.dataset.originalTitle;
      delete button.dataset.flashTimer;
    }, ok ? 1200 : 2500);
    button.dataset.flashTimer = String(timerId);
  }

  function extractPromrasQuery(expr) {
    return promqlApi?.extractPromrasQuery?.(expr) || '';
  }

  function applyAlertTagsToPromQuery(query, rawTags, alertKey = '') {
    const result = promqlApi?.applyAlertTagsToPromQuery?.(query, rawTags, alertKey);
    return typeof result === 'string' ? result : '';
  }

  function getGrafanaQueryForPanel(panel) {
    const heading = getChildHeading(panel);
    if (!heading) return '';

    const panelId = getPanelIdFromHeading(heading);
    if (panelId && ambiguousGrafanaIds.has(panelId)) return '';
    if (panelId && grafanaQueryById.has(panelId)) {
      return grafanaQueryById.get(panelId) || '';
    }

    const groupPanel = findParentGroupPanelForChild(panel);
    const childKey = buildChildMarkerKeyFromHeading(heading, groupPanel);
    if (childKey && ambiguousGrafanaKeys.has(childKey)) return '';
    return childKey ? (grafanaQueryByKey.get(childKey) || '') : '';
  }

  function ensureGrafanaQueryButton(panel) {
    if (!isFeatureEnabled('grafanaIntegration')) return;
    if (!grafanaHandoffApi?.openQuery) return;
    if (!getChildSubjectNode(panel)) return;

    const subjectNode = getChildSubjectNode(panel);
    if (!subjectNode || subjectNode.parentElement?.querySelector(`.${GRAFANA_QUERY_BUTTON_CLASS}`)) return;

    const query = getGrafanaQueryForPanel(panel);
    if (!query) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = GRAFANA_QUERY_BUTTON_CLASS;
    btn.textContent = 'Grafana';
    btn.title = 'Показать запрос и открыть панель Grafana';
    btn.setAttribute('unselectable', 'on');

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentQuery = getGrafanaQueryForPanel(panel);
      if (!currentQuery) return;
      await grafanaHandoffApi.openQuery(currentQuery, btn);
    });

    const copyButton = subjectNode.parentElement?.querySelector(`.${COPY_BUTTON_CLASS}`);
    if (copyButton) {
      copyButton.insertAdjacentElement('afterend', btn);
    } else {
      subjectNode.insertAdjacentElement('afterend', btn);
    }
  }

  function ensureCopyButton(panel) {
    if (!isFeatureEnabled('copyButtons')) return;
    const subjectNode = getGroupSubjectNode(panel) || getChildSubjectNode(panel);
    if (!subjectNode) return;

    if (subjectNode.parentElement?.querySelector(`.${COPY_BUTTON_CLASS}`)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = COPY_BUTTON_CLASS;
    btn.textContent = 'Копировать';
    btn.title = 'Скопировать текст алерта';
    btn.setAttribute('unselectable', 'on');

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const text = getAlertTextFromPanel(panel);
      const ok = await copyTextToClipboard(text);
      flashCopyButtonState(btn, ok);
    });

    subjectNode.insertAdjacentElement('afterend', btn);
  }

  function ensureCopyAllButton(panel) {
    if (!isFeatureEnabled('copyButtons')) return;
    if (!isGroupPanel(panel)) return;

    const title = getPanelTitle(panel);
    const countNode = getGroupCountNode(panel);
    if (!title || !countNode) return;

    const totalCount = parseGroupAlertCount(panel);
    const shouldShow = totalCount >= 2;

    const existing = title.querySelector(`.${COPY_ALL_BUTTON_CLASS}`);
    if (!shouldShow) {
      existing?.remove();
      return;
    }

    if (existing) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = COPY_ALL_BUTTON_CLASS;
    btn.textContent = 'Копировать все';
    btn.title = 'Скопировать все вложенные алерты';
    btn.setAttribute('unselectable', 'on');

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const texts = getAllChildAlertTextsForGroup(panel);
      const payload = texts.join('\n');
      const ok = payload ? await copyTextToClipboard(payload) : false;
      flashCopyButtonState(btn, ok, 'Внимание! Сначала раскрой и проверь!');
    });

    countNode.insertAdjacentElement('afterend', btn);
  }

  function getLastActionMessageText(messageNode) {
    if (!messageNode) return '';
    const text = typeof messageNode.innerText === 'string'
      ? messageNode.innerText
      : (messageNode.textContent || '');
    return text
      .replace(/\r\n?/g, '\n')
      .trim()
      .replace(/^:\s*/, '');
  }

  function getLastActionMessageNode(container) {
    return container?.querySelector(
      ':scope > [ng-show="state.LastAction.Message"], ' +
      ':scope > [ng-bind="state.LastAction.Message"]'
    ) || null;
  }

  function trimUrlEnd(rawUrl) {
    let url = rawUrl;
    let suffix = '';
    while (/[.,;:!?]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
    let changed = true;
    while (changed && url) {
      changed = false;
      for (const [open, close] of pairs) {
        if (!url.endsWith(close)) continue;
        const openCount = url.split(open).length - 1;
        const closeCount = url.split(close).length - 1;
        if (closeCount > openCount) {
          suffix = close + suffix;
          url = url.slice(0, -1);
          changed = true;
          break;
        }
      }
    }
    return { url, suffix };
  }

  function linkifyLastActionMessage(messageNode) {
    if (!messageNode) return;
    const textNodes = [];
    const walker = document.createTreeWalker(messageNode, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      if (!textNode.parentElement?.closest('a')) textNodes.push(textNode);
      textNode = walker.nextNode();
    }

    for (const node of textNodes) {
      const source = node.nodeValue || '';
      const pattern = /\bhttps?:\/\/[^\s<>"']+/gi;
      let match = pattern.exec(source);
      if (!match) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let linked = false;
      do {
        const rawUrl = match[0];
        const { url, suffix } = trimUrlEnd(rawUrl);
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch (_) {}

        fragment.appendChild(document.createTextNode(source.slice(cursor, match.index)));
        if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
          const link = document.createElement('a');
          link.className = LAST_ACTION_LINK_CLASS;
          link.href = parsed.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = url;
          link.title = 'Открыть ссылку в новой вкладке';
          fragment.appendChild(link);
          linked = true;
          if (suffix) fragment.appendChild(document.createTextNode(suffix));
        } else {
          fragment.appendChild(document.createTextNode(rawUrl));
        }
        cursor = pattern.lastIndex;
        match = pattern.exec(source);
      } while (match);
      fragment.appendChild(document.createTextNode(source.slice(cursor)));
      if (linked) node.replaceWith(fragment);
    }
  }

  function disableLastActionTimeLinks() {
    document
      .querySelectorAll('[ts-time="state.LastAction.Time"] a')
      .forEach((link) => {
        const text = document.createElement('span');
        text.className = LAST_ACTION_TIME_TEXT_CLASS;
        text.style.color = getComputedStyle(link).color;
        while (link.firstChild) text.appendChild(link.firstChild);
        link.replaceWith(text);
      });
  }

  function ensureLastActionCopyButtons() {
    if (!isFeatureEnabled('lastActionEnhancements')) return;
    disableLastActionTimeLinks();
    document
      .querySelectorAll(`.${COPY_LAST_ACTION_BUTTON_CLASS}[data-bosun-message-copy]`)
      .forEach((button) => {
        const currentMessage = getLastActionMessageNode(button.parentElement);
        if (!getLastActionMessageText(currentMessage)) button.remove();
      });

    document
      .querySelectorAll(LAST_ACTION_MESSAGE_SELECTOR)
      .forEach((messageNode) => {
        linkifyLastActionMessage(messageNode);
        const existing = messageNode.parentElement?.querySelector(
          `:scope > .${COPY_LAST_ACTION_BUTTON_CLASS}[data-bosun-message-copy]`
        );
        if (!getLastActionMessageText(messageNode)) {
          existing?.remove();
          return;
        }
        if (existing) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = COPY_LAST_ACTION_BUTTON_CLASS;
        btn.dataset.bosunMessageCopy = 'true';
        btn.textContent = 'Копировать';
        btn.title = 'Скопировать текст заметки';
        btn.setAttribute('aria-label', 'Скопировать текст заметки');
        btn.setAttribute('unselectable', 'on');

        btn.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentMessage = getLastActionMessageNode(btn.parentElement);
          const text = getLastActionMessageText(currentMessage);
          const ok = await copyTextToClipboard(text);
          flashCopyButtonState(btn, ok, 'Не удалось скопировать заметку');
        });

        messageNode.insertAdjacentElement('afterend', btn);
      });
  }

  function ensureCopyButtons() {
    if (!isFeatureEnabled('copyButtons')) return;
    getAcknowledgedPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getGroupPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getChildAlertPanels().forEach((panel) => {
      ensureCopyButton(panel);
    });
  }

  function ensureGrafanaQueryButtons() {
    document.querySelectorAll(`.${GRAFANA_QUERY_BUTTON_CLASS}`).forEach((button) => {
      const panel = button.closest?.('.panel');
      if (
        !isFeatureEnabled('grafanaIntegration') ||
        !panel ||
        !getGrafanaQueryForPanel(panel)
      ) button.remove();
    });
    if (isFeatureEnabled('grafanaIntegration')) {
      getAcknowledgedPanels().forEach(ensureGrafanaQueryButton);
      getChildAlertPanels().forEach(ensureGrafanaQueryButton);
    }
  }

  function getPanelHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function installSelectionGuard() {
    if (window.__bosunSelectionGuardInstalled) return;
    window.__bosunSelectionGuardInstalled = true;

    document.addEventListener(
      'mousedown',
      (event) => {
        const heading = event.target?.closest?.('.panel-heading');
        if (!heading) return;

        bosunSelectionDragState = {
          x: event.clientX,
          y: event.clientY,
          moved: false,
          heading,
        };
      },
      true
    );

    document.addEventListener(
      'mousemove',
      (event) => {
        if (!bosunSelectionDragState) return;

        const dx = Math.abs(event.clientX - bosunSelectionDragState.x);
        const dy = Math.abs(event.clientY - bosunSelectionDragState.y);
        if (dx > 4 || dy > 4) {
          bosunSelectionDragState.moved = true;
        }
      },
      true
    );

    document.addEventListener(
      'mouseup',
      () => {
        setTimeout(() => {
          bosunSelectionDragState = null;
        }, 0);
      },
      true
    );

    document.addEventListener(
      'click',
      (event) => {
        const heading = event.target?.closest?.('.panel-heading');
        if (!heading) return;

        const selectionText = window.getSelection?.()?.toString?.().trim?.() || '';
        const wasDragSelection =
          bosunSelectionDragState &&
          bosunSelectionDragState.heading === heading &&
          bosunSelectionDragState.moved &&
          selectionText.length > 0;

        if (!wasDragSelection) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      },
      true
    );
  }

  function getClosestElementFromNode(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function selectionIsInsideAlertHeading(selection) {
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return false;

    const anchorEl = getClosestElementFromNode(selection.anchorNode);
    const focusEl = getClosestElementFromNode(selection.focusNode);
    const anchorHeading = anchorEl?.closest?.('.panel-heading') || null;
    const focusHeading = focusEl?.closest?.('.panel-heading') || null;
    if (anchorHeading || focusHeading) return true;

    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      const commonEl = getClosestElementFromNode(range?.commonAncestorContainer);
      if (!commonEl) continue;
      if (commonEl.closest?.('.panel-heading, .panel-title')) return true;
      if (commonEl.querySelector?.('.panel-heading, .panel-title')) return true;
    }

    return false;
  }

  function normalizeSelectedAlertText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s+/, '').replace(/\s+$/, ''))
      .join('\n')
      .trim();
  }

  function installSelectionCopySanitizer() {
    if (window.__bosunSelectionCopySanitizerInstalled) return;
    window.__bosunSelectionCopySanitizerInstalled = true;

    document.addEventListener(
      'copy',
      (event) => {
        const selection = window.getSelection?.();
        if (!selectionIsInsideAlertHeading(selection)) return;

        const rawText = selection?.toString?.() || '';
        const normalizedText = normalizeSelectedAlertText(rawText);
        if (!normalizedText) return;

        if (event.clipboardData?.setData) {
          event.clipboardData.setData('text/plain', normalizedText);
          event.preventDefault();
          return;
        }

        if (navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(normalizedText).catch(() => {});
        }
      },
      true
    );
  }

  function isSilencedPanel(panel) {
    const heading = getPanelHeading(panel);
    return !!heading?.querySelector('.fa-volume-off');
  }

  function ensureSilencedBadge(panel) {
    const heading = getPanelHeading(panel);
    if (!heading) return;

    const muteIcon = heading.querySelector('.fa-volume-off');
    if (!muteIcon) return;

    let badge = muteIcon.parentElement?.querySelector(`.${SILENCED_BADGE_CLASS}`);
    if (badge) return;

    badge = document.createElement('span');
    badge.className = `${SILENCED_BADGE_CLASS} ${NO_SELECT_CLASS}`;
    badge.textContent = 'Silenced';

    muteIcon.insertAdjacentElement('afterend', badge);
  }

  function removeSilencedBadge(panel) {
    panel?.querySelector(`.${SILENCED_BADGE_CLASS}`)?.remove();
  }

  function refreshSilencedBadges() {
    if (!isFeatureEnabled('silencedFilter')) return;
    const roots = [getNeedsAckRoot(), getAcknowledgedRoot()].filter(Boolean);
    const panels = uniqueNodes(
      roots.flatMap((root) => Array.from(root.querySelectorAll('.panel')))
    );
    panels.forEach((panel) => {
      if (isSilencedPanel(panel)) {
        ensureSilencedBadge(panel);
      } else {
        removeSilencedBadge(panel);
      }
    });
  }

  function getAcknowledgedRoot() {
    return document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
  }

  function getAcknowledgedHeading() {
    const root = getAcknowledgedRoot();
    let node = root?.previousElementSibling || null;
    let guard = 0;

    while (node && guard < 8) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (/^Acknowledged\b/i.test(text)) return node;
      if (/^Needs Acknowledgement\b/i.test(text)) return null;
      node = node.previousElementSibling;
      guard += 1;
    }

    return null;
  }

  function getAcknowledgedPanels() {
    const root = getAcknowledgedRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll('.panel-group > .panel'));
  }

  function isDashboardEnhancementsPage() {
    return isDashboardHome();
  }

  function clearAlertDerivedState() {
    alertsPayloadApplyVersion += 1;
    ruleGraphLifecycleGeneration += 1;
    ruleGraphResolver?.stop?.();
    latestAlertsPayload = null;
    try { primedAlertsPayload?.controller?.abort?.(); } catch (_) {}
    primedAlertsPayload = null;
    if (alertMarkerCachePersistTimer) {
      clearTimeout(alertMarkerCachePersistTimer);
      alertMarkerCachePersistTimer = null;
      flushAlertMarkerCacheToSession();
    }
    rebuildAlertDataIndex({ Groups: {} });
    singleAlertAgeApi?.clear?.();
    alertDataIndexReady = false;
    document.querySelectorAll(
      `.${GRAFANA_QUERY_BUTTON_CLASS}, .${OLD_NO_NOTE_ICON_CLASS}, .${HAS_NOTE_ICON_CLASS}`
    ).forEach((element) => element.remove());
  }

  function runDomRefreshPass(options = {}) {
    const preserveExistingOnNone = options.preserveExistingOnNone === true;
    const skipSingleAlertAge = options.skipSingleAlertAge === true;

    ensureToggleExists();
    if (isFeatureEnabled('silencedFilter')) applyVisibility();
    if (isFeatureEnabled('acknowledgedCollapse')) applyAcknowledgedCollapse();
    if (isFeatureEnabled('noCommentFilter')) applyUserCommentFilter();
    ensureCopyButtons();
    ensureGrafanaQueryButtons();
    if (isFeatureEnabled('lastActionEnhancements')) ensureLastActionCopyButtons();
    if (isFeatureEnabled('checkboxImprovements')) pageUtils?.ensureDashboardGroupCheckboxHitAreaGuards?.();
    markNoSelectElements();
    refreshSilencedBadges();
    if (!skipSingleAlertAge && isFeatureEnabled('singleAlertAge')) singleAlertAgeApi?.refresh?.();
    applyActionPageTweaks();
    if (isFeatureEnabled('actionTemplates')) actionTemplatesApi?.refresh?.();

    if (preserveExistingOnNone) {
      repaintNeedsAckMarkersFast();
    }
  }

  function handleRouteChange() {
    if (isDashboardEnhancementsPage()) {
      if (!alertDataIndexReady) restoreAlertMarkerCacheFromSession();
      scheduleTopBarMount();
      refreshCoordinatorApi?.start?.();
      refreshCoordinatorApi?.requestRefresh?.('route-change');
    } else {
      disconnectTopBarMountObserver();
      refreshCoordinatorApi?.stop?.();
      settingsUi?.close?.({ restoreFocus: false });
      document.getElementById(TOP_BAR_ID)?.remove();
      clearAlertDerivedState();
    }

    if (!isActionPage()) {
      actionTemplatesApi?.destroy?.();
    }

    syncScopedDomObservers();
    runDomRefreshPass({ preserveExistingOnNone: true });
  }

  function applyVisibility() {
    const panels = getAcknowledgedPanels();
    let nextHiddenCount = 0;
    let nextTotalSilencedCount = 0;

    for (const panel of panels) {
      if (isSilencedPanel(panel)) {
        nextTotalSilencedCount++;
        if (!showSilenced) {
          setExtensionClass(panel, HIDDEN_CLASS, true);
          nextHiddenCount++;
        } else {
          setExtensionClass(panel, HIDDEN_CLASS, false);
        }
      } else {
        setExtensionClass(panel, HIDDEN_CLASS, false);
      }
    }

    // На всякий случай гарантируем, что в Needs Acknowledgement ничего не скрыто
    const needsAckRoot = getNeedsAckRoot();
    needsAckRoot?.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((panel) => {
      setExtensionClass(panel, HIDDEN_CLASS, false);
    });

    hiddenCount = nextTotalSilencedCount;
    updateToggleText();
  }

  function applyAcknowledgedCollapse() {
    const root = getAcknowledgedRoot();
    const heading = getAcknowledgedHeading();
    setExtensionClass(root, ACKNOWLEDGED_COLLAPSED_CLASS, acknowledgedCollapseEnabled);
    setExtensionClass(heading, ACKNOWLEDGED_COLLAPSED_CLASS, acknowledgedCollapseEnabled);
  }

  function resolveChildHasUserComment(panel, parentGroupPanel = null) {
    const heading = getChildHeading(panel);
    if (!heading) return true;

    const panelId = getPanelIdFromHeading(heading);
    const groupPanel = parentGroupPanel || findParentGroupPanelForChild(panel);
    const childKey = buildChildMarkerKeyFromHeading(heading, groupPanel);
    let hasLastActionUserComment = false;

    if (panelId && childHasUserCommentById.has(panelId)) {
      hasLastActionUserComment = childHasUserCommentById.get(panelId) === true;
    }

    if (!hasLastActionUserComment && childKey && childHasUserCommentByKey.has(childKey)) {
      hasLastActionUserComment = childHasUserCommentByKey.get(childKey) === true;
    }

    return hasLastActionUserComment;
  }

  function resolveGroupHasUserComment(groupPanel) {
    const groupKey = buildGroupMarkerKeyFromDom(groupPanel);
    const groupSubject = getGroupSubjectFromPanel(groupPanel);
    let hasLastActionUserComment = false;

    if (groupKey && groupHasAnyUserCommentByKey.has(groupKey)) {
      hasLastActionUserComment = groupHasAnyUserCommentByKey.get(groupKey) === true;
    }

    if (
      !hasLastActionUserComment &&
      groupSubject &&
      groupCountBySubject.get(groupSubject) === 1 &&
      groupHasAnyUserCommentBySubject.has(groupSubject)
    ) {
      hasLastActionUserComment = groupHasAnyUserCommentBySubject.get(groupSubject) === true;
    }

    return hasLastActionUserComment;
  }

  function shouldShowAlertByUserCommentFilter(panel, parentGroupPanel = null) {
    if (!userCommentFilterEnabled || !alertDataIndexReady) return true;
    return !resolveChildHasUserComment(panel, parentGroupPanel);
  }

  function applyUserCommentFilter() {
    const needsAckRoot = getNeedsAckRoot();
    if (!needsAckRoot) return;

    if (!userCommentFilterEnabled || !alertDataIndexReady) {
      needsAckRoot.querySelectorAll(`.${USER_COMMENT_FILTER_HIDDEN_CLASS}`).forEach((panel) => {
        setExtensionClass(panel, USER_COMMENT_FILTER_HIDDEN_CLASS, false);
      });
      return;
    }

    const groupPanels = getGroupPanels();
    for (const groupPanel of groupPanels) {
      const childPanels = getGroupChildPanels(groupPanel);

      for (const childPanel of childPanels) {
        const shouldShow = shouldShowAlertByUserCommentFilter(childPanel, groupPanel);
        setExtensionClass(childPanel, USER_COMMENT_FILTER_HIDDEN_CLASS, !shouldShow);
      }

      const hasVisibleChild = childPanels.some((childPanel) => {
        return !childPanel.classList.contains(USER_COMMENT_FILTER_HIDDEN_CLASS);
      });
      const shouldShowGroup = childPanels.length ? hasVisibleChild : !resolveGroupHasUserComment(groupPanel);
      setExtensionClass(groupPanel, USER_COMMENT_FILTER_HIDDEN_CLASS, !shouldShowGroup);
    }
  }

  function scheduleRefresh(options = {}) {
    if (refreshTimer) clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refreshTimer = null;

      // Быстрый локальный repaint по текущим index maps,
      // но без удаления значков, если DOM ещё не устаканился.
      if (isDashboardEnhancementsPage() && !alertDataIndexReady) {
        restoreAlertMarkerCacheFromSession();
      }
      runDomRefreshPass({
        preserveExistingOnNone: true,
        skipSingleAlertAge: options.skipSingleAlertAge === true
      });
    }, 120);
  }

  function scheduleAlertsDataRefresh() {
    if (refreshCoordinatorApi?.requestRefresh) {
      refreshCoordinatorApi.requestRefresh('dom-mutation');
      return;
    }
    if (dataRefreshDebounceTimer) clearTimeout(dataRefreshDebounceTimer);

    dataRefreshDebounceTimer = setTimeout(() => {
      dataRefreshDebounceTimer = null;
      refreshAlertsData();
    }, DATA_REFRESH_DEBOUNCE_MS);
  }

  function getChromeStorageLastError() {
    return globalThis.chrome?.runtime?.lastError || null;
  }

  function clearToolbarStatusTimer() {
    if (!toolbarStatusTimer) return;
    clearTimeout(toolbarStatusTimer);
    toolbarStatusTimer = null;
  }

  function updateToolbarStatus() {
    const status = document.getElementById(TOP_BAR_STATUS_ID);
    if (!status) return;

    const isVisible = Boolean(toolbarStatusMessage);
    const accessibleText = toolbarStatusTitle && toolbarStatusTitle !== toolbarStatusMessage
      ? `${toolbarStatusMessage}. Подробности: ${toolbarStatusTitle}`
      : toolbarStatusMessage;
    status.textContent = isVisible ? toolbarStatusMessage : '';
    status.title = isVisible ? (toolbarStatusTitle || toolbarStatusMessage) : '';
    status.hidden = !isVisible;
    if (isVisible) {
      status.setAttribute('aria-label', accessibleText);
      status.tabIndex = toolbarStatusTitle !== toolbarStatusMessage ? 0 : -1;
    } else {
      status.removeAttribute('aria-label');
      status.removeAttribute('tabindex');
    }
    status.classList.toggle('is-info', toolbarStatusLevel === 'info');
    status.classList.toggle('is-warn', toolbarStatusLevel === 'warn');
    status.classList.toggle('is-error', toolbarStatusLevel === 'error');
  }

  function clearToolbarStatus(source) {
    if (source && toolbarStatusSource && toolbarStatusSource !== source) return;

    toolbarStatusSource = '';
    toolbarStatusLevel = '';
    toolbarStatusMessage = '';
    toolbarStatusTitle = '';
    clearToolbarStatusTimer();
    updateToolbarStatus();
  }

  function setToolbarStatus(source, message, level = 'info', options = {}) {
    const {
      sticky = false,
      ttlMs = STATUS_MESSAGE_TTL_MS,
      title = ''
    } = options;

    toolbarStatusSource = String(source || '');
    toolbarStatusLevel = level;
    toolbarStatusMessage = String(message || '');
    toolbarStatusTitle = String(title || toolbarStatusMessage);
    clearToolbarStatusTimer();
    updateToolbarStatus();

    if (sticky || !toolbarStatusMessage) return;

    toolbarStatusTimer = setTimeout(() => {
      clearToolbarStatus(source);
    }, Math.max(1000, Number(ttlMs) || STATUS_MESSAGE_TTL_MS));
  }

  function updateNewAlertNotice() {
    if (!isFeatureEnabled('visualNewAlertNotifications')) return;
    const notice = document.getElementById(NEW_ALERT_NOTICE_ID);
    if (!notice) return;
    const warning = Math.max(0, Number(newAlertNoticeCounts.warning) || 0);
    const critical = Math.max(0, Number(newAlertNoticeCounts.critical) || 0);
    const unknown = Math.max(0, Number(newAlertNoticeCounts.unknown) || 0);
    const total = warning + critical + unknown;
    const visibleCounts = [];
    if (warning > 0) visibleCounts.push(`Warn: ${warning}`);
    if (critical > 0) visibleCounts.push(`Crit: ${critical}`);
    if (unknown > 0) visibleCounts.push(`Unk: ${unknown}`);
    const nextText = total ? `Новые алерты: ${visibleCounts.join(', ')}` : '';
    if (notice.textContent !== nextText) notice.textContent = nextText;
    notice.hidden = total === 0;
    const severityClass = critical > 0
      ? 'is-critical'
      : (warning > 0 ? 'is-warning' : (unknown > 0 ? 'is-unknown' : ''));
    for (const className of ['is-critical', 'is-warning', 'is-unknown']) {
      notice.classList.toggle(className, className === severityClass);
    }
  }

  function ensureNewAlertNotice() {
    if (!isFeatureEnabled('visualNewAlertNotifications')) return null;
    const bar = ensureTopBarExists();
    if (!bar) return null;
    let notice = bar.querySelector(`#${NEW_ALERT_NOTICE_ID}`);
    if (!notice) {
      notice = document.createElement('div');
      notice.id = NEW_ALERT_NOTICE_ID;
      notice.className = 'bosun-new-alerts-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.setAttribute('aria-atomic', 'true');
      notice.hidden = true;
      bar.appendChild(notice);
    }
    updateNewAlertNotice();
    return notice;
  }

  function getChromeLocalStorage() {
    return globalThis.chrome?.storage?.local || null;
  }

  function saveToLocalStorage(values, context) {
    const storage = getChromeLocalStorage();
    if (!storage) {
      setToolbarStatus('storage-read', 'Storage unavailable; using in-memory settings', 'warn', {
        sticky: true,
        title: 'chrome.storage.local is unavailable, so settings will not persist after reload'
      });
      return;
    }

    try {
      storage.set(values, () => {
        const err = getChromeStorageLastError();
        if (!err) {
          clearToolbarStatus('storage-write');
          return;
        }
        console.warn(`[Bosun plugin] Failed to save ${context}:`, err.message || err);
        reportDiagnostics('storage-save-failed', `${context}: ${err.message || err}`);
        setToolbarStatus('storage-write', 'Settings were not saved', 'warn', {
          title: `${context}: ${err.message || err}`,
          sticky: true
        });
      });
    } catch (err) {
      console.warn(`[Bosun plugin] Failed to save ${context}:`, err);
      reportDiagnostics('storage-save-failed', `${context}: ${err?.message || 'unknown-error'}`);
      setToolbarStatus('storage-write', 'Settings were not saved', 'warn', {
        title: `${context}: ${err?.message || 'unknown-error'}`,
        sticky: true
      });
    }
  }

  function saveState() {
    if (settingsStore?.update) {
      persistSettingsUpdate({ 'preferences.showSilenced': showSilenced }, STORAGE_KEY);
      return;
    }
    saveToLocalStorage({ [STORAGE_KEY]: showSilenced }, STORAGE_KEY);
  }

  function normalizeAutoRefreshIdleSeconds(value) {
    if (sharedUtils?.normalizeAutoRefreshIdleSeconds) {
      return sharedUtils.normalizeAutoRefreshIdleSeconds(value, {
        min: AUTO_REFRESH_MIN_IDLE_SECONDS,
        max: AUTO_REFRESH_MAX_IDLE_SECONDS,
        fallback: AUTO_REFRESH_DEFAULT_IDLE_SECONDS
      });
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return AUTO_REFRESH_DEFAULT_IDLE_SECONDS;
    return Math.min(
      AUTO_REFRESH_MAX_IDLE_SECONDS,
      Math.max(AUTO_REFRESH_MIN_IDLE_SECONDS, Math.round(numericValue))
    );
  }

  function uniqueNodes(nodes) {
    if (sharedUtils?.uniqueNodes) {
      return sharedUtils.uniqueNodes(nodes);
    }
    const seen = new Set();
    const result = [];
    for (const node of nodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }
    return result;
  }

  function saveAutoRefreshState() {
    if (settingsStore?.update) {
      persistSettingsUpdate({
        'preferences.autoRefreshEnabled': autoRefreshEnabled,
        'preferences.autoRefreshIdleSeconds': autoRefreshIdleSeconds
      }, 'auto-refresh');
      return;
    }
    saveToLocalStorage({
      [AUTO_REFRESH_ENABLED_KEY]: autoRefreshEnabled,
      [AUTO_REFRESH_IDLE_SECONDS_KEY]: autoRefreshIdleSeconds
    }, 'auto-refresh');
  }

  function saveUserCommentFilterState() {
    if (settingsStore?.update) {
      persistSettingsUpdate(
        { 'preferences.noCommentFilterActive': userCommentFilterEnabled },
        USER_COMMENT_FILTER_ENABLED_KEY
      );
      return;
    }
    saveToLocalStorage({ [USER_COMMENT_FILTER_ENABLED_KEY]: userCommentFilterEnabled }, USER_COMMENT_FILTER_ENABLED_KEY);
  }

  function saveAcknowledgedCollapseState() {
    if (settingsStore?.update) {
      persistSettingsUpdate(
        { 'preferences.acknowledgedCollapsed': acknowledgedCollapseEnabled },
        ACKNOWLEDGED_COLLAPSE_ENABLED_KEY
      );
      return;
    }
    saveToLocalStorage({ [ACKNOWLEDGED_COLLAPSE_ENABLED_KEY]: acknowledgedCollapseEnabled }, ACKNOWLEDGED_COLLAPSE_ENABLED_KEY);
  }

  function saveSoundAlertsState() {
    if (settingsStore?.update) {
      persistSettingsUpdate({ 'preferences.soundEnabled': soundAlertsEnabled }, SOUND_ALERTS_ENABLED_KEY);
      return;
    }
    saveToLocalStorage({ [SOUND_ALERTS_ENABLED_KEY]: soundAlertsEnabled }, SOUND_ALERTS_ENABLED_KEY);
  }


  function saveDiagnosticsState() {
    if (settingsStore?.update) {
      persistSettingsUpdate({ 'internal.diagnosticsEnabled': diagnosticsEnabled }, DIAGNOSTICS_ENABLED_KEY);
      return;
    }
    saveToLocalStorage({ [DIAGNOSTICS_ENABLED_KEY]: diagnosticsEnabled }, DIAGNOSTICS_ENABLED_KEY);
  }

  function persistSettingsUpdate(values, context) {
    settingsStore.update(values).then(() => {
      clearToolbarStatus('storage-write');
    }).catch((error) => {
      const persisted = settingsStore.getSnapshot?.();
      if (persisted) {
        applySettingsSnapshot(persisted, {
          previous: settingsSnapshot,
          changedPaths: Object.keys(values),
          initial: false
        });
      }
      handleSettingsWriteError(context, error);
    });
  }

  function handleSettingsWriteError(context, error) {
    console.warn(`[Bosun plugin] Failed to save ${context}:`, error);
    setToolbarStatus('storage-write', 'Settings were not saved', 'warn', {
      title: `${context}: ${error?.message || error || 'unknown-error'}`,
      sticky: true
    });
  }

  function resetNeedAckSoundBaseline() {
    needAckBaselineApi?.reset?.();
  }

  function restoreNeedAckSoundBaselineFromSession() {
    needAckBaselineApi?.restoreFromSession?.();
  }

  function getAlertMarkerCacheMaps() {
    return {
      childOldNoNoteById,
      childOldNoNoteByKey,
      childHasNoteById,
      childHasNoteByKey,
      childHasUserCommentById,
      childHasUserCommentByKey,
      groupHasOldNoNoteByKey,
      groupHasAnyNoteByKey,
      groupHasAnyUserCommentByKey,
      groupHasOldNoNoteBySubject,
      groupHasAnyNoteBySubject,
      groupHasAnyUserCommentBySubject,
      groupCountBySubject
    };
  }

  function serializeAlertMarkerMap(map) {
    return Array.from(map.entries())
      .filter(([key, value]) => (
        (typeof key === 'number' || (
          typeof key === 'string' && key.length <= ALERT_MARKER_CACHE_MAX_KEY_LENGTH
        )) &&
        (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      ))
      .slice(0, ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP);
  }

  function flushAlertMarkerCacheToSession() {
    try {
      lastAlertMarkerCachePersistAttemptAt = Date.now();
      const maps = {};
      for (const [name, map] of Object.entries(getAlertMarkerCacheMaps())) {
        maps[name] = serializeAlertMarkerMap(map);
      }
      const serializedMaps = JSON.stringify(maps);
      if (
        serializedMaps === lastAlertMarkerCacheSerializedMaps &&
        Date.now() - lastAlertMarkerCacheSavedAt < ALERT_MARKER_CACHE_MAX_UNCHANGED_AGE_MS
      ) return;
      const savedAt = Date.now();
      window.sessionStorage.setItem(ALERT_MARKER_CACHE_SESSION_KEY, JSON.stringify({
        version: 1,
        savedAt,
        maps
      }));
      lastAlertMarkerCacheSerializedMaps = serializedMaps;
      lastAlertMarkerCacheSavedAt = savedAt;
    } catch (err) {
      reportDiagnostics('alert-marker-cache-save-failed', err?.message || 'unknown-error');
    }
  }

  function persistAlertMarkerCacheToSession() {
    if (alertMarkerCachePersistTimer) return;
    const elapsed = Date.now() - lastAlertMarkerCachePersistAttemptAt;
    const throttleDelay = Math.max(0, ALERT_MARKER_CACHE_MIN_PERSIST_INTERVAL_MS - elapsed);
    alertMarkerCachePersistTimer = setTimeout(() => {
      alertMarkerCachePersistTimer = null;
      flushAlertMarkerCacheToSession();
    }, Math.max(ALERT_MARKER_CACHE_PERSIST_DELAY_MS, throttleDelay));
  }

  function restoreAlertMarkerCacheFromSession() {
    try {
      const raw = window.sessionStorage.getItem(ALERT_MARKER_CACHE_SESSION_KEY);
      if (!raw) return false;
      if (raw.length > ALERT_MARKER_CACHE_MAX_RAW_LENGTH) {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
        return false;
      }
      const cached = JSON.parse(raw);
      const ageMs = Date.now() - Number(cached?.savedAt);
      if (
        cached?.version !== 1 ||
        !cached.maps ||
        typeof cached.maps !== 'object' ||
        !Number.isFinite(ageMs) ||
        ageMs < 0 ||
        ageMs > ALERT_MARKER_CACHE_MAX_AGE_MS
      ) {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
        return false;
      }

      for (const [name, map] of Object.entries(getAlertMarkerCacheMaps())) {
        const entries = cached.maps[name];
        if (!Array.isArray(entries)) continue;
        map.clear();
        for (const entry of entries.slice(0, ALERT_MARKER_CACHE_MAX_ENTRIES_PER_MAP)) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [key, value] = entry;
          const validKey = typeof key === 'number' || (
            typeof key === 'string' && key.length <= ALERT_MARKER_CACHE_MAX_KEY_LENGTH
          );
          const validValue = typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
          if (validKey && validValue) map.set(key, value);
        }
      }
      lastAlertMarkerCacheSerializedMaps = JSON.stringify(cached.maps);
      lastAlertMarkerCacheSavedAt = Number(cached.savedAt);
      alertDataIndexReady = true;
      return true;
    } catch (err) {
      try {
        window.sessionStorage.removeItem(ALERT_MARKER_CACHE_SESSION_KEY);
      } catch (_) {}
      reportDiagnostics('alert-marker-cache-restore-failed', err?.message || 'unknown-error');
      return false;
    }
  }

  function restoreDiagnosticsLogFromStorage() {
    diagnosticsApi?.restoreLogFromStorage?.();
  }

  function setDiagnosticsModalOpen(isOpen) {
    diagnosticsApi?.setModalOpen?.(isOpen);
  }

  function reportDiagnostics(eventName, details = '') {
    diagnosticsApi?.report?.(eventName, details);
  }

  function clearOwnedElements(selector) {
    document.querySelectorAll(selector).forEach((element) => {
      if (element.dataset?.flashTimer) clearTimeout(Number(element.dataset.flashTimer));
      element.remove();
    });
  }

  function clearOwnedClass(className) {
    document.querySelectorAll(`.${className}`).forEach((element) => {
      setExtensionClass(element, className, false);
    });
  }

  function applyFeatureLifecycle(name, enabled, initial) {
    if (name === 'lastActionEnhancements') return;

    if (!enabled) {
      if (name === 'singleAlertAge') singleAlertAgeApi?.clear?.();
      if (name === 'checkboxImprovements') {
        document.body?.classList?.add(CHECKBOX_IMPROVEMENTS_DISABLED_BODY_CLASS);
        pageUtils?.clearDashboardGroupCheckboxHitAreaGuards?.();
      }
      if (name === 'copyButtons') {
        clearOwnedElements(`.${COPY_BUTTON_CLASS}, .${COPY_ALL_BUTTON_CLASS}`);
      }
      if (name === 'silencedFilter') {
        clearOwnedClass(HIDDEN_CLASS);
        clearOwnedElements(`.${SILENCED_BADGE_CLASS}, #${TOGGLE_ID}`);
        hiddenCount = 0;
      }
      if (name === 'noCommentFilter') {
        clearOwnedClass(USER_COMMENT_FILTER_HIDDEN_CLASS);
        clearOwnedElements('.bosun-user-comment-filter-wrap');
      }
      if (name === 'acknowledgedCollapse') {
        clearOwnedClass(ACKNOWLEDGED_COLLAPSED_CLASS);
        clearOwnedElements('.bosun-acknowledged-collapse-wrap');
      }
      if (name === 'soundNotifications') {
        soundApi?.destroy?.();
        clearOwnedElements('.bosun-sound-alerts-wrap');
      }
      if (name === 'visualNewAlertNotifications') {
        visualTrackerLifecycleGeneration += 1;
        newAlertTrackerApi?.destroy?.();
        clearOwnedElements(`#${NEW_ALERT_NOTICE_ID}`);
      }
      if (name === 'autoRefresh') {
        activityApi?.destroy?.();
        clearOwnedElements('.bosun-auto-refresh-group');
      }
      if (name === 'actionTemplates') actionTemplatesApi?.destroy?.();
      if (name === 'grafanaIntegration') {
        ruleGraphLifecycleGeneration += 1;
        ruleGraphResolver?.stop?.();
        clearOwnedElements(`.${GRAFANA_QUERY_BUTTON_CLASS}`);
        grafanaHandoffApi?.destroy?.();
      }
      return;
    }

    if (name === 'checkboxImprovements') {
      document.body?.classList?.remove(CHECKBOX_IMPROVEMENTS_DISABLED_BODY_CLASS);
      pageUtils?.ensureDashboardGroupCheckboxHitAreaGuards?.();
    }
    if (name === 'singleAlertAge') singleAlertAgeApi?.refresh?.();
    if (name === 'soundNotifications' && soundAlertsEnabled) {
      soundApi?.installAudioUnlockTracking?.();
      soundApi?.ensureAudioObjects?.();
    }
    if (name === 'visualNewAlertNotifications') {
      const generation = ++visualTrackerLifecycleGeneration;
      Promise.resolve(newAlertTrackerApi?.start?.()).then(() => {
        if (
          generation !== visualTrackerLifecycleGeneration ||
          !isFeatureEnabled('visualNewAlertNotifications') ||
          !latestAlertsPayload
        ) return;
        return newAlertTrackerApi?.reconcile?.(latestAlertsPayload);
      }).catch((error) => {
        reportDiagnostics('new-alert-tracker-start-failed', error?.message || 'unknown-error');
      });
      ensureNewAlertNotice();
    }
    if (name === 'autoRefresh') {
      installUserActivityTracking();
      startAutoRefreshLoop();
    }
    if (name === 'actionTemplates') actionTemplatesApi?.refresh?.();
    if (name === 'grafanaIntegration' && latestAlertsPayload) {
      rebuildGrafanaQueryIndex(latestAlertsPayload);
      ensureGrafanaQueryButtons();
      refreshRuleGraphDefinitions(latestAlertsPayload);
    }
    if (!initial) {
      scheduleTopBarMount();
      scheduleRefresh({ skipSingleAlertAge: name !== 'singleAlertAge' });
    }
  }

  function applySettingsSnapshot(next, options = {}) {
    if (!next || typeof next !== 'object') return;
    const previous = options.previous || settingsSnapshot;
    const initial = options.initial === true;
    const changedPaths = Array.isArray(options.changedPaths) ? options.changedPaths : [];
    settingsSnapshot = next;

    showSilenced = next.preferences?.showSilenced === true;
    autoRefreshEnabled = next.preferences?.autoRefreshEnabled !== false;
    autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(next.preferences?.autoRefreshIdleSeconds);
    userCommentFilterEnabled = next.preferences?.noCommentFilterActive === true;
    acknowledgedCollapseEnabled = next.preferences?.acknowledgedCollapsed === true;
    soundAlertsEnabled = next.preferences?.soundEnabled !== false;
    diagnosticsEnabled = DIAGNOSTICS_TOOLBAR_UI_ENABLED && next.internal?.diagnosticsEnabled === true;

    const featureNames = Object.keys(next.features || {});
    for (const name of featureNames) {
      const changed = initial || changedPaths.includes(`features.${name}`) ||
        previous?.features?.[name] !== next.features[name];
      if (changed) applyFeatureLifecycle(name, next.features[name] !== false, initial);
    }

    if (initial || changedPaths.includes('preferences.showSilenced')) {
      if (isFeatureEnabled('silencedFilter')) applyVisibility();
    }
    if (initial || changedPaths.includes('preferences.noCommentFilterActive')) {
      if (isFeatureEnabled('noCommentFilter')) applyUserCommentFilter();
      updateUserCommentFilterControl();
    }
    if (initial || changedPaths.includes('preferences.acknowledgedCollapsed')) {
      if (isFeatureEnabled('acknowledgedCollapse')) applyAcknowledgedCollapse();
      updateAcknowledgedCollapseControl();
    }
    if (initial || changedPaths.includes('preferences.soundEnabled')) {
      if (isFeatureEnabled('soundNotifications')) {
        if (soundAlertsEnabled) {
          soundApi?.installAudioUnlockTracking?.();
          soundApi?.ensureAudioObjects?.();
        } else {
          soundApi?.destroy?.();
        }
      }
      updateSoundAlertsControl();
    }
    if (
      initial ||
      changedPaths.includes('preferences.autoRefreshEnabled') ||
      changedPaths.includes('preferences.autoRefreshIdleSeconds')
    ) {
      if (autoRefreshEnabled) clearAutoRefreshReEnableTimer();
      else if (isFeatureEnabled('autoRefresh')) scheduleAutoRefreshReEnable();
      updateAutoRefreshControls();
    }
    if (initial || changedPaths.includes('internal.diagnosticsEnabled')) updateDiagnosticsControl();
  }

  function loadState(callback) {
    if (settingsStore?.start) {
      settingsStore.start().then(() => {
        clearToolbarStatus('storage-read');
        applySettingsSnapshot(settingsStore.getSnapshot(), { initial: true });
        callback();
      }).catch((error) => {
        console.warn('[Bosun plugin] Failed to load saved settings:', error);
        setToolbarStatus('storage-read', 'Saved settings were not loaded', 'warn', {
          title: error?.message || String(error),
          sticky: true
        });
        applySettingsSnapshot(settingsSnapshot, { initial: true });
        callback();
      });
      return;
    }
    const storage = getChromeLocalStorage();
    if (!storage) {
      console.warn('[Bosun plugin] chrome.storage.local unavailable; using defaults');
      reportDiagnostics('storage-load-unavailable', 'chrome.storage.local unavailable');
      setToolbarStatus('storage-read', 'Storage unavailable; using defaults', 'warn', {
        sticky: true,
        title: 'chrome.storage.local is unavailable, so saved settings cannot be loaded'
      });
      callback();
      return;
    }

    try {
      storage.get(
        [
          STORAGE_KEY,
          AUTO_REFRESH_ENABLED_KEY,
          AUTO_REFRESH_IDLE_SECONDS_KEY,
          USER_COMMENT_FILTER_ENABLED_KEY,
          ACKNOWLEDGED_COLLAPSE_ENABLED_KEY,
          SOUND_ALERTS_ENABLED_KEY,
          DIAGNOSTICS_ENABLED_KEY
        ],
        (result) => {
          const err = getChromeStorageLastError();
          if (err) {
            console.warn('[Bosun plugin] Failed to load saved settings:', err.message || err);
            reportDiagnostics('storage-load-failed', err.message || 'unknown-error');
            setToolbarStatus('storage-read', 'Saved settings were not loaded', 'warn', {
              title: err.message || String(err)
            });
          }
          if (!err) clearToolbarStatus('storage-read');
          result = result && typeof result === 'object' ? result : {};
          showSilenced = Boolean(result[STORAGE_KEY]);
          autoRefreshEnabled = typeof result[AUTO_REFRESH_ENABLED_KEY] === 'boolean'
            ? result[AUTO_REFRESH_ENABLED_KEY]
            : true;
          autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(result[AUTO_REFRESH_IDLE_SECONDS_KEY]);
          userCommentFilterEnabled = typeof result[USER_COMMENT_FILTER_ENABLED_KEY] === 'boolean'
            ? result[USER_COMMENT_FILTER_ENABLED_KEY]
            : false;
          acknowledgedCollapseEnabled = typeof result[ACKNOWLEDGED_COLLAPSE_ENABLED_KEY] === 'boolean'
            ? result[ACKNOWLEDGED_COLLAPSE_ENABLED_KEY]
            : false;
          soundAlertsEnabled = typeof result[SOUND_ALERTS_ENABLED_KEY] === 'boolean'
            ? result[SOUND_ALERTS_ENABLED_KEY]
            : true;
          diagnosticsEnabled = DIAGNOSTICS_TOOLBAR_UI_ENABLED &&
            typeof result[DIAGNOSTICS_ENABLED_KEY] === 'boolean'
            ? result[DIAGNOSTICS_ENABLED_KEY]
            : false;
          if (!DIAGNOSTICS_TOOLBAR_UI_ENABLED && result[DIAGNOSTICS_ENABLED_KEY] === true) {
            storage.set({ [DIAGNOSTICS_ENABLED_KEY]: false });
          }
          if (!autoRefreshEnabled) {
            scheduleAutoRefreshReEnable();
          }
          callback();
        }
      );
    } catch (err) {
      console.warn('[Bosun plugin] Failed to load saved settings:', err);
      reportDiagnostics('storage-load-failed', err?.message || 'unknown-error');
      setToolbarStatus('storage-read', 'Saved settings were not loaded', 'warn', {
        title: err?.message || 'unknown-error'
      });
      callback();
    }
  }

  function installStorageChangeTracking() {
    if (settingsStore?.subscribe) {
      settingsStore.subscribe((next, previous, changedPaths) => {
        applySettingsSnapshot(next, { previous, changedPaths, initial: false });
      });
      return;
    }
    const onChanged = globalThis.chrome?.storage?.onChanged;
    if (!onChanged?.addListener) return;

    onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes || typeof changes !== 'object') return;

      if (STORAGE_KEY in changes) {
        showSilenced = Boolean(changes[STORAGE_KEY].newValue);
        applyVisibility();
      }
      if (AUTO_REFRESH_ENABLED_KEY in changes) {
        autoRefreshEnabled = changes[AUTO_REFRESH_ENABLED_KEY].newValue !== false;
        if (autoRefreshEnabled) clearAutoRefreshReEnableTimer();
        updateAutoRefreshControls();
      }
      if (AUTO_REFRESH_IDLE_SECONDS_KEY in changes) {
        autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(
          changes[AUTO_REFRESH_IDLE_SECONDS_KEY].newValue
        );
        updateAutoRefreshControls();
      }
      if (USER_COMMENT_FILTER_ENABLED_KEY in changes) {
        userCommentFilterEnabled = Boolean(changes[USER_COMMENT_FILTER_ENABLED_KEY].newValue);
        applyUserCommentFilter();
        updateUserCommentFilterControl();
      }
      if (ACKNOWLEDGED_COLLAPSE_ENABLED_KEY in changes) {
        acknowledgedCollapseEnabled = Boolean(
          changes[ACKNOWLEDGED_COLLAPSE_ENABLED_KEY].newValue
        );
        applyAcknowledgedCollapse();
        updateAcknowledgedCollapseControl();
      }
      if (SOUND_ALERTS_ENABLED_KEY in changes) {
        soundAlertsEnabled = changes[SOUND_ALERTS_ENABLED_KEY].newValue !== false;
        updateSoundAlertsControl();
      }
      if (DIAGNOSTICS_ENABLED_KEY in changes) {
        diagnosticsEnabled = Boolean(changes[DIAGNOSTICS_ENABLED_KEY].newValue);
        updateDiagnosticsControl();
      }
    });
  }

  function updateToggleText() {
    const btn = document.getElementById(TOGGLE_ID);
    const counter = document.getElementById(TOGGLE_COUNTER_ID);
    if (!btn) return;

    const labelNode = btn.querySelector('.bosun-silence-label');
    if (!labelNode) return;

    labelNode.textContent = showSilenced
      ? 'Скрыть silenced alerts'
      : 'Показать silenced alerts';

    btn.classList.toggle('is-on', showSilenced);
    btn.classList.toggle('is-neutral-off', !showSilenced);
    btn.setAttribute('aria-pressed', showSilenced ? 'true' : 'false');

    if (counter) {
      counter.textContent = String(hiddenCount);
      counter.title = `Всего silenced alerts: ${hiddenCount}`;
    }
  }

  function handleToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    showSilenced = !showSilenced;
    saveState();
    applyVisibility();
  }

  function markUserActivity() {
    if (activityApi?.markUserActivity) {
      activityApi.markUserActivity();
      return;
    }
    lastUserActivityTs = Date.now();
    updateAutoRefreshCountdown();
  }

  function setToolbarToggleButtonState(button, enabled, options = {}) {
    if (!button) return;

    const {
      onIcon = '✓',
      offIcon = '✕',
      label = '',
      offUsesNeutral = false
    } = options;

    button.classList.remove('is-on', 'is-off', 'is-neutral-off');
    button.classList.add(enabled ? 'is-on' : (offUsesNeutral ? 'is-neutral-off' : 'is-off'));

    const iconEl = button.querySelector('.bosun-toolbar-btn-icon');
    const labelEl = button.querySelector('.bosun-toolbar-btn-label');

    if (iconEl) iconEl.textContent = enabled ? onIcon : offIcon;
    if (labelEl && label) labelEl.textContent = label;

    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }

  function getAutoRefreshButtonLabel() {
    return 'Автообновление';
  }

  function getAutoRefreshRemainingSeconds() {
    if (activityApi?.getAutoRefreshRemainingSeconds) {
      return activityApi.getAutoRefreshRemainingSeconds();
    }
    const elapsedSeconds = (Date.now() - lastUserActivityTs) / 1000;
    return Math.max(0, Math.ceil(autoRefreshIdleSeconds - elapsedSeconds));
  }

  function updateAutoRefreshCountdown() {
    const countdown = document.getElementById(AUTO_REFRESH_COUNTDOWN_ID);
    if (!countdown) return;

    if (activityApi?.updateAutoRefreshCountdown) {
      activityApi.updateAutoRefreshCountdown(countdown);
      return;
    }

    if (!autoRefreshEnabled) {
      countdown.textContent = 'выкл';
      countdown.title = 'Автообновление выключено';
      countdown.removeAttribute('aria-pressed');
      countdown.setAttribute('aria-label', 'Автообновление выключено');
      return;
    }

    if (!isDashboardHome()) {
      countdown.textContent = '—';
      countdown.title = 'Автообновление страницы только на главной /';
      countdown.removeAttribute('aria-pressed');
      countdown.setAttribute('aria-label', 'Автообновление включено и работает только на главной странице');
      return;
    }

    const remaining = getAutoRefreshRemainingSeconds();
    countdown.title = `До автообновления: ${remaining} секунд`;
    countdown.textContent = `${remaining}s`;
    countdown.removeAttribute('aria-pressed');
    countdown.setAttribute(
      'aria-label',
      `Автообновление включено, осталось ${remaining} секунд`
    );
  }

  function updateAutoRefreshControls() {
    const toggle = document.getElementById(AUTO_REFRESH_TOGGLE_ID);
    const input = document.getElementById(AUTO_REFRESH_INPUT_ID);
    if (!toggle || !input) return;

    setToolbarToggleButtonState(toggle, autoRefreshEnabled, {
      onIcon: '↻',
      offIcon: '⏸',
      label: getAutoRefreshButtonLabel(),
      offUsesNeutral: true
    });

    if (document.activeElement !== input) {
      input.value = String(autoRefreshIdleSeconds);
    }
    updateAutoRefreshCountdown();
  }

  function clearAutoRefreshReEnableTimer() {
    activityApi?.clearAutoRefreshReEnableTimer?.();
  }

  function scheduleAutoRefreshReEnable() {
    activityApi?.scheduleAutoRefreshReEnable?.();
  }

  function handleAutoRefreshToggleChange(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const nextEnabled = !autoRefreshEnabled;
    if (activityApi?.handleAutoRefreshToggleChange) {
      activityApi.handleAutoRefreshToggleChange(nextEnabled);
      return;
    }
    autoRefreshEnabled = nextEnabled;
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleChange(e) {
    autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(e.target.value);
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleInput(e) {
    const numericValue = Number(e.target.value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;

    autoRefreshIdleSeconds = Math.round(numericValue);
    markUserActivity();
  }

  function handleAutoRefreshIdleKeydown(e) {
    if (e.key !== 'Enter') return;

    e.preventDefault();
    e.currentTarget.blur();
  }

  function handleAutoRefreshCountdownClick() {
    if (activityApi?.handleCountdownClick) {
      activityApi.handleCountdownClick();
      return;
    }
    autoRefreshEnabled = !autoRefreshEnabled;
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function updateSoundAlertsControl() {
    const button = document.getElementById(SOUND_ALERTS_TOGGLE_ID);
    setToolbarToggleButtonState(button, soundAlertsEnabled, {
      onIcon: '🔊',
      offIcon: '🔇',
      label: 'Звук',
      offUsesNeutral: false
    });
  }




  function updateUserCommentFilterControl() {
    const button = document.getElementById(USER_COMMENT_FILTER_TOGGLE_ID);
    setToolbarToggleButtonState(button, userCommentFilterEnabled, {
      onIcon: '!',
      offIcon: '!',
      label: 'Без комментария',
      offUsesNeutral: true
    });
    if (button) {
      button.title = userCommentFilterEnabled
        ? 'Показаны только алерты без пользовательских комментариев'
        : 'Показаны все алерты Needs Acknowledgement';
    }
  }

  function updateAcknowledgedCollapseControl() {
    const button = document.getElementById(ACKNOWLEDGED_COLLAPSE_TOGGLE_ID);
    setToolbarToggleButtonState(button, acknowledgedCollapseEnabled, {
      onIcon: '-',
      offIcon: '+',
      label: acknowledgedCollapseEnabled ? 'Показать Ack' : 'Скрыть Ack',
      offUsesNeutral: true
    });
    if (button) {
      button.title = acknowledgedCollapseEnabled
        ? 'Секция Acknowledged скрыта'
        : 'Секция Acknowledged показана';
    }
  }

  function updateDiagnosticsControl() {
    const cb = document.getElementById(DIAGNOSTICS_TOGGLE_ID);
    if (cb) cb.checked = diagnosticsEnabled;
    const openBtn = document.getElementById(DIAGNOSTICS_OPEN_BUTTON_ID);
    if (openBtn) {
      const isOpen = diagnosticsApi?.isModalOpen?.() === true;
      openBtn.textContent = isOpen ? 'Закрыть лог' : 'Открыть лог';
    }
  }

  function handleSoundAlertsToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    soundAlertsEnabled = !soundAlertsEnabled;
    markUserActivity();
    saveSoundAlertsState();
    updateSoundAlertsControl();
  }


  function handleUserCommentFilterToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    userCommentFilterEnabled = !userCommentFilterEnabled;
    markUserActivity();
    saveUserCommentFilterState();
    applyUserCommentFilter();
    updateUserCommentFilterControl();
  }

  function handleAcknowledgedCollapseToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    acknowledgedCollapseEnabled = !acknowledgedCollapseEnabled;
    markUserActivity();
    saveAcknowledgedCollapseState();
    applyAcknowledgedCollapse();
    updateAcknowledgedCollapseControl();
  }

  function handleDiagnosticsToggle(e) {
    diagnosticsEnabled = Boolean(e.target.checked);
    saveDiagnosticsState();
    updateDiagnosticsControl();
    reportDiagnostics('diag-toggled', diagnosticsEnabled ? 'on' : 'off');
  }

  function handleDiagnosticsOpenClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = diagnosticsApi?.isModalOpen?.() === true;
    setDiagnosticsModalOpen(!isOpen);
    updateDiagnosticsControl();
  }

  function ensureDiagnosticsModal() {
    return diagnosticsApi?.ensureModal?.(updateDiagnosticsControl) || null;
  }

  function ensureSoundAlertsControls(actions) {
    if (!isFeatureEnabled('soundNotifications')) {
      actions.querySelector('.bosun-sound-alerts-wrap')?.remove();
      return;
    }
    let wrap = actions.querySelector('.bosun-sound-alerts-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'bosun-toolbar-group bosun-sound-alerts-wrap';

      const button = document.createElement('button');
      button.type = 'button';
      button.id = SOUND_ALERTS_TOGGLE_ID;
      button.className = 'bosun-toolbar-btn';
      button.innerHTML = `
        <span class="bosun-toolbar-btn-icon">🔊</span>
        <span class="bosun-toolbar-btn-label">Звук</span>
      `;
      button.addEventListener('click', handleSoundAlertsToggle);
      wrap.appendChild(button);
      actions.appendChild(wrap);
    }

    updateSoundAlertsControl();
  }



  function ensureUserCommentFilterControls(actions) {
    if (!isFeatureEnabled('noCommentFilter')) {
      actions.querySelector('.bosun-user-comment-filter-wrap')?.remove();
      return;
    }
    let wrap = actions.querySelector('.bosun-user-comment-filter-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'bosun-toolbar-group bosun-user-comment-filter-wrap';

      const button = document.createElement('button');
      button.type = 'button';
      button.id = USER_COMMENT_FILTER_TOGGLE_ID;
      button.className = 'bosun-toolbar-btn';
      button.innerHTML = `
        <span class="bosun-toolbar-btn-icon">!</span>
        <span class="bosun-toolbar-btn-label">Без комментария</span>
      `;
      button.addEventListener('click', handleUserCommentFilterToggle);
      wrap.appendChild(button);
      actions.appendChild(wrap);
    }

    updateUserCommentFilterControl();
  }

  function ensureAcknowledgedCollapseControls(actions) {
    if (!isFeatureEnabled('acknowledgedCollapse')) {
      actions.querySelector('.bosun-acknowledged-collapse-wrap')?.remove();
      return;
    }
    let wrap = actions.querySelector('.bosun-acknowledged-collapse-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'bosun-toolbar-group bosun-acknowledged-collapse-wrap';

      const button = document.createElement('button');
      button.type = 'button';
      button.id = ACKNOWLEDGED_COLLAPSE_TOGGLE_ID;
      button.className = 'bosun-toolbar-btn';
      button.innerHTML = `
        <span class="bosun-toolbar-btn-icon">+</span>
        <span class="bosun-toolbar-btn-label">Скрыть Ack</span>
      `;
      button.addEventListener('click', handleAcknowledgedCollapseToggle);
      wrap.appendChild(button);
      actions.appendChild(wrap);
    }

    updateAcknowledgedCollapseControl();
  }

  function ensureDiagnosticsControls(actions) {
    if (!DIAGNOSTICS_TOOLBAR_UI_ENABLED) {
      const deadGroup = actions.querySelector('.bosun-diagnostics-group');
      if (deadGroup) deadGroup.remove();
      const deadModal = document.getElementById(DIAGNOSTICS_MODAL_ID);
      if (deadModal) deadModal.remove();
      return;
    }

    let group = actions.querySelector('.bosun-diagnostics-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'bosun-diagnostics-group';
      actions.appendChild(group);
    }

    let wrap = group.querySelector('.bosun-diagnostics-wrap');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.className = 'bosun-auto-refresh-label bosun-diagnostics-wrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = DIAGNOSTICS_TOGGLE_ID;
      cb.addEventListener('change', handleDiagnosticsToggle);
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode('Диагностика'));
      group.appendChild(wrap);
    }
    let openBtn = group.querySelector(`#${DIAGNOSTICS_OPEN_BUTTON_ID}`);
    if (!openBtn) {
      openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.id = DIAGNOSTICS_OPEN_BUTTON_ID;
      openBtn.className = 'bosun-toolbar-btn bosun-toolbar-btn-secondary';
      openBtn.textContent = 'Открыть лог';
      openBtn.title = 'Открыть окно журнала диагностики';
      openBtn.addEventListener('click', handleDiagnosticsOpenClick);
      group.appendChild(openBtn);
    }
    ensureDiagnosticsModal();
    updateDiagnosticsControl();
  }

  function ensureAutoRefreshControls(actions) {
    if (!isFeatureEnabled('autoRefresh')) {
      actions.querySelector('.bosun-auto-refresh-group')?.remove();
      return;
    }
    let group = actions.querySelector('.bosun-auto-refresh-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'bosun-toolbar-group bosun-auto-refresh-group';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.id = AUTO_REFRESH_TOGGLE_ID;
      toggle.className = 'bosun-toolbar-btn';
      toggle.innerHTML = `
        <span class="bosun-toolbar-btn-icon">↻</span>
        <span class="bosun-toolbar-btn-label">${getAutoRefreshButtonLabel()}</span>
      `;
      toggle.addEventListener('click', handleAutoRefreshToggleChange);

      const input = document.createElement('input');
      input.id = AUTO_REFRESH_INPUT_ID;
      input.className = 'bosun-toolbar-input';
      input.type = 'number';
      input.min = String(AUTO_REFRESH_MIN_IDLE_SECONDS);
      input.max = String(AUTO_REFRESH_MAX_IDLE_SECONDS);
      input.step = '1';
      input.inputMode = 'numeric';
      input.setAttribute('aria-label', 'Интервал автообновления в секундах');
      input.addEventListener('input', handleAutoRefreshIdleInput);
      input.addEventListener('change', handleAutoRefreshIdleChange);
      input.addEventListener('keydown', handleAutoRefreshIdleKeydown);

      const inputHint = document.createElement('span');
      inputHint.id = `${AUTO_REFRESH_INPUT_ID}-hint`;
      inputHint.className = 'bosun-sr-only';
      inputHint.textContent = `Допустимый диапазон: от ${AUTO_REFRESH_MIN_IDLE_SECONDS} до ${AUTO_REFRESH_MAX_IDLE_SECONDS} секунд`;
      input.setAttribute('aria-describedby', inputHint.id);

      const countdown = document.createElement('output');
      countdown.id = AUTO_REFRESH_COUNTDOWN_ID;
      countdown.className = 'bosun-toolbar-countdown';
      countdown.setAttribute('role', 'timer');
      countdown.setAttribute('aria-label', 'Состояние автообновления');

      group.appendChild(toggle);
      group.appendChild(input);
      group.appendChild(inputHint);
      group.appendChild(countdown);
      actions.appendChild(group);
    }

    updateAutoRefreshControls();
  }

  function ensureToolbarStatusIndicator(actions) {
    let status = actions.querySelector(`#${TOP_BAR_STATUS_ID}`);
    if (!status) {
      status = document.createElement('span');
      status.id = TOP_BAR_STATUS_ID;
      status.className = 'bosun-toolbar-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.hidden = true;
      actions.appendChild(status);
    }

    updateToolbarStatus();
  }

  function startAutoRefreshLoop() {
    if (!isFeatureEnabled('autoRefresh')) return;
    if (activityApi?.startAutoRefreshLoop) {
      activityApi.startAutoRefreshLoop(updateAutoRefreshCountdown);
      return;
    }
    console.warn('[Bosun plugin] Activity module unavailable; auto-refresh is disabled.');
  }

  function installUserActivityTracking() {
    if (!isFeatureEnabled('autoRefresh')) return;
    if (activityApi?.installUserActivityTracking) {
      activityApi.installUserActivityTracking();
      return;
    }
    console.warn('[Bosun plugin] Activity module unavailable; activity tracking is disabled.');
  }

  function findMainContentAnchor() {
    return (
      document.querySelector('body > .container[style*="width: 95%"]') ||
      document.querySelector('body > .container') ||
      document.body?.querySelector('.container') ||
      null
    );
  }

  function disconnectTopBarMountObserver() {
    if (topBarMountObserver) {
      topBarMountObserver.disconnect();
      topBarMountObserver = null;
    }
  }

  function scheduleTopBarMount() {
    if (!isDashboardHome()) {
      disconnectTopBarMountObserver();
      return;
    }

    const tryMount = () => {
      ensureToggleExists();
      return !!document.getElementById(TOP_BAR_ID);
    };

    if (tryMount()) return;

    if (topBarMountObserver) return;

    topBarMountObserver = new MutationObserver(() => {
      if (tryMount()) {
        disconnectTopBarMountObserver();
      }
    });
    topBarMountObserver.observe(document.documentElement, { childList: true, subtree: true });
    requestAnimationFrame(tryMount);
  }

  function ensureTopBarExists() {
    let bar = document.getElementById(TOP_BAR_ID);
    if (!isDashboardHome()) {
      if (bar) bar.remove();
      return null;
    }
    if (bar) return bar;

    const navbar = document.querySelector('.navbar.navbar-default.navbar-static-top');
    const contentContainer = findMainContentAnchor();
    if (!contentContainer && !navbar) return null;

    bar = document.createElement('div');
    bar.id = TOP_BAR_ID;
    bar.className = 'bosun-toolbar-fallback';
    bar.innerHTML = `
      <div class="bosun-top-controls-inner">
        <div class="bosun-top-controls-actions"></div>
      </div>
    `;

    if (navbar && navbar.parentNode) {
      if (navbar.nextElementSibling) {
        navbar.parentNode.insertBefore(bar, navbar.nextElementSibling);
      } else {
        navbar.parentNode.appendChild(bar);
      }
    } else if (contentContainer && contentContainer.parentNode) {
      contentContainer.parentNode.insertBefore(bar, contentContainer);
    }

    return bar;
  }

  function getTopBarActionsContainer() {
    const bar = ensureTopBarExists();
    return bar?.querySelector('.bosun-top-controls-actions') || null;
  }

  function ensureToolbarUtilityGroup(actions) {
    let group = actions.querySelector('.bosun-toolbar-utility-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'bosun-toolbar-utility-group';
      actions.appendChild(group);
    }
    return group;
  }

  function ensureToggleExists() {
    if (!isDashboardHome()) {
      document.getElementById(TOP_BAR_ID)?.remove();
      return;
    }
    const actions = getTopBarActionsContainer();
    if (!actions) return;
    ensureSoundAlertsControls(actions);
    ensureUserCommentFilterControls(actions);
    ensureAcknowledgedCollapseControls(actions);
    ensureAutoRefreshControls(actions);
    ensureToolbarStatusIndicator(actions);
    ensureNewAlertNotice();
    ensureDiagnosticsControls(actions);
    const utilityGroup = ensureToolbarUtilityGroup(actions);

    let btn = document.getElementById(TOGGLE_ID);
    let counter = document.getElementById(TOGGLE_COUNTER_ID);

    if (!isFeatureEnabled('silencedFilter')) {
      btn?.remove();
      settingsUi?.mount?.(utilityGroup);
      return;
    }

    if (!btn) {
      btn = document.createElement('button');
      btn.id = TOGGLE_ID;
      btn.type = 'button';
      btn.className = 'bosun-toolbar-btn';

      const label = document.createElement('span');
      label.className = 'bosun-silence-label bosun-toolbar-btn-label';
      btn.appendChild(label);
      btn.addEventListener('click', handleToggleClick, true);
    }

    if (!counter) {
      counter = document.createElement('span');
      counter.id = TOGGLE_COUNTER_ID;
      counter.className = 'bosun-toolbar-badge';
    }

    if (counter.parentElement !== btn) {
      btn.appendChild(counter);
    }
    if (btn.parentElement !== utilityGroup) {
      utilityGroup.appendChild(btn);
    }
    settingsUi?.mount?.(utilityGroup);
    updateToggleText();
  }

  function getNeedsAckRoot() {
    return document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"]');
  }

  function getGroupPanels() {
    const root = getNeedsAckRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll('.panel-group > .panel')).filter((panel) => {
      const heading = getPanelHeading(panel);
      return !!heading?.querySelector('[ng-bind="group.Subject"]');
    });
  }

  function getChildAlertPanels() {
    const root = getNeedsAckRoot();
    if (!root) return [];

    const byHeading = Array.from(root.querySelectorAll('.panel-heading[ng-click="toggle()"]'))
      .filter((heading) => {
        return !!(
          heading.querySelector('[ts-since="child.Ago"]') ||
          heading.querySelector('[ng-bind="child.Subject || child.AlertKey"]')
        );
      })
      .map((heading) => heading.closest('.panel'));

    const byRepeat = Array.from(root.querySelectorAll('[ng-repeat="child in group.Children"]'))
      .map((node) => node.closest('.panel') || node);

    return uniqueNodes([...byHeading, ...byRepeat]).filter(Boolean);
  }

  function getChildHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function getPanelIdFromHeading(heading) {
    const idNode = heading?.querySelector('span[ng-show="state.Id"]');
    if (!idNode) return null;
    const match = idNode.textContent.match(/#(\d+)/);
    return match ? match[1] : null;
  }

  function getPanelSubjectFromHeading(heading) {
    const subjectNode = heading?.querySelector('[ng-bind="child.Subject || child.AlertKey"]');
    if (subjectNode?.textContent?.trim()) return subjectNode.textContent.trim();

    const idNode = heading?.querySelector('span[ng-show="state.Id"]');
    let text = heading?.querySelector('.panel-title')?.textContent || heading?.textContent || '';

    if (idNode?.textContent) text = text.replace(idNode.textContent, '');

    const ageNode = heading?.querySelector('[ts-since="child.Ago"], .pull-right[ts-since]');
    if (ageNode?.textContent) text = text.replace(ageNode.textContent, '');

    return text.replace(/\s+/g, ' ').trim() || null;
  }

  function getGroupSubjectFromPanel(groupPanel) {
    const subjectNode = getPanelHeading(groupPanel)?.querySelector('[ng-bind="group.Subject"]');
    return subjectNode?.textContent?.replace(/\s+/g, ' ').trim() || null;
  }

  function buildChildMarkerKey(id, groupSubject, childSubject, ago) {
    const normalizedId = id != null && String(id).trim() ? String(id).trim() : '';
    if (normalizedId) return `id:${normalizedId}`;

    const g = typeof groupSubject === 'string' ? groupSubject.trim() : '';
    const c = typeof childSubject === 'string' ? childSubject.trim() : '';
    const a = typeof ago === 'string' ? ago.trim() : '';

    if (g && c && a) return `g:${g}|c:${c}|ago:${a}`;
    if (g && c) return `g:${g}|c:${c}`;
    if (c && a) return `c:${c}|ago:${a}`;
    if (c) return `c:${c}`;
    if (g) return `g:${g}`;
    return null;
  }

  function getPanelAgoFromHeading(heading) {
    const ageNode = heading?.querySelector('[ts-since="child.Ago"], .pull-right[ts-since]');
    return ageNode?.textContent?.replace(/\s+/g, ' ').trim() || null;
  }

  function buildChildMarkerKeyFromData(child, group) {
    return buildChildMarkerKey(
      child?.State?.Id,
      typeof group?.Subject === 'string' ? group.Subject : '',
      (typeof child?.Subject === 'string' && child.Subject.trim())
        ? child.Subject
        : (typeof child?.AlertKey === 'string' ? child.AlertKey : ''),
      typeof child?.Ago === 'string' ? child.Ago : ''
    );
  }

  function buildChildMarkerKeyFromHeading(heading, groupPanel) {
    if (!heading) return null;
    const panelId = getPanelIdFromHeading(heading);
    const groupSubject = getGroupSubjectFromPanel(groupPanel);
    const subject = getPanelSubjectFromHeading(heading);
    const ago = getPanelAgoFromHeading(heading);
    return buildChildMarkerKey(panelId, groupSubject, subject, ago);
  }

  function getGroupChildPanels(groupPanel) {
    if (!groupPanel) return [];
    return Array.from(groupPanel.querySelectorAll('[ng-repeat="child in group.Children"]'))
      .map((node) => node.closest('.panel') || node)
      .filter(Boolean);
  }

  function buildGroupMarkerKey(groupSubject, childKeys) {
    const g = typeof groupSubject === 'string' ? groupSubject.trim() : '';
    const normalizedChildKeys = Array.isArray(childKeys)
      ? childKeys.filter((key) => typeof key === 'string' && key)
      : [];

    if (g && normalizedChildKeys.length) {
      return `group:${g}|children:${normalizedChildKeys.slice().sort().join(',')}`;
    }
    if (g) return `group:${g}`;
    if (normalizedChildKeys.length) return `children:${normalizedChildKeys.slice().sort().join(',')}`;
    return null;
  }

  function buildGroupMarkerKeyFromData(group) {
    const groupSubject = typeof group?.Subject === 'string' ? group.Subject : '';
    const children = sharedUtils?.normalizeNeedAckChildren
      ? sharedUtils.normalizeNeedAckChildren(group?.Children)
      : (Array.isArray(group?.Children) ? group.Children : (group?.Children ? [group.Children] : []));
    const childKeys = children
      .map((child) => buildChildMarkerKeyFromData(child, group))
      .filter((key) => typeof key === 'string' && key);
    return buildGroupMarkerKey(groupSubject, childKeys);
  }

  function getAlertGroupsFromPayload(payload) {
    const groups = payload?.Groups;
    if (!groups || typeof groups !== 'object') return [];

    const result = [];
    Object.keys(groups).forEach((name) => {
      const list = groups[name];
      if (Array.isArray(list)) result.push(...list);
    });
    return result;
  }

  function getExactAlertName(child) {
    const candidates = [child?.Alert, child?.State?.Alert]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    const unique = Array.from(new Set(candidates));
    return unique.length === 1 ? unique[0] : '';
  }

  function getRuleGraphAlertNames(payload) {
    const names = new Set();
    for (const group of getAlertGroupsFromPayload(payload)) {
      const children = sharedUtils?.normalizeNeedAckChildren
        ? sharedUtils.normalizeNeedAckChildren(group?.Children)
        : (Array.isArray(group?.Children) ? group.Children : (group?.Children ? [group.Children] : []));
      for (const child of children) {
        const name = getExactAlertName(child);
        if (name) names.add(name);
      }
    }
    return Array.from(names);
  }

  function getRuleGraphRawQuery(child) {
    const expr = child?.State?.Expr || child?.Expr || '';
    if (!ruleGraphResolver) return extractPromrasQuery(expr);

    const sourceState = ruleGraphResolver.getSnapshot?.() || { available: false };
    const alertName = getExactAlertName(child);
    if (!alertName) return '';
    const resolution = alertName ? ruleGraphResolver.getResolution?.(alertName) : null;
    if (resolution?.ok && typeof resolution.query === 'string') {
      return resolution.query;
    }
    if (resolution && resolution.reason !== 'no_usage_graph') return '';
    if (sourceState.available && !resolution) return '';
    const fallbackAllowed = resolution?.reason === 'no_usage_graph' ||
      sourceState.reason === 'config_unavailable' ||
      sourceState.reason === 'hash_unavailable';
    return fallbackAllowed ? extractPromrasQuery(expr) : '';
  }

  function reportRuleGraphRejections(alertNames) {
    const allowedReasons = new Set([
      'no_usage_graph',
      'multi_query_graph',
      'computed_graph',
      'legacy_prom',
      'unresolved_variable',
      'cyclic_variable',
      'invalid_promras',
      'invalid_rule_source'
    ]);
    const counts = new Map();
    for (const alertName of alertNames) {
      const resolution = ruleGraphResolver?.getResolution?.(alertName);
      const reason = resolution?.ok ? '' : resolution?.reason;
      if (!allowedReasons.has(reason)) continue;
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    if (counts.size) {
      const summary = Array.from(counts.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(',');
      reportDiagnostics('grafana-rule-graph-rejected', summary);
    }
  }

  function handleRuleGraphInvalidation() {
    if (
      !latestAlertsPayload ||
      !isDashboardEnhancementsPage() ||
      !isFeatureEnabled('grafanaIntegration')
    ) return;
    rebuildGrafanaQueryIndex(latestAlertsPayload);
    ensureGrafanaQueryButtons();
  }

  function refreshRuleGraphDefinitions(payload) {
    if (
      !ruleGraphResolver?.refresh ||
      !isFeatureEnabled('grafanaIntegration') ||
      !isDashboardEnhancementsPage()
    ) return;
    const names = getRuleGraphAlertNames(payload);
    if (!names.length) return;
    const generation = ++ruleGraphLifecycleGeneration;
    ruleGraphResolver.refresh(names).then((sourceState) => {
      if (
        generation !== ruleGraphLifecycleGeneration ||
        !latestAlertsPayload ||
        !isDashboardEnhancementsPage() ||
        !isFeatureEnabled('grafanaIntegration')
      ) return;
      rebuildGrafanaQueryIndex(latestAlertsPayload);
      ensureGrafanaQueryButtons();
      if (sourceState?.available) reportRuleGraphRejections(names);
      if (!sourceState?.available) {
        reportDiagnostics('grafana-rule-source-unavailable', sourceState?.reason || 'config_unavailable');
      }
    }).catch(() => {
      if (generation !== ruleGraphLifecycleGeneration) return;
      rebuildGrafanaQueryIndex(latestAlertsPayload);
      ensureGrafanaQueryButtons();
      reportDiagnostics('grafana-rule-source-unavailable', 'config_unavailable');
    });
  }

  function rebuildGrafanaQueryIndex(payload) {
    grafanaQueryById.clear();
    grafanaQueryByKey.clear();
    ambiguousGrafanaIds.clear();
    ambiguousGrafanaKeys.clear();
    const entries = [];
    const idCounts = new Map();
    const keyCounts = new Map();

    for (const group of getAlertGroupsFromPayload(payload)) {
      const children = sharedUtils?.normalizeNeedAckChildren
        ? sharedUtils.normalizeNeedAckChildren(group?.Children)
        : (Array.isArray(group?.Children) ? group.Children : (group?.Children ? [group.Children] : []));

      for (const child of children) {
        const rawQuery = getRuleGraphRawQuery(child);
        const rawTags = child?.State?.Tags || child?.Tags || '';
        const alertKey = child?.State?.AlertKey || child?.AlertKey || '';
        const query = applyAlertTagsToPromQuery(
          rawQuery,
          rawTags,
          alertKey
        );
        const childId = child?.State?.Id != null ? String(child.State.Id) : null;
        const childKey = buildChildMarkerKeyFromData(child, group);
        entries.push({
          childId,
          childKey,
          query
        });
        if (childId) idCounts.set(childId, (idCounts.get(childId) || 0) + 1);
        if (childKey) keyCounts.set(childKey, (keyCounts.get(childKey) || 0) + 1);
      }
    }

    for (const entry of entries) {
      const unsafe = (entry.childId && idCounts.get(entry.childId) > 1) ||
        (entry.childKey && keyCounts.get(entry.childKey) > 1);
      if (unsafe) {
        if (entry.childId) ambiguousGrafanaIds.add(entry.childId);
        if (entry.childKey) ambiguousGrafanaKeys.add(entry.childKey);
        continue;
      }
      if (!entry.query) continue;
      if (entry.childId) grafanaQueryById.set(entry.childId, entry.query);
      if (entry.childKey) grafanaQueryByKey.set(entry.childKey, entry.query);
    }
  }

  function buildGroupMarkerKeyFromDom(groupPanel) {
    const groupSubject = getGroupSubjectFromPanel(groupPanel) || '';
    const childKeys = getGroupChildPanels(groupPanel)
      .map((childPanel) => buildChildMarkerKeyFromHeading(getChildHeading(childPanel), groupPanel))
      .filter((key) => typeof key === 'string' && key);
    return buildGroupMarkerKey(groupSubject, childKeys);
  }

  function findParentGroupPanelForChild(childPanel) {
    if (!childPanel) return null;

    let ancestor = childPanel.parentElement;
    while (ancestor) {
      if (
        ancestor.classList?.contains('panel') &&
        getPanelHeading(ancestor)?.querySelector('[ng-bind="group.Subject"]')
      ) {
        return ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function rebuildAlertDataIndex(payload) {
    const nextIndex = alertsDataApi?.rebuildAlertDataIndex?.(payload, {
      buildChildMarkerKeyFromData,
      buildGroupMarkerKeyFromData,
      normalizeNeedAckChildren: (raw) => {
        if (sharedUtils?.normalizeNeedAckChildren) {
          return sharedUtils.normalizeNeedAckChildren(raw);
        }
        if (raw == null) return [];
        return Array.isArray(raw) ? raw : [raw];
      }
    }) || {
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
    childOldNoNoteById.clear();
    childOldNoNoteByKey.clear();
    childHasNoteById.clear();
    childHasNoteByKey.clear();
    childHasUserCommentById.clear();
    childHasUserCommentByKey.clear();
    groupHasOldNoNoteByKey.clear();
    groupHasAnyNoteByKey.clear();
    groupHasAnyUserCommentByKey.clear();
    groupHasOldNoNoteBySubject.clear();
    groupHasAnyNoteBySubject.clear();
    groupHasAnyUserCommentBySubject.clear();
    groupCountBySubject.clear();
    for (const [key, value] of nextIndex.childOldNoNoteById) childOldNoNoteById.set(key, value);
    for (const [key, value] of nextIndex.childOldNoNoteByKey) childOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteById) childHasNoteById.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteByKey) childHasNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasUserCommentById || []) childHasUserCommentById.set(key, value);
    for (const [key, value] of nextIndex.childHasUserCommentByKey || []) childHasUserCommentByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteByKey) groupHasOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteByKey) groupHasAnyNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyUserCommentByKey || []) groupHasAnyUserCommentByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteBySubject) groupHasOldNoNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteBySubject) groupHasAnyNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyUserCommentBySubject || []) groupHasAnyUserCommentBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupCountBySubject || []) groupCountBySubject.set(key, value);
    alertDataIndexReady = true;
    rebuildGrafanaQueryIndex(payload);
  }

  function ensureStateIcon(title, type) {
    if (!title) return;

    const warnSelector = `.${OLD_NO_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`;
    const noteSelector = `.${HAS_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`;

    const warnIcon = title.querySelector(warnSelector);
    const noteIcon = title.querySelector(noteSelector);

    if (type === 'warning') {
      if (noteIcon) noteIcon.remove();
      if (!warnIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS} ${NO_SELECT_CLASS}`;
        icon.title = OLD_NO_NOTE_MINUTES > 0
          ? `Старше ${OLD_NO_NOTE_MINUTES} мин. и без Note`
          : 'Нет активного Note';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.title);
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (type === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS} ${NO_SELECT_CLASS}`;
        icon.title = 'Есть активный Note';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.title);
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (warnIcon) warnIcon.remove();
    if (noteIcon) noteIcon.remove();
  }

  function getExistingParentMarkerState(groupPanel) {
    const heading = getPanelHeading(groupPanel);
    const title = heading?.querySelector('.panel-title');
    if (!title) return 'none';

    if (title.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`)) {
      return 'warning';
    }
    if (title.querySelector(`.${HAS_NOTE_ICON_CLASS}.bosun-parent-marker`)) {
      return 'note';
    }

    return 'none';
  }

  function ensureChildStateIcon(panel, state) {
    const heading = getChildHeading(panel);
    const title = heading?.querySelector('.panel-title');
    ensureStateIcon(title, state);
  }

  function ensureParentStateIcon(groupPanel, state) {
    const heading = getPanelHeading(groupPanel);
    const title = heading?.querySelector('.panel-title');
    if (!title) return;

    const warnSelector = `.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`;
    const noteSelector = `.${HAS_NOTE_ICON_CLASS}.bosun-parent-marker`;

    const warnIcon = title.querySelector(warnSelector);
    const noteIcon = title.querySelector(noteSelector);

    if (state === 'warning') {
      if (noteIcon) noteIcon.remove();
      if (!warnIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS} bosun-parent-marker ${NO_SELECT_CLASS}`;
        icon.title = OLD_NO_NOTE_MINUTES > 0
          ? `Есть алерты старше ${OLD_NO_NOTE_MINUTES} мин. без Note`
          : 'Есть алерты без активного Note';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.title);
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (state === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS} bosun-parent-marker ${NO_SELECT_CLASS}`;
        icon.title = 'Есть алерты с активным Note';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.title);
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (warnIcon) warnIcon.remove();
    if (noteIcon) noteIcon.remove();
  }

  function resolveChildState(panel, parentGroupPanel = null) {
    const heading = getChildHeading(panel);
    if (!heading) return 'none';

    const panelId = getPanelIdFromHeading(heading);
    const groupPanel = parentGroupPanel || findParentGroupPanelForChild(panel);
    const childKey = buildChildMarkerKeyFromHeading(heading, groupPanel);

    let oldNoNote = false;
    let hasNote = false;

    if (panelId) {
      if (childOldNoNoteById.has(panelId)) oldNoNote = childOldNoNoteById.get(panelId) === true;
      if (childHasNoteById.has(panelId)) hasNote = childHasNoteById.get(panelId) === true;
    }

    if (!oldNoNote && !hasNote && childKey) {
      if (childOldNoNoteByKey.has(childKey)) oldNoNote = childOldNoNoteByKey.get(childKey) === true;
      if (childHasNoteByKey.has(childKey)) hasNote = childHasNoteByKey.get(childKey) === true;
    }

    if (oldNoNote) return 'warning';
    if (hasNote) return 'note';
    return 'none';
  }

  function resolveGroupStateFromDom(groupPanel) {
    if (!groupPanel) return 'none';

    const childPanels = getGroupChildPanels(groupPanel);

    let hasWarning = false;
    let hasNote = false;

    for (const childPanel of childPanels) {
      const state = resolveChildState(childPanel, groupPanel);
      if (state === 'warning') hasWarning = true;
      else if (state === 'note') hasNote = true;
    }

    if (hasWarning) return 'warning';
    if (hasNote) return 'note';

    const domHasWarning = !!groupPanel.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`);
    const domHasNote = !!groupPanel.querySelector(`.${HAS_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`);

    if (domHasWarning) return 'warning';
    if (domHasNote) return 'note';

    return 'none';
  }

  function resolveGroupState(groupPanel) {
    const groupKey = buildGroupMarkerKeyFromDom(groupPanel);
    const groupSubject = getGroupSubjectFromPanel(groupPanel);

    const domState = resolveGroupStateFromDom(groupPanel);
    if (domState !== 'none') return domState;

    if (groupKey) {
      const hasOldNoNote = groupHasOldNoNoteByKey.get(groupKey) === true;
      const hasAnyNote = groupHasAnyNoteByKey.get(groupKey) === true;

      if (hasOldNoNote) {
        return 'warning';
      }
      if (hasAnyNote) {
        return 'note';
      }
    }

    if (groupSubject && groupCountBySubject.get(groupSubject) === 1) {
      const hasOldNoNoteBySubject = groupHasOldNoNoteBySubject.get(groupSubject) === true;
      const hasAnyNoteBySubject = groupHasAnyNoteBySubject.get(groupSubject) === true;

      if (hasOldNoNoteBySubject) return 'warning';
      if (hasAnyNoteBySubject) return 'note';
    }

    const existingState = getExistingParentMarkerState(groupPanel);
    if (existingState !== 'none') return existingState;

    return 'none';
  }

  function applyNeedsAckMarkersFromData(options = {}) {
    const preserveExistingOnNone = options.preserveExistingOnNone === true;

    const childPanels = getChildAlertPanels();
    for (const childPanel of childPanels) {
      const state = resolveChildState(childPanel);
      if (state !== 'none') {
        ensureChildStateIcon(childPanel, state);
      } else if (!preserveExistingOnNone) {
        ensureChildStateIcon(childPanel, 'none');
      }
    }

    const groupPanels = getGroupPanels();
    for (const groupPanel of groupPanels) {
      const state = resolveGroupState(groupPanel);
      if (state !== 'none') {
        ensureParentStateIcon(groupPanel, state);
      } else if (!preserveExistingOnNone) {
        ensureParentStateIcon(groupPanel, 'none');
      }
    }
  }

  function repaintNeedsAckMarkersFast() {
    applyNeedsAckMarkersFromData({ preserveExistingOnNone: true });
  }

  async function fetchAlertsPayload(options = {}) {
    if (!alertsDataApi?.fetchAlertsDataWithRetry && (!alertsDataApi?.fetchAlertsDataViaFetch || !alertsDataApi?.fetchAlertsDataViaXHR)) {
      throw new Error('alerts-data module unavailable');
    }
    try {
      if (alertsDataApi?.fetchAlertsDataWithRetry) {
        return await alertsDataApi.fetchAlertsDataWithRetry(options);
      }
      try {
        return await alertsDataApi.fetchAlertsDataViaFetch(options);
      } catch (_) {
        return await alertsDataApi.fetchAlertsDataViaXHR(options);
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      console.warn('[Bosun plugin] Failed to refresh alerts data:', err);
      reportDiagnostics('refresh-failed', err?.message || 'unknown-error');
      setToolbarStatus('refresh', 'Не удалось синхронизировать алерты', 'error', {
        title: err?.message || 'unknown-error',
        ttlMs: 12000
      });
      throw err;
    }
  }

  function primeAlertsPayload() {
    if (primedAlertsPayload || !isDashboardEnhancementsPage()) return;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const entry = {
      startedAt: Date.now(),
      applyVersion: alertsPayloadApplyVersion,
      controller,
      promise: fetchAlertsPayload({ signal: controller?.signal })
    };
    primedAlertsPayload = entry;
    entry.promise.then((payload) => {
      if (isDashboardEnhancementsPage() && alertsPayloadApplyVersion === entry.applyVersion) {
        singleAlertAgeApi?.update?.(payload, { source: 'prime', fetchedAt: Date.now() });
        if (isFeatureEnabled('singleAlertAge')) singleAlertAgeApi?.refresh?.();
      }
    }).catch(() => {});
  }

  function consumeAlertsPayload(options = {}) {
    const entry = primedAlertsPayload;
    primedAlertsPayload = null;
    if (entry && Date.now() - entry.startedAt <= DATA_REFRESH_MS) {
      if (options.signal?.aborted) entry.controller?.abort?.();
      const onAbort = () => entry.controller?.abort?.();
      options.signal?.addEventListener?.('abort', onAbort, { once: true });
      return entry.promise.finally(() => options.signal?.removeEventListener?.('abort', onAbort));
    }
    entry?.controller?.abort?.();
    return fetchAlertsPayload(options);
  }

  function applyAlertsPayload(payload, metadata = {}) {
    if (!isDashboardEnhancementsPage()) return;
    latestAlertsPayload = payload;
    alertsPayloadApplyVersion += 1;
    singleAlertAgeApi?.update?.(payload, {
      source: metadata?.source || 'direct',
      fetchedAt: metadata?.fetchedAt || Date.now()
    });
    refreshRuleGraphDefinitions(payload);
    rebuildAlertDataIndex(payload);
    persistAlertMarkerCacheToSession();
    const trackerOwner = metadata?.source !== 'follower';
    const previousTrackerPermission = newAlertTrackerMutationAllowed;
    newAlertTrackerMutationAllowed = trackerOwner;
    try {
      needAckBaselineApi?.process?.(payload);
    } finally {
      newAlertTrackerMutationAllowed = previousTrackerPermission;
    }
    if (trackerOwner && isFeatureEnabled('visualNewAlertNotifications')) {
      newAlertTrackerApi?.reconcile?.(payload);
    }
    applyNeedsAckMarkersFromData();
    if (isFeatureEnabled('noCommentFilter')) applyUserCommentFilter();
    ensureCopyButtons();
    ensureGrafanaQueryButtons();
    if (isFeatureEnabled('lastActionEnhancements')) ensureLastActionCopyButtons();
    if (isFeatureEnabled('checkboxImprovements')) pageUtils?.ensureDashboardGroupCheckboxHitAreaGuards?.();
    markNoSelectElements();
    refreshSilencedBadges();
    if (isFeatureEnabled('singleAlertAge')) singleAlertAgeApi?.refresh?.();
    reportDiagnostics('refresh-ok', 'alerts payload received');
    clearToolbarStatus('refresh');
  }

  async function refreshAlertsData() {
    if (!isDashboardEnhancementsPage()) {
      dataRefreshQueued = false;
      return;
    }
    if (refreshCoordinatorApi?.requestRefresh) {
      refreshCoordinatorApi.requestRefresh('direct');
      return;
    }
    if (dataRefreshInFlight) {
      dataRefreshQueued = true;
      return;
    }
    dataRefreshInFlight = true;
    try {
      applyAlertsPayload(await consumeAlertsPayload());
    } catch (_) {
      // fetchAlertsPayload already reported a user-visible error.
    } finally {
      dataRefreshInFlight = false;
      if (dataRefreshQueued) {
        dataRefreshQueued = false;
        setTimeout(() => refreshAlertsData(), 50);
      }
    }
  }

  function startDataRefreshLoop() {
    if (refreshCoordinatorApi?.start) {
      if (isDashboardEnhancementsPage()) refreshCoordinatorApi.start();
      return;
    }
    if (dataRefreshTimer) return;

    const scheduleNext = () => {
      const delayMs = document.visibilityState === 'hidden' || !isDashboardEnhancementsPage()
        ? DATA_REFRESH_HIDDEN_MS
        : DATA_REFRESH_MS;
      dataRefreshTimer = setTimeout(async () => {
        dataRefreshTimer = null;
        await refreshAlertsData();
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();

    if (!dataVisibilityTrackingInstalled) {
      dataVisibilityTrackingInstalled = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isDashboardEnhancementsPage()) {
          scheduleAlertsDataRefresh();
        }
      }, { passive: true });
    }
  }

  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;
    for (const node of expectedExtensionClassNodes) expectedExtensionClassStates.delete(node);
    expectedExtensionClassNodes.clear();

    function isExtensionOwnedNode(node) {
      if (!node || node.nodeType !== 1) return false;
      return Boolean(
        singleAlertAgeApi?.isSynchronizedMutationNode?.(node) ||
        node.id === TOP_BAR_ID ||
        node.closest?.(`#${TOP_BAR_ID}`) ||
        node.matches?.(
          `.${OLD_NO_NOTE_ICON_CLASS}, .${HAS_NOTE_ICON_CLASS}, .${SILENCED_BADGE_CLASS}, ` +
          `.${COPY_BUTTON_CLASS}, .${COPY_ALL_BUTTON_CLASS}, .${COPY_LAST_ACTION_BUTTON_CLASS}, ` +
          `.${LAST_ACTION_LINK_CLASS}, .${LAST_ACTION_TIME_TEXT_CLASS}, ` +
          `.${GRAFANA_QUERY_BUTTON_CLASS}`
        )
      );
    }

    function isExtensionOwnedClassMutation(mutation) {
      if (mutation?.type !== 'attributes' || mutation.attributeName !== 'class') return false;
      const target = mutation.target;
      if (!target || target.nodeType !== 1) return false;
      const expectedStates = expectedExtensionClassStates.get(target);
      if (!expectedStates?.size) return false;
      const before = new Set(String(mutation.oldValue || '').split(/\s+/).filter(Boolean));
      const after = new Set(Array.from(target.classList || []));
      const changed = new Set([
        ...Array.from(before).filter((name) => !after.has(name)),
        ...Array.from(after).filter((name) => !before.has(name))
      ]);
      if (changed.size && Array.from(changed).some((name) => !expectedStates.has(name))) return false;
      return Array.from(expectedStates).every(([name, expected]) => after.has(name) === expected);
    }

    function isNeedsAckNode(node, needsAckRoot) {
      if (!node || node.nodeType !== 1 || isExtensionOwnedNode(node)) return false;

      if (needsAckRoot && (node === needsAckRoot || needsAckRoot.contains(node))) {
        return true;
      }

      if (node.matches?.('[ts-ack-group="schedule.Groups.NeedAck"]')) {
        return true;
      }

      return !!node.querySelector?.('[ts-ack-group="schedule.Groups.NeedAck"]');
    }

    function mutationChangesNeedsAckGroups(mutation, changedChildren, needsAckRoot) {
      if (mutation?.type !== 'childList' || !changedChildren.length) return false;
      if (changedChildren.some((node) => (
        node.matches?.('[ts-ack-group="schedule.Groups.NeedAck"]') ||
        node.querySelector?.('[ts-ack-group="schedule.Groups.NeedAck"]')
      ))) return true;
      const target = mutation.target;
      const groupList = needsAckRoot?.querySelector?.(':scope > .panel-group');
      return target === groupList && changedChildren.some((node) => node.matches?.('.panel'));
    }

    function collectRelevantMutationNodes(mutation) {
      const nodes = [];
      if (mutation.target && mutation.target.nodeType === 1) {
        nodes.push(mutation.target);
      } else if (mutation.target?.parentElement) {
        nodes.push(mutation.target.parentElement);
      }

      if (mutation.type === 'childList') {
        if (mutation.addedNodes) nodes.push(...Array.from(mutation.addedNodes));
        if (mutation.removedNodes) nodes.push(...Array.from(mutation.removedNodes));
      }

      return uniqueNodes(nodes);
    }

    function isUiRelevantNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (singleAlertAgeApi?.isSynchronizedMutationNode?.(node)) return false;
      if (node.id === TOGGLE_ID || node.closest?.(`#${TOGGLE_ID}`)) return false;
      if (node.id === TOP_BAR_ID || node.closest?.(`#${TOP_BAR_ID}`)) return false;
      if (node.classList?.contains(OLD_NO_NOTE_ICON_CLASS) || node.closest?.(`.${OLD_NO_NOTE_ICON_CLASS}`)) return false;
      if (node.classList?.contains(HAS_NOTE_ICON_CLASS) || node.closest?.(`.${HAS_NOTE_ICON_CLASS}`)) return false;

      if (
        node === document.body ||
        node.matches?.('.container, .panel, .panel-heading, .navbar, [ts-ack-group], [ts-ack-item], [ng-repeat], [ng-bind]') ||
        node.closest?.('.container, .panel, .navbar, [ts-ack-group], [ts-ack-item]') ||
        node.querySelector?.('.panel, [ts-ack-group], [ts-ack-item], [ng-repeat], [ng-bind]')
      ) {
        return true;
      }

      return false;
    }

    const processMutations = (mutations) => {
      if (isDashboardEnhancementsPage()) {
        for (const mutation of mutations) {
          if (mutation.type !== 'childList') continue;
          for (const node of mutation.addedNodes || []) {
            if (node?.nodeType === 1) {
              if (isFeatureEnabled('checkboxImprovements')) {
                pageUtils?.ensureDashboardGroupCheckboxHitAreaGuards?.(node);
              }
            }
          }
        }
      }
      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        markUserActivity();
        resetNeedAckSoundBaseline();
        handleRouteChange();
      }
      if (!isDashboardEnhancementsPage() && !isActionPage()) {
        for (const node of expectedExtensionClassNodes) expectedExtensionClassStates.delete(node);
        expectedExtensionClassNodes.clear();
        return;
      }

      let shouldRefreshUi = false;
      let shouldRefreshData = false;
      const needsAckRoot = getNeedsAckRoot();
      const ageResetProblems = [];
      const ageDebugEnabled = isFeatureEnabled('singleAlertAge') && singleAlertAgeApi?.isDebugEnabled?.() === true;

      for (const mutation of mutations) {
        if (isExtensionOwnedClassMutation(mutation)) continue;
        const changedNodes = collectRelevantMutationNodes(mutation);
        if (!changedNodes.length) continue;
        const changedChildren = mutation.type === 'childList'
          ? [...Array.from(mutation.addedNodes || []), ...Array.from(mutation.removedNodes || [])]
              .filter((node) => node?.nodeType === 1)
          : [];
        const extensionOnlyChildChange =
          changedChildren.length > 0 &&
          changedChildren.every(isExtensionOwnedNode);
        const mutationConsideredOwn = ageDebugEnabled && changedNodes.some(isExtensionOwnedNode);
        let mutationRequestsRepaint = false;

        for (const node of changedNodes) {
          if (isUiRelevantNode(node)) {
            mutationRequestsRepaint = true;
            shouldRefreshUi = true;
          }

          const mutationCanChangeAlertData =
            (!extensionOnlyChildChange && mutationChangesNeedsAckGroups(mutation, changedChildren, needsAckRoot)) ||
            mutation.attributeName === 'ts-ack-group';
          const agePresentationMutation = isFeatureEnabled('singleAlertAge') && singleAlertAgeApi?.isManagedNode?.(node) === true;
          if (mutationCanChangeAlertData && !agePresentationMutation && isNeedsAckNode(node, needsAckRoot)) {
            shouldRefreshData = true;
            break;
          }
        }
        if (ageDebugEnabled) {
          const problem = singleAlertAgeApi?.captureAgeReset?.(mutation, {
            consideredOwn: mutationConsideredOwn,
            repaint: mutationRequestsRepaint
          });
          if (problem) ageResetProblems.push(problem);
        }
      }

      for (const node of expectedExtensionClassNodes) expectedExtensionClassStates.delete(node);
      expectedExtensionClassNodes.clear();

      if (shouldRefreshUi) {
        if (isDashboardEnhancementsPage() && isFeatureEnabled('singleAlertAge')) singleAlertAgeApi?.refresh?.();
        scheduleRefresh({ skipSingleAlertAge: true });
      }

      for (const problem of ageResetProblems) {
        singleAlertAgeApi?.completeAgeReset?.(problem, shouldRefreshUi);
      }

      if (shouldRefreshData) {
        scheduleAlertsDataRefresh();
      }
    };

    const scopedObservers = new Map();
    syncScopedDomObservers = () => {
      const desiredRoots = new Map();
      if (isDashboardEnhancementsPage()) {
        const needsAckRoot = getNeedsAckRoot();
        const acknowledgedRoot = getAcknowledgedRoot();
        if (needsAckRoot) desiredRoots.set('NeedAck', needsAckRoot);
        if (acknowledgedRoot) desiredRoots.set('Acknowledged', acknowledgedRoot);
      }

      for (const [type, entry] of scopedObservers) {
        if (desiredRoots.get(type) === entry.root) continue;
        entry.observer.disconnect();
        scopedObservers.delete(type);
      }
      for (const [type, root] of desiredRoots) {
        if (scopedObservers.has(type)) continue;
        const observer = new MutationObserver(processMutations);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ['class', 'ts-ack-group', 'ts-ack-item']
        });
        scopedObservers.set(type, { root, observer });
        if (isFeatureEnabled('checkboxImprovements')) {
          pageUtils?.ensureDashboardGroupCheckboxHitAreaGuards?.(root);
        }
      }
    };

    function mutationContainsDashboardRoot(mutation) {
      const nodes = [...Array.from(mutation.addedNodes || []), ...Array.from(mutation.removedNodes || [])];
      return nodes.some((node) => node?.nodeType === 1 && (
        node.matches?.('[ts-ack-group="schedule.Groups.NeedAck"], [ts-ack-group="schedule.Groups.Acknowledged"]') ||
        node.querySelector?.('[ts-ack-group="schedule.Groups.NeedAck"], [ts-ack-group="schedule.Groups.Acknowledged"]')
      ));
    }

    const discoveryObserver = new MutationObserver((mutations) => {
      const previousUrl = lastKnownUrl;
      const currentUrl = window.location.href;
      if (currentUrl !== previousUrl) {
        lastKnownUrl = currentUrl;
        markUserActivity();
        resetNeedAckSoundBaseline();
        handleRouteChange();
      } else {
        syncScopedDomObservers();
      }
      if (isActionPage()) {
        processMutations(mutations);
      } else if (isDashboardEnhancementsPage()) {
        const rootMutations = mutations.filter(mutationContainsDashboardRoot);
        if (rootMutations.length) processMutations(rootMutations);
      }
    });

    discoveryObserver.observe(document.body, { childList: true, subtree: true });
    syncScopedDomObservers();
  }

  function init() {
    if (!isConfiguredBosunHost()) return;

    grafanaHandoffApi?.cleanupExpired?.();
    if (DIAGNOSTICS_TOOLBAR_UI_ENABLED) restoreDiagnosticsLogFromStorage();
    injectStyles();
    installSelectionGuard();
    installSelectionCopySanitizer();
    installStorageChangeTracking();
    restoreNeedAckSoundBaselineFromSession();
    restoreAlertMarkerCacheFromSession();
    window.addEventListener('pagehide', () => {
      ruleGraphLifecycleGeneration += 1;
      ruleGraphResolver?.stop?.();
      settingsUi?.destroy?.();
      if (alertMarkerCachePersistTimer) {
        clearTimeout(alertMarkerCachePersistTimer);
        alertMarkerCachePersistTimer = null;
        flushAlertMarkerCacheToSession();
      }
    });
    primeAlertsPayload();

    loadState(() => {
      markUserActivity();
      runDomRefreshPass({ preserveExistingOnNone: true });
      startObserver();
      startDataRefreshLoop();
      if (!refreshCoordinatorApi) refreshAlertsData();
      startAutoRefreshLoop();

      setTimeout(() => {
        runDomRefreshPass();
      }, 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
