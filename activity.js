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
    let lastHighFrequencyActivityAt = 0;
    let autoRefreshUpdateCountdown = null;

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
        countdownElement.textContent = 'выкл';
        countdownElement.title = 'Автообновление выключено';
        countdownElement.removeAttribute('aria-pressed');
        countdownElement.setAttribute('aria-label', 'Автообновление выключено');
        return;
      }

      if (!pageUtils.isDashboardHome()) {
        countdownElement.textContent = '—';
        countdownElement.title = 'Автообновление страницы только на главной /';
        countdownElement.removeAttribute('aria-pressed');
        countdownElement.setAttribute('aria-label', 'Автообновление включено и работает только на главной странице');
        return;
      }

      const remaining = getAutoRefreshRemainingSeconds();
      countdownElement.title = `До автообновления: ${remaining} секунд`;
      countdownElement.textContent = `${remaining}s`;
      countdownElement.removeAttribute('aria-pressed');
      countdownElement.setAttribute(
        'aria-label',
        `Автообновление включено, осталось ${remaining} секунд`
      );
    }

    function maybeAutoRefreshPage() {
      if (!getAutoRefreshEnabled() || !pageUtils.isDashboardHome()) return;
      if (document.visibilityState === 'hidden') {
        reportDiagnostics?.('auto-refresh-deferred', 'page-hidden');
        return;
      }
      if (Date.now() - getLastUserActivityTs() < getAutoRefreshIdleSeconds() * 1000) return;
      const activeElement = document.activeElement;
      const isEditing = Boolean(activeElement?.matches?.(
        'input, textarea, select, [contenteditable="true"], [role="textbox"]'
      ));
      const hasSelection = Boolean(window.getSelection?.()?.toString?.().trim());
      if (isEditing || hasSelection) {
        markUserActivity();
        reportDiagnostics?.('auto-refresh-deferred', isEditing ? 'editing' : 'text-selection');
        return;
      }

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
      if (!Number.isFinite(autoRefreshForceReenableMs) || autoRefreshForceReenableMs <= 0) {
        return;
      }
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
      const nextEnabled = !getAutoRefreshEnabled();
      setAutoRefreshEnabled(nextEnabled);
      if (nextEnabled) clearAutoRefreshReEnableTimer();
      else scheduleAutoRefreshReEnable();
      markUserActivity();
      saveAutoRefreshState?.();
      updateAutoRefreshControls?.();
    }

    function installUserActivityTracking() {
      const markHighFrequencyActivity = () => {
        const now = Date.now();
        if (now - lastHighFrequencyActivityAt < 500) return;
        lastHighFrequencyActivityAt = now;
        markUserActivity();
      };

      [
        ['pointerdown', markUserActivity],
        ['keydown', markUserActivity],
        ['touchstart', markUserActivity],
        ['wheel', markHighFrequencyActivity],
        ['scroll', markHighFrequencyActivity]
      ].forEach(([eventName, handler]) => {
        window.addEventListener(eventName, handler, { passive: true, capture: true });
      });

      document.addEventListener('visibilitychange', () => {
        markUserActivity();
        if (document.visibilityState === 'hidden') {
          if (autoRefreshTimer) clearInterval(autoRefreshTimer);
          autoRefreshTimer = null;
        } else if (autoRefreshUpdateCountdown) {
          startAutoRefreshLoop(autoRefreshUpdateCountdown);
        }
      }, { passive: true });
    }

    function startAutoRefreshLoop(updateCountdown) {
      if (typeof updateCountdown === 'function') autoRefreshUpdateCountdown = updateCountdown;
      if (autoRefreshTimer) return;
      if (document.visibilityState === 'hidden') return;

      autoRefreshTimer = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== getLastKnownUrl()) {
          setLastKnownUrl(currentUrl);
          markUserActivity();
          onUrlChanged?.();
        }

        autoRefreshUpdateCountdown?.();
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
