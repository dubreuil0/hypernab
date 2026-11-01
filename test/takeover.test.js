import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const read = name => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');

// Real core.js + takeover.js against a fake browser and a fake Hypernab connection.
const plain = value => JSON.parse(JSON.stringify(value));
function setup({ online = true, items = {}, take, duplicates = [], receipt = { known: false }, firefox = false } = {}) {
  const log = [], local = {}, session = {}, windows = new Map(), listeners = [], requests = [], cookieReads = [];
  let onCreated, onRemoved, onHeaders, nextWindow = 1;
  const store = area => ({
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).filter(k => k in area).map(k => [k, structuredClone(area[k])])),
    set: async value => { Object.assign(area, structuredClone(value)); },
    remove: async key => { delete area[key]; }
  });
  const api = {
    runtime: { id: 'ext', getURL: file => `chrome-extension://ext/${file}`, onMessage: { addListener: listener => listeners.push(listener) } },
    storage: { local: store(local), session: store(session) },
    downloads: {
      onCreated: { addListener: listener => { onCreated = listener; } },
      pause: async id => { if (items[id]?.state === 'complete') throw new Error('not pausable'); log.push(['pause', id]); },
      resume: async id => { log.push(['resume', id]); },
      cancel: async id => { log.push(['cancel', id]); },
      erase: async query => { log.push(['erase', query.id]); },
      search: async ({ id }) => [items[id]].filter(Boolean),
      download: async options => { log.push(['download', options.url, options.filename]); }
    },
    windows: {
      create: async options => { const id = nextWindow++; windows.set(id, options); log.push(['window', options.url]); return { id }; },
      get: async id => { if (!windows.has(id)) throw new Error('no window'); return { id }; },
      update: async () => {},
      onRemoved: { addListener: listener => { onRemoved = listener; } }
    },
    cookies: { getAll: async ({ url }) => { cookieReads.push(url); return [{ name: 'sid', value: 'SECRET-COOKIE', domain: new URL(url).hostname, path: '/', secure: true, hostOnly: true, expirationDate: 4102444800 }]; } }
  };
  if (firefox) { // Firefox can hold a response while the user decides
    api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    api.webRequest = { onHeadersReceived: { addListener: (listener, filter, extra) => { onHeaders = listener; log.push(['webrequest', extra.join(',')]); } } };
    api.tabs = { get: async id => { if (id < 0) throw new Error('no tab'); return { id, url: 'https://files.example.org/page' }; } };
  }
  const client = {
    request: async (route, options = {}) => {
      requests.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
      if (route === '/api/duplicates') return { duplicates };
      if (route === '/api/status') return { directory: 'C:\\Downloads\\Hypernab' };
      if (route === '/api/files/take') return take ? take(JSON.parse(options.body)) : { id: 'job-1', name: JSON.parse(options.body).fileName };
      if (route.startsWith('/api/submissions/')) return receipt;
      throw new Error(`unexpected ${route}`);
    }
  };
  const context = vm.createContext({ URL, crypto: webcrypto, navigator: { userAgent: 'UA/Test' }, console, clearInterval, clearTimeout, chrome: api,
    // timers must not keep the test process alive (a held request has a long safety timer)
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref?.(); return timer; }, ...(firefox ? { browser: api } : {}) });
  vm.runInContext(read('core.js'), context);
  context.HypernabFloat = { connection: async () => { if (!online) throw Object.assign(new Error('offline'), { code: 'APP_OFFLINE' }); return client; } };
  vm.runInContext(read('takeover.js'), context);
  const send = (message, sender = { id: 'ext' }) => new Promise(resolve => {
    for (const listener of listeners) { if (listener(message, sender, resolve) === true) return; }
    resolve(undefined);
  });
  const download = (id, extra = {}) => { items[id] = { id, url: `https://files.example.org/f${id}.zip`, referrer: 'https://files.example.org/page', filename: `D:\\Indirilenler\\f${id}.zip`, mime: 'application/zip', totalBytes: 50 * 1048576, state: 'in_progress', ...extra }; return items[id]; };
  const created = async item => { onCreated(item); await wait(30); };
  const headers = (extra = {}) => ({ method: 'GET', statusCode: 200, tabId: 7, type: 'main_frame', incognito: false, url: 'https://files.example.org/get/a', originUrl: 'https://files.example.org/page', responseHeaders: [{ name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: String(50 * 1048576) }, { name: 'Content-Disposition', value: 'attachment; filename="Veri Paketi.zip"' }], ...extra });
  const response = details => onHeaders(details);
  return { api, log, local, session, windows, requests, cookieReads, send, download, created, close: id => onRemoved(id), items, headers, response };
}
const actions = (f, name) => f.log.filter(entry => entry[0] === name).map(entry => entry[1]);

