// Real isolated Chrome + HTTP engine. No user's engine/profile/downloads are touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromiumBrowser, freePort, browserUntil } from './browser-driver.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools/browsers.json')));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-history-web-'));
const data = path.join(dir, 'data'), downloads = path.join(dir, 'downloads');
fs.mkdirSync(data); fs.mkdirSync(downloads);
const seed = Array.from({ length: 113 }, (_, index) => ({ id: randomUUID(), url: `https://example.org/video/${index}?secret=not-for-history`, headers: { Cookie: 'not-for-history' },
  engine: 'direct', status: 'completed', title: index === 112 ? 'İstanbul Öyküsü' : `Film ${String(index).padStart(3, '0')}`, file: `video-${index}.mp4`, directory: downloads, total: 123, received: 123, createdAt: '2026-10-28T10:00:00.000Z' }));
fs.writeFileSync(path.join(downloads, seed.at(-1).file), 'kept-bytes');
fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify(seed));
fs.writeFileSync(path.join(data, 'queue.json.meta.json'), JSON.stringify({ order: 2 }));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HYPERNAB_LOCALE: 'tr-TR', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: data, HYPERNAB_DOWNLOAD_DIR: downloads }, stdio: 'ignore' });
let browser;
try {
  await browserUntil(() => fetch(origin).then(r => r.ok, () => false));
  const token = fs.readFileSync(path.join(data, 'pairing-token'), 'utf8').trim();
  const api = async (route, body) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  browser = await chromiumBrowser(tools.chrome, path.join(dir, 'profile'), []);
  const tab = await browser.create(origin), ev = expression => browser.eval(tab, expression);
  await browser.viewport(tab, 1200, 820);
  await browserUntil(() => ev(`document.querySelector('#connection')?.textContent.includes('aktif')`));
  // Browser-only bridge stub, so nothing on the real desktop can be launched.
  await ev(`(()=>{window.__historyCalls=[];window.hypernabDesktop={action:async(command,id)=>{window.__historyCalls.push([command,id]);if(window.__missing)throw new Error('Dosya taşınmış veya silinmiş. Geçmiş kaydı korunuyor.');return true}};return true})()`);
  await ev(`document.querySelector('#open-history').click()`);
  const ready = count => browserUntil(() => ev(`document.querySelector('#history-rows').getAttribute('aria-busy')==='false' && document.querySelectorAll('.history-row').length===${count}`));
  await ready(50);
  assert.equal(await ev(`document.querySelector('#view-downloads').hidden && document.querySelector('#tabs').hidden`), true);
  assert.equal(await ev(`document.querySelector('.history-name').textContent`), 'İstanbul Öyküsü');
  assert.ok(!(JSON.stringify(await api('/api/history'))).includes('not-for-history'));
  const firstIds = await ev(`[...document.querySelectorAll('.history-row')].map(row=>row.dataset.historyId)`);
  await ev(`document.querySelector('#history-next').click()`); await ready(50);
  const secondIds = await ev(`[...document.querySelectorAll('.history-row')].map(row=>row.dataset.historyId)`);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 100);
  await ev(`document.querySelector('#history-next').click()`); await ready(13);
  assert.equal(await ev(`document.querySelector('#history-next').disabled`), true);
  await ev(`document.querySelector('#history-prev').click()`); await ready(50);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.history-row')].map(row=>row.dataset.historyId)`), secondIds);
  console.log('OK 113 history records paginate 50/50/13 without duplicates; previous page is stable');

  await ev(`(()=>{document.querySelector('#history-search').value='İSTANBUL';document.querySelector('#history-form').requestSubmit();return true})()`); await ready(1);
  await ev(`document.querySelector('[data-history-play]').click()`);
  assert.deepEqual((await ev('window.__historyCalls')).at(-1), ['history-play', seed.at(-1).id]);
  await ev(`document.querySelector('[data-history-location]').click()`);
  assert.deepEqual((await ev('window.__historyCalls')).at(-1), ['history-location', seed.at(-1).id]);
  await ev(`(()=>{window.__missing=true;document.querySelector('[data-history-play]').click();return true})()`);
  await browserUntil(() => ev(`document.querySelector('#history-status').textContent.includes('taşınmış')`));
  assert.equal((await api('/api/history?search=' + encodeURIComponent('İSTANBUL'))).entries.length, 1);
  await ev(`window.__missing=false`);
  console.log('OK Turkish search, SVG play/folder actions and visible missing-file error without deleting history');

  await ev(`document.querySelector('#close-history').click()`);
  assert.equal((await api('/api/queue/clear', {})).removed, 113);
  assert.equal((await api('/api/jobs')).length, 0);
  assert.equal(fs.readFileSync(path.join(downloads, seed.at(-1).file), 'utf8'), 'kept-bytes');
  await browser.navigate(tab, origin);
  await browserUntil(() => ev(`document.querySelector('#connection')?.textContent.includes('aktif')`));
  await ev(`document.querySelector('#open-history').click()`); await ready(50);
  assert.equal(await ev(`document.querySelectorAll('[data-history-play]').length`), 0, 'web page must not claim it can launch local files');
  await browser.screenshot(tab, path.join(dir, 'history-desktop.png'));
  for (const [width, height] of [[720, 700], [360, 740]]) {
    await browser.viewport(tab, width, height);
    assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
    await browser.screenshot(tab, path.join(dir, `history-${width}.png`));
  }
  await ev(`document.querySelector('#open-settings').click()`);
  assert.equal(await ev(`document.querySelector('#view-history').hidden && !document.querySelector('#view-settings').hidden`), true);
  await ev(`document.querySelector('#close-settings').click()`);
  assert.equal(await ev(`!document.querySelector('#view-downloads').hidden && document.querySelector('#view-history').hidden`), true);
  console.log('OK clearing queue keeps file bytes and searchable history after reload; navigation and 720/360px layouts');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill();
  console.log(`Test directory: ${dir}`);
}
