(() => {
  'use strict';

  function createDiagnostics(options) {
    const {
      modalId,
      logListId,
      logStorageKey,
      maxEntries,
      getEnabled
    } = options;

    const sharedUtils = globalThis.BosunSilenceHiderSharedUtils || null;
    const formatTimestamp = sharedUtils?.formatDiagnosticsTimestamp
      ? sharedUtils.formatDiagnosticsTimestamp
      : (date) => {
          const yyyy = String(date.getFullYear());
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const hh = String(date.getHours()).padStart(2, '0');
          const mm = String(date.getMinutes()).padStart(2, '0');
          const ss = String(date.getSeconds()).padStart(2, '0');
          return `${yyyy}-${month}-${day} ${hh}:${mm}:${ss}`;
        };

    let modalOpen = false;
    let logEntries = [];
    let saveTimer = null;
    let previouslyFocusedElement = null;

    function saveLogToStorage() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!window?.localStorage) return;
      try {
        const payload = JSON.stringify(logEntries.slice(-maxEntries));
        window.localStorage.setItem(logStorageKey, payload);
      } catch (err) {
        console.warn('[Bosun plugin] Failed to save diagnostics log to localStorage:', err);
      }
    }

    function scheduleLogSave() {
      if (saveTimer) return;
      saveTimer = setTimeout(saveLogToStorage, 500);
    }

    function restoreLogFromStorage() {
      if (!window?.localStorage) return;
      try {
        const raw = window.localStorage.getItem(logStorageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        logEntries = parsed
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            time: String(entry.time || ''),
            event: String(entry.event || 'unknown'),
            details: String(entry.details || '')
          }))
          .slice(-maxEntries);
      } catch (err) {
        console.warn('[Bosun plugin] Failed to restore diagnostics log from localStorage:', err);
      }
    }

    function appendLogItem(list, text) {
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    }

    function renderLogList() {
      const list = document.getElementById(logListId);
      if (!list) return;

      list.textContent = '';
      if (!logEntries.length) {
        appendLogItem(list, 'Log is empty. Enable diagnostics and wait for events.');
        return;
      }

      for (const entry of logEntries) {
        const details = entry.details ? ` | ${entry.details}` : '';
        appendLogItem(list, `[${entry.time}] ${entry.event}${details}`);
      }
      list.scrollTop = list.scrollHeight;
    }

    function setModalOpen(isOpen) {
      const modal = document.getElementById(modalId);
      if (!modal) return;
      modalOpen = isOpen;
      modal.classList.toggle('is-open', isOpen);
      if (isOpen) {
        previouslyFocusedElement = document.activeElement;
        renderLogList();
        modal.querySelector('[data-role="close"]')?.focus?.();
      } else {
        previouslyFocusedElement?.focus?.();
        previouslyFocusedElement = null;
      }
    }

    function appendLog(eventName, details = '') {
      logEntries.push({
        time: formatTimestamp(new Date()),
        event: String(eventName || 'unknown'),
        details: String(details || '')
      });
      if (logEntries.length > maxEntries) {
        logEntries = logEntries.slice(-maxEntries);
      }
      scheduleLogSave();
      if (modalOpen) renderLogList();
    }

    function report(eventName, details = '') {
      if (!getEnabled()) return;
      appendLog(eventName, details);
      console.debug('[Bosun plugin][diag]', eventName, details);
    }

    function clear() {
      logEntries = [];
      saveLogToStorage();
      renderLogList();
    }

    function ensureModal(onVisibilityMaybeChanged) {
      let modal = document.getElementById(modalId);
      if (modal) return modal;

      modal = document.createElement('div');
      modal.id = modalId;
      modal.innerHTML = `
      <div class="bosun-diagnostics-modal-card" role="dialog" aria-modal="true" aria-label="Diagnostics log">
        <div class="bosun-diagnostics-modal-head">
          <strong>Bosun Diagnostics Log</strong>
          <div class="bosun-diagnostics-modal-actions">
            <button type="button" data-role="clear">Clear</button>
            <button type="button" data-role="close">Close</button>
          </div>
        </div>
        <div class="bosun-diagnostics-modal-body">
          <ul id="${logListId}"></ul>
        </div>
      </div>
    `;

      modal.addEventListener('click', (event) => {
        const role = event.target?.getAttribute?.('data-role');
        if (event.target === modal || role === 'close') {
          setModalOpen(false);
          if (typeof onVisibilityMaybeChanged === 'function') onVisibilityMaybeChanged();
          return;
        }
        if (role === 'clear') {
          clear();
        }
      });

      modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setModalOpen(false);
          if (typeof onVisibilityMaybeChanged === 'function') onVisibilityMaybeChanged();
        }
      });

      document.body.appendChild(modal);
      renderLogList();
      return modal;
    }

    return {
      saveLogToStorage,
      scheduleLogSave,
      restoreLogFromStorage,
      renderLogList,
      setModalOpen,
      isModalOpen: () => modalOpen,
      appendLog,
      report,
      clear,
      ensureModal
    };
  }

  globalThis.BosunSilenceHiderDiagnostics = {
    createDiagnostics
  };
})();
