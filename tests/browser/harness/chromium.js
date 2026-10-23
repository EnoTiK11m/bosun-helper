'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { checkContext } = require('../../../scripts/check-context');
const { CdpClient } = require('./cdp-client');
const { reservePort, startPageServer } = require('./page-server');

function executableFromCommand(command) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [command], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '';
}

function findBrowserExecutable() {
  const configured = String(process.env.BOSUN_HELPER_BROWSER || '').trim();
  if (configured) {
    const resolved = fs.existsSync(configured) ? configured : executableFromCommand(configured);
    if (resolved) return resolved;
    throw new Error(`BOSUN_HELPER_BROWSER does not resolve to an executable: ${configured}`);
  }

  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    : [
        executableFromCommand('google-chrome'),
        executableFromCommand('google-chrome-stable'),
        executableFromCommand('chromium'),
        executableFromCommand('chromium-browser'),
        '/usr/bin/google-chrome',
        '/usr/bin/chromium'
      ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Chrome/Chromium/Edge was not found. Install one or set BOSUN_HELPER_BROWSER to its executable.'
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTemporaryProfile(profileDirectory, options = {}) {
  const resolvedProfile = path.resolve(profileDirectory);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedProfile).startsWith('bosun-helper-browser-'),
    `Refusing to remove unexpected browser profile path: ${resolvedProfile}`
  );
  const remove = options.remove || ((target) => fs.promises.rm(target, {
    recursive: true,
    force: true
  }));
  const wait = options.wait || delay;
  const maxAttempts = options.maxAttempts || 12;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await remove(resolvedProfile);
      return;
    } catch (error) {
      lastError = error;
      if (!['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      if (attempt + 1 < maxAttempts) {
        await wait(Math.min(1000, 100 * (2 ** attempt)));
      }
    }
  }
  throw lastError || new Error('Temporary browser profile cleanup failed');
}

function waitForBrowserExit(browser, timeoutMs) {
  if (browser.exitCode != null || browser.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeoutId);
      resolve(true);
    };
    const timeoutId = setTimeout(() => {
      browser.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    browser.once('exit', onExit);
  });
}

async function waitForJson(url, browserProcess, stderr) {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (browserProcess.exitCode != null) {
      throw new Error(`Browser exited with code ${browserProcess.exitCode}: ${stderr.value.trim()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Browser debugging endpoint did not become ready: ${lastError?.message || 'timeout'}`);
}

async function withBrowserSession(run) {
  const executable = findBrowserExecutable();
  const context = checkContext('test:browser', { executable, argv: process.argv.slice(2) });
  const debugPort = await reservePort();
  const pagePort = await reservePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-browser-'));
  const pageServer = await startPageServer(pagePort);

  const stderr = { value: '' };
  const browser = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  browser.stderr.on('data', (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8000);
  });

  let client = null;
  try {
    const browserVersion = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, browser, stderr);
    const pageUrl = `http://127.0.0.1:${pagePort}/action?type=note`;
    const targetResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' }
    );
    assert.ok(targetResponse.ok, `Unable to create browser target: HTTP ${targetResponse.status}`);
    const target = await targetResponse.json();
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url: pageUrl });
    await loaded;
    await run({ client, executable, browserVersion, context });
  } finally {
    try {
      const closeRequest = client?.send('Browser.close').catch(() => undefined);
      if (closeRequest) await Promise.race([closeRequest, delay(3000)]);
    } catch (_) {}
    client?.close();
    let exited = await waitForBrowserExit(browser, 5000);
    if (!exited && browser.exitCode == null && browser.signalCode == null) {
      browser.kill();
      exited = await waitForBrowserExit(browser, 5000);
    }
    await new Promise((resolve) => pageServer.close(resolve));
    try {
      await removeTemporaryProfile(profileDirectory);
    } catch (error) {
      console.warn(`Temporary browser profile could not be removed: ${error.message}`);
    }
  }
}

module.exports = { withBrowserSession, removeTemporaryProfile };
