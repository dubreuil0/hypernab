// Look-only diagnosis of a real page with the REAL extension in an isolated Firefox/Chrome (temporary profile, own app on its own
// port, temporary folders). Prints what the extension captured and what the app answers for each candidate; downloads nothing.
// Usage: node scripts/site-diagnose.js <pageUrl> [firefox|chrome]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil, freePort } from './browser-driver.js';
import { installNative, uninstallNative } from './install-native.js';
import { zipFolder } from './zip-store.js';

const pageUrl = process.argv[2], name = process.argv[3] || 'firefox';
if (!/^https?:/.test(pageUrl || '')) throw new Error('Kullanım: node scripts/site-diagnose.js <sayfa adresi> [firefox|chrome]');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-diagnose-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.diagnose_${Date.now()}`;
const registration = installNative({ directory: path.join(dir, 'native'), host: nativeHost, port, dataDirectory: path.join(dir, 'data'), downloadDirectory: path.join(dir, 'downloads') });
const builds = buildExtensions(path.join(dir, 'extensions'), { nativeHost });
const chromiumKey = JSON.parse(fs.readFileSync(path.join(builds.chromium, 'manifest.json'), 'utf8')).key;
const chromiumId = createHash('sha256').update(Buffer.from(chromiumKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const short = value => String(value).length > 150 ? String(value).slice(0, 150) + '…' : value;
const call = async (route, body) => {
  const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
  const response = await fetch(`${origin}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
};

// The app itself (own port, own folders) so the page's candidates can be inspected exactly like the extension would.
const server = spawn(process.execPath, [path.join(import.meta.dirname, '../src/server.js')], { env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') }, stdio: 'ignore', windowsHide: true });
await browserUntil(async () => fs.existsSync(path.join(dir, 'data', 'pairing-token')) && await fetch(origin).then(() => true, () => false), 30000);
const browser = await (name === 'chrome' ? chromiumBrowser(tools.chrome, path.join(dir, 'profile'), [builds.chromium]) : firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'))));
try {
  const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}options.html`) : await browserUntil(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`)?.targetId);
  await wait(800);
  const api = 'typeof browser !== "undefined" ? browser : chrome';
  await browser.eval(setup, `(${api}).storage.local.set({ transport: 'native' }).then(() => true)`);
  const tab = await browser.create(pageUrl);
  await wait(10000);
  // Try to start the player the way a visitor would: play every <video>, then click the middle of the window.
  await browser.eval(tab, `[...document.querySelectorAll('video')].forEach(v => { v.muted = true; v.play().catch(() => {}); }); document.querySelectorAll('video').length`).then(count => console.log('video öğesi (ana belge):', count)).catch(() => {});
  // The player usually sits below the fold (often in an iframe): bring it to the middle and press play like a visitor.
  const spot = await browser.eval(tab, `(() => { const p = [...document.querySelectorAll('iframe')].filter(f => f.getBoundingClientRect().width > 300).concat([...document.querySelectorAll('video')])[0]; if (!p) return null; p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: p.tagName, src: (p.src || p.currentSrc || '').slice(0, 120) }; })()`).catch(() => null);
  console.log('oynatıcı:', JSON.stringify(spot));
  await wait(1500);
  if (spot) { await browser.click(tab, spot.x, spot.y).catch(() => {}); await wait(2500); await browser.click(tab, spot.x, spot.y).catch(() => {}); }
  await wait(25000);
  await browser.screenshot(tab, path.join(dir, 'player.png'));
  const dump = await browser.eval(setup, `(async () => {
    const a = ${api}, tabs = await a.tabs.query({}), out = [];
    for (const t of tabs) { const key = 'tab:' + t.id, data = await a.storage.session.get([key, 'context:' + t.id]); if (data[key]) out.push({ tab: t.url, entries: data[key], context: data['context:' + t.id] }); }
    return JSON.stringify(out);
  })()`);
  const tabs = JSON.parse(dump);
  for (const item of tabs) {
    console.log('\nSEKME', short(item.tab));
    console.log('çerçeveler:', JSON.stringify(Object.fromEntries(Object.entries(item.context?.frames || {}).map(([id, f]) => [id, { url: short(f.url || ''), mediaUrl: short(f.mediaUrl || ''), playerBlob: f.playerBlob, height: f.height, duration: f.duration, drm: f.drm }]))));
    for (const e of item.entries) console.log(`  [${e.kind}] frame=${e.frameId} size=${e.size ?? '-'} mime=${e.mime || '-'} partial=${e.partial} range=${e.rangeLimited} ${short(e.url)}`);
  }
  await browser.screenshot(tab, path.join(dir, 'page.png'));
  // Ask the app about every captured stream/file directly (cookieless, like the automatic look-up).
  const entries = tabs.flatMap(item => item.entries).slice(0, 14);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.url)) continue; seen.add(e.url);
    const engine = ['VIDEO', 'OTHER', 'AUDIO'].includes(e.kind) ? 'direct' : 'extractor';
    try {
      const info = await call('/api/inspect', { url: e.url, engine, referer: e.frameUrl || pageUrl, pageUrl, noBrowser: true });
      console.log(`\nINSPECT ${engine} ${short(e.url)}\n  → seçenek=${info.options?.length || 0} süre=${info.duration || '-'} boyut=${info.filesize || '-'} uzantı=${info.extension || '-'} not=${info.qualityNote || '-'}`);
      for (const o of (info.options || []).slice(0, 8)) console.log(`    ${o.label} ${o.filesize || ''}`);
    } catch (error) { console.log(`\nINSPECT ${engine} ${short(e.url)}\n  → HATA ${error.message}`); }
  }
} catch (error) { console.log('BETİK HATASI', error.stack || error.message);
} finally {
  await browser.close();
  try {
    const status = await call('/api/status');
    await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
  } catch {}
  uninstallNative(registration.directory); server.kill();
  console.log(`\nçıktı klasörü: ${dir}`);
  process.exit(0);
}
