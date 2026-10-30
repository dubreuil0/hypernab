import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const TOKEN = 'a'.repeat(64);

// Real core.js + float.js against a fake browser and a fake app server.
function setup({ entries = [], frames = {}, inspect, jobs = [], native } = {}) {
  const session = { 'tab:7': entries, 'context:7': { frames } }, local = { token: TOKEN };
  const cookieCalls = [], requests = [];
  let listener = null;
  const browser = {
    runtime: { id: 'ext', getManifest: () => ({ version: '9.9.9' }), onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { async get(id) { return { id, url: 'https://example.org/watch?v=1&token=SECRET-PAGE', title: 'Video başlığı' }; } },
    storage: {
      session: { async get(keys) { return Object.fromEntries([].concat(keys).map(key => [key, session[key]]).filter(([, value]) => value !== undefined)); }, async set(values) { Object.assign(session, values); } },
      local: { async get(keys) { return Object.fromEntries([].concat(keys).map(key => [key, local[key]]).filter(([, value]) => value !== undefined)); }, async set(values) { Object.assign(local, values); } }
    },
    cookies: { async getAll(query) { cookieCalls.push(query.url); return [{ name: 'sid', value: 'secret', domain: 'example.org', path: '/', secure: true, hostOnly: true }]; } }
  };
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body });
    const data = route === '/api/status' ? { extensionProtocol: 1, instanceId: 'engine-1' } : ['/api/inspect', '/api/sniff'].includes(route) ? inspect(body) : route.startsWith('/api/submissions/') ? { known: false } : { id: 'job-1' };
    return { ok: !data?.httpError, status: data?.httpError ? 422 : 200, json: async () => data?.httpError ? { error: data.httpError } : data };
  };
  const context = vm.createContext({ browser, URL, AbortSignal, JSON, Promise, Date, Math, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, navigator: { userAgent: 'UA' }, setTimeout, clearTimeout, fetch: fetcher, globalThis: null });
  context.globalThis = context;
  if (native) { local.transport = 'native'; context.HypernabNativeChannel = native; }
  vm.runInContext(read('core.js'), context); vm.runInContext(read('float.js'), context);
  const send = message => new Promise(resolve => {
    const keep = listener(message, { id: 'ext', tab: { id: 7, url: 'https://example.org/watch?v=1', title: 'Video başlığı' }, url: 'https://example.org/watch?v=1' }, resolve);
    if (keep !== true) resolve(null);
  });
  const raw = (message, sender) => new Promise(resolve => { if (listener(message, sender, resolve) !== true) resolve(null); });
  return { send, raw, cookieCalls, requests, session, local };
}
const info = { title: 'Video başlığı', duration: 125, defaultOptionId: 'a', sessionUsed: false, options: [
  { id: 'a', label: '1080p · MP4 · H.264', height: 1080, fps: 60, hdr: false, codec: 'H.264', ext: 'mp4', filesize: 5e7, sizeKind: 'approx', recommended: true, audio: 'merged' },
  { id: 'b', label: '1080p · WEBM · VP9', height: 1080, fps: 60, hdr: false, codec: 'VP9', ext: 'webm', filesize: 4e7, sizeKind: 'approx', recommended: false, audio: 'merged' }
] };

test('uzantısız HLS yerel okuyucuya gider; yanlış MP4/blob yanıtı sayfadan önce koklanır', async () => {
  const app = setup({ entries: [{ url: 'https://cdn.example.org/opaque', kind: 'HLS' }], inspect: () => info });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(app.requests.find(r => r.route === '/api/inspect').body.mediaKind, 'HLS');
  const disguised = setup({ entries: [{ url: 'https://cdn.example.org/opaque', kind: 'VIDEO', playerBlob: true }], inspect: () => ({ ...info, resolved: { engine: 'extractor', mediaKind: 'HLS' } }) });
  await disguised.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(disguised.requests.find(r => r.route !== '/api/status').route, '/api/sniff');
  assert.equal(disguised.cookieCalls.length, 0);
});

