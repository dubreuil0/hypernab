// Real Firefox / Chrome (isolated temporary profiles, the built extension): the capture switch and the new settings page.
// A local page with a looping muted video; the on-page button must appear, vanish when capture is switched off (the same storage value a
// click on the toolbar icon writes), stay away after a reload, and come back when switched on. The settings page is opened and driven.
// Usage: node scripts/switch-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil } from './browser-driver.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-switch-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const video = path.join(dir, 'v.mp4');
const made = spawnSync(path.join(root, 'tools', 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
if (made.status !== 0) throw new Error(String(made.stderr));
const bytes = fs.readFileSync(video);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v.mp4')) {
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) { const start = Number(range[1] || 0), end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1); res.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 }); res.end(bytes.subarray(start, end + 1)); return; }
    res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': bytes.length }); res.end(bytes); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#ddd"><div style="position:absolute;left:100px;top:140px"><video id="v" src="/v.mp4" autoplay muted loop playsinline width="640" height="360"></video></div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const page = `http://127.0.0.1:${server.address().port}/`;

const chromiumKey = JSON.parse(fs.readFileSync(path.join(root, 'extension/chromium-key.json'), 'utf8')).key;
const chromiumId = createHash('sha256').update(Buffer.from(chromiumKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const OVERLAYS = `[...document.body.children].filter(node => node.style && node.style.zIndex === '2147483647').length`;

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const optionsUrl = (browser.extensionUrl || `chrome-extension://${chromiumId}/`) + 'options.html';
    const options = await browser.create(optionsUrl);
    await browser.navigate(options, optionsUrl); await sleep(800);
    const api = browser.extensionUrl ? 'browser' : 'chrome';
    const stored = key => browser.eval(options, `${api}.storage.local.get(${JSON.stringify(key)}).then(v => v[${JSON.stringify(key)}])`);
    const store = values => browser.eval(options, `${api}.storage.local.set(${JSON.stringify(values)}).then(() => true)`);
    const tab = await browser.create(page); await browser.navigate(tab, page);
    if (browser.viewport) await browser.viewport(tab, 1100, 700);
    const overlays = () => browser.eval(tab, OVERLAYS);
    const until = (fn, ms = 15000) => browserUntil(fn, ms).then(() => true, () => false);

    check(name, 'the on-page button appears while capture is on (the default)', await until(async () => (await overlays()) === 1));
    await store({ captureEnabled: false });
    check(name, 'switching capture off (the toolbar click\'s stored value) removes the button at once', await until(async () => (await overlays()) === 0, 8000));
    check(name, 'the toolbar tooltip says capture is off', await until(async () => /kapalı|off/i.test(await browser.eval(options, `${api}.action.getTitle({}).then(t => t || '')`)), 6000));
    const iconError = await browser.eval(options, `${api}.action.setIcon({ path: { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' } }).then(() => '', e => String(e && e.message || e))`);
    check(name, 'the grey slashed icon files ship in the package and the browser accepts them', iconError === '', iconError);
    await browser.navigate(tab, page); await sleep(6000);
    check(name, 'after a reload it stays away while capture is off', (await overlays()) === 0);
    await store({ captureEnabled: true });
    check(name, 'switching capture on brings the button back', await until(async () => (await overlays()) === 1, 12000));

    // the settings page
    await browser.navigate(options, optionsUrl); await sleep(1200);
    const ui = await browser.eval(options, `(() => ({ nativeSelects: document.querySelectorAll('select').length, dsLists: document.querySelectorAll('.hd-select').length, switches: document.querySelectorAll('.hd-switch').length, unresolved: [...document.querySelectorAll('[data-t]')].filter(n => !n.textContent || /^(opt|ctl|panel)\\./.test(n.textContent)).length, title: document.querySelector('h1').textContent, conn: document.getElementById('conn-state').textContent, remembered: document.getElementById('remembered').textContent }))()`);
    check(name, 'settings page: design-system lists and switches, no native <select>, every text resolved', ui.nativeSelects === 0 && ui.dsLists === 2 && ui.switches === 2 && ui.unresolved === 0, JSON.stringify(ui));
    check(name, 'settings page: it says what the connection to the app is', ui.conn.length > 5);
    await browser.eval(options, `document.querySelectorAll('.hd-switch')[0].click()`); await sleep(400);
    check(name, 'the capture switch on the page writes the same stored value', (await stored('captureEnabled')) === false);
    await browser.eval(options, `document.querySelectorAll('.hd-switch')[0].click()`); await sleep(400);
    check(name, '...and flips back', (await stored('captureEnabled')) === true);
    await browser.eval(options, `document.querySelectorAll('.hd-switch')[1].click()`); await sleep(600);
    check(name, 'the file-download switch stores the takeover setting', (await stored('takeover'))?.enabled === false, JSON.stringify(await stored('takeover')));
    await browser.eval(options, `document.querySelectorAll('.hd-switch')[1].click()`); await sleep(400);
    await browser.eval(options, `document.querySelectorAll('.hd-select-btn')[0].click()`); await sleep(200);
    await browser.eval(options, `[...document.querySelectorAll('.hd-select[data-open="true"] .hd-opt')].find(o => /10 MB/.test(o.textContent)).click()`); await sleep(600);
    check(name, 'choosing a smallest size stores it', (await stored('takeover'))?.minBytes === 10485760, JSON.stringify(await stored('takeover')));
    await browser.screenshot(options, path.join(shots, `options-${name}.png`));
  } catch (error) { check(name, 'run', false, error.message); }
  finally { await browser?.close(); }
}

const builds = buildExtensions(path.join(dir, 'ext'));
if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), [builds.chromium]));
server.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${results.filter(Boolean).length}/${results.length} geçti`);
process.exit(results.every(Boolean) ? 0 : 1);
