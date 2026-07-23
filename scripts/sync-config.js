'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'config.local.js');
const manifestPath = path.join(root, 'manifest.json');
const configPath = path.join(root, 'config.js');

assert.ok(
  fs.existsSync(sourcePath),
  'config.local.js is missing. Copy config.example.js and fill in local hosts first.'
);

const context = { globalThis: null };
context.globalThis = context;
vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, {
  filename: sourcePath
});

const config = context.BosunHelperLocalConfig;
assert.ok(config && typeof config === 'object', 'BosunHelperLocalConfig was not defined');
assert.ok(Array.isArray(config.bosunHosts) && config.bosunHosts.length > 0, 'bosunHosts is empty');

const hostPattern = /^[a-z0-9.-]+(?::\d+)?$/;
const bosunHosts = Array.from(new Set(config.bosunHosts.map((host) => {
  const normalized = String(host).trim().toLowerCase();
  assert.ok(hostPattern.test(normalized), `Invalid Bosun host: ${host}`);
  return normalized;
})));
const grafanaHost = String(config.grafanaHost || '').trim().toLowerCase();
assert.ok(hostPattern.test(grafanaHost), `Invalid Grafana host: ${config.grafanaHost}`);

const grafanaPanelUrl = new URL(String(config.grafanaPanelUrl || ''));
assert.strictEqual(grafanaPanelUrl.protocol, 'https:', 'Grafana URL must use HTTPS');
assert.strictEqual(grafanaPanelUrl.host.toLowerCase(), grafanaHost, 'Grafana URL host mismatch');

const normalizedConfig = {
  bosunHosts,
  grafanaHost,
  grafanaPanelUrl: grafanaPanelUrl.toString()
};
const matchPatterns = bosunHosts.map((host) => `https://${host}/*`);
const grafanaMatch = `https://${grafanaHost}/*`;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.ok(manifest.content_scripts?.[0], 'Bosun content script entry is missing');
assert.ok(manifest.content_scripts?.[1], 'Grafana content script entry is missing');
assert.ok(manifest.web_accessible_resources?.[0], 'Audio resource entry is missing');
assert.ok(manifest.web_accessible_resources?.[1], 'Grafana bridge resource entry is missing');

manifest.content_scripts[0].matches = matchPatterns;
manifest.content_scripts[1].matches = [grafanaMatch];
manifest.web_accessible_resources[0].matches = matchPatterns;
manifest.web_accessible_resources[1].matches = [grafanaMatch];

const configSource = `(() => {
  'use strict';

  globalThis.BosunHelperLocalConfig = ${JSON.stringify(normalizedConfig, null, 2)};
})();
`;

fs.writeFileSync(configPath, configSource, 'utf8');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('config.js and manifest.json were synchronized from config.local.js');
