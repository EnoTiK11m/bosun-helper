(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const AUTO_REFRESH_ENABLED_KEY = 'bosunAutoRefreshEnabled';
  const AUTO_REFRESH_IDLE_SECONDS_KEY = 'bosunAutoRefreshIdleSeconds';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const TOP_BAR_ID = 'bosun-top-controls-bar';
  const TOP_BAR_STATUS_ID = 'bosun-top-controls-status';
  const TOGGLE_ID = 'bosun-silence-toggle';
  const TOGGLE_COUNTER_ID = 'bosun-silence-toggle-counter';
  const AUTO_REFRESH_TOGGLE_ID = 'bosun-auto-refresh-toggle';
  const AUTO_REFRESH_INPUT_ID = 'bosun-auto-refresh-idle-seconds';
  const AUTO_REFRESH_COUNTDOWN_ID = 'bosun-auto-refresh-countdown';
  const SOUND_ALERTS_ENABLED_KEY = 'bosunSoundAlertsEnabled';
  const SOUND_ALERTS_TOGGLE_ID = 'bosun-sound-alerts-toggle';
  const DIAGNOSTICS_ENABLED_KEY = 'bosunDiagnosticsEnabled';
  const DIAGNOSTICS_TOGGLE_ID = 'bosun-diagnostics-toggle';
  const DIAGNOSTICS_OPEN_BUTTON_ID = 'bosun-diagnostics-open-button';
  const DIAGNOSTICS_MODAL_ID = 'bosun-diagnostics-modal';
  const DIAGNOSTICS_LOG_LIST_ID = 'bosun-diagnostics-log-list';

  const ACTION_TEMPLATE_WRAP_CLASS = 'bosun-action-templates';
  const ACTION_TEMPLATE_TITLE_CLASS = 'bosun-action-templates-title';
  const ACTION_TEMPLATE_BUTTONS_CLASS = 'bosun-action-templates-buttons';
  const ACTION_TEMPLATE_BUTTON_CLASS = 'bosun-action-template-btn';

  const ACTION_MESSAGE_TEMPLATES = {
    note: ['пройдет', 'пройдет через час', 'смотрю', 'в работе', 'норма', 'моргнуло', 'сдано в '],
    ack: ['пройдет', 'пройдет через час', 'норма', 'моргнуло', 'сдано в '],
    close: []
  };
  const DIAGNOSTICS_LOG_STORAGE_KEY = 'bosunDiagnosticsLogV1';
  const NEED_ACK_SOUND_BASELINE_SESSION_KEY = 'bosunNeedAckSoundBaselineV1';
  const SOUND_FILE_ALERT = 'bosun_notification_alert_chime.wav';
  const SOUND_FILE_SOFT = 'bosun_notification_soft_chime.wav';
  const COPY_BUTTON_CLASS = 'bosun-copy-alert-btn';
  const COPY_ALL_BUTTON_CLASS = 'bosun-copy-all-alerts-btn';
  const NO_SELECT_CLASS = 'bosun-no-select';
  const SILENCED_BADGE_CLASS = 'bosun-silenced-badge';

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

  const DATA_REFRESH_MS = 6000;
  const DATA_REFRESH_DEBOUNCE_MS = 250;
  const STATUS_MESSAGE_TTL_MS = 8000;
  const OLD_NO_NOTE_MINUTES = 0
  const AUTO_REFRESH_DEFAULT_IDLE_SECONDS = 60;
  const AUTO_REFRESH_MIN_IDLE_SECONDS = 10;
  const AUTO_REFRESH_MAX_IDLE_SECONDS = 3600;
  const AUTO_REFRESH_FORCE_REENABLE_MS = 10 * 60 * 1000;

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;

  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;
  let dataRefreshQueued = false;
  let dataRefreshDebounceTimer = null;
  let autoRefreshEnabled = true;
  let autoRefreshIdleSeconds = AUTO_REFRESH_DEFAULT_IDLE_SECONDS;
  let autoRefreshTimer = null;
  let autoRefreshReEnableTimer = null;
  let lastUserActivityTs = Date.now();
  let lastKnownUrl = window.location.href;
  let topBarMountObserver = null;
  let soundAlertsEnabled = true;
  let diagnosticsEnabled = false;
  let toolbarStatusSource = '';
  let toolbarStatusLevel = '';
  let toolbarStatusMessage = '';
  let toolbarStatusTitle = '';
  let toolbarStatusTimer = null;
  const DIAGNOSTICS_LOG_MAX_ENTRIES = 750;

  // child maps
  const childOldNoNoteById = new Map();
  const childOldNoNoteByKey = new Map();
  const childHasNoteById = new Map();
  const childHasNoteByKey = new Map();

  // group maps
  const groupHasOldNoNoteByKey = new Map();
  const groupHasAnyNoteByKey = new Map();
  const groupHasOldNoNoteBySubject = new Map();
  const groupHasAnyNoteBySubject = new Map();
  const lastResolvedParentStateByKey = new Map();
  const sharedUtils = globalThis.BosunSilenceHiderSharedUtils || null;
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
    getEnabled: () => soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details)
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
  const needAckBaselineApi = globalThis.BosunSilenceHiderNeedAckBaseline?.createNeedAckBaseline?.({
    sessionKey: NEED_ACK_SOUND_BASELINE_SESSION_KEY,
    isSoundEnabled: () => soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    playNeedAckChime: (kind) => soundApi?.playNeedAckChime?.(kind),
    collectCurrentIdsAndSeverity: (payload) =>
      needAckSeverityApi?.collectCurrentIdsAndSeverity?.(payload) ?? {
        currentIds: new Set(),
        idToSeverity: new Map()
      }
  }) || null;

  if (!soundApi || !needAckBaselineApi || !needAckSeverityApi || !alertsDataApi) {
    console.warn(
      '[Bosun plugin] One or more extension modules failed to load; sound, NeedAck baseline, severity, or alerts index may be disabled.',
      {
        soundApi: Boolean(soundApi),
        needAckBaselineApi: Boolean(needAckBaselineApi),
        needAckSeverityApi: Boolean(needAckSeverityApi),
        alertsDataApi: Boolean(alertsDataApi)
      }
    );
  }

  const pageUtils = globalThis.BosunSilenceHiderPageUtils?.createPageUtils?.() || null;
  const stylesApi = globalThis.BosunSilenceHiderStyles || null;
  const activityApi = globalThis.BosunSilenceHiderActivity?.createActivityTracker?.({
    pageUtils: pageUtils || {
      isDashboardHome: () => window.location.pathname === '/',
      isActionPage: () => window.location.pathname === '/action'
    },
    getAutoRefreshEnabled: () => autoRefreshEnabled,
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

  function isActionPage() {
    return pageUtils?.isActionPage?.() ?? (window.location.pathname === '/action' && window.location.search.includes('type='));
  }

  function isDashboardHome() {
    return pageUtils?.isDashboardHome?.() ?? window.location.pathname === '/';
  }

  function applyActionPageTweaks() {
    if (pageUtils?.applyActionPageTweaks) {
      pageUtils.applyActionPageTweaks();
      return;
    }
  }

  function getActionType() {
    try {
      return new URLSearchParams(window.location.search).get('type') || '';
    } catch (_) {
      return '';
    }
  }

  function getActionTemplatesForType(type) {
    return ACTION_MESSAGE_TEMPLATES[type] || [];
  }

  function findActionMessageTextarea() {
    const areas = Array.from(document.querySelectorAll('textarea'));
    if (!areas.length) return null;
    return areas.find((el) => el.offsetParent !== null) || areas[0] || null;
  }

  function setNativeTextareaValue(textarea, value) {
    if (!textarea) return;

    const proto = Object.getPrototypeOf(textarea);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    const setter = descriptor && typeof descriptor.set === 'function' ? descriptor.set : null;

    if (setter) {
      setter.call(textarea, value);
      return;
    }

    textarea.value = value;
  }

  function moveTextareaCursorToEnd(textarea) {
    if (!textarea) return;
    const pos = (textarea.value || '').length;
    try {
      textarea.setSelectionRange(pos, pos);
    } catch (_) {}
  }

  function insertTemplateIntoTextarea(textarea, value) {
    if (!textarea) return;

    const current = textarea.value || '';
    const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${value}` : value;

    setNativeTextareaValue(textarea, next);
    textarea.focus();
    moveTextareaCursorToEnd(textarea);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    textarea.focus();
    moveTextareaCursorToEnd(textarea);
  }

  function ensureActionTemplates() {
    const existing = document.querySelector(`.${ACTION_TEMPLATE_WRAP_CLASS}`);
    if (!isActionPage()) {
      existing?.remove();
      return;
    }

    const type = getActionType();
    const templates = getActionTemplatesForType(type);
    if (!templates.length) {
      existing?.remove();
      return;
    }

    const textarea = findActionMessageTextarea();
    if (!textarea || !textarea.parentElement) return;

    let wrap = existing;
    const signature = `${type}::${templates.join('|')}`;
    const alreadyBuilt = wrap
      && wrap.dataset.templateSignature === signature
      && wrap.dataset.textareaBound === '1'
      && wrap.parentElement === textarea.parentElement
      && wrap.nextElementSibling === textarea;

    if (alreadyBuilt) {
      return;
    }

    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = ACTION_TEMPLATE_WRAP_CLASS;
    }

    if (wrap.parentElement !== textarea.parentElement || wrap.nextElementSibling !== textarea) {
      textarea.parentElement.insertBefore(wrap, textarea);
    }

    wrap.textContent = '';
    wrap.dataset.templateSignature = signature;
    wrap.dataset.textareaBound = '1';

    const title = document.createElement('div');
    title.className = ACTION_TEMPLATE_TITLE_CLASS;
    title.textContent = 'Частые комментарии';
    wrap.appendChild(title);

    const buttons = document.createElement('div');
    buttons.className = ACTION_TEMPLATE_BUTTONS_CLASS;
    templates.forEach((template) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = ACTION_TEMPLATE_BUTTON_CLASS;
      btn.textContent = template;
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        insertTemplateIntoTextarea(textarea, template);
      });
      buttons.appendChild(btn);
    });
    wrap.appendChild(buttons);
  }

  function injectStyles() {
    if (!stylesApi?.injectStyles) return;

    stylesApi.injectStyles({
      hiddenClass: HIDDEN_CLASS,
      copyButtonClass: COPY_BUTTON_CLASS,
      copyAllButtonClass: COPY_ALL_BUTTON_CLASS,
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
      diagnosticsLogListId: DIAGNOSTICS_LOG_LIST_ID
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
      .forEach((el) => el.classList.add(NO_SELECT_CLASS));

    document
      .querySelectorAll('.panel-title > span.pull-right[ts-since="child.Ago"]')
      .forEach((el) => el.classList.add(NO_SELECT_CLASS));

    document
      .querySelectorAll('.panel-title > span[ng-show="state.Id"], .panel-title > span.ng-binding')
      .forEach((el) => {
        if (/^#\d+:$/.test((el.textContent || '').trim())) {
          el.classList.add(NO_SELECT_CLASS);
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

  function flashCopyButtonState(button, ok, errorText = 'error') {
    if (!button) return;
    if (button.dataset.flashTimer) {
      clearTimeout(Number(button.dataset.flashTimer));
    }
    const originalText = button.dataset.originalText || button.textContent;
    button.dataset.originalText = originalText;
    button.textContent = ok ? 'copied' : errorText;
    button.dataset.copied = ok ? 'true' : 'false';
    const timerId = setTimeout(() => {
      button.textContent = originalText;
      delete button.dataset.copied;
      delete button.dataset.originalText;
      delete button.dataset.flashTimer;
    }, ok ? 1200 : 2500);
    button.dataset.flashTimer = String(timerId);
  }

  function ensureCopyButton(panel) {
    const subjectNode = getGroupSubjectNode(panel) || getChildSubjectNode(panel);
    if (!subjectNode) return;

    if (subjectNode.parentElement?.querySelector(`.${COPY_BUTTON_CLASS}`)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = COPY_BUTTON_CLASS;
    btn.textContent = 'Copy';
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
    btn.textContent = 'Copy all';
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

  function ensureCopyButtons() {
    getAcknowledgedPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getGroupPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getChildAlertPanels().forEach((panel) => ensureCopyButton(panel));
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
    document.querySelectorAll('.panel').forEach((panel) => {
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

  function getAcknowledgedPanels() {
    const root = getAcknowledgedRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll('.panel-group > .panel'));
  }

  function isDashboardEnhancementsPage() {
    return isDashboardHome();
  }

  function runDomRefreshPass(options = {}) {
    const preserveExistingOnNone = options.preserveExistingOnNone === true;

    ensureToggleExists();
    applyVisibility();
    ensureCopyButtons();
    markNoSelectElements();
    refreshSilencedBadges();
    applyActionPageTweaks();
    ensureActionTemplates();

    if (preserveExistingOnNone) {
      repaintNeedsAckMarkersFast();
    }
  }

  function handleRouteChange() {
    if (isDashboardEnhancementsPage()) {
      scheduleTopBarMount();
    } else {
      disconnectTopBarMountObserver();
      document.getElementById(TOP_BAR_ID)?.remove();
    }

    if (!isActionPage()) {
      document.querySelector(`.${ACTION_TEMPLATE_WRAP_CLASS}`)?.remove();
    }

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
          panel.classList.add(HIDDEN_CLASS);
          nextHiddenCount++;
        } else {
          panel.classList.remove(HIDDEN_CLASS);
        }
      } else {
        panel.classList.remove(HIDDEN_CLASS);
      }
    }

    // На всякий случай гарантируем, что в Needs Acknowledgement ничего не скрыто
    const needsAckRoot = getNeedsAckRoot();
    needsAckRoot?.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((panel) => {
      panel.classList.remove(HIDDEN_CLASS);
    });

    hiddenCount = nextTotalSilencedCount;
    updateToggleText();
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refreshTimer = null;

      // Быстрый локальный repaint по текущим index maps,
      // но без удаления значков, если DOM ещё не устаканился.
      runDomRefreshPass({ preserveExistingOnNone: true });
    }, 120);
  }

  function scheduleAlertsDataRefresh() {
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
    status.textContent = isVisible ? toolbarStatusMessage : '';
    status.title = isVisible ? (toolbarStatusTitle || toolbarStatusMessage) : '';
    status.hidden = !isVisible;
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
          title: `${context}: ${err.message || err}`
        });
      });
    } catch (err) {
      console.warn(`[Bosun plugin] Failed to save ${context}:`, err);
      reportDiagnostics('storage-save-failed', `${context}: ${err?.message || 'unknown-error'}`);
      setToolbarStatus('storage-write', 'Settings were not saved', 'warn', {
        title: `${context}: ${err?.message || 'unknown-error'}`
      });
    }
  }

  function saveState() {
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
    saveToLocalStorage({
      [AUTO_REFRESH_ENABLED_KEY]: autoRefreshEnabled,
      [AUTO_REFRESH_IDLE_SECONDS_KEY]: autoRefreshIdleSeconds
    }, 'auto-refresh');
  }

  function saveSoundAlertsState() {
    saveToLocalStorage({ [SOUND_ALERTS_ENABLED_KEY]: soundAlertsEnabled }, SOUND_ALERTS_ENABLED_KEY);
  }


  function saveDiagnosticsState() {
    saveToLocalStorage({ [DIAGNOSTICS_ENABLED_KEY]: diagnosticsEnabled }, DIAGNOSTICS_ENABLED_KEY);
  }

  function resetNeedAckSoundBaseline() {
    needAckBaselineApi?.reset?.();
  }

  function restoreNeedAckSoundBaselineFromSession() {
    needAckBaselineApi?.restoreFromSession?.();
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

  function parseNeedAckStatusToBucket(raw) {
    return needAckSeverityApi?.parseNeedAckStatusToBucket?.(raw) ?? 'unknown';
  }

  /** В шаблоне Bosun у группы есть CurrentStatus; у ребёнка — State.* и Events[].Status */
  function getNeedAckSeverityBucket(child, group) {
    return needAckSeverityApi?.getNeedAckSeverityBucket?.(child, group) ?? 'unknown';
  }

  function getNeedAckSeverityFromGroupOnly(group) {
    return needAckSeverityApi?.getNeedAckSeverityFromGroupOnly?.(group) ?? 'unknown';
  }

  /** Стабильный ключ: Id -> AlertKey+Tags -> group+child+ago -> fallback */
  function needAckStableKey(child, group) {
    return needAckSeverityApi?.needAckStableKey?.(child, group) ?? null;
  }

  function loadState(callback) {
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
        [STORAGE_KEY, AUTO_REFRESH_ENABLED_KEY, AUTO_REFRESH_IDLE_SECONDS_KEY, SOUND_ALERTS_ENABLED_KEY, DIAGNOSTICS_ENABLED_KEY],
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
          soundAlertsEnabled = typeof result[SOUND_ALERTS_ENABLED_KEY] === 'boolean'
            ? result[SOUND_ALERTS_ENABLED_KEY]
            : true;
          diagnosticsEnabled = typeof result[DIAGNOSTICS_ENABLED_KEY] === 'boolean'
            ? result[DIAGNOSTICS_ENABLED_KEY]
            : false;
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
      countdown.textContent = 'off';
      countdown.title = 'Отключить автообновление';
      return;
    }

    if (!isDashboardHome()) {
      countdown.textContent = '—';
      countdown.title = 'Автообновление страницы только на главной /';
      return;
    }

    countdown.title = 'Отключить автообновление';
    countdown.textContent = `${getAutoRefreshRemainingSeconds()}s`;
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
    if (activityApi?.clearAutoRefreshReEnableTimer) {
      activityApi.clearAutoRefreshReEnableTimer();
      return;
    }
    if (!autoRefreshReEnableTimer) return;
    clearTimeout(autoRefreshReEnableTimer);
    autoRefreshReEnableTimer = null;
  }

  function scheduleAutoRefreshReEnable() {
    if (activityApi?.scheduleAutoRefreshReEnable) {
      activityApi.scheduleAutoRefreshReEnable();
      return;
    }
    clearAutoRefreshReEnableTimer();
    autoRefreshReEnableTimer = setTimeout(() => {
      autoRefreshReEnableTimer = null;
      if (autoRefreshEnabled) return;

      autoRefreshEnabled = true;
      markUserActivity();
      saveAutoRefreshState();
      updateAutoRefreshControls();
    }, AUTO_REFRESH_FORCE_REENABLE_MS);
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
    if (autoRefreshEnabled) clearAutoRefreshReEnableTimer();
    else scheduleAutoRefreshReEnable();
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
    if (!autoRefreshEnabled) return;

    autoRefreshEnabled = false;
    scheduleAutoRefreshReEnable();
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
    resetNeedAckSoundBaseline();
    updateSoundAlertsControl();
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
      input.addEventListener('input', handleAutoRefreshIdleInput);
      input.addEventListener('change', handleAutoRefreshIdleChange);
      input.addEventListener('keydown', handleAutoRefreshIdleKeydown);

      const countdown = document.createElement('span');
      countdown.id = AUTO_REFRESH_COUNTDOWN_ID;
      countdown.className = 'bosun-toolbar-countdown';
      countdown.title = 'Отключить автообновление';
      countdown.addEventListener('click', handleAutoRefreshCountdownClick);

      group.appendChild(toggle);
      group.appendChild(input);
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
      status.hidden = true;
      actions.appendChild(status);
    }

    updateToolbarStatus();
  }

  function maybeAutoRefreshPage() {
    if (activityApi?.startAutoRefreshLoop) return;
    if (isActionPage()) return;
    if (!autoRefreshEnabled || !isDashboardHome()) return;
    if (Date.now() - lastUserActivityTs < autoRefreshIdleSeconds * 1000) return;

    window.location.reload();
  }

  function startAutoRefreshLoop() {
    if (activityApi?.startAutoRefreshLoop) {
      activityApi.startAutoRefreshLoop(updateAutoRefreshCountdown);
      return;
    }

    if (autoRefreshTimer) return;

    autoRefreshTimer = setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        markUserActivity();
        resetNeedAckSoundBaseline();
        handleRouteChange();
      }

      updateAutoRefreshCountdown();
      maybeAutoRefreshPage();
    }, 1000);
  }

  function installUserActivityTracking() {
    if (activityApi?.installUserActivityTracking) {
      activityApi.installUserActivityTracking();
      return;
    }
    const activityEvents = ['click', 'keydown'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, markUserActivity, { passive: true, capture: true });
    });
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

  function ensureToggleExists() {
    if (!isDashboardHome()) {
      document.getElementById(TOP_BAR_ID)?.remove();
      return;
    }
    const actions = getTopBarActionsContainer();
    if (!actions) return;
    ensureSoundAlertsControls(actions);
    ensureAutoRefreshControls(actions);
    ensureToolbarStatusIndicator(actions);

    let btn = document.getElementById(TOGGLE_ID);
    let counter = document.getElementById(TOGGLE_COUNTER_ID);

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
    if (btn.parentElement !== actions) {
      actions.appendChild(btn);
    }
    ensureDiagnosticsControls(actions);
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
    const children = Array.isArray(group?.Children) ? group.Children : [];
    const childKeys = children
      .map((child) => buildChildMarkerKeyFromData(child, group))
      .filter((key) => typeof key === 'string' && key);
    return buildGroupMarkerKey(groupSubject, childKeys);
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
    const groups = getGroupPanels();
    for (const groupPanel of groups) {
      if (groupPanel.contains(childPanel)) return groupPanel;
    }
    return null;
  }

  function rebuildAlertDataIndex(payload) {
    const nextIndex = alertsDataApi?.rebuildAlertDataIndex?.(payload, {
      buildChildMarkerKeyFromData,
      buildGroupMarkerKeyFromData
    }) || {
      childOldNoNoteById: new Map(),
      childOldNoNoteByKey: new Map(),
      childHasNoteById: new Map(),
      childHasNoteByKey: new Map(),
      groupHasOldNoNoteByKey: new Map(),
      groupHasAnyNoteByKey: new Map(),
      groupHasOldNoNoteBySubject: new Map(),
      groupHasAnyNoteBySubject: new Map()
    };
    childOldNoNoteById.clear();
    childOldNoNoteByKey.clear();
    childHasNoteById.clear();
    childHasNoteByKey.clear();
    groupHasOldNoNoteByKey.clear();
    groupHasAnyNoteByKey.clear();
    groupHasOldNoNoteBySubject.clear();
    groupHasAnyNoteBySubject.clear();
    for (const [key, value] of nextIndex.childOldNoNoteById) childOldNoNoteById.set(key, value);
    for (const [key, value] of nextIndex.childOldNoNoteByKey) childOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteById) childHasNoteById.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteByKey) childHasNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteByKey) groupHasOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteByKey) groupHasAnyNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteBySubject) groupHasOldNoNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteBySubject) groupHasAnyNoteBySubject.set(key, value);
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
        icon.title = `Older than ${OLD_NO_NOTE_MINUTES} minutes and has no Note`;
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (type === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS} ${NO_SELECT_CLASS}`;
        icon.title = 'Contains Note';
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
        icon.title = `Contains alerts older than ${OLD_NO_NOTE_MINUTES} minutes without Note`;
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (state === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS} bosun-parent-marker ${NO_SELECT_CLASS}`;
        icon.title = 'Contains alerts with Note';
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
    if (domState !== 'none') {
      if (groupKey) lastResolvedParentStateByKey.set(groupKey, domState);
      return domState;
    }

    if (groupKey) {
      const hasOldNoNote = groupHasOldNoNoteByKey.get(groupKey) === true;
      const hasAnyNote = groupHasAnyNoteByKey.get(groupKey) === true;

      if (hasOldNoNote) {
        lastResolvedParentStateByKey.set(groupKey, 'warning');
        return 'warning';
      }
      if (hasAnyNote) {
        lastResolvedParentStateByKey.set(groupKey, 'note');
        return 'note';
      }

      const stickyState = lastResolvedParentStateByKey.get(groupKey);
      if (stickyState === 'warning' || stickyState === 'note') {
        return stickyState;
      }
    }

    if (groupSubject) {
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

  async function refreshAlertsData() {
    if (!isDashboardEnhancementsPage()) {
      dataRefreshQueued = false;
      return;
    }

    if (dataRefreshInFlight) {
      dataRefreshQueued = true;
      return;
    }

    if (dataRefreshDebounceTimer) {
      clearTimeout(dataRefreshDebounceTimer);
      dataRefreshDebounceTimer = null;
    }

    dataRefreshInFlight = true;

    try {
      let payload;
      if (!alertsDataApi?.fetchAlertsDataWithRetry && (!alertsDataApi?.fetchAlertsDataViaFetch || !alertsDataApi?.fetchAlertsDataViaXHR)) {
        throw new Error('alerts-data module unavailable');
      }
      if (alertsDataApi?.fetchAlertsDataWithRetry) {
        payload = await alertsDataApi.fetchAlertsDataWithRetry();
      } else {
        try {
          payload = await alertsDataApi.fetchAlertsDataViaFetch();
        } catch (_) {
          payload = await alertsDataApi.fetchAlertsDataViaXHR();
        }
      }

      rebuildAlertDataIndex(payload);
      needAckBaselineApi?.process?.(payload);
      applyNeedsAckMarkersFromData();
      ensureCopyButtons();
      markNoSelectElements();
      refreshSilencedBadges();
      reportDiagnostics('refresh-ok', 'alerts payload received');
      clearToolbarStatus('refresh');
    } catch (err) {
      console.warn('[Bosun plugin] Failed to refresh alerts data:', err);
      reportDiagnostics('refresh-failed', err?.message || 'unknown-error');
      setToolbarStatus('refresh', 'Alerts sync failed', 'error', {
        title: err?.message || 'unknown-error',
        ttlMs: 12000
      });
    } finally {
      dataRefreshInFlight = false;

      if (dataRefreshQueued) {
        dataRefreshQueued = false;
        setTimeout(() => {
          refreshAlertsData();
        }, 50);
      }
    }
  }

  function startDataRefreshLoop() {
    if (dataRefreshTimer) return;

    dataRefreshTimer = setInterval(() => {
      refreshAlertsData();
    }, DATA_REFRESH_MS);
  }

  function startObserver() {
    if (observerStarted || !document.body) return;
    observerStarted = true;

    function isNeedsAckNode(node, needsAckRoot) {
      if (!node || node.nodeType !== 1) return false;

      if (needsAckRoot && (node === needsAckRoot || needsAckRoot.contains(node))) {
        return true;
      }

      if (node.matches?.('[ts-ack-group="schedule.Groups.NeedAck"]')) {
        return true;
      }

      return !!node.querySelector?.('[ts-ack-group="schedule.Groups.NeedAck"]');
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

    const observer = new MutationObserver((mutations) => {
      let shouldRefreshUi = false;
      let shouldRefreshData = false;
      const needsAckRoot = getNeedsAckRoot();

      for (const mutation of mutations) {
        const changedNodes = collectRelevantMutationNodes(mutation);
        if (!changedNodes.length) continue;

        for (const node of changedNodes) {
          if (!shouldRefreshUi && isUiRelevantNode(node)) {
            shouldRefreshUi = true;
          }

          if (isNeedsAckNode(node, needsAckRoot)) {
            shouldRefreshData = true;
            break;
          }
        }
      }

      if (shouldRefreshUi) {
        scheduleRefresh();
      }

      if (shouldRefreshData) {
        scheduleAlertsDataRefresh();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'ts-ack-group', 'ts-ack-item']
    });
  }

  function init() {
    restoreDiagnosticsLogFromStorage();
    injectStyles();
    installSelectionGuard();
    installSelectionCopySanitizer();
    installUserActivityTracking();
    soundApi?.installAudioUnlockTracking?.();
    soundApi?.ensureAudioObjects?.();
    scheduleTopBarMount();
    restoreNeedAckSoundBaselineFromSession();

    loadState(() => {
      markUserActivity();
      runDomRefreshPass();
      startObserver();
      refreshAlertsData();
      startDataRefreshLoop();
      startAutoRefreshLoop();

      setTimeout(() => {
        runDomRefreshPass();
        refreshAlertsData();
      }, 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
