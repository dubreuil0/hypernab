// Customizable list in real Chromium: full-window layout, column resize, search, sort, menu, focus view, persistence.
// Isolated server/data/profile only; never touches the installed app.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromiumBrowser, freePort, browserUntil } from './browser-driver.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools/browsers.json')));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-list-web-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const data = path.join(dir, 'data'), downloads = path.join(dir, 'downloads');
fs.mkdirSync(data); fs.mkdirSync(downloads);
const long = 'Çok uzun Türkçe belgesel adı — görüntü, ses ve öğretici anlatım bölümü ';
const seeded = Array.from({ length: 60 }, (_, i) => ({
  id: randomUUID(), title: `${i % 7 === 0 ? long.repeat(3) : 'Video'} ${String(i).padStart(2, '0')}`, engine: 'direct', status: 'completed',
  url: `https://example.org/v${i}.mp4`, file: `v${i}.mp4`, directory: downloads, received: 1000 * (60 - i), total: 1000 * (60 - i), createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
}));
fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify(seeded));
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HYPERNAB_LOCALE: 'tr-TR', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: data, HYPERNAB_DOWNLOAD_DIR: downloads }, stdio: 'ignore' });
let browser;
const ok = text => console.log(`OK ${text}`);
try {
  await browserUntil(() => fetch(origin).then(r => r.ok, () => false));
  const token = fs.readFileSync(path.join(data, 'pairing-token'), 'utf8').trim();
  const api = async (route, body) => (await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const initial = await api('/api/jobs'); assert.equal(initial.length, 60);
  browser = await chromiumBrowser(tools.chrome, path.join(dir, 'profile'), []);
  const tab = await browser.create(origin);
  const ev = expression => browser.eval(tab, expression);
  const ready = () => browserUntil(() => ev('document.querySelectorAll("#jobs .job").length > 0'));
  const rect = selector => ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}})()`);
  await browser.viewport(tab, 1900, 900); await browser.navigate(tab, origin); await ready();

  // 1. Full window: no 1440 cap, list scrolls inside itself, header stays put.
  const wide = await ev(`({shell:document.querySelector('.shell').getBoundingClientRect().width,page:document.documentElement.scrollHeight,inner:innerHeight,list:document.querySelector('#job-list').clientHeight,scroll:document.querySelector('#job-list').scrollHeight,name:document.querySelector('.col-head[data-col="name"]').getBoundingClientRect().width,rows:document.querySelectorAll('#jobs .job').length})`);
  assert.ok(wide.shell > 1800, JSON.stringify(wide)); assert.ok(wide.page <= wide.inner + 1, JSON.stringify(wide));
  assert.ok(wide.list > 300 && wide.scroll > wide.list, JSON.stringify(wide)); assert.ok(wide.name > 900, JSON.stringify(wide));
  await ev(`document.querySelector('#job-list').scrollTop = 600`);
  const headTop = (await rect('#job-columns')).y, listTop = (await rect('#job-list')).y;
  assert.ok(Math.abs(headTop - listTop) <= 1, `header not sticky ${headTop} vs ${listTop}`);
  await ev(`document.querySelector('#job-list').scrollTop = 0`);
  await browser.screenshot(tab, path.join(dir, 'wide.png'));
  ok(`1900px window: list ${Math.round(wide.shell)}px wide, scrolls inside (${wide.list}px tall), sticky header, name column ${Math.round(wide.name)}px`);

  // 1b. Automatic layout follows the window; it is not saved and says so.
  assert.match(await ev(`document.querySelector('#layout-mode').textContent`), /Otomatik/);
  const autoWide = (await rect('.col-head[data-col="state"]')).w;
  await browser.viewport(tab, 1200, 900); await new Promise(r => setTimeout(r, 300));
  const autoNarrow = (await rect('.col-head[data-col="state"]')).w;
  assert.ok(autoWide > autoNarrow + 20, `auto widths ${autoWide} vs ${autoNarrow}`);
  assert.deepEqual((await api('/api/settings')).listLayout.widths, {});
  await browser.viewport(tab, 1900, 900); await new Promise(r => setTimeout(r, 300));
  ok(`automatic columns adapt to the window (Durum ${Math.round(autoWide)}px at 1900, ${Math.round(autoNarrow)}px at 1200) without saving anything`);

  // 2. Drag resize of "Boyut" from its header boundary (real mouse).
  const before = (await rect('.col-head[data-col="size"]')).w;
  const grip = await rect('.col-resize[data-col="size"]'), gx = grip.x + grip.w / 2, gy = grip.y + grip.h / 2;
  await browser.mouse(tab, 'mouseMoved', gx, gy); await browser.mouse(tab, 'mousePressed', gx, gy);
  for (const step of [20, 50, 80]) await browser.mouse(tab, 'mouseMoved', gx + step, gy);
  await browser.mouse(tab, 'mouseReleased', gx + 80, gy);
  const after = (await rect('.col-head[data-col="size"]')).w;
  assert.ok(Math.abs(after - before - 80) <= 3, `before ${before} after ${after}`);
  const edge = await rect('.col-head[data-col="size"]'); // the dragged boundary must sit under the pointer, not run away
  assert.ok(Math.abs(edge.r - (gx + 80 - 3)) <= 8, `edge ${edge.r} pointer ${gx + 80}`);
  assert.ok((await rect('.col-head[data-col="name"]')).w >= wide.name - 2, 'name keeps its width');
  const rowInfo = await ev(`({cell:document.querySelector('#jobs .job .compact-size').getBoundingClientRect().width,tpl:getComputedStyle(document.querySelector('#jobs .job-top')).gridTemplateColumns,htpl:getComputedStyle(document.querySelector('#job-columns')).gridTemplateColumns})`);
  assert.ok(rowInfo.cell >= after - 2, `rows follow the header ${JSON.stringify(rowInfo)} after=${after}`);
  await browserUntil(async () => (await api('/api/settings')).listLayout.widths.size === Math.round(after));
  const order = (await api('/api/jobs')).map(j => j.id);
  assert.deepEqual(order, initial.map(j => j.id)); // resizing never touches real queue order
  ok('mouse drag resized header and rows together and saved the width; queue order untouched');

  // 3. Keyboard resize, Escape-safe, fit and hide.
  await ev(`document.querySelector('.col-resize[data-col="speed"]').focus()`);
  const speed0 = (await rect('.col-head[data-col="speed"]')).w;
  await browser.key(tab, 'ArrowRight');
  assert.ok(Math.abs((await rect('.col-head[data-col="speed"]')).w - speed0 - 10) <= 2);
  await ev(`document.querySelector('.col-resize[data-col="name"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await browserUntil(async () => { const w = (await api('/api/settings')).listLayout.widths.name; return w >= 110 && w <= 700; });
  await ev(`(()=>{const b=document.querySelector('input[data-col="eta"]');b.checked=false;b.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  assert.equal(await ev(`!!document.querySelector('.col-head[data-col="eta"]') || getComputedStyle(document.querySelector('.compact-eta')).display !== 'none'`), false);
  await browserUntil(async () => (await api('/api/settings')).listLayout.hidden.includes('eta'));
  ok('keyboard resize, double-click fit and hiding a column');

  // 4. Persistence across reload.
  await browser.navigate(tab, origin); await ready();
  assert.ok(Math.abs((await rect('.col-head[data-col="size"]')).w - after) <= 3);
  assert.equal(await ev(`!!document.querySelector('.col-head[data-col="eta"]')`), false);
  ok('layout survives reload');

  // 5. Search (Ctrl+F) and visual sort never reorder the real queue.
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))`);
  assert.equal(await ev(`document.activeElement.id`), 'list-search');
  await ev(`(()=>{const i=document.querySelector('#list-search');i.value='belgesel';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const found = await ev(`document.querySelectorAll('#jobs .job').length`);
  assert.equal(found, seeded.filter(j => /belgesel/i.test(j.title)).length);
  assert.match(await ev(`document.querySelector('#list-notice').textContent`), /yalnızca görünümü/);
  await ev(`(()=>{const i=document.querySelector('#list-search');i.value='yok-boyle-bir-sey';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.match(await ev(`document.querySelector('#jobs').textContent`), /eşleşen indirme yok/);
  await browser.key(tab, 'Escape');
  assert.equal(await ev(`document.querySelector('#list-search').value`), '');
  assert.equal(await ev(`document.querySelectorAll('#jobs .job').length`), 60);
  await ev(`document.querySelector('.col-head[data-col="name"] .col-sort').click()`);
  const firstAsc = await ev(`document.querySelector('#jobs .job-title').textContent`);
  assert.equal(await ev(`document.querySelector('.col-head[data-col="name"]').getAttribute('aria-sort')`), 'ascending');
  await ev(`document.querySelector('.col-head[data-col="name"] .col-sort').click()`);
  assert.notEqual(await ev(`document.querySelector('#jobs .job-title').textContent`), firstAsc);
  assert.match(await ev(`document.querySelector('#list-notice').textContent`), /Sıralama: Ad/);
  await ev(`document.querySelector('#jobs .reorder-handle').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true,pointerId:1}))`);
  assert.match(await ev(`document.querySelector('#queue-message').textContent`), /Liste sırasına dön/);
  assert.deepEqual((await api('/api/jobs')).map(j => j.id), initial.map(j => j.id));
  await ev(`document.querySelector('#sort-reset').click()`);
  assert.equal(await ev(`document.querySelector('#jobs .job-title').textContent.trim()`), initial[0].title.trim());
  ok('Ctrl+F search, empty result, Escape, header sort asc/desc, priority drag blocked while sorted, real order unchanged');

  // 6. Row menu: keyboard-reachable, Escape returns focus.
  await ev(`document.querySelector('#jobs .job [data-job-action$="-more"]').focus()`);
  await browser.key(tab, 'Enter'); await ev(`document.querySelector('#jobs .job [data-job-action$="-more"]').click()`);
  const items = await ev(`[...document.querySelectorAll('#row-menu [role=menuitem]')].map(b=>b.textContent.trim())`);
  assert.ok(items.includes('Adı kopyala') && items.includes('Ayrıntıları göster'), items.join('|'));
  assert.equal(await ev(`document.activeElement.getAttribute('role')`), 'menuitem');
  const menu = await rect('#row-menu'); assert.ok(menu.r <= 1900 && menu.b <= 900);
  await browser.key(tab, 'Escape');
  assert.equal(await ev(`document.querySelector('#row-menu').hidden`), true);
  assert.match(await ev(`document.activeElement.dataset.jobAction`), /-more$/);
  await ev(`document.querySelector('#jobs .job').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}))`);
  assert.equal(await ev(`document.querySelector('#row-menu').hidden`), false);
  await browser.key(tab, 'Escape');
  ok('row menu opens by button and right click, stays in view, Escape restores focus');

  // 7. Focus view and narrow window.
  const listBefore = (await rect('#job-list')).h;
  await ev(`document.querySelector('#focus-toggle').click()`);
  assert.equal(await ev(`getComputedStyle(document.querySelector('.composer')).display`), 'none');
  assert.ok((await rect('#job-list')).h > listBefore + 40);
  await browserUntil(async () => (await api('/api/settings')).listLayout.focus === true);
  await ev(`document.querySelector('#focus-toggle').click()`);
  await browser.viewport(tab, 720, 700); await new Promise(r => setTimeout(r, 300));
  const narrow = await ev(`({w:innerWidth,s:document.documentElement.scrollWidth,b:document.body.scrollWidth})`);
  assert.ok(narrow.s <= narrow.w + 1, JSON.stringify(narrow));
  await browser.viewport(tab, 1300, 800);
  ok('focus view gives the list more height; 720px window has no page overflow');

  // 8. Reset layout.
  await ev(`document.querySelector('#layout-reset').click()`);
  await browserUntil(async () => { const l = (await api('/api/settings')).listLayout; return !Object.keys(l.widths).length && !l.hidden.length; });
  assert.equal(await ev(`!!document.querySelector('.col-head[data-col="eta"]')`), true);

  // 8b. Themes: light + another accent switch instantly, stay readable, and never cost layout (no overflow, no blur effects).
  for (const [theme, accent, bg, accentColor] of [['light', 'blue', 'rgb(243, 245, 244)', 'rgb(31, 111, 209)'], ['light', 'violet', 'rgb(243, 245, 244)', 'rgb(106, 69, 209)'], ['dark', 'orange', 'rgb(14, 17, 19)', 'rgb(255, 178, 87)']]) {
    await api('/api/settings', { theme, accent });
    await browserUntil(() => ev(`document.documentElement.dataset.scheme === '${theme}' && document.documentElement.dataset.accent === '${accent}'`));
    await new Promise(r => setTimeout(r, 400)); // let the short colour fade finish
    const look = await ev(`({bg:getComputedStyle(document.body).backgroundColor,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),primary:getComputedStyle(document.querySelector('#add-button')).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth+1,blur:[...document.querySelectorAll('*')].some(e=>{const s=getComputedStyle(e);return s.backdropFilter!=='none'||s.filter!=='none'})})`);
    assert.equal(look.bg, bg); assert.ok(!look.overflow && !look.blur, JSON.stringify(look));
    assert.ok(look.primary.replace(/\s/g, '') === accentColor.replace(/\s/g, ''), JSON.stringify({ look, accentColor }));
    await browser.screenshot(tab, path.join(dir, `theme-${theme}-${accent}.png`));
  }
  await api('/api/settings', { theme: 'dark', accent: 'green' });
  await browser.navigate(tab, origin); await ready();
  assert.equal(await ev('document.documentElement.dataset.accent'), 'green');
  // 8c. An idle list is not rebuilt on every poll (cheap on slow PCs).
  await ev(`window.__row = document.querySelector('#jobs .job')`); await new Promise(r => setTimeout(r, 4000));
  assert.equal(await ev(`window.__row === document.querySelector('#jobs .job') && document.contains(window.__row)`), true);
  ok('light/dark themes and four accents apply instantly with no overflow or blur effects; unchanged rows are not redrawn');

  // 9. Duplicate check by the shared engine.
  const same = await api('/api/duplicates', { url: seeded.find(s => s.title === initial[3].title).url, formatId: null });
  assert.deepEqual(same.duplicates.map(d => d.id), [initial[3].id]);
  assert.deepEqual((await api('/api/duplicates', { url: seeded.find(s => s.title === initial[3].title).url, formatId: '137' })).duplicates, []);
  ok('duplicate check finds same source/quality only');
  // Settings are real controls: saving and reloading must retain both policies.
  await ev(`document.querySelector('#open-settings').click()`);
  await browserUntil(() => ev(`document.querySelector('#set-smartNames').checked === true`));
  await ev(`(()=>{const n=document.querySelector('#set-folderLayout');n.value='site-series';n.dispatchEvent(new Event('change'));return true})()`);
  await browserUntil(async () => (await api('/api/settings')).folderLayout === 'site-series');
  await ev(`(()=>{const n=document.querySelector('#set-smartNames');n.checked=false;n.dispatchEvent(new Event('change'));return true})()`);
  await browserUntil(async () => (await api('/api/settings')).smartNames === false);
  await browser.navigate(tab, origin); await ready();
  await browserUntil(() => ev(`document.querySelector('#set-folderLayout').value === 'site-series' && document.querySelector('#set-smartNames').checked === false`));
  await ev(`document.querySelector('#open-settings').click()`);
  await browser.screenshot(tab, path.join(dir, 'file-layout-settings.png'));
  await api('/api/settings', { smartNames: true, folderLayout: 'flat' });
  await ev(`document.querySelector('#close-settings').click()`);
  ok('smart naming and folder controls save correctly and survive reload');
  await browser.screenshot(tab, path.join(dir, 'final.png'));
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill();
  console.log(`Test directory: ${dir}`);
}


