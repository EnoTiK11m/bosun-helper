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
const contentPath = 'src/bosun/content.js';
const contentIndex = bosunScripts.indexOf(contentPath);
assert.ok(contentIndex >= 0, `Bosun entry must include ${contentPath}`);
for (const provider of [
  'src/settings/settings.js',
  'src/settings/settings-ui.js',
  'src/grafana/promql.js',
  'src/grafana/bosun-rule-graph.js',
  'src/bosun/single-alert-age.js',
  'src/bosun/action-templates.js',
  'src/grafana/grafana-handoff.js',
  'src/bosun/new-alert-tracker.js',
  'src/bosun/priority-alerts.js',
  'src/shared/refresh-coordinator.js'
]) {
  const providerIndex = bosunScripts.indexOf(provider);
  assert.ok(providerIndex >= 0, `Bosun entry must include ${provider}`);
  assert.ok(providerIndex < contentIndex, `${provider} must load before ${contentPath}`);
}
assert.ok(
  bosunScripts.indexOf('src/settings/settings.js') <
    bosunScripts.indexOf('src/bosun/action-templates.js'),
  'settings.js must load before action-templates.js'
);
assert.ok(
  bosunScripts.indexOf('src/settings/settings.js') <
    bosunScripts.indexOf('src/settings/settings-ui.js'),
  'settings.js must load before settings-ui.js'
);
assert.ok(
  bosunScripts.indexOf('src/grafana/promql.js') <
    bosunScripts.indexOf('src/grafana/bosun-rule-graph.js'),
  'promql.js must load before bosun-rule-graph.js'
);
assert.deepStrictEqual(
  manifest.content_scripts[1].js,
  ['config.js', 'src/grafana/grafana-content.js'],
  'Grafana entry must remain isolated from Bosun modules'
);

const contentSource = fs.readFileSync(path.join(root, 'src/bosun/content.js'), 'utf8');
const grafanaSource = fs.readFileSync(path.join(root, 'src/grafana/grafana-page.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'src/shared/styles.js'), 'utf8');
assert.ok(!/postMessage\([\s\S]{0,200},\s*['"]\*['"]\)/.test(contentSource), 'Wildcard postMessage in content.js');
assert.ok(!/postMessage\([\s\S]{0,200},\s*['"]\*['"]\)/.test(grafanaSource), 'Wildcard postMessage in grafana-page.js');
assert.ok(!/a:focus,\s*[\s\S]*button:focus/.test(stylesSource), 'Global focus styles are forbidden');

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(filename));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(filename);
    }
  }
  return files;
}

const javascriptFiles = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => path.join(root, entry.name));
for (const directory of ['src', 'tests', 'scripts']) {
  javascriptFiles.push(...collectJavaScriptFiles(path.join(root, directory)));
}

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr || `Syntax check failed: ${file}`);
}

const smoke = spawnSync(process.execPath, ['tests/smoke-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(smoke.status, 0, 'Smoke test failed');

const settings = spawnSync(process.execPath, ['tests/settings-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(settings.status, 0, 'Settings test failed');

const settingsUi = spawnSync(process.execPath, ['tests/settings-ui-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(settingsUi.status, 0, 'Settings UI test failed');

const ruleGraph = spawnSync(process.execPath, ['tests/rule-graph-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(ruleGraph.status, 0, 'Rule graph test failed');

const integration = spawnSync(process.execPath, ['tests/integration-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(integration.status, 0, 'Integration test failed');

const regression = spawnSync(process.execPath, ['tests/regression-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(regression.status, 0, 'Regression test failed');

const configSync = spawnSync(process.execPath, ['tests/config-sync-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(configSync.status, 0, 'Config synchronization test failed');

console.log(`Checks passed: ${javascriptFiles.length} JavaScript files and manifest.json`);
