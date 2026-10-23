'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const BROWSER_CASES = ['A04', 'A12', 'A06'];
const REGRESSION_CASES = ['A19', 'A18', 'A05', 'A13'];
const BROWSER_FLAGS = [
  '--acknowledged-compact-regression', '--single-alert-age-expand-identity-regression',
  '--single-alert-age-inherited-child-regression', '--single-alert-age-visible-id-format-regression',
  '--single-alert-age-empty-section-regression', '--single-alert-age-source-regression',
  '--single-alert-age-subject-regression'
];
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const PRODUCT = /^(?:Chrome|HeadlessChrome|Chromium|Edg)\/(\d+\.\d+\.\d+\.\d+)$/;

function readSelectors(env = process.env) {
  const browserCase = env.BOSUN_HELPER_BROWSER_CASE || '';
  const regressionCase = env.BOSUN_HELPER_REGRESSION_CASE || '';
  if (browserCase && !BROWSER_CASES.includes(browserCase)) throw new Error('Неизвестный BOSUN_HELPER_BROWSER_CASE.');
  if (regressionCase && !REGRESSION_CASES.includes(regressionCase)) throw new Error('Неизвестный BOSUN_HELPER_REGRESSION_CASE.');
  return { browserCase, regressionCase };
}
function selection(command, env = process.env, argv = []) {
  const selected = readSelectors(env);
  let selectors = {};
  if (command === 'test:browser') {
    if (argv.some(flag => !BROWSER_FLAGS.includes(flag))) throw new Error('Неизвестный selector браузерной проверки.');
    if (argv.length > 1 || argv.length && selected.browserCase) throw new Error('Допустим только один browser selector.');
    selectors = { browserCase: selected.browserCase, flags: argv.slice() };
  } else if (command === 'test' || command === 'check') selectors = { regressionCase: selected.regressionCase };
  else if (command !== 'check:docs') throw new Error('Неизвестная команда проверки.');
  const partial = Boolean(selectors.browserCase || selectors.regressionCase || selectors.flags?.length);
  return { scope: partial ? 'partial' : 'full', selectors };
}
function resolveBrowser() {
  const lookup = command => {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return result.status === 0 ? result.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) : '';
  };
  const configured = String(process.env.BOSUN_HELPER_BROWSER || '').trim();
  if (configured) {
    const file = fs.existsSync(configured) ? configured : lookup(configured);
    if (!file) throw new Error('Настроенный браузер недоступен.');
    return file;
  }
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe')
  ] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(lookup).concat(['/usr/bin/google-chrome', '/usr/bin/chromium']);
  const found = candidates.find(file => file && fs.existsSync(file));
  if (!found) throw new Error('Браузер для проверки недоступен.');
  return found;
}
function browserIdentity(executable = resolveBrowser()) {
  const file = fs.realpathSync(executable), stat = fs.statSync(file);
  // В Windows --version может открыть обычное окно; читаем ресурс версии без запуска Chrome.
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:BOSUN_HELPER_VERSION_FILE).ProductVersion'], {
      env: { ...process.env, BOSUN_HELPER_VERSION_FILE: file }, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192
    })
    : spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
  const version = result.status === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] : '';
  if (!version) throw new Error('Не удалось определить версию браузера.');
  return { executable: file, version,
    signature: crypto.createHash('sha256').update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex') };
}
function checkContext(command, options = {}) {
  return { ...selection(command, options.env || process.env, options.argv || []),
    browser: command === 'test:browser' ? (options.browserIdentity || browserIdentity)(options.executable) : null };
}
function contextIdentity(context) {
  const { executable, version, signature } = context.browser || {};
  return { scope: context.scope, selectors: context.selectors,
    browser: context.browser ? { executable, version, signature } : null };
}
function validContext(command, context) {
  try {
    const expected = selection(command, {
      BOSUN_HELPER_BROWSER_CASE: context.selectors.browserCase,
      BOSUN_HELPER_REGRESSION_CASE: context.selectors.regressionCase
    }, context.selectors.flags || []);
    if (!isDeepStrictEqual(expected, { scope: context.scope, selectors: context.selectors })) return false;
    if (command !== 'test:browser') return context.browser === null;
    const b = context.browser;
    return typeof b.executable === 'string' && path.isAbsolute(b.executable) && b.executable.length <= 4096 &&
      VERSION.test(b.version) && /^[a-f0-9]{64}$/.test(b.signature) && PRODUCT.exec(b.product)?.[1] === b.version;
  } catch (_) { return false; }
}
function validateBrowserReport(expected, report) {
  if (!report || report.complete !== true || !validContext('test:browser', report) ||
      !isDeepStrictEqual(contextIdentity(expected), contextIdentity(report))) {
    throw new Error('Результат и версия фактического браузера не подтверждены.');
  }
  return { scope: report.scope, selectors: report.selectors, browser: report.browser };
}
function writeBrowserReport(context, product) {
  const report = { ...context, complete: true, browser: { ...context.browser, product } };
  validateBrowserReport(context, report);
  const file = process.env.BOSUN_HELPER_CHECK_REPORT;
  if (file) {
    const directory = path.dirname(path.resolve(file));
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) ||
        !path.basename(directory).startsWith('bosun-check-report-') || path.basename(file) !== 'result.json') {
      throw new Error('Недопустимый путь локального отчёта проверки.');
    }
    fs.writeFileSync(file, JSON.stringify(report));
  }
}
module.exports = { readSelectors, selection, browserIdentity, checkContext, contextIdentity, validContext, validateBrowserReport, writeBrowserReport };
