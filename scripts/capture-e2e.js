// Real Firefox/Chrome + the REAL extension + a REAL app on an isolated port (temporary profiles, data and download folders).
// Checks: (1) clicking the video inside an embedded player frame closes the open floating panel, (2) a new source captured while
// the panel is open appears in it without reopening, (3) that extra file row downloads directly.
// Needs internet (small public MDN videos). Never touches the user's own application or data.
// Usage: node scripts/capture-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil, freePort } from './browser-driver.js';
import { installNative, uninstallNative } from './install-native.js';
import { zipFolder } from './zip-store.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-capture-'));
const MP4 = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const WEBM = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm';
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };

const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.capture_${Date.now()}`;
const registration = installNative({ directory: path.join(dir, 'native'), host: nativeHost, port, dataDirectory: path.join(dir, 'data'), downloadDirectory: path.join(dir, 'downloads') });
// The player lives on another origin (another port), exactly like an embedded player frame.
const player = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><video id="v" src="${MP4}" width="640" height="360" muted autoplay loop style="display:block"></video>`);
});
await new Promise(resolve => player.listen(0, '127.0.0.1', resolve));
const top = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Gömülü oynatıcı</title><body style="margin:0;height:2000px"><div style="height:140px"></div><iframe src="http://127.0.0.1:${player.address().port}/player" width="640" height="360" style="display:block;margin-left:100px;border:0" allow="autoplay"></iframe>`);
});
await new Promise(resolve => top.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${top.address().port}/`;
const builds = buildExtensions(path.join(dir, 'extensions'), { nativeHost });
const chromiumKey = JSON.parse(fs.readFileSync(path.join(builds.chromium, 'manifest.json'), 'utf8')).key;
const chromiumId = createHash('sha256').update(Buffer.from(chromiumKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const barBox = `(() => {
  const hosts = [...document.body.children].filter(e => e.style.zIndex === '2147483647'); if (!hosts.length) return null;
  let box = null;
  for (let y = 0; y < document.documentElement.clientHeight; y += 3) for (let x = 0; x < document.documentElement.clientWidth; x += 3) {
    if (document.elementFromPoint(x, y) !== hosts[0]) continue;
    box = box ? { l: Math.min(box.l, x), r: Math.max(box.r, x), t: Math.min(box.t, y), b: Math.max(box.b, y) } : { l: x, r: x, t: y, b: y };
  }
  return box;
})()`;
const height = box => box ? box.b - box.t : 0;

async function run(name, open) {
  const browser = await open();
  try {
    const call = async (route, body) => {
      const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
      const response = await fetch(`${origin}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    };
    const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}popup.html`) : await browserUntil(async () => {
      const worker = (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`);
      return worker?.targetId;
    });
    await wait(800);
    await browser.eval(setup, `browser.storage.local.set({ transport: 'native' }).then(() => true)`).catch(() => browser.eval(setup, `chrome.storage.local.set({ transport: 'native' }).then(() => true)`));
    const tab = await browser.create(pageUrl);
    await browserUntil(async () => Boolean(await browser.eval(tab, barBox)), 40000);
    await wait(6000);
    const openPanel = async () => {
      const closed = await browser.eval(tab, barBox);
      await browser.click(tab, closed.l + 18, Math.round((closed.t + closed.b) / 2));
      return browserUntil(async () => { const box = await browser.eval(tab, barBox); return height(box) > 90 ? box : null; }, 60000);
    };
    let opened = await openPanel();
    check(name, 'gömülü oynatıcıda panel açıldı', height(opened) > 90, `(${height(opened)}px)`);
    await browser.screenshot(tab, path.join(dir, `capture-open-${name}.png`));
    // (1) A click on the video inside the other-origin frame must close the panel.
    await browser.click(tab, 420, 330); await wait(900);
    const afterClick = await browser.eval(tab, barBox);
    check(name, 'iframe içindeki videoya tıklayınca panel kapanır', height(afterClick) > 0 && height(afterClick) < 60, `(${height(afterClick)}px)`);
    // (2) A new source appears while the panel is open: it must show up without reopening.
    opened = await openPanel(); await wait(1500);
    const before = height(await browser.eval(tab, barBox));
    await browser.eval(tab, `fetch(${JSON.stringify(WEBM)}, { mode: 'no-cors' }).then(() => true, () => true)`);
    const grown = await browserUntil(async () => { const box = await browser.eval(tab, barBox); return height(box) > before + 20 ? box : null; }, 40000).catch(() => null);
    await browser.screenshot(tab, path.join(dir, `capture-grown-${name}.png`));
    check(name, 'yeni yakalanan kaynak açık panelde kendiliğinden belirir', Boolean(grown), `(${before}px → ${height(grown)}px)`);
    // (3) The extra file row is a direct download. Its row sits just above the "Ayrıntılar" line at the bottom of the panel.
    if (grown) {
      await browser.click(tab, grown.r - 100, grown.b - 62);
      let job = null;
      await browserUntil(async () => { job = (await call('/api/jobs'))[0]; return job && ['completed', 'failed'].includes(job.status); }, 90000).catch(() => {});
      const file = job?.file && path.join(dir, 'downloads', job.file);
      check(name, 'ek dosya satırı doğrudan indirilir', job?.status === 'completed' && /\.webm$/i.test(job.file || '') && fs.statSync(file).size > 10000, `(${job?.status} ${job?.file || ''} ${job?.error || ''})`);
    }
  } finally { await browser.close(); }
}

try {
  await wait(3000);
  if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), [builds.chromium]));
} catch (error) { console.log('BETİK HATASI ' + error.message); results.push(false); }
finally {
  try {
    const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const status = await (await fetch(origin + '/api/status', { headers })).json();
    const jobs = await (await fetch(origin + '/api/jobs', { headers })).json();
    for (const job of jobs) if (['queued', 'running', 'paused', 'interrupted', 'failed'].includes(job.status)) await fetch(origin + `/api/jobs/${job.id}/cancel`, { method: 'POST', headers, body: '{}' });
    await browserUntil(async () => (await (await fetch(origin + '/api/jobs', { headers })).json()).every(job => !job.settling));
    await fetch(origin + '/api/app/shutdown', { method: 'POST', headers, body: JSON.stringify({ confirm: true, instanceId: status.instanceId }) });
  } catch {}
  uninstallNative(registration.directory); player.close(); top.close();
  console.log(results.length && results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: başarısız var');
  console.log(`çıktı klasörü (ekran görüntüsü için, silinmedi): ${dir}`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
