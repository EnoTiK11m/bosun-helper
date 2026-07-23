'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');
assert.strictEqual(manifest.content_scripts.length, 2, 'Expected separate Bosun and Grafana scripts');

const configContext = { globalThis: null };
configContext.globalThis = configContext;
vm.runInNewContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), configContext, {
  filename: 'config.js'
});
const config = configContext.BosunHelperLocalConfig;
assert.ok(config && typeof config === 'object', 'config.js did not define BosunHelperLocalConfig');
const expectedBosunMatches = Array.from(
  config.bosunHosts,
  (host) => `https://${host}/*`
).sort();
const actualBosunMatches = manifest.content_scripts[0].matches.slice().sort();
assert.deepStrictEqual(actualBosunMatches, expectedBosunMatches, 'Bosun config/manifest mismatch');
assert.deepStrictEqual(
  manifest.content_scripts[1].matches,
  [`https://${config.grafanaHost}/*`],
  'Grafana config/manifest mismatch'
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

assert.ok(
  manifest.content_scripts[0].js.indexOf('promql.js') <
    manifest.content_scripts[0].js.indexOf('content.js'),
  'promql.js must load before content.js'
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

const integration = spawnSync(process.execPath, ['integration-test.js'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
});
assert.strictEqual(integration.status, 0, 'Integration test failed');

console.log(`Checks passed: ${javascriptFiles.length} JavaScript files and manifest.json`);
