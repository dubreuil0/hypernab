// Step-9 verification in real Firefox and Chrome (isolated server on its own port, temporary data and profiles): the app window in dark and
// light theme, compact and normal layout, small and large text, left-to-right and right-to-left. For each combination it checks that nothing
// overflows sideways, that text keeps readable contrast, that the keyboard alone reaches and drives the lists, and that the right-to-left view
// mirrors; it also scans every stylesheet for what slows a low-end PC down. Screenshots go to the shots folder for a look.
// Usage: node scripts/visual-matrix.js [firefox] [chrome]
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
const dir = fs.mkdtempSync(path.join(base, 'hypernab-matrix-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }

// Contrast of the text of an element against the first opaque background above it (WCAG ratio).
const CONTRAST = `(selector => {
  const parse = value => { const m = value.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const node = document.querySelector(selector); if (!node) return null;
  const fg = parse(getComputedStyle(node).color); let bg = null;
  for (let e = node; e && !bg; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.95) bg = c; }
  bg ||= { r: 255, g: 255, b: 255, a: 1 };
  const a = lum(fg), b = lum(bg); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
})`;

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 900);
    const ev = expr => browser.eval(tab, expr);
    const save = body => ev(`fetch('/api/bootstrap').then(r => r.json()).then(b => fetch('/api/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }))`);
    const open = async view => { await browser.navigate(tab, origin + '/'); await sleep(900); if (view === 'settings') { await ev(`document.getElementById('open-settings').click()`); await sleep(400); } };
    const overflow = () => ev(`Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)`);

    // ---- the matrix: theme x layout x text size, both views
    for (const theme of ['dark', 'light']) for (const appearance of ['compact', 'normal']) for (const textSize of ['small', 'large']) {
      await save({ theme, appearance, textSize });
      for (const view of ['downloads', 'settings']) {
        await open(view);
        const label = `${theme}/${appearance}/${textSize}/${view}`;
        const wide = await overflow();
        check(name, `no sideways overflow ${label}`, wide === 0, wide ? `${wide}px` : '');
        if (view === 'settings') {
          const samples = { 'title': '.setting strong', 'hint': '.setting .hint', 'list button': '.hd-select-btn', 'primary': '.hd-btn.primary', 'chip': '.hd-chip' };
          for (const [what, selector] of Object.entries(samples)) {
            const ratio = await ev(`${CONTRAST}(${JSON.stringify(selector)})`);
            if (ratio !== null) check(name, `contrast of ${what} ${label}`, ratio >= (what === 'hint' ? 4.0 : 4.5), String(ratio));
          }
        }
        if (textSize === 'large' && appearance === 'normal') await browser.screenshot(tab, path.join(shots, `matrix-${name}-${theme}-${view}.png`));
      }
    }

    // ---- keyboard only (light theme, settings): Tab reaches the lists with a visible ring, arrows + Enter choose, Escape closes without choosing
    await save({ theme: 'light', appearance: 'compact', textSize: 'normal' });
    await open('settings');
    await ev(`document.querySelector('#set-theme').parentElement.nextElementSibling.querySelector('.hd-select-btn').focus()`);
    await browser.key(tab, 'Tab'); await sleep(100);
    const moved = await ev(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { tag: a.tagName, cls: a.className, ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 }; })()`);
    check(name, 'Tab moves to the next control and it shows a focus ring', moved.tag !== 'BODY' && moved.ring, JSON.stringify(moved));
    await ev(`document.querySelector('#set-theme').parentElement.nextElementSibling.querySelector('.hd-select-btn').focus()`);
    const before = await ev(`document.querySelector('#set-theme').value`);
    await browser.key(tab, 'Enter'); await sleep(120);
    check(name, 'Enter opens the list', await ev(`document.querySelector('.hd-select[data-open="true"]') !== null`));
    await browser.key(tab, 'Escape'); await sleep(120);
    check(name, 'Escape closes it without changing the value', (await ev(`document.querySelector('.hd-select[data-open="true"]') === null`)) && (await ev(`document.querySelector('#set-theme').value`)) === before);
    await browser.key(tab, 'Enter'); await sleep(100); await browser.key(tab, 'ArrowUp'); await browser.key(tab, 'Enter'); await sleep(700);
    check(name, 'Enter, ArrowUp, Enter chooses another theme and applies it', (await ev(`document.querySelector('#set-theme').value`)) !== before, await ev(`document.querySelector('#set-theme').value`));
    const keyboardFocus = await ev(`document.activeElement.classList.contains('hd-select-btn')`);
    check(name, 'focus is back on the list button after choosing', keyboardFocus);

    // ---- right-to-left: the whole window mirrored, lists open from the right edge, nothing overflows
    await save({ theme: 'dark', appearance: 'compact', textSize: 'normal' });
    await open('settings');
    await ev(`(() => { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'ar'; })()`); await sleep(300);
    const rtl = await ev(`(() => { const btn = document.querySelector('#language-settings .hd-select-btn'); btn.click(); const pop = btn.parentElement.querySelector('.hd-pop'); const b = btn.getBoundingClientRect(), p = pop.getBoundingClientRect(); const row = document.querySelector('.setting'); const copy = row.firstElementChild.getBoundingClientRect(), control = row.querySelector('.setting-control').getBoundingClientRect(); return { open: !pop.hidden, popStartsAtButtonEnd: Math.abs(p.right - b.right) < 3, textOnRight: copy.left > control.left, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    check(name, 'right-to-left: the list opens flush with the button and the label sits on the right of its control', rtl.open && rtl.popStartsAtButtonEnd && rtl.textOnRight, JSON.stringify(rtl));
    check(name, 'right-to-left: no sideways overflow', rtl.overflow <= 0, String(rtl.overflow));
    await browser.screenshot(tab, path.join(shots, `matrix-${name}-rtl-settings.png`));
    await ev(`document.documentElement.dir = 'ltr'`);

    // ---- what makes a low-end PC slow: scan every stylesheet the app serves
    const css = await ev(`Promise.all([...document.styleSheets].map(s => s.href ? fetch(s.href).then(r => r.text()) : '')).then(list => list.join('\\n'))`);
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    check(name, 'no blur or backdrop filters in the app\'s styles', !/backdrop-filter|blur\(/.test(bare));
    const loops = (bare.match(/animation(?:-iteration-count)?\s*:[^;}]*infinite/g) || []);
    check(name, 'no endless animation', loops.length === 0, loops.join(' | ').slice(0, 160));
    const bigShadows = (bare.match(/box-shadow\s*:[^;}]*/g) || []).filter(value => { const blur = value.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/); return blur && Number(blur[3]) > 24; });
    check(name, 'no big shadows (blur above 24px)', bigShadows.length === 0, bigShadows.join(' | ').slice(0, 160));
    check(name, 'reduced motion is honoured', /prefers-reduced-motion\s*:\s*reduce/.test(bare));
  } catch (error) { check(name, 'run', false, error.message); }
  finally { await browser?.close(); }
}

const builds = buildExtensions(path.join(dir, 'ext'));
if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), []));
if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
server.kill();
await sleep(500);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${results.filter(Boolean).length}/${results.length} geçti`);
process.exit(results.every(Boolean) ? 0 : 1);
