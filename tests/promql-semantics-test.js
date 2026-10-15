'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/grafana/promql.js'), 'utf8'), context);
const api = context.BosunHelperPromQL;
const tests = [];
function test(name, run) { tests.push({ name, run }); }

// Sanitized counterpart of the production-shaped global count/subquery case.
const globalCountQuery = [
  'sum by (name, zone) (',
  '  sum by (account, name, zone) (session_bound)',
  '  and on (account) (',
  '    max_over_time(count by (account) (',
  '      session_bound{account!~"retired|sandbox"}',
  '    )[24h:10m]) > 1',
  '  )',
  ')'
].join('\n');
const selectedTags = { name: 'channel-alpha', zone: 'zone-one' };

// This parser only evaluates the generated constant RHS, never arbitrary PromQL.
// It independently checks that replacements make literal alert values, including $.
function readConstantVector(source) {
  let offset = 0;
  function trivia() { while (/\s/.test(source[offset] || '')) offset += 1; }
  function consume(token) {
    trivia();
    assert.strictEqual(source.slice(offset, offset + token.length), token, `Expected ${token} in filter vector`);
    offset += token.length;
  }
  function string() {
    trivia();
    assert.strictEqual(source[offset], '"', 'Generated filter arguments must be string literals');
    const start = offset++;
    let escaped = false;
    while (offset < source.length) {
      const char = source[offset++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return JSON.parse(source.slice(start, offset));
    }
    assert.fail('Unterminated filter string');
  }
  function vector() {
    trivia();
    if (source[offset] === '(') {
      consume('(');
      const labels = vector();
      consume(')');
      return labels;
    }
    if (source.slice(offset, offset + 6) === 'vector') {
      consume('vector'); consume('('); consume('1'); consume(')');
      return {};
    }
    consume('label_replace'); consume('(');
    const labels = vector();
    consume(','); const destination = string();
    consume(','); const replacement = string();
    consume(','); const sourceLabel = string();
    consume(','); const regex = string();
    consume(')');
    assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(destination));
    assert.ok(new RegExp(`^(?:${regex})$`).test(labels[sourceLabel] || ''), 'Constant label_replace must match its source');
    assert.ok(Array.from(replacement.matchAll(/\$+/g)).every(match => match[0].length % 2 === 0),
      'Alert values must not become replacement group references');
    labels[destination] = replacement.replace(/\$\$/g, '$');
    return labels;
  }
  const labels = vector();
  trivia();
  assert.strictEqual(offset, source.length, 'Unexpected query after the constant filter vector');
  return labels;
}

function outputFilter(query, original, tags) {
  const position = query.indexOf(original);
  assert.ok(position >= 0, 'Original query must remain byte-for-byte intact');
  assert.strictEqual(query.slice(0, position).trim(), '(', 'Original query must be the complete left operand');
  const tail = query.slice(position + original.length);
  // A newline before the closing parenthesis also protects a trailing # comment.
  assert.ok(/^\s*\n\s*\)/.test(tail), 'Wrapper must terminate a possible trailing comment');
  const match = tail.match(/^\s*\)\s+and\s+on\s*\(([^)]*)\)\s*([\s\S]+)$/);
  assert.ok(match, 'Filter must intersect the completed result using explicit matching labels');
  const matchingLabels = match[1].split(',').map(label => label.trim()).filter(Boolean);
  assert.deepStrictEqual([...matchingLabels].sort(), Object.keys(tags).sort());
  assert.strictEqual(new Set(matchingLabels).size, matchingLabels.length);
  const filterLabels = readConstantVector(match[2]);
  assert.deepStrictEqual(filterLabels, tags, 'Constant filter vector must represent the exact alert tags');
  return rows => rows.filter(row => matchingLabels.every(label => (row.labels[label] || '') === filterLabels[label]));
}

function success(original, tags, alertKey = '') {
  const result = api.transformAlertQuery(original, tags, alertKey);
  assert.strictEqual(result.ok, true, `${original}: ${result.reason}`);
  assert.ok(typeof result.strategy === 'string' && result.strategy.length);
  assert.strictEqual(api.applyAlertTagsToPromQuery(original, tags, alertKey), result.query, 'Legacy API must use the same safe transform');
  outputFilter(result.query, original, tags);
  return result;
}

