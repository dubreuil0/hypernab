// Real-browser check of the app window's interface language: an isolated server (own port, temporary data and download folders, a German
// Windows locale = no German texts = English) and an isolated browser profile. English first; choosing Turkish saves it, reloads the
// window once and every text follows; no raw text key may show anywhere. Usage: node scripts/ui-language-check.js [firefox] [chrome]
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
const dir = fs.mkdtempSync(path.join(base, 'hypernab-ui-lang-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_LOCALE: 'de-DE', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }

const LEAK = String.raw`(() => { const keys = new Set(); const walk = root => { for (const node of root.querySelectorAll('*')) { const own = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' '); if (/^(app|panel|lang|sub|job|ext|opt|prompt|ctl)\.[\w.-]+$/.test(own)) keys.add(own); for (const a of ['title', 'aria-label', 'placeholder']) { const v = node.getAttribute(a); if (v && /^(app|panel|lang|sub|job|ext|opt|prompt|ctl)\.[\w.-]+$/.test(v)) keys.add(v); } } }; walk(document); return [...keys]; })()`;

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 900);
    const ev = expr => browser.eval(tab, expr);
    await sleep(1500);
    const text = id => ev(`document.getElementById('${id}')?.textContent.trim()`);
    check(name, 'a German Windows gets English (the app has no German texts)', await ev(`document.documentElement.lang`) === 'en' && /Ready for your next video/.test(await ev(`document.getElementById('job-list').textContent`)));
    check(name, 'static texts are English: tabs, buttons, placeholders', /All/.test(await ev(`document.querySelector('[data-filter=all]').textContent`)) && await ev(`document.getElementById('url').placeholder`) === 'Paste a video page or a media link');
    check(name, 'no raw text key shows in the main view', (await ev(LEAK)).length === 0, JSON.stringify(await ev(LEAK)));
    await ev(`document.getElementById('open-settings').click()`); await sleep(500);
    const selected = await ev(`document.getElementById('set-interfaceLanguage').value`);
    check(name, 'Settings has a language list, "Same as Windows" by default', selected === 'auto' && /Language/.test(await ev(`document.querySelector('#s-appearance h2')?.textContent + ' ' + document.querySelector('#s-appearance .setting strong')?.textContent`)), selected);
    check(name, 'no raw text key shows in Settings (language lists, extension help, engines)', (await ev(LEAK)).length === 0, JSON.stringify(await ev(LEAK)));
    // Sorting by type: a switch, off by default; clicking it is saved by the engine
    const sortSaved = () => ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); return (await fetch('/api/settings', { headers: { Authorization: 'Bearer ' + b.token } }).then(r => r.json())).sortByType; })()`);
    check(name, 'Settings has the sort-by-type switch, off by default, with its English text', await ev(`document.getElementById('set-sortByType')?.checked`) === false && await sortSaved() === false && /Sort files into folders by type/.test(await ev(`document.getElementById('set-sortByType').closest('.setting').textContent`)));
    await ev(`document.getElementById('set-sortByType').click()`); await sleep(600);
    check(name, 'turning it on is saved by the engine', await sortSaved() === true && await ev(`document.getElementById('set-sortByType').checked`) === true);
    await ev(`document.getElementById('set-sortByType').click()`); await sleep(600);
    check(name, 'and off again', await sortSaved() === false);
    await browser.screenshot(tab, path.join(shots, `${name}-ui-english-settings.png`));
    // choose Turkish: saved by the engine, the window reloads itself once
    await ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); await fetch('/api/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: 'tr' }) }); })()`);
    await sleep(4500);
    check(name, 'the window reloaded into Turkish by itself', await ev(`document.documentElement.lang`) === 'tr', await ev(`document.documentElement.lang`));
    check(name, 'static and built texts are Turkish', await ev(`document.getElementById('url').placeholder`) === 'Video sayfasını veya medya bağlantısını yapıştır' && /Bir sonraki videon için hazır/.test(await ev(`document.getElementById('job-list').textContent`)));
    check(name, 'the automatic subtitle language now follows the interface language (Turkish)', /Türkçe|Turkish/.test(await ev(`document.querySelector('#language-settings .hd-select-btn')?.textContent`)), await ev(`document.querySelector('#language-settings .hd-select-btn')?.textContent`));
    await ev(`document.getElementById('open-settings').click()`); await sleep(500);
    check(name, 'no raw text key shows in Turkish Settings', (await ev(LEAK)).length === 0, JSON.stringify(await ev(LEAK)));
    await browser.screenshot(tab, path.join(shots, `${name}-ui-turkish-settings.png`));
    // back to automatic: German Windows -> English again
    await ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); await fetch('/api/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: 'auto' }) }); })()`);
    await sleep(4500);
    check(name, 'back to "Same as Windows": English again', await ev(`document.documentElement.lang`) === 'en');
  } catch (error) { check(name, 'finished without an exception', false, String(error.stack || error).slice(0, 300)); }
  finally { await browser?.close(); }
}

try {
  // Firefox needs an add-on to start its test session; the app window itself does not use it.
if (wanted.includes('firefox')) { const builds = buildExtensions(path.join(dir, 'ext')); await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'ff-profile'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')))); }
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'chrome-profile'), []));
} finally { server.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: hata var');
process.exitCode = results.every(Boolean) ? 0 : 1;
