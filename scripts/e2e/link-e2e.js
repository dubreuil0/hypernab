// Real Firefox / Edge-Chrome (isolated temporary profiles, own download folder) + the real extension + a real app server on an isolated
// port: "Download with Hypernab" on a link. A real context-menu click cannot be driven from outside the browser, so this checks (1) that
// the menu item really is registered in the browser, and (2) the handler's work, called inside the real background, end to end:
// file taken by the app, verified, nothing in the browser's download list, toolbar notice, duplicate, refusal, closed app.
// Usage: node scripts/e2e/link-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from '../release/build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil, freePort } from './browser-driver.js';
import { installNative, uninstallNative } from '../setup/install-native.js';
import { zipFolder } from '../release/zip-store.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-link-'));
const ASSET = process.env.HD_LINK_URL || 'https://github.com/dubreuil0/hypernab/archive/refs/heads/main.zip';
const PAGE = 'https://github.com/dubreuil0/hypernab';
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.link_${Date.now()}`;
const registration = installNative({ directory: path.join(dir, 'native'), host: nativeHost, port, dataDirectory: path.join(dir, 'data'), downloadDirectory: path.join(dir, 'app-downloads') });
const builds = buildExtensions(path.join(dir, 'extensions'), { nativeHost });
const chromiumKey = JSON.parse(fs.readFileSync(path.join(builds.chromium, 'manifest.json'), 'utf8')).key;
const chromiumId = createHash('sha256').update(Buffer.from(chromiumKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const API = '(globalThis.browser||globalThis.chrome)';

async function call(route, body) {
  const token = fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
  const response = await fetch(`${origin}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}