function reject(query, tags, alertKey = '') {
  const result = api.transformAlertQuery(query, tags, alertKey);
  assert.strictEqual(result.ok, false, `Unproven query must fail closed: ${query}`);
  assert.strictEqual(result.query, '');
  assert.ok(typeof result.reason === 'string' && result.reason.length, 'Rejected transforms need a diagnostic reason');
  assert.strictEqual(api.applyAlertTagsToPromQuery(query, tags, alertKey), '');
}

test('global account count keeps all selectors intact before final filtering', () => {
  outputFilter(api.applyAlertTagsToPromQuery(globalCountQuery, selectedTags), globalCountQuery, selectedTags);
});

test('global count semantics retain the selected series that selector injection loses', () => {
  const rows = [
    { labels: { account: 'shared', name: 'channel-alpha', zone: 'zone-one' }, value: 2 },
    { labels: { account: 'shared', name: 'channel-beta', zone: 'zone-two' }, value: 3 },
    { labels: { account: 'solo', name: 'channel-gamma', zone: 'zone-three' }, value: 9 },
    { labels: { account: 'retired', name: 'channel-alpha', zone: 'zone-one' }, value: 7 }
  ];
  const frames = [rows, rows.map(row => ({ ...row, value: row.value + 1 }))];
  function evaluateHistory(selector) {
    const maximumCounts = new Map();
    for (const frame of frames) {
      const counts = new Map();
      for (const row of frame.filter(selector)) {
        if (/^(retired|sandbox)$/.test(row.labels.account)) continue;
        counts.set(row.labels.account, (counts.get(row.labels.account) || 0) + 1);
      }
      for (const [account, count] of counts) maximumCounts.set(account, Math.max(maximumCounts.get(account) || 0, count));
    }
    const totals = new Map();
    for (const row of rows.filter(selector)) {
      if ((maximumCounts.get(row.labels.account) || 0) <= 1) continue;
      const key = JSON.stringify([row.labels.name, row.labels.zone]);
      totals.set(key, (totals.get(key) || 0) + row.value);
    }
    return Array.from(totals, ([key, value]) => {
      const [name, zone] = JSON.parse(key);
      return { labels: { name, zone }, value };
    });
  }
  const result = success(globalCountQuery, selectedTags);
  const filtered = outputFilter(result.query, globalCountQuery, selectedTags)(evaluateHistory(() => true));
  assert.deepStrictEqual(filtered, [{ labels: selectedTags, value: 2 }]);
  const injected = evaluateHistory(row => Object.entries(selectedTags).every(([label, value]) => row.labels[label] === value));
  assert.deepStrictEqual(injected, [], 'Control must reproduce the original selector-injection regression');
});

test('ratio keeps a global scalar denominator and preserves sample values', () => {
  const query = 'sum by (service) (request_total) / scalar(sum(request_total))';
  const tags = { service: 'alpha' };
  const result = success(query, tags);
  const samples = [{ labels: { service: 'alpha' }, value: 30 }, { labels: { service: 'beta' }, value: 70 }];
  const total = samples.reduce((sum, sample) => sum + sample.value, 0);
  const computed = samples.map(sample => ({ labels: sample.labels, value: sample.value / total }));
  assert.deepStrictEqual(outputFilter(result.query, query, tags)(computed), [{ labels: tags, value: 0.3 }]);
  assert.notStrictEqual(30 / 30, 0.3, 'Control: injecting service into a global denominator changes the ratio');
});

test('topk ranks globally before filtering the requested alert', () => {
  const query = 'topk(2, request_total)';
  const tags = { service: 'alpha' };
  const samples = [
    { labels: { service: 'alpha' }, value: 1 },
    { labels: { service: 'beta' }, value: 9 },
    { labels: { service: 'gamma' }, value: 7 }
  ];
  const result = success(query, tags);
  const globallyRanked = [...samples].sort((a, b) => b.value - a.value).slice(0, 2);
  assert.deepStrictEqual(outputFilter(result.query, query, tags)(globallyRanked), []);
  const injectedRanking = samples.filter(sample => sample.labels.service === tags.service).slice(0, 2);
  assert.deepStrictEqual(injectedRanking, [samples[0]], 'Control: pre-filtering topk incorrectly makes an excluded series appear');
});

