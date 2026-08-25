'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function loadApi() {
  const context = {
    console,
    globalThis: null,
    URL,
    URLSearchParams,
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync('promql.js', 'utf8'), context, { filename: 'promql.js' });
  vm.runInNewContext(fs.readFileSync('bosun-rule-graph.js', 'utf8'), context, {
    filename: 'bosun-rule-graph.js'
  });
  return context.BosunHelperRuleGraph;
}

function promras(query) {
  return `promras('''${query}''', '5m', '2h', '')`;
}

function alertRule(name, body) {
  return `alert ${name} {\n${body}\n}`;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function response(options = {}) {
  const status = options.status ?? 200;
  const body = options.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-length') {
          return options.contentLength == null ? String(Buffer.byteLength(body)) : String(options.contentLength);
        }
        return null;
      }
    },
    async json() {
      if (options.jsonError) throw new Error('synthetic json error');
      return options.json ?? JSON.parse(body);
    },
    async text() {
      if (options.textError) throw new Error('synthetic text error');
      return body;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function run() {
  const moduleSource = fs.readFileSync('bosun-rule-graph.js', 'utf8');
  assert.ok(!/chrome\.storage|localStorage|sessionStorage/.test(moduleSource));
  assert.ok(!/console\.(?:log|warn|error)/.test(moduleSource), 'Resolver must not log raw source or queries');
  const api = loadApi();
  assert.ok(api, 'Bosun rule graph module must expose its API');

  const selectedQuery = 'sum(rate(selected_total[5m]))';
  const directConfig = [
    alertRule('synthetic.direct', `  $usage_graph = ${promras(selectedQuery)}\n  warn = 1`),
    alertRule('synthetic.unrelated', [
      `  $q = ${promras('sum(rate(unrelated_total[5m]))')}`,
      `  $q1 = ${promras('sum(rate(first_total[5m]))')}`,
      `  $q2 = ${promras('sum(rate(second_total[5m]))')}`,
      `  $limit = ${promras('sum(rate(limit_total[5m]))')}`,
      `  $usage_graph = ${promras(selectedQuery)}`,
      '  warn = $q > 0'
    ].join('\n')),
    alertRule('synthetic.cassandra.compactions.long', [
      `  $q1 = ${promras('sum(rate(cassandra_q1_total[5m]))')}`,
      `  $q2 = ${promras('sum(rate(cassandra_q2_total[5m]))')}`,
      `  $usage_graph = ${promras('sum(rate(cassandra_usage_total[5m]))')}`,
      '  warn = $q1 > 0'
    ].join('\n'))
  ].join('\n\n');

  assert.deepStrictEqual(plain(api.resolveAlertGraph(directConfig, 'synthetic.direct')), {
    ok: true,
    kind: 'single_query',
    reason: 'direct_promras',
    source: 'usage_graph',
    query: selectedQuery,
    queries: [selectedQuery],
    fallbackReason: ''
  });
  assert.strictEqual(
    api.resolveAlertGraph(directConfig, 'synthetic.unrelated').query,
    selectedQuery,
    'Unrelated promras calls must not make a direct usage_graph ambiguous'
  );
  assert.strictEqual(
    api.resolveAlertGraph(directConfig, 'synthetic.cassandra.compactions.long').query,
    'sum(rate(cassandra_usage_total[5m]))',
    'q1/q2 must not hide a direct usage_graph'
  );

  const chainConfig = alertRule('synthetic.chain', [
    `  $q_graph = ${promras(selectedQuery)}`,
    '  $graph = $q_graph',
    '  $usage_graph = $graph',
    '  warn = 1'
  ].join('\n'));
  assert.deepStrictEqual(plain(api.resolveAlertGraph(chainConfig, 'synthetic.chain')), {
    ok: true,
    kind: 'single_query',
    reason: 'direct_promras',
    source: 'usage_graph',
    query: selectedQuery,
    queries: [selectedQuery],
    fallbackReason: ''
  });
  const variableWindowConfig = alertRule('synthetic.variable-window', [
    '  $window = "5m"',
    `  $usage_graph = promras('''${selectedQuery}''', $window, '2h', '')`,
    '  warn = 1'
  ].join('\n'));
  assert.strictEqual(
    api.resolveAlertGraph(variableWindowConfig, 'synthetic.variable-window').query,
    selectedQuery,
    'Non-query promras arguments must not change graph-query selection'
  );

  const errorQuery = 'sum(rate(error_total[5m]))';
  const allQuery = 'sum(rate(all_total[5m]))';
  const computedConfig = alertRule('synthetic.submitresp.errors.high', [
    `  $q_err_g = ${promras(errorQuery)}`,
    `  $q_all_g = ${promras(allQuery)}`,
    '  $ratio = ($q_err_g / $q_all_g) * 100',
    '  $usage_graph = $ratio',
    '  warn = 1'
  ].join('\n'));
  const computed = api.resolveAlertGraph(computedConfig, 'synthetic.submitresp.errors.high');
  assert.strictEqual(computed.ok, true);
  assert.strictEqual(computed.reason, 'computed_graph');
  assert.deepStrictEqual(plain(computed.queries), [errorQuery, allQuery]);
  assert.ok(computed.query.includes(`(${errorQuery}) / (${allQuery})`));

  const dropnaConfig = computedConfig.replace('$usage_graph = $ratio', '$usage_graph = dropna($ratio)');
  const dropnaResult = api.resolveAlertGraph(dropnaConfig, 'synthetic.submitresp.errors.high');
  assert.strictEqual(dropnaResult.ok, false, 'dropna must fail closed until NaN/Inf semantics are preserved');
  assert.strictEqual(dropnaResult.reason, 'computed_graph');

  const mismatchedLabelsConfig = alertRule('synthetic.mismatched-labels', [
    `  $left = ${promras('sum by (channel) (rate(left_total[5m]))')}`,
    `  $right = ${promras('sum by (provider) (rate(right_total[5m]))')}`,
    '  $usage_graph = $left / $right',
    '  warn = 1'
  ].join('\n'));
  assert.strictEqual(
    api.resolveAlertGraph(mismatchedLabelsConfig, 'synthetic.mismatched-labels').reason,
    'computed_graph',
    'Vector arithmetic without proven matching labels must fail closed'
  );

  const precedenceConfig = alertRule('synthetic.precedence', [
    `  $q = ${promras('foo + bar')}`,
    '  $usage_graph = $q * 100',
    '  warn = 1'
  ].join('\n'));
  assert.strictEqual(
    api.resolveAlertGraph(precedenceConfig, 'synthetic.precedence').query,
    '((foo + bar) * (100))',
    'A PromQL leaf must remain grouped when used in computed arithmetic'
  );

  const multiConfig = alertRule('synthetic.multi', [
    `  $left = ${promras('sum(rate(left_total[5m]))')}`,
    `  $right = ${promras('sum(rate(right_total[5m]))')}`,
    '  $usage_graph = merge(addtags($left, "side=left"), addtags($right, "side=right"))',
    '  warn = 1'
  ].join('\n'));
  assert.deepStrictEqual(plain(api.resolveAlertGraph(multiConfig, 'synthetic.multi')), {
    ok: false,
    kind: 'multi_query',
    reason: 'multi_query_graph',
    source: 'usage_graph',
    query: '',
    queries: ['sum(rate(left_total[5m]))', 'sum(rate(right_total[5m]))'],
    fallbackReason: ''
  });
  assert.ok(
    !api.resolveAlertGraph(multiConfig, 'synthetic.multi').query.includes(' or '),
    'Multi-query graph must never be synthesized with or'
  );

  const unsupportedConfig = [
    alertRule('synthetic.cycle', '  $a = $b\n  $b = $a\n  $usage_graph = $a\n  warn = 1'),
    alertRule('synthetic.unresolved', '  $usage_graph = $missing\n  warn = 1'),
    alertRule('synthetic.legacy', '  $usage_graph = prom("sum:metric", "5m", "")\n  warn = 1'),
    alertRule('synthetic.invalid', "  $usage_graph = promras('''broken''', '5m')\n  warn = 1"),
    alertRule('synthetic.interpolation', "  $metric = 'requests_total'\n  $usage_graph = promras('''sum(rate($metric[5m]))''', '5m', '2h', '')\n  warn = 1"),
    alertRule('synthetic.forward', `  $usage_graph = $later\n  $later = ${promras('forward_total')}\n  warn = 1`)
  ].join('\n\n');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.cycle').reason, 'cyclic_variable');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.unresolved').reason, 'unresolved_variable');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.legacy').reason, 'legacy_prom');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.invalid').reason, 'invalid_promras');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.interpolation').reason, 'unresolved_variable');
  assert.strictEqual(api.resolveAlertGraph(unsupportedConfig, 'synthetic.forward').reason, 'unresolved_variable');

  const slashNameConfig = alertRule('synthetic.team/service', `  $usage_graph = ${promras('service_total')}\n  warn = 1`);
  assert.strictEqual(api.resolveAlertGraph(slashNameConfig, 'synthetic.team/service').query, 'service_total');

  const excessiveNesting = '('.repeat(65) + `$q` + ')'.repeat(65);
  const boundedConfig = alertRule('synthetic.bounded', [
    `  $q = ${promras('bounded_total')}`,
    `  $usage_graph = ${excessiveNesting}`,
    '  warn = 1'
  ].join('\n'));
  const boundedResult = api.resolveAlertGraph(boundedConfig, 'synthetic.bounded');
  assert.strictEqual(boundedResult.reason, 'computed_graph');

  const expensiveExpression = `$base${' + 1'.repeat(1500)}`;
  const repeatedExpression = Array(500).fill('$expensive').join(' + ');
  const repeatedConfig = alertRule('synthetic.repeated-work', [
    `  $base = ${promras('work_total')}`,
    `  $expensive = ${expensiveExpression}`,
    `  $usage_graph = ${repeatedExpression}`,
    '  warn = 1'
  ].join('\n'));
  const repeatedStartedAt = Date.now();
  assert.strictEqual(api.resolveAlertGraph(repeatedConfig, 'synthetic.repeated-work').ok, false);
  assert.ok(
    Date.now() - repeatedStartedAt < 1000,
    'Repeated variables must be memoized and terminal parse errors must short-circuit'
  );

  const qFallbackQuery = 'sum(rate(fallback_total[5m]))';
  const qFallbackConfig = alertRule('synthetic.q-fallback', [
    `  $q = ${promras(qFallbackQuery)}`,
    '  warn = $q > 0'
  ].join('\n'));
  assert.deepStrictEqual(plain(api.resolveAlertGraph(qFallbackConfig, 'synthetic.q-fallback')), {
    ok: true,
    kind: 'single_query',
    reason: 'direct_promras',
    source: 'q',
    query: qFallbackQuery,
    queries: [qFallbackQuery],
    fallbackReason: 'no_usage_graph'
  });

  const fakeAssignmentConfig = alertRule('synthetic.fake', [
    `  # $usage_graph = ${promras('comment_total')}`,
    `  $description = "fake $usage_graph = ${promras('string_total')}"`,
    `  $q = ${promras(qFallbackQuery)}`,
    '  warn = 1'
  ].join('\n'));
  assert.strictEqual(api.resolveAlertGraph(fakeAssignmentConfig, 'synthetic.fake').source, 'q');

  const malformedConfig = 'alert synthetic.malformed {\n  $usage_graph = promras(\'\'\'metric\'\'\'\n';
  assert.strictEqual(
    api.resolveAlertGraph(malformedConfig, 'synthetic.malformed').reason,
    'invalid_rule_source'
  );
  assert.strictEqual(
    api.resolveAlertGraph(`${qFallbackConfig}\n${qFallbackConfig}`, 'synthetic.q-fallback').reason,
    'invalid_rule_source',
    'Duplicate alert definitions must fail closed'
  );

  const concurrentNames = Array.from({ length: 20 }, (_unused, index) => `synthetic.concurrent.${index}`);
  const concurrentConfig = concurrentNames.map((name, index) => {
    return alertRule(name, `  $usage_graph = ${promras(`concurrent_metric_${index}`)}\n  warn = 1`);
  }).join('\n\n');
  const concurrentCalls = [];
  const concurrentConfigGate = deferred();
  const concurrentResolver = api.createRuleGraphResolver({
    fetchImpl: async (url, init) => {
      concurrentCalls.push({ url, init });
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'CONCURRENT-H1' }) });
      }
      if (url === '/api/config?hash=') return concurrentConfigGate.promise;
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: () => 1000,
    hashCheckIntervalMs: 60000
  });
  const concurrentPending = concurrentNames.map((name) => concurrentResolver.refresh([name]));
  await flushMicrotasks();
  assert.deepStrictEqual(
    concurrentCalls.map((entry) => entry.url),
    ['/api/config/running_hash', '/api/config?hash='],
    'All concurrent lookups must join while the one config request is pending'
  );
  concurrentConfigGate.resolve(response({ body: concurrentConfig }));
  const concurrentSnapshots = await Promise.all(concurrentPending);
  assert.ok(concurrentSnapshots.every((snapshot) => snapshot.available === true));
  assert.deepStrictEqual(
    concurrentCalls.map((entry) => entry.url),
    ['/api/config/running_hash', '/api/config?hash=', '/api/config/running_hash'],
    'Concurrent alert lookups must share one full-config snapshot acquisition'
  );
  concurrentNames.forEach((name, index) => {
    assert.strictEqual(concurrentResolver.getResolution(name).query, `concurrent_metric_${index}`);
  });
  const callsBeforeMissingLookup = concurrentCalls.length;
  const missingSnapshot = await concurrentResolver.refresh(['synthetic.concurrent.missing']);
  assert.strictEqual(missingSnapshot.available, true);
  assert.strictEqual(
    concurrentCalls.length,
    callsBeforeMissingLookup,
    'A missing definition in a loaded snapshot must be negative-cached without refetching config'
  );
  assert.strictEqual(concurrentResolver.getResolution('synthetic.concurrent.missing'), null);

  const scannerCanary = 'NEVER_LOG_RULECONF_CANARY';
  const scannerConfig = [
    'template synthetic.template {',
    '  subject = "quoted alert fake.quoted { braces }"',
    '  body = `backtick alert fake.backtick { braces }`',
    "  note = '''triple alert fake.triple { braces }'''",
    '}',
    'lookup synthetic.lookup {',
    '  entry host=synthetic {',
    '    value = "lookup alert fake.lookup { braces }"',
    '  }',
    '}',
    '# alert fake.comment { braces }',
    alertRule('synthetic.scanner.direct', [
      `  $usage_graph = ${promras(scannerCanary)}`,
      '  warn = 1'
    ].join('\n')),
    alertRule('synthetic.scanner.legacy', [
      '  $usage_graph = prom("legacy:metric", "5m", "")',
      '  warn = 1'
    ].join('\n'))
  ].join('\n\n');
  const scannerResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'SCANNER-HASH' }) });
      }
      if (url === '/api/config?hash=') return response({ body: scannerConfig });
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 60000
  });
  const scannerSnapshot = await scannerResolver.refresh(['synthetic.scanner.direct']);
  assert.strictEqual(scannerSnapshot.available, true);
  assert.strictEqual(scannerResolver.getResolution('synthetic.scanner.direct').query, scannerCanary);
  assert.strictEqual(scannerResolver.getResolution('synthetic.scanner.legacy').reason, 'legacy_prom');

  const opaqueLookupQuery = 'sum(rate(opaque_lookup_metric_total[5m]))';
  const opaqueLookupConfig = [
    'lookup synthetic.routing {',
    '  entry host=nyhq-|-int|den-*|lon-* {',
    "    route_pattern = ^/v[0-9]{2,4}/(primary|canary)'?$",
    '    description = alert fake.lookup { opaque braces must not be indexed }',
    '  }',
    '}',
    'template synthetic.opaque-template {',
    '  subject = opaque template',
    '  body = `{{if .Alert}} alert fake.template { } {{end}}`',
    '}',
    '# alert fake.comment { }',
    alertRule('synthetic.opaque.direct', [
      `  $usage_graph = ${promras(opaqueLookupQuery)}`,
      '  warn = 1'
    ].join('\n')),
    alertRule('synthetic.opaque.legacy', [
      '  $usage_graph = prom("legacy:opaque", "5m", "")',
      '  warn = 1'
    ].join('\n'))
  ].join('\n');
  const opaqueLookupResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'OPAQUE-LOOKUP-HASH' }) });
      }
      if (url === '/api/config?hash=') return response({ body: opaqueLookupConfig });
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 60000
  });
  const opaqueLookupSnapshot = await opaqueLookupResolver.refresh(['synthetic.opaque.direct']);
  assert.strictEqual(
    opaqueLookupSnapshot.available,
    true,
    'Valid opaque lookup syntax before alerts must not reject the full rule index'
  );
  assert.strictEqual(
    opaqueLookupResolver.getResolution('synthetic.opaque.direct').query,
    opaqueLookupQuery
  );
  assert.strictEqual(opaqueLookupResolver.getResolution('synthetic.opaque.legacy').reason, 'legacy_prom');
  assert.strictEqual(opaqueLookupResolver.getResolution('fake.lookup'), null);
  assert.strictEqual(opaqueLookupResolver.getResolution('fake.template'), null);

  const alertOpaqueValueQuery = 'sum(rate(alert_opaque_value_total[5m]))';
  const alertOpaqueValueConfig = [
    'alert synthetic.alert-opaque-value {',
    "  $notes = \"example promras(''' shown as text\" plus operator's { brace",
    "  $runbook = Example syntax is promras(''' without the closing delimiter",
    '  description = alert fake.inside-value { must stay opaque }',
    `  $usage_graph = ${promras(alertOpaqueValueQuery)}`,
    '  warn = 1',
    '}',
    alertRule(
      'synthetic.after-alert-opaque-value',
      `  $usage_graph = ${promras('after_alert_opaque_value_total')}`
    )
  ].join('\n');
  const alertOpaqueValueIndex = await collectIndexSnapshot(
    alertOpaqueValueConfig,
    'ALERT-OPAQUE-VALUE-CANARY'
  );
  assert.strictEqual(
    alertOpaqueValueIndex.snapshot.available,
    true,
    'Ordinary alert pair values must be opaque through end-of-line'
  );
  assert.strictEqual(
    api.resolveAlertGraph(alertOpaqueValueConfig, 'synthetic.alert-opaque-value').query,
    alertOpaqueValueQuery
  );
  assert.strictEqual(
    api.resolveAlertGraph(alertOpaqueValueConfig, 'synthetic.after-alert-opaque-value').query,
    'after_alert_opaque_value_total'
  );

  const trailingProseConfig = alertRule('synthetic.trailing-prose', [
    `  $usage_graph = ${promras('trailing_prose_metric_total')}`,
    "  $runbook = Example syntax is promras(''' without a closing delimiter",
    '  warn = 1'
  ].join('\n'));
  assert.strictEqual(
    api.resolveAlertGraph(trailingProseConfig, 'synthetic.trailing-prose').query,
    'trailing_prose_metric_total',
    'An incomplete call-shaped prose value at EOF must remain EOL-opaque'
  );

  const multilinePromrasQuery = [
    'sum(',
    '  synthetic_multiline_metric{',
    '    role="primary"',
    '  }',
    ')'
  ].join('\n');
  const multilinePromrasConfig = alertRule(
    'synthetic.multiline-promras',
    `  $usage_graph = ${promras(multilinePromrasQuery)}\n  warn = 1`
  );
  assert.strictEqual(
    api.resolveAlertGraph(multilinePromrasConfig, 'synthetic.multiline-promras').query,
    multilinePromrasQuery,
    'A proven promras triple-quoted argument may safely span physical lines'
  );

  const splitHeaderConfig = [
    'alert synthetic.split-header',
    '# whitespace/comments between a section name and its opening brace are valid',
    '{',
    `  $usage_graph = ${promras('split_header_metric_total')}`,
    '  warn = 1',
    '}',
    'lookup synthetic.split-lookup',
    '{',
    '  entry host=*',
    '  {',
    '    route_pattern = ^/v[0-9]+/(primary|canary)$',
    '  }',
    '}'
  ].join('\n');
  const splitHeaderIndex = await collectIndexSnapshot(
    splitHeaderConfig,
    'SPLIT-HEADER-CANARY'
  );
  assert.strictEqual(
    splitHeaderIndex.snapshot.available,
    true,
    'Section header tokens may be separated by RuleConf whitespace/comments'
  );

  const compactOpaqueConfig = [
    'lookup synthetic.compact { entry host=* {',
    '  route_pattern = ^/(primary|canary)$',
    '} }',
    'template synthetic.raw-close { body = `opaque { alert fake.raw { } }` }',
    alertRule(
      'synthetic.after-compact-opaque',
      `  $usage_graph = ${promras('after_compact_opaque_total')}`
    )
  ].join('\n');
  const compactOpaqueIndex = await collectIndexSnapshot(
    compactOpaqueConfig,
    'COMPACT-OPAQUE-CANARY'
  );
  assert.strictEqual(
    compactOpaqueIndex.snapshot.available,
    true,
    'Nested opaque headers and a raw-string close may share physical lines'
  );

  const productionSizedLookup = ['lookup synthetic.production-sized {'];
  const productionSizedFiller = 'opaque-value-'.repeat(126);
  for (let index = 0; index < 350; index += 1) {
    productionSizedLookup.push(
      `  entry host=zone-*|node-${index} {`,
      "    route_pattern = ^/v[0-9]{2,4}/(primary|canary)'?$",
      `    opaque = ${productionSizedFiller}`,
      '  }'
    );
  }
  productionSizedLookup.push('}');
  const productionSizedAlerts = Array.from({ length: 388 }, (_unused, index) => alertRule(
    `synthetic.production-sized.${index}`,
    `  $usage_graph = ${promras(`synthetic_production_sized_metric_${index}`)}\n  warn = 1`
  ));
  const productionSizedConfig = productionSizedLookup.concat(productionSizedAlerts).join('\n');
  assert.ok(
    productionSizedConfig.length > 600000,
    'The synthetic fixture must exercise the live config size class without production data'
  );
  const productionSizedIndex = await collectIndexSnapshot(
    productionSizedConfig,
    'PRODUCTION-SIZED-SYNTHETIC-CANARY'
  );
  assert.strictEqual(productionSizedIndex.snapshot.available, true);
  const productionSizedBlocks = api.extractAlertBlocks(
    productionSizedConfig,
    [],
    { collectAll: true }
  );
  assert.strictEqual(productionSizedBlocks.ok, true);
  assert.strictEqual(productionSizedBlocks.blocks.size, 388);

  const budgetExpression = `$q${' + 1'.repeat(1800)}`;
  const budgetConfig = [
    ...Array.from({ length: 280 }, (_unused, index) => alertRule(
      `synthetic.snapshot.budget.${index}`,
      `  $q = ${promras(`budget_metric_${index}`)}\n  $usage_graph = ${budgetExpression}\n  warn = 1`
    )),
    alertRule(
      'synthetic.snapshot.after-budget',
      `  $usage_graph = ${promras('must_not_be_partially_published')}\n  warn = 1`
    )
  ].join('\n\n');
  let budgetNow = 1000;
  let budgetConfigRequests = 0;
  let budgetHashRequests = 0;
  let budgetHash = 'BUDGET-H1';
  let budgetResponseConfig = budgetConfig;
  const budgetResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        budgetHashRequests += 1;
        return response({ body: JSON.stringify({ Hash: budgetHash }) });
      }
      if (url === '/api/config?hash=') {
        budgetConfigRequests += 1;
        return response({ body: budgetResponseConfig });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: () => budgetNow,
    hashCheckIntervalMs: 60000,
    failureRetryMs: 60000
  });
  const budgetSnapshot = await budgetResolver.refresh(['synthetic.snapshot.after-budget']);
  assert.strictEqual(budgetSnapshot.available, false);
  assert.strictEqual(budgetSnapshot.reason, 'rule_index_unavailable');
  assert.strictEqual(
    budgetResolver.getResolution('synthetic.snapshot.after-budget'),
    null,
    'A batch-budget exhaustion must reject the whole candidate snapshot'
  );
  for (let index = 0; index < 20; index += 1) {
    budgetNow += 1000;
    const retrySnapshot = await budgetResolver.refresh(['synthetic.snapshot.after-budget'], { verify: true });
    assert.strictEqual(retrySnapshot.available, false);
  }
  assert.strictEqual(budgetConfigRequests, 1, 'Rejected index retries must respect failure backoff');
  budgetNow += 60000;
  const unchangedRejectedSnapshot = await budgetResolver.refresh(
    ['synthetic.snapshot.after-budget'],
    { verify: true }
  );
  assert.strictEqual(unchangedRejectedSnapshot.available, false);
  assert.strictEqual(unchangedRejectedSnapshot.reason, 'rule_index_unavailable');
  assert.strictEqual(budgetHashRequests, 3, 'An expired rejection backoff performs one hash-only check');
  assert.strictEqual(
    budgetConfigRequests,
    1,
    'An unchanged rejected hash must not redownload or reparse the full RuleConf'
  );

  budgetNow += 60000;
  budgetHash = 'BUDGET-H2';
  budgetResponseConfig = alertRule(
    'synthetic.snapshot.after-budget',
    `  $usage_graph = ${promras('accepted_after_rejected_hash_change_total')}\n  warn = 1`
  );
  const changedRejectedSnapshot = await budgetResolver.refresh(
    ['synthetic.snapshot.after-budget'],
    { verify: true }
  );
  assert.strictEqual(changedRejectedSnapshot.available, true);
  assert.strictEqual(budgetHashRequests, 5, 'A changed hash performs one consistent H1/H2 pair');
  assert.strictEqual(budgetConfigRequests, 2, 'A changed hash performs exactly one new config fetch');

  async function collectIndexSnapshot(config, hashValue) {
    const candidate = api.createRuleGraphResolver({
      fetchImpl: async (url) => {
        if (url === '/api/config/running_hash') {
          return response({ body: JSON.stringify({ Hash: hashValue }) });
        }
        if (url === '/api/config?hash=') return response({ body: config });
        throw new Error(`Unexpected URL: ${url}`);
      },
      hashCheckIntervalMs: 60000
    });
    const candidateSnapshot = await candidate.refresh(['synthetic.diagnostic']);
    candidate.destroy();
    return { snapshot: candidateSnapshot };
  }

  const malformedIndex = await collectIndexSnapshot(
    'alert synthetic.diagnostic {\n  $usage_graph = promras(\'\'\'metric\'\'\', \'5m\', \'2h\', \'\')',
    'MALFORMED-CANARY'
  );
  assert.strictEqual(malformedIndex.snapshot.reason, 'rule_index_unavailable');

  const lexerSource = 'template synthetic.template {\n  body = `unterminated alert synthetic.diagnostic {';
  const lexerIndex = await collectIndexSnapshot(
    lexerSource,
    'LEXER-CANARY'
  );
  assert.strictEqual(lexerIndex.snapshot.reason, 'rule_index_unavailable');

  const ambiguousOpaqueConfig = [
    'lookup synthetic.unclosed {',
    '  entry host=* {',
    '    threshold = 1',
    '  }',
    alertRule('synthetic.diagnostic', `  $usage_graph = ${promras('must_not_publish')}`)
  ].join('\n');
  const ambiguousOpaqueIndex = await collectIndexSnapshot(
    ambiguousOpaqueConfig,
    'AMBIGUOUS-OPAQUE-CANARY'
  );
  assert.strictEqual(ambiguousOpaqueIndex.snapshot.reason, 'rule_index_unavailable');

  const tripleLexerSource = [
    'alert synthetic.diagnostic {',
    "  $usage_graph = promras('''unterminated, '5m', '2h', '')",
    '}',
    alertRule('synthetic.after-triple', '  warn = 1')
  ].join('\n');
  const tripleLexerIndex = await collectIndexSnapshot(
    tripleLexerSource,
    'TRIPLE-LEXER-CANARY'
  );
  assert.strictEqual(tripleLexerIndex.snapshot.available, true);

  const workLimitConfig = Array.from({ length: 2001 }, (_unused, index) => (
    alertRule(`synthetic.work-limit.${index}`, '  warn = 1')
  )).join('\n');
  const workLimitIndex = await collectIndexSnapshot(workLimitConfig, 'WORK-LIMIT-CANARY');
  assert.strictEqual(workLimitIndex.snapshot.reason, 'rule_index_unavailable');

  const duplicateResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'DUPLICATE-CANARY' }) });
      }
      if (url === '/api/config?hash=') return response({ body: `${qFallbackConfig}\n${qFallbackConfig}` });
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 60000
  });
  assert.strictEqual((await duplicateResolver.refresh(['synthetic.q-fallback'])).available, true);
  assert.strictEqual(duplicateResolver.getResolution('synthetic.q-fallback').ok, false);

  const penaltyBudgetConfig = Array.from({ length: 245 }, (_unused, index) => alertRule(
    `synthetic.penalty-budget.${index}`,
    `  $q = ${promras(`penalty_metric_${index}`)}\n  $usage_graph = $q @\n  warn = 1`
  )).join('\n');
  const penaltyBudget = await collectIndexSnapshot(
    penaltyBudgetConfig,
    'PENALTY-BUDGET-CANARY'
  );
  assert.strictEqual(penaltyBudget.snapshot.reason, 'rule_index_unavailable');

  const calls = [];
  let hash = 'H1 /+?';
  let configText = directConfig;
  const resolver = api.createRuleGraphResolver({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/config/running_hash') return response({ body: JSON.stringify({ Hash: hash }) });
      if (url === '/api/config?hash=') return response({ body: configText });
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: () => 1000,
    hashCheckIntervalMs: 60000
  });
  assert.strictEqual(resolver.getSnapshot().reason, 'not_loaded');
  const h1 = await resolver.refresh(['synthetic.direct', 'synthetic.unrelated']);
  assert.strictEqual(h1.available, true);
  assert.strictEqual(h1.hash, 'H1 /+?');
  assert.deepStrictEqual(
    calls.slice(0, 3).map((entry) => entry.url),
    ['/api/config/running_hash', '/api/config?hash=', '/api/config/running_hash'],
    'RuleConf must come from the empty-hash Rule Editor URL and be bracketed by hash checks'
  );
  assert.ok(
    calls.every((entry) => !entry.url.includes(encodeURIComponent(hash))),
    'The running hash is a version token and must not be sent as the config hash value'
  );
  assert.strictEqual(resolver.getResolution('synthetic.direct').query, selectedQuery);
  assert.strictEqual(calls.filter((entry) => entry.url.startsWith('/api/config?')).length, 1);
  assert.ok(calls.every((entry) => entry.init.cache === 'no-store'));
  assert.ok(calls.every((entry) => entry.init.credentials === 'same-origin'));
  const callsBeforeCacheHit = calls.length;
  await resolver.refresh(['synthetic.direct']);
  assert.strictEqual(calls.length, callsBeforeCacheHit, 'A fresh resolved name must use memory cache only');
  assert.strictEqual(
    calls.filter((entry) => entry.url.startsWith('/api/config?')).length,
    1,
    'Same running hash must reuse parsed definitions'
  );

  const callsBeforeCacheMiss = calls.length;
  await resolver.refresh(['synthetic.cassandra.compactions.long']);
  assert.deepStrictEqual(
    calls.slice(callsBeforeCacheMiss).map((entry) => entry.url),
    [],
    'A new alert name must resolve from the accepted full-config snapshot'
  );
  assert.strictEqual(
    resolver.getResolution('synthetic.cassandra.compactions.long').query,
    'sum(rate(cassandra_usage_total[5m]))'
  );
  assert.strictEqual(calls.filter((entry) => entry.url.startsWith('/api/config?')).length, 1);

  let cycleNow = 0;
  let cycleHash = 'CYCLE-H1';
  let cycleMetric = 'cycle_metric_h1';
  let cycleHashRequests = 0;
  let cycleConfigRequests = 0;
  const cycleResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        cycleHashRequests += 1;
        return response({ body: JSON.stringify({ Hash: cycleHash }) });
      }
      if (url === '/api/config?hash=') {
        cycleConfigRequests += 1;
        return response({
          body: alertRule('synthetic.cycle-cache', `  $usage_graph = ${promras(cycleMetric)}\n  warn = 1`)
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    now: () => cycleNow,
    hashCheckIntervalMs: 1000
  });
  assert.strictEqual((await cycleResolver.refresh(['synthetic.cycle-cache'])).available, true);
  assert.strictEqual(cycleHashRequests, 2, 'Initial snapshot must use one stable H1/H2 pair');
  assert.strictEqual(cycleConfigRequests, 1);
  for (let index = 0; index < 20; index += 1) {
    cycleNow += 1000;
    assert.strictEqual(
      (await cycleResolver.refresh(['synthetic.cycle-cache'])).available,
      true
    );
  }
  assert.strictEqual(cycleHashRequests, 22, 'Scheduled refreshes may check only running_hash');
  assert.strictEqual(cycleConfigRequests, 1, 'An unchanged hash must not refetch RuleConf');
  cycleHash = 'CYCLE-H2';
  cycleMetric = 'cycle_metric_h2';
  cycleNow += 1000;
  assert.strictEqual((await cycleResolver.refresh(['synthetic.cycle-cache'])).available, true);
  assert.strictEqual(cycleHashRequests, 24, 'A changed hash must acquire one new stable H1/H2 pair');
  assert.strictEqual(cycleConfigRequests, 2, 'A changed hash must fetch one new RuleConf');
  assert.strictEqual(cycleResolver.getResolution('synthetic.cycle-cache').query, 'cycle_metric_h2');

  hash = 'H2';
  configText = alertRule('synthetic.direct', `  $usage_graph = ${promras('sum(rate(h2_total[5m]))')}\n  warn = 1`);
  await resolver.refresh(['synthetic.direct'], { force: true });
  assert.strictEqual(resolver.getResolution('synthetic.direct').query, 'sum(rate(h2_total[5m]))');
  assert.strictEqual(calls.filter((entry) => entry.url.startsWith('/api/config?')).length, 2);

  let stabilityHashCall = 0;
  let stabilityConfigCall = 0;
  const stabilityCalls = [];
  const stabilityResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      stabilityCalls.push(url);
      if (url === '/api/config/running_hash') {
        stabilityHashCall += 1;
        return response({
          body: JSON.stringify({ Hash: stabilityHashCall === 1 ? 'UNSTABLE-H1' : 'STABLE-H2' })
        });
      }
      if (url === '/api/config?hash=') {
        stabilityConfigCall += 1;
        const metric = stabilityConfigCall === 1 ? 'stale_metric' : 'current_metric';
        return response({
          body: alertRule('synthetic.direct', `  $usage_graph = ${promras(metric)}\n  warn = 1`)
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 0
  });
  const stableAfterRetry = await stabilityResolver.refresh(['synthetic.direct'], { force: true });
  assert.strictEqual(stableAfterRetry.available, true);
  assert.strictEqual(stableAfterRetry.hash, 'STABLE-H2');
  assert.strictEqual(stabilityResolver.getResolution('synthetic.direct').query, 'current_metric');
  assert.deepStrictEqual(stabilityCalls, [
    '/api/config/running_hash',
    '/api/config?hash=',
    '/api/config/running_hash',
    '/api/config?hash=',
    '/api/config/running_hash'
  ]);

  let changingHashCalls = 0;
  let changingConfigCalls = 0;
  const continuouslyChangingResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        changingHashCalls += 1;
        return response({ body: JSON.stringify({ Hash: `CHANGING-${changingHashCalls}` }) });
      }
      if (url === '/api/config?hash=') {
        changingConfigCalls += 1;
        return response({
          body: alertRule('synthetic.direct', `  $usage_graph = ${promras('never_accepted_metric')}\n  warn = 1`)
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 0
  });
  const continuouslyChanging = await continuouslyChangingResolver.refresh(
    ['synthetic.direct'],
    { force: true }
  );
  assert.strictEqual(continuouslyChanging.available, false);
  assert.strictEqual(continuouslyChanging.reason, 'config_unavailable');
  assert.strictEqual(continuouslyChangingResolver.getResolution('synthetic.direct'), null);
  assert.strictEqual(changingConfigCalls, 2, 'An unstable config may be retried only a bounded number of times');
  assert.strictEqual(changingHashCalls, 3);

  const staleH1Config = deferred();
  let hashCalls = 0;
  let staleConfigCalls = 0;
  const staleResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        hashCalls += 1;
        return response({ body: JSON.stringify({ Hash: hashCalls === 1 ? 'STALE-H1' : 'CURRENT-H2' }) });
      }
      if (url === '/api/config?hash=') {
        staleConfigCalls += 1;
        if (staleConfigCalls === 1) return staleH1Config.promise;
        return response({ body: alertRule('synthetic.direct', `  $usage_graph = ${promras('current_metric')}\n  warn = 1`) });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 0
  });
  const staleRefresh = staleResolver.refresh(['synthetic.direct'], { force: true });
  await flushMicrotasks();
  const queuedForceRefresh = staleResolver.refresh(['synthetic.direct'], { force: true });
  await flushMicrotasks();
  assert.strictEqual(staleConfigCalls, 1, 'A forced refresh must not overlap an in-flight snapshot');
  staleH1Config.resolve(response({
    body: alertRule('synthetic.direct', `  $usage_graph = ${promras('stale_metric')}\n  warn = 1`)
  }));
  await staleRefresh;
  await queuedForceRefresh;
  assert.strictEqual(
    staleResolver.getResolution('synthetic.direct').query,
    'current_metric',
    'Late stale config must not replace the current hash result'
  );

  let failedRequestCount = 0;
  const failedResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      failedRequestCount += 1;
      if (url === '/api/config/running_hash') return response({ body: JSON.stringify({ Hash: 'FAIL' }) });
      return response({ status: 500, body: 'synthetic failure body must not be parsed' });
    },
    hashCheckIntervalMs: 0
  });
  const failed = await failedResolver.refresh(['synthetic.direct']);
  assert.strictEqual(failed.available, false);
  assert.strictEqual(failed.reason, 'config_unavailable');
  assert.strictEqual(failedResolver.getResolution('synthetic.direct'), null);
  await failedResolver.refresh(['synthetic.direct'], { verify: true });
  assert.strictEqual(failedRequestCount, 2, 'Repeated snapshots must respect failure backoff');
  await failedResolver.refresh(['synthetic.direct'], { force: true });
  assert.strictEqual(failedRequestCount, 4, 'An explicit force refresh may bypass failure backoff');

  const oversizedResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'OVERSIZED' }) });
      }
      return response({
        body: 'must not be read',
        contentLength: api.MAX_CONFIG_LENGTH + 1,
        textError: true
      });
    },
    hashCheckIntervalMs: 0
  });
  const oversized = await oversizedResolver.refresh(['synthetic.direct']);
  assert.strictEqual(oversized.available, false);
  assert.strictEqual(oversized.reason, 'config_unavailable');

  const networkFailedResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'NETWORK-FAIL' }) });
      }
      if (url === '/api/config?hash=') throw new Error('synthetic network failure');
      throw new Error(`Unexpected URL: ${url}`);
    },
    hashCheckIntervalMs: 0
  });
  const networkFailed = await networkFailedResolver.refresh(['synthetic.direct']);
  assert.strictEqual(networkFailed.available, false);
  assert.strictEqual(networkFailed.reason, 'config_unavailable');
  assert.strictEqual(networkFailedResolver.getResolution('synthetic.direct'), null);

  const stoppedHash = deferred();
  let stoppedSignal = null;
  const stoppedResolver = api.createRuleGraphResolver({
    fetchImpl: async (_url, init) => {
      stoppedSignal = init.signal;
      return stoppedHash.promise;
    },
    hashCheckIntervalMs: 0
  });
  const stoppedRefresh = stoppedResolver.refresh(['synthetic.direct']);
  await flushMicrotasks();
  assert.strictEqual(stoppedResolver.getSnapshot().reason, 'loading');
  stoppedResolver.stop();
  assert.strictEqual(stoppedResolver.getSnapshot().reason, 'stopped');
  assert.strictEqual(stoppedSignal.aborted, true, 'Stop must abort the pending rule request');
  stoppedHash.resolve(response({ body: JSON.stringify({ Hash: 'LATE' }) }));
  assert.strictEqual((await stoppedRefresh).reason, 'stale_result');
  assert.strictEqual(stoppedResolver.getResolution('synthetic.direct'), null);

  const queuedConfig = deferred();
  const queuedCalls = [];
  const queuedResolver = api.createRuleGraphResolver({
    fetchImpl: async (url) => {
      queuedCalls.push(url);
      if (url === '/api/config/running_hash') {
        return response({ body: JSON.stringify({ Hash: 'QUEUED' }) });
      }
      return queuedConfig.promise;
    },
    hashCheckIntervalMs: 0
  });
  const queuedFirst = queuedResolver.refresh(['synthetic.direct']);
  await flushMicrotasks();
  const queuedSecond = queuedResolver.refresh(['synthetic.unrelated']);
  queuedResolver.stop();
  queuedConfig.resolve(response({ body: directConfig }));
  assert.strictEqual((await queuedFirst).reason, 'stale_result');
  assert.strictEqual((await queuedSecond).reason, 'stale_result');
  assert.strictEqual(
    queuedCalls.length,
    2,
    'A queued refresh must not restart network acquisition after stop'
  );

  resolver.destroy();
  concurrentResolver.destroy();
  scannerResolver.destroy();
  opaqueLookupResolver.destroy();
  budgetResolver.destroy();
  duplicateResolver.destroy();
  cycleResolver.destroy();
  stabilityResolver.destroy();
  continuouslyChangingResolver.destroy();
  staleResolver.destroy();
  failedResolver.destroy();
  oversizedResolver.destroy();
  networkFailedResolver.destroy();
  stoppedResolver.destroy();
  queuedResolver.destroy();
  assert.strictEqual(resolver.getResolution('synthetic.direct'), null, 'Destroy must clear parsed definitions');

  console.log('Rule graph tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
