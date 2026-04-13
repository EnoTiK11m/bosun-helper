(() => {
  'use strict';

  function createPageUtils() {
    function isActionPage() {
      return window.location.pathname === '/action' && window.location.search.includes('type=');
    }

    function isDashboardHome() {
      return window.location.pathname === '/';
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

        if (!/notify/i.test(model) || !input.checked) return;

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
      uncheckActionNotificationCheckbox,
      applyActionPageTweaks
    };
  }

  globalThis.BosunSilenceHiderPageUtils = {
    createPageUtils
  };
})();
