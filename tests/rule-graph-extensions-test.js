'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({});
for (const file of ['promql.js', 'bosun-rule-graph.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/grafana', file), 'utf8'), context);
}
const graph = context.BosunHelperRuleGraph;
const promql = context.BosunHelperPromQL;
const tests = [];
const test = (name, run) => tests.push({ name, run });
const plain = value => JSON.parse(JSON.stringify(value));
const promras = query => `promras('''${query}''', '5m', '2h', '')`;
const tagged = (query, discriminator) => `addtags(${promras(query)}, "series_kind=${discriminator}")`;
const merge = branches => `merge(${branches.map(([query, discriminator]) => tagged(query, discriminator)).join(', ')})`;
function resolve(expression, prelude = '', suffix = '') {
  return graph.resolveAlertGraph(`alert synthetic.graph.extensions {\n${prelude}\n  $usage_graph = ${expression}\n${suffix}\n  warn = 1\n}`, 'synthetic.graph.extensions');
}
function reject(expression, prelude = '', suffix = '') {
  const result = resolve(expression, prelude, suffix);
  assert.strictEqual(result.ok, false, 'An unproven expression must remain unavailable');
  assert.strictEqual(result.query, '', 'A rejection must not publish a partial query');
  assert.ok(result.reason, 'A rejection needs a reason code');
  return result;
}
function mergedSuccess(branches) {
  const expression = merge(branches);
  const result = resolve(expression);
  assert.strictEqual(result.ok, true, `Disjoint branches should resolve: ${result.reason}`);
  const expected = branches.map(([query, discriminator]) =>
    `label_replace((${query}), "series_kind", "${discriminator}", "", ".*")`).join(' or ');
  assert.strictEqual(result.query, expected, 'Every complete branch must remain byte-for-byte intact and independently parenthesized');
  assert.deepStrictEqual(plain(resolve(expression)), plain(result), 'Repeated resolution must be deterministic');
  const tags = { service: 'service-one', series_kind: branches[0][1] };
  const filtered = promql.transformAlertQuery(result.query, tags);
  assert.strictEqual(filtered.ok, true, filtered.reason);
  assert.strictEqual(filtered.query,
    `(\n${expected}\n) and on (service, series_kind) (label_replace(label_replace(vector(1), "service", "service-one", "", ".*"), "series_kind", "${branches[0][1]}", "", ".*"))`,
    'Tags must select the completed union, preserving its original selectors and denominators');
  assert.strictEqual(promql.transformAlertQuery(result.query, { removed_label: 'unavailable' }).ok, false,
    'A label removed by all branch aggregations cannot identify the output');
}

test('three and four discriminator branches preserve internal arithmetic and aggregation', () => {
  const branches = [
    ['sum by (service) (requests_total)', 'actual'],
    ['sum by (service) (requests_total * 1.25)', 'scaled'],
    ['sum by (service) (rate(requests_total[5m]))', 'rate']
  ];
  mergedSuccess(branches);
  mergedSuccess([...branches, ['sum by (service) (avg_over_time(requests_total[1h]))', 'history']]);
});

test('structural labels allow avg of rate divided by capacity without changing vector matching', () => {
  mergedSuccess([
    ['avg by (service) (rate(incoming_total[5m]) / on (service, interface) interface_capacity)', 'incoming'],
    ['avg by (service) (rate(outgoing_total[5m]) / on (service, interface) interface_capacity)', 'outgoing']
  ]);
});

test('nested histogram aggregations and dotted discriminator values preserve quantiles', () => {
  mergedSuccess([
    ['histogram_quantile(0.95, sum by (service, le) (rate(duration_bucket[5m])))', 'p.95'],
    ['histogram_quantile(0.99, sum by (le, service) (rate(duration_bucket[5m])))', 'p.99']
  ]);
});

test('OR fallback remains confined to its original branch', () => {
  mergedSuccess([
    ['sum by (service) (requests_total or on () vector(0))', 'actual'],
    ['sum by (service) (requests_total * 0.8)', 'threshold'],
    ['sum by (service) (avg_over_time(requests_total[1h]))', 'history']
  ]);
});

