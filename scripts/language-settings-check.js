// Real-browser check of the language settings in the app's Settings page: an isolated server (own port, temporary data and download
// folders) and an isolated browser profile. Picks languages with the mouse and the search box, and reads the saved settings back.
// Usage: node scripts/language-settings-check.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, freePort } from './browser-driver.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-lang-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 900);
    const ev = expr => browser.eval(tab, expr);
    await sleep(1200);
    await ev(`document.getElementById('open-settings').click()`); await sleep(500);
    check(name, 'the language lists and the video-format list are drawn in Settings', await ev(`document.querySelectorAll('#language-settings .hd-select').length === 3`));
    check(name, 'no raw <select> among them', await ev(`document.querySelectorAll('#language-settings select').length === 0`));
    const labels = await ev(`[...document.querySelectorAll('#language-settings .hd-select-btn')].map(b => b.textContent.trim())`);
    check(name, 'defaults: interface language and "whatever the player plays"', /Aray\u00fcz dili/.test(labels[0]) && /Oynat/.test(labels[1]), JSON.stringify(labels));
    const setting = key => ev(`fetch('/api/bootstrap').then(r => r.json()).then(b => fetch('/api/settings', { headers: { Authorization: 'Bearer ' + b.token } })).then(r => r.json()).then(s => s.${key})`);
    check(name, 'engine defaults are auto / player', (await setting('subtitleLanguage')) === 'auto' && (await setting('audioLanguage')) === 'player');

    // choose German by searching with its own name
    await ev(`document.querySelector('#language-settings .hd-select-btn').click()`); await sleep(150);
    await ev(`(() => { const f = document.querySelector('#language-settings .hd-pop-search'); f.value = 'deutsch'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(150);
    const found = await ev(`[...document.querySelectorAll('#language-settings .hd-select:first-of-type .hd-opt, #language-settings .setting:first-child .hd-opt')].map(o => o.textContent.trim())`);
    check(name, 'searching the language\'s own name finds it', found.length === 1 && /Almanca/.test(found[0]), JSON.stringify(found));
    await browser.screenshot(tab, path.join(shots, `${name}-language-settings-open.png`));
    await ev(`document.querySelector('#language-settings .setting:first-child .hd-opt').click()`); await sleep(500);
    check(name, 'picking it saves "de" in the engine', (await setting('subtitleLanguage')) === 'de');
    check(name, 'the button now shows the language', await ev(`document.querySelector('#language-settings .hd-select-btn').textContent.includes('Almanca')`));

    // sound: "always original"
    await ev(`document.querySelectorAll('#language-settings .hd-select-btn')[1].click()`); await sleep(150);
    await ev(`document.querySelectorAll('#language-settings .setting')[1].querySelectorAll('.hd-opt')[1].click()`); await sleep(500);
    check(name, 'sound preference saved as "original"', (await setting('audioLanguage')) === 'original');
    check(name, 'the video format with subtitles is "keep" until chosen', (await setting('subtitleContainer')) === 'keep');
    await ev(`document.querySelectorAll('#language-settings .hd-select-btn')[2].click()`); await sleep(150);
    await ev(`document.querySelectorAll('#language-settings .setting')[2].querySelectorAll('.hd-opt')[1].click()`); await sleep(500);
    check(name, 'choosing mkv saves it', (await setting('subtitleContainer')) === 'mkv');
    const prefs = await ev(`fetch('/api/bootstrap').then(r => r.json()).then(b => fetch('/api/prefs', { headers: { Authorization: 'Bearer ' + b.token } })).then(r => r.json())`);
    check(name, 'the extension\'s narrow /api/prefs route shows only the language choices and the look', JSON.stringify(Object.keys(prefs).sort()) === '["accent","audioLanguage","subtitleLanguage","theme"]' && prefs.subtitleLanguage === 'de' && prefs.audioLanguage === 'original', JSON.stringify(prefs));
    // settings page survives a reload with the stored values
    await browser.navigate(tab, origin + '/'); await sleep(1200);
    await ev(`document.getElementById('open-settings').click()`); await sleep(800);
    const again = await ev(`[...document.querySelectorAll('#language-settings .hd-select-btn')].map(b => b.textContent.trim())`);
    check(name, 'stored choices show after a reload', /Almanca/.test(again[0]) && /orijinal/i.test(again[1]), JSON.stringify(again));
    // every drop-down of the app is the design system's list; the native ones are hidden and still carry the values
    const natives = await ev(`[...document.querySelectorAll('select')].filter(s => s.offsetParent !== null).length`);
    check(name, 'no native drop-down is visible anywhere in the app window', natives === 0, String(natives));
    const upgraded = await ev(`document.querySelectorAll('.hd-select.hd-native').length`);
    check(name, 'the app\'s own drop-downs are the design system\'s list', upgraded >= 12, String(upgraded));
    // a finished download shows its subtitles as language chips (a job is added held, then the list answer is given subtitle data)
    await ev(`fetch('/api/bootstrap').then(r => r.json()).then(b => fetch('/api/jobs', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.org/film.mp4', start: 'queue' }) }))`);
    await ev(`(() => { const real = window.fetch.bind(window); window.fetch = async (url, options) => { const response = await real(url, options); if (String(url) !== '/api/jobs' || (options?.method || 'GET') !== 'GET') return response; const jobs = await response.json(); const fake = jobs.map(job => ({ ...job, subtitleResult: { mode: 'embedded+sidecar', tracks: [{ name: 'T\\u00fcrk\\u00e7e', lang: 'tr', default: true }, { name: 'English', lang: 'en', default: false }], files: ['film.tr.srt'] } })); return new Response(JSON.stringify(fake), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; })()`);
    await ev(`document.getElementById('close-settings').click()`); await sleep(5000);
    const subs = await ev(`(() => { const row = document.querySelector('.job-subs'); return row ? { chips: row.querySelectorAll('.hd-chip').length, badges: [...row.querySelectorAll('.hd-badge')].map(b => b.textContent), accent: row.querySelectorAll('.hd-chip[data-tone="accent"]').length, text: row.textContent } : null; })()`);
    check(name, 'subtitles of a job are language chips: default one accented, "in the video" + "side file" badges', Boolean(subs) && subs.chips === 2 && subs.accent === 1 && subs.badges.length === 2, JSON.stringify(subs));
    await ev(`document.getElementById('open-settings').click()`); await sleep(500);
    // pick a theme with the new list: it is saved and applied
    await ev(`document.querySelector('#set-theme').parentElement.nextElementSibling.querySelector('.hd-select-btn').click()`); await sleep(150);
    await ev(`[...document.querySelectorAll('.hd-select.hd-native[data-open="true"] .hd-opt')].find(o => /A\u00e7\u0131k/.test(o.textContent)).click()`); await sleep(700);
    check(name, 'choosing "Açık" in the theme list saves it and changes the look at once', (await setting('theme')) === 'light' && (await ev(`document.documentElement.dataset.scheme === 'light'`)), await ev(`document.documentElement.dataset.scheme`));
    await browser.screenshot(tab, path.join(shots, `${name}-language-settings.png`));
  } catch (error) { check(name, 'run', false, error.message); }
  finally { await browser?.close(); }
}

const builds = buildExtensions(path.join(dir, 'ext'));
if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), []));
server.kill();
await sleep(500);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${results.filter(Boolean).length}/${results.length} geçti`);
process.exit(results.every(Boolean) ? 0 : 1);
