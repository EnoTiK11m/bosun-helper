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

  // Rule editing uses structured names, never human-readable Subject text.
  function getRuleAlertName(child) {
    const names = [child?.Alert, child?.State?.Alert]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    for (const key of [child?.AlertKey, child?.State?.AlertKey]) {
      if (key == null || key === '') continue;
      if (typeof key !== 'string') return '';
      const match = key.trim().match(/^([^\s{},="'\\]+)(?:\{([^{}]*)\})?$/);
      if (!match) return '';
      const seenTags = new Set();
      if (match[2]) for (const pair of match[2].split(',')) {
        const tag = pair.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^\s{},="'\\]+)$/);
        if (!tag || seenTags.has(tag[1])) return '';
        seenTags.add(tag[1]);
      }
      names.push(match[1]);
    }
    const unique = [...new Set(names)];
    return unique.length === 1 && !/[\s{}]/.test(unique[0]) ? unique[0] : '';
  }

  function buildRuleIdentityIndex(payload) {
    const sections = new Map();
    for (const section of ['NeedAck', 'Acknowledged']) {
      const byId = new Map();
      const groups = payload?.Groups?.[section];
      for (const group of Array.isArray(groups) ? groups : []) {
        const children = Array.isArray(group?.Children) ? group.Children : (group?.Children ? [group.Children] : []);
        for (const child of children) {
          const id = child?.State?.Id == null ? '' : String(child.State.Id).trim();
          if (!id) continue;
          const name = getRuleAlertName(child);
          const subjects = [child?.Subject, child?.AlertKey, child?.State?.AlertKey]
            .filter((value) => typeof value === 'string' && value.trim())
            .map((value) => value.replace(/\s+/g, ' ').trim());
          byId.set(id, byId.has(id) || !name ? null : { name, subjects });
        }
      }
      sections.set(section, byId);
    }
    return { childrenBySection: sections };
  }

  globalThis.BosunHelperPriorityAlerts = Object.freeze({ classify, getRuleAlertName, buildRuleIdentityIndex });
})();