test('eligible download: paused, one window, nothing cancelled and no cookie read until the user decides', async () => {
  const f = setup(); const item = f.download(1);
  await f.created(item);
  assert.deepEqual(actions(f, 'pause'), [1]); assert.equal(actions(f, 'window').length, 1);
  assert.deepEqual(actions(f, 'cancel'), []); assert.deepEqual(actions(f, 'erase'), []); assert.deepEqual(f.cookieReads, []);
  const view = await f.send({ type: 'hypernab:takeover:next' });
  assert.equal(view.name, 'f1.zip'); assert.equal(view.host, 'files.example.org'); assert.equal(view.bytes, 50 * 1048576); assert.equal(view.risk, null);
  assert.equal(view.directory, 'C:\\Downloads\\Hypernab'); assert.equal(view.duplicate, false);
});

test('the prompt opens in the middle of the browser window the user was in (a maximized browser = the middle of its monitor)', async () => {
  const placed = async parent => {
    const f = setup(); if (parent !== 'unsupported') f.api.windows.getLastFocused = async () => { if (parent === 'fails') throw new Error('no window'); return parent; };
    await f.created(f.download(1));
    const options = [...f.windows.values()][0]; return { left: options.left, top: options.top, width: options.width, height: options.height };
  };
  // maximized on a 1920x1080 monitor: Windows reports the frame a few pixels outside the screen
  assert.deepEqual(await placed({ left: -8, top: -8, width: 1936, height: 1048, state: 'maximized' }), { left: 740, top: 391, width: 440, height: 250 });
  assert.deepEqual(await placed({ left: 1920, top: 100, width: 1000, height: 800, state: 'normal' }), { left: 2200, top: 375, width: 440, height: 250 }, 'a browser on a second monitor: its middle, not the first monitor\'s');
  for (const unknown of [{ left: -32000, top: -32000, width: 160, height: 28, state: 'minimized' }, { state: 'normal' }, 'fails', 'unsupported']) {
    const options = await placed(unknown);
    assert.equal(options.left, undefined); assert.equal(options.top, undefined); assert.equal(options.width, 440, 'minimized or unknown: the system chooses, the size stays');
  }
});

test('"İndir": the file is sent with its own cookies, and the browser download is cancelled only after Hypernab accepted it', async () => {
  const f = setup({ take: async body => { assert.deepEqual(actions(f, 'cancel'), [], 'not cancelled before the app answered'); return { id: 'job-1', name: body.fileName }; } });
  await f.created(f.download(1));
  const answer = await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(answer.ok, true);
  const take = f.requests.find(request => request.route === '/api/files/take').body;
  assert.equal(take.url, 'https://files.example.org/f1.zip'); assert.equal(take.fileName, 'f1.zip'); assert.equal(take.start, 'now'); assert.equal(take.userAgent, 'UA/Test');
  assert.equal(take.referer, 'https://files.example.org/page'); assert.match(take.submissionId, /^[a-f0-9-]{36}$/);
  assert.equal(take.cookies[0].value, 'SECRET-COOKIE'); assert.ok(f.cookieReads.every(url => url.startsWith('https://files.example.org/')));
  assert.deepEqual(actions(f, 'cancel'), [1]); assert.deepEqual(actions(f, 'erase'), [1]); assert.deepEqual(actions(f, 'resume'), []);
  assert.ok(!JSON.stringify(f.local).includes('SECRET-COOKIE') && !JSON.stringify(f.session).includes('SECRET-COOKIE'), 'cookies are never stored by the extension');
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).empty, true);
});

test('"Sonra ekle" queues without starting', async () => {
  const f = setup(); await f.created(f.download(1));
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'later' });
  assert.equal(f.requests.find(request => request.route === '/api/files/take').body.start, 'queue');
});

