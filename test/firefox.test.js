import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

test('kaynak manifest Firefox event page ve ortak core kullanır; Chromium paketi ayrı üretilir', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.background.scripts, ['native-config.js', 'native.js', 'core.js', 'background.js', 'float.js', 'takeover.js']);
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
  assert.ok(manifest.browser_specific_settings.gecko.id);
  assert.equal(manifest.content_scripts[0].all_frames, true);
});

test('Firefox browser API ile yakalama, badge ve sayfa temizleme çalışır', async () => {
  const store = {}, badges = [];
  let navigate;
  const context = vm.createContext({ URL, browser: {
    webRequest: { onHeadersReceived: { addListener() {} } },
    tabs: { onUpdated: { addListener(listener) { navigate = listener; } }, onRemoved: { addListener() {} } },
    action: { async setBadgeText(value) { badges.push(value.text); }, async setBadgeBackgroundColor() {} },
    storage: { session: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[k]])); },
      async set(value) { Object.assign(store, value); },
      async remove(key) { delete store[key]; }
    }}
  }});
  vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`capture({ tabId: 3, statusCode: 200, url: 'https://example.com/video.m3u8' })`, context);
  await vm.runInContext('writes', context);
  assert.equal(store['tab:3'][0].kind, 'HLS');
  assert.deepEqual(badges, ['1']);
  navigate(3, { status: 'loading' });
  await vm.runInContext('writes', context);
  assert.equal(store['tab:3'], undefined);
  assert.deepEqual(badges, ['1', '']);
});

test('Firefox popup yalnızca browser namespace ile eşleşebilir ve sayfayı gönderebilir', async () => {
  const nodes = new Map(), calls = [], storedToken = 'b'.repeat(64);
  function node() { return { value: '', textContent: '', className: '', disabled: false, events: {}, addEventListener(event, fn) { this.events[event] = fn; }, replaceChildren() {}, append() {} }; }
  const context = vm.createContext({
    URL, AbortSignal, crypto: webcrypto,
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement() { return node(); } },
    browser: {
      tabs: { async query() { return [{ id: 3, url: 'https://example.com/video', title: 'Örnek' }]; } },
      storage: { local: { async get() { return { token: storedToken }; }, async set() {} }, session: { async get() { return {}; } } }
    },
    async fetch(url, options) { calls.push({ url, options }); return { ok: true, async json() { return url.endsWith('/api/inspect') ? { title: 'Doğrulanmış video', extension: 'mp4', heights: [720], options: [{ id: 'source720', label: '720p · MP4', filesize: 10000, sizeKind: 'exact' }], defaultOptionId: 'source720' } : url.endsWith('/api/jobs') && options?.method === 'POST' ? { id: '00000000-0000-0000-0000-000000000001' } : url.endsWith('/api/jobs') ? [] : { extensionProtocol: 1 }; } }; }
  });
  vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'), context);
  // Await the initialized popup; no real browser or external requests are used.
  await vm.runInContext('initialized', context);
  assert.equal(nodes.get('token').value, storedToken);
  assert.equal(nodes.get('status').textContent, 'Yerel uygulama bağlı.');
  await nodes.get('send-page').events.click();
  assert.equal(calls.some(call => call.url.endsWith('/api/jobs') && call.options.method === 'POST'), false, 'İnceleme tek başına indirme başlatmamalı.');
  assert.equal(nodes.get('preview-title').textContent, 'Doğrulanmış video');
  assert.equal(nodes.get('preview').hidden, false);
  nodes.get('preview-quality').value = 'source720';
  await nodes.get('confirm-download').events.click();
  const sent = calls.find(call => call.url.endsWith('/api/jobs') && call.options.method === 'POST');
  assert.ok(sent);
  assert.equal(sent.options.headers.Authorization, `Bearer ${storedToken}`);
  assert.equal(JSON.parse(sent.options.body).engine, 'extractor');
  assert.equal(JSON.parse(sent.options.body).title, 'Doğrulanmış video');
  assert.equal(JSON.parse(sent.options.body).quality, 'best');
  assert.equal(JSON.parse(sent.options.body).formatId, 'source720');
  assert.match(JSON.parse(sent.options.body).submissionId, /^[a-f0-9-]{36}$/);
});
