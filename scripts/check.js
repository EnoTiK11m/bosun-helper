'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');

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

console.log(`Checks passed: ${javascriptFiles.length} JavaScript files and manifest.json`);