test('arkadan ölçülen HLS kalite listesi eski boş cevapta 15 dakika takılı kalmaz', async () => {
  let calls = 0;
  const app = setup({ entries: [{ url: 'https://cdn.example.org/opaque', kind: 'HLS' }], inspect: () => ++calls === 1 ? { ...info, options: [], inspectionPending: true } : { ...info, inspectionPending: false } });
  const first = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(first.options.length, 0);
  await new Promise(resolve => setTimeout(resolve, 750));
  const updated = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(updated.options[0].height, 1080); assert.equal(calls, 2); assert.equal(app.cookieCalls.length, 0);
});

test('çok sayıda bilinmeyen aday sayfa çözümlemesini bütçe dışına itemez; başarısız HLS koklamasından sonra video bulunur', async () => {
  const app = setup({ entries: Array.from({ length: 9 }, (_, i) => ({ url: `https://cdn.example.org/opaque-${i}`, kind: 'UNKNOWN' })), frames: { 0: { playerBlob: true } }, inspect: body => {
    if (body.url.includes('cdn.example.org')) return { httpError: 'Yanıt bir HLS listesi değil.' };
    return info;
  } });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(answer.ok, true, answer.error);
  const attempts = app.requests.filter(r => ['/api/inspect', '/api/sniff'].includes(r.route));
  assert.equal(attempts.length, 4); assert.equal(attempts.at(-1).route, '/api/inspect');
  assert.ok(attempts.at(-1).body.url.startsWith('https://example.org/watch'));
  assert.equal(app.cookieCalls.length, 0);
});

test('adayın HLS değil hatası sayfanın gerçek oturum/erişim nedenini maskelemez; kullanıcı eylemi dışında çerez okunmaz', async () => {
  const app = setup({ entries: Array.from({ length: 6 }, (_, i) => ({ url: `https://cdn.example.org/resource-${i}`, kind: 'UNKNOWN' })), inspect: body => {
    return { httpError: body.url.includes('cdn.example.org') ? 'Yanıt bir HLS listesi değil.' : 'Sayfa oturum/erişim doğrulaması istedi.' };
  } });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(answer.ok, false); assert.equal(answer.code, 'needs-session');
  assert.equal(answer.error, 'Sayfa oturum/erişim doğrulaması istedi.');
  assert.equal(app.cookieCalls.length, 0);
});

test('ilk doğrulanmış kaynak başarıya ulaşırsa ek sayfa isteği veya çerez okuması yapılmaz', async () => {
  const app = setup({ entries: [{ url: 'https://cdn.example.org/a.m3u8', kind: 'HLS' }], inspect: () => info });
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, true);
  assert.equal(app.requests.filter(r => ['/api/inspect', '/api/sniff'].includes(r.route)).length, 1);
  assert.equal(app.cookieCalls.length, 0);
});

test('rapor regresyonu: istatistik adayları önünde olsa da oynatılan uzantısız 720p MP4 doğrudan ilk denenir', async () => {
  const media = 'https://cdn.example.org/?signature=KEEP-UNCHANGED';
  const noise = Array.from({ length: 8 }, (_, i) => ({ kind: 'UNKNOWN', url: `https://metrics.example.net/event?i=${i}`, frameId: 0 }));
  const app = setup({ entries: [...noise, { kind: 'VIDEO', url: media, mime: 'video/mp4', size: 203832171, partial: true, rangeLimited: false, observedHeight: 720, frameId: 0 }],
    frames: { 0: { mediaUrl: media, height: 720, duration: 1020.66, playerBlob: false } }, inspect: body => body.url === media ? { title: 'Video', engine: 'direct', filesize: 203832171, options: [] } : { httpError: 'Yanlış aday denenmemeli.' } });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(answer.ok, true, answer.error);
  const attempts = app.requests.filter(r => ['/api/inspect', '/api/sniff'].includes(r.route));
  assert.equal(attempts.length, 1); assert.equal(attempts[0].body.url, media); assert.equal(attempts[0].body.engine, 'direct');
  assert.equal(attempts[0].route, '/api/inspect'); assert.equal(app.cookieCalls.length, 0);
  const report = await app.raw({ type: 'hypernab:diagnose', tabId: 7 }, { id: 'ext' });
  assert.equal(report.data.candidates[0].kind, 'VIDEO'); assert.doesNotMatch(JSON.stringify(report.data), /KEEP-UNCHANGED/);
});

