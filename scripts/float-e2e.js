// End-to-end check of the on-page floating panel with the REAL extension in a REAL Firefox/Chrome (isolated temporary profiles)
// against a REAL Native-launched app server on an isolated port, with temporary data/download folders. The video is a small
// public MP4 (or HD_FLOAT_MEDIA HLS fixture); the player page is local. Never stops the user's application.
// Usage: node scripts/float-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil } from './browser-driver.js';
import { freePort } from './browser-driver.js';
import { installNative, uninstallNative } from './install-native.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-float-'));
const VIDEO = process.env.HD_FLOAT_MEDIA || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };

const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.float_${Date.now()}`;
const registration = installNative({ directory: path.join(dir, 'native'), host: nativeHost, port, dataDirectory: path.join(dir, 'data'), downloadDirectory: path.join(dir, 'downloads') });
const segmented = /m3u8|mpd/.test(VIDEO);
const noisy = process.env.HD_FLOAT_NOISE === '1' && !segmented;
const page = http.createServer((req, res) => {
  if (/^\/noise\/\d+$/.test(req.url)) { res.setHeader('content-type', 'application/octet-stream'); res.end('synthetic unknown non-media response padded beyond sixteen bytes'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // A blob-backed preview supplies a visible player even in browsers without native HLS decoding.
  // The captured manifest is the real public HLS test asset downloaded and verified by the app.
  const play = segmented ? `fetch(${JSON.stringify(VIDEO)}).then(()=>fetch('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4')).then(r=>r.blob()).then(b=>{v.src=URL.createObjectURL(b);v.play().catch(()=>{});}).catch(()=>{});` : `fetch(${JSON.stringify(VIDEO)}).catch(()=>{});`;
  const noise = noisy ? `v.addEventListener('loadeddata',()=>{for(let i=0;i<8;i++)fetch('/noise/'+i).catch(()=>{});},{once:true});` : '';
  res.end(`<!doctype html><meta charset="utf-8"><title>Deneme videosu</title><body style="margin:0;height:2000px"><div style="height:140px"></div><video id="v" src="${segmented ? '' : VIDEO}" width="640" height="360" muted autoplay loop style="display:block;margin-left:100px"></video><script>${noise}${play}</script>`);
});
await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
const pageUrl = process.env.HD_PAGE_URL || `http://127.0.0.1:${page.address().port}/`; // HD_PAGE_URL: open a real site instead (look-only)
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

