// End-to-end: REAL extension + REAL Native-launched app (isolated temporary profile/data/downloads) on generic test pages that
// show subtitles in three different, site-independent ways. After pressing the page's download button, the finished video file must
// contain the subtitle track (read back with ffprobe/ffmpeg). The video is a small public MP4; the player pages are local.
// Usage: node scripts/subtitle-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil, freePort } from './browser-driver.js';
import { installNative, uninstallNative } from './install-native.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-subtitle-'));
const VIDEO = process.env.HD_FLOAT_MEDIA || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const VTT = 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nBeni çözün, sizi ona götüreyim.\n\n00:00:04.000 --> 00:00:05.000\nÇığ düştü şüphesiz.\n';

const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.subs_${Date.now()}`;
const registration = installNative({ directory: path.join(dir, 'native'), host: nativeHost, port, dataDirectory: path.join(dir, 'data'), downloadDirectory: path.join(dir, 'downloads') });
// Subtitles are off by default; these checks are about putting them in, so the isolated app starts with them on.
fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'queue.json.settings.json'), JSON.stringify({ subtitleMode: 'both', settingsVersion: 3 }));
// Three ways a player may carry subtitles; the extension must not care which one a site uses.
const players = {
  // 1. a normal <track> element (shown by default)
  track: `<video id="v" src="${VIDEO}?v=track" width="640" height="360" muted autoplay loop style="display:block;margin-left:100px"><track kind="subtitles" srclang="tr" label="Türkçe" src="/sub.vtt" default></video>`,
  // 2. cues created by the page's own script, track switched OFF (no address anywhere: nothing a network sniffer could ever see)
  script: `<video id="v" src="${VIDEO}?v=script" width="640" height="360" muted autoplay loop style="display:block;margin-left:100px"></video><script>const t=v.addTextTrack('subtitles','English','en');t.addCue(new VTTCue(0.5,4,'Hello island, free me'));t.addCue(new VTTCue(4,5,'Second line'));t.mode='disabled';</script>`,
  // 3. the same player, but inside a cross-origin iframe (the usual embedded-player layout)
  frame: null
};
const html = (body, title) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;height:2000px"><div style="height:140px"></div>${body}`;
const second = http.createServer((req, res) => { // the iframe's own origin
  if (req.url === '/sub.vtt') { res.setHeader('content-type', 'text/vtt; charset=utf-8'); return res.end(VTT); }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html(players.track.replace('?v=track', '?v=frame'), 'Oynatıcı'));
});
await new Promise(resolve => second.listen(0, 'localhost', resolve));
players.frame = `<iframe src="http://localhost:${second.address().port}/" width="760" height="380" style="border:0;display:block;margin-left:60px"></iframe>`;
const page = http.createServer((req, res) => {
  if (req.url === '/sub.vtt') { res.setHeader('content-type', 'text/vtt; charset=utf-8'); return res.end(VTT); }
  const name = req.url.replace(/^\//, '').split('?')[0] || 'track';
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html(players[name] || players.track, `Deneme ${name}`));
});
await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
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
const ffmpeg = path.join(root, 'tools', 'ffmpeg.exe'), ffprobe = path.join(root, 'tools', 'ffprobe.exe');
const subtitleStreams = file => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=language,title:stream_disposition=default', '-of', 'json', file]).stdout || '{"streams":[]}').streams.filter(s => s.codec_type === 'subtitle');
const subtitleText = file => spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'webvtt', '-'], { encoding: 'utf8' }).stdout || '';

