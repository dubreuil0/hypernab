// Real-browser check of "Add several links": an isolated server (own port, temporary data and download folders) and an isolated browser
// profile. Open the dialog, paste a messy text with a file link, a page link, a repeated link and words around them; the dialog counts the
// links, "Add for later" adds them without starting anything, the list shows them, and pasting the same ones again skips them.
// The links are real addresses of the project's own public repository (headers only are fetched; nothing is downloaded).
// Usage: node scripts/bulk-add-check.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromiumBrowser, firefoxBrowser, freePort } from './browser-driver.js';
import { buildExtensions } from './build-extensions.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-bulk-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FILE = 'https://codeload.github.com/dubreuil0/hypernab/zip/refs/heads/main', PAGE = 'https://github.com/dubreuil0/hypernab';

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_LOCALE: 'ja-JP', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 900);
    const ev = expr => browser.eval(tab, expr);
    await sleep(1500);
    // one engine serves both browsers: the second pass starts from an empty list (the first pass's links would all be \"already in the list\")
    await ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); const h = { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }; await fetch('/api/queue/bulk', { method: 'POST', headers: h, body: JSON.stringify({ action: 'cancel', all: true }) }); await fetch('/api/queue/clear', { method: 'POST', headers: h, body: '{}' }); })()`);
    await sleep(500);
    const jobs = () => ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); return (await fetch('/api/jobs', { headers: { Authorization: 'Bearer ' + b.token } }).then(r => r.json())).map(j => [j.status, j.engine, j.kind || '']); })()`);
    check(name, 'the "Add several links" button is there, with an icon', await ev(`(() => { const b = document.getElementById('open-bulk'); return Boolean(b && b.querySelector('svg') && b.getAttribute('aria-label') === 'Add several links'); })()`));
    await ev(`document.getElementById('open-bulk').click()`); await sleep(400);
    check(name, 'the dialog opens; nothing found yet; the buttons wait', await ev(`(() => { const d = document.getElementById('bulk-dialog'); return d.open && /No link found yet/.test(document.getElementById('bulk-count').textContent) && document.getElementById('bulk-now').disabled && document.getElementById('bulk-later').disabled; })()`));
    const text = `Look at this: ${FILE}, and also (${PAGE}). Again: ${FILE} — thanks!`;
    await ev(`(() => { const t = document.getElementById('bulk-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(300);
    check(name, 'it finds the 2 different links in the messy text and says so', /^2 links found/.test(await ev(`document.getElementById('bulk-count').textContent`)) && await ev(`!document.getElementById('bulk-later').disabled`));
    await browser.screenshot(tab, path.join(shots, `${name}-bulk-dialog.png`));
    await ev(`document.getElementById('bulk-later').click()`);
    let list = [];
    for (let n = 0; n < 60 && list.length < 2; n++) { await sleep(500); list = await jobs(); }
    check(name, 'added for later: a file job and a page job, both waiting, nothing started', list.length === 2 && list.every(item => item[0] === 'held') && list.some(item => item[2] === 'file') && list.some(item => item[1] === 'extractor'), JSON.stringify(list));
    check(name, 'the dialog is closed and the message says 2 links were added', await ev(`!document.getElementById('bulk-dialog').open && /2 links added/.test(document.getElementById('message').textContent)`), await ev(`document.getElementById('message').textContent`));
    check(name, 'no raw text key shows', !/app\.bulk|e\.add-/.test(await ev(`document.body.innerText`)));
    // the same links again: skipped, nothing added
    await ev(`document.getElementById('open-bulk').click()`); await sleep(300);
    await ev(`(() => { const t = document.getElementById('bulk-text'); t.value = ${JSON.stringify(FILE + '\n' + PAGE)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ev(`document.getElementById('bulk-later').click()`); await sleep(2500);
    check(name, 'the same links again: skipped, the list stays at 2', (await jobs()).length === 2 && /already in the list/.test(await ev(`document.getElementById('message').textContent`)), await ev(`document.getElementById('message').textContent`));
    await browser.screenshot(tab, path.join(shots, `${name}-bulk-result.png`));
  } catch (error) { check(name, 'finished without an exception', false, String(error?.stack || error)); }
  finally { await browser?.close(); }
}

try {
  if (wanted.includes('firefox')) { const builds = buildExtensions(path.join(dir, 'ext')); await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'ff-profile'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')))); }
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'chrome-profile'), []));
} finally { server.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: hata var');
process.exitCode = results.every(Boolean) ? 0 : 1;
