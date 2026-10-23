'use strict';

// Необязательная локальная проверка движка; сеть и рабочие данные не используются.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const executable = process.argv[2] || process.env.PROMTOOL;
if (!executable) throw new Error('Pass a local promtool executable or set PROMTOOL.');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/grafana/promql.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/grafana/bosun-rule-graph.js'), 'utf8'), context);
const api = context.BosunHelperPromQL;
const guard = 'sum by (name, zone) (sum by (account, name, zone) (session_bound) and on (account) (max_over_time(count by (account) (session_bound{account!~"retired|sandbox"})[24h:10m]) > 1))';
const tags = { name: 'alpha', zone: 'one' };
const filter = (query, labels) => {
  const result = api.transformAlertQuery(query, labels);
  assert.ok(result.ok, result.reason);
  return result.query;
};
const sample = (labels, value) => ({ labels, value });
const mergeSources = [
  'sum by (name, zone) (session_bound) # source calculation',
  'sum by (name, zone) (session_bound - session_bound * 0.5)',
  'sum by (name, zone) (avg_over_time(session_bound[5m]))'
];
const mergeValues = ['current', 'previous.day', 'baseline'];
const mergeResolution = context.BosunHelperRuleGraph.resolveAlertGraph(`alert synthetic.merge {
  $usage_graph = merge(${mergeSources.map((query, index) =>
    `addtags(promras('''${query}''', '5m', '2h', ''), "kind=${mergeValues[index]}")`).join(', ')})
  warn = 1
}`, 'synthetic.merge');
assert.ok(mergeResolution.ok, mergeResolution.reason);
const interpolationResolution = context.BosunHelperRuleGraph.resolveAlertGraph(`alert synthetic.interpolation {
  $channels = alpha|beta
  $zones = one|two
  $usage_graph = promras('''sum by (name, zone) (session_bound{name=~"$channels",zone=~"$zones"})''', '5m', '2h', '')
  warn = 1
}`, 'synthetic.interpolation');
assert.ok(interpolationResolution.ok, interpolationResolution.reason);
const tests = [
  { expr: guard, eval_time: '10m', exp_samples: [sample('{name="alpha",zone="one"}', 2), sample('{name="beta",zone="two"}', 3)] },
  { expr: filter(guard, tags), eval_time: '10m', exp_samples: [sample('{name="alpha",zone="one"}', 2)] },
  // Контроль воспроизводит прежний баг: ограничение внутреннего глобального count опустошает результат.
  { expr: guard.replaceAll('session_bound', 'session_bound{name="alpha",zone="one"}')
    .replace('{name="alpha",zone="one"}{account!~"retired|sandbox"}', '{name="alpha",zone="one",account!~"retired|sandbox"}'),
    eval_time: '10m', exp_samples: [] },
  { expr: filter('sum by (name) (session_bound) / scalar(sum(session_bound))', { name: 'alpha' }),
    eval_time: '10m', exp_samples: [sample('{name="alpha"}', 0.4)] },
  { expr: filter('topk(1, session_bound)', tags), eval_time: '10m', exp_samples: [] },
  { expr: filter('literal_metric', { host: 'cost$1${name}$$' }), eval_time: '10m',
    exp_samples: [sample('literal_metric{host="cost$1${name}$$"}', 42)] },
  { expr: filter('label_join(session_bound, "joined", "-", "name", "zone")', { joined: 'alpha-one' }),
    eval_time: '10m', exp_samples: [sample('session_bound{account="shared",name="alpha",zone="one",joined="alpha-one"}', 2)] },
  { expr: filter('count_values by (zone) ("value", session_bound)', { zone: 'one', value: '2' }),
    eval_time: '10m', exp_samples: [sample('{zone="one",value="2"}', 1)] },
  { expr: 'sum by(account)(session_bound) + on(account,name) sum by(account)(session_bound)',
    eval_time: '10m', exp_samples: [sample('{account="shared"}', 10)] },
  { expr: mergeResolution.query, eval_time: '10m', exp_samples: mergeValues.flatMap((kind, index) => [
    sample(`{name="alpha",zone="one",kind="${kind}"}`, index === 1 ? 1 : 2),
    sample(`{name="beta",zone="two",kind="${kind}"}`, index === 1 ? 1.5 : 3)
  ]) },
  { expr: filter(mergeResolution.query, { ...tags, kind: 'previous.day' }), eval_time: '10m',
    exp_samples: [sample('{name="alpha",zone="one",kind="previous.day"}', 1)] },
  // Контроль: те же операнды без различающей метки теряют последующие ветви.
  { expr: mergeSources.map(query => `(\n${query}\n)`).join(' or '), eval_time: '10m',
    exp_samples: [sample('{name="alpha",zone="one"}', 2), sample('{name="beta",zone="two"}', 3)] },
  { expr: interpolationResolution.query, eval_time: '10m',
    exp_samples: [sample('{name="alpha",zone="one"}', 2), sample('{name="beta",zone="two"}', 3)] },
  { expr: filter(interpolationResolution.query, tags), eval_time: '10m',
    exp_samples: [sample('{name="alpha",zone="one"}', 2)] },
  // Фильтрация конечных значений убирает NaN и бесконечности, но не воспроизводит
  // ошибку Bosun при опустошении всей входной серии. Поддержку dropna не включаем.
  { expr: '(finite_metric < +Inf) > -Inf', eval_time: '10m',
    exp_samples: [sample('finite_metric{kind="finite"}', 2)] },
  { expr: '(finite_metric{kind="nan"} < +Inf) > -Inf', eval_time: '10m', exp_samples: [] },
  // Это подтверждает поддержку только этим локальным движком, а не настроенным backend.
  { expr: '{__name__="synthetic.metric",host="one"}', eval_time: '10m',
    exp_samples: [sample('{__name__="synthetic.metric",host="one"}', 7)] }
];
const spec = { evaluation_interval: '1m', tests: [{ interval: '1m', input_series: [
  { series: 'session_bound{account="shared",name="alpha",zone="one"}', values: '2+0x10' },
  { series: 'session_bound{account="shared",name="beta",zone="two"}', values: '3+0x10' },
  { series: 'literal_metric{host="cost$1${name}$$"}', values: '42+0x10' },
  { series: 'finite_metric{kind="finite"}', values: '2+0x10' },
  { series: 'finite_metric{kind="nan"}', values: Array(11).fill('NaN').join(' ') },
  { series: 'finite_metric{kind="positive"}', values: Array(11).fill('+Inf').join(' ') },
  { series: 'finite_metric{kind="negative"}', values: Array(11).fill('-Inf').join(' ') },
  { series: '{__name__="synthetic.metric",host="one"}', values: '7+0x10' }
], promql_expr_test: tests }] };
const { fixtures: legacyFixtures, expression: legacyExpression } = require('./legacy-prom-test');
const legacyInputs = [];
const legacyTests = [];
const series = (metric, labels) => '{' + Object.entries({ __name__: metric, ...labels })
  .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',') + '}';