test('oynatıcıya tam adresle bağlı dosya ilgisiz akış listeleri altında dört aday sınırından düşmez', async () => {
  const media = 'https://files.example.org/movie?quality=720&sig=unchanged';
  const entries = Array.from({ length: 5 }, (_, i) => ({ kind: 'HLS', frameId: 0, url: `https://stream${i}.example.net/master.m3u8` }));
  entries.push({ kind: 'VIDEO', frameId: 0, url: media, mime: 'video/mp4' });
  const app = setup({ entries, frames: { 0: { mediaUrl: media, height: 720 } }, inspect: body => { assert.equal(body.url, media); return info; } });
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, true);
  assert.equal(app.requests.filter(r => r.route === '/api/inspect').length, 1);
});

test('aynı klasördeki büyük UNKNOWN yanıtı küçük doğrulanmış video dosyasını gizlemez', async () => {
  const media = 'https://cdn.example.org/movie.avi';
  const app = setup({ entries: [{ kind: 'UNKNOWN', url: 'https://cdn.example.org/opaque', size: 1000000 }, { kind: 'OTHER', url: media, mime: 'video/x-msvideo', size: 10000 }],
    inspect: body => { assert.equal(body.url, media); assert.equal(body.engine, 'direct'); return info; } });
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, true);
});

test('HLS olmayan UNKNOWN için eski hata önbelleği aynı adres VIDEO olarak doğrulanınca kullanılmaz', async () => {
  const media = 'https://cdn.example.org/opaque'; let identified = false;
  const app = setup({ entries: [{ kind: 'UNKNOWN', url: media }], inspect: body => identified && body.url === media && body.engine === 'direct' ? info : { httpError: 'Yanıt bir HLS listesi değil.' } });
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, false);
  assert.equal(app.session[`inspect:${media}`].sourceKind, 'UNKNOWN');
  identified = true; app.session['tab:7'] = [{ kind: 'VIDEO', url: media, mime: 'video/mp4' }];
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, true);
  assert.equal(app.session[`inspect:${media}`].sourceKind, 'VIDEO');
  assert.equal(app.cookieCalls.length, 0);
});

test('native floating panel never launches on prefetch, launches only on user action', async () => {
  const calls = []; let online = false;
  class Channel {
    async request(command) {
      calls.push(command);
      if (command.action === 'launch') { online = true; return { status: { extensionProtocol: 1, instanceId: 'engine-1' } }; }
      if (!online) throw Object.assign(new Error('offline'), { code: 'APP_OFFLINE' });
      return command.route === '/api/inspect' ? info : command.route === '/api/jobs' ? { id: 'job-1' } : { extensionProtocol: 1, instanceId: 'engine-1' };
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  const prefetch = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(prefetch.ok, false); assert.equal(prefetch.code, 'needs-session', 'açık kullanıcı tıklaması soğuk başlangıç yoluna geçebilmeli');
  assert.equal(calls.some(call => call.action === 'launch'), false);
  assert.equal((await app.send({ type: 'hypernab:float', action: 'inspect', cookies: true })).ok, true);
  assert.equal((await app.send({ type: 'hypernab:float', action: 'start', optionId: 'a' })).ok, true);
  assert.equal(calls.filter(call => call.action === 'launch').length, 1);
  assert.equal(app.requests.length, 0);
});

test('yüzen panel: ilk inceleme çerezsiz yapılır, çerez API’si kullanılmaz; seçenekler öneri bayrağıyla döner', async () => {
  const app = setup({ entries: [], frames: { 0: { mediaUrl: null, playerBlob: true, duration: 100 } }, inspect: () => info });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(answer.ok, true);
  assert.deepEqual(app.cookieCalls, []);
  assert.deepEqual(answer.options.map(option => option.recommended), [true, false]);
  assert.equal(answer.defaultOptionId, 'a');
  assert.equal(app.requests.find(r => r.route === '/api/inspect').body.noBrowser, true, 'otomatik inceleme uygulamanın kendi tarayıcısını açmaz');
  assert.equal(app.requests.find(r => r.route === '/api/inspect').body.cookies, undefined);
});

test('yüzen panel: kullanıcı tıkladığında (cookies:true) yalnızca o videonun adresi için çerez okunur ve gövdede gider', async () => {
  const app = setup({ frames: { 0: { playerBlob: true, duration: 100 } }, inspect: () => info });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: true });
  assert.equal(answer.ok, true);
  assert.ok(app.cookieCalls.length > 0 && app.cookieCalls.every(url => url.startsWith('https://example.org/')));
  assert.equal(app.requests.find(r => r.route === '/api/inspect').body.cookies[0].name, 'sid');
  assert.ok(!JSON.stringify(app.session).includes('secret'), 'çerez değeri depolamaya yazılmaz');
});

