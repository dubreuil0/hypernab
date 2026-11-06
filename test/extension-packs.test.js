import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { extensionPack, buildExtensions } from '../scripts/build-extensions.js';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const load = () => { const g = {}, context = vm.createContext({ globalThis: g }); vm.runInContext(read('../public/strings.js'), context); return { T: g.HypernabText, context }; };
const placeholders = text => (text.match(/\{\w+\}/g) || []).sort().join(',');
const WANTED = /^(panel|opt|x|lang|sub|job)\./;
const CODES = ['es', 'de', 'fr', 'ru', 'pt', 'ar'];

for (const code of CODES) {
  test(`${code}: the extension pack carries every panel / settings-page / message text with its placeholders, nothing of the app window`, () => {
    const { T, context } = load();
    vm.runInContext(extensionPack(code), context);
    const texts = T.TEXTS[code], en = T.TEXTS.en;
    for (const key of Object.keys(en).filter(key => WANTED.test(key))) {
      assert.ok(typeof texts[key] === 'string' && texts[key].trim(), `${code}: ${key}`);
      assert.equal(placeholders(texts[key]), placeholders(en[key]), `${code}: placeholders of ${key}`);
    }
    assert.ok(Object.keys(texts).every(key => WANTED.test(key) && key in en), 'only extension texts, all of them known');
    assert.ok(Object.keys(texts).length < 260 && !('app.settings' in texts), 'the app window texts stay out of the extension');
    assert.ok(extensionPack(code).length < 40000, 'a pack stays small');
  });
}

test('the built packages hold the packs, the localized names and an options page that loads every pack', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-ext-packs-'));
  try {
    const dirs = buildExtensions(out);
    for (const dir of Object.values(dirs)) {
      for (const code of CODES) assert.ok(fs.existsSync(`${dir}/lang/${code}.js`), `${dir} lang/${code}.js`);
      const html = fs.readFileSync(`${dir}/options.html`, 'utf8');
      for (const code of CODES) assert.ok(html.includes(`src="lang/${code}.js"`), `options page loads ${code}`);
      for (const locale of ['en', 'tr', 'es', 'de', 'fr', 'ru', 'pt_BR', 'pt_PT', 'ar']) {
        const messages = JSON.parse(fs.readFileSync(`${dir}/_locales/${locale}/messages.json`, 'utf8'));
        assert.ok(messages.extName.message && messages.extDescription.message.length <= 132, `${locale} name and a description of at most 132 characters`);
      }
    }
    const manifest = JSON.parse(fs.readFileSync(`${dirs.firefox}/manifest.json`, 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['strings.js', 'ds.js', 'panel-css.js', 'content.js'], 'no pack is injected into web pages');
    assert.ok(manifest.background.scripts.includes('lang/ar.js'));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('a page script asks for a further language once and then speaks it; nothing else changes it', async () => {
  const { T } = load(); T.setLanguage('en');
  const pack = { 'panel.download': 'Herunterladen' }; const asked = []; const listeners = [];
  const api = { storage: { local: { get: async () => ({ uiLanguage: 'de' }) }, onChanged: { addListener: fn => listeners.push(fn) } }, runtime: { sendMessage: async message => { asked.push(message); return { texts: pack }; } } };
  const changes = []; T.follow(api, code => changes.push(code));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(asked), JSON.stringify([{ type: 'hypernab:pack', code: 'de' }])); assert.equal(T.language(), 'de'); assert.equal(T.t('panel.download'), 'Herunterladen'); assert.equal(JSON.stringify(changes), '["de"]');
  assert.equal(T.t('panel.hide'), 'Hide on this page', 'a text the pack lacks falls back to English');
  listeners[0]({ uiLanguage: { newValue: 'xx' } }, 'local'); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(asked.length, 1, 'a code that is no language is never asked for');
  T.setLanguage('en'); const refused = { storage: { local: { get: async () => ({ uiLanguage: 'fr' }) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async () => ({ texts: null }) } };
  T.follow(refused, () => assert.fail('no texts, no change')); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(T.language(), 'en');
});

test('the extension words no longer speak of a queue; a download added for later reads as paused', () => {
  const { T } = load();
  for (const code of ['en', 'tr']) for (const key of Object.keys(T.TEXTS[code]).filter(key => /^(panel|opt|x|ctl)\./.test(key))) assert.ok(!/queue|kuyruk/i.test(T.TEXTS[code][key]), `${code}: ${key}`);
  assert.ok(!('panel.status.held' in T.TEXTS.en) && !('panel.status.held' in T.TEXTS.tr));
  const content = read('../extension/content.js');
  assert.ok(content.includes("status === 'held' ? T('panel.status.paused')"));
});

test('"Download the app" is offered only for an app problem: a link to the release page, no permission', () => {
  const content = read('../extension/content.js'), options = read('../extension/options.html'), float = read('../extension/float.js');
  assert.ok(/if \(appProblem\) \{ const get = el\('a'/.test(content) && content.includes("get.rel = 'noopener noreferrer'") && content.includes('https://github.com/dubreuil0/hypernab/releases/latest'));
  assert.ok(content.includes('result.appProblem === true'));
  assert.ok(/id="get-app"[^>]*href="https:\/\/github\.com\/dubreuil0\/hypernab\/releases\/latest"[^>]*hidden/.test(options));
  for (const code of ['NATIVE_DISCONNECTED', 'APP_OFFLINE', 'APP_TOO_OLD', 'APP_NOT_PAIRED']) assert.ok(float.includes(`'${code}'`), code);
  const manifest = JSON.parse(read('../extension/manifest.json'));
  assert.deepEqual(manifest.permissions, ['webRequest', 'storage', 'nativeMessaging', 'cookies', 'contextMenus'], 'no new permission');
});

test('Arabic mirrors the on-page panel and the settings page', () => {
  const content = read('../extension/content.js'), options = read('../extension/options.js');
  assert.ok(content.includes("panel.dir = toast.dir = hint.dir = globalThis.HypernabText.dir?.() || 'ltr'"));
  assert.ok(options.includes("document.documentElement.dir = globalThis.HypernabText.dir?.() || 'ltr'"));
  assert.ok(!/padding:4px 10px 4px 4px/.test(read('../extension/panel.css')), 'logical padding in the panel button');
});

test('the settings page, which holds every pack, starts in the language it showed last and does not reload in a loop', async () => {
  const memory = new Map([['hypernab-language', 'ar']]); const localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const g = { location: { protocol: 'chrome-extension:' }, localStorage, navigator: { language: 'en-US' } }, context = vm.createContext({ globalThis: g });
  vm.runInContext(read('../public/strings.js'), context); // the packs come after strings.js on that page
  assert.equal(g.HypernabText.language(), 'en', 'before the packs are there the page cannot speak Arabic yet');
  vm.runInContext(extensionPack('ar'), context);
  g.HypernabText.restore(); assert.equal(g.HypernabText.language(), 'ar'); assert.equal(g.HypernabText.dir(), 'rtl');
  const reloads = []; const api = { storage: { local: { get: async () => ({ uiLanguage: 'ar' }) }, onChanged: { addListener() {} } } };
  g.HypernabText.follow(api, code => reloads.push(code)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reloads.length, 0, 'the language is already the one in the app: no reload');
  assert.ok(read('../extension/options.js').indexOf('HypernabText.restore?.()') < read('../extension/options.js').indexOf('HypernabText.follow?.('), 'restored before it follows');
});
