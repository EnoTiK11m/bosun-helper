'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git: runGit } = require('./project-tools');
const { loadConfigFile } = require('./config-sync');
const ZERO = /^0+$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RESERVED = /(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/i;
const HISTORICAL_DOCS = new Set([
  'docs/GRAFANA-PROMQL.md', 'docs/SINGLE-ALERT-AGE-DIAGNOSTICS.md', 'docs/WIKI-INSTALL.md'
]);
// Сравниваем фактические байты объектов без локальных подмен через refs/replace.
function git(root, args, options) { return runGit(root, ['--no-replace-objects', ...args], options); }

// Точные публичные контрольные значения проверяют отказ упаковки, не создавая общего исключения для tests/.
// Собираем URL из частей, чтобы код проверки сам не стал тестовым URL.
const PACKAGE_FIXTURE = 'tests/package-internal-test.js';
const FIXTURE_URLS = new Set([
  ['https:', '', 'synthetic-grafana.internal', 'd/synthetic/dashboard?orgId=1&editPanel=2&from=now-6h&to=now&timezone=browser&refresh=5s'].join('/'),
  ['https:', '', 'wrong.internal', '*'].join('/'),
  ['https:', '', 'user:private-canary@synthetic-grafana.internal', 'd/synthetic/dashboard?editPanel=1'].join('/'),
  ['https:', '', 'user:private-canary@synthetic.internal', ''].join('/'),
  ['https:', '', 'synthetic.internal', '?access_token=private-canary'].join('/')
]);
function fixtureAssignment(name, key, value) {
  return name === PACKAGE_FIXTURE && /^(?:password|token)$/i.test(key) &&
    /^(?:private-canary|private-credential-canary)$/.test(value) ||
    /^(?:tests\/)?integration-test\.js$/.test(name) && key === 'token' && value === 'poisoned';
}

function forbidden(name) {
  return /^(?:docs|\.worklogs|\.agents|\.codex|dist)(?:\/|$)/i.test(name) ||
    /(?:^|\/)(?:AGENTS\.md|WORKLOG\.md|SUMMARY\.md|config\.local\.js|bosun-rules\.conf|\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(name) ||
    /(?:^|\/)(?:backup[^/]*\.(?:zip|tar|gz)|[^/]*\.(?:pem|p12|pfx|key))$/i.test(name);
}
function localHosts(root) {
  const hosts = new Set();
  for (const name of ['config.js', 'config.local.js']) {
    const file = path.join(root, name); if (!fs.existsSync(file)) continue;
    const config = loadConfigFile(file); // Используем существующий декларативный парсер, не исполняя конфигурацию через eval.
    for (const host of [...config.bosunHosts, config.grafanaHost]) {
      const hostname = new URL(`https://${host}`).hostname.toLowerCase();
      if (!RESERVED.test(hostname)) hosts.add(hostname);
    }
  }
  return hosts;
}
function scanText(text, hosts, configFile = false, name = '') {
  const reasons = new Set();
  // Учитываем обычные escape-последовательности JSON/JS; найденные значения не возвращаем.
  const decoded = text.replace(/\\u([a-f0-9]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/');
  const lower = decoded.toLowerCase();
  for (const host of hosts) if (lower.includes(host)) reasons.add('configured-internal-host');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(decoded)) reasons.add('private-key');
  if (/\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[a-zA-Z0-9_-]{24,})\b/.test(decoded)) reasons.add('credential-format');
  if (/\bBearer\s+[a-zA-Z0-9._~+/-]{20,}/i.test(decoded)) reasons.add('bearer-token');
  if (/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(decoded)) reasons.add('jwt');
  // Читаем целиком ключ в кавычках или без них: channelToken не является полем token.
  const assignments = /(?<![\w$"'-])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([a-z_$][\w$-]*))\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;
  for (const match of decoded.matchAll(assignments)) {
    const key = match[1] || match[2] || match[3], value = match[4];
    if (!/^(?:password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token)$/i.test(key)) continue;
    if (!configFile && fixtureAssignment(name, key, value)) continue;
    // Общее исключение допустимо только для явного синтаксиса шаблонов. Префикс test/demo и т. п.
    // не доказывает тестовое происхождение; точные публичные контрольные значения ограничены выше.
    if (!/^(?:<[^>]+>|\$\{[^}]+\})$/.test(value)) reasons.add('secret-assignment');
  }
  for (const match of decoded.matchAll(/\bhttps?:\/\/[^\s"'`<>\\)]+/gi)) {
    try {
      const url = new URL(match[0]), hostname = url.hostname.toLowerCase();
      // Общие проверки hosts, ключей и токенов выше действуют и для этих точных литералов.
      if (!configFile && name === PACKAGE_FIXTURE && FIXTURE_URLS.has(match[0])) continue;
      if (url.username || url.password) reasons.add('url-credentials');
      if (/(?:^|\.)(?:internal|local|lan|corp)$/.test(hostname) ||
          /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname) ||
          /^\[(?:::1|f[cd]|fe80)/i.test(hostname)) reasons.add('private-network-url');
      if (configFile && !RESERVED.test(hostname)) reasons.add('non-public-example-config');
      if ([...url.searchParams.keys()].some(key => /^(?:token|access_token|api_key|apikey|password|secret)$/i.test(key))) reasons.add('url-secret-parameter');
    } catch (_) { if (configFile) reasons.add('invalid-config-url'); }
  }
  // Имена hosts из config.js не обязательно записаны как URL.
  if (configFile === 'config') for (const match of decoded.matchAll(/["']([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?["']/gi)) {
    if (!RESERVED.test(match[1])) reasons.add('non-public-example-config');
  }
  return [...reasons];
}
function readObjects(root, ids, encoding = 'utf8') {
  const unique = [...new Set(ids)]; if (!unique.length) return new Map();
  if (unique.some(id => !OID.test(id))) throw new Error('Invalid object ID');
  const output = git(root, ['cat-file', '--batch'], { encoding: null, input: Buffer.from(unique.join('\n') + '\n'), maxBuffer: 256 * 1024 * 1024 });
  let offset = 0; const objects = new Map();
  for (const expected of unique) {
    const end = output.indexOf(10, offset); if (end < 0) throw new Error('Invalid batch');
    const [oid, type, sizeText] = output.subarray(offset, end).toString('ascii').split(' '), size = Number(sizeText);
    if (oid !== expected || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || end + 2 + size > output.length) throw new Error('Object unavailable/oversized');
    objects.set(oid, { type, text: output.subarray(end + 1, end + 1 + size).toString(encoding) }); offset = end + size + 2;
  }
  return objects;
}
function treeEntries(root, revision) {
  return git(root, ['ls-tree', '-rz', '--full-tree', revision]).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row); if (!match) throw new Error('Invalid tree');
    if (match[2] !== 'blob') throw new Error('Submodule requires manual review');
    return { mode: match[1], oid: match[3], name: match[4] };
  });
}
function scanEntries(root, entries, hosts, cache = new Map(), historical = false) {
  const missing = entries.filter(e => !cache.has(e.oid));
  for (const [id, object] of readObjects(root, missing.map(e => e.oid))) cache.set(id, object);
  const counts = new Map();
  for (const entry of entries) {
    const reasons = [];
    if (forbidden(entry.name) && !(historical && HISTORICAL_DOCS.has(entry.name))) reasons.push('forbidden-publication-path');
    if (entry.mode === '120000') reasons.push('symlink-requires-review');
    const object = cache.get(entry.oid); if (object?.type !== 'blob') throw new Error('Not a blob');
    const configKind = /(?:^|\/)config(?:\.local)?\.js$/.test(entry.name) ? 'config'
      : /(?:^|\/)manifest\.json$/.test(entry.name) ? 'manifest' : false;
    reasons.push(...scanText(object.text, hosts, configKind, entry.name));
    for (const reason of new Set(reasons)) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return counts;
}
function mergeCounts(target, other) { for (const [key, count] of other) target.set(key, (target.get(key) || 0) + count); }
function scanIndex(root) {
  const entries = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);
    if (!match || match[3] !== '0') throw new Error('Unmerged index');
    return { mode: match[1], oid: match[2], name: match[4] };
  });
  return scanEntries(root, entries, localHosts(root));
}
function scanRevisions(root, revisions, hosts = localHosts(root), historical = new Set()) {
  const counts = new Map(), cache = new Map();
  if (revisions.length > 10000) throw new Error('History scan budget exceeded');
  const metadata = readObjects(root, revisions), expanded = [...new Set(revisions)];
  // Аннотированные теги могут ссылаться на другие теги; каждое сообщение в цепочке проверяется как содержимое.
  for (let i = 0; i < expanded.length; i++) {
    const object = metadata.get(expanded[i]);
    if (object.type !== 'tag') continue;
    const target = /^object ([a-f0-9]+)$/m.exec(object.text)?.[1];
    if (!target || !OID.test(target) || expanded.length > 10000) throw new Error('Invalid tag chain');
    if (!metadata.has(target)) { metadata.set(target, readObjects(root, [target]).get(target)); expanded.push(target); }
  }
  for (const revision of expanded) {
    const object = metadata.get(revision);
    for (const reason of scanText(object.text, hosts)) counts.set(reason, (counts.get(reason) || 0) + 1);
    if (object.type === 'commit' || object.type === 'tree' || object.type === 'tag') {
      // По возможности раскрываем тег до дерева; ссылки тегов на blob проверяются ниже.
      const peeled = git(root, ['rev-parse', `${revision}^{}`]).trim();
      const type = git(root, ['cat-file', '-t', peeled]).trim();
      if (type === 'blob') {
        for (const reason of scanText(readObjects(root, [peeled]).get(peeled).text, hosts)) counts.set(reason, (counts.get(reason) || 0) + 1);
      } else mergeCounts(counts, scanEntries(root, treeEntries(root, revision), hosts, cache, historical.has(peeled)));
    }
  }
  return counts;
}
function provePublishedTranslation(root, local, remote) {
  // Старый ID объекта берётся из удалённой ref, объявленной Git, а не из списка разрешений
  // в отправляемом дереве. Доказываем взаимно однозначное соответствие всего графа коммитов и тегов.
  const commits = new Set(), cache = new Map(), seen = new Set(), forward = new Map(), reverse = new Map();
  let pending = [[remote, local]], bytes = 0;
  const reject = () => new Set();
  while (pending.length) {
    const batch = pending; pending = [];
    const missing = [...new Set(batch.flat().filter(id => !cache.has(id)))];
    // Latin1 сохраняет каждый байт метаданных, включая имена авторов вне UTF-8.
    for (const [id, object] of readObjects(root, missing, 'latin1')) {
      bytes += object.text.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('Translation proof budget exceeded');
      cache.set(id, object);
    }
    for (const [oldId, newId] of batch) {
      const key = oldId + ':' + newId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 10000) throw new Error('Translation proof budget exceeded');
      if ((forward.has(oldId) && forward.get(oldId) !== newId) ||
          (reverse.has(newId) && reverse.get(newId) !== oldId)) return reject();
      forward.set(oldId, newId); reverse.set(newId, oldId);
      const oldObject = cache.get(oldId), newObject = cache.get(newId);
      if (!oldObject || oldObject.type !== newObject?.type || !['commit', 'tag'].includes(oldObject.type)) return reject();
      const oldEnd = oldObject.text.indexOf('\n\n'), newEnd = newObject.text.indexOf('\n\n');
      if (oldEnd < 0 || newEnd < 0) return reject();
      const oldHeader = oldObject.text.slice(0, oldEnd), newHeader = newObject.text.slice(0, newEnd);
      if (/^(?:gpgsig(?:-sha256)?|mergetag) /m.test(oldHeader + '\n' + newHeader)) return reject();
      if (oldObject.type === 'commit') {
        const parents = header => [...header.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
        const oldParents = parents(oldHeader), newParents = parents(newHeader);
        const metadata = header => header.replace(/^parent [a-f0-9]+$/gm, 'parent');
        // Сравнение включает полный OID дерева: пути, режимы и байты blob должны совпасть.
        if (metadata(oldHeader) !== metadata(newHeader) || oldParents.length !== newParents.length) return reject();
        for (let i = 0; i < oldParents.length; i++) pending.push([oldParents[i], newParents[i]]);
        commits.add(newId);
      } else {
        if (/-----BEGIN (?:PGP|SSH) SIGNATURE-----/.test(oldObject.text + newObject.text)) return reject();
        const target = header => /^object ([a-f0-9]+)$/m.exec(header)?.[1];
        const oldTarget = target(oldHeader), newTarget = target(newHeader);
        if (!oldTarget || !newTarget || oldHeader.replace(/^object [a-f0-9]+$/m, 'object') !==
            newHeader.replace(/^object [a-f0-9]+$/m, 'object')) return reject();
        pending.push([oldTarget, newTarget]);
      }
    }
  }
  return commits;
}
function scanPush(root, input) {
  const revisions = new Set(), eligible = new Map();
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Too many refs');
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+/); if (parts.length !== 4 || !OID.test(parts[1]) || !OID.test(parts[3])) throw new Error('Invalid pre-push input');
    const [, local, , remote] = parts; if (ZERO.test(local)) continue;
    const args = ['rev-list', local]; if (!ZERO.test(remote)) args.push(`^${remote}`);
    const outgoing = git(root, args).trim().split('\n').filter(Boolean);
    const proven = ZERO.test(remote) ? new Set() : provePublishedTranslation(root, local, remote);
    const peeled = git(root, ['rev-parse', `${local}^{}`]).trim();
    for (const id of [...outgoing, local, peeled]) {
      revisions.add(id);
      // Проверенная существующая ref не разрешает то же содержимое для новой
      // или непроверенной ref в том же push. Каждая использующая его ref должна пройти проверку.
      eligible.set(id, (eligible.get(id) ?? true) && proven.has(id));
    }
  }
  return scanRevisions(root, [...revisions], localHosts(root), new Set([...eligible].filter(([, ok]) => ok).map(([id]) => id)));
}
function report(counts, mode) {
  if (!counts.size) { console.log(`Publication guard ${mode}: PASS.`); return 0; }
  console.error(`Publication guard ${mode}: BLOCKED. Matched values, paths and diff contents withheld.`);
  for (const [reason, count] of counts) console.error(`  ${reason}: ${count}`);
  if (counts.has('forbidden-publication-path')) console.error('Forbidden files must be absent from the resulting index/tree. Working-tree deletion alone is not a staged removal; new forbidden files remain blocked.');
  console.error('Review the exact index/outgoing objects manually. Working configuration was not changed.');
  return 1;
}
if (require.main === module) {
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim(), mode = process.argv[2];
    let counts;
    if (mode === 'pre-commit' || mode === 'index') counts = scanIndex(root);
    else if (mode === 'commit-msg') {
      if (!process.argv[3] || fs.statSync(process.argv[3]).size > 2 * 1024 * 1024) throw new Error('Invalid message');
      counts = new Map(scanText(fs.readFileSync(process.argv[3], 'utf8'), localHosts(root)).map(reason => [reason, 1]));
    }
    else if (mode === 'pre-push') counts = scanPush(root, fs.readFileSync(0, 'utf8'));
    else if (mode === 'history') {
      const revisions = git(root, ['rev-list', '--all']).trim().split('\n').filter(Boolean);
      const tips = git(root, ['for-each-ref', '--format=%(objectname)']).trim().split('\n').filter(Boolean);
      counts = scanRevisions(root, [...new Set([...revisions, ...tips])]); console.log(`History audit: ${revisions.length} reachable commits plus ref/tag tips (local refs only).`);
    } else throw new Error('Unknown mode');
    process.exitCode = report(counts, mode);
  } catch (_) { console.error('Publication guard: BLOCKED; inspection failed or exceeded bounds. No raw values printed.'); process.exitCode = 1; }
}
module.exports = { forbidden, scanText, localHosts, readObjects, scanIndex, scanRevisions, scanPush, report };
