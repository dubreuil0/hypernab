import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { buildExtensions } from '../scripts/release/build-extensions.js';

function load(context, file) { return vm.runInContext(fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context); }

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
test('Firefox/Chromium paketleri aynı kodu, farklı doğru arka plan manifestlerini taşır', t => {
  const preferred = (process.env.LOCALAPPDATA + '/Temp/opencode');
  const root = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builds = buildExtensions(root);
  const firefox = JSON.parse(fs.readFileSync(path.join(builds.firefox, 'manifest.json'), 'utf8'));
  const chromium = JSON.parse(fs.readFileSync(path.join(builds.chromium, 'manifest.json'), 'utf8'));
  assert.deepEqual(firefox.background.scripts, ['native-config.js', 'native.js', 'core.js', 'strings.js', 'lang/es.js', 'lang/de.js', 'lang/fr.js', 'lang/ru.js', 'lang/pt.js', 'lang/ar.js', 'control.js', 'background.js', 'float.js', 'link-download.js']); assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(chromium.background, { service_worker: 'background.js' }); assert.equal(chromium.browser_specific_settings, undefined); assert.equal(chromium.minimum_chrome_version, '121');
  assert.equal(firefox.content_scripts[0].all_frames, true); assert.equal(chromium.content_scripts[0].all_frames, true);
  // No popup: a click on the icon switches capture; the rest is in the right-click menu and the settings page.
  for (const manifest of [firefox, chromium]) {
    assert.equal(manifest.action.default_popup, undefined); assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true }); assert.ok(manifest.permissions.includes('contextMenus'));
  }
  for (const dir of [builds.firefox, builds.chromium]) for (const file of ['control.js', 'options.html', 'options.js', 'options.css', 'strings.js', 'ds.js', 'ds.css']) assert.ok(fs.existsSync(path.join(dir, file)), file);
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
