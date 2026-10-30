import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { buildExtensions } from '../scripts/build-extensions.js';

function load(context, file) { return vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context); }
function popup({ family = 'browser', storage = { token: 'b'.repeat(64) }, handler, nativeHandler, sessionData } = {}) {
  const nodes = new Map(), calls = [], updates = [], hooks = {}, tab = { id: 3, url: 'https://film.example.org/watch', title: 'Gerçek Türkçe ad' };
  function node(tag = 'div') { return { tag, value: '', textContent: '', disabled: false, hidden: false, className: '', children: [], events: {}, addEventListener(event, fn) { this.events[event] = fn; }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } }; }
  const api = {
    ...(nativeHandler ? { runtime: { connectNative() {} } } : {}),
    tabs: { async query() { return [tab]; }, onUpdated: { addListener(fn) { hooks.updated = fn; } }, onActivated: { addListener(fn) { hooks.activated = fn; } } },
    storage: { onChanged: { addListener(fn) { hooks.changed = fn; } }, local: { async get() { return storage; }, async set(value) { Object.assign(storage, value); updates.push(structuredClone(value)); } }, session: { async get() { return sessionData || { 'tab:3': [{ url: 'https://cdn.example.org/master.m3u8?secret=hidden', kind: 'HLS', host: 'cdn.example.org', frameId: 7, frameUrl: 'https://player.example.org/embed?session=private' }] }; } } }
  };
  const context = vm.createContext({ URL, AbortSignal, crypto: webcrypto, setTimeout: fn => { Promise.resolve().then(fn); return 1; }, clearTimeout() {},
    ...(nativeHandler ? { HypernabNativeChannel: class { constructor() { this.closed = false; } request(command) { return nativeHandler(command); } close() { this.closed = true; } } } : {}),
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node },
    [family]: api,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const custom = await handler?.(url, options, storage);
      if (custom instanceof Error) throw custom;
      if (custom) return custom;
      const data = url.endsWith('/api/status') ? { extensionProtocol: 1 } : url.endsWith('/api/inspect') ? { title: 'Gerçek Türkçe ad', duration: 100, defaultOptionId: 'v1080+a', options: [
        { id: 'v1080+a', label: '1080p · MP4 · H.264', audio: 'merged', filesize: 1000000, sizeKind: 'approx' },
        { id: 'v360+a', label: '360p · MP4 · H.264', audio: 'merged', filesize: 300000, sizeKind: 'approx' }
      ] } : url.includes('/api/submissions/') ? { known: false } : url.endsWith('/api/jobs') && options?.method === 'POST' ? { id: randomUUID() } : [];
      return { ok: true, status: 200, async json() { return data; } };
    }
  });
  load(context, 'core.js'); load(context, 'popup.js');
  return { context, nodes, calls, storage, updates, tab, hooks, ready: vm.runInContext('initialized', context) };
}
const response = data => ({ ok: true, status: 200, async json() { return data; } });
const posted = calls => calls.filter(c => c.url.endsWith('/api/jobs') && c.options?.method === 'POST');

test('gerçek tarayıcıdaki fetch doğru global bağlamla çağrılır (Illegal invocation regresyonu)', async () => {
  const context = vm.createContext({ URL, AbortSignal });
  load(context, 'core.js');
  const result = await vm.runInContext(`
    globalThis.fetch = function () {
      if (this !== globalThis) throw new Error('Illegal invocation');
      return Promise.resolve({ ok: true, json: async () => ({ extensionProtocol: 1 }) });
    };
    new Hypernab.Client({ token: 'test' }).request('/api/status');
  `, context);
  assert.equal(result.extensionProtocol, 1);
});

