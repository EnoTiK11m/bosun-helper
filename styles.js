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
      checkboxImprovementsDisabledClass = 'bosun-checkbox-improvements-disabled',
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

      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        min-width: 0;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > a {
        order: 1;
        display: flex;
        flex: 1 1 auto;
        align-items: center;
        flex-wrap: nowrap;
        min-width: 0;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title [ng-bind="group.Subject"] {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-left: 4px;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title .pull-right.ng-binding {
        flex: 0 0 auto;
        float: none !important;
        margin-left: auto;
        white-space: nowrap;
      }
      body:not(.${checkboxImprovementsDisabledClass}) :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > label.pull-right.select {
        order: 2;
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        box-sizing: border-box;
        float: none !important;
        margin: -4px 4px -4px 2px;
        border-radius: 4px;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color .12s ease, box-shadow .12s ease;
      }
      @media (hover: hover) {
        body:not(.${checkboxImprovementsDisabledClass}) :is(
          [ts-ack-group="schedule.Groups.NeedAck"],
          [ts-ack-group="schedule.Groups.Acknowledged"]
        ) > .panel-group > .panel > .panel-heading > .panel-title > label.pull-right.select:hover {
          background: rgba(0, 0, 0, .055);
        }
      }
      body:not(.${checkboxImprovementsDisabledClass}) :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > label.pull-right.select:has(input:focus-visible) {
        box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 0 0 4px #2d69a0;
      }
      body:not(.${checkboxImprovementsDisabledClass}) :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > label.pull-right.select > input[type="checkbox"] {
        width: 16px;
        height: 16px;
        margin: 0;
        cursor: pointer;
      }
      body:not(.${checkboxImprovementsDisabledClass}) :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > input[type="checkbox"] {
        order: 2;
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        margin-left: 8px;
      }
      body:not(.${checkboxImprovementsDisabledClass}) :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading:has(
        > .panel-title > label.pull-right.select input[type="checkbox"]:checked,
        > .panel-title > input[type="checkbox"]:checked
      ) {
        outline: 2px solid rgba(0, 0, 0, .10);
        outline-offset: -2px;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title > .bosun-parent-marker {
        order: 0;
        flex: 0 0 auto;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title :is(
        .${copyButtonClass},
        .${copyAllButtonClass}
      ) {
        flex: 0 0 auto;
        float: none;
        white-space: nowrap;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title .${copyButtonClass} {
        margin-right: 8px;
      }
      :is(
        [ts-ack-group="schedule.Groups.NeedAck"],
        [ts-ack-group="schedule.Groups.Acknowledged"]
      ) > .panel-group > .panel > .panel-heading > .panel-title .${copyAllButtonClass} {
        margin-right: 0;
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
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1 1 auto;
        flex-wrap: wrap;
        min-width: 0;
        width: 100%;
      }

      #${topBarId} .bosun-toolbar-utility-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
        flex-wrap: nowrap;
        margin-left: auto;
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
      #${topBarStatusId}.bosun-toolbar-status[hidden] { display: none !important; }

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
      .bosun-action-templates-settings:focus-visible,
      .bosun-action-template-icon-btn:focus-visible,
      .bosun-action-template-editor-btn:focus-visible,
      .bosun-action-template-input:focus-visible,
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
      .bosun-action-templates-title-row {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 0 0 6px 0;
      }
      .bosun-action-templates-title {
        margin: 0;
        font-size: 12px;
        font-weight: 700;
        color: #555;
      }
      .bosun-action-templates-settings,
      .bosun-action-template-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: #666;
        line-height: 1;
        cursor: pointer;
      }
      .bosun-action-templates-settings:hover,
      .bosun-action-template-icon-btn:hover { background: #f1f1f1; border-color: #d2d2d2; }
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
      .bosun-action-templates-editor {
        max-width: 620px;
        margin-top: 8px;
        padding: 8px;
        border: 1px solid #d5d5d5;
        border-radius: 6px;
        background: #fafafa;
      }
      .bosun-action-template-limit-hint { margin-bottom: 6px; color: #666; font-size: 11px; }
      .bosun-action-template-rows { display: grid; gap: 5px; }
      .bosun-action-template-row { display: flex; align-items: center; gap: 5px; }
      .bosun-action-template-input {
        flex: 1 1 auto;
        min-width: 0;
        height: 28px;
        padding: 3px 7px;
        border: 1px solid #8c8c8c;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
      }
      .bosun-action-template-row-actions { display: inline-flex; gap: 2px; }
      .bosun-action-template-icon-btn:disabled { opacity: .35; cursor: default; }
      .bosun-action-template-icon-btn.is-danger { color: #a33; }
      .bosun-action-template-editor-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 7px;
      }
      .bosun-action-template-editor-btn {
        min-height: 26px;
        padding: 3px 8px;
        border: 1px solid #c9c9c9;
        border-radius: 4px;
        background: #fff;
        color: #444;
        font-size: 12px;
        cursor: pointer;
      }
      .bosun-action-template-editor-btn:hover { background: #f1f1f1; }
      .bosun-action-template-editor-btn.is-primary { border-color: #2f6fad; background: #337ab7; color: #fff; }
      .bosun-action-template-status { margin: -2px 0 6px; color: #4d6b45; font-size: 11px; }
      .bosun-action-template-status.is-error { color: #a33; }

      .bosun-settings-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: max(16px, 5vh) 16px 16px;
        box-sizing: border-box;
        overflow: auto;
        background: rgba(0, 0, 0, .46);
      }
      .bosun-settings-modal[hidden] { display: none !important; }
      .bosun-settings-panel {
        width: min(680px, 100%);
        max-height: calc(100vh - max(32px, 10vh));
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        overflow: hidden;
        border: 1px solid #c9c9c9;
        border-radius: 9px;
        color: #333;
        background: #fff;
        box-shadow: 0 14px 38px rgba(0, 0, 0, .34);
        font-family: Arial, sans-serif;
        font-size: 13px;
        line-height: 1.4;
      }
      .bosun-settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex: 0 0 auto;
        padding: 11px 14px;
        border-bottom: 1px solid #e3e3e3;
      }
      .bosun-settings-title { margin: 0; color: #333; font-size: 17px; line-height: 1.3; }
      .bosun-settings-close {
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 5px;
        color: #555;
        background: transparent;
        font-size: 24px;
        line-height: 1;
        cursor: pointer;
      }
      .bosun-settings-close:hover { border-color: #d2d2d2; background: #f3f3f3; }
      .bosun-settings-body {
        display: block;
        column-count: 2;
        column-gap: 12px;
        min-width: 0;
        padding: 12px 14px;
        overflow: auto;
        overscroll-behavior: contain;
      }
      .bosun-settings-group {
        display: inline-block;
        width: 100%;
        min-width: 0;
        margin: 0 0 12px;
        padding: 9px 10px 10px;
        box-sizing: border-box;
        break-inside: avoid;
        border: 1px solid #dedede;
        border-radius: 7px;
        vertical-align: top;
      }
      .bosun-settings-group-title {
        width: auto;
        margin: 0;
        padding: 0 5px;
        border: 0;
        color: #555;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.3;
      }
      .bosun-settings-group-collapsible > .bosun-settings-group-title {
        cursor: pointer;
        user-select: none;
      }
      .bosun-settings-group-collapsible[open] > .bosun-settings-group-title { margin-bottom: 4px; }
      .bosun-settings-group-collapsible:not([open]) { padding-bottom: 9px; }
      .bosun-settings-toggle {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
        margin: 0;
        padding: 5px 2px;
        color: #333;
        font-weight: 400;
        cursor: pointer;
      }
      .bosun-settings-toggle input {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        margin: 1px 0 0;
        accent-color: #337ab7;
        cursor: pointer;
      }
      .bosun-settings-toggle input:disabled,
      .bosun-settings-number-input:disabled,
      .bosun-settings-template-input:disabled { cursor: wait; opacity: .65; }
      .bosun-settings-toggle-copy { min-width: 0; overflow-wrap: anywhere; }
      .bosun-settings-toggle-label { display: block; }
      .bosun-settings-field-hint,
      .bosun-settings-template-mode {
        display: block;
        margin-top: 2px;
        color: #6f6f6f;
        font-size: 11px;
        line-height: 1.3;
      }
      .bosun-settings-number-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
        margin: 0;
        padding: 5px 2px;
        color: #333;
        font-weight: 400;
      }
      .bosun-settings-number-label { min-width: 0; overflow-wrap: anywhere; }
      .bosun-settings-number-value { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
      .bosun-settings-number-input {
        width: 72px;
        height: 28px;
        box-sizing: border-box;
        padding: 3px 6px;
        border: 1px solid #8a8a8a;
        border-radius: 4px;
        color: #333;
        background: #fff;
        font: inherit;
      }
      .bosun-settings-number-suffix { color: #666; font-size: 12px; }
      .bosun-settings-template { min-width: 0; padding: 5px 2px; }
      .bosun-settings-template-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        margin-bottom: 4px;
      }
      .bosun-settings-template-label { margin: 0; color: #333; font-size: 12px; font-weight: 700; }
      .bosun-settings-template-input {
        display: block;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        min-height: 56px;
        box-sizing: border-box;
        resize: vertical;
        padding: 5px 7px;
        border: 1px solid #8a8a8a;
        border-radius: 4px;
        color: #333;
        background: #fff;
        font: 12px/1.35 Arial, sans-serif;
      }
      .bosun-settings-small-button,
      .bosun-settings-reset {
        min-height: 28px;
        padding: 4px 9px;
        border: 1px solid #8a8a8a;
        border-radius: 5px;
        color: #444;
        background: #fff;
        font: 600 11px/1.2 Arial, sans-serif;
        cursor: pointer;
      }
      .bosun-settings-small-button:hover,
      .bosun-settings-reset:hover { border-color: #aaa; background: #f4f4f4; }
      .bosun-settings-small-button:disabled,
      .bosun-settings-reset:disabled { cursor: default; opacity: .55; }
      .bosun-settings-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex: 0 0 auto;
        min-height: 31px;
        padding: 9px 14px;
        border-top: 1px solid #e3e3e3;
        background: #fafafa;
      }
      .bosun-settings-status { min-width: 0; color: #476c47; font-size: 11px; overflow-wrap: anywhere; }
      .bosun-settings-status.is-error { color: #a33; }
      .bosun-settings-close:focus-visible,
      .bosun-settings-group-collapsible > summary:focus-visible,
      .bosun-settings-toggle input:focus-visible,
      .bosun-settings-number-input:focus-visible,
      .bosun-settings-template-input:focus-visible,
      .bosun-settings-small-button:focus-visible,
      .bosun-settings-reset:focus-visible {
        outline: 2px solid #2f6fad;
        outline-offset: 2px;
      }

      @media (max-width: 620px) {
        .bosun-settings-modal { padding: 8px; }
        .bosun-settings-panel { max-height: calc(100vh - 16px); }
        .bosun-settings-body { column-count: 1; padding: 10px; }
        .bosun-settings-header, .bosun-settings-footer { padding-left: 10px; padding-right: 10px; }
        .bosun-settings-footer { align-items: flex-start; flex-direction: column; }
      }

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
        :is(
          [ts-ack-group="schedule.Groups.NeedAck"],
          [ts-ack-group="schedule.Groups.Acknowledged"]
        ) > .panel-group > .panel > .panel-heading > .panel-title > label.pull-right.select {
          transition: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  globalThis.BosunSilenceHiderStyles = { injectStyles };
})();