test('unsafe discriminator unions reject collisions, overwrites, unknown and mismatched labels', () => {
  const known = 'sum by (service) (requests_total)';
  for (const branches of [
    [[known, 'same'], [known, 'other'], [known, 'same']],
    [['sum by (service, series_kind) (requests_total)', 'actual'], [known, 'history']],
    [['requests_total', 'actual'], [known, 'history']],
    [['sum by (region) (requests_total)', 'actual'], [known, 'history']],
    [[known, 'actual'], ['sum by (service) (requests_total)', 'history'], ['rate(requests_total[5m])', 'unknown']]
  ]) reject(merge(branches));
  for (const discriminator of ['a"b', 'a\\b', '$value', 'a=b', 'a,b', 'a b', '']) {
    reject(merge([[known, discriminator], [known, 'history']]));
  }
});

test('nested and computed wrappers cannot turn an unproven merge into a graph', () => {
  const known = 'sum by (service) (requests_total)';
  const expression = merge([[known, 'actual'], [known, 'history'], [known, 'limit']]);
  for (const wrapped of [`(${expression})`, `dropna(${expression})`, `${expression} * 2`, `unknown(${expression})`,
    `merge(addtags(${expression}, "series_kind=outer"), ${tagged(known, 'other')})`]) reject(wrapped);
  reject('$merged', `  $merged = ${expression}`);
});

test('merge resource exhaustion rejects the whole expression without poisoning later calls', () => {
  const known = 'sum by (service) (requests_total)';
  mergedSuccess(Array.from({ length: 16 }, (_, index) => [known, `branch${index}`]));
  reject(merge(Array.from({ length: 17 }, (_, index) => [known, `branch${index}`])));
  reject(merge(Array.from({ length: 300 }, (_, index) => [known, `branch${index}`])));
  reject(merge([[`${known} #${'x'.repeat(17000)}`, 'actual'], [known, 'history']]));
  mergedSuccess([[known, 'actual'], [known, 'history'], [known, 'limit']]);
});

test('local raw string interpolation is restricted to selector matcher values', () => {
  const prelude = '  $workerKinds = ingest|deliver\n  $queueNames = urgent.one|batch.two\n  $retired = retired|disabled';
  const query = 'sum by (service) (queue_size{worker=~"$workerKinds", queue=~"$queueNames", status!~"$retired"})';
  const expected = 'sum by (service) (queue_size{worker=~"ingest|deliver", queue=~"urgent.one|batch.two", status!~"retired|disabled"})';
  const result = resolve(promras(query), prelude);
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(result.query, expected, 'Only the intended matcher string contents may change');
  assert.deepStrictEqual(plain(resolve(promras(query), prelude)), plain(result), 'Interpolation must not mutate source or leak state');
  const filtered = promql.transformAlertQuery(result.query, { service: 'selected-service' });
  assert.strictEqual(filtered.ok, true, filtered.reason);
  assert.ok(filtered.query.startsWith(`(\n${expected}\n) and on (service)`), 'Alert Tags must filter the interpolated query externally');
  assert.ok(!result.query.includes('selected-service'), 'Bosun variables must never be filled from alert-instance Tags');
  for (const operator of ['=', '!=', '=~', '!~']) {
    const one = resolve(promras(`queue_size{worker${operator}"$workerKinds"}`), prelude);
    assert.strictEqual(one.ok, true, `${operator}: ${one.reason}`);
    assert.strictEqual(one.query, `queue_size{worker${operator}"ingest|deliver"}`);
  }
});

test('prior local raw string aliases resolve with dependency order retained', () => {
  const prelude = '  $baseKinds = ingest|deliver\n  $selectedKinds = $baseKinds\n  $aliasKinds = $selectedKinds';
  const result = resolve(promras('queue_size{worker=~"$aliasKinds"}'), prelude);
  assert.strictEqual(result.ok, true, result.reason);
  assert.strictEqual(result.query, 'queue_size{worker=~"ingest|deliver"}');
  const singleQuoted = resolve(promras("queue_size{worker=~'$aliasKinds'}"), prelude);
  assert.strictEqual(singleQuoted.ok, true, singleQuoted.reason);
  assert.strictEqual(singleQuoted.query, "queue_size{worker=~'ingest|deliver'}");
});