for (const family of ['browser', 'chrome']) test(`${family}: kartta kaliteler otomatik gelir; iframe referer, elle başlatma ve tek gönderim`, async () => {
  const p = popup({ family }); await p.ready;
  await vm.runInContext('inspectChain', p.context);
  // The card inspected the captured source by itself (no "inspect" button) and still created no job.
  assert.equal(p.calls.filter(c => c.url.endsWith('/api/inspect')).length, 1);
  assert.equal(posted(p.calls).length, 0);
  const area = p.nodes.get('media').children[0].children.find(n => n.className === 'card-quality');
  const buttons = area.children.find(n => n.className === 'row').children;
  const select = area.children.find(n => n.tag === 'select'), start = buttons.find(n => n.className === 'primary');
  assert.equal(buttons.find(n => n.className === 'later').textContent, 'Sonra ekle ☰+', 'sonra ekleme seçeneği var');
  assert.equal(select.value, 'v1080+a', 'en yüksek kalite hazır seçili');
  assert.equal(select.children.length, 2);
  assert.equal(start.textContent, 'İndir ↓');
  select.value = 'v360+a'; select.events.change();
  assert.match(area.children.find(n => n.tag === 'small' && /Ses ayrı/.test(n.textContent)).textContent, /Ses ayrı akıştan birleştirilir/);
  await Promise.all([start.events.click(), start.events.click()]);
  assert.equal(posted(p.calls).length, 1);
  const body = JSON.parse(posted(p.calls)[0].options.body);
  assert.equal(body.formatId, 'v360+a'); assert.equal(body.title, 'Gerçek Türkçe ad'); assert.equal(body.start, 'now', 'İndir ↓ hemen indirir');
  assert.equal(body.referer, 'https://player.example.org/embed?session=private');
  assert.equal(body.pageUrl, 'https://film.example.org/watch'); assert.match(body.submissionId, /^[a-f0-9-]{36}$/);
  assert.ok(p.updates.some(value => value.outbox?.submissionId === body.submissionId));
  assert.equal(p.storage.outbox, null);
});
test('ağda dosya görünmeyen ama oynatıcısı olan sayfa (blob/MSE) otomatik incelenir; tarayıcı açtırmaz, indirme başlatmaz', async () => {
  const p = popup({ sessionData: { 'context:3': { frames: { 0: { playerBlob: true, duration: 600 } } } } }); await p.ready;
  await vm.runInContext('inspectChain', p.context);
  const inspects = p.calls.filter(c => c.url.endsWith('/api/inspect'));
  assert.equal(inspects.length, 1);
  const sent = JSON.parse(inspects[0].options.body);
  assert.equal(sent.url, 'https://film.example.org/watch'); assert.equal(sent.noBrowser, true, 'otomatik inceleme sunucunun tarayıcısını açmamalı');
  assert.equal(posted(p.calls).length, 0);
  const area = p.nodes.get('media').children[0].children.find(n => n.className === 'card-quality');
  assert.equal(area.children.find(n => n.tag === 'select').children.length, 2);
  assert.equal(area.children.find(n => n.className === 'row').children.find(n => n.className === 'primary').textContent, 'İndir ↓');
});
test('panel açıkken başka videoya geçilince kartlar kendiliğinden yenilenir; ilgisiz depo etkinliği seçimi sıfırlamaz', async () => {
  const sessionData = { 'context:3': { frames: { 0: { playerBlob: true, duration: 600 } } } };
  const p = popup({ sessionData }); await p.ready; await vm.runInContext('inspectChain', p.context);
  const inspects = () => p.calls.filter(c => c.url.endsWith('/api/inspect')).map(c => JSON.parse(c.options.body).url);
  assert.deepEqual(inspects(), ['https://film.example.org/watch']);
  const area = () => p.nodes.get('media').children[0].children.find(n => n.className === 'card-quality');
  area().children.find(n => n.tag === 'select').value = 'v360+a';
  // Unrelated storage activity (the panel's own cache writes, other tabs) must leave the user's pick alone.
  p.hooks.changed({ 'inspect:https://x': {} }, 'session'); p.hooks.changed({ 'tab:99': {} }, 'session'); p.hooks.changed({ 'tab:3': {} }, 'local');
  await new Promise(r => setTimeout(r, 20)); await vm.runInContext('inspectChain', p.context);
  assert.deepEqual(inspects(), ['https://film.example.org/watch']);
  assert.equal(area().children.find(n => n.tag === 'select').value, 'v360+a');
  // Same URL, nothing new captured: an automatic refresh changes nothing.
  p.hooks.updated(3, { status: 'complete' }); await new Promise(r => setTimeout(r, 20));
  assert.equal(area().children.find(n => n.tag === 'select').value, 'v360+a');
  // The user opens another video in the same tab (e.g. a single-page site): the panel follows without "Yenile".
  p.tab.url = 'https://film.example.org/watch2'; p.tab.title = 'İkinci video';
  p.hooks.updated(3, { url: p.tab.url }); await new Promise(r => setTimeout(r, 20)); await vm.runInContext('inspectChain', p.context);
  assert.deepEqual(inspects(), ['https://film.example.org/watch', 'https://film.example.org/watch2']);
  assert.equal(p.nodes.get('media').children[0].children[0].textContent, 'İkinci video');
  assert.equal(posted(p.calls).length, 0, 'otomatik izleme hiçbir indirme başlatmaz');
  // Another tab (not the one shown) changing does not trigger anything.
  p.hooks.updated(77, { url: 'https://other.example.org/' }); await new Promise(r => setTimeout(r, 20));
  assert.equal(inspects().length, 2);
});
test('oynatıcı yoksa, DRM bildirimi varsa veya bağlı değilse sayfa kendiliğinden incelenmez', async () => {
  const none = popup({ sessionData: {} }); await none.ready; await vm.runInContext('inspectChain', none.context);
  const drm = popup({ sessionData: { 'context:3': { frames: { 0: { playerBlob: true, drm: true } } } } }); await drm.ready; await vm.runInContext('inspectChain', drm.context);
  const offline = popup({ storage: {}, sessionData: { 'context:3': { frames: { 0: { playerBlob: true } } } } }); await offline.ready; await vm.runInContext('inspectChain', offline.context);
  for (const p of [none, drm, offline]) assert.equal(p.calls.filter(c => c.url.endsWith('/api/inspect')).length, 0);
});
test('yanıt kaybolur ve popup kapanırsa gönderim kimliği saklanır; yeniden açılış işi başlatmaz', async () => {
  const p = popup({ handler: async (url, options) => url.endsWith('/api/jobs') && options.method === 'POST' ? new Error('network gone') : null });
  await p.ready; await p.nodes.get('send-page').events.click(); await p.nodes.get('confirm-download').events.click();
  assert.ok(p.storage.outbox); const originalId = p.storage.outbox.submissionId;
  const reopened = popup({ storage: p.storage, handler: async url => url.includes('/api/submissions/') ? response({ known: true, listed: true, id: 'existing' }) : null });
  await reopened.ready;
  assert.equal(posted(reopened.calls).length, 0); assert.equal(reopened.storage.outbox, null);
  assert.ok(reopened.calls.some(c => c.url.endsWith(`/api/submissions/${originalId}`)));
  assert.match(reopened.nodes.get('status').textContent, /Tekrar başlatılmadı/);
});
test('popup motor yeniden başladığında seçili kaliteyi yeniler, codec/FPS koruyarak tek gönderim yapar', async () => {
  let instance = 'old';
  const p = popup({ handler: async url => {
    if (url.endsWith('/api/status')) return response({ extensionProtocol: 1, instanceId: instance });
    if (url.endsWith('/api/inspect')) return response({ title: 'Video', defaultOptionId: `${instance}-high`, options: [
      { id: `${instance}-high`, label: '1080p60 MP4 H.264', height: 1080, fps: 60, hdr: false, codec: 'H.264', ext: 'mp4', audio: 'merged' },
      { id: `${instance}-low`, label: '360p MP4 H.264', height: 360, fps: 30, hdr: false, codec: 'H.264', ext: 'mp4', audio: 'merged' }
    ] });
  } });
  await p.ready; await p.nodes.get('send-page').events.click(); p.nodes.get('preview-quality').value = 'old-low';
  instance = 'new'; await p.nodes.get('confirm-download').events.click();
  assert.equal(posted(p.calls).length, 1);
  assert.equal(JSON.parse(posted(p.calls)[0].options.body).formatId, 'new-low');
  assert.equal(p.storage.outbox, null);
});
test('belirsiz gönderimin açıkça tekrarı aynı kimliği ve aynı seçimi kullanır', async () => {
  const outbox = { url: 'https://example.org/video', engine: 'extractor', formatId: '720+a', submissionId: randomUUID() };
  const p = popup({ storage: { token: 'b'.repeat(64), outbox } }); await p.ready;
  assert.equal(posted(p.calls).length, 0);
  await p.nodes.get('retry-submission').events.click();
  assert.deepEqual(JSON.parse(posted(p.calls)[0].options.body), outbox);
  assert.equal(p.storage.outbox, null);
});
test('gönderimi bırakma mevcut işi iptal etmez; özel abandon komutu gönderir', async () => {
  const outbox = { submissionId: randomUUID(), url: 'https://example.org/video', engine: 'extractor' };
  const p = popup({ storage: { token: 'b'.repeat(64), outbox }, handler: async (url, options) => url.endsWith('/abandon') ? response({ known: false, abandoned: true }) : null });
  await p.ready; await p.nodes.get('abandon-submission').events.click();
  assert.ok(p.calls.some(c => c.url.endsWith(`/api/submissions/${outbox.submissionId}/abandon`) && c.options.method === 'POST'));
  assert.equal(p.calls.some(c => /\/cancel$/.test(c.url)), false); assert.equal(p.storage.outbox, null);
});
test('uygulama kuyruğu aynı kimlikle okunur, komutlar o işe gider ve panel açılışı indirme oluşturmaz', async () => {
  const id = randomUUID(), job = { id, title: 'Video', host: 'film.example.org', status: 'running', progress: { phase: 'downloading', received: 100, total: 1000, speed: 50, etaSeconds: 18 } };
  const p = popup({ handler: async (url, options) => url.endsWith('/api/jobs') && !options.method ? response([job]) : /\/pause$/.test(url) ? response({ changed: 1 }) : null });
  await p.ready;
  const item = p.nodes.get('jobs').children[0];
  assert.ok(item.children.some(n => /18 sn kaldı/.test(n.textContent)));
  const action = item.children.find(n => n.tag === 'div').children.find(n => n.textContent === 'Duraklat');
  await action.events.click();
  assert.ok(p.calls.some(c => c.url.endsWith(`/api/jobs/${id}/pause`))); assert.equal(posted(p.calls).length, 0);
});
test('eşleştirme hatası ile bağlantı yokluğu ayrılır; kapalı uygulama otomatik başlatılmaz', async () => {
  const p = popup({ handler: async url => url.endsWith('/api/status') ? { ok: false, status: 401, async json() { return {}; } } : null });
  await p.ready; assert.match(p.nodes.get('status').textContent, /anahtarı geçersiz/);
  assert.equal(p.calls.some(c => /launch|start/.test(c.url)), false);
  const offline = popup({ handler: async () => new Error('offline') }); await offline.ready;
  assert.match(offline.nodes.get('status').textContent, /bağlantı kurulamadı/);
});
test('Native bağlantı anahtar istemez ve kapalı uygulamayı yalnızca açık kullanıcı komutuyla açar', async () => {
  let running = false; const commands = [];
  const instanceId = randomUUID();
  const p = popup({ storage: { transport: 'native' }, nativeHandler: async command => {
    commands.push(command);
    if (['launch', 'show'].includes(command.action)) { running = true; return { started: true, status: { extensionProtocol: 1, instanceId } }; }
    if (!running) throw new Error('Hypernab kapalı olabilir. Uygulamayı aç düğmesini kullan.');
    if (command.route === '/api/status') return { extensionProtocol: 1, instanceId };
    if (command.route === '/api/jobs') return [];
    if (command.route === '/api/app/shutdown') { assert.equal(command.body.confirm, true); assert.equal(command.body.instanceId, instanceId); running = false; return { stopped: true }; }
  } });
  await p.ready; assert.equal(commands.some(c => c.action === 'launch'), false);
  assert.equal(p.calls.length, 0, 'Native bağlantı HTTP token kullanmamalı');
  await p.nodes.get('launch-app').events.click(); assert.equal(running, true);
  assert.match(p.nodes.get('transport-state').textContent, /Native Messaging/);
  await p.nodes.get('close-app').events.click(); assert.equal(running, true, 'kapatma iki aşamalı onay ister');
  await p.nodes.get('close-app').events.click(); assert.equal(running, false);
});
test('başlıktaki ok web sekmesi yerine Native show komutuyla masaüstünü açar', async () => {
  const commands = [];
  const p = popup({ storage: { transport: 'native' }, nativeHandler: async command => {
    commands.push(command);
    if (command.action === 'show') return { status: { extensionProtocol: 1, instanceId: 'same' } };
    if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: 'same' };
    if (command.route === '/api/jobs') return [];
    if (command.route === '/api/inspect') return { title: 'Video', options: [] };
  } });
  await p.ready; await p.nodes.get('show-app').events.click();
  assert.equal(commands.filter(command => command.action === 'show').length, 1);
  assert.equal(p.calls.length, 0);
  const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1/);
});
test('eski sunucuya kalite seçimi veya gönderim yapılmaz; kimlik yok sayılarak çift indirme oluşturulamaz', async () => {
  const p = popup({ handler: async url => url.endsWith('/api/status') ? response({ version: '0.8.0' }) : null });
  await p.ready; await p.nodes.get('send-page').events.click();
  assert.equal(p.calls.some(c => c.url.endsWith('/api/inspect')), false); assert.equal(posted(p.calls).length, 0);
  assert.match(p.nodes.get('status').textContent, /güncel Hypernab/);
});
test('bağlantı kopunca eski hız/ETA canlı veri gibi gösterilmez ve komutlar devre dışı kalır', async () => {
  let offline = false;
  const id = randomUUID(), job = { id, title: 'Video', host: 'example.org', status: 'running', progress: { phase: 'downloading', received: 10, total: 100, speed: 10, etaSeconds: 9 } };
  const p = popup({ handler: async url => url.endsWith('/api/jobs') ? offline ? new Error('offline') : response([job]) : null });
  await p.ready; offline = true; await p.nodes.get('sync-jobs').events.click();
  const item = p.nodes.get('jobs').children[0];
  assert.ok(item.children.some(n => /bağlantı bekleniyor/.test(n.textContent)));
  assert.equal(item.children.some(n => /sn kaldı|\/sn/.test(n.textContent)), false);
  assert.ok(item.children.find(n => n.tag === 'div').children.every(n => n.disabled));
});
test('sırası değişen senkron yanıtlar daha yeni iş durumunun üzerine yazamaz', async () => {
  let mode = 'initial', resolveOld;
  const id = randomUUID();
  const p = popup({ handler: async url => {
    if (!url.endsWith('/api/jobs')) return null;
    if (mode === 'old') return new Promise(resolve => { resolveOld = resolve; });
    return response([{ id, title: mode === 'new' ? 'Yeni durum' : 'İlk', status: 'paused', host: 'example.org' }]);
  } });
  await p.ready; mode = 'old'; const old = p.nodes.get('sync-jobs').events.click();
  await new Promise(resolve => setTimeout(resolve, 10)); mode = 'new'; await p.nodes.get('sync-jobs').events.click();
  resolveOld(response([{ id, title: 'Eski durum', status: 'running', host: 'example.org' }])); await old;
  assert.equal(p.nodes.get('jobs').children[0].children[0].textContent, 'Yeni durum');
});
test('Firefox/Chromium paketleri aynı kodu, farklı doğru arka plan manifestlerini taşır', t => {
  const preferred = (process.env.LOCALAPPDATA + '/Temp/opencode');
  const root = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builds = buildExtensions(root);
  const firefox = JSON.parse(fs.readFileSync(path.join(builds.firefox, 'manifest.json'), 'utf8'));
  const chromium = JSON.parse(fs.readFileSync(path.join(builds.chromium, 'manifest.json'), 'utf8'));
  assert.deepEqual(firefox.background.scripts, ['native-config.js', 'native.js', 'core.js', 'background.js', 'float.js', 'takeover.js']); assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(chromium.background, { service_worker: 'background.js' }); assert.equal(chromium.browser_specific_settings, undefined); assert.equal(chromium.minimum_chrome_version, '121');
  assert.equal(firefox.content_scripts[0].all_frames, true); assert.equal(chromium.content_scripts[0].all_frames, true);
  assert.equal(fs.readFileSync(path.join(builds.firefox, 'core.js'), 'utf8'), fs.readFileSync(path.join(builds.chromium, 'core.js'), 'utf8'));
  // Cookies are read per user action in the popup (for the one video being inspected); the always-on background never touches them.
  assert.ok(firefox.permissions.includes('cookies') && chromium.permissions.includes('cookies'));
  for (const dir of [builds.firefox, builds.chromium]) {
    assert.ok(!/cookies\./.test(fs.readFileSync(path.join(dir, 'background.js'), 'utf8')), 'arka plan çerez API’si kullanmamalı');
    assert.ok(!/cookies\./.test(fs.readFileSync(path.join(dir, 'content.js'), 'utf8')), 'içerik betiği çerez API’si kullanmamalı');
  }
  assert.doesNotThrow(() => buildExtensions(root));
});
test('paket üretimi kullanıcıya ait bilinmeyen hedef klasörün üzerine yazmaz', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-build-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'firefox')); fs.writeFileSync(path.join(root, 'firefox', 'mine.txt'), 'keep');
  assert.throws(() => buildExtensions(root), /üretilmemiş/);
  assert.equal(fs.readFileSync(path.join(root, 'firefox', 'mine.txt'), 'utf8'), 'keep');
});
