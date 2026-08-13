(() => {
  "use strict";

  function injectStyles(config) {
    const {
      hiddenClass,
      userCommentFilterHiddenClass,
      acknowledgedCollapsedClass,
      copyButtonClass,
      copyAllButtonClass,
      copyLastActionButtonClass,
      grafanaQueryButtonClass,
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
      .bosun-sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
      }

      .bosun-grafana-preview-dialog {
        width: min(760px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        padding: 20px;
        border: 1px solid #b7b7b7;
        border-radius: 10px;
        color: #222;
        background: #fff;
        box-shadow: 0 16px 50px rgba(0, 0, 0, .35);
      }
      .bosun-grafana-preview-dialog::backdrop { background: rgba(0, 0, 0, .55); }
      .bosun-grafana-preview-dialog h2 { margin: 0 0 8px; font-size: 20px; }
      .bosun-grafana-preview-dialog p { margin: 0 0 12px; }
      .bosun-grafana-preview-query {
        max-height: min(55vh, 520px);
        overflow: auto;
        padding: 12px;
        border: 1px solid #d4d4d4;
        border-radius: 6px;
        color: #111;
        background: #f6f7f8;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .bosun-grafana-preview-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }
      .bosun-grafana-preview-actions button {
        min-height: 34px;
        padding: 6px 12px;
        border: 1px solid #aaa;
        border-radius: 6px;
        background: #fff;
        color: #222;
        cursor: pointer;
      }
      .bosun-grafana-preview-actions button.is-primary {
        border-color: #a95c12;
        background: #d97818;
        color: #fff;
      }

      .${hiddenClass}, .${userCommentFilterHiddenClass}, .${acknowledgedCollapsedClass} { display: none !important; }

      .${copyButtonClass}, .${copyAllButtonClass}, .${copyLastActionButtonClass}, .${grafanaQueryButtonClass} {
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
        transition: background-color .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease, transform .05s ease;
      }
      .${copyAllButtonClass} { margin-right: 8px; float: right; }
      .${grafanaQueryButtonClass} {
        border-color: rgba(229, 132, 33, 0.85);
        color: #d96c0b;
      }
      .${copyButtonClass}:hover, .${copyAllButtonClass}:hover, .${copyLastActionButtonClass}:hover, .${grafanaQueryButtonClass}:hover { background: rgba(255,255,255,0.16); }
      .${copyButtonClass}:active, .${copyAllButtonClass}:active, .${copyLastActionButtonClass}:active {
        background: rgba(90, 90, 90, 0.16);
        border-color: rgba(125, 125, 125, 0.72);
        box-shadow: 0 0 0 1px rgba(90, 90, 90, 0.18) inset;
        transform: translateY(1px);
      }
      .${copyButtonClass}[data-copied="true"], .${copyAllButtonClass}[data-copied="true"], .${copyLastActionButtonClass}[data-copied="true"] {
        background: rgba(100, 100, 100, 0.09);
        border-color: rgba(145, 145, 145, 0.72);
        color: inherit;
        box-shadow: 0 0 0 1px rgba(100, 100, 100, 0.12) inset;
        opacity: 1;
      }
      .${copyButtonClass}[data-copied="false"], .${copyAllButtonClass}[data-copied="false"], .${copyLastActionButtonClass}[data-copied="false"] {
        background: #8a3d3d;
        border-color: #672c2c;
        color: #fff !important;
        opacity: 1;
      }
      .${grafanaQueryButtonClass}[data-copied="true"] { opacity: 0.85; }

      .bosun-last-action-link {
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .bosun-last-action-link:hover,
      .bosun-last-action-link:focus-visible {
        text-decoration: underline;
      }
      .bosun-last-action-time-text {
        cursor: text;
        text-decoration: none;
      }

      .${noSelectClass} { user-select: none; }
      .${noSelectClass}::selection, .${copyButtonClass}::selection, .${copyAllButtonClass}::selection, .${copyLastActionButtonClass}::selection, .${grafanaQueryButtonClass}::selection { background: transparent; }
      .${noSelectClass}::-moz-selection, .${copyButtonClass}::-moz-selection, .${copyAllButtonClass}::-moz-selection, .${copyLastActionButtonClass}::-moz-selection, .${grafanaQueryButtonClass}::-moz-selection { background: transparent; }

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

      #${topBarId} .bosun-new-alerts-notice {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: 32px;
        margin-top: 6px;
        padding: 6px 10px;
        box-sizing: border-box;
        border: 1px solid #ddd;
        border-radius: 6px;
        background: #f5f5f5;
        color: #444;
        font-family: Arial, sans-serif;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.4;
      }
      #${topBarId} .bosun-new-alerts-notice.is-critical {
        border-color: #8d3836;
        background: #a94442;
        color: #fff;
      }
      #${topBarId} .bosun-new-alerts-notice.is-warning {
        border-color: #71592f;
        background: #8a6d3b;
        color: #fff;
      }
      #${topBarId} .bosun-new-alerts-notice.is-unknown {
        border-color: #285d78;
        background: #31708f;
        color: #fff;
      }
      #${topBarId} .bosun-new-alerts-notice[hidden] { display: none !important; }

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
      #${topBarId} .bosun-toolbar-btn:focus-visible,
      #${topBarId} .bosun-toolbar-input:focus-visible,
      .${copyButtonClass}:focus-visible,
      .${copyAllButtonClass}:focus-visible,
      .${copyLastActionButtonClass}:focus-visible,
      .${grafanaQueryButtonClass}:focus-visible,
      .bosun-action-template-btn:focus-visible,
      .bosun-grafana-preview-dialog button:focus-visible,
      #${diagnosticsModalId} button:focus-visible {
        outline: 2px solid #2f6fad;
        outline-offset: 2px;
        border-color: #2f6fad;
        box-shadow: 0 0 0 3px rgba(47,111,173,.18);
      }
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
        cursor: default;
        font-family: inherit;
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

      @media (max-width: 900px) {
        #${topBarId} .bosun-top-controls-inner,
        #${topBarId} .bosun-top-controls-actions {
          align-items: flex-start;
          flex-wrap: wrap;
        }
        #${topBarStatusId}.bosun-toolbar-status {
          width: 100%;
          max-width: none;
          margin-left: 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #${topBarId} .bosun-toolbar-btn { transition: none; }
        #${topBarId} .bosun-toolbar-btn:active { transform: none; }
        .${copyButtonClass}, .${copyAllButtonClass}, .${copyLastActionButtonClass}, .${grafanaQueryButtonClass} { transition: none; }
        .${copyButtonClass}:active, .${copyAllButtonClass}:active, .${copyLastActionButtonClass}:active { transform: none; }
      }
    `;

    document.head.appendChild(style);
  }

  globalThis.BosunSilenceHiderStyles = { injectStyles };
})();
