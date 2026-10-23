(() => {
  'use strict';

  function createToolbar({
    state,
    ACKNOWLEDGED_COLLAPSE_TOGGLE_ID,
    ACKNOWLEDGED_CONTROLS_ID,
    ACKNOWLEDGED_HEADER_ROW_CLASS,
    AUTO_REFRESH_COUNTDOWN_ID,
    AUTO_REFRESH_INPUT_ID,
    AUTO_REFRESH_MAX_IDLE_SECONDS,
    AUTO_REFRESH_MIN_IDLE_SECONDS,
    AUTO_REFRESH_TOGGLE_ID,
    DIAGNOSTICS_MODAL_ID,
    DIAGNOSTICS_OPEN_BUTTON_ID,
    DIAGNOSTICS_TOGGLE_ID,
    DIAGNOSTICS_TOOLBAR_UI_ENABLED,
    Date,
    MutationObserver,
    NEW_ALERT_NOTICE_ID,
    SOUND_ALERTS_TOGGLE_ID,
    TOGGLE_COUNTER_ID,
    TOGGLE_ID,
    TOP_BAR_ID,
    USER_COMMENT_FILTER_TOGGLE_ID,
    acknowledgedControlNodes,
    activityApi,
    applyAcknowledgedCollapse,
    applyUserCommentFilter,
    applyVisibility,
    clearOwnedElements,
    diagnosticsApi,
    document,
    ensureToolbarStatusIndicator,
    getAcknowledgedHeading,
    getAcknowledgedRoot,
    isDashboardEnhancementsPage,
    isDashboardHome,
    isFeatureEnabled,
    markUserActivity,
    normalizeAutoRefreshIdleSeconds,
    reportDiagnostics,
    requestAnimationFrame,
    saveAcknowledgedCollapseState,
    saveAutoRefreshState,
    saveDiagnosticsState,
    saveSoundAlertsState,
    saveState,
    saveUserCommentFilterState,
    setDiagnosticsModalOpen,
    setExtensionClass,
    settingsUi
  }) {

  function updateNewAlertNotice() {
    if (!isFeatureEnabled('visualNewAlertNotifications')) return;
    const notice = document.getElementById(NEW_ALERT_NOTICE_ID);
    if (!notice) return;
    const warning = Math.max(0, Number(state.newAlertNoticeCounts.warning) || 0);
    const critical = Math.max(0, Number(state.newAlertNoticeCounts.critical) || 0);
    const unknown = Math.max(0, Number(state.newAlertNoticeCounts.unknown) || 0);
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

  function updateToggleText() {
    const btn = document.getElementById(TOGGLE_ID);
    const counter = document.getElementById(TOGGLE_COUNTER_ID);
    if (!btn) return;

    const labelNode = btn.querySelector('.bosun-silence-label');
    if (!labelNode) return;

    labelNode.textContent = state.showSilenced
      ? 'Скрыть silenced alerts'
      : 'Показать silenced alerts';

    btn.classList.toggle('is-on', state.showSilenced);
    btn.classList.toggle('is-neutral-off', !state.showSilenced);
    btn.setAttribute('aria-pressed', state.showSilenced ? 'true' : 'false');

    if (counter) {
      counter.textContent = String(state.hiddenCount);
      counter.title = `Всего silenced alerts: ${state.hiddenCount}`;
    }
  }

  function handleToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    state.showSilenced = !state.showSilenced;
    saveState();
    applyVisibility();
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
    const elapsedSeconds = (Date.now() - state.lastUserActivityTs) / 1000;
    return Math.max(0, Math.ceil(state.autoRefreshIdleSeconds - elapsedSeconds));
  }

  function updateAutoRefreshCountdown() {
    const countdown = document.getElementById(AUTO_REFRESH_COUNTDOWN_ID);
    if (!countdown) return;

    if (activityApi?.updateAutoRefreshCountdown) {
      activityApi.updateAutoRefreshCountdown(countdown);
      return;
    }

    if (!state.autoRefreshEnabled) {
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

    setToolbarToggleButtonState(toggle, state.autoRefreshEnabled, {
      onIcon: '↻',
      offIcon: '⏸',
      label: getAutoRefreshButtonLabel(),
      offUsesNeutral: true
    });

    if (document.activeElement !== input) {
      input.value = String(state.autoRefreshIdleSeconds);
    }
    updateAutoRefreshCountdown();
  }

  function handleAutoRefreshToggleChange(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const nextEnabled = !state.autoRefreshEnabled;
    if (activityApi?.handleAutoRefreshToggleChange) {
      activityApi.handleAutoRefreshToggleChange(nextEnabled);
      return;
    }
    state.autoRefreshEnabled = nextEnabled;
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleChange(e) {
    state.autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(e.target.value);
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleInput(e) {
    const numericValue = Number(e.target.value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;

    state.autoRefreshIdleSeconds = Math.round(numericValue);
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
    state.autoRefreshEnabled = !state.autoRefreshEnabled;
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function updateSoundAlertsControl() {
    const button = document.getElementById(SOUND_ALERTS_TOGGLE_ID);
    setToolbarToggleButtonState(button, state.soundAlertsEnabled, {
      onIcon: '🔊',
      offIcon: '🔇',
      label: 'Звук',
      offUsesNeutral: false
    });
  }

  function updateUserCommentFilterControl() {
    const button = document.getElementById(USER_COMMENT_FILTER_TOGGLE_ID);
    setToolbarToggleButtonState(button, state.userCommentFilterEnabled, {
      onIcon: '!',
      offIcon: '!',
      label: 'Без комментария',
      offUsesNeutral: true
    });
    if (button) {
      button.title = state.userCommentFilterEnabled
        ? 'Показаны только алерты без пользовательских комментариев'
        : 'Показаны все алерты Needs Acknowledgement';
    }
  }

  function updateAcknowledgedCollapseControl() {
    const button = document.getElementById(ACKNOWLEDGED_COLLAPSE_TOGGLE_ID);
    if (!button) return;
    const enabled = isFeatureEnabled('priorityAlerts');
    const compact = state.acknowledgedCollapseEnabled && enabled;
    const label = compact ? 'Показать все' : 'Скрыть обычные';
    const labelNode = button.querySelector('.bosun-ack-toggle-label');
    if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
    const icon = button.querySelector('.fa');
    const iconClass = compact ? 'fa fa-eye' : 'fa fa-eye-slash';
    if (icon && icon.className !== iconClass) icon.className = iconClass;
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(compact));
    button.setAttribute('aria-expanded', String(!compact));
    button.title = enabled ? 'Приоритетные и непроверенные алерты остаются видимыми'
      : 'Для компактного режима включите Priority Alerts';
  }

  function updateDiagnosticsControl() {
    const cb = document.getElementById(DIAGNOSTICS_TOGGLE_ID);
    if (cb) cb.checked = state.diagnosticsEnabled;
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
    state.soundAlertsEnabled = !state.soundAlertsEnabled;
    markUserActivity();
    saveSoundAlertsState();
    updateSoundAlertsControl();
  }

  function handleUserCommentFilterToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    state.userCommentFilterEnabled = !state.userCommentFilterEnabled;
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
    state.acknowledgedCollapseEnabled = !state.acknowledgedCollapseEnabled;
    markUserActivity();
    saveAcknowledgedCollapseState();
    applyAcknowledgedCollapse();
    updateAcknowledgedCollapseControl();
  }

  function handleDiagnosticsToggle(e) {
    state.diagnosticsEnabled = Boolean(e.target.checked);
    saveDiagnosticsState();
    updateDiagnosticsControl();
    reportDiagnostics('diag-toggled', state.diagnosticsEnabled ? 'on' : 'off');
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

  function getAcknowledgedControlsMount() {
    const root = getAcknowledgedRoot(), heading = getAcknowledgedHeading();
    const bound = heading?.matches('[ng-bind], [ng-bind-html], [ng-bind-template]');
    const parent = bound ? heading.parentElement : heading || root;
    const row = bound && parent !== root && parent.matches('.clearfix') &&
      !parent.querySelector('.panel, [ts-ack-group]') ? parent : null;
    return { root, heading, bound, parent, row };
  }

  function ensureAcknowledgedCollapseControls() {
    const root = getAcknowledgedRoot();
    if (!isDashboardEnhancementsPage() || !root) return;
    clearOwnedElements('.bosun-acknowledged-collapse-wrap');
    const mount = getAcknowledgedControlsMount();
    for (const row of document.querySelectorAll(`.${ACKNOWLEDGED_HEADER_ROW_CLASS}`)) {
      if (row !== mount.row) setExtensionClass(row, ACKNOWLEDGED_HEADER_ROW_CLASS, false);
    }
    if (mount.row) setExtensionClass(mount.row, ACKNOWLEDGED_HEADER_ROW_CLASS, true);
    let wrap = document.getElementById(ACKNOWLEDGED_CONTROLS_ID);
    // Старые панели и копии DOM не принадлежат текущим обработчикам. Пересоздаём
    // только элементы расширения; штатные узлы и их привязки сохраняются.
    if (wrap && !acknowledgedControlNodes.has(wrap)) { wrap.remove(); wrap = null; }
    for (const duplicate of document.querySelectorAll(`#${ACKNOWLEDGED_CONTROLS_ID}`)) {
      if (duplicate !== wrap) duplicate.remove();
    }
    if (!wrap) {
      wrap = document.createElement('span');
      wrap.id = ACKNOWLEDGED_CONTROLS_ID;
      wrap.className = 'bosun-acknowledged-controls';
      const summary = document.createElement('span');
      summary.className = 'bosun-ack-summary';
      summary.id = 'bosun-acknowledged-summary';
      const priority = document.createElement('span');
      priority.className = 'bosun-ack-priority';
      const flag = document.createElement('span');
      flag.className = 'fa fa-flag';
      flag.setAttribute('aria-hidden', 'true');
      const priorityLabel = document.createElement('span');
      priorityLabel.className = 'bosun-ack-priority-label';
      const hiddenLabel = document.createElement('span');
      hiddenLabel.className = 'bosun-ack-hidden-label';
      priority.append(flag, priorityLabel);
      summary.append(priority, hiddenLabel);
      const button = document.createElement('button');
      button.type = 'button';
      button.id = ACKNOWLEDGED_COLLAPSE_TOGGLE_ID;
      button.className = 'btn btn-default btn-xs';
      const icon = document.createElement('span');
      icon.className = 'fa fa-eye-slash';
      icon.setAttribute('aria-hidden', 'true');
      const labelNode = document.createElement('span');
      labelNode.className = 'bosun-ack-toggle-label';
      button.append(icon, labelNode);
      button.setAttribute('aria-describedby', summary.id);
      button.addEventListener('click', handleAcknowledgedCollapseToggle);
      wrap.append(summary, button);
      acknowledgedControlNodes.add(wrap);
    }
    if (mount.bound) {
      // Сохраняем исходный порядок: заголовок → раскрытие → штатные элементы управления. Перемещаем
      // только свой элемент, после всех штатных соседей в той же строке.
      if (wrap.parentElement !== mount.parent || mount.parent.lastElementChild !== wrap) mount.parent.appendChild(wrap);
    } else if (wrap.parentElement !== mount.parent) {
      // В старых заголовках без привязок безопасно размещать встроенный элемент управления. Если
      // заголовок не распознан, показываем только небольшой элемент в начале секции.
      if (mount.heading) mount.parent.appendChild(wrap);
      else mount.parent.insertBefore(wrap, mount.parent.firstChild);
    }
    if (!root.id) {
      let suffix = 0;
      let id;
      do { id = 'bosun-acknowledged-content-' + suffix++; }
      while (document.getElementById(id));
      root.id = id;
    }
    wrap.querySelector('button').setAttribute('aria-controls', root.id);
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

  function findMainContentAnchor() {
    return (
      document.querySelector('body > .container[style*="width: 95%"]') ||
      document.querySelector('body > .container') ||
      document.body?.querySelector('.container') ||
      null
    );
  }

  function disconnectTopBarMountObserver() {
    if (state.topBarMountObserver) {
      state.topBarMountObserver.disconnect();
      state.topBarMountObserver = null;
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

    if (state.topBarMountObserver) return;

    state.topBarMountObserver = new MutationObserver(() => {
      if (tryMount()) {
        disconnectTopBarMountObserver();
      }
    });
    state.topBarMountObserver.observe(document.documentElement, { childList: true, subtree: true });
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

    return {
      updateNewAlertNotice,
      ensureNewAlertNotice,
      updateToggleText,
      handleToggleClick,
      setToolbarToggleButtonState,
      getAutoRefreshButtonLabel,
      getAutoRefreshRemainingSeconds,
      updateAutoRefreshCountdown,
      updateAutoRefreshControls,
      handleAutoRefreshToggleChange,
      handleAutoRefreshIdleChange,
      handleAutoRefreshIdleInput,
      handleAutoRefreshIdleKeydown,
      handleAutoRefreshCountdownClick,
      updateSoundAlertsControl,
      updateUserCommentFilterControl,
      updateAcknowledgedCollapseControl,
      updateDiagnosticsControl,
      handleSoundAlertsToggle,
      handleUserCommentFilterToggle,
      handleAcknowledgedCollapseToggle,
      handleDiagnosticsToggle,
      handleDiagnosticsOpenClick,
      ensureDiagnosticsModal,
      ensureSoundAlertsControls,
      ensureUserCommentFilterControls,
      getAcknowledgedControlsMount,
      ensureAcknowledgedCollapseControls,
      ensureDiagnosticsControls,
      ensureAutoRefreshControls,
      findMainContentAnchor,
      disconnectTopBarMountObserver,
      scheduleTopBarMount,
      ensureTopBarExists,
      getTopBarActionsContainer,
      ensureToolbarUtilityGroup,
      ensureToggleExists
    };
  }

  globalThis.BosunHelperToolbar = { createToolbar };
})();
