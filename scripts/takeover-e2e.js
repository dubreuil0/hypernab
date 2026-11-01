// Real Firefox / Chrome (isolated temporary profiles, their own download folder) + the real extension + a real app server on an
// isolated port. A real file from the project's public release (a redirect to a signed address with "attachment") is downloaded by
// the browser; this checks what the takeover does with the browser's download in six situations. Never touches the user's app,
// profile or Downloads folder.
// Usage: node scripts/takeover-e2e.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil, freePort } from './browser-driver.js';
import { installNative, uninstallNative } from './install-native.js';
import { zipFolder } from './zip-store.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-takeover-'));
// The project's own source archive: a real ZIP the server builds on request (no length announced, redirect to a signed address,
// "attachment" name chosen by the server).
const ASSET = process.env.HD_TAKEOVER_URL || 'https://github.com/dubreuil0/hypernab/archive/refs/heads/main.zip';
const NAME = process.env.HD_TAKEOVER_NAME || 'hypernab-main.zip';
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const port = await freePort(), origin = `http://127.0.0.1:${port}`, nativeHost = `com.hypernab.takeover_${Date.now()}`;
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

async function run(name, downloadDirectory, open) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
  const browser = await open();
  try {
    const setup = browser.extensionUrl ? await browser.create(`${browser.extensionUrl}options.html`) : await browserUntil(async () => (await browser.targets()).find(target => target.type === 'service_worker' && target.url === `chrome-extension://${chromiumId}/background.js`)?.targetId);
    await wait(800);
    const ev = expression => browser.eval(setup, expression);
    await ev(`${API}.storage.local.set({ transport: 'native', takeover: { enabled: true, minBytes: 0, autoTypes: [], excludedHosts: [] } }).then(() => true)`);
    await ev(`(async () => { const channel = new globalThis.HypernabNativeChannel(${API}.runtime); await channel.request({ action: 'launch' }); return true; })()`);
    await browserUntil(() => call('/api/status'), 30000);
    // Messages to the background come from the prompt page (an extension page), exactly like the real window does; a Chrome
    // service worker cannot message itself.
    let view = null; // the prompt page: it closes itself when no download is waiting, as it should
    const hub = await browser.create(browser.extensionUrl ? `${browser.extensionUrl}options.html` : `chrome-extension://${chromiumId}/options.html`);
    const message = payload => browser.eval(hub, `${API}.runtime.sendMessage(${JSON.stringify(payload)})`);
    // Browsers allow one automatic download per page; a real user clicks on a page each time, so every download gets a fresh tab.
    let tab = null;
    const trigger = async () => {
      // A new tab opens in the window that was focused last, which may be the prompt popup: go back to the main window first.
      await ev(`${API}.windows.getAll({ windowTypes: ['normal'] }).then(all => ${API}.windows.update(all[0].id, { focused: true })).then(() => true)`).catch(() => {});
      const old = tab; tab = await browser.create('about:blank');
      if (old) await browser.closeTab(old).catch(() => {});
      await browser.eval(tab, `setTimeout(() => { location.href = ${JSON.stringify(ASSET)}; }, 0), true`);
    };
    const pending = async () => (await ev(`${API}.storage.session.get('takeover:pending').then(v => v['takeover:pending'] || [])`)) || [];
    const downloadsList = () => ev(`${API}.downloads.search({}).then(list => list.map(d => ({ id: d.id, state: d.state, paused: d.paused, name: (d.filename || '').split(/[\\\\/]/).pop(), url: d.url })))`);
    const inDirectory = () => fs.readdirSync(downloadDirectory).filter(file => !file.endsWith('.crdownload') && !file.endsWith('.part'));
    const previous = new Set((await call('/api/jobs')).map(job => job.id)); // jobs of an earlier browser in this run do not count
    const clearDirectory = () => { for (const entry of fs.readdirSync(downloadDirectory)) fs.rmSync(path.join(downloadDirectory, entry), { force: true }); };
    // Done = the browser reports every download complete (a file that is still being written does not count).
    const browserFinished = () => browserUntil(async () => { const list = await downloadsList(); return list.length > 0 && list.every(d => d.state === 'complete') && inDirectory().includes(NAME); }, 60000).catch(() => {});
    const ownJobs = async () => (await call('/api/jobs')).filter(job => !previous.has(job.id));
    // The prompt window the extension itself opened (not the test tab that shows the same page).
    const promptWindow = async () => (await ev(`${API}.storage.session.get('takeover:window').then(v => v['takeover:window'] ? ${API}.windows.get(v['takeover:window']).then(() => true, () => false) : false)`));

    // 1. Paused while the user decides; the window is there; nothing was cancelled or taken yet.
    await trigger();
    await browserUntil(async () => (await pending()).length === 1, 40000);
    const list1 = await downloadsList();
    // Firefox holds the response itself: the browser has no download at all. Chrome/Edge cannot, so theirs is paused (and hidden).
    const held = name === 'firefox';
    check(name, held ? 'Firefox: dosya tarayıcıya hiç düşmedi (indirme listesi boş), onay penceresi açık' : 'tarayıcı indirmesi duraklatıldı ve onay penceresi açıldı', held ? list1.length === 0 && await promptWindow() : list1.length === 1 && (list1[0].paused === true || list1[0].state === 'interrupted') && await promptWindow(), JSON.stringify(list1.map(d => ({ paused: d.paused, state: d.state }))));
    check(name, 'karar verilene kadar uygulamada iş yok, dosya yok', (await ownJobs()).length === 0 && inDirectory().length === 0);
    // The prompt window opens in the middle of the browser window (a maximized browser: the middle of its monitor).
    await wait(900); // the window may still be settling its height around its own centre
    const wins = await browser.eval(hub, `${API}.windows.getAll().then(list => list.map(w => ({ type: w.type, left: w.left, top: w.top, width: w.width, height: w.height })))`);
    const popup = wins.find(w => w.type === 'popup' && w.width < 700), parent = wins.find(w => w.type === 'normal');
    check(name, 'onay penceresi tarayıcı penceresinin ortasında açıldı', Boolean(popup && parent) && Math.abs(popup.left + popup.width / 2 - (parent.left + parent.width / 2)) <= 60 && Math.abs(popup.top + popup.height / 2 - (parent.top + parent.height / 2)) <= 140, JSON.stringify({ popup, parent }));
    // The prompt page itself, against the real background.
    const promptUrl = browser.extensionUrl ? `${browser.extensionUrl}download-prompt.html` : `chrome-extension://${chromiumId}/download-prompt.html`;
    view = await browser.create(promptUrl);
    await browserUntil(() => browser.eval(view, `!document.getElementById('card').hidden`), 20000);
    const ui = await browser.eval(view, `({ name: document.getElementById('name').textContent, meta: document.getElementById('meta').textContent, dir: document.getElementById('directory').textContent, now: document.getElementById('now').textContent, buttons: ['now','later','cancel'].every(id => !document.getElementById(id).disabled), height: window.innerHeight })`);
    check(name, 'onay penceresi ad, kaynak, boyut ve kayıt yerini gösterir', ui.name === NAME && ui.meta.includes('github.com') && ui.meta.length > 12 && ui.dir.includes('app-downloads') && ui.buttons, JSON.stringify(ui));
    await browser.screenshot(view, path.join(dir, `prompt-${name}.png`));
    // 1b. İndir
    const clicked = Date.now();
    await browser.eval(view, `document.getElementById('now').click(), true`);
    // Time from the click until the first byte of the file is in (or the job is registered at all).
    let registered = null, firstByte = null;
    await browserUntil(async () => {
      const own = await ownJobs(), first = own[0];
      if (first && registered === null) registered = Date.now() - clicked;
      if (first && firstByte === null && (first.downloaded > 0 || first.progress > 0 || ['completed', 'failed'].includes(first.status))) firstByte = Date.now() - clicked;
      return own.some(job => ['completed', 'failed'].includes(job.status));
    }, 60000, 100);
    console.log(`SÜRE [${name}] tıklamadan işin görünmesine ${registered} ms, ilk bayta ${firstByte} ms`);
    console.log(`TARAYICI SEKMESİ [${name}] ${await browser.eval(tab, 'location.href + " | " + document.title + " | " + document.body?.innerText?.slice(0, 80)')}`);
    const job = (await ownJobs())[0], taken = job?.file && path.join(dir, 'app-downloads', job.file);
    check(name, 'İndir: Hypernab dosyayı gerçek adıyla indirip doğruladı', job?.status === 'completed' && new RegExp(`^${NAME.replace(/[.]/g, '\\.')}$|^${NAME.replace(/\.zip$/, '')} \\(\\d+\\)\\.zip$`).test(job.file || '') && job.verification?.status === 'passed' && job.verification?.format === 'zip' && job.kind === 'file', `(${job?.status} ${job?.file} ${job?.error || ''})`);
    check(name, 'indirilen dosya "internetten indirildi" işaretli ve boş değil', Boolean(taken) && fs.existsSync(taken) && fs.statSync(taken).size > 0 && /ZoneId=3/.test(fs.readFileSync(`${taken}:Zone.Identifier`, 'utf8')), taken ? `(${fs.statSync(taken).size} bayt)` : '');
    const after1 = await downloadsList();
    check(name, 'İndir sonrası tarayıcıda yinelenen indirme/dosya kalmadı', after1.length === 0 && inDirectory().length === 0, JSON.stringify(after1));
    await browserUntil(async () => !(await pending()).length, 10000);

    // 2. Tarayıcı ile indir: the browser finishes it by itself.
    await trigger(); await browserUntil(async () => (await pending()).length === 1, 40000);
    await message({ type: 'hypernab:takeover:decide', id: (await pending())[0].id, choice: 'browser' });
    await browserFinished();
    check(name, 'Tarayıcı ile indir: dosya tarayıcının klasörüne tamam indi, uygulamada yeni iş yok', inDirectory().includes(NAME) && fs.statSync(path.join(downloadDirectory, NAME)).size > 1000 && (await ownJobs()).length === 1, JSON.stringify({ files: inDirectory(), jobs: (await ownJobs()).length, browser: await downloadsList() }));
    clearDirectory(); await ev(`${API}.downloads.erase({}).then(() => true)`);

    // 3. İptal
    await trigger(); await browserUntil(async () => (await pending()).length === 1, 40000);
    await message({ type: 'hypernab:takeover:decide', id: (await pending())[0].id, choice: 'cancel' });
    await wait(2500);
    check(name, 'İptal: ne dosya ne iş ne tarayıcı kaydı kaldı', inDirectory().length === 0 && (await ownJobs()).length === 1 && (await downloadsList()).filter(d => d.state !== 'interrupted').length === 0, JSON.stringify(await downloadsList()));

    // 4. Pencere kapatılırsa tarayıcı devam eder
    await trigger(); await browserUntil(async () => (await pending()).length === 1, 40000);
    await browserUntil(promptWindow, 20000); // the window opens a moment after the record is written
    await ev(`${API}.storage.session.get('takeover:window').then(v => ${API}.windows.remove(v['takeover:window'])).then(() => true)`).catch(() => {});
    await browserFinished();
    check(name, 'Pencere kapatılınca indirme tarayıcıda kaldığı yerden bitti (bekleyen istek iptal olsa da yeniden istenir)', inDirectory().includes(NAME), JSON.stringify({ files: inDirectory(), browser: await downloadsList(), pending: (await pending()).length }));
    clearDirectory(); await ev(`${API}.downloads.erase({}).then(() => true)`);

    // 5. Sonra ekle (aynı bağlantı listede olduğu için "yine de" ile)
    await trigger(); await browserUntil(async () => (await pending()).length === 1, 40000);
    const dupView = await message({ type: 'hypernab:takeover:next' });
    check(name, 'aynı bağlantı listede varsa pencere bunu bildirir', dupView?.duplicate === true);
    await message({ type: 'hypernab:takeover:decide', id: dupView.id, choice: 'later', allowDuplicate: true });
    await browserUntil(async () => (await ownJobs()).length === 2, 20000).catch(() => {});
    const jobs = await ownJobs();
    check(name, 'Sonra ekle: iş bekliyor, dosya henüz inmedi, tarayıcı kaydı silindi', jobs.length === 2 && jobs[1].status === 'held' && !jobs[1].file && (await downloadsList()).length === 0 && inDirectory().length === 0, JSON.stringify({ jobs: jobs.map(item => [item.status, item.file]), browser: await downloadsList(), files: inDirectory().map(file => [file, fs.statSync(path.join(downloadDirectory, file)).size, Math.round((Date.now() - fs.statSync(path.join(downloadDirectory, file)).mtimeMs) / 1000) + 's önce']) }));
    await call('/api/queue/start', {});
    await browserUntil(async () => (await ownJobs()).every(item => item.status === 'completed'), 60000).catch(() => {});
    const done = await ownJobs();
    check(name, 'kuyruk başlatılınca bekleyen dosya adı çakışmadan indi', done.every(item => item.status === 'completed') && new Set(done.map(item => item.file)).size === 2, `(${done.map(item => item.file).join(' | ')})`);
    await browser.closeTab(view).catch(() => {});

    // 6. Uygulama kapalıyken tarayıcı hiç duraklatılmaz
    const status = await call('/api/status');
    await call('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
    await browserUntil(async () => !await fetch(origin).then(() => true, () => false), 20000);
    // The window of step 5 was answered through the background, so it is still open; close it as a user would.
    await ev(`${API}.storage.session.get('takeover:window').then(v => v['takeover:window'] ? ${API}.windows.remove(v['takeover:window']) : null).then(() => true, () => true)`);
    await wait(500);
    clearDirectory(); await ev(`${API}.downloads.erase({}).then(() => true)`);
    await trigger();
    await browserFinished();
    const state = { files: inDirectory(), pending: (await pending()).length, window: await promptWindow() };
    check(name, 'uygulama kapalıyken tarayıcı dosyayı kendisi indirdi, pencere açılmadı', state.files.includes(NAME) && state.pending === 0 && !state.window, JSON.stringify(state));
  } finally { await browser.close(); }
}

try {
  await wait(2000);
  if (wanted.includes('firefox')) {
    const downloads = path.join(dir, 'firefox-downloads');
    await run('firefox', downloads, () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')), { 'browser.download.folderList': 2, 'browser.download.dir': downloads, 'browser.download.useDownloadDir': true, 'browser.download.always_ask_before_handling_new_types': false, 'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,application/x-yaml,text/yaml' }));
  }
  if (wanted.includes('chrome')) {
    const downloads = path.join(dir, 'chrome-downloads'), profile = path.join(dir, 'profile-chrome');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.writeFileSync(path.join(profile, '.hypernab-browser-test-profile'), 'Isolated automated Hypernab test profile.'); fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads } }));
    await run('chrome', downloads, () => chromiumBrowser(tools.chrome, profile, [builds.chromium]));
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
  console.log(`çıktı klasörü (ekran görüntüleri, silinmedi): ${dir}`);
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
