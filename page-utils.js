(() => {
  'use strict';

  function createPageUtils() {
    const guardedGroupCheckboxTitles = new WeakSet();
    const groupCheckboxTitleSelector =
      ':is(' +
        '[ts-ack-group="schedule.Groups.NeedAck"], ' +
        '[ts-ack-group="schedule.Groups.Acknowledged"]' +
      ') > .panel-group > .panel > .panel-heading > .panel-title';

    function isActionPage() {
      const path = window.location.pathname.replace(/\/+$/, '') || '/';
      if (path !== '/action') return false;
      try {
        return new URLSearchParams(window.location.search).has('type');
      } catch (_) {
        return false;
      }
    }

    function isDashboardHome() {
      return window.location.pathname === '/';
    }

    function isDashboardGroupCheckboxLabelHitArea(target) {
      const label = target?.closest?.('label.pull-right.select');
      if (!label || target?.closest?.('input[type="checkbox"]')) return false;
      const title = label.parentElement;
      if (!title?.classList?.contains('panel-title')) return false;
      if (!title.querySelector?.('[ng-bind="group.Subject"]')) return false;
      return Boolean(title.closest?.(
        '[ts-ack-group="schedule.Groups.NeedAck"], ' +
        '[ts-ack-group="schedule.Groups.Acknowledged"]'
      ));
    }

    function ensureDashboardGroupCheckboxHitAreaGuards(root = document) {
      const titles = [];
      if (root.matches?.(groupCheckboxTitleSelector)) titles.push(root);
      for (const title of root.querySelectorAll?.(groupCheckboxTitleSelector) || []) {
        titles.push(title);
      }
      for (const title of titles) {
        if (guardedGroupCheckboxTitles.has(title)) continue;
        guardedGroupCheckboxTitles.add(title);
        title.addEventListener('click', (event) => {
          if (isDashboardGroupCheckboxLabelHitArea(event.target)) event.stopPropagation();
        });
      }
    }

    function uncheckActionNotificationCheckbox() {
      if (!isActionPage()) return;

      const notifyInputs = document.querySelectorAll(
        'input[type="checkbox"][ng-model], input[type="checkbox"][data-ng-model], input[type="checkbox"][x-ng-model]'
      );

      notifyInputs.forEach((input) => {
        const model =
          input.getAttribute('ng-model') ||
          input.getAttribute('data-ng-model') ||
          input.getAttribute('x-ng-model') ||
          '';

        if (!/(^|\.)notify$/i.test(model.trim()) || !input.checked) return;

        input.click();

        if (!input.checked) return;

        input.checked = false;
        input.removeAttribute('checked');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    function applyActionPageTweaks() {
      if (!isActionPage()) return;
      uncheckActionNotificationCheckbox();
    }

    return {
      isActionPage,
      isDashboardHome,
      isDashboardGroupCheckboxLabelHitArea,
      ensureDashboardGroupCheckboxHitAreaGuards,
      uncheckActionNotificationCheckbox,
      applyActionPageTweaks
    };
  }

  globalThis.BosunSilenceHiderPageUtils = {
    createPageUtils
  };
})();