async function run(name, open) {
  const browser = await open();
  try {
    const call = async (route, body) => {
      const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
      const response = await fetch(`${origin}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    };
    const known = new Set();
    const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}options.html`) : await browserUntil(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`)?.targetId);
    await wait(800);
    await browser.eval(setup, `browser.storage.local.set({ transport: 'native' }).then(() => true)`).catch(() => browser.eval(setup, `chrome.storage.local.set({ transport: 'native' }).then(() => true)`));
    for (const [variant, expect] of [['track', { lang: 'tur', text: 'Beni çözün' }], ['script', { lang: 'eng', text: 'Hello island' }], ['frame', { lang: 'tur', text: 'Çığ düştü' }]]) {
      const pageUrl = `http://127.0.0.1:${page.address().port}/${variant}`;
      const tab = await browser.create(pageUrl);
      await browserUntil(async () => Boolean(await browser.eval(tab, barBox)), 40000);
      await wait(6000);
      const closed = await browser.eval(tab, barBox);
      await browser.click(tab, closed.l + 18, Math.round((closed.t + closed.b) / 2)); await wait(2500);
      await browserUntil(async () => { const box = await browser.eval(tab, barBox); return box && box.b - box.t > 90; }, 45000);
      const opened = await browser.eval(tab, barBox);
      if (process.env.HD_DEBUG) console.log('     gather:', await browser.eval(setup, `(async()=>{const api=globalThis.browser||globalThis.chrome;const t=(await api.tabs.query({})).find(t=>t.url===${JSON.stringify(pageUrl)});const g=await Hypernab.gatherSubtitles(api,t.id,4000);const st=await api.storage.session.get([\`subs:\${t.id}\`,\`context:\${t.id}\`]);return JSON.stringify({tracks:g.tracks.map(x=>[x.lang,x.vtt.length]),urls:g.urls,frames:Object.keys(st[\`context:\${t.id}\`]?.frames||{}),subs:Object.keys(st[\`subs:\${t.id}\`]||{})})})()`).catch(error => String(error.message)));
      await browser.click(tab, opened.r - 160, opened.b - 52); await wait(600);
      let job = null;
      await browserUntil(async () => { job = (await call('/api/jobs')).find(item => !known.has(item.id)); return job && ['completed', 'failed'].includes(job.status); }, 90000).catch(() => {});
      if (job) known.add(job.id);
      check(name, `${variant}: indirme tamamlandı`, job?.status === 'completed', `(${job?.status} ${job?.error || ''})`);
      const file = job?.file && path.join(dir, 'downloads', job.file);
      const streams = file && fs.existsSync(file) ? subtitleStreams(file) : [];
      check(name, `${variant}: sayfanın altyazısı videonun içinde`, streams.length === 1 && streams[0].tags?.language === expect.lang && streams[0].disposition?.default === 1, JSON.stringify(streams.map(s => [s.codec_name, s.tags?.language])) + ` sonuç=${JSON.stringify(job?.subtitleResult?.mode)} ${job?.subtitleResult?.note || ''}`);
      check(name, `${variant}: altyazı metni (Türkçe karakterler dahil) doğru`, Boolean(file) && subtitleText(file).includes(expect.text));
      await browser.closeTab(tab);
    }
    // The same video again, same quality: the panel must ask first (nothing is added), and "Yine de indir" must then add a second copy.
    const again = `http://127.0.0.1:${page.address().port}/track`, tab2 = await browser.create(again);
    await browserUntil(async () => Boolean(await browser.eval(tab2, barBox)), 40000); await wait(6000);
    const bar = await browser.eval(tab2, barBox);
    await browser.click(tab2, bar.l + 18, Math.round((bar.t + bar.b) / 2)); await wait(2500);
    await browserUntil(async () => { const box = await browser.eval(tab2, barBox); return box && box.b - box.t > 90; }, 45000);
    const panel = await browser.eval(tab2, barBox), before = (await call('/api/jobs')).length;
    await browser.click(tab2, panel.r - 160, panel.b - 52); await wait(3500);
    const asked = await browser.eval(tab2, barBox);
    await browser.screenshot(tab2, path.join(dir, `duplicate-${name}.png`));
    check(name, 'aynı video aynı kalitede: önce uyarı çıktı, hiçbir şey eklenmedi', (await call('/api/jobs')).length === before && asked.b - asked.t > panel.b - panel.t, `(panel ${panel.b - panel.t}px → ${asked.b - asked.t}px)`);
    await browser.click(tab2, asked.l + 60, asked.b - 30); await wait(2500);
    await browserUntil(async () => (await call('/api/jobs')).length === before + 1, 20000).catch(() => {});
    check(name, "'Yine de indir' ikinci bir kopya ekledi (ayrı iş, dosyalar silinmedi)", (await call('/api/jobs')).length === before + 1, `(${(await call('/api/jobs')).length} iş)`);
    await browser.closeTab(tab2);
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
  uninstallNative(registration.directory); page.close(); second.close();
  console.log(results.length && results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: başarısız var');
  console.log(`çıktı klasörü: ${dir}`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
