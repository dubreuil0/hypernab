import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runContentScripts } from './content-scripts.js';

function load(context, file) {
  if (file === 'content.js') return runContentScripts(context);
  if (file) return vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
}

test('eklenti MP4, HLS, DASH yanıtlarını ayırt eder; segmentleri atlar', () => {
  const context = vm.createContext({ URL, chrome: {
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
  }});
  load(context);
  for (const [url, type, expected] of [
    ['https://example.com/movie.mp4?signature=secret', '', 'VIDEO'],
    ['https://example.com/manifest.m3u8', '', 'HLS'],
    ['https://example.com/manifest.mpd', '', 'DASH'],
    ['https://example.com/opaque', 'application/vnd.apple.mpegurl', 'HLS'],
    ['https://example.com/opaque', 'application/dash+xml', 'DASH'],
    ['https://example.com/opaque', 'video/mp4', 'VIDEO'],
    ['https://example.com/segment.m4s', 'video/mp4', null],
    ['https://example.com/segment.ts', '', null],
    ['https://example.com/page', 'text/html', null]
  ]) {
    assert.equal(vm.runInContext(`mediaKind(${JSON.stringify(url)}, ${JSON.stringify(type)})`, context), expected);
  }
});

test('tür kaçakları sınırlı yakalanır; tüm istek tanısı yalnızca kullanıcı açınca, başlık/sorgu/çerez olmadan tutulur', async () => {
  const store = {}; let headersReceived, message;
  const context = vm.createContext({ URL, chrome: {
    runtime: { id: 'ext', onMessage: { addListener(fn) { message = fn; } } },
    webRequest: { onHeadersReceived: { addListener(fn) { headersReceived = fn; } } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { session: { async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, store[k]])); }, async set(values) { Object.assign(store, values); } } }
  } });
  load(context);
  const details = { tabId: 4, statusCode: 200, type: 'xmlhttprequest', url: 'https://cdn.example.org/SHORTTOKEN?secret=SECRET', responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, { name: 'Set-Cookie', value: 'SESSIONSECRET' }] };
  headersReceived(details); await vm.runInContext('writes', context);
  assert.equal(store['tab:4'][0].kind, 'UNKNOWN'); assert.equal(store['requests:4'], undefined);
  let result;
  message({ type: 'hypernab:diagnostic-mode', tabId: 4, enabled: true }, { id: 'ext', tab: { id: 4 } }, value => { result = value; });
  assert.equal(result.ok, false);
  message({ type: 'hypernab:diagnostic-mode', tabId: 4, enabled: true }, { id: 'ext' }, value => { result = value; });
  assert.equal(result.ok, true);
  headersReceived({ ...details, url: 'https://cdn.example.org/SHORTTOKEN?secret=SECRET', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Set-Cookie', value: 'SESSIONSECRET' }] });
  await vm.runInContext('writes', context);
  assert.equal(store['requests:4'].length, 1);
  const report = JSON.stringify(store['requests:4']);
  assert.ok(!report.includes('SHORTTOKEN') && !report.includes('SECRET'));
});

test('eklenti geçersiz yanıtları atlar, aynı kaynağı çoğaltmaz ve listeyi sınırlar', async () => {
  const store = {};
  const context = vm.createContext({ URL, chrome: {
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { session: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[k]])); },
      async set(value) { Object.assign(store, value); }
    }}
  }});
  load(context);
  vm.runInContext(`capture({ tabId: 1, statusCode: 403, url: 'https://example.com/forbidden.mp4' })`, context);
  vm.runInContext(`capture({ tabId: -1, statusCode: 200, url: 'https://example.com/background.mp4' })`, context);
  await vm.runInContext('writes', context);
  assert.equal(Object.keys(store).length, 0);
  vm.runInContext(`capture({ tabId: 1, statusCode: 200, url: 'https://example.com/video.mp4' }); capture({ tabId: 1, statusCode: 206, url: 'https://example.com/video.mp4' });`, context);
  await vm.runInContext('writes', context);
  assert.equal(store['tab:1'].length, 1);
  vm.runInContext(`for(let i=0;i<70;i++) capture({ tabId: 1, statusCode: 200, url: 'https://example.com/video'+i+'.mp4' });`, context);
  await vm.runInContext('writes', context);
  assert.equal(store['tab:1'].length, 60);
});

test('CDN bytes varyantları birleştirilir; imza değiştirilmez ve parça tam dosya gibi sunulmaz', async () => {
  const store = {};
  const context = vm.createContext({ URL, chrome: {
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { session: { async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[k]])); }, async set(value) { Object.assign(store, value); } } }
  }});
  load(context);
  for (const range of ['0-99', '100-199']) {
    vm.runInContext(`capture({ tabId: 1, statusCode: 206, url: 'https://example.com/?sig=keep&bytes=${range}', responseHeaders: [{name:'content-range',value:'bytes ${range}/1000'}] }, 'video/mp4')`, context);
  }
  await vm.runInContext('writes', context);
  assert.equal(store['tab:1'].length, 1);
  assert.equal(store['tab:1'][0].partial, true);
  assert.equal(store['tab:1'][0].size, 1000);
  assert.match(store['tab:1'][0].url, /sig=keep&bytes=100-199/);
});

