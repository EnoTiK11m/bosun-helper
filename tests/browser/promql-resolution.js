'use strict';

const assert = require('assert');
const { evaluate } = require('./harness/cdp-client');

function outputFilter(query, tags) {
  let constant = 'vector(1)';
  for (const [name, value] of Object.entries(tags)) {
    const literal = JSON.stringify(String(value).replace(/\$/g, '$$$$'));
    constant = `label_replace(${constant}, "${name}", ${literal}, "", ".*")`;
  }
  return `(\n${query}\n) and on (${Object.keys(tags).join(', ')}) (${constant})`;
}

module.exports = async function runPromqlResolutionScenarios({ client, promqlSource, ruleGraphSource, contentSource }) {
  const usageGraphResolverResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const directConfig = ${JSON.stringify(`alert synthetic.alert.query {
  $q_pct = promras(''' sum by (name, zone) (sum by (account, name, zone) (session_bound) and on(account) (max_over_time(count by(account)(session_bound{account!~"retired|sandbox"})[24h:10m]) > 1)) ''', '5m', '2h', '')
  $usage_graph = $q_pct
  warn = $q_pct < 90
}`)};
    let activeHash = 'DIRECT-H1';
    let activeConfig = directConfig;
    let configFails = false;
    let configNetworkFails = false;
    let releaseDirectConfig;
    const directConfigGate = new Promise((resolve) => { releaseDirectConfig = resolve; });
    let waitForDirectConfig = true;
    let configFetchCount = 0;
    let hashFetchCount = 0;
    let releaseScheduledHash;
    const scheduledHashGate = new Promise((resolve) => { releaseScheduledHash = resolve; });
    let waitForScheduledHash = false;
    let syntheticNowOffset = 0;
    const nativeDateNow = Date.now;
    Date.now = () => nativeDateNow() + syntheticNowOffset;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        hashFetchCount += 1;
        if (waitForScheduledHash) await scheduledHashGate;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: activeHash }),
          json: async () => ({ Hash: activeHash })
        };
      }
      if (url === '/api/config?hash=') {
        configFetchCount += 1;
        if (waitForDirectConfig) await directConfigGate;
        if (configNetworkFails) throw new Error('synthetic config network failure');
        if (configFails) {
          return { ok: false, status: 500, headers: { get() { return null; } } };
        }
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => activeConfig
        };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };
    ${promqlSource}
    ${ruleGraphSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const panel = document.createElement('div');
    panel.className = 'panel';
    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    heading.setAttribute('ng-click', 'toggle()');
    const idNode = document.createElement('span');
    idNode.setAttribute('ng-show', 'state.Id');
    idNode.textContent = '#701';
    heading.appendChild(idNode);
    const subjectNode = document.createElement('span');
    subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
    subjectNode.textContent = 'synthetic.alert.query{name=synthetic-node,zone=synthetic-zone}';
    heading.appendChild(subjectNode);
    const agoNode = document.createElement('span');
    agoNode.setAttribute('ts-since', 'child.Ago');
    agoNode.textContent = '3m';
    heading.appendChild(agoNode);
    panel.appendChild(heading);
    root.appendChild(panel);
    document.body.appendChild(root);

    const payload = { Groups: { NeedAck: [{
      Subject: 'synthetic group',
      Children: [{
        Alert: 'synthetic.alert.query',
        AlertKey: 'synthetic.alert.query{name=synthetic-node,zone=synthetic-zone}',
        Subject: 'synthetic.alert.query{name=synthetic-node,zone=synthetic-zone}',
        Ago: '3m',
        State: {
          Id: 701,
          Alert: 'synthetic.alert.query',
          AlertKey: 'synthetic.alert.query{name=synthetic-node,zone=synthetic-zone}',
          Tags: 'name=synthetic-node,zone=synthetic-zone',
          Expr: "promras('''sum(rate(non_authoritative_total[5m]))''', '5m', '2h', '')"
        }
      }]
    }] } };
    hooks.applyAlertsPayload(payload);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const pendingQuery = hooks.getGrafanaQueryForPanel(panel);
    const buttonsWhileConfigPending = root.querySelectorAll('.bosun-grafana-query-btn').length;
    hooks.applyAlertsPayload(payload);
    waitForDirectConfig = false;
    releaseDirectConfig();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const directQuery = hooks.getGrafanaQueryForPanel(panel);
    const directButtons = root.querySelectorAll('.bosun-grafana-query-btn').length;
    const directConfigFetchCount = configFetchCount;
    const directHashFetchCount = hashFetchCount;
    hooks.applyAlertsPayload(payload);
    const cachedQueryDuringFreshInterval = hooks.getGrafanaQueryForPanel(panel);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const cachedHashFetchCount = hashFetchCount;
    syntheticNowOffset = 16000;
    waitForScheduledHash = true;
    hooks.applyAlertsPayload(payload);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const queryDuringUnchangedHashCheck = hooks.getGrafanaQueryForPanel(panel);
    waitForScheduledHash = false;
    releaseScheduledHash();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const queryAfterUnchangedHashCheck = hooks.getGrafanaQueryForPanel(panel);
    const unchangedHashFetchCount = hashFetchCount;

    activeHash = 'MULTI-H2';
    activeConfig = ${JSON.stringify(`alert synthetic.alert.query {
  $q1 = promras('''sum(rate(first_total[5m]))''', '5m', '2h', '')
  $q2 = promras('''sum(rate(second_total[5m]))''', '5m', '2h', '')
  $usage_graph = merge($q1, $q2)
  warn = $q1 > 0
}`)};
    const multiRefresh = hooks.ruleGraphResolver.refresh(
      ['synthetic.alert.query'],
      { force: true }
    );
    const queryDuringHashCheck = hooks.getGrafanaQueryForPanel(panel);
    await multiRefresh;
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const rejectedQuery = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterUnsupportedHash = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'FAIL-H3';
    configFails = true;
    payload.Groups.NeedAck[0].Children[0].State.Expr =
      "promras('''sum by (name, zone) (rate(fallback_total[5m]))''', '5m', '2h', '')";
    await hooks.ruleGraphResolver.refresh(['synthetic.alert.query'], { force: true });
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const safeFailureFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterSafeFallback = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'NETWORK-H4';
    configFails = false;
    configNetworkFails = true;
    await hooks.ruleGraphResolver.refresh(['synthetic.alert.query'], { force: true });
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const safeNetworkFailureFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterNetworkFallback = root.querySelectorAll('.bosun-grafana-query-btn').length;

    activeHash = 'MALFORMED-H5';
    configNetworkFails = false;
    activeConfig = 'alert synthetic.alert.query {\\n  $usage_graph = promras(';
    const malformedSnapshot = await hooks.ruleGraphResolver.refresh(
      ['synthetic.alert.query'],
      { force: true }
    );
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    const malformedRuleFallback = hooks.getGrafanaQueryForPanel(panel);
    const buttonsAfterMalformedRule = root.querySelectorAll('.bosun-grafana-query-btn').length;

    payload.Groups.NeedAck[0].Children[0].State.Alert = 'synthetic.conflicting.identity';
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    return {
      pendingQuery,
      buttonsWhileConfigPending,
      directQuery,
      directButtons,
      directConfigFetchCount,
      directHashFetchCount,
      cachedQueryDuringFreshInterval,
      cachedHashFetchCount,
      queryDuringUnchangedHashCheck,
      queryAfterUnchangedHashCheck,
      unchangedHashFetchCount,
      queryDuringHashCheck,
      rejectedQuery,
      buttonsAfterUnsupportedHash,
      safeFailureFallback,
      buttonsAfterSafeFallback,
      safeNetworkFailureFallback,
      buttonsAfterNetworkFallback,
      malformedSnapshotReason: malformedSnapshot.reason,
      malformedRuleFallback,
      buttonsAfterMalformedRule,
      conflictingIdentityQuery: hooks.getGrafanaQueryForPanel(panel),
      buttonsAfterConflictingIdentity: root.querySelectorAll('.bosun-grafana-query-btn').length
    };
  })()`);
  assert.deepStrictEqual(usageGraphResolverResult, {
    pendingQuery: '',
    buttonsWhileConfigPending: 0,
    directQuery: outputFilter('sum by (name, zone) (sum by (account, name, zone) (session_bound) and on(account) (max_over_time(count by(account)(session_bound{account!~"retired|sandbox"})[24h:10m]) > 1))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    directButtons: 1,
    directConfigFetchCount: 1,
    directHashFetchCount: 2,
    cachedQueryDuringFreshInterval: outputFilter('sum by (name, zone) (sum by (account, name, zone) (session_bound) and on(account) (max_over_time(count by(account)(session_bound{account!~"retired|sandbox"})[24h:10m]) > 1))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    cachedHashFetchCount: 2,
    queryDuringUnchangedHashCheck: outputFilter('sum by (name, zone) (sum by (account, name, zone) (session_bound) and on(account) (max_over_time(count by(account)(session_bound{account!~"retired|sandbox"})[24h:10m]) > 1))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    queryAfterUnchangedHashCheck: outputFilter('sum by (name, zone) (sum by (account, name, zone) (session_bound) and on(account) (max_over_time(count by(account)(session_bound{account!~"retired|sandbox"})[24h:10m]) > 1))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    unchangedHashFetchCount: 3,
    queryDuringHashCheck: '',
    rejectedQuery: '',
    buttonsAfterUnsupportedHash: 0,
    safeFailureFallback: outputFilter('sum by (name, zone) (rate(fallback_total[5m]))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    buttonsAfterSafeFallback: 1,
    safeNetworkFailureFallback: outputFilter('sum by (name, zone) (rate(fallback_total[5m]))', { name: 'synthetic-node', zone: 'synthetic-zone' }),
    buttonsAfterNetworkFallback: 1,
    malformedSnapshotReason: 'rule_index_unavailable',
    malformedRuleFallback: '',
    buttonsAfterMalformedRule: 0,
    conflictingIdentityQuery: '',
    buttonsAfterConflictingIdentity: 0
  });

  const discriminatorBrowserCases = [
    { labels: 'host, label_a', scaleLeft: false, scaleRight: false },
    { labels: 'host, label_a, label_b', scaleLeft: true, scaleRight: false },
    { labels: 'host, label_a, label_b, label_c', scaleLeft: false, scaleRight: true },
    { labels: 'host, label_a', scaleLeft: false, scaleRight: false, complex: true }
  ].map(({ labels, scaleLeft, scaleRight, complex }, index) => {
    const left = complex ? `sum by (${labels}) (synthetic_a - synthetic_a * 0.5)` : `sum by (${labels}) (synthetic_a)`;
    const right = `sum by (${labels}) (synthetic_b)`;
    const third = `sum by (${labels}) (avg_over_time(synthetic_c[10m]))`;
    const secondValue = complex ? 'previous.day' : 'second';
    const operand = (query, scaled) => scaled ? `((${query}) * (100))` : query;
    const wrapper = (query, value) => `label_replace((${query}), "branch_axis", "${value}", "", ".*")`;
    return { name: `synthetic.merge.${index}`, expression:
      `merge(addtags(promras('''${left}''', '5m', '2h', '')${scaleLeft ? ' * 100' : ''}, "branch_axis=first"), ` +
      `addtags(promras('''${right}''', '5m', '2h', '')${scaleRight ? ' * 100' : ''}, "branch_axis=${secondValue}")` +
      (complex ? `, addtags(promras('''${third}''', '5m', '2h', ''), "branch_axis=baseline"))` : ')'),
      query: `${wrapper(operand(left, scaleLeft), 'first')} or ${wrapper(operand(right, scaleRight), secondValue)}` +
        (complex ? ` or ${wrapper(third, 'baseline')}` : '') };
  });
  discriminatorBrowserCases.push({ name: 'synthetic.matcher.interpolation',
    prelude: '  $workers = ingestor|deliverer\n  $queues = urgent.one|batch.two\n',
    expression: `promras('''sum by (host) (synthetic_queue{worker=~"$workers",queue=~"$queues"})''', '5m', '2h', '')`,
    query: 'sum by (host) (synthetic_queue{worker=~"ingestor|deliverer",queue=~"urgent.one|batch.two"})' });
  const { fixtures: legacyFixtures, expression: legacyExpression } = require('../legacy-prom-test');
  discriminatorBrowserCases.push(...legacyFixtures.map((fixture) => {
    const selector = `{__name__="${fixture.metric}"${fixture.filter ? ', ' + fixture.filter.replace(/,/g, ', ') : ''}}`;
    const body = fixture.rate ? `rate(${selector}[${fixture.rate}])` : selector;
    return { name: fixture.name, expression: legacyExpression(fixture), source: fixture.source,
      tags: Object.fromEntries(fixture.group.split(',').filter(Boolean).map(label => [label, 'legacy-selected'])),
      query: `sum(${body}) by (${fixture.group.split(',').filter(Boolean).join(', ')})` };
  }));
  const a20MalformedQuotedTags = ['host="a" "b"', 'host="a"x', 'host="a""b"',
    'host="a"trailing', 'host="a" "b" "c"', 'host="a"b"c"', 'host="unterminated',
    'host="a"  garbage', 'host="a""b""c"', "host='a' 'b'",
    'host="a" "b",env=test', 'env=test,host="a" "b"'];
  const stateExprFallbackResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    const openedQueries = [];
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery(query) { openedQueries.push(query); }, cleanupExpired() {}, destroy() {} };
      }
    };
    const previousFetch = globalThis.fetch;
    let activeHash = 'EXPR-H1';
    const config = ${JSON.stringify(`alert synthetic.expr.a {
  $value = promras('''sum by (host) (rate(expr_a_total[5m]))''', '5m', '2h', '')
  warn = 1
}
alert synthetic.expr.b {
  warn = 1
}
alert synthetic.expr.unresolved {
  $q = $missing
  warn = 1
}
alert synthetic.legacy.direct {
  $usage_graph = prom("synthetic_legacy_total", "host", '''env="demo"''', "sum", "1m", "1d", "")
  warn = 1
}
alert synthetic.legacy.q {
  $q = prom("synthetic_legacy_q_total", "host", "", "sum", "1m", "1d", "")
  warn = 1
}
alert synthetic.legacy.dotted {
  $usage_graph = prom("synthetic.legacy.total", "", "", "sum", "1m", "1d", "")
  warn = 1
}
${discriminatorBrowserCases.map(({ name, expression, prelude = '', source = 'usage_graph' }) => `alert ${name} {\n${prelude}  $${source} = ${expression}\n  warn = 1\n}`).join('\n')}
alert synthetic.merge.rejected {
  $usage_graph = ${discriminatorBrowserCases[0].expression.replace('branch_axis=second', 'branch_axis=first')}
  warn = 1
}`)};
    let configGate = null;
    let configStarted = null;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        return { ok: true, status: 200, headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: activeHash }) };
      }
      if (url === '/api/config?hash=') {
        configStarted?.();
        if (configGate) await configGate;
        return { ok: true, status: 200, headers: { get() { return null; } }, text: async () => config };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };
    ${promqlSource}
    ${ruleGraphSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;
    const expr = (query) => "promras('''" + query + "''', '5m', '2h', '')";
    function fixture(name, id, expression, rawTags = 'host=node' + id) {
      const key = name + '{' + rawTags + '}';
      const child = { Alert: name, AlertKey: key, Subject: key, Ago: '3m',
        State: { Id: id, Alert: name, AlertKey: key, Tags: rawTags, Expr: expression } };
      const root = document.createElement('div');
      root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      heading.setAttribute('ng-click', 'toggle()');
      const idNode = document.createElement('span');
      idNode.setAttribute('ng-show', 'state.Id');
      idNode.textContent = '#' + id;
      const subject = document.createElement('span');
      subject.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subject.textContent = key;
      const ago = document.createElement('span');
      ago.setAttribute('ts-since', 'child.Ago');
      ago.textContent = '3m';
      heading.append(idNode, subject, ago);
      panel.append(heading);
      root.append(panel);
      return { name, panel, root, payload: { Groups: { NeedAck: [{
        Subject: 'synthetic expr group', Children: [child]
      }] } } };
    }
    const settle = async () => {
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    };
    function mount(current) {
      document.body.replaceChildren(current.root);
      hooks.applyAlertsPayload(current.payload);
    }
    function observe(current) {
      return { query: hooks.getGrafanaQueryForPanel(current.panel),
        buttons: current.root.querySelectorAll('.bosun-grafana-query-btn').length };
    }
    async function resolved(current) {
      mount(current);
      await hooks.ruleGraphResolver.refresh([current.name]);
      await settle();
      return observe(current);
    }
    try {
      const a = fixture('synthetic.expr.a', 801, expr('sum by (host) (rate(expr_a_total[5m]))'));
      const positive = await resolved(a);
      const verified = hooks.ruleGraphResolver.getSnapshot().available;
      const positiveReason = hooks.ruleGraphResolver.getResolution(a.name)?.reason;
      a.root.querySelector('.bosun-grafana-query-btn')?.click();
      const missing = fixture('synthetic.expr.missing', 803, expr('up'));
      const missingResult = await resolved(missing);
      const missingResolution = hooks.ruleGraphResolver.getResolution(missing.name);
      const unresolved = fixture('synthetic.expr.unresolved', 804, expr('up'));
      const unresolvedResult = await resolved(unresolved);
      const unresolvedReason = hooks.ruleGraphResolver.getResolution(unresolved.name)?.reason;
      const ambiguous = await resolved(fixture('synthetic.expr.a', 805, expr('up') + ' + ' + expr('other_up')));
      const unsupportedQuery = '{__name__=~"synthetic_.*"}';
      const extractedUnsupported = globalThis.BosunHelperPromQL.extractPromrasQuery(expr(unsupportedQuery));
      const unsupported = await resolved(fixture('synthetic.expr.a', 806, expr(unsupportedQuery)));

      const legacy = fixture('synthetic.legacy.direct', 807, expr('fallback_must_not_win'));
      const legacyResult = await resolved(legacy);
      legacy.root.querySelector('.bosun-grafana-query-btn')?.click();
      const legacyQ = fixture('synthetic.legacy.q', 808, expr('fallback_must_not_win'));
      const legacyQResult = await resolved(legacyQ);
      legacyQ.root.querySelector('.bosun-grafana-query-btn')?.click();
      const dotted = fixture('synthetic.legacy.dotted', 809, expr('valid_fallback_total'));
      const dottedResult = await resolved(dotted);
      const dottedReason = hooks.ruleGraphResolver.getResolution(dotted.name)?.reason;
      const malformedTags = fixture('synthetic.legacy.direct', 810, expr('valid_fallback_total'));
      malformedTags.payload.Groups.NeedAck[0].Children[0].State.Tags = 'host=';
      const malformedLegacyTags = await resolved(malformedTags);

      const malformedQuotedTags = [];
      const quotedTagCases = ${JSON.stringify(a20MalformedQuotedTags)};
      for (let index = 0; index < quotedTagCases.length; index += 1) {
        const current = fixture('synthetic.expr.a', 940 + index, expr('up'));
        current.payload.Groups.NeedAck[0].Children[0].State.Tags = quotedTagCases[index];
        malformedQuotedTags.push(await resolved(current));
      }
      const quotedComma = fixture('synthetic.expr.a', 960, expr('up'));
      quotedComma.payload.Groups.NeedAck[0].Children[0].State.Tags = 'host="a,b",env=test';
      const validQuotedTags = await resolved(quotedComma);
      quotedComma.payload.Groups.NeedAck[0].Children[0].State.Tags = quotedTagCases[0];
      hooks.applyAlertsPayload(quotedComma.payload);
      await settle();
      const malformedQuotedRepaint = observe(quotedComma);

      const mergeActions = [];
      const mergeCases = ${JSON.stringify(discriminatorBrowserCases)};
      for (let index = 0; index < mergeCases.length; index += 1) {
        const current = fixture(mergeCases[index].name, 820 + index, expr('fallback_must_not_win'),
          mergeCases[index].tags === undefined ? undefined : Object.entries(mergeCases[index].tags)
            .map(([name, value]) => name + '=' + value).join(','));
        mergeActions.push(await resolved(current));
        current.root.querySelector('.bosun-grafana-query-btn')?.click();
      }
      const conflict = fixture(mergeCases[0].name, 830, expr('valid_fallback_total'));
      conflict.payload.Groups.NeedAck[0].Children[0].State.Tags = 'host=node830,branch_axis=first';
      const mergeConflict = await resolved(conflict);
      const rejectedMerge = await resolved(fixture('synthetic.merge.rejected', 831, expr('valid_fallback_total')));
      const malformedMerge = fixture(mergeCases[0].name, 832, expr('valid_fallback_total'));
      malformedMerge.payload.Groups.NeedAck[0].Children[0].State.Tags = 'host=';
      const malformedMergeTags = await resolved(malformedMerge);

      // Both generations subscribe to a real, delayed config acquisition. Only the
      // latest snapshot/DOM may receive an action when that acquisition completes.
      async function replaceWhilePending(next, hash) {
        await resolved(a);
        activeHash = hash;
        let release;
        configGate = new Promise((resolve) => { release = resolve; });
        const started = new Promise((resolve) => { configStarted = resolve; });
        const refresh = hooks.ruleGraphResolver.refresh([a.name], { force: true });
        hooks.applyAlertsPayload(a.payload);
        await started;
        const pendingA = observe(a);
        mount(next);
        const pendingNext = observe(next);
        release();
        await refresh;
        await settle();
        configGate = null;
        configStarted = null;
        const after = observe(next);
        const oldQuery = hooks.getGrafanaQueryForPanel(a.panel);
        next.root.querySelector('.bosun-grafana-query-btn')?.click();
        return { pendingA, pendingNext, after, oldQuery };
      }
      const replacement = await replaceWhilePending(
        fixture('synthetic.expr.b', 802, expr('sum by (host) (rate(expr_b_total[5m]))')), 'EXPR-H2');
      const forbiddenReplacement = await replaceWhilePending(missing, 'EXPR-H3');
      return { verified, positiveReason, positive, missingResolution, missingResult,
        unresolvedReason, unresolvedResult, ambiguous, extractedUnsupported, unsupported,
        legacyResult, legacyQResult, dottedResult, dottedReason, malformedLegacyTags,
        malformedQuotedTags, validQuotedTags, malformedQuotedRepaint,
        mergeActions, mergeConflict, rejectedMerge, malformedMergeTags,
        replacement, forbiddenReplacement, openedQueries };
    } finally {
      hooks.ruleGraphResolver.destroy();
      globalThis.fetch = previousFetch;
      document.body.replaceChildren();
    }
  })()`);
  const noExprAction = { query: '', buttons: 0 };
  const expectedMergeQueries = discriminatorBrowserCases.map(({ query, tags }, index) =>
    tags && !Object.keys(tags).length ? query : outputFilter(query, tags || { host: 'node' + (820 + index) }));
  assert.deepStrictEqual(stateExprFallbackResult, {
    verified: true,
    positiveReason: 'no_usage_graph',
    positive: { query: outputFilter('sum by (host) (rate(expr_a_total[5m]))', { host: 'node801' }), buttons: 1 },
    missingResolution: null,
    missingResult: noExprAction,
    unresolvedReason: 'unresolved_variable',
    unresolvedResult: noExprAction,
    ambiguous: noExprAction,
    extractedUnsupported: '{__name__=~"synthetic_.*"}',
    unsupported: noExprAction,
    legacyResult: { query: outputFilter('sum(synthetic_legacy_total{env="demo"}) by (host)', { host: 'node807' }), buttons: 1 },
    legacyQResult: { query: outputFilter('sum(synthetic_legacy_q_total) by (host)', { host: 'node808' }), buttons: 1 },
    dottedResult: noExprAction,
    dottedReason: 'direct_prom',
    malformedLegacyTags: noExprAction,
    malformedQuotedTags: a20MalformedQuotedTags.map(() => noExprAction),
    validQuotedTags: { query: outputFilter('up', { host: 'a,b', env: 'test' }), buttons: 1 },
    malformedQuotedRepaint: noExprAction,
    mergeActions: expectedMergeQueries.map((query) => ({ query, buttons: 1 })),
    mergeConflict: { query: outputFilter(discriminatorBrowserCases[0].query, { host: 'node830', branch_axis: 'first' }), buttons: 1 },
    rejectedMerge: noExprAction,
    malformedMergeTags: noExprAction,
    replacement: {
      pendingA: noExprAction, pendingNext: noExprAction,
      after: { query: outputFilter('sum by (host) (rate(expr_b_total[5m]))', { host: 'node802' }), buttons: 1 }, oldQuery: ''
    },
    forbiddenReplacement: {
      pendingA: noExprAction, pendingNext: noExprAction, after: noExprAction, oldQuery: ''
    },
    openedQueries: [
      outputFilter('sum by (host) (rate(expr_a_total[5m]))', { host: 'node801' }),
      outputFilter('sum(synthetic_legacy_total{env="demo"}) by (host)', { host: 'node807' }),
      outputFilter('sum(synthetic_legacy_q_total) by (host)', { host: 'node808' }),
      ...expectedMergeQueries,
      outputFilter('sum by (host) (rate(expr_b_total[5m]))', { host: 'node802' })
    ]
  }, 'State.Expr fallback must obey verified rule resolution, current identity and the common tag pipeline');

  const outputDerivedLabelResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const alertName = 'synthetic.output.derived.label';
    const countValuesAlertName = 'synthetic.count.values.label';
    const ruleConfig = ${JSON.stringify(`alert synthetic.output.derived.label {
  $usage_graph = promras('''label_replace(up, "cluster", "prod", "job", ".*")''', '5m', '2h', '')
  warn = $usage_graph > 0
}
alert synthetic.count.values.label {
  $usage_graph = promras('''count_values("sample_value", temperature)''', '5m', '2h', '')
  warn = $usage_graph > 0
}`)};
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: 'A02-H1' }),
          json: async () => ({ Hash: 'A02-H1' })
        };
      }
      if (url === '/api/config?hash=') {
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => ruleConfig
        };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };

    try {
      ${promqlSource}
      ${ruleGraphSource}
      ${contentSource}
      const hooks = globalThis.__BosunHelperBrowserTest;
      const root = document.createElement('div');
      root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      heading.setAttribute('ng-click', 'toggle()');
      const idNode = document.createElement('span');
      idNode.setAttribute('ng-show', 'state.Id');
      idNode.textContent = '#702';
      heading.appendChild(idNode);
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subjectNode.textContent = alertName + '{cluster=prod}';
      heading.appendChild(subjectNode);
      const agoNode = document.createElement('span');
      agoNode.setAttribute('ts-since', 'child.Ago');
      agoNode.textContent = '4m';
      heading.appendChild(agoNode);
      panel.appendChild(heading);
      root.appendChild(panel);
      document.body.appendChild(root);

      const payload = { Groups: { NeedAck: [{
        Subject: 'synthetic group',
        Children: [{
          Alert: alertName,
          AlertKey: alertName + '{cluster=prod}',
          Subject: alertName + '{cluster=prod}',
          Ago: '4m',
          State: {
            Id: 702,
            Alert: alertName,
            AlertKey: alertName + '{cluster=prod}',
            Tags: 'cluster=prod'
          }
        }]
      }] } };
      hooks.applyAlertsPayload(payload);
      const sourceState = await hooks.ruleGraphResolver.refresh([alertName]);
      const resolution = hooks.ruleGraphResolver.getResolution(alertName);
      const result = {
        sourceAvailable: sourceState.available,
        resolvedQuery: resolution?.query || '',
        grafanaQuery: hooks.getGrafanaQueryForPanel(panel),
        grafanaButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
      };
      const countValuesPayload = JSON.parse(JSON.stringify(payload));
      const countValuesChild = countValuesPayload.Groups.NeedAck[0].Children[0];
      countValuesChild.Alert = countValuesAlertName;
      countValuesChild.AlertKey = countValuesAlertName + '{sample_value=7,host=synthetic-host}';
      countValuesChild.Subject = countValuesChild.AlertKey;
      countValuesChild.State.Alert = countValuesAlertName;
      countValuesChild.State.AlertKey = countValuesChild.AlertKey;
      countValuesChild.State.Tags = 'sample_value=7,host=synthetic-host';
      subjectNode.textContent = countValuesChild.Subject;
      hooks.applyAlertsPayload(countValuesPayload);
      result.countValuesConflict = {
        resolvedQuery: hooks.ruleGraphResolver.getResolution(countValuesAlertName)?.query || '',
        grafanaQuery: hooks.getGrafanaQueryForPanel(panel),
        grafanaButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
      };
      countValuesChild.AlertKey = countValuesAlertName + '{host=synthetic-host}';
      countValuesChild.Subject = countValuesChild.AlertKey;
      countValuesChild.State.AlertKey = countValuesChild.AlertKey;
      countValuesChild.State.Tags = 'host=synthetic-host';
      subjectNode.textContent = countValuesChild.Subject;
      hooks.applyAlertsPayload(countValuesPayload);
      result.countValuesIndependent = {
        grafanaQuery: hooks.getGrafanaQueryForPanel(panel),
        grafanaButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
      };
      countValuesChild.AlertKey = countValuesAlertName + '{sample_value=7}';
      countValuesChild.Subject = countValuesChild.AlertKey;
      countValuesChild.State.AlertKey = countValuesChild.AlertKey;
      countValuesChild.State.Tags = 'sample_value=7';
      subjectNode.textContent = countValuesChild.Subject;
      hooks.applyAlertsPayload(countValuesPayload);
      result.countValuesDerived = {
        grafanaQuery: hooks.getGrafanaQueryForPanel(panel),
        grafanaButtonCount: root.querySelectorAll('.bosun-grafana-query-btn').length
      };
      return result;
    } finally {
      globalThis.fetch = previousFetch;
    }
  })()`);
  assert.deepStrictEqual(outputDerivedLabelResult, {
    sourceAvailable: true,
    resolvedQuery: 'label_replace(up, "cluster", "prod", "job", ".*")',
    grafanaQuery: outputFilter('label_replace(up, "cluster", "prod", "job", ".*")', { cluster: 'prod' }),
    grafanaButtonCount: 1,
    countValuesConflict: {
      resolvedQuery: 'count_values("sample_value", temperature)',
      grafanaQuery: '',
      grafanaButtonCount: 0
    },
    countValuesIndependent: {
      grafanaQuery: '',
      grafanaButtonCount: 0
    },
    countValuesDerived: {
      grafanaQuery: outputFilter('count_values("sample_value", temperature)', { sample_value: '7' }),
      grafanaButtonCount: 1
    }
  });

  const concurrentRuleSnapshotResult = await evaluate(client, `(async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    globalThis.BosunHelperLocalConfig = {
      bosunHosts: ['not-current.invalid'],
      grafanaHost: 'grafana.example.test',
      grafanaPanelUrl: 'https://grafana.example.test/d/test?editPanel=1'
    };
    globalThis.BosunHelperGrafanaHandoff = {
      createGrafanaHandoff() {
        return { openQuery() {}, cleanupExpired() {}, destroy() {} };
      }
    };
    const names = Array.from({ length: 20 }, (_unused, index) => 'synthetic.browser.concurrent.' + index);
    const configText = names.map((name, index) => [
      'alert ' + name + ' {',
      "  $usage_graph = promras('''browser_concurrent_metric_" + index + "''', '5m', '2h', '')",
      '  warn = 1',
      '}'
    ].join('\\n')).join('\\n\\n');
    let configFetchCount = 0;
    let hashFetchCount = 0;
    globalThis.fetch = async (url) => {
      if (url === '/api/config/running_hash') {
        hashFetchCount += 1;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => JSON.stringify({ Hash: 'BROWSER-CONCURRENT-H1' })
        };
      }
      if (url === '/api/config?hash=') {
        configFetchCount += 1;
        return {
          ok: true,
          status: 200,
          headers: { get() { return null; } },
          text: async () => configText
        };
      }
      throw new Error('unexpected synthetic URL: ' + url);
    };
    ${promqlSource}
    ${ruleGraphSource}
    ${contentSource}
    const hooks = globalThis.__BosunHelperBrowserTest;

    await Promise.all(names.map((name) => hooks.ruleGraphResolver.refresh([name])));

    const root = document.createElement('div');
    root.setAttribute('ts-ack-group', 'schedule.Groups.NeedAck');
    const children = names.map((name, index) => {
      const alertKey = name + '{zone=z' + index + '}';
      const panel = document.createElement('div');
      panel.className = 'panel';
      const heading = document.createElement('div');
      heading.className = 'panel-heading';
      heading.setAttribute('ng-click', 'toggle()');
      const idNode = document.createElement('span');
      idNode.setAttribute('ng-show', 'state.Id');
      idNode.textContent = '#' + (800 + index);
      heading.appendChild(idNode);
      const subjectNode = document.createElement('span');
      subjectNode.setAttribute('ng-bind', 'child.Subject || child.AlertKey');
      subjectNode.textContent = alertKey;
      heading.appendChild(subjectNode);
      const agoNode = document.createElement('span');
      agoNode.setAttribute('ts-since', 'child.Ago');
      agoNode.textContent = '1m';
      heading.appendChild(agoNode);
      panel.appendChild(heading);
      root.appendChild(panel);
      return {
        Alert: name,
        AlertKey: alertKey,
        Subject: alertKey,
        Ago: '1m',
        State: {
          Id: 800 + index,
          Alert: name,
          AlertKey: alertKey,
          Tags: 'zone=z' + index,
          Expr: ''
        }
      };
    });
    document.body.appendChild(root);
    const payload = { Groups: { NeedAck: [{ Subject: 'concurrent group', Children: children }] } };
    hooks.applyAlertsPayload(payload);
    hooks.rebuildGrafanaQueryIndex(payload);
    hooks.ensureGrafanaQueryButtons();
    return {
      configFetchCount,
      hashFetchCount,
      actionCount: root.querySelectorAll('.bosun-grafana-query-btn').length,
      allQueriesPresent: Array.from(root.querySelectorAll('.panel')).every((panel, index) => {
        const query = hooks.getGrafanaQueryForPanel(panel);
        return query.startsWith('(\\nbrowser_concurrent_metric_' + index + '\\n) and on (zone)') &&
          query.endsWith('(label_replace(vector(1), "zone", "z' + index + '", "", ".*"))');
      })
    };
  })()`);
  assert.deepStrictEqual(concurrentRuleSnapshotResult, {
    configFetchCount: 1,
    hashFetchCount: 2,
    actionCount: 20,
    allQueriesPresent: true
  });

  return { legacyFixtures, stateExprFallbackResult, expectedMergeQueries };
};