test('Hypernab refuses or fails: nothing is cancelled, the browser download stays paused and can continue', async () => {
  const f = setup({ take: async () => { throw Object.assign(new Error('Sunucu erişimi reddetti (giriş veya izin gerekebilir).'), { code: 'ACCESS_DENIED' }); } });
  await f.created(f.download(1));
  const answer = await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(answer.ok, false); assert.equal(answer.code, 'ACCESS_DENIED'); assert.match(answer.error, /reddetti/);
  assert.deepEqual(actions(f, 'cancel'), []); assert.deepEqual(actions(f, 'erase'), []);
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).id, 1, 'still waiting for a decision');
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'browser' });
  assert.deepEqual(actions(f, 'resume'), [1]);
});

test('lost answer after the app took the file is recognised through the submission receipt', async () => {
  const timeout = async () => { throw Object.assign(new Error('Bağlantı zaman aşımına uğradı.'), { code: 'APP_TIMEOUT' }); };
  const known = setup({ take: timeout, receipt: { known: true, id: 'job-9', listed: true } }); await known.created(known.download(1));
  const accepted = await known.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(accepted.ok, true, 'the app has the file even though its answer was lost');
  assert.deepEqual(actions(known, 'cancel'), [1]);
  const unknown = setup({ take: timeout }); await unknown.created(unknown.download(1));
  const answer = await unknown.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(answer.ok, false, 'unknown receipt: the file stays with the browser');
  assert.deepEqual(actions(unknown, 'cancel'), []);
});

test('closing the window or having no answer hands every waiting download back to the browser', async () => {
  const f = setup(); await f.created(f.download(1)); await f.created(f.download(2));
  assert.equal(actions(f, 'window').length, 1, 'one window serves all waiting files');
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).remaining, 1);
  await f.close(1); await wait(20);
  assert.deepEqual(actions(f, 'resume').sort(), [1, 2]); assert.deepEqual(actions(f, 'cancel'), []);
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).empty, true);
  const g = setup(); await g.created(g.download(3));
  await g.send({ type: 'hypernab:takeover:release' }); assert.deepEqual(actions(g, 'resume'), [3]);
});

test('a stopped background cannot leave a download paused: stale waiting items are released at start', async () => {
  const f = setup(); await f.created(f.download(1));
  f.windows.clear(); // the prompt window vanished together with the background
  const g = setup(); Object.assign(g.session, structuredClone(f.session));
  const context = vm.createContext({ URL, crypto: webcrypto, navigator: { userAgent: 'UA' }, console, setTimeout, clearTimeout, chrome: g.api });
  vm.runInContext(read('core.js'), context); context.HypernabFloat = { connection: async () => ({}) }; vm.runInContext(read('takeover.js'), context);
  await wait(30);
  assert.deepEqual(actions(g, 'resume'), [1]);
});

test('filters: closed app, small files, private windows, odd addresses, pages, local addresses and excluded sites are left to the browser', async () => {
  const offline = setup({ online: false }); await offline.created(offline.download(1));
  assert.deepEqual(actions(offline, 'resume'), [1], 'a closed app: the brief pause is undone at once'); assert.deepEqual(actions(offline, 'cancel'), []); assert.equal(actions(offline, 'window').length, 0);
  const f = setup();
  for (const extra of [{ totalBytes: 100 }, { incognito: true }, { url: 'blob:https://x.example/1' }, { url: 'data:text/plain,hi' }, { url: 'file:///C:/a.zip' }, { url: 'ftp://x.example/a.zip' }, { mime: 'text/html' }, { url: 'http://127.0.0.1:17846/x.zip' }, { byExtensionId: 'other' }, { state: 'complete' }]) await f.created(f.download(Math.random(), extra));
  assert.deepEqual(actions(f, 'pause'), []); assert.equal(actions(f, 'window').length, 0);
  await f.send({ type: 'hypernab:takeover:settings', patch: { excludedHosts: ['files.example.org'] } });
  await f.created(f.download(7)); assert.deepEqual(actions(f, 'pause'), []);
  await f.send({ type: 'hypernab:takeover:settings', patch: { excludedHosts: [], enabled: false } });
  await f.created(f.download(8)); assert.deepEqual(actions(f, 'pause'), []);
  await f.send({ type: 'hypernab:takeover:settings', patch: { enabled: true, minBytes: 0 } });
  await f.created(f.download(9, { totalBytes: 10 })); assert.deepEqual(actions(f, 'pause'), [9]);
  await f.created(f.download(10, { totalBytes: -1 })); assert.deepEqual(actions(f, 'pause'), [9, 10], 'unknown size is still offered');
});