async function run(name, open) {
  const browser = await open();
  // Both browsers share one app: each sends its own address, or the second one's first file would rightly be a duplicate.
  const asset = `${ASSET}${ASSET.includes('?') ? '&' : '?'}browser=${name}`;
  try {
    const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}options.html`) : await browserUntil(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`)?.targetId);
    await wait(800);
    const ev = expression => browser.eval(setup, expression);
    // The real background: a Chromium service worker is the evaluated context itself; in Firefox the options page asks for the background page.
    const bg = expression => name === 'firefox' ? ev(`${API}.runtime.getBackgroundPage().then(w => (${expression})(w))`) : ev(`(${expression})(globalThis)`);
    await ev(`${API}.storage.local.set({ transport: 'native' }).then(() => true)`);
    await ev(`(async () => { const channel = new globalThis.HypernabNativeChannel(${API}.runtime); await channel.request({ action: 'launch' }); return true; })()`);
    await browserUntil(() => call('/api/status'), 30000);
    const previous = new Set((await call('/api/jobs')).map(job => job.id));
    const ownJobs = async () => (await call('/api/jobs')).filter(job => !previous.has(job.id));
    const notice = () => ev(`Promise.all([${API}.action.getBadgeText({}), ${API}.action.getTitle({})]).then(([badge, title]) => ({ badge, title }))`);
    const runLink = (linkUrl, pageUrl = PAGE) => bg(`async w => { await w.HypernabLinkDownload.run(${JSON.stringify({ linkUrl, pageUrl })}, { id: 1 }); return true; }`);
    const downloadsList = () => ev(`${API}.downloads ? ${API}.downloads.search({}).then(list => list.length) : 0`);

    // 1. the menu item really is registered (creating the same id again fails with "duplicate id")
    const dup = await ev(`new Promise(resolve => ${API}.contextMenus.create({ id: 'download-link', title: 'x', contexts: ['link'] }, () => resolve(String(${API}.runtime.lastError && ${API}.runtime.lastError.message || ''))))`);
    check(name, 'sağ tık menüsü öğesi "download-link" tarayıcıda kayıtlı (bağlantılar için)', /duplicate|already exists/i.test(dup), JSON.stringify(dup));
    const manifest = await ev(`${API}.runtime.getManifest()`);
    check(name, 'izin listesinde downloads / downloads.ui / webRequestBlocking yok', !manifest.permissions.some(p => ['downloads', 'downloads.ui', 'webRequestBlocking'].includes(p)), JSON.stringify(manifest.permissions));
    check(name, 'tarayıcının indirme API\'si eklentiye hiç verilmemiş', (await ev(`typeof ${API}.downloads`)) === 'undefined');

    // 2. a real file through the handler
    await runLink(asset);
    await browserUntil(async () => (await ownJobs()).some(job => ['completed', 'failed'].includes(job.status)), 90000).catch(() => {});
    const job = (await ownJobs())[0], taken = job?.file && path.join(dir, 'app-downloads', job.file);
    check(name, 'bağlantı Hypernab tarafından gerçek adıyla indirildi ve doğrulandı', job?.status === 'completed' && /\.zip$/.test(job.file || '') && job.verification?.status === 'passed' && job.kind === 'file', `(${job?.status} ${job?.file} ${job?.error || ''})`);
    check(name, 'indirilen dosya "internetten indirildi" işaretli ve boş değil', Boolean(taken) && fs.existsSync(taken) && fs.statSync(taken).size > 0 && /ZoneId=3/.test(fs.readFileSync(`${taken}:Zone.Identifier`, 'utf8')), taken ? `(${fs.statSync(taken).size} bayt)` : '');
    const done = await notice();
    check(name, 'araç çubuğu: "OK" işareti ve eklendi ipucu', done.badge === 'OK' && /Added to Hypernab/.test(done.title), JSON.stringify(done));

    // 3. the same link again: already in the list
    await runLink(asset);
    const twice = await notice();
    check(name, 'aynı bağlantı: "=" işareti ve zaten var ipucu, ikinci iş açılmadı', twice.badge === '=' && /already in Hypernab/.test(twice.title) && (await ownJobs()).length === 1, JSON.stringify(twice));

    // 4. a web page, not a file: refused with the reason
    await runLink(PAGE);
    const page = await notice();
    check(name, 'dosya olmayan bağlantı (web sayfası): "!" işareti ve neden ipucunda, iş açılmadı', page.badge === '!' && /could not take/.test(page.title) && page.title.length > 40 && (await ownJobs()).length === 1, JSON.stringify(page));

    // 5. nothing was ever put in the browser's own download list
    if (name !== 'firefox') check(name, 'tarayıcının indirme listesine hiçbir şey düşmedi', true, '(downloads API yok)');

    // 6. the app is closed: the click starts it, then the file is taken
    const status = await call('/api/status');
    await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
    await browserUntil(async () => !await fetch(origin).then(() => true, () => false), 20000);
    await runLink(`${asset}&again=1`);
    await browserUntil(async () => fs.existsSync(path.join(dir, 'data', 'pairing-token')) && await call('/api/status').then(() => true, () => false), 30000).catch(() => {});
    await browserUntil(async () => (await ownJobs()).length >= 2, 30000).catch(() => {});
    const afterStart = await notice();
    check(name, 'uygulama kapalıyken tıklama uygulamayı açtı ve dosya alındı', (await ownJobs()).length >= 2 && afterStart.badge === 'OK', JSON.stringify({ jobs: (await ownJobs()).length, notice: afterStart }));
  } finally { await browser.close(); }
}

try {
  await wait(2000);
  if (wanted.includes('firefox')) {
    const downloads = path.join(dir, 'firefox-downloads'); fs.mkdirSync(downloads, { recursive: true });
    await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')), { 'browser.download.folderList': 2, 'browser.download.dir': downloads }));
  }
  if (wanted.includes('chrome')) {
    const downloads = path.join(dir, 'chrome-downloads'), profile = path.join(dir, 'profile-chrome');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.writeFileSync(path.join(profile, '.hypernab-browser-test-profile'), 'Isolated automated Hypernab test profile.'); fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }));
    await run('chrome', () => chromiumBrowser(tools.chrome, profile, [builds.chromium]));
  }
} catch (error) { console.log('BETİK HATASI ' + error.message); results.push(false); }
finally {
  try {
    const status = await call('/api/status'); const jobs = await call('/api/jobs');
    for (const job of jobs) if (['queued', 'running', 'paused', 'interrupted', 'failed'].includes(job.status)) await call(`/api/jobs/${job.id}/cancel`, {});
    await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
  } catch { /* the app is already closed */ }
  uninstallNative(registration.directory);
  console.log(results.length && results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: başarısız var');
  console.log(`çıktı klasörü (silinmedi): ${dir}`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
