'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfigFile } = require('./config-sync');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');
assert.strictEqual(manifest.content_scripts.length, 2, 'Expected separate Bosun and Grafana scripts');

const config = loadConfigFile(path.join(root, 'config.js'));
const expectedBosunMatches = Array.from(new Set(
  Array.from(config.bosunHosts, (host) => `https://${new URL(`https://${host}`).hostname}/*`)
)).sort();
const actualBosunMatches = manifest.content_scripts[0].matches.slice().sort();
const expectedGrafanaMatches = [`https://${new URL(`https://${config.grafanaHost}`).hostname}/*`];
const sameStrings = (actual, expected) => Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);
assert.ok(sameStrings(actualBosunMatches, expectedBosunMatches), 'Bosun config/manifest mismatch');
assert.ok(
  sameStrings(manifest.content_scripts[1].matches, expectedGrafanaMatches),
  'Grafana config/manifest mismatch'
);
assert.ok(
  sameStrings(manifest.web_accessible_resources[0].matches.slice().sort(), expectedBosunMatches),
  'Bosun config/resource manifest mismatch'
);
assert.ok(
  sameStrings(manifest.web_accessible_resources[1].matches, expectedGrafanaMatches),
  'Grafana config/resource manifest mismatch'
);

const referencedFiles = new Set();
for (const entry of manifest.content_scripts) {
  for (const file of entry.js || []) referencedFiles.add(file);
}
for (const entry of manifest.web_accessible_resources || []) {
  for (const file of entry.resources || []) referencedFiles.add(file);
}
for (const file of referencedFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `Manifest references missing file: ${file}`);
}

const bosunScripts = manifest.content_scripts[0].js;
const contentIndex = bosunScripts.indexOf('content.js');
assert.ok(contentIndex >= 0, 'Bosun entry must include content.js');
for (const provider of [
  'settings.js',
  'promql.js',
  'bosun-rule-graph.js',
  'single-alert-age.js',
  'action-templates.js',
  'grafana-handoff.js',
  'new-alert-tracker.js',
  'refresh-coordinator.js'
]) {
  const providerIndex = bosunScripts.indexOf(provider);
  assert.ok(providerIndex >= 0, `Bosun entry must include ${provider}`);
  assert.ok(providerIndex < contentIndex, `${provider} must load before content.js`);
}
assert.ok(
  bosunScripts.indexOf('settings.js') < bosunScripts.indexOf('action-templates.js'),
  'settings.js must load before action-templates.js'
);
assert.ok(
  bosunScripts.indexOf('promql.js') < bosunScripts.indexOf('bosun-rule-graph.js'),
  'promql.js must load before bosun-rule-graph.js'
);
assert.deepStrictEqual(
  manifest.content_scripts[1].js,
  ['config.js', 'grafana-content.js'],
  'Grafana entry must remain isolated from Bosun modules'
);

const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const grafanaSource = fs.readFileSync(path.join(root, 'grafana-page.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'styles.js'), 'utf8');
assert.ok(!/postMessage\([\s\S]{0,200},\s*['"]\*['"]\)/.test(contentSource), 'Wildcard postMessage in content.js');
assert.ok(!/postMessage\([\s\S]{0,200},\s*['"]\*['"]\)/.test(grafanaSource), 'Wildcard postMessage in grafana-page.js');
assert.ok(!/a:focus,\s*[\s\S]*button:focus/.test(stylesSource), 'Global focus styles are forbidden');

const javascriptFiles = fs.readdirSync(root)
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(root, name));

for (const directory of ['scripts']) {
  const fullDirectory = path.join(root, directory);
  for (const name of fs.readdirSync(fullDirectory)) {
    if (name.endsWith('.js')) javascriptFiles.push(path.join(fullDirectory, name));
  }
}

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr || `Syntax check failed: ${file}`);
}

const smoke = spawnSync(process.execPath, ['smoke-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(smoke.status, 0, 'Smoke test failed');

const settings = spawnSync(process.execPath, ['settings-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(settings.status, 0, 'Settings test failed');

const ruleGraph = spawnSync(process.execPath, ['rule-graph-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(ruleGraph.status, 0, 'Rule graph test failed');

const integration = spawnSync(process.execPath, ['integration-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(integration.status, 0, 'Integration test failed');

const regression = spawnSync(process.execPath, ['regression-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(regression.status, 0, 'Regression test failed');

const configSync = spawnSync(process.execPath, ['config-sync-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(configSync.status, 0, 'Config synchronization test failed');

console.log(`Checks passed: ${javascriptFiles.length} JavaScript files and manifest.json`);
