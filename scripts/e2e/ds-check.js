// Real-browser check of the design system (public/ds.css + public/ds.js): draws every control in dark / light / four accents / right-to-left /
// inside a shadow root (like the page panel), drives the select with real mouse and keyboard, and saves screenshots to look at.
// Isolated temporary profiles; nothing of the user's is touched. Usage: node scripts/e2e/ds-check.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildExtensions } from '../release/build-extensions.js';
import { chromiumBrowser, firefoxBrowser } from './browser-driver.js';
import { zipFolder } from '../release/zip-store.js';

const root = path.resolve(import.meta.dirname, '../..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-ds-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };

const page = `<!doctype html><meta charset="utf-8"><title>ds</title>
<link rel="stylesheet" href="/ds.css"><script src="/ds.js"></script>
<style>body{margin:0;font:14px 'Segoe UI',sans-serif;display:grid;grid-template-columns:repeat(3,1fr);gap:0}.scope{padding:14px;background:var(--bg);color:var(--text);display:grid;gap:10px;align-content:start}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}h4{margin:0;font-size:12px;color:var(--muted)}</style>
<body><script>
const DS = HypernabDS, doc = document;
const langs = [
  { value: 'tr', code: 'TR', label: 'Türkçe', sub: 'Turkish', badge: { text: 'çalıyor', tone: 'live' } },
  { value: 'en', code: 'EN', label: 'English', sub: 'İngilizce' },
  { value: 'ar', code: 'AR', label: 'العربية', sub: 'Arapça' },
  { value: 'ja', code: 'JA', label: '日本語', sub: 'Japonca' },
  { value: 'xx', code: 'XX', label: 'Kapalı seçenek', disabled: true },
];
const scopes = [['dark', 'green'], ['dark', 'blue'], ['light', 'green'], ['light', 'violet'], ['dark', 'orange'], ['rtl', 'green']];
window.sel = {};
for (const [scheme, accent] of scopes) {
  const id = 's-' + scheme + '-' + accent, rtl = scheme === 'rtl', real = rtl ? 'dark' : scheme;
  const style = doc.createElement('style'); style.textContent = DS.tokens(real, accent, '#' + id); doc.head.append(style);
  const scope = doc.createElement('div'); scope.className = 'scope'; scope.id = id; if (rtl) scope.dir = 'rtl';
  scope.append(Object.assign(doc.createElement('h4'), { textContent: scheme + ' / ' + accent }));
  const row1 = doc.createElement('div'); row1.className = 'row';
  const mk = (cls, text, extra) => { const b = doc.createElement('button'); b.className = 'hd-btn ' + cls; b.textContent = text; if (extra) b.disabled = true; return b; };
  row1.append(mk('primary', 'İndir'), mk('', 'Sonra'), mk('quiet', 'İptal'), mk('', 'Kapalı', true));
  const row2 = doc.createElement('div'); row2.className = 'row';
  const ib = (name, filled) => { const b = doc.createElement('button'); b.className = 'hd-icon-btn' + (filled ? ' filled' : ''); b.setAttribute('aria-label', name); b.append(DS.icon(doc, name)); return b; };
  row2.append(ib('refresh'), ib('download', true), ib('queue'), ib('close'), DS.toggle(doc, { text: 'Anahtar', checked: true }).el, DS.toggle(doc, { text: 'Kapalı' }).el, DS.toggle(doc, { text: 'Kutu', kind: 'check', checked: true }).el, DS.toggle(doc, { text: 'Boş', kind: 'check' }).el);
  const row3 = doc.createElement('div'); row3.className = 'row';
  row3.append(DS.chip(doc, { code: 'TR', text: 'Türkçe', sub: 'Turkish', tone: 'accent' }), DS.chip(doc, { code: 'EN', text: 'English' }), DS.chip(doc, { code: 'AR', text: 'العربية' }), DS.chip(doc, { text: 'Gömülü' }), DS.chip(doc, { code: 'DE', text: 'Almanca', tone: 'warn' }), DS.badge(doc, 'çalıyor', 'live'), DS.badge(doc, 'sitenin varsayılanı'), DS.dot(doc, 'live'), DS.dot(doc, 'off'), DS.dot(doc));
  const s1 = DS.select(doc, { options: langs, value: 'tr', label: 'Ses ' + id, onChange: v => { window.sel[id] = v; } });
  const s2 = DS.select(doc, { options: langs, value: 'en', label: 'Altyazı ' + id, search: true, searchLabel: 'Ara', emptyText: 'Sonuç yok' });
  s1.el.dataset.k = 'a'; s2.el.dataset.k = 'b'; window.sel[id] = 'tr';
  scope.append(row1, row2, row3, s1.el, s2.el);
  doc.body.append(scope);
}
// Same controls inside a shadow root, the way the page panel draws them (host page styles must not leak in).
const host = doc.createElement('div'); host.style.cssText = 'grid-column:1/-1;padding:14px;background:#888'; doc.body.append(host);
const shadow = host.attachShadow({ mode: 'open' });
fetch('/ds.css').then(r => r.text()).then(css => {
  const style = doc.createElement('style'); style.textContent = DS.tokens('auto', 'green') + css + ':host{display:block;font:13px system-ui}.in{display:grid;gap:8px;width:320px;padding:12px;background:var(--panel);color:var(--text);border-radius:14px}';
  const inner = doc.createElement('div'); inner.className = 'in';
  const s = DS.select(doc, { options: langs, value: 'tr', label: 'Panel ses' }); inner.append(s.el); shadow.append(style, inner); window.shadowSelect = s; window.ready = true;
});
</script>`;

const server = http.createServer((req, res) => {
  const file = { '/ds.css': 'public/ds.css', '/ds.js': 'public/ds.js' }[req.url];
  if (file) { res.setHeader('content-type', file.endsWith('css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(root, file))); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(url);
    await browser.navigate(tab, url);
    for (let n = 0; n < 40 && !(await browser.eval(tab, 'window.ready === true')); n++) await sleep(150);
    if (browser.viewport) await browser.viewport(tab, 1300, 700);
    const ev = expr => browser.eval(tab, expr);
    check(name, 'page drawn, shadow root ready', await ev('window.ready === true && document.querySelectorAll(".hd-select").length === 12'), await ev('JSON.stringify([window.ready, document.querySelectorAll(".hd-select").length, typeof HypernabDS, location.href, document.body.innerHTML.slice(0, 120)])'));
    const q = id => `document.querySelector('#${id} .hd-select-btn')`;
    const rect = async id => ev(`(${q(id)}.getBoundingClientRect(), (r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(${q(id)}.getBoundingClientRect()))`);

    // look
    const look = await ev(`(() => { const b = ${q('s-dark-green')}, cs = getComputedStyle(b), sw = getComputedStyle(document.querySelector('#s-dark-green .hd-switch')); return { appearance: cs.appearance, radius: cs.borderRadius, bg: cs.backgroundColor, swAppearance: sw.appearance, swBg: sw.backgroundColor }; })()`);
    check(name, 'no native look on the select button and the switch', look.appearance === 'none' && look.swAppearance === 'none', JSON.stringify(look));
    check(name, 'shadow-root tokens give the select a themed background', await ev('getComputedStyle(window.shadowSelect.button).backgroundColor !== "rgba(0, 0, 0, 0)"'));

    // mouse: open, pick, closes
    const p = await rect('s-dark-green'); await browser.click(tab, p.x, p.y); await sleep(150);
    check(name, 'click opens the list with 5 options', await ev(`!document.querySelector('#s-dark-green .hd-pop').hidden && document.querySelectorAll('#s-dark-green .hd-select[data-k="a"] .hd-opt').length === 5`));
    await browser.screenshot(tab, path.join(shots, `${name}-open-dark.png`));
    const option = await ev(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelectorAll('#s-dark-green .hd-select[data-k="a"] .hd-opt')[1].getBoundingClientRect())`);
    await browser.click(tab, option.x, option.y); await sleep(150);
    check(name, 'picking an option changes the value, calls back and closes', await ev(`window.sel['s-dark-green'] === 'en' && document.querySelector('#s-dark-green .hd-pop').hidden && ${q('s-dark-green')}.textContent.includes('English')`));
    check(name, 'focus returns to the button after picking', await ev(`document.activeElement === document.querySelector('#s-dark-green .hd-select-btn') || document.querySelector('#s-dark-green').contains(document.activeElement)`));

    // keyboard on the light/violet one
    await ev(`${q('s-light-violet')}.focus()`);
    await browser.key(tab, 'ArrowDown'); await sleep(100);
    check(name, 'ArrowDown opens the list', await ev(`${q('s-light-violet')}.getAttribute('aria-expanded') === 'true'`));
    await browser.key(tab, 'ArrowDown'); await browser.key(tab, 'ArrowDown'); await browser.key(tab, 'Enter'); await sleep(150);
    check(name, 'two more ArrowDown + Enter pick the third option', await ev(`window.sel['s-light-violet'] === 'ar'`), await ev(`window.sel['s-light-violet']`));
    await browser.key(tab, 'ArrowDown'); await sleep(80);
    await browser.key(tab, 'Escape'); await sleep(100);
    check(name, 'Escape closes without changing', await ev(`${q('s-light-violet')}.getAttribute('aria-expanded') === 'false' && window.sel['s-light-violet'] === 'ar'`));
    await ev(`document.querySelectorAll('#s-light-violet .hd-select')[0].querySelector('.hd-select-btn').click()`);
    await browser.key(tab, 'End'); await sleep(80);
    check(name, 'End skips the disabled last option', await ev(`document.querySelector('#s-light-violet .hd-opt.active')?.textContent.includes('日本語')`));
    await browser.key(tab, 'Escape');

    // outside click closes
    await ev(`${q('s-dark-blue')}.click()`); await sleep(100);
    await browser.click(tab, 1355, 670); await sleep(150);
    check(name, 'a click outside closes the list', await ev(`document.querySelector('#s-dark-blue .hd-pop').hidden`));

    // search select
    await ev(`document.querySelectorAll('#s-dark-orange .hd-select-btn')[1].click()`); await sleep(100);
    const typed = await ev(`(() => { const f = document.querySelector('#s-dark-orange .hd-pop-search:not([hidden])'); return !!f; })()`);
    check(name, 'search select shows a search field', typed);
    await ev(`(() => { const f = document.querySelectorAll('#s-dark-orange .hd-pop-search')[0]; f.value = 'jap'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(100);
    check(name, 'search matches the native-script name via its quieter sub name', await ev(`document.querySelectorAll('#s-dark-orange .hd-select[data-k="b"] .hd-opt').length === 1`));
    await ev(`(() => { const f = document.querySelector('#s-dark-orange .hd-pop-search'); f.value = 'zzz'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(80);
    check(name, 'no match shows the empty text', await ev(`document.querySelectorAll('#s-dark-orange .hd-empty').length === 1`));
    await ev(`document.querySelectorAll('#s-dark-orange .hd-select-btn')[1].click()`);

    // shadow root select works too
    await ev('window.shadowSelect.button.click()'); await sleep(100);
    check(name, 'select works inside a shadow root', await ev('!window.shadowSelect.el.querySelector(".hd-pop").hidden && window.shadowSelect.el.querySelectorAll(".hd-opt").length === 5'));
    await ev('window.shadowSelect.close()');

    // RTL mirrors
    const rtl = await ev(`(() => { const t = document.querySelector('#s-rtl-green .hd-switch'); const l = document.querySelector('#s-rtl-green .hd-select-btn'); return { dir: getComputedStyle(l).direction, tx: getComputedStyle(l).textAlign }; })()`);
    check(name, 'right-to-left scope mirrors', rtl.dir === 'rtl' && rtl.tx !== 'left', JSON.stringify(rtl));

    await browser.screenshot(tab, path.join(shots, `${name}-gallery.png`));
  } catch (error) { check(name, 'run', false, error.message); }
  finally { await browser?.close(); }
}

const builds = buildExtensions(path.join(dir, 'ext'));
if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), []));
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nEkran görüntüleri: ${shots}\n${results.filter(Boolean).length}/${results.length} geçti`);
process.exit(results.every(Boolean) ? 0 : 1);