async function run(name, open) {
  const browser = await open();
  try {
    const call = async (route, body) => {
      const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
      const response = await fetch(`${origin}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    };
    const previousIds = new Set((await call('/api/jobs').catch(() => [])).map(job => job.id));
    const ownJobs = async () => (await call('/api/jobs')).filter(job => !previousIds.has(job.id));
    // Configure the real extension worker; Chrome also has built-in extension
    // workers, so match our background script rather than the first worker.
    const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}popup.html`) : await browserUntil(async () => {
      const worker = (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`);
      return worker?.targetId;
    });
    await wait(800);
    await browser.eval(setup, `browser.storage.local.set({ transport: 'native' }).then(() => true)`).catch(() => browser.eval(setup, `chrome.storage.local.set({ transport: 'native' }).then(() => true)`));
    // The real panel uses a closed shadow root. Confirm the visible duplicate warning with a real mouse click,
    // just like Start; do not bypass it through the engine API or change the extension's safeguards.
    const confirmDuplicate = async originalHeight => {
      const box = await browserUntil(async () => {
        const current = await browser.eval(tab, barBox);
        return current && (current.b - current.t < 100 || current.b - current.t > originalHeight + 60) && current;
      }, 30000);
      if (box.b - box.t < 100) return false;
      check(name, 'aynı kalite için tekrar indirme uyarısı kullanıcı onayı bekler', true);
      await browser.click(tab, box.r - 160, box.b - 40); await wait(600);
      return true;
    };
    const tab = await browser.create(pageUrl);
    await browserUntil(async () => Boolean(await browser.eval(tab, barBox)), 30000);
    await wait(6000); // lets the page capture the file and the automatic (cookieless) look-up finish
    if (!previousIds.size) check(name, 'otomatik ön hazırlık kapalı uygulamayı açmaz', !fs.existsSync(path.join(dir, 'data', 'pairing-token')));
    const closed = await browser.eval(tab, barBox);
    await browser.click(tab, closed.l + 18, Math.round((closed.t + closed.b) / 2)); await wait(process.env.HD_PAGE_URL ? 25000 : 2500);
    if (!process.env.HD_PAGE_URL) await browserUntil(async () => { const box = await browser.eval(tab, barBox); return box && box.b - box.t > 130; }, 45000);
    const opened = await browser.eval(tab, barBox);
    check(name, 'panel açıldı ve içerik geldi', Boolean(opened) && opened.b - opened.t > 90, `(${opened?.b - opened?.t}px)`);
    if (noisy && !process.env.HD_PAGE_URL) {
      const evidence = await browser.eval(setup, `(async()=>{const api=globalThis.browser||globalThis.chrome;const t=(await api.tabs.query({})).find(t=>t.url===${JSON.stringify(pageUrl)});const s=await api.storage.session.get(['tab:'+t.id,'float:'+t.id]);return {unknown:(s['tab:'+t.id]||[]).filter(e=>e.kind==='UNKNOWN').length,engine:s['float:'+t.id]?.sourceInput?.engine,url:s['float:'+t.id]?.sourceInput?.url};})()`);
      check(name, 'gerçek ağdan sekiz bilinmeyen yanıt içinde oynatılan MP4 doğrudan seçildi', evidence.unknown >= 4 && evidence.engine === 'direct' && evidence.url === VIDEO, `(${evidence.unknown} UNKNOWN, ${evidence.engine})`);
    }
    const shot = path.join(dir, `float-${name}.png`); await browser.screenshot(tab, shot); console.log(`     ekran görüntüsü: ${shot}`);
    // Scrolling over the panel (list or not) must never scroll the page behind it, not even at the ends of the list.
    const wheelY = Math.round((closed.b + opened.b) / 2), wheelX = opened.r - 160;
    const scrollBefore = await browser.eval(tab, 'window.scrollY');
    for (let i = 0; i < 10; i++) { await browser.wheel(tab, wheelX, wheelY, 300); await wait(120); }
    for (let i = 0; i < 4; i++) { await browser.wheel(tab, wheelX, wheelY, -300); await wait(120); }
    await wait(500);
    const scrollAfter = await browser.eval(tab, 'window.scrollY');
    check(name, 'panel üzerinde kaydırınca sayfa kaymaz (liste sonunda da)', scrollBefore === scrollAfter, `(önce=${scrollBefore} sonra=${scrollAfter})`);
    if (process.env.HD_PAGE_URL) return; // look-only mode for real sites: no download
    // A same-result refresh USED TO invalidate the existing Start handlers, so accepted jobs left the panel open forever.
    await browser.eval(setup, `(async()=>{const api=globalThis.browser||globalThis.chrome;const t=(await api.tabs.query({})).find(t=>t.url===${JSON.stringify(pageUrl)});await api.tabs.sendMessage(t.id,{type:'hypernab:refresh'});return true;})()`);
    await wait(500);
    // A plain file has no quality list: the panel shows [İndir ↓] and, below it, [Sıraya ekle]. First: download right now.
    await browser.click(tab, segmented ? opened.r - 65 : opened.r - 160, segmented ? closed.b + 90 : opened.b - 52); await wait(600);
    await confirmDuplicate(opened.b - opened.t);
    const feedback = await browser.eval(tab, barBox);
    check(name, 'aynı içerikli yenilemeden sonra kabul edilen indirme paneli kapatır ve kısa bildirim görünür', feedback && feedback.b - feedback.t < 100 && feedback.b - feedback.t > closed.b - closed.t, `(${feedback?.b - feedback?.t}px)`);
    const shotAfter = path.join(dir, `float-after-${name}.png`); await browser.screenshot(tab, shotAfter); console.log(`     tıklama sonrası: ${shotAfter}`);
    let job = null;
    await browserUntil(async () => { job = (await ownJobs())[0]; return job && ['completed', 'failed'].includes(job.status); }, 90000).catch(() => {});
    check(name, 'İndir basınca uygulamada iş oluştu', Boolean(job));
    check(name, 'indirme tamamlandı', job?.status === 'completed', `(${job?.status} ${job?.error || ''})`);
    if (segmented) check(name, 'kalite seçimi gerçek HLS kaynağına uygulanıp doğrulandı', Boolean(job?.formatId) && job?.media?.height > 0, `(${job?.formatId}, ${job?.media?.height}p)`);
    const file = job?.file && path.join(dir, 'downloads', job.file);
    check(name, 'dosya diskte ve boş değil', Boolean(file) && fs.existsSync(file) && fs.statSync(file).size > 10000, file ? `(${fs.existsSync(file) ? fs.statSync(file).size : 0} bayt)` : '');
    // Second: "Sıraya ekle" waits (no download), "Kuyruğu başlat" then runs it.
    await browser.navigate(tab, pageUrl); await browserUntil(async () => Boolean(await browser.eval(tab, barBox)), 30000); await wait(6000);
    const closed2 = await browser.eval(tab, barBox);
    await browser.click(tab, closed2.l + 18, Math.round((closed2.t + closed2.b) / 2)); await wait(2500);
    const opened2 = await browser.eval(tab, barBox);
    const oldStatus = await call('/api/status');
    await call('/api/app/shutdown', { confirm: true, instanceId: oldStatus.instanceId });
    await browserUntil(async () => !await fetch(origin).then(() => true, () => false));
    // Keep the floating panel open. Its old inspect results must recover without extension reload or page refresh.
    await browser.click(tab, segmented ? opened2.r - 33 : opened2.r - 55, segmented ? closed2.b + 90 : opened2.b - 51); await wait(2000);
    await confirmDuplicate(opened2.b - opened2.t);
    await browserUntil(async () => (await ownJobs()).some(item => item.status === 'held'), 75000).catch(async () => { await browser.screenshot(tab, path.join(dir, `restart-${name}.png`)); });
    const afterQueue = await ownJobs();
    const held = afterQueue.find(item => item.status === 'held');
    check(name, 'Sonra ekle: iş listenin altında bekliyor (indirme başlamadı)', Boolean(held) && afterQueue.at(-1) === held, `(${afterQueue.map(item => item.status).join(',')})`);
    check(name, 'panel açıkken motor yeniden başlamasından reload olmadan toparlanır', (await call('/api/status')).instanceId !== oldStatus.instanceId && Boolean(held));
    const started = await call('/api/queue/start', {});
    await browserUntil(async () => { const list = await ownJobs(); return list.every(item => ['completed', 'failed'].includes(item.status)); }, 90000).catch(() => {});
    const final = await ownJobs();
    check(name, 'Kuyruğu başlat: bekleyen iş indi', final.length === 2 && final.every(item => item.status === 'completed') && started.limit === 'all' && final[0].id === afterQueue[0].id, `(${final.map(item => item.status).join(',')})`);
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
  uninstallNative(registration.directory); page.close();
  console.log(results.length && results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: başarısız var');
  console.log(`çıktı klasörü (ekran görüntüsü için, silinmedi): ${dir}`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
