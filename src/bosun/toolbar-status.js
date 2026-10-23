(() => {
  'use strict';

  function createToolbarStatus({
    state,
    STATUS_MESSAGE_TTL_MS,
    TOP_BAR_STATUS_ID,
    clearTimeout,
    document,
    setTimeout
  }) {

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

  function clearToolbarStatusTimer() {
    if (!state.toolbarStatusTimer) return;
    clearTimeout(state.toolbarStatusTimer);
    state.toolbarStatusTimer = null;
  }

  function updateToolbarStatus() {
    const status = document.getElementById(TOP_BAR_STATUS_ID);
    if (!status) return;

    const isVisible = Boolean(state.toolbarStatusMessage);
    const accessibleText = state.toolbarStatusTitle && state.toolbarStatusTitle !== state.toolbarStatusMessage
      ? `${state.toolbarStatusMessage}. Подробности: ${state.toolbarStatusTitle}`
      : state.toolbarStatusMessage;
    status.textContent = isVisible ? state.toolbarStatusMessage : '';
    status.title = isVisible ? (state.toolbarStatusTitle || state.toolbarStatusMessage) : '';
    status.hidden = !isVisible;
    if (isVisible) {
      status.setAttribute('aria-label', accessibleText);
      status.tabIndex = state.toolbarStatusTitle !== state.toolbarStatusMessage ? 0 : -1;
    } else {
      status.removeAttribute('aria-label');
      status.removeAttribute('tabindex');
    }
    status.classList.toggle('is-info', state.toolbarStatusLevel === 'info');
    status.classList.toggle('is-warn', state.toolbarStatusLevel === 'warn');
    status.classList.toggle('is-error', state.toolbarStatusLevel === 'error');
  }

  function clearToolbarStatus(source) {
    if (source && state.toolbarStatusSource && state.toolbarStatusSource !== source) return;

    state.toolbarStatusSource = '';
    state.toolbarStatusLevel = '';
    state.toolbarStatusMessage = '';
    state.toolbarStatusTitle = '';
    clearToolbarStatusTimer();
    updateToolbarStatus();
  }

  function setToolbarStatus(source, message, level = 'info', options = {}) {
    const {
      sticky = false,
      ttlMs = STATUS_MESSAGE_TTL_MS,
      title = ''
    } = options;

    state.toolbarStatusSource = String(source || '');
    state.toolbarStatusLevel = level;
    state.toolbarStatusMessage = String(message || '');
    state.toolbarStatusTitle = String(title || state.toolbarStatusMessage);
    clearToolbarStatusTimer();
    updateToolbarStatus();

    if (sticky || !state.toolbarStatusMessage) return;

    state.toolbarStatusTimer = setTimeout(() => {
      clearToolbarStatus(source);
    }, Math.max(1000, Number(ttlMs) || STATUS_MESSAGE_TTL_MS));
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

    return {
      flashButtonState,
      clearToolbarStatusTimer,
      updateToolbarStatus,
      clearToolbarStatus,
      setToolbarStatus,
      ensureToolbarStatusIndicator
    };
  }

  globalThis.BosunHelperToolbarStatus = { createToolbarStatus };
})();