function background() {
  const store = {};
  const context = vm.createContext({ URL, browser: {
    runtime: { id: 'hypernab-test', onMessage: { addListener() {} } },
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { session: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])); },
      async set(values) { Object.assign(store, values); }, async remove(key) { delete store[key]; }
    } }
  } });
  load(context); return { store, context };
}
test('iframe bağlamı ve kaynak sayfa adı korunur, doğru Referer için iframe URL’si saklanır', async () => {
  const { store, context } = background();
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Bölüm adı'}, {id:'hypernab-test',tab:{id:5},frameId:0,url:'https://site.example.org/watch'})`, context);
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Player',playerBlob:true}, {id:'hypernab-test',tab:{id:5},frameId:7,url:'https://player.example.org/embed?private=x'})`, context);
  vm.runInContext(`capture({tabId:5, frameId:7, statusCode:200, url:'https://cdn.example.org/master.m3u8?sig=keep'})`, context);
  await vm.runInContext('writes', context);
  const entry = store['tab:5'][0];
  assert.equal(entry.pageTitle, 'Bölüm adı'); assert.equal(entry.frameId, 7); assert.equal(entry.frameUrl, 'https://player.example.org/embed?private=x');
  assert.equal(entry.playerBlob, true); assert.match(entry.url, /sig=keep/);
});
test('dış kimlik veya yerel dosya içeren içerik mesajları saklanmaz', async () => {
  const { store, context } = background();
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Spoof'}, {id:'other',tab:{id:1},url:'https://example.org'})`, context);
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Local'}, {id:'hypernab-test',tab:{id:1},url:'file:///C:/private'})`, context);
  assert.deepEqual(store, {});
});
test('aralık isteyen normal tam dosya URL’si ile query içinde byte parçası taşıyan URL ayrılır', () => {
  const { context } = background();
  assert.equal(vm.runInContext(`Hypernab.rangeLimited('https://cdn.example.org/a.mp4?signature=keep')`, context), false);
  assert.equal(vm.runInContext(`Hypernab.rangeLimited('https://cdn.example.org/a.mp4?range=0-999&signature=keep')`, context), true);
  assert.equal(vm.runInContext(`Hypernab.mediaKind('https://cdn.example.org/init-1.mp4', 'video/mp4')`, context), null);
  assert.equal(vm.runInContext(`Hypernab.mediaKind('https://cdn.example.org/chunk23.mp4', 'video/mp4')`, context), null);
  assert.equal(vm.runInContext(`Hypernab.mediaKind('https://cdn.example.org/movie.mp4', 'video/mp4')`, context), 'VIDEO');
});
test('parçalı/MSE kaynakta aynı iframe manifesti tercih edilir, yoksa sayfa çözümlenir; site adı koşulu yoktur', () => {
  const { context } = background(); const core = context.Hypernab;
  const entry = { url: 'https://cdn.example.org/track.mp4', kind: 'VIDEO', frameId: 7, playerBlob: true };
  const otherFrame = { url: 'https://ads.example.org/ad.m3u8', kind: 'HLS', frameId: 3 };
  const manifest = { url: 'https://cdn.example.org/master.m3u8', kind: 'HLS', frameId: 7 };
  assert.equal(core.sourceFor(entry, [otherFrame, manifest], 'https://site.example.org/watch').url, manifest.url);
  assert.equal(core.sourceFor(entry, [otherFrame], 'https://site.example.org/watch').kind, 'PAGE');
  const ambiguous = core.sourceFor(entry, [manifest, { ...manifest, url: 'https://cdn.example.org/ad.m3u8' }], 'https://site.example.org/watch');
  assert.equal(ambiguous.kind, 'PAGE'); assert.equal(ambiguous.ambiguous, true, 'reklam ile bölüm arasında sessiz seçim yapılmaz');
  assert.equal(core.sourceFor({ ...entry, playerBlob: false, partial: true }, [], 'https://site.example.org/watch').kind, 'VIDEO', 'normal HTTP Range isteği tek başına parçalı video değildir');
});
test('video DOM kaynağı yakalanır, gerçek oynatıcı yüksekliği kaynağa eşleşir; DRM yalnızca bildirim olarak tutulur', async () => {
  const { context, store } = background();
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Video',url:'https://cdn.example.org/a.mp4',height:720,duration:90}, {id:'hypernab-test',tab:{id:1},frameId:0,url:'https://example.org/watch'})`, context);
  await vm.runInContext('writes', context);
  assert.equal(store['tab:1'][0].observedHeight, 720);
  assert.equal(store['tab:1'][0].observedDuration, 90);
  await vm.runInContext(`recordFrame({type:'hypernab:media-context',title:'Video',drm:true}, {id:'hypernab-test',tab:{id:1},frameId:0,url:'https://example.org/watch'})`, context);
  assert.equal(store['tab:1'][0].drmSuspected, true);
});
// Firefox runs content scripts in a sandbox whose globalThis is NOT the page window. Regression: the top-level page must
// not mistake itself for an embedded frame (which made the button vanish on iframe sites).
function overlayContext({ top, alreadyPlaying = false }) {
  const posted = [], timers = [], events = {};
  const video = { paused: !alreadyPlaying, ended: false, readyState: 4, currentSrc: '', isConnected: true, videoHeight: 360, videoWidth: 640, duration: 60, addEventListener(event, fn) { events[event] = fn; }, getBoundingClientRect() { return { left: 100, top: 200, right: 740, bottom: 560, width: 640, height: 360 }; } };
  const page = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  page.self = page; page.parent = { postMessage(message) { posted.push(message); } }; page.top = top ? page : { elsewhere: true };
  const created = [], docEvents = {};
  const document = { title: 'Sayfa', body: { append(el) { created.push(el); } }, documentElement: {}, fullscreenElement: null, addEventListener(type, fn) { docEvents[type] = fn; }, querySelectorAll() { return [video]; }, querySelector() { return video; },
    createElement() { return { style: {}, className: '', classList: { add() {}, remove() {} }, append() {}, addEventListener() {}, attachShadow() { return { append() {} }; }, remove() {}, offsetWidth: 150, offsetHeight: 30 }; },
    createElementNS() { return { setAttribute() {}, append() {} }; } };
  // globalThis (the sandbox) deliberately differs from `window`, like in Firefox.
  const context = vm.createContext({ document, window: page, browser: { runtime: { async sendMessage() { return { ok: true }; } } }, MutationObserver: class { observe() {} }, setTimeout() {}, setInterval(fn) { timers.push(fn); return 1; }, clearInterval() {} });
  load(context, 'content.js');
  return { posted, events, video, created, timers, document, docEvents };
}
test('tam ekranda (video, oynatıcı ya da tüm sayfa) düğme görünmez; çıkınca aynı yerde geri gelir', () => {
  const ctx = overlayContext({ top: true, alreadyPlaying: true });
  const host = ctx.created[0];
  assert.equal(host.style.display, '');
  ctx.document.fullscreenElement = ctx.document.documentElement; ctx.docEvents.fullscreenchange();
  assert.equal(host.style.display, 'none', 'tam ekrana geçer geçmez gizlenir');
  for (const tick of ctx.timers) tick();
  assert.equal(host.style.display, 'none', 'zamanlayıcı onu geri getirmez');
  ctx.document.fullscreenElement = null; ctx.docEvents.fullscreenchange();
  assert.equal(host.style.display, '');
});
test('Firefox sandbox: en üst sayfa kendini iframe sanmaz ve düğmeyi kendisi çizer; iframe konumu ebeveyne bildirir', () => {
  const topLevel = overlayContext({ top: true });
  topLevel.events.playing();
  assert.equal(topLevel.posted.length, 0, 'üst sayfa kendine mesaj göndermemeli');
  assert.equal(topLevel.created.length, 1, 'üst sayfa düğmeyi kendi çizer');
  const framed = overlayContext({ top: false });
  framed.events.playing();
  assert.equal(framed.created.length, 0, 'iframe düğmeyi hemen kendi içinde çizmez');
  assert.equal(framed.posted.length, 1);
  assert.deepEqual({ ...framed.posted[0], rect: { ...framed.posted[0].rect } }, { type: 'hypernab:rect', rect: { left: 100, top: 200, width: 640, height: 360 } });
});