test('or preserves matching branch samples and removes rows without the requested label', () => {
  const query = 'sum by (host) (up) or sum by (zone) (up)';
  const tags = { host: 'node-one' };
  const originalRows = [
    { labels: { host: 'node-one' }, value: 5 },
    { labels: { host: 'node-two' }, value: 3 },
    { labels: { zone: 'zone-one' }, value: 8 }
  ];
  const result = success(query, tags);
  assert.deepStrictEqual(outputFilter(result.query, query, tags)(originalRows), [originalRows[0]]);
});

test('safe output labels survive simple, nested and existing-filter expressions', () => {
  for (const [query, tags] of [
    ['up', { host: 'node-one' }],
    ['up{host!="excluded", env=~"prod|stage", zone!~"retired"}', { host: 'node-one', env: 'prod' }],
    ['up{host="node-one",}', { host: 'node-one' }],
    ['rate(request_total{method="GET"}[5m])', { service: 'alpha' }],
    ['sum by (host) (rate(cpu_total[5m]))', { host: 'node-one' }],
    ['sum(rate(cpu_total[5m])) by (host)', { host: 'node-one' }],
    ['sum without (instance) (cpu_total)', { host: 'node-one' }],
    ['max_over_time((sum by (host) (cpu_total))[1h:5m])', { host: 'node-one' }],
    ['(left_metric / on (host) right_metric) + 1', { host: 'node-one' }],
    ['sum by (service) (errors) / on (service) sum by (service) (requests)', { service: 'alpha' }],
    ['left_metric and on (account) right_metric', { name: 'channel-alpha' }],
    ['left_metric unless on (account) right_metric', { zone: 'zone-one' }],
    ['left_metric + on (account) group_left (zone) right_metric', { name: 'channel-alpha', zone: 'zone-one' }],
    ['left_metric + on (account) group_right (zone) right_metric', { name: 'channel-alpha', zone: 'zone-one' }],
    ['left_metric / ignoring (instance) right_metric', { host: 'node-one' }],
    ['left_metric or right_metric', { host: 'node-one' }],
    ['topk(2, request_total)', { service: 'alpha' }],
    ['bottomk by (zone) (2, request_total)', { service: 'alpha' }],
    ['label_replace(up, "cluster", "prod", "job", ".*")', { cluster: 'prod' }],
    ['label_join(up, "cluster", "-", "region", "zone")', { cluster: 'west-one' }],
    ['label_join(up, "cluster", ")", "region", "zone")', { cluster: 'west)one' }],
    ['label_replace(up, "cluster", "-", "job", ".*")', { cluster: '-' }],
    ['count_values by (host) ("sample_value", temperature)', { host: 'node-one', sample_value: '7' }],
    ['histogram_quantile(0.95, sum by (le, service) (rate(bucket_total[5m])))', { service: 'alpha' }],
    ['up offset 5m', { host: 'node-one' }],
    ['up @ 1234567890', { host: 'node-one' }],
    ['# operator-like comment and on (fake)\nup # trailing comment', { host: 'node-one' }]
  ]) success(query, tags);
});

test('labels removed by aggregation or vector matching cannot be invented', () => {
  for (const [query, tags] of [
    ['sum(up)', { host: 'node-one' }],
    ['sum by (zone) (up)', { host: 'node-one' }],
    ['sum without (host) (up)', { host: 'node-one' }],
    ['sum by (host) (sum by (zone) (up))', { host: 'node-one' }],
    ['left_metric / on (account) right_metric', { host: 'node-one' }],
    ['left_metric / ignoring (host) right_metric', { host: 'node-one' }],
    ['histogram_quantile(0.95, sum by (le, service) (rate(bucket_total[5m])))', { le: '1' }],
    ['scalar(up)', { host: 'node-one' }],
    ['vector(1)', { host: 'node-one' }],
    ['up[5m]', { host: 'node-one' }]
  ]) reject(query, tags);
});

