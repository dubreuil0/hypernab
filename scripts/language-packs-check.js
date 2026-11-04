// Real-browser check of the further interface languages (Spanish, German, French, Russian, Portuguese): an isolated server (Japanese
// Windows locale = automatic gives English) and an isolated browser profile. Each language is chosen through the engine's settings; the
// window must reload into it by itself, show its texts, show no raw text key, and no page may scroll sideways (long words must fit).
// Usage: node scripts/language-packs-check.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { chromiumBrowser, firefoxBrowser, freePort } from './browser-driver.js';
import { buildExtensions } from './build-extensions.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-packs-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sandbox = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'public/strings.js'), 'utf8'), { globalThis: sandbox });
const LANGS = sandbox.HypernabText.packs;
const texts = {};
for (const code of LANGS) { const g = {}, ctx = vm.createContext({ globalThis: g }); vm.runInContext(fs.readFileSync(path.join(root, 'public/strings.js'), 'utf8'), ctx); vm.runInContext(fs.readFileSync(path.join(root, `public/lang/${code}.js`), 'utf8'), ctx); texts[code] = g.HypernabText.TEXTS[code]; }

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_LOCALE: 'ja-JP', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }

const LEAK = String.raw`(() => { const keys = new Set(); for (const node of document.querySelectorAll('*')) { const own = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' '); if (/^(app|panel|lang|sub|job|ext|opt|prompt|ctl|desk)\.[\w.-]+$/.test(own)) keys.add(own); for (const a of ['title', 'aria-label', 'placeholder']) { const v = node.getAttribute(a); if (v && /^(app|panel|lang|sub|job|ext|opt|prompt|ctl|desk)\.[\w.-]+$/.test(v)) keys.add(v); } } return [...keys]; })()`;
const SIDEWAYS = `(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }))()`;
const setLanguage = (ev, code) => ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); await fetch('/api/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceLanguage: ${JSON.stringify(code)} }) }); })()`);

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 900);
    const ev = expr => browser.eval(tab, expr);
    await sleep(1500);
    check(name, 'starts in English on a Japanese Windows', await ev(`document.documentElement.lang`) === 'en');
    const listed = await ev(`[...document.querySelectorAll('#set-interfaceLanguage option')].map(o => o.value).join(',')`);
    check(name, 'the language list offers every pack', ['auto', 'en', 'tr', ...LANGS].every(code => listed.split(',').includes(code)), listed);
    for (const code of LANGS) {
      await setLanguage(ev, code); await sleep(4500);
      const t = texts[code];
      check(name, `${code}: the window reloaded into it by itself`, await ev(`document.documentElement.lang`) === code, await ev(`document.documentElement.lang`));
      check(name, `${code}: the page direction is ${code === 'ar' ? 'right-to-left' : 'left-to-right'}`, await ev(`document.documentElement.dir`) === (code === 'ar' ? 'rtl' : 'ltr'));
      check(name, `${code}: static texts follow (placeholder of the link box)`, await ev(`document.getElementById('url').placeholder`) === t['app.url.placeholder'], await ev(`document.getElementById('url').placeholder`));
      check(name, `${code}: built texts follow (empty list)`, (await ev(`document.getElementById('job-list').textContent`)).includes(t['app.empty.ready']));
      check(name, `${code}: no raw text key in the main view`, (await ev(LEAK)).length === 0, JSON.stringify(await ev(LEAK)));
      const side = await ev(SIDEWAYS); check(name, `${code}: main view does not scroll sideways`, side.doc <= 1 && side.body <= 1, JSON.stringify(side));
      await browser.screenshot(tab, path.join(shots, `${name}-lang-${code}-main.png`));
      await ev(`document.getElementById('open-settings').click()`); await sleep(600);
      check(name, `${code}: no raw text key in Settings`, (await ev(LEAK)).length === 0, JSON.stringify(await ev(LEAK)));
      check(name, `${code}: a settings heading is translated`, (await ev(`document.getElementById('s-download')?.querySelector('h2')?.textContent`)) === t['app.dl'], await ev(`document.getElementById('s-download')?.querySelector('h2')?.textContent`));
      const side2 = await ev(SIDEWAYS); check(name, `${code}: Settings does not scroll sideways`, side2.doc <= 1 && side2.body <= 1, JSON.stringify(side2));
      await browser.screenshot(tab, path.join(shots, `${name}-lang-${code}-settings.png`));
      await browser.navigate(tab, origin + '/'); await sleep(1200);
    }
    await setLanguage(ev, 'auto'); await sleep(4500);
    check(name, 'back to "Same as Windows": English again', await ev(`document.documentElement.lang`) === 'en');
  } catch (error) { check(name, 'finished without an exception', false, String(error.stack || error).slice(0, 300)); }
  finally { await browser?.close(); }
}

try {
  if (wanted.includes('firefox')) { const builds = buildExtensions(path.join(dir, 'ext')); await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'ff-profile'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')))); }
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'chrome-profile'), []));
} finally { server.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: hata var');
process.exitCode = results.every(Boolean) ? 0 : 1;
