'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const COMMANDS = ['test', 'test:browser', 'check', 'check:docs'];
function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...options });
  if (result.status !== 0) throw new Error('Git operation failed; raw output withheld.');
  return result.stdout;
}
function safe(value, max = 160) {
  return String(value).replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]+/g, '[email]')
    .replace(/(?:gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{12,}/g, '[secret]')
    .replace(/\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[secret assignment]')
    .replace(/[\x00-\x1f\x7f\x1b]/g, ' ').slice(0, max);
}
function readJson(root, name) { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }

function parseRoadmap(text) {
  const sections = []; const tasks = []; let section = ''; let task = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^## /.test(line)) { section = line.slice(3).trim(); sections.push(section); task = null; }
    else if (/^- /.test(line)) {
      task = { section, title: line.slice(2), criteria: [], results: '', live: '', links: [] }; tasks.push(task);
    } else if (task) {
      const criterion = /^  - \[([ xX])\] (.+)$/.exec(line);
      if (criterion) task.criteria.push({ checked: criterion[1].toLowerCase() === 'x', text: criterion[2] });
      const result = /^  - Проверки: (.+)$/.exec(line); if (result) task.results = result[1];
      const live = /^  - LIVE: (.+)$/.exec(line); if (live) task.live = live[1];
    }
    if (task) for (const match of line.matchAll(/\]\(([^)]+)\)/g)) task.links.push(match[1]);
  }
  return { sections, tasks };
}

