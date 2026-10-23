'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// Двенадцать обезличенных структур: девять prom и три promrate. Имена метрик,
// значения условий отбора и идентичности алертов намеренно отличаются от локального источника.
const fixtures = [
  { name: 'synthetic.legacy.01', metric: 'demo.backup.state', group: 'service', filter: '', step: '1m', start: '8d' },
  { name: 'synthetic.legacy.02', metric: 'demo.worker.state', group: 'job', filter: '', step: '5m', start: '4h' },
  { name: 'synthetic.legacy.03', metric: 'demo.worker.age', group: '', filter: '', step: '30s', start: '2d', source: 'q' },
  { name: 'synthetic.legacy.04', metric: 'demo.worker.error.total', group: 'service', filter: 'env="demo",region="east",class=~".*",status="failed",component=~".*",queue=~".*"', step: '1m', start: '1h' },
  { name: 'synthetic.legacy.05', metric: 'demo.worker.active.processing.total', group: '', filter: 'env="demo",region="east",kind="active"', step: '1m', start: '24h' },
  { name: 'synthetic.legacy.06', metric: 'demo.worker.ok.total', group: 'service,status', filter: 'env="demo",region="east",class="worker",status="ok",component=~".*",queue=~".*"', step: '1m', start: '48h' },
  { name: 'synthetic.legacy.07', metric: 'demo.worker.processing.duration.total', group: '', filter: 'env="demo",region="east",kind="duration"', step: '1m', start: '24h' },
  { name: 'synthetic.legacy.08', metric: 'demo.worker.status.total', group: '', filter: 'env="demo",region="east",kind="status",status="pending"', step: '1m', start: '1h' },
  { name: 'synthetic.legacy.09', metric: 'demo.network.state', group: 'service,region,owner,interface', filter: '', step: '1m', start: '2h' },
  { name: 'synthetic.legacy.10', metric: 'demo.loader.record.total', group: 'src', filter: 'env="demo"', rate: '1m', step: '1m', start: '4d' },
  { name: 'synthetic.legacy.11', metric: 'demo.audit.total', group: 'hostname,type', filter: 'type=~".+Errors"', rate: '1m', step: '1m', start: '1h' },
  { name: 'synthetic.legacy.12', metric: 'demo.audit.total', group: 'hostname,type,dbname', filter: 'type="received"', rate: '1m', step: '1m', start: '1h' }
];

function expression(fixture) {
  const { metric, group, filter, aggregation = 'sum', rate, step, start, end = '' } = fixture;
  return `${rate === undefined ? 'prom' : 'promrate'}("${metric}", "${group}", '''${filter}''', "${aggregation}", ` +
    (rate === undefined ? '' : `"${rate}", `) + `"${step}", "${start}", "${end}")`;
}

function load() {
  const context = vm.createContext({});
  for (const file of ['promql.js', 'bosun-rule-graph.js']) {
    vm.runInContext(fs.readFileSync(`src/grafana/${file}`, 'utf8'), context);
  }
  return { graph: context.BosunHelperRuleGraph, promql: context.BosunHelperPromQL };
}