test('a download that finishes before it can be paused is left completely alone', async () => {
  const f = setup(); const item = f.download(1); f.items[1].state = 'complete';
  await f.created({ ...item, state: 'in_progress' });
  assert.deepEqual(actions(f, 'cancel'), []); assert.equal(actions(f, 'window').length, 0);
});

test('programs and scripts are marked; duplicates are reported', async () => {
  const f = setup({ duplicates: [{ title: 'x' }] }); await f.created(f.download(1, { filename: 'C:\\x\\setup.exe', url: 'https://files.example.org/setup.exe' }));
  const view = await f.send({ type: 'hypernab:takeover:next' });
  assert.equal(view.risk, 'program'); assert.equal(view.secure, true); assert.equal(view.duplicate, true);
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'browser' });
  await f.created(f.download(2, { filename: 'C:\\x\\run.ps1', url: 'https://files.example.org/run.ps1' }));
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).risk, 'script');
  await f.send({ type: 'hypernab:takeover:decide', id: 2, choice: 'browser' });
  await f.created(f.download(3, { filename: 'C:\\x\\old.msi', url: 'http://files.example.org/old.msi' }));
  const plain = await f.send({ type: 'hypernab:takeover:next' });
  assert.equal(plain.risk, 'program'); assert.equal(plain.secure, false, 'a program over http is told apart');
});

test('remembering: "always this type" skips the window next time and still falls back to the browser on any failure; "this site" leaves the site to the browser', async () => {
  let fail = false;
  const f = setup({ take: async body => { if (fail) throw new Error('boom'); return { id: 'j', name: body.fileName }; } });
  await f.created(f.download(1));
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now', rememberType: true });
  assert.deepEqual(plain((await f.send({ type: 'hypernab:takeover:settings' })).settings.autoTypes), ['zip']);
  await f.created(f.download(2));
  assert.equal(actions(f, 'window').length, 1, 'no second window'); assert.deepEqual(actions(f, 'cancel'), [1, 2]);
  fail = true; await f.created(f.download(3));
  assert.deepEqual(actions(f, 'resume'), [3], 'a failed silent take hands the download back'); assert.deepEqual(actions(f, 'cancel'), [1, 2]);
  const g = setup(); await g.created(g.download(1, { url: 'https://other.example.net/a.zip' }));
  await g.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'browser', rememberHost: true });
  assert.deepEqual(plain((await g.send({ type: 'hypernab:takeover:settings' })).settings.excludedHosts), ['other.example.net']);
  await g.created(g.download(2, { url: 'https://other.example.net/b.zip' })); assert.deepEqual(actions(g, 'pause'), [1]);
});

test('cancel removes only the browser download; the waiting list is capped and the rest go back to the browser', async () => {
  const f = setup(); await f.created(f.download(1));
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'cancel' });
  assert.deepEqual(actions(f, 'cancel'), [1]); assert.equal(f.requests.some(request => request.route === '/api/files/take'), false);
  const g = setup();
  for (let id = 1; id <= 32; id++) g.download(id);
  for (let id = 1; id <= 32; id++) await g.created(g.items[id]);
  assert.equal((await g.send({ type: 'hypernab:takeover:next' })).remaining, 29, 'at most 30 wait');
  assert.deepEqual(actions(g, 'resume').sort((a, b) => a - b), [31, 32]);
});

test('only the extension itself may talk to the takeover; settings are validated', async () => {
  const f = setup(); await f.created(f.download(1));
  assert.equal(await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' }, { id: 'someone-else' }), undefined);
  assert.equal(await f.send({ type: 'hypernab:takeover:release' }, { id: 'x' }), undefined);
  assert.deepEqual(actions(f, 'resume'), []);
  const settings = (await f.send({ type: 'hypernab:takeover:settings', patch: { minBytes: -5, autoTypes: ['<script>', 'zip'], excludedHosts: ['ok.example', 'a b'] } })).settings;
  assert.equal(settings.minBytes, 1048576); assert.deepEqual(plain(settings.autoTypes), ['zip']); assert.deepEqual(plain(settings.excludedHosts), ['ok.example']);
  assert.equal((await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'delete-everything' })).ok, false);
});