test('interpolation rejects undefined, cyclic, forward, nonliteral and global dependencies', () => {
  const expression = promras('queue_size{worker=~"$chosen"}');
  for (const prelude of [
    '',
    '  $chosen = $missing',
    '  $chosen = $second\n  $second = $chosen',
    '  $chosen = $second\n  $second = ingest|deliver',
    '  $chosen = 2 + 3',
    `  $chosen = ${promras('unrelated_metric')}`,
    '  $chosen = "ingest|deliver"'
  ]) reject(expression, prelude);
  reject(expression, '', '  $chosen = ingest|deliver');
  const globalOnly = graph.resolveAlertGraph(`$chosen = ingest|deliver\nalert synthetic.graph.extensions {\n  $usage_graph = ${expression}\n  warn = 1\n}`, 'synthetic.graph.extensions');
  assert.strictEqual(globalOnly.ok, false, 'Global values are outside the authorized local interpolation subset');
  assert.strictEqual(globalOnly.query, '');
});

test('interpolation cannot replace query structure or arbitrary function strings', () => {
  const prelude = '  $chosen = service';
  for (const query of [
    '$chosen{service="demo"}',
    '$chosen(queue_size)',
    'sum by ($chosen) (queue_size)',
    'queue_size{$chosen="demo"}',
    '{__name__="$chosen"}',
    'queue_size{worker=$chosen}',
    'label_replace(queue_size, "worker", "$chosen", "", ".*")',
    'queue_size + $chosen',
    'queue_size[$chosen]'
  ]) reject(promras(query), prelude);
});

test('interpolation rejects escaping and injected syntax without partial publication', () => {
  const expression = promras('queue_size{worker=~"$chosen"}');
  for (const value of [
    'safe\\d+',
    'safe"} or vector(1) #',
    "safe'quote",
    'safe,owner=other',
    'safe } or vector(1)',
    '"safe\n  $injected = other"',
    'safe$value',
    '`safe`'
  ]) reject(expression, `  $chosen = ${value}`);
  reject(promras(String.raw`queue_size{worker=~"\$chosen"}`), '  $chosen = safe');
  // A newline outside quotes ends a RuleConf assignment. A subsequent unrelated
  // assignment is valid source, rather than a newline inside the chosen value.
  const unrelated = resolve(expression, '  $chosen = safe\n  $unrelated = other');
  assert.strictEqual(unrelated.ok, true, unrelated.reason);
  assert.strictEqual(unrelated.query, 'queue_size{worker=~"safe"}', 'Unrelated assignments must not become part of an interpolated value');
  const valid = resolve(promras('queue_size{worker=~"$chosen"}'), '  $chosen = safe.value|other-value');
  assert.strictEqual(valid.ok, true, 'Rejected injection attempts must not poison later valid resolution');
  assert.strictEqual(valid.query, 'queue_size{worker=~"safe.value|other-value"}');
});

test('interpolation remains bounded across aliases and output expansion', () => {
  const chain = ['  $first = safe'];
  let previous = 'first';
  for (let index = 0; index < 24; index += 1) {
    chain.push(`  $alias${index} = $${previous}`);
    previous = `alias${index}`;
  }
  reject(promras(`queue_size{worker=~"$${previous}"}`), chain.join('\n'));
  reject(promras('queue_size{worker=~"$chosen"}'), `  $chosen = ${'x'.repeat(17000)}`);
  const largeValue = 'x'.repeat(4000);
  reject(promras('queue_size{a=~"$chosen", b=~"$chosen", c=~"$chosen", d=~"$chosen", e=~"$chosen"}'), `  $chosen = ${largeValue}`);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
if (failures) process.exitCode = 1;
else console.log(`Rule graph extensions: ${tests.length} groups passed`);
