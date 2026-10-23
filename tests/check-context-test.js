'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fingerprint, runChecks, status, receiptPath } = require('../scripts/project-tools');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-check-context-test-'));
const keys = ['npm_execpath', 'BOSUN_HELPER_BROWSER_CASE', 'BOSUN_HELPER_REGRESSION_CASE',
  'BOSUN_FAKE_BROWSER_RECORD', 'BOSUN_FAKE_REPORT_MODE'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const put = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function output(options) {
  const lines = [], log = console.log;
  console.log = line => lines.push(line);
  try { status(root, options); } finally { console.log = log; }
  return lines.join('\n');
}
try {
  delete process.env.BOSUN_HELPER_BROWSER_CASE;
  delete process.env.BOSUN_HELPER_REGRESSION_CASE;
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  put('manifest.json', '{"version":"2.0.5"}'); put('package.json', '{"version":"2.0.5"}');
  put('docs/ROADMAP.md', '## Новое\n## В работе\n## Выполненные\n');
  const full = fingerprint(root, 'test');
  process.env.BOSUN_HELPER_REGRESSION_CASE = 'A19';
  assert.notEqual(fingerprint(root, 'test'), full, 'Focused regression cannot have the full-suite fingerprint');
  delete process.env.BOSUN_HELPER_REGRESSION_CASE;

  const { selection, checkContext, validateBrowserReport } = require('../scripts/check-context');
  const record = path.join(root, 'browser-record.json');
  const identity = { executable: process.execPath, version: '100.0.0.1', signature: 'a'.repeat(64) };
  const setBrowser = value => fs.writeFileSync(record, JSON.stringify(value));
  setBrowser(identity);
  const options = { browserIdentity: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
  const run = command => {
    const log = console.log, error = console.error;
    console.log = console.error = () => {};
    try { return runChecks(root, command, options); } finally { console.log = log; console.error = error; }
  };
  process.env.BOSUN_FAKE_BROWSER_RECORD = record;
  put('fake-npm.js', `const fs=require('node:fs');
    if(process.env.BOSUN_HELPER_CHECK_REPORT && process.env.BOSUN_FAKE_REPORT_MODE!=='missing'){
      const browser=JSON.parse(fs.readFileSync(process.env.BOSUN_FAKE_BROWSER_RECORD,'utf8'));
      const selected=process.env.BOSUN_HELPER_BROWSER_CASE||'';
      const report={complete:true,scope:selected?'partial':'full',selectors:{browserCase:selected,flags:[]},
        browser:{...browser,product:'Chrome/'+(process.env.BOSUN_FAKE_REPORT_MODE==='mismatch'?'999.0.0.1':browser.version)}};
      fs.writeFileSync(process.env.BOSUN_HELPER_CHECK_REPORT,JSON.stringify(report));
      if(process.env.BOSUN_FAKE_REPORT_MODE==='change')fs.writeFileSync(process.env.BOSUN_FAKE_BROWSER_RECORD,JSON.stringify({...browser,version:'101.0.0.1'}));
    }
  `);
  process.env.npm_execpath = path.join(root, 'fake-npm.js');
  const receipt = () => JSON.parse(fs.readFileSync(receiptPath(root), 'utf8'));
  assert.equal(run('test'), 0);
  assert.equal(receipt().version, 2);
  assert.equal(receipt().checks.find(c => c.command === 'test').context.scope, 'full');
  assert.match(output(options), /test: PASS/);
  process.env.BOSUN_HELPER_REGRESSION_CASE = 'A19';
  assert.match(output(options), /test: PASS.*устарело/);
  assert.equal(run('test'), 0);
  assert.match(output(options), /test: PARTIAL PASS/);
  assert.doesNotMatch(output(options), /test: PASS/);
  assert.equal(run('check'), 0);
  assert.match(output(options), /check: PARTIAL PASS/);
  for (const name of ['A19', 'A18', 'A05', 'A13']) {
    assert.equal(selection('test', { BOSUN_HELPER_REGRESSION_CASE: name }).scope, 'partial');
  }
  const focused = fingerprint(root, 'test');
  process.env.BOSUN_HELPER_REGRESSION_CASE = 'A18';
  assert.notEqual(fingerprint(root, 'test'), focused);
  assert.match(output(options), /test: PARTIAL PASS.*устарело/);
  delete process.env.BOSUN_HELPER_REGRESSION_CASE;
  assert.match(output(options), /test: PARTIAL PASS.*устарело/);
  assert.equal(run('test'), 0);
  assert.match(output(options), /test: PASS/);

  const browserFull = fingerprint(root, 'test:browser', checkContext('test:browser', options));
  let previousBrowserFingerprint = browserFull;
  for (const name of ['A04', 'A12', 'A06']) {
    process.env.BOSUN_HELPER_BROWSER_CASE = name;
    const current = fingerprint(root, 'test:browser', checkContext('test:browser', options));
    assert.notEqual(current, browserFull);
    assert.notEqual(current, previousBrowserFingerprint);
    previousBrowserFingerprint = current;
    assert.equal(run('test:browser'), 0);
    assert.match(output(options), /test:browser: PARTIAL PASS/);
    assert.equal(receipt().checks.find(c => c.command === 'test:browser').context.selectors.browserCase, name);
  }
  delete process.env.BOSUN_HELPER_BROWSER_CASE;
  assert.match(output(options), /test:browser: PARTIAL PASS.*устарело/);
  assert.equal(run('test:browser'), 0);
  assert.match(output(options), /test:browser: PASS/);
  const browserReceipt = receipt().checks.find(c => c.command === 'test:browser');
  assert.equal(browserReceipt.context.browser.product, 'Chrome/100.0.0.1');
  setBrowser({ ...identity, version: '101.0.0.1' });
  assert.match(output(options), /test:browser: PASS.*устарело/);
  assert.notEqual(fingerprint(root, 'test:browser', checkContext('test:browser', options)), browserFull);
  setBrowser(identity);
  for (const mode of ['missing', 'mismatch', 'change']) {
    process.env.BOSUN_FAKE_REPORT_MODE = mode;
    assert.equal(run('test:browser'), 1, 'Missing/mismatched/changed browser metadata must fail verification');
    assert.doesNotMatch(output(options), /test:browser: PASS(?!.*устарело)/);
    setBrowser(identity);
  }
  delete process.env.BOSUN_FAKE_REPORT_MODE;
  assert.equal(run('test:browser'), 0);
  const valid = receipt();
  const corrupt = structuredClone(valid);
  corrupt.checks.find(c => c.command === 'test:browser').context.scope = 'partial';
  fs.writeFileSync(receiptPath(root), JSON.stringify(corrupt));
  assert.doesNotMatch(output(options), /test:browser: PASS/);
  fs.writeFileSync(receiptPath(root), JSON.stringify({ version: 1, checks: valid.checks }));
  assert.doesNotMatch(output(options), /test:browser: PASS/);
  fs.writeFileSync(receiptPath(root), JSON.stringify(valid));
  assert.doesNotMatch(output({ browserIdentity() { throw new Error('Synthetic missing browser'); } }), /test:browser: PASS/);

  for (const key of ['BOSUN_HELPER_BROWSER_CASE', 'BOSUN_HELPER_REGRESSION_CASE']) {
    process.env[key] = 'UNKNOWN';
    assert.throws(() => run('test'), /Неизвестный/);
    const file = key.includes('REGRESSION') ? 'regression-test.js' : 'browser-test.js';
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env: process.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Неизвестный/);
    delete process.env[key];
  }
  assert.throws(() => selection('test:browser', {}, ['--unknown-case']), /Неизвестный/);
  assert.throws(() => selection('test:browser', {}, ['--acknowledged-compact-regression', '--single-alert-age-source-regression']), /один/);
  assert.throws(() => selection('test:browser', { BOSUN_HELPER_BROWSER_CASE: 'A04' }, ['--acknowledged-compact-regression']), /один/);
  assert.equal(selection('test:browser', {}, ['--acknowledged-compact-regression']).scope, 'partial');
  const unknownFlag = spawnSync(process.execPath, [path.join(__dirname, 'browser-test.js'), '--unknown-case'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(unknownFlag.status, 1); assert.match(unknownFlag.stderr, /Неизвестный/);
  const unknownRegressionFlag = spawnSync(process.execPath, [path.join(__dirname, 'regression-test.js'), '--unknown-case'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(unknownRegressionFlag.status, 1); assert.match(unknownRegressionFlag.stderr, /Неизвестный/);
  assert.throws(() => validateBrowserReport(checkContext('test:browser', options), { complete: true }), /браузера/);
  console.log('Check context tests passed (full/partial, selectors, actual browser metadata, stale and legacy receipts).');
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('bosun-check-context-test-'));
  fs.rmSync(root, { recursive: true, force: true });
}
