'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { ConfigSyncError, loadConfigFile, buildConfigSource, verifyGeneratedContents } = require('./config-sync');

class PackageError extends Error {}

function ensure(condition, message) {
  if (!condition) throw new PackageError(message);
}

function readRuntimeFile(root, file) {
  ensure(file === 'manifest.json' || file === 'config.js' || file === 'LICENSE' ||
    /^(?:src\/[a-z0-9/-]+\.js|assets\/sounds\/[a-z0-9_-]+\.wav)$/.test(file),
  'Unsupported runtime resource path.');
  const segments = file.split('/');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    ensure(!fs.lstatSync(current).isSymbolicLink(), 'Symlink runtime resources are not supported.');
  }
  const stat = fs.statSync(current);
  ensure(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'Missing or oversized runtime resource.');
  return fs.readFileSync(current);
}

function validateInternalConfig(config) {
  for (const host of [...config.bosunHosts, config.grafanaHost]) {
    const hostname = new URL(`https://${host}`).hostname;
    ensure(!/(^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/.test(hostname) &&
      !/^127\./.test(hostname),
      'Internal packaging requires configured service hosts, not placeholders.');
  }
  const url = new URL(config.grafanaPanelUrl);
  ensure(!url.hash && /^\/d\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname),
    'Internal packaging requires a Grafana dashboard edit URL without a fragment.');
  const validators = {
    orgId: value => /^[1-9]\d*$/.test(value),
    editPanel: value => /^[1-9]\d*$/.test(value),
    from: value => /^(?:\d{1,16}|now(?:-\d+[smhdwMy])?(?:\/[smhdwMy])?)$/.test(value),
    to: value => /^(?:\d{1,16}|now(?:-\d+[smhdwMy])?(?:\/[smhdwMy])?)$/.test(value),
    timezone: value => /^(?:browser|utc|[A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2})$/.test(value),
    refresh: value => /^(?:auto|off|\d+[smhd])$/.test(value)
  };
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    ensure(!seen.has(key) && validators[key]?.(value), 'Unsupported or credential-like Grafana URL parameter.');
    seen.add(key);
  }
  ensure(seen.has('editPanel'), 'Grafana URL must select an edit panel.');
}