test('yüzen panel: İndir seçilen kaliteyle iş oluşturur; listede olmayan kalite reddedilir', async () => {
  const app = setup({ frames: { 0: { playerBlob: true, duration: 100 } }, inspect: () => info });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const bad = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'zzz' });
  assert.equal(bad.ok, false);
  const good = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'b' });
  assert.equal(good.ok, true);
  const created = app.requests.find(request => request.route === '/api/jobs').body;
  assert.equal(created.formatId, 'b'); assert.equal(created.submissionId, '11111111-1111-4111-8111-111111111111'); assert.equal(created.quality, 'best');
});

test('yüzen panel: "sıraya ekle" start:"queue" gönderir, varsayılan ve ↓ hemen indirir', async () => {
  const app = setup({ frames: { 0: { playerBlob: true, duration: 100 } }, inspect: () => info });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal((await app.send({ type: 'hypernab:float', action: 'start', optionId: 'a', mode: 'queue' })).queued, true);
  assert.equal((await app.send({ type: 'hypernab:float', action: 'start', optionId: 'a', mode: 'now' })).queued, false);
  assert.equal((await app.send({ type: 'hypernab:float', action: 'start', optionId: 'a' })).queued, false);
  const sent = app.requests.filter(request => request.route === '/api/jobs').map(request => request.body.start);
  assert.deepEqual(sent, ['queue', 'now'], 'aynı eylemin hızlı tekrarı çift indirme oluşturmaz');
});

test('yüzen panel: kaynak yoksa veya DRM varsa açık mesaj; yabancı gönderen reddedilir', async () => {
  assert.equal((await setup({ inspect: () => info }).send({ type: 'hypernab:float', action: 'inspect' })).code, 'none');
  const drm = setup({ frames: { 0: { drm: true, playerBlob: true } }, inspect: () => info });
  assert.equal((await drm.send({ type: 'hypernab:float', action: 'inspect' })).code, 'drm');
  assert.equal(drm.requests.length, 0, 'DRM durumunda uygulamaya istek gitmez');
});