function run() {
  const { graph, promql } = load();
  const resolve = (call, source = 'usage_graph', prelude = '') => graph.resolveAlertGraph(
    `alert synthetic.legacy.test {\n${prelude}\n  $${source} = ${call}\n  warn = 1\n}`, 'synthetic.legacy.test');
  for (const fixture of fixtures) {
    const result = resolve(expression(fixture), fixture.source);
    assert.strictEqual(result.ok, true, `${fixture.name}: ${result.reason}`);
    const selector = `{__name__="${fixture.metric}"${fixture.filter ? ', ' + fixture.filter.replace(/,/g, ', ') : ''}}`;
    const body = fixture.rate ? `rate(${selector}[${fixture.rate}])` : selector;
    assert.strictEqual(result.query, `sum(${body}) by (${fixture.group.split(',').filter(Boolean).join(', ')})`);
    assert.strictEqual(result.reason, fixture.rate ? 'direct_promrate' : 'direct_prom');
    assert.strictEqual(result.source, fixture.source || 'usage_graph');
    assert.strictEqual(promql.applyAlertTagsToPromQuery(result.query, ''), result.query);
    const tags = Object.fromEntries(fixture.group.split(',').filter(Boolean).map(label => [label, 'selected']));
    const filtered = promql.transformAlertQuery(result.query, tags);
    assert.strictEqual(filtered.ok, true, fixture.name);
    if (fixture.group) assert.ok(filtered.query.startsWith(`(\n${result.query}\n) and on (`));
    else assert.strictEqual(promql.applyAlertTagsToPromQuery(result.query, { host: 'invented' }), '');
  }
  const base = fixtures[1];
  for (const aggregation of ['sum', 'avg', 'min', 'max', 'count', 'group', 'stddev', 'stdvar']) {
    const result = resolve(expression({ ...base, aggregation, filter: 'env!="retired",zone!~"old.*|gone",kind=~".+Errors"' }));
    assert.strictEqual(result.ok, true, `${aggregation}: ${result.reason}`);
    assert.ok(result.query.includes('env!="retired", zone!~"old.*|gone", kind=~".+Errors"'));
  }
  for (const step of ['30s', '250ms', '1.5m', '01m', '+1m', '1h30m', '1n']) {
    assert.strictEqual(resolve(expression({ ...base, step, start: '2n' })).ok, true, `Bosun duration ${step}`);
  }
  assert.strictEqual(resolve(expression({ ...base, start: '2h', end: '30m' })).ok, true);
  const rateCall = { ...fixtures[10], rate: '5m', step: '15s', start: '2d', end: '1h' };
  const rateResult = resolve(expression(rateCall));
  assert.strictEqual(rateResult.ok, true, rateResult.reason);
  assert.ok(rateResult.query.includes('[5m]'));
  assert.ok(!rateResult.query.includes('15s') && !rateResult.query.includes('2d') && !rateResult.query.includes('1h'));
  for (const rate of ['30s', '250ms', '2h30m', '1y']) {
    assert.strictEqual(resolve(expression({ ...rateCall, rate })).ok, true, rate);
  }

  const negatives = [
    ...['median', 'topk', 'sum) or vector(1)'].map(aggregation => ({ ...base, aggregation })),
    ...['', '1metric', 'metric} or vector(1)', 'demo.metric\n'].map(metric => ({ ...base, metric })),
    ...['service,service', 'bad-label', '__name__', 'service,,zone'].map(group => ({ ...base, group })),
    ...['__name__="different"', '__name__!="different"', '__name__=~".*"', '__name__!~".*"', 'env=oops', 'env="x",env="y"', 'env="x",', '{env="x"}', 'env=~"["', 'env=~"[ab]"'].map(filter => ({ ...base, filter })),
    ...['', '0s', '-1m', '1us', '1.0000000001s', '999999999999999999999h', '9223372036.854775807s'].map(step => ({ ...base, step })),
    { ...base, start: '' }, { ...base, start: '1m', end: '2m' }, { ...base, end: '-1m' },
    ...['', '0s', '-1m', '1.5m', '1n', '1m1h', '1m1m', '999999999999999999999h'].map(rate => ({ ...rateCall, rate }))
  ];
  for (const fixture of negatives) {
    const result = resolve(expression(fixture));
    assert.strictEqual(result.ok, false, `Must reject ${expression(fixture)}`);
    assert.strictEqual(result.query, '');
    assert.ok(/^legacy_prom(?:rate)?(?:_[a-z]+)?$/.test(result.reason) || result.reason === 'invalid_rule_source', result.reason);
  }
  for (const call of [
    'prom("demo.metric", "1m", "")', 'promrate("demo.metric", "1m", "")',
    'prom(1, "service", "", "sum", "1m", "1h", "")',
    'prom($metric, "service", "", "sum", "1m", "1h", "")',
    `(${expression(base)})`, `${expression(base)} * 2`, `dropna(${expression(base)})`,
    `["other"]${expression(base)}`, `merge(${expression(base)}, ${expression(base)})`, '$legacy'
  ]) assert.strictEqual(resolve(call, 'usage_graph', `  $metric = "demo.metric"\n  $legacy = ${expression(base)}`).ok, false, call);

  for (const query of ['{job="api"}', '{__name__=~"demo.*"}', '{__name__=""}', '{__name__="a",__name__="b"}', 'up{__name__="up"}']) {
    assert.strictEqual(promql.applyAlertTagsToPromQuery(query, ''), '', query);
  }
  const exact = 'rate({__name__="demo.counter.total",env!="retired"}[5m])';
  assert.strictEqual(promql.applyAlertTagsToPromQuery(exact, ''), exact);
  assert.strictEqual(promql.transformAlertQuery(`sum by (job) (${exact})`, { env: 'demo' }).ok, false);
  console.log('Legacy prom/promrate tests passed (12 anonymized rule structures, durations, filters and rejection matrix).');
}

module.exports = { fixtures, expression };
if (require.main === module) run();