test('browser faster than the pause or removed meanwhile: nothing is taken twice and nothing is deleted', async () => {
  const f = setup(); await f.created(f.download(1));
  f.items[1].state = 'complete'; // the browser finished the file while the window was open
  const done = await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(done.ok, true); assert.equal(done.browserDone, true);
  assert.equal(f.requests.some(request => request.route === '/api/files/take'), false); assert.deepEqual(actions(f, 'cancel'), []);
  const g = setup(); await g.created(g.download(2)); delete g.items[2]; // the user cancelled it in the browser's own list
  const gone = await g.send({ type: 'hypernab:takeover:decide', id: 2, choice: 'now' });
  assert.equal(gone.gone, true); assert.equal(g.requests.some(request => request.route === '/api/files/take'), false);
  const h = setup(); const item = h.download(3); item.state = 'complete';
  await h.created({ ...item, state: 'in_progress' });
  assert.equal(h.log.some(entry => entry[0] === 'window'), false, 'finished before we looked: leave it alone');
  assert.deepEqual(actions(h, 'cancel'), []);
});

test('if the browser still ends up with a copy after the cancel, the answer says so (the file is never deleted)', async () => {
  const f = setup(); await f.created(f.download(1));
  const cancel = f.api.downloads.cancel; f.api.downloads.cancel = async id => { await cancel(id); f.items[id].state = 'complete'; };
  const answer = await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'now' });
  assert.equal(answer.ok, true); assert.equal(answer.browserCopy, true);
  assert.equal(f.log.some(entry => entry[0] === 'remove' || entry[0] === 'removeFile'), false);
});

test('a browser that cannot resume the stopped download is asked to download the same address again (never a lost download)', async () => {
  const f = setup(); await f.created(f.download(1));
  f.api.downloads.resume = async id => { f.log.push(['resume', id]); f.items[id].state = 'interrupted'; f.items[id].paused = false; }; // like Firefox before any data arrived
  await f.send({ type: 'hypernab:takeover:decide', id: 1, choice: 'browser' });
  assert.deepEqual(actions(f, 'download'), ['https://files.example.org/f1.zip']); assert.equal(f.log.find(entry => entry[0] === 'download')[2], 'f1.zip', 'the name the user saw is kept'); assert.deepEqual(actions(f, 'erase'), [1]);
  const g = setup(); await g.created(g.download(2));
  await g.send({ type: 'hypernab:takeover:decide', id: 2, choice: 'browser' });
  assert.deepEqual(actions(g, 'download'), [], 'a download that moves again is left alone');
  const h = setup(); await h.created(h.download(3));
  h.api.downloads.resume = async id => { h.log.push(['resume', id]); h.items[id].state = 'complete'; };
  await h.send({ type: 'hypernab:takeover:decide', id: 3, choice: 'browser' });
  assert.deepEqual(actions(h, 'download'), [], 'a finished download is never started a second time');
});

// ---- Firefox: the response is held, so the file never becomes a browser download ----
const settle = async promise => { let result = 'waiting'; promise?.then?.(value => { result = value; }); await wait(40); return result; };

test('Firefox: a file response is held (no browser download exists) until the user decides; cookies are read only after that', async () => {
  const f = setup({ firefox: true });
  assert.deepEqual(actions(f, 'webrequest'), ['blocking,responseHeaders']);
  const held = f.response(f.headers());
  assert.equal(await settle(held), 'waiting'); assert.equal(actions(f, 'window').length, 1); assert.deepEqual(f.cookieReads, []);
  assert.deepEqual(actions(f, 'pause'), []); assert.deepEqual(actions(f, 'cancel'), []);
  const view = await f.send({ type: 'hypernab:takeover:next' });
  assert.equal(view.name, 'Veri Paketi.zip'); assert.equal(view.host, 'files.example.org'); assert.equal(view.bytes, 50 * 1048576);
  const answer = await f.send({ type: 'hypernab:takeover:decide', id: view.id, choice: 'now' });
  assert.equal(answer.ok, true);
  const take = f.requests.find(request => request.route === '/api/files/take').body;
  assert.equal(take.url, 'https://files.example.org/get/a'); assert.equal(take.fileName, 'Veri Paketi.zip'); assert.equal(take.referer, 'https://files.example.org/page'); assert.equal(take.cookies[0].value, 'SECRET-COOKIE');
  assert.deepEqual(plain(await held), { cancel: true }, 'the request ends only after Hypernab accepted the file');
  assert.deepEqual(actions(f, 'cancel'), []); assert.deepEqual(actions(f, 'erase'), []);
});

