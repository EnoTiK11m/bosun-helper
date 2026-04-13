(() => {
  'use strict';

  function createActivityTracker(options) {
    const {
      pageUtils,
      getAutoRefreshEnabled,
      setAutoRefreshEnabled,
      getAutoRefreshIdleSeconds,
      getLastUserActivityTs,
      setLastUserActivityTs,
      getLastKnownUrl,
      setLastKnownUrl,
      onActivity,
      onIdleRefresh,
      onUrlChanged,
      scheduleReEnable,
      clearReEnable,
      saveAutoRefreshState,
      updateAutoRefreshControls,
      reportDiagnostics,
      autoRefreshForceReenableMs
    } = options;

    let autoRefreshTimer = null;
    let autoRefreshReEnableTimer = null;

    function markUserActivity() {
      setLastUserActivityTs(Date.now());
      if (typeof onActivity === 'function') onActivity();
    }

    function getAutoRefreshRemainingSeconds() {
      const elapsedSeconds = (Date.now() - getLastUserActivityTs()) / 1000;
      return Math.max(0, Math.ceil(getAutoRefreshIdleSeconds() - elapsedSeconds));
    }

    function updateAutoRefreshCountdown(countdownElement) {
      if (!countdownElement) return;

      if (!getAutoRefreshEnabled()) {
        countdownElement.textContent = 'off';
        countdownElement.title = 'Отключить автообновление';
        return;
      }

      if (!pageUtils.isDashboardHome()) {
        countdownElement.textContent = '—';
        countdownElement.title = 'Автообновление страницы только на главной /';
        return;
      }

      countdownElement.title = 'Отключить автообновление';
      countdownElement.textContent = `${getAutoRefreshRemainingSeconds()}s`;
    }

    function maybeAutoRefreshPage() {
      if (!getAutoRefreshEnabled() || !pageUtils.isDashboardHome()) return;
      if (Date.now() - getLastUserActivityTs() < getAutoRefreshIdleSeconds() * 1000) return;

      reportDiagnostics?.('auto-refresh', 'reloading page after idle timeout');
      if (typeof onIdleRefresh === 'function') onIdleRefresh();
      window.location.reload();
    }

    function clearAutoRefreshReEnableTimer() {
      if (!autoRefreshReEnableTimer) return;
      clearTimeout(autoRefreshReEnableTimer);
      autoRefreshReEnableTimer = null;
      if (typeof clearReEnable === 'function') clearReEnable();
    }

    function scheduleAutoRefreshReEnable() {
      clearAutoRefreshReEnableTimer();
      autoRefreshReEnableTimer = setTimeout(() => {
        autoRefreshReEnableTimer = null;
        if (getAutoRefreshEnabled()) return;

        setAutoRefreshEnabled(true);
        markUserActivity();
        saveAutoRefreshState?.();
        updateAutoRefreshControls?.();
      }, autoRefreshForceReenableMs);
      if (typeof scheduleReEnable === 'function') scheduleReEnable(autoRefreshReEnableTimer);
    }

    function handleAutoRefreshToggleChange(checked) {
      setAutoRefreshEnabled(Boolean(checked));
      if (getAutoRefreshEnabled()) clearAutoRefreshReEnableTimer();
      else scheduleAutoRefreshReEnable();
      markUserActivity();
      saveAutoRefreshState?.();
      updateAutoRefreshControls?.();
    }

    function handleCountdownClick() {
      if (!getAutoRefreshEnabled()) return;
      setAutoRefreshEnabled(false);
      scheduleAutoRefreshReEnable();
      markUserActivity();
      saveAutoRefreshState?.();
      updateAutoRefreshControls?.();
    }

    function installUserActivityTracking() {
      [
        ['click', markUserActivity],
        ['keydown', markUserActivity]
      ].forEach(([eventName, handler]) => {
        window.addEventListener(eventName, handler, { passive: true, capture: true });
      });
    }

    function startAutoRefreshLoop(updateCountdown) {
      if (autoRefreshTimer) return;

      autoRefreshTimer = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== getLastKnownUrl()) {
          setLastKnownUrl(currentUrl);
          markUserActivity();
          onUrlChanged?.();
        }

        updateCountdown?.();
        maybeAutoRefreshPage();
      }, 1000);
    }

    return {
      markUserActivity,
      getAutoRefreshRemainingSeconds,
      updateAutoRefreshCountdown,
      clearAutoRefreshReEnableTimer,
      scheduleAutoRefreshReEnable,
      handleAutoRefreshToggleChange,
      handleCountdownClick,
      installUserActivityTracking,
      startAutoRefreshLoop
    };
  }

  globalThis.BosunSilenceHiderActivity = {
    createActivityTracker
  };
})();