function scanSecrets(source) {
  ensure(!/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/.test(source),
    'Credential signature found in a runtime file.');
  ensure(!/\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|authorization)["']?\s*[=:]\s*["'][^"'\r\n]{4,}["']/i.test(source),
    'Hardcoded credential assignment found in a runtime file.');
  for (const match of source.matchAll(/https?:\/\/[^\s'"`<>]+/g)) {
    if (match[0].includes('${')) continue;
    let url;
    try { url = new URL(match[0]); } catch (_) { continue; }
    ensure(!url.username && !url.password, 'URL credentials found in a runtime file.');
    ensure(![...url.searchParams.keys()].some(key => /token|password|secret|api.?key|credential|authorization/i.test(key)),
      'Credential URL parameter found in a runtime file.');
  }
}

function collectRuntime(root) {
  const manifestSource = readRuntimeFile(root, 'manifest.json');
  const manifest = JSON.parse(manifestSource.toString('utf8'));
  ensure(manifest.manifest_version === 3 && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifest.version),
    'Invalid Manifest V3 version.');
  ensure(manifest.version.split('.').every(part => Number(part) <= 65535) &&
    manifest.version.split('.').some(part => Number(part) > 0), 'Invalid Manifest V3 version components.');
  ensure(Object.keys(manifest).every(key => ['manifest_version', 'name', 'version', 'description',
    'permissions', 'content_scripts', 'web_accessible_resources'].includes(key)),
  'Unsupported manifest field; review packaging dependencies first.');
  ensure(JSON.stringify(manifest.permissions) === '["storage"]', 'Unexpected manifest permissions.');
  ensure(manifest.content_scripts?.length === 4 && manifest.web_accessible_resources?.length === 2,
    'Unexpected runtime manifest layout.');
  const config = loadConfigFile(path.join(root, 'config.js'));
  validateInternalConfig(config);
  if (fs.existsSync(path.join(root, 'config.local.js'))) {
    ensure(JSON.stringify(config) === JSON.stringify(loadConfigFile(path.join(root, 'config.local.js'))),
      'Runtime config differs from config.local.js; synchronize it before packaging.');
  }
  // Rebuild only the declarative runtime assignment: comments/local extra data are never copied.
  const configSource = buildConfigSource(config);
  verifyGeneratedContents(configSource, manifestSource.toString('utf8'), config);
  for (const [file, world] of [['src/bosun/group-identity-page.js', 'MAIN'], ['src/bosun/group-identity.js', 'ISOLATED']]) {
    const entries = manifest.content_scripts.filter(entry => entry.js?.includes(file));
    ensure(entries.length === 1 && entries[0].world === world && entries[0].run_at === 'document_start' &&
      !entries[0].all_frames, 'Missing or unsafe group identity content script.');
  }
  const paths = new Set(['manifest.json', 'config.js', 'LICENSE']);
  for (const entry of manifest.content_scripts) {
    ensure(Object.keys(entry).every(key => ['matches', 'js', 'run_at', 'world'].includes(key)),
      'Unsupported content script option.');
    for (const file of entry.js) paths.add(file);
  }
  for (const entry of manifest.web_accessible_resources) {
    ensure(Object.keys(entry).every(key => ['matches', 'resources'].includes(key)), 'Unsupported resource option.');
    for (const file of entry.resources) paths.add(file);
  }
  const files = new Map();
  for (const file of [...paths].sort()) {
    const data = file === 'config.js' ? Buffer.from(configSource) : readRuntimeFile(root, file);
    if (file.endsWith('.js') || file.endsWith('.json') || file === 'LICENSE') {
      const source = data.toString('utf8');
      scanSecrets(source);
      ensure(!/BH (?:IdentityDiag|IndicatorDiag|PriorityDiag)|priorityRegressionDiagnosticsV1/.test(source),
        'Temporary investigation diagnostics found in runtime.');
      // Literal runtime paths include sound options as well as getURL arguments.
      for (const match of source.matchAll(/["']((?:src|assets)\/[^"'\s]+)["']/g)) {
        ensure(paths.has(match[1]), 'Dynamic runtime resource is missing from manifest.');
      }
      for (const match of source.matchAll(/\bgetURL\(\s*([^)]*)\)/g)) {
        ensure(/^(?:['"][^'"]+['"]|alertFile|softFile)$/.test(match[1].trim()),
          'Unknown dynamic getURL dependency; review packaging first.');
      }
    } else {
      ensure(data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE', 'Invalid sound asset.');
    }
    files.set(file, data);
  }
  ensure(files.size <= 512 && [...files.values()].reduce((sum, data) => sum + data.length, 0) <= 32 * 1024 * 1024,
    'Runtime package exceeds size bounds.');
  return { manifest, files };
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Standard ZIP/deflate, UTF-8 names, fixed timestamp, no dependencies or shell commands.
function createZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [file, data] of files) {
    const name = Buffer.from(`bosun-helper/${file}`), compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function packageInternal(root = path.resolve(__dirname, '..')) {
  root = fs.realpathSync(root);
  const { manifest, files } = collectRuntime(root);
  const archive = createZip(files);
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  ensure(!fs.lstatSync(dist).isSymbolicLink(), 'dist must not be a symlink.');
  const filename = path.join(dist, `bosun-helper-internal-v${manifest.version}.zip`);
  ensure(!fs.existsSync(filename) || fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink(),
    'Unsafe archive destination.');
  const temporary = path.join(dist, `.package-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, archive, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { filename, bytes: archive.length, files: files.size };
}

if (require.main === module) {
  try {
    const result = packageInternal();
    console.log(`Internal package: dist/${path.basename(result.filename)} (${result.bytes} bytes, ${result.files} files)`);
  } catch (error) {
    // Filesystem/JSON/config errors may contain operational data: never echo them.
    const reason = error instanceof PackageError || error instanceof ConfigSyncError
      ? error.message : 'Verify runtime config, manifest, resource paths and absence of credentials.';
    console.error(`Internal packaging failed: ${reason}`);
    process.exitCode = 1;
  }
}

module.exports = { collectRuntime, packageInternal };