test('eski motorun kalite listesi uygulama yeniden açılınca aynı kaliteyle otomatik yenilenir', async () => {
  let instance = 'one', online = true, inspections = 0; const posts = [], launches = [];
  class Channel {
    async request(command) {
      if (command.action === 'launch') { launches.push(command); online = true; return { status: { extensionProtocol: 1, instanceId: instance } }; }
      if (!online) throw Object.assign(new Error('offline'), { code: 'APP_OFFLINE' });
      if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: instance };
      if (command.route.startsWith('/api/submissions/')) return { known: false };
      if (command.route === '/api/inspect') { inspections++; return { ...info, options: info.options.map(option => ({ ...option, id: instance + option.id })) }; }
      if (command.route === '/api/jobs') { posts.push(command.body); return { id: 'download' }; }
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  instance = 'two'; online = false;
  const answer = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'oneb' });
  assert.equal(answer.ok, true, answer.error); assert.equal(posts.length, 1);
  assert.equal(posts[0].formatId, 'twob', 'codec/kapsayıcı/FPS aynı seçeneğe eşlenir');
  assert.equal(inspections, 2); assert.equal(launches.length, 1);
  assert.ok(!JSON.stringify(app.local).includes('secret'));
  assert.ok(!JSON.stringify(app.session).includes('secret'));
});
test('sunucu aynı instance içinde kalite önbelleğini atarsa otomatik yenilenir, aynı gönderim kimliği kullanılır', async () => {
  const posts = []; let inspections = 0;
  class Channel {
    async request(command) {
      if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: 'same' };
      if (command.route === '/api/inspect') { inspections++; return info; }
      if (command.route === '/api/jobs') {
        posts.push(command.body);
        if (posts.length === 1) throw Object.assign(new Error('expired'), { code: 'SELECTION_EXPIRED' });
        return { id: 'download' };
      }
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const answer = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'a' });
  assert.equal(answer.ok, true, answer.error); assert.equal(inspections, 2);
  assert.equal(posts.length, 2); assert.equal(posts[0].submissionId, posts[1].submissionId);
});
test('kayıp yanıt ve hızlı çift tıklama tek iş bırakır, alındı kontrolü tekrar POSTu önler', async () => {
  let accepted = false, posts = 0;
  class Channel {
    async request(command) {
      if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: 'same' };
      if (command.route === '/api/inspect') return info;
      if (command.route.startsWith('/api/submissions/')) return { known: accepted, id: accepted ? 'download' : null };
      if (command.route === '/api/jobs') { posts++; accepted = true; throw new Error('lost response'); }
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const answers = await Promise.all([app.send({ type: 'hypernab:float', action: 'start', optionId: 'a' }), app.send({ type: 'hypernab:float', action: 'start', optionId: 'a' })]);
  assert.ok(answers.every(answer => answer.ok)); assert.equal(posts, 1);
});
test('seçilen codec veya FPS kalkarsa sessiz kalite değişimi yapılmaz; yeni seçenekler panelde döner', async () => {
  let expired = false, posts = 0;
  class Channel {
    async request(command) {
      if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: 'same' };
      if (command.route === '/api/inspect') return expired ? { ...info, options: info.options.filter(option => option.id !== 'b') } : info;
      if (command.route === '/api/jobs') { posts++; expired = true; throw Object.assign(new Error('expired'), { code: 'SELECTION_EXPIRED' }); }
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const answer = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'b' });
  assert.equal(answer.ok, false); assert.equal(answer.refresh.ok, true); assert.equal(posts, 1);
  assert.match(answer.error, /başka kalite otomatik indirilmedi/);
});
test('çerezli ve çerezsiz inceleme önbelleği birbirine karışmaz', async () => {
  const app = setup({ frames: { 0: { playerBlob: true } }, inspect: input => ({ ...info, sessionUsed: Boolean(input.cookies?.length) }) });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: true });
  assert.equal(answer.sessionUsed, true);
  assert.equal(app.requests.filter(request => request.route === '/api/inspect').length, 2);
  assert.ok(!JSON.stringify(app.session).includes('secret'));
  let failed = false;
  const temporary = setup({ frames: { 0: { playerBlob: true } }, inspect: () => { if (!failed) { failed = true; throw new Error('offline'); } return info; } });
  assert.equal((await temporary.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, false);
  assert.equal((await temporary.send({ type: 'hypernab:float', action: 'inspect', cookies: false })).ok, true, 'geçici bağlantı hatası iki dakikalık hata önbelleğine dönüşmemeli');
});
test('içerik betiğine giden yanıt kaybolsa da aynı kullanıcı niyeti ikinci iş oluşturmaz', async () => {
  let accepted = false, posts = 0;
  class Channel {
    async request(command) {
      if (command.route === '/api/status') return { extensionProtocol: 1, instanceId: 'same' };
      if (command.route === '/api/inspect') return info;
      if (command.route.startsWith('/api/submissions/')) return { known: accepted, id: accepted ? 'download' : null };
      if (command.route === '/api/jobs') { accepted = true; posts++; return { id: 'download' }; }
    }
  }
  const app = setup({ native: Channel, frames: { 0: { playerBlob: true } } });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  const intent = { type: 'hypernab:float', action: 'start', optionId: 'a', intentId: '22222222-2222-4222-8222-222222222222' };
  await app.send(intent); // pretend this reply never reached the content script
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await app.send(intent)).ok, true); assert.equal(posts, 1);
});

