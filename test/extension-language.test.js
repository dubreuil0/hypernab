import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const load = () => { const g = {}; vm.runInContext(read('../public/strings.js'), vm.createContext({ globalThis: g })); return g.HypernabText; };

test('every text key the extension uses exists in both languages; no Turkish sentence is left in its code', () => {
  const { TEXTS } = load(); const used = new Set(); const leftovers = [];
  for (const name of fs.readdirSync(new URL('../extension/', import.meta.url)).filter(file => file.endsWith('.js'))) {
    const text = read(`../extension/${name}`);
    for (const match of text.matchAll(/\bT\('([^']+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/(?:new Error|message:|title:)\(?\s*['`"]([^'`"\n]*[ğüşıöçĞÜŞİÖÇ][^'`"\n]*)['`"]/g)) leftovers.push(`${name}: ${match[1].slice(0, 60)}`);
  }
  assert.ok(used.size > 60, `only ${used.size} keys`);
  for (const key of used) { assert.ok(TEXTS.en[key], `en: ${key}`); assert.ok(TEXTS.tr[key], `tr: ${key}`); }
  assert.deepEqual(leftovers, []);
});

test('the extension follows the app\'s language: stored by the background, read by every page, changed live', async () => {
  const T = load(); T.setLanguage('en');
  const listeners = []; const stored = { uiLanguage: 'tr' }; const changes = [];
  const api = { storage: { local: { get: async () => ({ ...stored }) }, onChanged: { addListener: fn => listeners.push(fn) } } };
  T.follow(api, code => changes.push(code));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(T.language(), 'tr'); assert.deepEqual(changes, ['tr']);
  listeners[0]({ uiLanguage: { newValue: 'en' } }, 'local'); assert.equal(T.language(), 'en'); assert.deepEqual(changes, ['tr', 'en']);
  listeners[0]({ uiLanguage: { newValue: 'en' } }, 'local'); assert.deepEqual(changes, ['tr', 'en'], 'the same language is no change');
  listeners[0]({ uiLanguage: { newValue: 'xx' } }, 'local'); assert.equal(T.language(), 'en', 'a language without texts is ignored');
  listeners[0]({ uiLanguage: { newValue: 'tr' } }, 'sync'); assert.equal(T.language(), 'en', 'only the local storage counts');
  assert.doesNotThrow(() => T.follow({}, () => {}));
});

test('an extension page that is drawn again starts in the remembered language and does not reload in a loop', async () => {
  const memory = new Map(); const localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const page = () => { const g = { location: { protocol: 'moz-extension:' }, localStorage, navigator: { language: 'en-US' } }; vm.runInContext(read('../public/strings.js'), vm.createContext({ globalThis: g })); return g.HypernabText; };
  const api = { storage: { local: { get: async () => ({ uiLanguage: 'tr' }) }, onChanged: { addListener: () => {} } } };
  const first = page(); const changes = []; assert.equal(first.language(), 'en');
  first.follow(api, code => changes.push(code)); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(changes, ['tr'], 'the first time it changes once (the page reloads)');
  const second = page(); assert.equal(second.language(), 'tr', 'the redrawn page starts in the app\'s language');
  second.follow(api, code => changes.push(code)); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(changes, ['tr'], 'and it does not change (reload) again');
  // a web page is never given the extension's memory
  const web = { location: { protocol: 'https:' }, localStorage, navigator: { language: 'en-US' } }; vm.runInContext(read('../public/strings.js'), vm.createContext({ globalThis: web }));
  assert.equal(web.HypernabText.language(), 'en');
});

test('the browser\'s own name and description exist in both languages', () => {
  const manifest = JSON.parse(read('../extension/manifest.json'));
  assert.equal(manifest.name, '__MSG_extName__'); assert.equal(manifest.default_locale, 'en');
  for (const code of ['en', 'tr']) { const messages = JSON.parse(read(`../extension/_locales/${code}/messages.json`)); assert.ok(messages.extName.message && messages.extDescription.message, code); }
});
