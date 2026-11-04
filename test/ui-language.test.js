import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { interfaceLanguage, validInterfaceLanguage, resolveLanguage } from '../src/language.js';
import { DownloadQueue } from '../src/downloads.js';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const strings = {}; vm.runInContext(read('../public/strings.js'), vm.createContext({ globalThis: strings }));
const { TEXTS } = strings.HypernabText;
const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&quot;/g, '"');

test('the app window markup: every key exists in both languages, the page itself is English, no Turkish text is left in it', () => {
  const html = read('../public/index.html');
  const keys = new Set([...html.matchAll(/data-i18n(?:-title|-aria|-placeholder|-alt)?="([^"]+)"/g)].map(m => m[1]));
  assert.ok(keys.size > 150, `only ${keys.size} keys`);
  for (const key of keys) { assert.ok(TEXTS.en[key], `en: ${key}`); assert.ok(TEXTS.tr[key], `tr: ${key}`); }
  // what the markup shows before any script runs is the English text of the same key
  for (const m of html.matchAll(/<(\w+)([^>]*?)\sdata-i18n="([^"]+)"([^>]*)>([^<]*)</g)) assert.equal(decode(m[5]).trim(), TEXTS.en[m[3]], m[3]);
  for (const m of html.matchAll(/\s(title|aria-label|placeholder)="([^"]*)"([^>]*?)data-i18n-(?:title|aria|placeholder)="([^"]+)"/g)) assert.equal(decode(m[2]), TEXTS.en[m[4]], m[4]);
  const body = html.slice(html.indexOf('</svg>'));
  assert.equal(/[ğüşıöçĞÜŞİÖÇ]/.test(body.replace(/<option value="\w+"[^>]*>[^<]*<\/option>/g, '')), false, 'a Turkish text is left in the markup: give it a key');
});

test('the language of the app: the setting, else Windows when the app has it, else English', () => {
  assert.equal(interfaceLanguage('auto', 'tr-TR'), 'tr'); assert.equal(interfaceLanguage('auto', 'en-GB'), 'en');
  assert.equal(interfaceLanguage('auto', 'de-DE'), 'de'); assert.equal(interfaceLanguage('auto', 'pt-BR'), 'pt'); assert.equal(interfaceLanguage('auto', 'ja-JP'), 'en', 'no Japanese texts: English'); assert.equal(interfaceLanguage('auto', ''), 'en'); assert.equal(interfaceLanguage(undefined, undefined), 'en');
  assert.equal(interfaceLanguage('tr', 'ja-JP'), 'tr'); assert.equal(interfaceLanguage('en', 'tr-TR'), 'en');
  assert.equal(interfaceLanguage('xx', 'tr-TR'), 'tr', 'junk is the same as automatic');
  for (const ok of ['auto', 'en', 'tr', 'es', 'de', 'fr', 'ru', 'pt']) assert.ok(validInterfaceLanguage(ok)); for (const bad of ['', 'ja', 'TR', null, 5]) assert.ok(!validInterfaceLanguage(bad));
  assert.equal(resolveLanguage('auto', interfaceLanguage('auto', 'tr-TR')), 'tr', 'automatic subtitle language = the interface language');
  assert.ok(Object.keys(TEXTS).every(code => interfaceLanguage(code, '') === code), 'every translated language can be chosen');
});

test('the engine keeps the setting, resolves it and refuses a language it has no texts for', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-lang-'));
  try {
    const make = locale => new DownloadQueue({ locale, directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
    const queue = make('ja-JP');
    assert.equal(queue.settings.interfaceLanguage, 'auto'); assert.equal(queue.interfaceLanguage(), 'en');
    assert.equal(queue.setSettings({ interfaceLanguage: 'tr' }).interfaceLanguage, 'tr'); assert.equal(queue.interfaceLanguage(), 'tr');
    assert.equal(queue.subtitleLanguage(), 'tr', 'the automatic subtitle language follows it');
    assert.throws(() => queue.setSettings({ interfaceLanguage: 'ja' }));
    assert.equal(make('tr-TR').interfaceLanguage(), 'tr');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply(): static texts and attributes follow the language', () => {
  const node = (attrs = {}) => { const set = { ...attrs }; return { dataset: { i18n: attrs['data-i18n'] }, textContent: '', set, getAttribute: name => attrs[name], setAttribute(name, value) { set[name] = value; } }; };
  const text = node({ 'data-i18n': 'app.theme' }), title = node({ 'data-i18n-title': 'app.settings' });
  const root = { querySelectorAll: selector => (selector === '[data-i18n], [data-t]' ? [text] : selector === '[data-i18n-title]' ? [title] : []) };
  const T = strings.HypernabText; T.setLanguage('tr'); T.apply(root);
  assert.equal(text.textContent, 'Tema'); assert.equal(title.set.title, 'Ayarlar');
  T.setLanguage('en'); T.apply(root); assert.equal(text.textContent, 'Theme'); assert.equal(title.set.title, 'Settings');
  T.setLanguage('xx'); assert.equal(T.language(), 'en', 'unknown language: English');
});