test('betik yüklenmeden önce zaten oynayan video için de düğme çizilir (olay beklenmez)', () => {
  const ctx = overlayContext({ top: true, alreadyPlaying: true });
  assert.equal(ctx.created.length, 1);
});

test('içerik betiği blob adresini dosya diye göndermez, çerez veya DRM anahtarlarını okumaz', () => {
  const sent = [], events = {};
  const video = { currentSrc: 'blob:https://example.org/opaque', videoHeight: 720, videoWidth: 1280, duration: 90, addEventListener(event, listener) { events[event] = listener; } };
  Object.defineProperty(video, 'mediaKeys', { get() { throw new Error('must not read DRM keys'); } });
  const document = { title: 'Bölüm', documentElement: {}, querySelectorAll() { return [video]; }, querySelector() { return video; } };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('must not read cookies'); } });
  const context = vm.createContext({ document, browser: { runtime: { async sendMessage(value) { sent.push(value); } } }, MutationObserver: class { observe() {} }, setTimeout() {}, setInterval() { return 1; } });
  load(context, 'content.js');
  assert.equal(sent[0].url, null); assert.equal(sent[0].playerBlob, true); assert.equal(sent[0].height, 720);
  events.encrypted(); assert.equal(sent.at(-1).drm, true); assert.equal(sent.at(-1).url, null);
});
