// Draws the real on-page panel (the shipped content scripts) in a real browser for a look at it: a page with a video-shaped box and a
// stubbed extension answer (several sounds, several qualities), in the app's dark/light themes and accents. Saves screenshots only;
// isolated temporary profile. Usage: node scripts/e2e/panel-visual.js [firefox] [chrome]
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
const dir = fs.mkdtempSync(path.join(base, 'hypernab-panel-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const builds = buildExtensions(path.join(dir, 'ext'));
const built = builds.chromium;

const looks = [['dark', 'green'], ['light', 'violet'], ['system', 'blue']];
const result = look => ({ ok: true, title: 'Örnek film adı — bölüm 3 (uzun bir başlık satırı)', duration: '42:10', defaultOptionId: 'v1080',
  audioTracks: [{ id: 'a0', name: 'Türkçe Dublaj', language: 'tr', default: true }, { id: 'a1', name: 'Original', language: 'en' }, { id: 'a2', name: 'Deutsch', language: 'de' }], audioActive: 'a1', audioPick: { id: 'a1', why: 'playing' },
  options: [{ id: 'v1080', label: '1080p · MP4 · H.264', size: '~820 MB', recommended: true, audio: 'merged', height: 1080 }, { id: 'v720', label: '720p · MP4 · H.264', size: '~410 MB', recommended: true, audio: 'merged', height: 720 }, { id: 'v360', label: '360p · MP4', size: '~120 MB', recommended: true, audio: 'merged', height: 360 }],
  files: [], look });

const page = look => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#e9ecef;font:14px sans-serif">
<div style="position:absolute;left:100px;top:140px;width:640px;height:360px;background:#345"><video id="v" style="width:640px;height:360px"></video></div>
<script>
window.browser = { runtime: { sendMessage: async m => m.type === 'hypernab:float' && m.action === 'inspect' ? ${JSON.stringify(result(look))} : { ok: true } } };
</script>
<script src="/strings.js"></script><script src="/ds.js"></script><script src="/panel-css.js"></script><script src="/content.js"></script>
<script>setTimeout(() => document.getElementById('v').dispatchEvent(new Event('playing')), 300);</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = { '/strings.js': path.join(built, 'strings.js'), '/ds.js': path.join(built, 'ds.js'), '/panel-css.js': path.join(built, 'panel-css.js'), '/content.js': path.join(built, 'content.js') }[url.pathname];
  if (file) { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(file)); return; }
  const [theme, accent] = (url.searchParams.get('look') || 'dark-green').split('-');
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page({ theme, accent }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

async function run(name, launch, scheme) {
  let browser;
  try {
    browser = await launch();
    for (const [theme, accent] of looks) {
      const tab = await browser.create(`${origin}?look=${theme}-${accent}`);
      await browser.navigate(tab, `${origin}?look=${theme}-${accent}`);
      if (browser.viewport) await browser.viewport(tab, 900, 640);
      await sleep(1200);
      await browser.click(tab, 692, 119); await sleep(700);           // the button
      await browser.screenshot(tab, path.join(shots, `panel-${name}-${theme}-${accent}.png`));
      await browser.click(tab, 590, 261); await sleep(400);           // the sound list
      await browser.screenshot(tab, path.join(shots, `panel-${name}-${theme}-${accent}-sound.png`));
      console.log(`OK   [${name}] ${theme}/${accent}`);
      await browser.closeTab(tab);
    }
  } catch (error) { console.log(`HATA [${name}] ${error.message}`); process.exitCode = 1; }
  finally { await browser?.close(); }
}
if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), []));
if (wanted.includes('firefox')) await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
server.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`Ekran görüntüleri: ${shots}`);

