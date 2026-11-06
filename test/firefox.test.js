import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

test('kaynak manifest Firefox event page ve ortak core kullanır; Chromium paketi ayrı üretilir', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.background.scripts, ['native-config.js', 'native.js', 'core.js', 'strings.js', 'lang/es.js', 'lang/de.js', 'lang/fr.js', 'lang/ru.js', 'lang/pt.js', 'lang/ar.js', 'control.js', 'background.js', 'float.js', 'link-download.js']);
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
