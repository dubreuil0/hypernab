// Real browser / installed Native Messaging integration. Uses a separate host, data and profiles.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from './build-extensions.js';
import { installNative, uninstallNative } from './install-native.js';
import { chromiumBrowser, firefoxBrowser, freePort, browserUntil } from './browser-driver.js';
import { zipFolder } from './zip-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const installedOnly = process.argv.includes('--installed-only');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', installedOnly ? 'driver.json' : 'browsers.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-native-browsers-'));
const reports = path.join(root, 'reports'); fs.mkdirSync(reports, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reports, `native-browsers-${stamp}.json`);
const host = `com.hypernab.test_${Date.now()}`, port = await freePort();
const dataDirectory = path.join(dir, 'data'), downloadDirectory = path.join(dir, 'downloads');
const native = installNative({ directory: path.join(dir, 'host'), host, port, dataDirectory, downloadDirectory });
const builds = buildExtensions(path.join(dir, 'extensions'), { nativeHost: host });
const addon = zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'));
const report = { createdAt: new Date().toISOString(), isolated: true, nativeHost: host, browsers: [], simultaneous: null };
report.expectedBrowsers = installedOnly ? ['Firefox', 'Edge'] : ['Firefox', 'Chrome for Testing', 'Edge', 'Brave'];
const open = [];
const media = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8';
const api = async (route, body) => {
  const token = fs.readFileSync(path.join(dataDirectory, 'pairing-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
};
const click = (browser, tab, selector) => browser.eval(tab, `(()=>{const n=document.querySelector(${JSON.stringify(selector)}); if(!n || n.disabled) throw new Error('Control unavailable: '+${JSON.stringify(selector)}); n.click(); return true;})()`);
const text = (browser, tab, selector) => browser.eval(tab, `document.querySelector(${JSON.stringify(selector)})?.textContent`);
async function popup(browser, extensionUrl) {
  const tab = await browser.create(extensionUrl + 'popup.html', true);
  await browserUntil(() => browser.eval(tab, `typeof initialized !== 'undefined'`));
  await browser.eval(tab, 'initialized'); return tab;
}
async function capturePage(browser, title) {
  const tab = await browser.create('https://example.com', false);
  await wait(4000); // a freshly started Chromium wakes the extension's service worker a moment later; earlier requests are not seen
  await browser.eval(tab, `(()=>{document.title=${JSON.stringify(title)};const video=document.createElement('video');video.controls=true;video.muted=true;video.src=${JSON.stringify(media)};document.body.replaceChildren(video);video.play().catch(()=>{});fetch(${JSON.stringify(media)}).catch(()=>{});return true;})()`);
  // fetch: what hls.js-style players do; browsers without native HLS (Chrome for Testing has no proprietary codecs) still request it.
  return tab;
}
async function runBrowser(family, browser, extensionUrl, first = false) {
  open.push(browser);
  const result = { browser: family, version: browser.name, passed: false, checks: {} }; report.browsers.push(result);
  const title = `Hypernab ${family} ${randomUUID().slice(0, 6)} — gerçek test`;
  let panel;
  try {
    const page = await capturePage(browser, title);
    panel = await popup(browser, extensionUrl);
    result.checks.nativeTransport = await text(browser, panel, '#transport-state'); assert.match(result.checks.nativeTransport, /Native Messaging/);
    if (first) {
      assert.equal(fs.existsSync(path.join(dataDirectory, 'pairing-token')), false, 'Opening the panel must not launch the application.');
      await browser.eval(panel, 'ensureReady(true).then(()=>syncJobs())'); // explicit download-path launch, not desktop Show
    }
    await browserUntil(async () => /senkron/.test(await text(browser, panel, '#connection')), 20000);
    const before = await api('/api/status');
    result.checks.explicitLaunch = first ? true : 'already running';
    await click(browser, panel, '#refresh');
    await browserUntil(() => browser.eval(panel, `(async()=>{const data=await browserApi.storage.session.get('tab:'+currentTab.id);return (data['tab:'+currentTab.id]||[]).some(e=>e.kind==='HLS' && e.observedBy==='network');})()`), 20000);
    await click(browser, panel, '#refresh');
    result.checks.realNetworkCapture = true;
    // The captured manifest card lists its real qualities by itself; pick the lowest and press the card's own "İndir ↓".
    const card = `Array.from(document.querySelectorAll('#media article')).find(n=>n.textContent.includes('HLS'))`;
    await browserUntil(() => browser.eval(panel, `Boolean(${card}?.querySelector('select.card-select'))`), 75000);
    const options = (await browser.eval(panel, `Array.from(${card}.querySelectorAll('select.card-select option')).map(o=>({id:o.value,label:o.textContent}))`))
      .map(option => ({ ...option, height: Number(/(\d{3,4})p/.exec(option.label)?.[1]) || null }));
    assert.ok(options.length >= 2, 'Real HLS quality choices must be available.');
    const highest = options[0], selected = options.at(-1);
    assert.equal(await browser.eval(panel, `${card}.querySelector('select.card-select').value`), highest.id);
    await browser.eval(panel, `(()=>{const n=${card}.querySelector('select.card-select');n.value=${JSON.stringify(selected.id)};n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    result.checks.quality = { offered: options.length, defaultHeight: highest.height, chosenHeight: selected.height };
    const countBefore = (await api('/api/jobs')).length;
    await browser.eval(panel, `(()=>{${card}.querySelector('button.primary').click();return true;})()`);
    const job = await browserUntil(async () => (await api('/api/jobs')).find(job => job.title === title), 15000);
    assert.equal(job.formatId, selected.id); assert.equal(job.host, 'example.com');
    assert.equal((await api('/api/jobs')).length, countBefore + 1);
    await browser.eval(panel, 'syncJobs()');
    await browser.eval(panel, `(()=>{const row=Array.from(document.querySelectorAll('#jobs article')).find(n=>n.querySelector('strong')?.textContent===${JSON.stringify(title)}); const b=Array.from(row.querySelectorAll('button')).find(n=>n.textContent==='Duraklat'); if(!b) throw new Error('Pause not found'); b.click();return true;})()`);
    await browserUntil(async () => (await api('/api/jobs')).find(j => j.id === job.id)?.status === 'paused', 15000);
    await browserUntil(async () => !(await api('/api/jobs')).find(j => j.id === job.id)?.settling, 15000);
    await browser.eval(panel, 'syncJobs()');
    await browser.eval(panel, `(()=>{const row=Array.from(document.querySelectorAll('#jobs article')).find(n=>n.querySelector('strong')?.textContent===${JSON.stringify(title)});Array.from(row.querySelectorAll('button')).find(n=>n.textContent==='Devam et').click();return true;})()`);
    result.checks.pauseResumeSameId = true;
    await browser.closeTab(panel); panel = null;
    await wait(1000);
    assert.equal((await api('/api/status')).processId, before.processId, 'Application must survive closing the native port/browser page.');
    panel = await popup(browser, extensionUrl);
    await browserUntil(async () => /senkron/.test(await text(browser, panel, '#connection')));
    assert.equal((await api('/api/jobs')).length, countBefore + 1);
    result.checks.reopenWithoutDuplicate = true;
    const completed = await browserUntil(async () => {
      const value = (await api('/api/jobs')).find(j => j.id === job.id);
      if (value?.status === 'failed') throw new Error(`Download failed: ${value.error}`);
      return value?.status === 'completed' && value;
    }, 150000);
    assert.equal(completed.media.height, selected.height); assert.equal(completed.media.audio, true);
    result.checks.verifiedOutput = { height: completed.media.height, duration: completed.media.duration, audio: completed.media.audio, bytes: completed.total };
    result.checks.applicationOutlivesNativePort = true;
    await browser.eval(panel, 'syncJobs()');
    const screenshot = path.join(reports, `${family.replaceAll(' ', '-')}-${stamp}.png`);
    // Firefox's WebDriver BiDi cannot capture extension (moz-extension) pages; that is a tool limit, not a failure.
    try { await browser.screenshot(panel, screenshot); result.screenshot = path.relative(root, screenshot).replaceAll('\\', '/'); }
    catch (error) { result.screenshot = `alınamadı: ${error.message}`; }
    result.passed = true;
    return { browser, panel, page, extensionUrl, jobId: job.id, instanceId: before.instanceId };
  } catch (error) {
    result.error = String(error.message).replace(/https?:\/\/[^\s]+/g, '[source]');
    if (panel) { try { result.panelText = String(await browser.eval(panel, `document.querySelector('#media').innerText + ' | ' + document.querySelector('#status').innerText`)).slice(0, 400); } catch {} }
    console.log(`${family}: FAILED ${result.error}`); return { browser, panel, extensionUrl, failed: true };
  } finally { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
}

let firefox;
try {
  console.log('Starting real Firefox (isolated/headless).');
  const ff = await firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), addon);
  firefox = await runBrowser('Firefox', ff, ff.extensionUrl, true);
  const chromiumCases = installedOnly ? [['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']] : [['Chrome for Testing', tools.chrome], ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'], ['Brave', tools.brave]];
  for (const [family, binary] of chromiumCases) {
    try {
      console.log(`Starting real ${family} (isolated/headless).`);
      const browser = await chromiumBrowser(binary, path.join(dir, `profile-${family.replaceAll(' ', '-')}`), [builds.chromium]);
      const current = await runBrowser(family, browser, `chrome-extension://${native.chromiumId}/`, firefox?.failed && !(await api('/api/status').catch(() => null)));
      if ((family === 'Chrome for Testing' || installedOnly && family === 'Edge') && !current.failed && firefox?.panel) {
        const ffJobs = await firefox.browser.eval(firefox.panel, `client.request('/api/jobs')`);
        const chromeJobs = await browser.eval(current.panel, `client.request('/api/jobs')`);
        assert.deepEqual(ffJobs.map(j => j.id), chromeJobs.map(j => j.id));
        report.simultaneous = { passed: true, browsers: ['Firefox', family], sameJobIds: true };
      }
      await browser.close(); open.splice(open.indexOf(browser), 1);
    } catch (error) { report.browsers.push({ browser: family, passed: false, error: error.message }); }
  }
} catch (error) { report.error = error.message; }
finally {
  for (const browser of open) { try { await browser.close(); } catch {} }
  try {
    const status = await api('/api/status');
    assert.equal(path.resolve(status.directory), path.resolve(downloadDirectory));
    const jobs = await api('/api/jobs');
    for (const job of jobs) if (['running', 'queued', 'paused', 'interrupted', 'failed'].includes(job.status)) await api(`/api/jobs/${job.id}/cancel`, {});
    await browserUntil(async () => (await api('/api/jobs')).every(j => !j.settling), 20000);
    await api('/api/app/shutdown', { confirm: true, instanceId: status.instanceId });
  } catch (error) { report.cleanupNote = error.message; }
  await wait(2000);
  try { uninstallNative(native.directory); } catch (error) { report.cleanupNote = error.message; }
  report.passed = report.browsers.length === report.expectedBrowsers.length && report.browsers.every(b => b.passed) && report.simultaneous?.passed === true;
  report.testDirectory = dir;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, passed: report.passed, browsers: report.browsers.map(b => ({ browser: b.browser, passed: b.passed, error: b.error })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
