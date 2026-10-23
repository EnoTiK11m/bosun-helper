'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { updateManifest, buildConfigSource } = require('../scripts/config-sync');
const { collectRuntime, packageInternal } = require('../scripts/package-internal');

const project = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-package-test-'));
const config = { bosunHosts: ['synthetic-bosun.internal'], grafanaHost: 'synthetic-grafana.internal',
  grafanaPanelUrl: 'https://synthetic-grafana.internal/d/synthetic/dashboard?orgId=1&editPanel=2&from=now-6h&to=now&timezone=browser&refresh=5s' };
const manifest = updateManifest(JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8')), config);
const writeManifest = value => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(value));
const writeConfig = value => {
  for (const name of ['config.js', 'config.local.js']) fs.writeFileSync(path.join(root, name), buildConfigSource(value));
};

// Читаем центральные и локальные структуры ZIP независимо от записывающего кода.
function unpack(zip) {
  const end = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10), entries = new Map();
  let offset = zip.readUInt32LE(end + 16);
  assert.strictEqual(offset + zip.readUInt32LE(end + 12), end);
  for (let i = 0; i < count; i++) {
    assert.strictEqual(zip.readUInt32LE(offset), 0x02014b50);
    assert.strictEqual(zip.readUInt16LE(offset + 10), 8);
    const length = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 46, offset + 46 + length);
    const local = zip.readUInt32LE(offset + 42);
    assert.strictEqual(zip.readUInt32LE(local), 0x04034b50);
    const localNameLength = zip.readUInt16LE(local + 26);
    assert.strictEqual(zip.toString('utf8', local + 30, local + 30 + localNameLength), name);
    const start = local + 30 + localNameLength + zip.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(offset + 20)));
    assert.strictEqual(data.length, zip.readUInt32LE(offset + 24));
    assert.strictEqual(zip.readUInt32LE(local + 14), zip.readUInt32LE(offset + 16));
    assert.ok(!entries.has(name)); entries.set(name, data);
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.strictEqual(offset, end);
  return entries;
}

try {
  writeManifest(manifest); writeConfig(config);
  const paths = new Set(['LICENSE', ...manifest.content_scripts.flatMap(entry => entry.js),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources)]);
  paths.delete('config.js');
  for (const file of paths) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(project, file), target);
  }
  for (const file of ['tests/ignored.js', 'scripts/dev.js', 'node_modules/ignored.js', '.git/ignored',
    'config.local.extra.js', 'bosun-rules.conf', 'capture.json', 'notes.md']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'must-not-be-packaged');
  }
  fs.writeFileSync(path.join(root, 'config.js'), buildConfigSource(config)
    .replace('"bosunHosts"', '/* temporary-private-comment-canary */ "bosunHosts"'));
  const originalConfig = fs.readFileSync(path.join(root, 'config.js'));
  const originalManifest = fs.readFileSync(path.join(root, 'manifest.json'));
  const expected = collectRuntime(root), result = packageInternal(root);
  assert.strictEqual(path.basename(result.filename), `bosun-helper-internal-v${manifest.version}.zip`);
  const archive = fs.readFileSync(result.filename), entries = unpack(archive);
  assert.strictEqual(entries.size, expected.files.size);
  for (const [name, data] of expected.files) assert.deepStrictEqual(entries.get(`bosun-helper/${name}`), data);
  assert.ok(!entries.get('bosun-helper/config.js').toString().includes('private-comment-canary'));
  assert.ok(entries.get('bosun-helper/config.js').toString().includes('synthetic-bosun.internal'));
  for (const name of ['src/bosun/last-action.js', 'src/bosun/group-identity.js', 'src/bosun/group-identity-page.js',
    'src/grafana/grafana-page.js', 'assets/sounds/bosun_notification_soft_chime.wav']) {
    assert.ok(entries.has(`bosun-helper/${name}`));
  }
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'config.js')), originalConfig);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'manifest.json')), originalManifest);
  assert.deepStrictEqual(fs.readFileSync(packageInternal(root).filename), archive, 'Packaging must be reproducible');
  const reject = (change, restore) => {
    try { change(); assert.throws(() => packageInternal(root)); }
    finally { restore(); }
    assert.deepStrictEqual(fs.readFileSync(result.filename), archive, 'A failed build must preserve the previous ZIP');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'dist')), [path.basename(result.filename)]);
  };
  for (const altered of [
    { ...config, bosunHosts: ['bosun.example.com'] },
    { ...config, grafanaPanelUrl: 'https://user:private-canary@synthetic-grafana.internal/d/synthetic/dashboard?editPanel=1' },
    { ...config, grafanaPanelUrl: config.grafanaPanelUrl + '&token=private-canary' },
    { ...config, grafanaPanelUrl: config.grafanaPanelUrl + '&editPanel=3' },
    { ...config, grafanaPanelUrl: config.grafanaPanelUrl.replace('editPanel=2', 'viewPanel=2') },
    { ...config, password: 'private-canary' }
  ]) reject(() => writeConfig(altered), () => writeConfig(config));
  reject(() => fs.writeFileSync(path.join(root, 'config.local.js'), buildConfigSource({ ...config, bosunHosts: ['different.internal'] })),
    () => writeConfig(config));
  for (const change of [
    next => { next.content_scripts[0].matches = ['https://wrong.internal/*']; },
    next => { next.content_scripts[2].matches = ['https://wrong.internal/*']; },
    next => { next.permissions.push('tabs'); },
    next => { next.background = { service_worker: 'scripts/dev.js' }; },
    next => { next.content_scripts[0].js.push('../config.local.js'); },
    next => { next.content_scripts[0].js.push('src/bosun/missing.js'); },
    next => { next.web_accessible_resources[0].resources.push('assets/*'); },
    next => { next.content_scripts[2].world = 'ISOLATED'; },
    next => { next.content_scripts[2].run_at = 'document_end'; },
    next => { next.content_scripts[3].all_frames = true; }
  ]) reject(() => { const next = structuredClone(manifest); change(next); writeManifest(next); }, () => writeManifest(manifest));
  const contentPath = path.join(root, 'src/bosun/content.js'), content = fs.readFileSync(contentPath);
  for (const suffix of [
    '\nconst password = "private-credential-canary";',
    '\nconst credentials = {"token": "private-credential-canary"};',
    '\nconst url = "https://user:private-canary@synthetic.internal/";',
    '\nconst url = "https://synthetic.internal/?access_token=private-canary";',
    '\n// BH IdentityDiag',
    '\nchrome.runtime.getURL("src/bosun/unlisted.js");',
    '\nchrome.runtime.getURL(arbitraryVariable);'
  ]) reject(() => fs.appendFileSync(contentPath, suffix), () => fs.writeFileSync(contentPath, content));
  const sourceDirectory = path.join(root, 'src/bosun'), movedDirectory = path.join(root, 'saved-bosun');
  fs.renameSync(sourceDirectory, movedDirectory);
  try {
    fs.symlinkSync(movedDirectory, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => packageInternal(root), /Symlink/);
  } finally {
    if (fs.existsSync(sourceDirectory)) fs.unlinkSync(sourceDirectory);
    fs.renameSync(movedDirectory, sourceDirectory);
  }
  console.log(`Internal packaging tests passed (${entries.size} files, reproducible ZIP, fail-closed config/resources/credentials)`);
} finally {
  const target = path.resolve(root);
  assert.ok(path.dirname(target) === fs.realpathSync(os.tmpdir()) || path.dirname(target) === path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('bosun-helper-package-test-'));
  fs.rmSync(target, { recursive: true, force: true });
}