test('Firefox: "browser" lets the very same request continue and its download is not asked about again', async () => {
  const f = setup({ firefox: true });
  const held = f.response(f.headers()); await wait(40);
  const view = await f.send({ type: 'hypernab:takeover:next' });
  await f.send({ type: 'hypernab:takeover:decide', id: view.id, choice: 'browser' });
  assert.deepEqual(plain(await held), {});
  await f.created(f.download(5, { url: 'https://files.example.org/get/a' }));
  assert.deepEqual(actions(f, 'pause'), [], 'the released download is left alone');
});

test('Firefox: cancel ends the request; a closed window or a failure hands the request back to the browser', async () => {
  const f = setup({ firefox: true });
  const first = f.response(f.headers()); await wait(40); const view = await f.send({ type: 'hypernab:takeover:next' });
  await f.send({ type: 'hypernab:takeover:decide', id: view.id, choice: 'cancel' });
  assert.deepEqual(plain(await first), { cancel: true });
  const second = f.response(f.headers({ url: 'https://files.example.org/get/b' }));
  await wait(30); f.close(1);
  assert.deepEqual(plain(await second), {}, 'closing the window never loses the file');
  const failing = setup({ firefox: true, take: async () => { throw Object.assign(new Error('x'), { code: 'ACCESS_DENIED' }); } });
  const third = failing.response(failing.headers()); await wait(40); const shown = await failing.send({ type: 'hypernab:takeover:next' });
  const answer = await failing.send({ type: 'hypernab:takeover:decide', id: shown.id, choice: 'now' });
  assert.equal(answer.ok, false); assert.equal(await settle(third), 'waiting', 'still held, the user can pick the browser');
  await failing.send({ type: 'hypernab:takeover:decide', id: shown.id, choice: 'browser' });
  assert.deepEqual(plain(await third), {});
});

test('Firefox: "always this type" takes the file without a window and still falls back to the browser on any failure', async () => {
  const f = setup({ firefox: true });
  await f.send({ type: 'hypernab:takeover:settings', patch: { autoTypes: ['zip'] } });
  assert.deepEqual(plain(await f.response(f.headers())), { cancel: true }); assert.equal(actions(f, 'window').length, 0);
  const failing = setup({ firefox: true, take: async () => { throw new Error('down'); } });
  await failing.send({ type: 'hypernab:takeover:settings', patch: { autoTypes: ['zip'] } });
  assert.deepEqual(plain(await failing.response(failing.headers())), {});
});

test('Firefox: only real file downloads are held; pages, inline types, other methods, private windows, small files and a closed app are not', async () => {
  const f = setup({ firefox: true });
  const types = type => [{ name: 'Content-Type', value: type }, { name: 'Content-Length', value: String(50 * 1048576) }];
  const left = [f.headers({ responseHeaders: types('text/html') }), f.headers({ responseHeaders: types('image/png') }), f.headers({ responseHeaders: types('application/pdf') }), f.headers({ responseHeaders: types('video/mp4') }),
    f.headers({ method: 'POST' }), f.headers({ statusCode: 206 }), f.headers({ incognito: true }), f.headers({ tabId: -1 }), f.headers({ originUrl: 'moz-extension://abc/page.html' }), f.headers({ responseHeaders: [] })];
  for (const details of left) assert.equal(f.response(details), undefined, JSON.stringify(details.responseHeaders?.[0]));
  assert.equal(actions(f, 'window').length, 0);
  assert.deepEqual(plain(await f.response(f.headers({ url: 'http://127.0.0.1:17846/x.zip' }))), {}, 'the app\'s own pages are left alone');
  assert.deepEqual(plain(await f.response(f.headers({ responseHeaders: [{ name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: '1000' }] }))), {}, 'below the minimum size');
  // octet-stream without a name is a download too; a pdf marked "attachment" as well (with an encoded name)
  assert.equal(await settle(f.response(f.headers({ url: 'https://files.example.org/x', responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }] }))), 'waiting');
  assert.equal(await settle(f.response(f.headers({ url: 'https://files.example.org/y', responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Disposition', value: "attachment; filename*=UTF-8''r%C3%A2por.pdf" }] }))), 'waiting');
  assert.equal((await f.send({ type: 'hypernab:takeover:next' })).name, 'x');
  const offline = setup({ firefox: true, online: false });
  assert.deepEqual(plain(await offline.response(offline.headers())), {}, 'app closed: the browser downloads by itself'); assert.equal(actions(offline, 'window').length, 0);
});
