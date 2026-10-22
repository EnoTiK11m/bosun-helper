'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkDocs, fingerprint, safe, status, receiptPath } = require('../scripts/project-tools');
const { scanIndex, scanPush, scanText, forbidden } = require('../scripts/publication-guard');
const { install } = require('../scripts/install-git-hooks');
const repository = path.resolve(__dirname, '..');
const roots = [];
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-process-test-config-')); roots.push(configRoot);
const emptyConfig = path.join(configRoot, 'empty.gitconfig'); fs.writeFileSync(emptyConfig, '');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
function command(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 0, `Synthetic Git operation failed: ${args[0]}`); return result.stdout.trim();
}
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-process-test-')); roots.push(root); command(root, ['init', '-q']); return root; }
function write(root, name, value) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function stage(root, name, value) {
  const oid = command(root, ['hash-object', '-w', '--stdin'], value);
  command(root, ['update-index', '--add', '--cacheinfo', `100644,${oid},${name}`]);
  return oid;
}
function commitObject(root, parent, message = 'Synthetic commit') {
  const tree = command(root, ['write-tree']);
  return command(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], message + '\n');
}
function docFixture(root) {
  write(root, 'manifest.json', '{"version":"2.0.0"}'); write(root, 'package.json', '{"version":"2.0.0"}');
  write(root, 'docs/CHANGELOG.md', '## Unreleased\n## Текущая версия — 2.0.0\n');
  write(root, '.worklogs/topic.md', '- Проверки: PASS — synthetic verification\n');
  const text = '# Roadmap\n## Новое\n## В работе\n## Выполненные\n' +
    '- [DOC-1] Проверка — [worklog](../.worklogs/topic.md)\n  - [x] Условие проверено.\n  - Проверки: PASS — проверены файлы.\n  - LIVE: не требуется\n';
  write(root, 'docs/ROADMAP.md', text); return text;
}
try {
  const docs = workspace(), roadmap = docFixture(docs);
  assert.deepEqual(checkDocs(docs).errors, []);
  for (const broken of [roadmap.replace('## Новое', '## Идеи'), roadmap + roadmap.split('- [DOC-1]')[1].replace(/^/, '- [DOC-1]'),
    roadmap.replace('[x]', '[ ]'), roadmap.replace('PASS — проверены файлы.', 'не запускались'),
    roadmap.replace('LIVE: не требуется', 'LIVE: требуется; не проведена'), roadmap.replace('topic.md', 'missing.md')]) {
    write(docs, 'docs/ROADMAP.md', broken); assert.ok(checkDocs(docs).errors.length);
  }
  write(docs, 'docs/ROADMAP.md', roadmap); write(docs, 'manifest.json', '{"version":"2.0.1"}'); assert.ok(checkDocs(docs).errors.length);
  write(docs, 'manifest.json', '{"version":"2.0.0"}');
  write(docs, 'docs/ROADMAP.md', roadmap + roadmap.slice(roadmap.indexOf('- [DOC-1]')).replace('[DOC-1]', '[DOC-2]'));
  assert.ok(checkDocs(docs).errors.length, 'Same task under a different ID must be rejected');
  write(docs, 'docs/ROADMAP.md', roadmap);
  write(docs, '.worklogs/topic.md', '- Проверки: FAIL\n'); assert.ok(checkDocs(docs).errors.length);
  write(docs, '.worklogs/topic.md', '- Проверки: PASS — synthetic verification\n');
  const before = fingerprint(docs, 'test'); write(docs, 'src/new.js', 'changed'); assert.notEqual(fingerprint(docs, 'test'), before);
  const output = []; const originalLog = console.log;
  console.log = line => output.push(line);
  try {
    status(docs); assert.ok(output.some(line => line.includes('нет достоверной записи'))); output.length = 0;
    const receipt = receiptPath(docs); fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ version: 1, checks: [{ command: 'test', exitCode: 0, stable: true,
      finishedAt: new Date().toISOString(), fingerprint: fingerprint(docs, 'test') }] }));
    status(docs); assert.ok(output.some(line => line.includes('test: PASS') && !line.includes('устарело'))); output.length = 0;
    write(docs, 'src/new.js', 'new change'); status(docs); assert.ok(output.some(line => line.includes('устарело')));
  } finally { console.log = originalLog; }
  const privateUrl = ['https:/', '/service.', 'internal'].join('');
  const credential = 'ghp_' + 'A'.repeat(36);
  assert.ok(scanText(privateUrl, new Set()).length); assert.ok(scanText(credential, new Set()).length);
  assert.equal(scanText('https://example.org/demo', new Set()).length, 0);
  assert.equal(scanText('{"resources":["config.js"]}', new Set(), 'manifest').length, 0);
  assert.ok(scanText('https://public-service.com', new Set(), 'config').length);
  assert.ok(!safe(privateUrl + ' ' + credential).includes(credential));
  for (const name of ['config.local.js', '.env', 'docs/PROJECT.md', '.worklogs/topic.md', 'backup-docs.zip']) assert.ok(forbidden(name));

  const emptyHosts = new Set();
  const assignment = (key, value) => JSON.stringify({ [key]: value });
  for (const key of ['channelToken', '$channelToken', 'my-token', 'tokenSuffix']) {
    assert.deepEqual(scanText(assignment(key, 'secret-token'), emptyHosts), [], 'Whole credential keys only');
    assert.deepEqual(scanText(`${key} = 'secret-token'`, emptyHosts), []);
  }
  for (const key of ['token', 'password', 'api_key', 'api-key', 'access-token', 'accessToken', 'client_secret']) {
    assert.ok(scanText(assignment(key, 'actual-credential-value'), emptyHosts).includes('secret-assignment'));
    assert.ok(scanText(`${key} = 'actual-credential-value'`, emptyHosts).includes('secret-assignment'));
    assert.ok(scanText(`'${key}': 'actual-credential-value'`, emptyHosts).includes('secret-assignment'));
  }
  assert.ok(scanText(assignment('token', credential), emptyHosts).includes('credential-format'));
  const escapedToken = assignment('token', 'actual-credential-value').replace('token', '\\u0074oken');
  assert.ok(scanText(escapedToken, emptyHosts).includes('secret-assignment'));
  for (const prefix of ['test', 'demo', 'example', 'placeholder', 'redacted', 'synthetic', 'fake']) {
    const value = prefix + '-potential-credential-12345678';
    for (const name of ['src/sample.js', 'tests/integration-test.js', 'tests/package-internal-test.js']) {
      assert.ok(scanText(assignment('password', value), emptyHosts, false, name).includes('secret-assignment'),
        'A synthetic-looking prefix must not exempt an arbitrary credential');
    }
    assert.ok(scanText(assignment('token', value), emptyHosts, 'config', 'config.js').includes('secret-assignment'));
  }
  const fixtureRoot = workspace();
  for (const name of ['tests/integration-test.js', 'tests/browser-test.js', 'tests/package-internal-test.js']) {
    const source = fs.readFileSync(path.join(repository, name), 'utf8');
    stage(fixtureRoot, name, source);
    assert.equal(scanIndex(fixtureRoot).size, 0, 'Existing synthetic fixtures must pass');
  }
  const fixtureName = 'tests/package-internal-test.js';
  const syntheticUrl = ['https:/', '/user:private-canary@synthetic.internal/'].join('');
  assert.deepEqual(scanText(syntheticUrl, emptyHosts, false, fixtureName), []);
  assert.ok(scanText(syntheticUrl, emptyHosts, false, 'src/other.js').length, 'Exception must be path scoped');
  assert.ok(scanText(syntheticUrl, emptyHosts, 'config', fixtureName).length, 'No config exemption');
  assert.ok(scanText(syntheticUrl, new Set(['synthetic.internal']), false, fixtureName).includes('configured-internal-host'));
  assert.deepEqual(scanText(assignment('token', 'poisoned'), emptyHosts, false, 'tests/integration-test.js'), []);
  assert.deepEqual(scanText(assignment('token', 'poisoned'), emptyHosts, false, 'integration-test.js'), [], 'Historical fixture path uses the same public canary');
  assert.ok(scanText(assignment('token', 'poisoned'), emptyHosts, false, fixtureName).length);
  const keyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const bearer = ['Bearer', 'A'.repeat(32)].join(' ');
  const jwt = ['eyJ' + 'A'.repeat(12), 'B'.repeat(12), 'C'.repeat(12)].join('.');
  for (const content of [credential, privateUrl, assignment('token', 'actual-credential-value'),
    syntheticUrl.replace('private-canary', 'different-credential'), syntheticUrl.replace('synthetic.', 'other.'),
    syntheticUrl + '?token=changed-value', assignment('password', credential), keyMarker, bearer, jwt]) {
    stage(fixtureRoot, fixtureName, content);
    assert.ok(scanIndex(fixtureRoot).size, 'Real or changed risks in test files must still block');
  }
  // New regression source and the detector must themselves remain publishable.
  for (const name of ['scripts/publication-guard.js', 'tests/development-tools-test.js']) {
    assert.deepEqual(scanText(fs.readFileSync(path.join(repository, name), 'utf8'), emptyHosts, false, name), []);
  }

  const root = workspace(); stage(root, 'file.txt', 'safe'); const base = commitObject(root);
  write(root, 'file.txt', privateUrl); assert.equal(scanIndex(root).size, 0, 'Unstaged risky text must not replace index scan');
  stage(root, 'file.txt', privateUrl); write(root, 'file.txt', 'safe'); assert.ok(scanIndex(root).size, 'Staged secret hidden by clean working file must be blocked');
  const risky = commitObject(root, base); stage(root, 'file.txt', 'safe'); const clean = commitObject(root, risky);
  const zeros = '0'.repeat(40), line = (local, remote = zeros) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;
  assert.ok(scanPush(root, line(clean, base)).size, 'Intermediate outgoing risky commit must be scanned');
  assert.equal(scanPush(root, line(clean, risky)).size, 0, 'Already remote history excluded for existing ref');
  assert.ok(scanPush(root, line(clean)).size, 'New ref scans full reachable history');
  assert.equal(scanPush(root, line(zeros, clean)).size, 0, 'Deletion sends no content');
  assert.throws(() => scanPush(root, line(clean, 'f'.repeat(40))));
  const tag = command(root, ['mktag'], `object ${clean}\ntype commit\ntag synthetic\ntagger Synthetic <test@example.invalid> 1700000000 +0000\n\n${credential}\n`);
  assert.ok(scanPush(root, `refs/tags/synthetic ${tag} refs/tags/synthetic ${zeros}\n`).size, 'Annotated tag messages scanned');
  const outer = command(root, ['mktag'], `object ${tag}\ntype tag\ntag outer\ntagger Synthetic <test@example.invalid> 1700000000 +0000\n\nSafe outer message\n`);
  assert.ok(scanPush(root, `refs/tags/outer ${outer} refs/tags/outer ${zeros}\n`).size, 'Nested annotated tag messages scanned');
  stage(root, '.worklogs/private.md', 'safe text'); assert.ok(scanIndex(root).has('forbidden-publication-path'));

  const deletionRoot = workspace();
  const oldDocs = ['docs/OLD.md', 'AGENTS.md', 'WORKLOG.md', 'SUMMARY.md', '.agents/skills/old/SKILL.md'];
  for (const name of oldDocs) stage(deletionRoot, name, 'Old local documentation');
  const docsBase = commitObject(deletionRoot);
  assert.ok(scanIndex(deletionRoot).has('forbidden-publication-path'), 'Unstaged deletion still leaves forbidden index content');
  for (const name of oldDocs) command(deletionRoot, ['update-index', '--force-remove', '--', name]);
  assert.equal(scanIndex(deletionRoot).size, 0, 'Prepared deletions scan the resulting tree, not removed blobs');
  const docsRemoved = commitObject(deletionRoot, docsBase);
  assert.equal(scanPush(deletionRoot, line(docsRemoved, docsBase)).size, 0, 'Removal of already remote documents is allowed');
  assert.ok(scanPush(deletionRoot, line(docsRemoved)).has('forbidden-publication-path'), 'New branch must still scan old ancestors');
  stage(deletionRoot, 'docs/NEW.md', 'New documentation');
  assert.ok(scanIndex(deletionRoot).has('forbidden-publication-path'), 'Adding forbidden docs still blocks');
  const docsReintroduced = commitObject(deletionRoot, docsRemoved);
  assert.ok(scanPush(deletionRoot, line(docsReintroduced, docsRemoved)).has('forbidden-publication-path'));
  for (const name of ['config.js', 'manifest.json']) {
    stage(fixtureRoot, name, JSON.stringify({ url: 'https://public-service.com' }));
    assert.ok(scanIndex(fixtureRoot).has('non-public-example-config'), 'Tracked configurations retain strict URL policy');
  }

  // Invoke hook files directly; no git add/commit/push in any repository.
  const hookRoot = workspace(); stage(hookRoot, 'file.txt', 'safe');
  for (const name of ['project-tools.js', 'publication-guard.js', 'config-sync.js']) write(hookRoot, `scripts/${name}`, fs.readFileSync(path.join(repository, 'scripts', name)));
  const hookDir = path.join(hookRoot, '.git', 'hooks');
  const oldCommit = '#!/bin/sh\nprintf preserved > "$PWD/old-hook-ran"\nexit 7\n';
  write(hookRoot, '.git/hooks/pre-commit', oldCommit); fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755);
  const oldPush = '#!/bin/sh\ncat > "$PWD/old-push-input"\nexit 0\n';
  write(hookRoot, '.git/hooks/pre-push', oldPush); fs.chmodSync(path.join(hookDir, 'pre-push'), 0o755);
  assert.equal(install(hookRoot), 3); assert.equal(install(hookRoot), 0);
  assert.equal(fs.readFileSync(path.join(hookDir, 'pre-commit.bosun-original'), 'utf8'), oldCommit);
  const execPath = command(hookRoot, ['--exec-path']);
  const bundledShell = path.resolve(execPath, '../../../usr/bin/sh.exe'); const shell = process.platform === 'win32' && fs.existsSync(bundledShell) ? bundledShell : 'sh';
  let result = spawnSync(shell, [path.join(hookDir, 'pre-commit')], { cwd: hookRoot, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 7, result.stderr); assert.equal(fs.readFileSync(path.join(hookRoot, 'old-hook-ran'), 'utf8'), 'preserved');
  const deletion = line(zeros, clean);
  result = spawnSync(shell, [path.join(hookDir, 'pre-push'), 'origin', 'redacted'], { cwd: hookRoot, encoding: 'utf8', input: deletion, env: gitEnv });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(path.join(hookRoot, 'old-push-input'), 'utf8'), deletion);
  stage(hookRoot, 'file.txt', privateUrl);
  result = spawnSync(shell, [path.join(hookDir, 'pre-commit')], { cwd: hookRoot, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 1); assert.ok(!result.stdout.includes(privateUrl) && !result.stderr.includes(privateUrl));
  write(hookRoot, 'message.txt', credential);
  result = spawnSync(shell, [path.join(hookDir, 'commit-msg'), 'message.txt'], { cwd: hookRoot, encoding: 'utf8', env: gitEnv });
  assert.equal(result.status, 1); assert.ok(!result.stderr.includes(credential));
  console.log('Development tools tests passed (docs criteria/versions, stale receipts, index/outgoing history, tags, preserved hooks/stdin and redacted failures).');
} finally {
  for (const root of roots) {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('bosun-process-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
