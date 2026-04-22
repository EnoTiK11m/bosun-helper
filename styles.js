(() => {
  "use strict";

  function injectStyles(config) {
    const {
      hiddenClass,
      copyButtonClass,
      copyAllButtonClass,
      noSelectClass,
      silencedBadgeClass,
      oldNoNoteIconClass,
      hasNoteIconClass,
      topBarId,
      topBarStatusId,
      toggleId,
      toggleCounterId,
      autoRefreshToggleId,
      autoRefreshInputId,
      autoRefreshCountdownId,
      soundAlertsToggleId,
      diagnosticsModalId,
      diagnosticsLogListId,
    } = config;

    if (document.getElementById("bosun-silence-hider-styles")) return;

    const style = document.createElement("style");
    style.id = "bosun-silence-hider-styles";
    style.textContent = `
      a:focus,
      button:focus,
      div:focus,
      span:focus {
        outline: none !important;
        outline-offset: 0 !important;
        box-shadow: none !important;
      }
    
      .${hiddenClass} { display: none !important; }

      .${copyButtonClass}, .${copyAllButtonClass} {
        margin-left: 8px;
        padding: 1px 6px;
        border: 1px solid rgba(194, 180, 180, 0.85);
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: inherit;
        font-size: 11px;
        line-height: 1.4;
        cursor: pointer;
        vertical-align: middle;
        box-shadow: 0 0 0 1px rgba(155, 143, 143, 0.6) inset;
        user-select: none;
      }
      .${copyAllButtonClass} { margin-right: 8px; float: right; }
      .${copyButtonClass}:hover, .${copyAllButtonClass}:hover { background: rgba(255,255,255,0.16); }
      .${copyButtonClass}[data-copied="true"], .${copyAllButtonClass}[data-copied="true"] { opacity: 0.85; }

      .${noSelectClass} { user-select: none; }
      .${noSelectClass}::selection, .${copyButtonClass}::selection, .${copyAllButtonClass}::selection { background: transparent; }
      .${noSelectClass}::-moz-selection, .${copyButtonClass}::-moz-selection, .${copyAllButtonClass}::-moz-selection { background: transparent; }

      .${silencedBadgeClass} {
        display: inline-block;
        margin-left: 6px;
        padding: 0 6px;
        border: 1px solid rgba(35, 95, 207, 0.55);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.5;
        vertical-align: middle;
        color: rgb(46, 113, 201);
        background: rgba(255, 193, 7, 0.10);
        box-shadow: 0 0 0 1px rgba(255, 193, 7, 0.12) inset;
        user-select: none;
        pointer-events: none;
      }

      .${oldNoNoteIconClass}, .${hasNoteIconClass} {
        margin-right: 6px;
        font-size: 14px;
        vertical-align: middle;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: none;
      }
      .${oldNoNoteIconClass} { color: #ff9800 !important; }
      .${hasNoteIconClass} { color: #9ea19d !important; }

      div#${topBarId}.bosun-toolbar-fallback {
        width: 95%;
        margin: 10px auto 14px auto;
        padding: 0;
        box-sizing: border-box;
      }

      #${topBarId} .bosun-top-controls-inner {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        box-sizing: border-box;
        font-family: Arial, sans-serif;
        font-size: 12px;
        line-height: 1.4;
        min-height: 34px;
        padding: 6px 8px;
        background: #f8f8f8;
        border: 1px solid #ddd;
        border-radius: 6px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15);
      }

      #${topBarId} .bosun-top-controls-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      #${topBarId} .bosun-toolbar-group {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: nowrap;
      }

      #${topBarStatusId}.bosun-toolbar-status {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        max-width: 320px;
        margin-left: auto;
        padding: 3px 8px;
        border: 1px solid #d7d7d7;
        border-radius: 999px;
        background: #fafafa;
        color: #555;
        font-size: 11px;
        font-weight: 700;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${topBarStatusId}.bosun-toolbar-status.is-info {
        border-color: #a8c4e4;
        background: #eef6ff;
        color: #245585;
      }

      #${topBarStatusId}.bosun-toolbar-status.is-warn {
        border-color: #ddc37f;
        background: #fff8e6;
        color: #8b6114;
      }

      #${topBarStatusId}.bosun-toolbar-status.is-error {
        border-color: #d9a2a2;
        background: #fff0f0;
        color: #9a3a3a;
      }

      #${topBarId} .bosun-toolbar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid #cfcfcf;
        border-radius: 6px;
        background: #fff;
        color: #333;
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        transition: background-color .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease, transform .05s ease;
        box-shadow: none;
        user-select: none;
        white-space: nowrap;
      }
      #${topBarId} .bosun-toolbar-btn:hover { background: #f7f7f7; border-color: #bdbdbd; }
      #${topBarId} .bosun-toolbar-btn:active { transform: translateY(1px); }
      #${topBarId} .bosun-toolbar-btn:focus { outline: none; border-color: #6aa0d8; box-shadow: 0 0 0 3px rgba(80,140,220,.15); }
      #${topBarId} .bosun-toolbar-btn-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        min-width: 14px;
        font-size: 12px;
        line-height: 1;
      }

      #${topBarId} .bosun-toolbar-btn.is-on { background: #edf7ef; border-color: #9fc7aa; color: #2f6a42; }
      #${topBarId} .bosun-toolbar-btn.is-on:hover { background: #e4f1e7; border-color: #8ebb9a; }
      #${topBarId} .bosun-toolbar-btn.is-off { background: #f8eeee; border-color: #d6b0b0; color: #8b4a4a; }
      #${topBarId} .bosun-toolbar-btn.is-off:hover { background: #f3e4e4; border-color: #c89e9e; }
      #${topBarId} .bosun-toolbar-btn.is-neutral-off { background: #f3f3f3; border-color: #cfcfcf; color: #666; }
      #${topBarId} .bosun-toolbar-btn.is-neutral-off:hover { background: #ebebeb; border-color: #bcbcbc; }

      #${toggleId}.bosun-toolbar-btn.is-on,
      #${toggleId}.bosun-toolbar-btn.is-neutral-off {
        background: #f7f7f7;
        border-color: #d0d0d0;
        color: #4a4a4a;
      }

      #${topBarId} .bosun-toolbar-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 999px;
        background: #2f6fad;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
      }

      #${topBarId} .bosun-toolbar-input {
        width: 52px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid #cfcfcf;
        border-radius: 6px;
        background: #fff;
        color: #333;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
        outline: none;
        box-shadow: inset 0 1px 1px rgba(0,0,0,.03);
      }
      #${topBarId} .bosun-toolbar-input:hover { border-color: #bdbdbd; }
      #${topBarId} .bosun-toolbar-input:focus { border-color: #6aa0d8; box-shadow: 0 0 0 3px rgba(80,140,220,.15); }
      #${topBarId} .bosun-toolbar-input::-webkit-outer-spin-button,
      #${topBarId} .bosun-toolbar-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      #${topBarId} .bosun-toolbar-input[type=number] { -moz-appearance: textfield; }

      #${autoRefreshCountdownId} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 40px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid #d7d7d7;
        border-radius: 6px;
        background: #fafafa;
        color: #555;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
      }

      #${topBarId} .bosun-diagnostics-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
        padding-left: 10px;
        border-left: 1px solid #d8d8d8;
      }

      #${toggleId} .bosun-silence-label {
        display: inline-block;
        width: 100%;
        text-align: center;
        pointer-events: none;
      }

      .bosun-action-templates { margin: 0 0 10px 0; }
      .bosun-action-templates-title {
        margin: 0 0 6px 0;
        font-size: 12px;
        font-weight: 700;
        color: #555;
      }
      .bosun-action-templates-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .bosun-action-template-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 26px;
        padding: 3px 8px;
        border: 1px solid #d0d0d0;
        border-radius: 999px;
        background: #fff;
        color: #444;
        font-size: 12px;
        line-height: 1.2;
        cursor: pointer;
      }
      .bosun-action-template-btn:hover { background: #f5f5f5; border-color: #bcbcbc; }

      #${diagnosticsModalId} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
      }
      #${diagnosticsModalId}.is-open { display: flex; }
      #${diagnosticsModalId} .bosun-diagnostics-modal-card {
        width: min(920px, calc(100vw - 32px));
        max-height: calc(100vh - 48px);
        display: flex;
        flex-direction: column;
        border-radius: 8px;
        border: 1px solid #d6d6d6;
        background: #fff;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
      }
      #${diagnosticsModalId} .bosun-diagnostics-modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #ececec;
        font-size: 13px;
      }
      #${diagnosticsModalId} .bosun-diagnostics-modal-actions { display: inline-flex; gap: 8px; }
      #${diagnosticsModalId} .bosun-diagnostics-modal-actions button {
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
        padding: 3px 10px;
      }
      #${diagnosticsModalId} .bosun-diagnostics-modal-actions button:hover { background: #f5f5f5; border-color: #adadad; }
      #${diagnosticsModalId} .bosun-diagnostics-modal-body { padding: 0; overflow: auto; }
      #${diagnosticsLogListId} {
        margin: 0;
        padding: 8px 10px;
        list-style: none;
        font-family: Consolas, "Courier New", monospace;
        font-size: 12px;
        line-height: 1.45;
      }
      #${diagnosticsLogListId} li {
        padding: 4px 6px;
        border-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${diagnosticsLogListId} li:nth-child(odd) { background: #fafafa; }
    `;

    document.head.appendChild(style);
  }

  globalThis.BosunSilenceHiderStyles = { injectStyles };
})();