const outputLabels = labels => '{' + Object.entries(labels)
  .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(',') + '}';
function legacyQuery(fixture) {
  const resolved = context.BosunHelperRuleGraph.resolveAlertGraph(`alert synthetic.engine.legacy {
    $${fixture.source || 'usage_graph'} = ${legacyExpression(fixture)}
    warn = 1
  }`, 'synthetic.engine.legacy');
  assert.ok(resolved.ok, resolved.reason);
  return resolved.query;
}
for (const fixture of legacyFixtures) {
  const group = fixture.group.split(',').filter(Boolean);
  const labels = Object.fromEntries(group.map(name => [name, 'selected']));
  for (const match of fixture.filter.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(=~|=)\s*"([^"]*)"/g)) {
    labels[match[1]] = match[2] === '=' ? match[3] : match[3] === '.+Errors' ? 'WriteErrors' : 'wildcard';
  }
  const selected = Object.fromEntries(group.map(name => [name, labels[name]]));
  const query = legacyQuery(fixture);
  const resetCounter = Array.from({ length: 41 }, (_unused, index) => index <= 20 ? index * 15 : (index - 20) * 15).join(' ');
  legacyInputs.push({ series: series(fixture.metric, { ...labels, instance: 'one' }),
    values: fixture.rate ? resetCounter : '5+0x40' });
  legacyInputs.push({ series: series(fixture.metric, { ...labels, instance: 'two' }),
    values: fixture.rate ? '0+30x40' : '7+0x40' });
  // Метрика с подчёркиванием и другим значением делает случайное переименование заметным.
  if (!legacyInputs.some(input => input.series === series(fixture.metric.replace(/\./g, '_'), labels))) {
    legacyInputs.push({ series: series(fixture.metric.replace(/\./g, '_'), labels), values: '999+0x40' });
  }
  const expected = [sample(outputLabels(selected), fixture.rate ? 3 : 12)];
  legacyTests.push({ expr: query, eval_time: '10m', exp_samples: expected });
  if (group.length) legacyTests.push({ expr: filter(query, selected), eval_time: '10m', exp_samples: expected });
  if (fixture.rate) legacyTests.push({ expr: query, eval_time: '5m30s', exp_samples: expected });
}
const changing = Array.from({ length: 41 }, (_unused, index) => index <= 36 ? index * 15 : 540 + (index - 36) * 30).join(' ');
legacyInputs.push({ series: series('demo.window.counter', { service: 'selected' }), values: changing });
const windowQuery = legacyQuery({ metric: 'demo.window.counter', group: 'service', filter: '', rate: '2m', step: '15s', start: '2h', end: '1h' });
legacyTests.push({ expr: windowQuery, eval_time: '10m', exp_samples: [sample('{service="selected"}', 11 / 7)] });
legacyTests.push({ expr: filter(windowQuery, { service: 'selected' }), eval_time: '10m', exp_samples: [sample('{service="selected"}', 11 / 7)] });
legacyTests.push({ expr: 'sum(rate({__name__="demo.window.counter"}[1m])) by(service)', eval_time: '10m',
  exp_samples: [sample('{service="selected"}', 2)] });
