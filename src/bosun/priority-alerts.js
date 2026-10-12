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

  function parseRuleAlertKey(value) {
    const reject = (kind, reason) => ({ kind, reason, name: '' });
    if (value == null || value === '') return reject('missing', 'missing');
    if (typeof value !== 'string') return reject('malformed', 'non-string-key');
    if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return reject('unsupported', 'unsupported-control-character');
    const text = value.trim();
    const envelope = text.match(/^([^{}]+)(?:\{([^{}]*)\})?$/);
    if (!envelope) return reject('malformed', 'invalid-key-envelope');
    const name = envelope[1];
    if (!/^[^\s{},="'\\]+$/.test(name)) return reject('unsupported', 'unsupported-alert-name-syntax');
    const tags = [], seen = new Set();
    if (envelope[2]) for (const pair of envelope[2].split(',')) {
      const tag = pair.match(/^([^=]+)=(.*)$/);
      if (!tag) return reject('malformed', 'invalid-tag-pair');
      // Bosun opentsdb/name.go permits these ASCII characters in tag names,
      // including initial digits. This is not the PromQL label-name grammar.
      if (!/^[A-Za-z0-9_./-]+$/.test(tag[1])) return reject('unsupported', 'unsupported-tag-name-syntax');
      // AlertKey.Group accepts internal spaces despite OpenTSDB validation errors.
      // Preserve them exactly; do not trim values or admit other whitespace.
      if (!/^[^\s{},="'\\]+(?: +[^\s{},="'\\]+)*$/.test(tag[2])) return reject('unsupported', 'unsupported-tag-value-syntax');
      if (seen.has(tag[1])) return reject('malformed', 'duplicate-tag-name');
      seen.add(tag[1]); tags.push([tag[1], tag[2]]);
    }
    tags.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return { kind: 'valid', reason: 'none', name,
      identity: JSON.stringify([name, envelope[2] !== undefined, tags]) };
  }

  // Rule editing uses structured names, never human-readable Subject text.
  function getRuleAlertName(child) {
    const names = [child?.Alert, child?.State?.Alert]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
    const identities = [];
    for (const key of [child?.AlertKey, child?.State?.AlertKey]) {
      if (key == null || key === '') continue;
      const parsed = parseRuleAlertKey(key);
      if (parsed.kind !== 'valid') return '';
      names.push(parsed.name); identities.push(parsed.identity);
    }
    if (new Set(identities).size > 1) return '';
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
