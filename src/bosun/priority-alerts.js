(() => {
  'use strict';

  // Identity and severity must already be resolved by the caller. This module
  // deliberately does not match snapshot records to DOM nodes.
  function classify(resolvedChild, settings) {
    const noPriority = { priority: false, reasons: [] };
    if (settings?.features?.priorityAlerts !== true) return noPriority;
    if (resolvedChild?.identity !== 'resolved') return noPriority;
    const alertName = resolvedChild.alertName;
    if (typeof alertName !== 'string' || !alertName.trim()) return noPriority;

    const reasons = [];
    if (
      settings?.preferences?.priorityCritical === true &&
      resolvedChild.severity === 'critical'
    ) reasons.push('critical');
    if (
      Array.isArray(settings?.priorityRules?.exactAlertNames) &&
      settings.priorityRules.exactAlertNames.includes(alertName)
    ) reasons.push('exact-alert-name');
    return { priority: reasons.length > 0, reasons };
  }

  globalThis.BosunHelperPriorityAlerts = Object.freeze({ classify });
})();