for (const [labels, value] of [
  [{ env: 'demo', zone: 'fresh', kind: 'ReadErrors', team: 'ops' }, 5],
  [{ env: 'demo', zone: 'fresh', kind: 'WriteErrors', team: 'ops' }, 7],
  [{ env: 'retired', zone: 'fresh', kind: 'WriteErrors', team: 'ops' }, 100],
  [{ env: 'demo', zone: 'old-zone', kind: 'WriteErrors', team: 'ops' }, 100],
  [{ env: 'demo', zone: 'fresh', kind: 'received', team: 'ops' }, 100],
  [{ env: 'demo', zone: 'fresh', kind: 'WriteErrors', team: 'other' }, 100]
]) legacyInputs.push({ series: series('demo.filter.value', { service: 'selected', ...labels }), values: `${value}+0x40` });
for (const [aggregation, expected] of [['sum', 12], ['avg', 6], ['min', 5], ['max', 7], ['count', 2], ['group', 1], ['stddev', 1], ['stdvar', 1]]) {
  const query = legacyQuery({ metric: 'demo.filter.value', group: 'service', aggregation,
    filter: 'env!="retired",zone!~"old.*|gone",kind=~".+Errors",team="ops"', step: '30s', start: '1h' });
  legacyTests.push({ expr: query, eval_time: '10m', exp_samples: [sample('{service="selected"}', expected)] });
}
// Экстраполяция rate может отличаться на один бит мантиссы от того же
// рационального значения, вычисленного в JS. Только новые тесты старых вызовов используют допуск promtool в один бит;
// исходные 17 выражений сохраняют строгое сравнение.
const legacySpec = { evaluation_interval: '15s', fuzzy_compare: true,
  tests: [{ interval: '15s', input_series: legacyInputs, promql_expr_test: legacyTests }] };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-promql-engine-'));
const filename = path.join(directory, 'synthetic-rules.json');
const legacyFilename = path.join(directory, 'synthetic-legacy-rules.json');
try {
  fs.writeFileSync(filename, JSON.stringify(spec)); // JSON является допустимым YAML.
  fs.writeFileSync(legacyFilename, JSON.stringify(legacySpec));
  for (const file of [filename, legacyFilename]) {
    const result = spawnSync(executable, ['test', 'rules', file], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  }
  console.log(`Prometheus engine tests passed (${tests.length + legacyTests.length} expressions).`);
} finally {
  for (const file of [filename, legacyFilename]) if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(directory);
}
