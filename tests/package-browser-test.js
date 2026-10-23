'use strict';

// Необязательная базовая проверка уже распакованного внутреннего ZIP в пустом профиле Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { collectRuntime } = require('../scripts/package-internal');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify() {
  const extensionPath = fs.realpathSync(process.argv[2] || '');
  const { files, manifest } = collectRuntime(extensionPath);
  assert.strictEqual(typeof WebSocket, 'function', 'Node.js with global WebSocket is required');
  const executable = process.env.BOSUN_HELPER_BROWSER || [
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ].find(file => fs.existsSync(file)) || 'chromium';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-package-browser-'));
  let socket, startupError, sequence = 0;
  const pending = new Map();
  const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  browser.on('error', error => { startupError = error; });
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const activePort = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(activePort); i++) {
      if (startupError || browser.exitCode != null || i > 150) throw new Error('Chrome startup failed');
      await delay(100);
    }
    const [port, endpoint] = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error('Chrome rejected extension/CDP operation'));
      else request.resolve(message.result);
    });
    const { id } = await command('Extensions.loadUnpacked', { path: extensionPath });
    assert.match(id, /^[a-p]{32}$/);
    const { targetId } = await command('Target.createTarget', { url: `chrome-extension://${id}/manifest.json` });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Runtime.enable', {}, sessionId);
    let verified = false;
    for (let attempt = 0; attempt < 30 && !verified; attempt++) {
      const response = await command('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `(async()=>{
          if(location.protocol!=='chrome-extension:')return false;
          const manifest=await (await fetch('/manifest.json')).json();
          if(manifest.version!==${JSON.stringify(manifest.version)})return false;
          const paths=${JSON.stringify([...files.keys()])};
          for(const file of paths){const response=await fetch('/'+file);if(!response.ok)return false;await response.arrayBuffer();}
          return true;
        })()` }, sessionId);
      verified = response.result?.value === true;
      if (!verified) await delay(100);
    }
    assert.ok(verified, 'Extracted runtime resources must load from the real extension origin');
    await command('Extensions.uninstall', { id });
    console.log(`Packaged extension Chrome load passed (${files.size} runtime/distribution files reachable)`);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { await command('Browser.close'); } catch (_) { /* Браузер может закрыться до ответа. */ }
    }
    socket?.close();
    for (const request of pending.values()) clearTimeout(request.timer);
    for (let attempt = 0; browser.exitCode == null && browser.signalCode == null && attempt < 50; attempt++) await delay(100);
    if (browser.exitCode == null && browser.signalCode == null) {
      browser.kill();
      for (let attempt = 0; browser.exitCode == null && browser.signalCode == null && attempt < 50; attempt++) await delay(100);
    }
    assert.ok(path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('bosun-helper-package-browser-'));
    for (let attempt = 0; attempt < 12; attempt++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 11) throw error; await delay(500); }
    }
  }
}

verify().catch(() => {
  // Не выводим ошибки Chrome, содержимое внутренних файлов расширения и адреса.
  console.error('Packaged extension Chrome load failed. Check Chrome support and the extracted runtime package.');
  process.exitCode = 1;
});
