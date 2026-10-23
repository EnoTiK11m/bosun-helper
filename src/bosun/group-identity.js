(() => {
  'use strict';

  const expandedReaderReasons = new Set([
    'parent-reader-rejected','parent-not-singleton','visible-child-count','visible-child-structure','visible-id-count',
    'visible-id-format','parent-model-membership','parent-child-count','child-scope-unavailable',
    'child-binding-accessor','child-binding-inherited-parent','child-binding-inherited-other','child-binding-missing',
    'child-parent-reference-mismatch','child-id-mismatch','visible-id-mismatch','child-alertkey-mismatch',
    'child-alertkey-conflict','state-alias-same-identity','state-alias-same-id-no-key','state-alias-reference-mismatch',
    'angular-changed','parent-scope-changed','child-scope-changed','group-membership-changed','parent-model-changed',
    'child-model-changed','child-id-changed','child-alertkey-changed','state-alias-changed','parent-recheck-rejected',
    'identity-changed','dom-changed','reader-exception'
  ]);
  const expandedReaderReasonCode = value => expandedReaderReasons.has(value) ? value : 'unknown';

  // Проверяем установку защиты ДО того, как скрипты страницы смогут установить поддельные блокировщики.
  // При неверном порядке внедрения или отсутствии поддержки MAIN навсегда отключаем читатель в этом документе.
  let guarded = false;
  if (document.readyState === 'loading') {
    const probe = new CustomEvent('bosun-helper-group-identity-result-v1', { detail: 'guard-probe' });
    let observed = false;
    const observe = event => { if (event === probe) observed = true; };
    window.addEventListener('bosun-helper-group-identity-result-v1', observe, true);
    try { window.dispatchEvent(probe); guarded = !observed; }
    finally { window.removeEventListener('bosun-helper-group-identity-result-v1', observe, true); }
  }

  // Синхронное чтение в пределах запроса. Без кеша идентичности, атрибутов DOM, storage,
  // таймеров и постоянных обработчиков. Ранняя MAIN-защита подтверждает подлинность объекта события.
  function readRequest(panel, request) {
    if (!guarded || !panel?.isConnected) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const detailOf = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get;
    let result = null, received = false, dispatching = false;
    const onResponse = event => {
      if (!dispatching || received || event.target !== window) return;
      const raw = detailOf.call(event);
      if (typeof raw !== 'string' || raw.length > 240000) return;
      let message;
      try { message = JSON.parse(raw); } catch (_) { return; }
      if (message?.version !== 1 || message.nonce !== nonce) return;
      received = true;
      const identity = message.identity;
      if (identity === null) {
        result = request === 'bosun-helper-age-expanded-identity-read-v1'
          ? { rejected: true, reason: expandedReaderReasonCode(message.reason) } : { rejected: true };
        return;
      }
      if (!identity || !['NeedAck', 'Acknowledged'].includes(identity.section) ||
        !Array.isArray(identity.children) || !identity.children.length || identity.children.length > 100) return;
      const ids = new Set(), rows = [];
      for (const row of identity.children) {
        if (typeof row?.id !== 'string' || !/^[1-9]\d{0,15}$/.test(row.id) || !Number.isSafeInteger(Number(row.id)) ||
          ids.has(row.id) || typeof row.key !== 'string' || !row.key || row.key.length > 2048) return;
        ids.add(row.id); rows.push({ id: row.id, key: row.key });
      }
      result = { section: identity.section, children: rows };
    };
    window.addEventListener('bosun-helper-group-identity-result-v1', onResponse, true);
    try {
      dispatching = true;
      panel.dispatchEvent(new CustomEvent(request, { bubbles: true, detail: nonce }));
    } finally {
      dispatching = false;
      window.removeEventListener('bosun-helper-group-identity-result-v1', onResponse, true);
    }
    return result;
  }

  function read(panel) { return readRequest(panel, 'bosun-helper-group-identity-read-v1'); }
  function readExpandedSingleton(panel) { return readRequest(panel, 'bosun-helper-age-expanded-identity-read-v1'); }

  function buildSnapshotIndexes(payload, getGroupKey) {
    const indexes = {}, recordsBySection = {};
    const idCounts = new Map(), keyCounts = new Map();
    for (const section of ['NeedAck', 'Acknowledged']) {
      const groups = payload?.Groups?.[section];
      const records = [];
      for (const group of Array.isArray(groups) ? groups : []) {
        const rows = Array.isArray(group?.Children) ? group.Children : [];
        const children = [];
        let valid = rows.length > 0 && rows.length <= 100;
        for (const row of rows) {
          const value = row?.State?.Id;
          const id = (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,15}$/.test(String(value)) &&
            Number.isSafeInteger(Number(value)) ? String(value) : null;
          const key = row?.AlertKey ?? row?.State?.AlertKey;
          if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
          if (typeof key === 'string' && key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
          if (!id || typeof key !== 'string' || !key || key.length > 2048 ||
            (row?.AlertKey != null && row?.State?.AlertKey != null && row.AlertKey !== row.State.AlertKey)) valid = false;
          children.push({ id, key });
        }
        records.push({ valid, children, key: getGroupKey(group) });
      }
      recordsBySection[section] = records;
    }
    for (const section of ['NeedAck', 'Acknowledged']) {
      const index = new Map();
      for (const record of recordsBySection[section]) {
        if (!record.valid || !record.key || record.children.some(row => idCounts.get(row.id) !== 1 || keyCounts.get(row.key) !== 1)) continue;
        index.set(record.children.map(row => row.id).sort().join(','), record);
      }
      indexes[section] = index;
    }
    return indexes;
  }

  globalThis.BosunHelperGroupIdentity = { read, readExpandedSingleton, expandedReaderReasonCode, buildSnapshotIndexes };
})();