test('HLS kalite listesi önce incelenir; sayfadaki MP4 ve diğer tam dosyalar satır olarak eklenir ve doğrudan indirilir', async () => {
  const seen = [];
  const e = (url, kind, extra = {}) => ({ url, kind, frameId: 0, host: 'cdn.example.org', frameUrl: 'https://example.org/watch?v=1', detectedAt: 1, ...extra });
  const app = setup({
    entries: [e('https://cdn.example.org/movie.mp4', 'VIDEO', { size: 900e6 }), e('https://cdn.example.org/old.flv', 'OTHER', { size: 100e6 }), e('https://cdn.example.org/master.m3u8', 'HLS', { detectedAt: 0 })],
    frames: { 0: { duration: 100 } }, inspect: body => { seen.push(body); return info; }
  });
  const answer = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(answer.ok, true);
  assert.equal(seen[0].url, 'https://cdn.example.org/master.m3u8', 'kalite listesi veren akış, düz MP4 dosyasından önce denenir');
  assert.deepEqual(JSON.parse(JSON.stringify(answer.files.map(file => [file.label, file.main]))), [['MP4 dosyası', true], ['FLV dosyası', false]]);
  assert.equal(answer.options.length, 2);
  const started = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'file:0', mode: 'now', intentId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(started.ok, true);
  const post = app.requests.find(request => request.route === '/api/jobs');
  assert.equal(post.body.url, 'https://cdn.example.org/movie.mp4'); assert.equal(post.body.engine, 'direct');
  assert.equal(post.body.submissionId, '22222222-2222-4222-8222-222222222222'); assert.equal(post.body.formatId, undefined);
  assert.equal((await app.send({ type: 'hypernab:float', action: 'start', optionId: 'file:9', mode: 'now' })).ok, false, 'listede olmayan kaynak başlatılamaz');
});