function checkDocs(root) {
  const errors = []; const roadmap = parseRoadmap(fs.readFileSync(path.join(root, 'docs/ROADMAP.md'), 'utf8'));
  if (roadmap.sections.join('|') !== 'Новое|В работе|Выполненные') errors.push('Roadmap must contain exactly the three ordered sections.');
  const ids = new Set(), titles = new Set();
  for (const [index, task] of roadmap.tasks.entries()) {
    const label = `Task ${index + 1}`;
    if (!roadmap.sections.includes(task.section)) errors.push(`${label}: unknown section.`);
    const id = /^\[([A-Z]+-\d+)\] /.exec(task.title)?.[1];
    const title = task.title.replace(/^\[[^\]]+\]\s*/, '').replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\s*[—–-]\s*$/, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!id || ids.has(id) || titles.has(title)) errors.push(`${label}: missing ID or duplicate task.`);
    ids.add(id); titles.add(title);
    if (!task.criteria.length) errors.push(`${label}: completion criteria required (indented checkboxes).`);
    if (!task.live) errors.push(`${label}: explicit LIVE requirement required.`);
    const worklogs = task.links.filter(link => /^\.\.\/\.worklogs\/[a-z0-9-]+\.md$/.test(link));
    if (task.section !== 'Новое' && worklogs.length !== 1) errors.push(`${label}: exactly one topic worklog required.`);
    for (const link of task.links) {
      if (!/^\.\.\/\.worklogs\/[a-z0-9-]+\.md$/.test(link)) { errors.push(`${label}: invalid worklog link.`); continue; }
      const file = path.resolve(root, 'docs', link);
      const logRoot = path.resolve(root, '.worklogs') + path.sep;
      if (!file.startsWith(logRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile() ||
          !fs.realpathSync(file).startsWith(fs.realpathSync(path.join(root, '.worklogs')) + path.sep)) {
        errors.push(`${label}: missing or unsafe worklog.`);
      } else if (task.section === 'Выполненные' && !/Проверки:.*\bPASS\b/.test(fs.readFileSync(file, 'utf8'))) {
        errors.push(`${label}: worklog has no recorded PASS.`);
      }
    }
    if (task.section === 'Выполненные') {
      if (task.criteria.some(item => !item.checked)) errors.push(`${label}: unchecked completion criterion.`);
      if (!/^PASS\s*[—:]/.test(task.results) || task.results.length < 12) errors.push(`${label}: concrete PASS results required.`);
      if (!(task.live === 'не требуется' || /^PASS\s*[—:]/.test(task.live))) errors.push(`${label}: required LIVE verification is incomplete.`);
    }
  }
  const version = readJson(root, 'manifest.json').version;
  if (version !== readJson(root, 'package.json').version) errors.push('Manifest/package versions differ.');
  const changelog = fs.readFileSync(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  const current = [...changelog.matchAll(/^## Текущая версия — (\S+)\s*$/gm)];
  if (current.length !== 1 || current[0][1] !== version) errors.push('CHANGELOG current version differs.');
  if ((changelog.match(/^## Unreleased\s*$/gm) || []).length !== 1) errors.push('Exactly one Unreleased section required.');
  const numeric = v => v.split(/[.+-]/).slice(0, 3).map(Number);
  for (const match of changelog.matchAll(/^## (?:\[)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gm)) {
    const a = numeric(match[1]), b = numeric(version);
    const first = a.findIndex((n, i) => n !== b[i]);
    if (first >= 0 && a[first] > b[first]) errors.push('CHANGELOG contains a version newer than manifest.');
  }
  return { errors, ...roadmap, version };
}

function fingerprint(root, command) {
  const entries = [`environment:${process.version}:${process.platform}:${process.arch}:${process.env.BOSUN_HELPER_BROWSER || ''}`];
  function walk(name) {
    const full = path.join(root, name); if (!fs.existsSync(full)) { entries.push(`${name}:missing`); return; }
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) { entries.push(`${name}:symlink:${fs.readlinkSync(full)}`); return; }
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) walk(`${name}/${child}`);
    else if (stat.isFile()) entries.push(`${name}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
  }
  const names = command === 'check:docs'
    ? ['docs', '.worklogs', 'AGENTS.md', 'manifest.json', 'package.json', 'scripts/project-tools.js']
    : ['src', 'tests', 'scripts', 'assets', 'manifest.json', 'package.json', 'config.js', 'config.local.js', 'config.example.js'];
  for (const name of names) walk(name);
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}
function receiptPath(root) { return path.resolve(root, git(root, ['rev-parse', '--git-path', 'bosun-helper/checks.json']).trim()); }
function runChecks(root, only) {
  const destination = receiptPath(root); fs.mkdirSync(path.dirname(destination), { recursive: true });
  let receipt = { version: 1, checks: [] };
  if (only) {
    if (!COMMANDS.includes(only)) throw new Error('Unknown check');
    try { const old = JSON.parse(fs.readFileSync(destination, 'utf8')); if (old.version === 1 && Array.isArray(old.checks)) receipt = old; } catch (_) {}
    receipt.checks = receipt.checks.filter(item => item.command !== only);
  }
  for (const command of only ? [only] : COMMANDS) {
    const before = fingerprint(root, command), startedAt = new Date().toISOString();
    // npm_execpath предоставляется командой `npm run verify`; запускаем Node напрямую, в том числе в Windows.
    if (!process.env.npm_execpath) throw new Error('Run via npm run verify.');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', command], { cwd: root, stdio: 'inherit' });
    receipt.checks.push({ command, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
      fingerprint: before, stable: before === fingerprint(root, command) });
    const temporary = `${destination}.tmp`; fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2)); fs.renameSync(temporary, destination);
  }
  return receipt.checks.every(item => item.exitCode === 0 && item.stable) ? 0 : 1;
}
function status(root) {
  const version = readJson(root, 'manifest.json').version, packageVersion = readJson(root, 'package.json').version;
  console.log(`Версия: ${safe(version)}${version === packageVersion ? '' : ' (расхождение с package.json)'}`);
  try {
    const active = parseRoadmap(fs.readFileSync(path.join(root, 'docs/ROADMAP.md'), 'utf8')).tasks.filter(t => t.section === 'В работе');
    console.log(`В работе: ${active.length}`); for (const task of active.slice(0, 5)) console.log(`  ${safe(task.title.replace(/\]\([^)]*\)/g, ']'))}`);
    if (active.length > 5) console.log('  … остальные задачи в локальном Roadmap');
  } catch (_) { console.log('Roadmap: недоступен или повреждён'); }
  const changes = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const rows = []; for (let i = 0; i < changes.length; i++) { rows.push(changes[i]); if (/^[RC]|^.[RC]/.test(changes[i])) i++; }
  console.log(`Git: ${rows.length} изменений`); for (const row of rows.slice(0, 12)) console.log(`  ${safe(row, 120)}`);
  if (rows.length > 12) console.log('  … вывод ограничен');
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath(root), 'utf8'));
    if (receipt.version !== 1 || !Array.isArray(receipt.checks) || !receipt.checks.length) throw new Error('Invalid receipt');
    console.log('Последние проверки (локальная запись npm run verify):');
    for (const command of COMMANDS) {
      const item = receipt.checks.find(c => c.command === command);
      if (!item || !Number.isFinite(Date.parse(item.finishedAt)) || Date.parse(item.finishedAt) > Date.now() + 5000 ||
          !Number.isInteger(item.exitCode) || item.exitCode < 0 || !/^[a-f0-9]{64}$/.test(item.fingerprint)) { console.log(`  ${command}: нет достоверной записи`); continue; }
      const current = item.stable === true && item.fingerprint === fingerprint(root, command);
      console.log(`  ${command}: ${item.exitCode === 0 ? 'PASS' : 'FAIL'}${current ? '' : ' (устарело/файлы изменялись)'} — ${new Date(item.finishedAt).toISOString()}`);
    }
  } catch (_) { console.log('Проверки: нет достоверной записи; запустите npm run verify'); }
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    const mode = process.argv[2];
    if (mode === 'status') status(root);
    else if (mode === 'check:docs') {
      const result = checkDocs(root); result.errors.slice(0, 15).forEach(e => console.error(e));
      if (result.errors.length) process.exitCode = 1;
      else console.log(`Documentation checks passed (${result.tasks.length} tasks, version ${result.version}).`);
    } else if (mode === 'verify') process.exitCode = runChecks(root, process.argv[3]);
    else throw new Error('Unknown project-tools mode.');
  } catch (_) { console.error('Project tools failed; check local files/Git. Raw values withheld.'); process.exitCode = 1; }
}
module.exports = { git, safe, parseRoadmap, checkDocs, fingerprint, status, runChecks, receiptPath };
