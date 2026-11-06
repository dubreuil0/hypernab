import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { freePort, browserUntil } from './browser-driver.js';
import { installNative } from './install-native.js';
import { NativeGateway, readNativeConfig } from '../src/native-host.js';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-desktop-'));
const port = await freePort(), debug = await freePort(), inspector = await freePort();
const exe = path.join(root, 'dist/win-unpacked/Hypernab.exe');
const env = { ...process.env, HYPERNAB_LOCALE: 'tr-TR', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads'), HD_DESKTOP_TEST: '1', HD_DESKTOP_PROFILE: path.join(dir, 'profile') };
const child = spawn(exe, ['--native-background', `--remote-debugging-port=${debug}`, `--inspect=${inspector}`], { env, stdio: 'ignore' });
const connections = [];
async function connect(url) {
  const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  connections.push(socket); let id = 0; const pending = new Map();
  socket.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
  return (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timeout')); }, 15000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); });
}
let call;
try {
  await browserUntil(() => fs.existsSync(path.join(dir, 'data/pairing-token')), 30000);
  const token = fs.readFileSync(path.join(dir, 'data/pairing-token'), 'utf8').trim();
  call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  const target = await browserUntil(async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith(`http://127.0.0.1:${port}`)), 30000);
  const rpc = await connect(target.webSocketDebuggerUrl);
  await rpc('Runtime.enable');
  const evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await browserUntil(() => evaluate('document.querySelector("#connection").textContent.includes("aktif")'));
  // A brand-new install: the one-time "add the browser extension" window (default-browser button only when Windows tells the kind, the two stores always).
  await browserUntil(() => evaluate(`document.getElementById('ext-welcome').open`), 20000);
  const defaultKind = await evaluate(`hypernabDesktop.action('default-browser')`);
  assert.ok([null, 'chromium', 'firefox'].includes(defaultKind), String(defaultKind));
  assert.equal(await evaluate(`!document.getElementById('ext-welcome-default').hidden`), defaultKind !== null, 'the default-browser button shows only when the kind is known');
  assert.deepEqual(await evaluate(`['ext-welcome-chromium', 'ext-welcome-firefox'].map(id => document.getElementById(id).textContent.trim())`), ['Chrome Web Store', 'Firefox Add-ons']);
  assert.match(await evaluate(`document.getElementById('ext-welcome-title').textContent`), /Tarayıcı eklentisini ekle/);
  assert.equal((await call('/api/settings')).extensionPromptDone, false, 'not answered yet');
  await evaluate(`document.getElementById('ext-welcome-chromium').click()`);
  await browserUntil(() => evaluate(`!document.getElementById('ext-welcome').open`));
  assert.match(await evaluate(`document.getElementById('settings-saved').textContent`), /Mağaza sayfası açıldı/, 'the store page was asked for (a test opens no real browser)');
  await browserUntil(async () => (await call('/api/settings')).extensionPromptDone === true, 10000);
  console.log('OK one-time extension window on a new install: shown, store button opens the store page, window closes and the answer is saved');
  const mainTarget = (await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0];
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  const mainEval = async expression => { const r = await main('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  const electron = 'process.mainModule.require("electron")';
  const visible = () => mainEval(`${electron}.BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('/tray.html')).isVisible()`);
  assert.equal((await call('/api/settings')).startMinimized, false);
  assert.equal(await visible(), false, 'Native indirme başlangıcı ayardan bağımsız tepside kalır');
  const silentSecond = spawn(exe, ['--native-background'], { env, stdio: 'ignore' });
  await new Promise((resolve, reject) => { silentSecond.on('error', reject); silentSecond.on('close', resolve); });
  assert.equal(await visible(), false, 'arka plan komutu mevcut pencereyi de öne getirmez');
  const registration = installNative({ directory: path.join(dir, 'native'), register: false, port, dataDirectory: env.HYPERNAB_DATA_DIR, downloadDirectory: env.HYPERNAB_DOWNLOAD_DIR, desktopExecutable: exe });
  const gateway = new NativeGateway(readNativeConfig(registration.configFile));
  const previousTest = process.env.HD_DESKTOP_TEST, previousProfile = process.env.HD_DESKTOP_PROFILE;
  try {
    process.env.HD_DESKTOP_TEST = '1'; process.env.HD_DESKTOP_PROFILE = env.HD_DESKTOP_PROFILE;
    await gateway.launch(false); assert.equal(await visible(), false);
    await gateway.launch(true); await browserUntil(visible);
  } finally {
    if (previousTest === undefined) delete process.env.HD_DESKTOP_TEST; else process.env.HD_DESKTOP_TEST = previousTest;
    if (previousProfile === undefined) delete process.env.HD_DESKTOP_PROFILE; else process.env.HD_DESKTOP_PROFILE = previousProfile;
  }
  console.log('OK background cold start with setting off, no focus steal and compiled Native show restores desktop');
  // Keep automated renderer checks visible even when Windows occludes the test window.
  await rpc('Emulation.setFocusEmulationEnabled', { enabled: true });
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('typeof hypernabDesktop.action'), 'function');
  assert.equal(await evaluate('document.querySelector("#desktop-settings").hidden'), false);
  await evaluate('document.querySelector("#open-settings").click()');
   await evaluate(`document.querySelector('a[href="#s-desktop"]').click()`);
  assert.equal(await evaluate('hypernabDesktop.settings().then(info => info.packaged)'), true);
  await evaluate('window.scrollTo(0,0)');
  assert.equal(await evaluate('document.querySelector("#view-downloads").hidden'), true);
   assert.equal(await evaluate('getComputedStyle(document.querySelector("#pause-all")).borderRadius'), '5px');
   assert.equal((await call('/api/settings')).appearance, 'compact');
   assert.equal(await evaluate('document.documentElement.dataset.appearance'), 'compact');
  assert.equal(await evaluate('document.querySelector("#pause-all use").getAttribute("href")'), '#i-pause');
  await evaluate('document.querySelector("#set-maxConnections").value="3"; document.querySelector("#set-maxConnections").dispatchEvent(new Event("change"))');
  await browserUntil(async () => (await call('/api/settings')).maxConnections === 3);
  await evaluate('document.querySelector("#set-maxQuality").value="720"; document.querySelector("#set-maxQuality").dispatchEvent(new Event("change"))');
  await browserUntil(async () => (await call('/api/settings')).maxQuality === 720);
  await browserUntil(() => evaluate('document.querySelector("#settings-saved").textContent === "Kaydedildi."'));
  const settingsShot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'settings.png'), Buffer.from(settingsShot.data, 'base64'));
  await evaluate('document.querySelector("#close-settings").click()');
  console.log('OK settings view, real SVG pause icon and persisted quality/connection preferences');
  console.log('OK desktop UI, sandbox and preload');
  await evaluate('document.querySelector("#new-queue-name").value="Smoke"; document.querySelector("#new-queue").click()');
  await browserUntil(async () => (await call('/api/settings')).selectedQueue === 'Smoke');
  await evaluate('document.querySelector("#speed-limit-mb").value="0.5"; document.querySelector("#save-speed").click()');
  await browserUntil(async () => (await call('/api/settings')).speedLimitKiB === 512);
  await evaluate('document.querySelector("#url").value="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"; document.querySelector("#engine").value="direct"; document.querySelector("#download-form").requestSubmit()');
  await browserUntil(() => evaluate('!document.querySelector("#preview").hidden'), 30000);
  await evaluate('document.querySelector("#queue-download").click()');
  await browserUntil(async () => (await call('/api/jobs'))[0]?.status === 'held');
  assert.equal((await call('/api/jobs'))[0].queueName, 'Smoke');
  await call('/api/automation', { schedule: { at: Date.now() + 1200, queue: 'Smoke' } });
  await browserUntil(async () => (await call('/api/jobs'))[0]?.status === 'completed', 90000);
  const job = (await call('/api/jobs'))[0];
  assert.equal(job.speedLimitKiB, 512);
  assert.equal(fs.statSync(path.join(dir, 'downloads', job.file)).size, 1128375);
  assert.ok(job.recovery.some(item => item.event === 'transfer-observed' && Number.isFinite(item.elapsedMs)));
  assert.doesNotMatch(JSON.stringify(job.recovery), /https?:|cookie|referer|signature/i);
  console.log('OK named queue, speed setting, schedule and verified real download');
  // Hidden/minimised renderers intentionally stop polling. Restore this isolated test window.
  await mainEval(`(()=>{const w=${electron}.BrowserWindow.getAllWindows()[0];w.restore();w.show();w.focus();return true})()`);
  try { await browserUntil(() => evaluate(`!!document.querySelector('[data-job-id="${job.id}"] .job-state.completed')`)); }
  catch (error) {
    console.log('UI diagnostic:', await evaluate(`JSON.stringify({hidden:document.hidden,connection:document.querySelector('#connection').textContent,message:document.querySelector('#message').textContent,rows:document.querySelector('#jobs').innerText})`));
    throw error;
  }
  const compactHeight = await evaluate(`document.querySelector('[data-job-id="${job.id}"]').getBoundingClientRect().height`);
  await evaluate(`document.querySelector('[data-job-id="${job.id}"]').scrollIntoView({block:'center'})`);
  const compactShot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'compact.png'), Buffer.from(compactShot.data, 'base64'));
  await call('/api/settings', { appearance: 'normal' });
  await browserUntil(() => evaluate('document.documentElement.dataset.appearance === "normal"'));
  const normalHeight = await evaluate(`document.querySelector('[data-job-id="${job.id}"]').getBoundingClientRect().height`);
  assert.ok(compactHeight < normalHeight, `compact=${compactHeight}, normal=${normalHeight}`);
  const normalShot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'normal.png'), Buffer.from(normalShot.data, 'base64'));
  // Actual settings controls, not just an API update: strings must not be converted to Number/NaN.
  await evaluate('document.querySelector("#open-settings").click();document.querySelector("#set-appearance").value="compact";document.querySelector("#set-appearance").dispatchEvent(new Event("change"))');
  await browserUntil(() => evaluate('document.documentElement.dataset.appearance === "compact"'));
  await evaluate('document.querySelector("#set-textSize").value="large";document.querySelector("#set-textSize").dispatchEvent(new Event("change"))');
  await browserUntil(async () => (await call('/api/settings')).textSize === 'large');
  await evaluate('document.querySelector("#set-textSize").value="normal";document.querySelector("#set-textSize").dispatchEvent(new Event("change"))');
  await browserUntil(async () => (await call('/api/settings')).textSize === 'normal');
  await evaluate('document.querySelector("#close-settings").click()');
  await browserUntil(() => evaluate(`!!document.querySelector('[data-job-action="${job.id}-details"]')`));
  await evaluate(`document.querySelector('[data-job-action="${job.id}-details"]').click();document.querySelector('[data-job-action="${job.id}-details"]').focus()`);
  await wait(2100);
  assert.equal(await evaluate(`document.querySelector('[data-job-action="${job.id}-details"]').getAttribute('aria-expanded')`), 'true');
  assert.equal(await evaluate(`document.activeElement.dataset.jobAction`), `${job.id}-details`);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('details-${job.id}')).display`), 'block');
  assert.equal(await evaluate(`document.getElementById('details-${job.id}').textContent.includes('İlk aktarım ölçümü')`), true);
  await evaluate(`document.querySelector('[data-job-action="${job.id}-details"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('details-${job.id}')).display`), 'none');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('button.btn')].filter(b=>!b.querySelector('svg')).map(b=>b.id)`), []);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('use')].map(u=>u.getAttribute('href')).filter(h=>h?.startsWith('#')&&!document.getElementById(h.slice(1)))`), []);
  assert.equal(await evaluate(`document.querySelectorAll('#i-pause rect').length`), 2);
  console.log(`OK default compact, both views, real settings controls, persistent details/focus, all action SVGs (row ${compactHeight}px vs ${normalHeight}px)`);
  // Stub ONLY Explorer side effects in this isolated Electron instance; exercise the real renderer -> IPC -> engine lookup.
  await mainEval(`globalThis.__locationCalls=[];globalThis.__locationShell={open:${electron}.shell.openPath,select:${electron}.shell.showItemInFolder};${electron}.shell.openPath=async p=>{globalThis.__locationCalls.push(['open',p]);return ''};${electron}.shell.showItemInFolder=p=>{globalThis.__locationCalls.push(['select',p])}`);
  await browserUntil(() => evaluate(`!!document.querySelector('[data-job-location="${job.id}"]')`));
  assert.equal(await evaluate(`document.querySelector('[data-job-location="${job.id}"] use').getAttribute('href')`), '#i-folder');
  await evaluate(`document.querySelector('[data-job-location="${job.id}"]').click()`);
  await browserUntil(async () => (await mainEval('globalThis.__locationCalls.length')) === 1);
  assert.deepEqual(await mainEval('globalThis.__locationCalls[0]'), ['select', path.join(dir, 'downloads', job.file)]);
  assert.equal(await evaluate(`hypernabDesktop.action('job-location','../secret').then(()=>false,()=>true)`), true);
  // Exercise real play IPC; stub only the final OS/player launch in this isolated app.
  await evaluate(`document.querySelector('[data-job-action="${job.id}-play"]').click()`);
  await browserUntil(async () => (await mainEval('globalThis.__locationCalls.length')) === 2);
  assert.deepEqual(await mainEval('globalThis.__locationCalls[1]'), ['open', path.join(dir, 'downloads', job.file)]);
  await evaluate(`document.querySelector('#open-history').click()`);
  await browserUntil(() => evaluate(`!!document.querySelector('[data-history-play="${job.id}"]')`));
  await evaluate(`document.querySelector('[data-history-play="${job.id}"]').click()`);
  await browserUntil(async () => (await mainEval('globalThis.__locationCalls.length')) === 3);
  assert.deepEqual(await mainEval('globalThis.__locationCalls[2]'), ['open', path.join(dir, 'downloads', job.file)]);
  await evaluate(`document.querySelector('[data-history-location="${job.id}"]').click()`);
  await browserUntil(async () => (await mainEval('globalThis.__locationCalls.length')) === 4);
  assert.deepEqual(await mainEval('globalThis.__locationCalls[3]'), ['select', path.join(dir, 'downloads', job.file)]);
  await evaluate(`document.querySelector('#close-history').click()`);
  await mainEval('globalThis.__locationCalls.splice(1)');
  console.log('OK completed queue and history play use real renderer -> IPC -> engine lookup; OS launch stubbed only');
  // Optional clipboard offer (off by default): real clipboard, real window focus event, real renderer strip and dialog.
  const focusWindow = () => mainEval(`(()=>{const w=${electron}.BrowserWindow.getAllWindows().find(x=>!x.webContents.getURL().endsWith('/tray.html'));w.emit('focus');return true})()`);
  const strip = () => evaluate(`(()=>{const b=document.getElementById('clip-banner');return b.hidden?null:document.getElementById('clip-text').textContent})()`);
  assert.equal((await call('/api/settings')).watchClipboard, false, 'the clipboard offer is off by default');
  await mainEval(`${electron}.clipboard.writeText('Bak: https://example.org/clip-a')`); await focusWindow(); await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await strip(), null, 'off: the clipboard is not looked at, nothing is offered');
  await evaluate(`document.querySelector('#set-watchClipboard').click()`);
  await browserUntil(async () => (await call('/api/settings')).watchClipboard === true);
  await browserUntil(() => mainEval('globalThis.__hypernabTestWatching()')); // the desktop shell has taken the new setting
  await focusWindow();
  await browserUntil(async () => Boolean(await strip())).catch(async error => { throw new Error(`no strip: offered=${JSON.stringify(await mainEval('globalThis.__hypernabTestOffered()'))} bridge=${await evaluate('typeof globalThis.hypernabDesktop?.onClipboard')} clip=${JSON.stringify(await mainEval('Promise.resolve(' + electron + '.clipboard.readText()).then(String)'))}`); });
  assert.match(await strip(), /example\.org/, 'on: one link in the clipboard is offered with its site');
  await evaluate(`document.querySelector('#clip-dismiss').click()`); await focusWindow(); await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await strip(), null, 'the same clipboard text is not offered again');
  await mainEval(`${electron}.clipboard.writeText('https://example.org/one\\nhttps://example.net/two')`); await focusWindow(); await browserUntil(async () => Boolean(await strip()));
  assert.match(await strip(), /2/, 'two links: the strip says how many');
  await evaluate(`document.querySelector('#clip-add').click()`);
  assert.equal(await evaluate(`document.getElementById('bulk-dialog').open && document.getElementById('bulk-text').value`), 'https://example.org/one\nhttps://example.net/two', 'Add opens the several-links dialog, filled in');
  await evaluate(`document.querySelector('#bulk-cancel').click()`);
  await evaluate(`document.querySelector('#set-watchClipboard').click()`); await browserUntil(async () => (await call('/api/settings')).watchClipboard === false);
  await mainEval(`${electron}.clipboard.writeText('')`);
  console.log('OK clipboard offer: off by default, strip on focus with the link\'s site, once per text, Add fills the several-links dialog');
  // Settings: the extension is one compact row at the very top; the old manual setup is gone; the mark turns green when the extension reaches the app.
  await evaluate('document.querySelector("#open-settings").click()');
  await browserUntil(() => evaluate(`document.getElementById('ext-row') !== null && document.getElementById('ext-row').offsetParent !== null`));
  assert.equal(await evaluate(`document.querySelector('.settings-body').firstElementChild.id`), 's-extension', 'the extension row heads Settings');
  assert.equal(await evaluate(`document.querySelector('#s-browser, #extension-help, .ext-wizard') === null && !document.querySelector('.settings-nav a[href="#s-browser"]')`), true, 'no old manual setup');
  assert.equal(await evaluate(`document.getElementById('ext-state').className.includes('ok')`), false, 'not connected yet');
  assert.match(await evaluate(`document.getElementById('ext-state').textContent`), /Bağlı değil/);
  assert.equal(await evaluate(`!document.getElementById('ext-stores').hidden && !document.getElementById('ext-problem').hidden`), true, 'not connected: store buttons and the connection help show');
  assert.equal(await evaluate(`!document.getElementById('desktop-settings').hidden`), true, 'the repair button is in the connection help (desktop app)');
  const rowHeight = await evaluate(`document.getElementById('ext-row').getBoundingClientRect().height`);
  assert.ok(rowHeight < 80, `the row stays one compact line (${rowHeight}px)`);
  await fetch(`http://127.0.0.1:${port}/api/prefs`, { headers: { Authorization: `Bearer ${token}`, 'X-Hypernab-Client': 'extension' } }); // what the extension's native host does
  await browserUntil(() => evaluate(`document.getElementById('ext-state').className.includes('ok')`), 15000);
  assert.match(await evaluate(`document.getElementById('ext-state').textContent`), /Bağlı$/);
  assert.equal(await evaluate(`!document.getElementById('ext-stores').hidden && document.getElementById('ext-problem').hidden`), true, 'connected: the green mark shows, the store buttons stay (another browser may be wanted), the connection help goes');
  await evaluate('document.querySelector("#close-settings").click()');
  console.log('OK Settings extension row: first, compact, no manual setup, store buttons always, green mark when the extension talks to the app');
  // Real pointer input, not a synthetic reorder API call: hold the handle across a poll cycle and drop it.
  await call('/api/settings', { queueLimit: 1, speedLimitKiB: 16 });
  const ids = [];
  for (const title of ['Priority A', 'Priority B', 'Priority C']) ids.push((await call('/api/jobs', { url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', title, engine: 'direct' })).id);
  await browserUntil(() => evaluate(`document.querySelectorAll('.reorder-handle').length === 4`));
  const runningBeforeView = (await call('/api/jobs')).filter(j => j.status === 'running').map(j => j.id);
  await evaluate(`document.querySelector('[data-job-select="${ids[0]}"]').click()`);
  for (const appearance of ['normal', 'compact']) {
    await call('/api/settings', { appearance });
    await browserUntil(() => evaluate(`document.documentElement.dataset.appearance === '${appearance}'`));
    assert.deepEqual((await call('/api/jobs')).filter(j => j.status === 'running').map(j => j.id), runningBeforeView);
    assert.equal(await evaluate(`document.querySelector('[data-job-select="${ids[0]}"]').checked`), true);
  }
  await evaluate(`document.querySelector('[data-job-select="${ids[0]}"]').click()`);
  await call('/api/settings', { downloadDirectory: path.join(dir, 'new-downloads') });
  await evaluate(`document.querySelector('[data-job-location="${ids[0]}"]').click()`);
  await browserUntil(async () => (await mainEval('globalThis.__locationCalls.length')) === 2);
  assert.deepEqual(await mainEval('globalThis.__locationCalls[1]'), ['open', path.join(dir, 'downloads')]);
  await mainEval(`${electron}.shell.openPath=globalThis.__locationShell.open;${electron}.shell.showItemInFolder=globalThis.__locationShell.select`);
  console.log('OK per-job folder SVG, completed file selection, active original folder after settings change and rejected arbitrary path');
  await browserUntil(async () => (await call('/api/jobs')).find(job => job.id === ids[0])?.received > 0);
  const coords = await evaluate(`(() => {
    const from = document.querySelector('[data-job-move="${ids[1]}"]'); from.scrollIntoView({block:'center'});
    const a = from.getBoundingClientRect(), b = document.querySelector('[data-job-id="${ids[0]}"]').getBoundingClientRect();
    return {x:a.x+a.width/2, y:a.y+a.height/2, target:b.top+8};
  })()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y - 10, button: 'left', buttons: 1 });
  await wait(1700);
  assert.equal(await evaluate('document.body.classList.contains("reordering")'), true);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.target, button: 'left', buttons: 1 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.target, button: 'left', clickCount: 1 });
  await browserUntil(async () => (await call('/api/jobs'))[1]?.id === ids[1]);
  await browserUntil(async () => {
    const jobs = await call('/api/jobs'); return jobs.find(job => job.id === ids[1])?.status === 'running' && jobs.find(job => job.id === ids[0])?.status === 'queued' && jobs.filter(job => job.status === 'running').length === 1;
  });
  await call('/api/queue/bulk', { action: 'pause', all: true });
  await browserUntil(async () => !(await call('/api/jobs')).some(job => job.settling));
  await browserUntil(() => evaluate('!document.querySelector("#resume-all").disabled'));
  await evaluate('document.querySelector("#resume-all").click()');
  await browserUntil(async () => (await call('/api/jobs')).filter(job => job.status === 'running').length === 1);
  assert.equal((await call('/api/jobs')).find(job => job.status === 'running').id, ids[1]);
  // Keyboard equivalent moves B down one slot, restoring A's priority and preempting B.
  await browserUntil(() => evaluate(`!!document.querySelector('[data-job-move="${ids[1]}"]:not(:disabled)')`));
  await evaluate(`document.querySelector('[data-job-move="${ids[1]}"]').focus()`);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await browserUntil(async () => (await call('/api/jobs'))[1]?.id === ids[0]);
  await browserUntil(async () => (await call('/api/jobs')).find(job => job.id === ids[0])?.status === 'running');
  await call('/api/queue/bulk', { action: 'pause', all: true });
  await browserUntil(async () => !(await call('/api/jobs')).some(job => job.settling));
  console.log('OK real drag across refresh, immediate safe priority switch, global Resume all limit and keyboard reorder');
  const long = await call('/api/jobs', { url: 'https://example.org/long.mp4', engine: 'direct', start: 'queue', title: 'Uzun Türkçe dosya adı — Görüntü, ses ve öğretici belgesel '.repeat(5) });
  await browserUntil(() => evaluate(`!!document.querySelector('[data-job-id="${long.id}"]')`));
  await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].setSize(720,820)`);
  for (const appearance of ['compact','normal']) for (const size of ['small','normal','large']) for (const zoom of [1,1.25,1.5,2]) {
    await call('/api/settings', { appearance, textSize: size });
    await browserUntil(() => evaluate(`document.documentElement.dataset.textSize === '${size}' && document.documentElement.dataset.appearance === '${appearance}'`));
    await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(${zoom})`);
    await wait(150);
    const layout = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,bad:[...document.querySelectorAll('.job-actions .btn')].some(b=>{const r=b.getBoundingClientRect();return !!(r.width||r.height)&&(r.width<24||r.height<24||r.right>innerWidth+1)}),overlap:[...document.querySelectorAll('.job-top')].some(top=>{const rs=[...top.children].map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);return rs.some((a,i)=>rs.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1))})})`);
    assert.ok(layout.scroll <= layout.width + 1 && !layout.bad && !layout.overlap, JSON.stringify({appearance,size,zoom,...layout}));
  }
  await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);${electron}.BrowserWindow.getAllWindows()[0].setSize(1120,820)`);
  await call('/api/settings', { appearance: 'compact', textSize: 'normal' });
  await browserUntil(() => evaluate('document.documentElement.dataset.textSize === "normal" && document.documentElement.dataset.appearance === "compact"'));
  console.log('OK both modes at 720px, three text sizes and 100/125/150/200% scaling without horizontal overflow, overlaps or tiny action targets');
  const shot = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'desktop.png'), Buffer.from(shot.data, 'base64'));
  // Native tray click -> lazy, sandboxed quick panel, without opening the main window.
  await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].hide();globalThis.__hypernabTestTray.emit('click')`);
  const panelTarget = await browserUntil(async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(item => item.type === 'page' && item.url.endsWith('/tray.html')));
  const panelRpc = await connect(panelTarget.webSocketDebuggerUrl);
  const panelEval = async expression => {
    const result = await panelRpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await panelRpc('Emulation.setFocusEmulationEnabled', { enabled: true });
  await browserUntil(() => panelEval(`document.querySelector('#tray-counts')?.textContent.includes('duraklatılmış')`));
  assert.equal(await visible(), false);
  assert.equal(await panelEval('typeof require'), 'undefined'); assert.equal(await panelEval('typeof hypernabDesktop'), 'undefined');
  assert.equal(await panelEval('typeof hypernabTray.command'), 'function');
  assert.equal(await panelEval(`document.querySelectorAll('.tray-row').length <= 5 && [...document.querySelectorAll('button')].every(button=>button.querySelector('svg'))`), true);
  await panelEval(`document.querySelector('#tray-resume').click()`);
  await browserUntil(async () => (await call('/api/jobs')).filter(job => job.status === 'running').length === 1);
  assert.equal((await call('/api/jobs')).find(job => job.id === long.id).status, 'held');
  await browserUntil(() => panelEval(`!document.querySelector('#tray-pause').disabled`));
  await panelEval(`document.querySelector('#tray-pause').click()`);
  await browserUntil(async () => !(await call('/api/jobs')).some(job => ['running','queued'].includes(job.status) || job.settling));
  await browserUntil(() => panelEval(`!document.querySelector('#tray-resume').disabled`));
  const singleTrayId = await panelEval(`document.querySelector('[data-tray-job]').dataset.trayJob`);
  await panelEval(`document.querySelector('[data-tray-job="${singleTrayId}"]').click()`);
  await browserUntil(async () => (await call('/api/jobs')).find(job => job.id === singleTrayId)?.status === 'running');
  await browserUntil(() => panelEval(`document.querySelector('[data-tray-job="${singleTrayId}"] use')?.getAttribute('href')==='#i-pause' && !document.querySelector('[data-tray-job="${singleTrayId}"]').disabled`));
  await panelEval(`document.querySelector('[data-tray-job="${singleTrayId}"]').click()`);
  await browserUntil(async () => !(await call('/api/jobs')).some(job => ['running','queued'].includes(job.status) || job.settling));
  for (const [theme, accent, textSize] of [['light','blue','large'],['dark','green','normal']]) {
    await call('/api/settings', { theme, accent, textSize });
    await evaluate(`hypernabDesktop.action('settings-changed')`);
    await browserUntil(() => panelEval(`document.documentElement.dataset.scheme==='${theme}' && document.documentElement.dataset.accent==='${accent}' && document.documentElement.dataset.textSize==='${textSize}'`));
    assert.equal(await panelEval(`document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('*')].every(e=>getComputedStyle(e).backdropFilter==='none')`), true);
  }
  const panelShot = await panelRpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'tray-panel.png'), Buffer.from(panelShot.data, 'base64'));
  // Disconnect never leaves stale speed or clickable transfer commands on screen.
  await mainEval(`${electron}.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/tray.html')).webContents.send('tray:state',{connected:false})`);
  assert.equal(await panelEval(`document.querySelector('#tray-speed').textContent === '—' && document.querySelector('#tray-resume').disabled && document.querySelector('#tray-pause').disabled`), true);
  await panelEval(`hypernabTray.command('refresh')`);
  await browserUntil(() => panelEval(`document.querySelector('#tray-counts').textContent.includes('duraklatılmış')`));
  await panelEval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await browserUntil(() => mainEval(`${electron}.BrowserWindow.getAllWindows().length===1`));
  await mainEval(`globalThis.__hypernabTestTray.emit('click')`);
  await browserUntil(() => mainEval(`${electron}.BrowserWindow.getAllWindows().length===2`));
  await mainEval(`globalThis.__hypernabTestTray.emit('double-click')`);
  await browserUntil(visible);
  assert.equal(await mainEval(`${electron}.BrowserWindow.getAllWindows().length`), 1);
  console.log('OK native tray panel: lazy renderer, sandbox, shared pause/resume, held queue preserved, disconnect, Escape and double-click');
  const before = (await call('/api/status')).processId;
  await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].close()`);
  assert.equal(await mainEval(`${electron}.BrowserWindow.getAllWindows()[0].isVisible()`), false);
  assert.equal((await call('/api/status')).processId, before);
  const second = spawn(exe, [], { env, stdio: 'ignore' });
  await new Promise((resolve, reject) => { second.on('error', reject); second.on('close', resolve); });
  await browserUntil(() => mainEval(`${electron}.BrowserWindow.getAllWindows()[0].isVisible()`));
  assert.equal((await call('/api/status')).processId, before);
  console.log('OK close-to-tray, reopen and single engine');
  await mainEval(`${electron}.app.quit()`);
  for (const socket of connections) socket.close(); // Node inspector holds process exit until the debugger detaches.
  await browserUntil(() => child.exitCode !== null, 20000);
  await browserUntil(async () => !await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false));
  console.log('OK graceful exit; screenshot: ' + path.join(dir, 'desktop.png'));
  const windowState = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'window-state.json'), 'utf8'));
  assert.ok(windowState.width >= 720 && windowState.height >= 520 && Number.isInteger(windowState.x), JSON.stringify(windowState));
  console.log(`OK window size/position remembered (${windowState.width}x${windowState.height})`);
  const reopened = spawn(exe, ['--native-background', `--remote-debugging-port=${debug}`], { env, stdio: 'ignore' });
  try {
    await browserUntil(async () => await call('/api/status').catch(() => null), 30000);
    const persisted = await call('/api/settings'); assert.equal(persisted.appearance, 'compact'); assert.equal(persisted.textSize, 'normal');
    assert.equal((await call('/api/jobs')).length, 5);
    const historyBefore = await call('/api/history');
    assert.ok(historyBefore.entries.some(entry => entry.id === job.id));
    await call('/api/queue/clear', { ids: [job.id] });
    assert.ok(!(await call('/api/jobs')).some(entry => entry.id === job.id));
    assert.ok((await call('/api/history')).entries.some(entry => entry.id === job.id));
    assert.equal(fs.statSync(path.join(dir, 'downloads', job.file)).size, 1128375);
    console.log('OK history survives packaged restart and queue clear while downloaded bytes remain untouched');
    const reopenedPage = await browserUntil(async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(p => p.type === 'page' && p.url.startsWith(`http://127.0.0.1:${port}`)), 30000);
    const reopenedRpc = await connect(reopenedPage.webSocketDebuggerUrl);
    await browserUntil(async () => (await reopenedRpc('Runtime.evaluate', { expression: 'document.readyState === "complete" && document.querySelector("#connection")?.textContent.includes("aktif")', returnByValue: true })).result.value);
    await wait(4500); // longer than the moment a new install waits before it would show the window
    assert.equal(await reopenedRpc('Runtime.evaluate', { expression: "document.getElementById('ext-welcome').open", returnByValue: true }).then(r => r.result.value), false, 'the one-time window never comes back');
    for (const socket of connections) socket.close();
    const status = await call('/api/status'); await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
    await browserUntil(() => reopened.exitCode !== null, 20000);
    console.log('OK real packaged restart retains appearance, text size and existing jobs');
  } finally {
    if (reopened.exitCode === null) {
      try { const status = await call('/api/status'); await call('/api/queue/bulk', { action: 'pause', all: true }); await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId }); } catch {}
      reopened.kill();
    }
  }
} finally {
  for (const socket of connections) socket.close();
  if (child.exitCode === null) {
    try { const status = await call('/api/status'); await call('/api/queue/bulk', { action: 'pause', all: true }); await wait(1500); await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId }); } catch {}
    child.kill();
  }
  console.log('Test directory: ' + dir);
}