test('akış listesi tek kaliteli (ana liste yok): sayfanın diğer listeleri başka kalite olarak eklenir ve doğru adresten indirilir', async () => {
  const one = (id, height, label) => ({ title: 'Film', duration: 5851, defaultOptionId: id, sessionUsed: false, options: [{ id, label, height, fps: 25, hdr: false, codec: 'H.264', ext: 'mp4', filesize: height * 1e6, sizeKind: 'approx', recommended: true, audio: 'included' }] });
  const e = (url, at) => ({ url, kind: 'HLS', frameId: 0, host: 'cdn.example.org', frameUrl: 'https://example.org/watch?v=1', detectedAt: at });
  const app = setup({
    entries: [e('https://cdn.example.org/m/high', 2), e('https://cdn.example.org/m/low', 1)], frames: { 0: { duration: 100 } },
    inspect: body => /low$/.test(body.url) ? one('0', 720, '720p · MP4 · H.264') : one('0', 1080, '1080p · MP4 · H.264')
  });
  const first = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(first.ok, true); assert.equal(first.options.length, 1, 'diğer liste arka planda çözülürken ilk cevap beklemez');
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.deepEqual(JSON.parse(JSON.stringify(second.options.map(option => option.label))), ['1080p · MP4 · H.264', '720p · MP4 · H.264'], 'en iyi görüntü üstte; aynı etiket tek satır');
  assert.equal(second.defaultOptionId, second.options[0].id);
  const alt = second.options.find(option => option.id.startsWith('alt:'));
  assert.ok(alt, 'diğer listeden gelen kalite alt: kimliğiyle gelir');
  const started = await app.send({ type: 'hypernab:float', action: 'start', optionId: alt.id, mode: 'now', intentId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(started.ok, true);
  const post = app.requests.find(request => request.route === '/api/jobs');
  assert.match(post.body.url, /\/m\/(low|high)$/); assert.equal(post.body.formatId, '0');
  assert.equal(app.requests.filter(request => request.route === '/api/inspect').length, 2, 'her liste yalnızca bir kez incelenir');
});
test('sessiz görüntü listesi + sayfanın ses listesi: ses adresi indirmeye eklenir; ses yoksa panel açık uyarı verir', async () => {
  const video = { title: 'Film', duration: 5851, silentStream: true, defaultOptionId: '0', sessionUsed: false, options: [{ id: '0', label: '720p · MP4 · H.264', height: 720, fps: 25, hdr: false, codec: 'H.264', ext: 'mp4', filesize: 7.9e8, sizeKind: 'approx', recommended: true, audio: 'included' }] };
  const sound = { title: 'Film', duration: 5851, audioOnly: true, options: [] };
  const e = (url, at) => ({ url, kind: 'HLS', frameId: 0, host: 'cdn.example.org', frameUrl: 'https://example.org/watch?v=1', detectedAt: at });
  const lone = setup({ entries: [e('https://cdn.example.org/m/video', 1)], frames: { 0: { duration: 100 } }, inspect: () => video });
  const warned = await lone.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.match(warned.alert, /ses yok/i, 'ses akışı bulunamadıysa sessiz indirme sessizce önerilmez');
  const app = setup({ entries: [e('https://cdn.example.org/m/video', 1), e('https://cdn.example.org/m/sound', 2)], frames: { 0: { duration: 100 } }, inspect: body => /sound$/.test(body.url) ? sound : video });
  await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  const ready = await app.send({ type: 'hypernab:float', action: 'inspect', cookies: false });
  assert.equal(ready.alert, null); assert.equal(ready.options.length, 1);
  const started = await app.send({ type: 'hypernab:float', action: 'start', optionId: '0', mode: 'now', intentId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(started.ok, true);
  const post = app.requests.find(request => request.route === '/api/jobs');
  assert.equal(post.body.audioUrl, 'https://cdn.example.org/m/sound'); assert.equal(post.body.url, 'https://cdn.example.org/m/video');
});
test('teşhis raporu: yalnızca eklentinin kendi sayfalarına, adresleri şekle indirgenmiş (sorgu ve belirteç yok) ve adım süreleriyle', async () => {
  const e = (url, extra = {}) => ({ url, kind: 'HLS', frameId: 0, host: 'cdn.example.org', mime: 'application/vnd.apple.mpegurl', frameUrl: 'https://example.org/watch?v=1', detectedAt: 1, ...extra });
  const app = setup({ entries: [e('https://cdn.example.org/mo/D29hqUWuYzIfYzu1pzSwLJ4hZwNlAv5KEHVgERjh?token=SECRET-QUERY&sig=abc')], frames: { 0: { height: 2160, duration: 7000, url: 'https://example.org/watch?v=1&session=SECRET-FRAME' } }, inspect: () => info });
  assert.equal((await app.raw({ type: 'hypernab:diagnose', tabId: 7 }, { id: 'ext', tab: { id: 7 } })).ok, false, 'sayfa betiği rapor isteyemez');
  assert.equal((await app.raw({ type: 'hypernab:diagnose', tabId: 7 }, { id: 'baska' })).ok, false, 'başka eklenti isteyemez');
  const answer = await app.raw({ type: 'hypernab:diagnose', tabId: 7 }, { id: 'ext' });
  assert.equal(answer.ok, true);
  const text = JSON.stringify(answer.data);
  assert.doesNotMatch(text, /SECRET|token=|sig=abc/, 'sorgu dizgeleri ve gizli değerler rapora girmez');
  assert.equal(answer.data.extension, '9.9.9'); assert.equal(answer.data.captured[0].kind, 'HLS'); assert.match(answer.data.captured[0].url, /mo\/D29hq…\(\d+\)$/);
  assert.equal(answer.data.frames[0].height, 2160); assert.equal(answer.data.lookup.ok, true); assert.ok(answer.data.lookup.ms >= 0);
  assert.ok(answer.data.steps.length >= 1 && answer.data.steps.every(step => typeof step.ms === 'number'), 'her inceleme adımının süresi yazılır');
  assert.match(answer.data.lookup.alert || '', /2160p oynatıyor/, 'oynatıcı yakalanandan yüksek kalitede çalıyorsa panel bunu söyler');
});