test('literal alert labels do not turn into replacement references or PromQL syntax', () => {
  for (const value of ['cost$1', '${name}', '$$', 'a"b\\c', 'line\nnext', 'literal,comma', "apostrophe's", 'юникод']) {
    const tags = { host: value };
    const result = success('up', tags);
    const samples = [{ labels: { host: value }, value: 42 }, { labels: { host: 'other' }, value: 3 }];
    assert.deepStrictEqual(outputFilter(result.query, 'up', tags)(samples), [samples[0]]);
  }
});

test('invalid input and unsupported syntax fail closed with sanitized reasons', () => {
  for (const query of ['', 'up +', 'sum by(host)(up', 'up{host="x}', 'up{host=oops}', 'mystery_function(up)', 'sum($metric)', 'up + on(host) 1', 'up and 1', '1', 'up | unexpected']) {
    reject(query, { host: 'node-one' });
  }
  for (const tags of ['host=a,host=b', 'host=a,', 'host="unterminated', { 'bad-label': 'value' }, { host: null }, { host: '' }]) {
    reject('up', tags, 'synthetic.alert{host=safe}');
  }
  reject('up', { host: 'x'.repeat(1025) });
  reject('m'.repeat(16 * 1024 + 1), { host: 'node-one' });
  reject('up +', null);
  const confidential = 'synthetic_sensitive_marker';
  const rejected = api.transformAlertQuery(`${confidential}{host="${confidential}"} +`, { host: confidential });
  assert.strictEqual(rejected.ok, false);
  assert.ok(!rejected.reason.includes(confidential), 'Diagnostics must not echo query text or alert values');
});

test('missing tags, AlertKey fallback, duplicate tags and repeated calls remain deterministic', () => {
  const unfiltered = api.transformAlertQuery('sum(up)', null);
  assert.strictEqual(unfiltered.ok, true);
  assert.strictEqual(unfiltered.query, 'sum(up)');
  success('up', { host: 'node-one' });
  const fallback = api.transformAlertQuery('up', '', 'synthetic.alert{host=node-one}');
  assert.strictEqual(fallback.ok, true);
  outputFilter(fallback.query, 'up', { host: 'node-one' });
  const duplicate = api.transformAlertQuery('up', 'host=node-one,host=node-one');
  assert.strictEqual(duplicate.ok, true);
  outputFilter(duplicate.query, 'up', { host: 'node-one' });
  const sourceTags = Object.freeze({ host: 'node-one' });
  const first = api.transformAlertQuery('up', sourceTags);
  reject('sum(up)', sourceTags);
  const second = api.transformAlertQuery('up', sourceTags);
  assert.strictEqual(first.query, second.query, 'A rejected intervening transform must not contaminate subsequent calls');
  assert.deepStrictEqual(sourceTags, { host: 'node-one' });
});

test('keyword case and group matching preserve case-sensitive label provenance', () => {
  success('SUM BY (OR) (left_metric AND ON (account) right_metric)', { OR: 'chosen' });
  reject('SUM BY (OR) (up)', { or: 'chosen' });
  reject('sum by (account) (left_metric) + on(account) group_right(host) right_metric', { host: 'chosen' });
  success('sum by (account, host) (left_metric) + on(account) group_right(host) right_metric', { host: 'chosen' });
});

test('label rewriting distinguishes deleted labels from nonempty joined separators', () => {
  reject('label_replace(up, "host", "", "", ".*")', { host: 'chosen' });
  reject('label_join(sum(up), "host", "-")', { host: 'chosen' });
  reject('count_values without (value) ("value", up)', { value: '1' });
  success('label_join(sum(up), "host", "-", "missing_one", "missing_two")', { host: '-' });
});

test('vector on matching cannot recreate a label and metric name cannot be set twice', () => {
  reject('sum by(account)(a) + on(account,host) sum by(account)(b)', { host: 'node' });
  reject('sum without(host)(a) + on(account,host) b', { host: 'node' });
  for (const matcher of ['="up"', '=~"u.*"', '!="x"']) reject(`up{__name__${matcher}}`, { host: 'node' });
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
}
if (failures) process.exitCode = 1;
else console.log(`PromQL semantics tests passed: ${tests.length} scenarios`);
