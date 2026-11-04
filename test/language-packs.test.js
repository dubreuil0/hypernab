import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { INTERFACE_LANGUAGES } from '../src/language.js';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const load = () => { const g = {}, context = vm.createContext({ globalThis: g }); vm.runInContext(read('../public/strings.js'), context); return { T: g.HypernabText, context }; };
// What a language pack must cover: the app window, the desktop shell and the engine's messages (the extension's own texts come later).
const inScope = key => /^(app|e|desk|lang|sub|job|ext)\./.test(key);
const placeholders = text => (text.match(/\{\w+\}/g) || []).sort().join(',');

test('the languages the app can be set to are exactly the built-in two plus the packs, and the Settings list offers each', () => {
  const { T } = load();
  assert.deepEqual([...INTERFACE_LANGUAGES].sort(), ['en', ...T.packs, 'tr'].sort());
  const html = read('../public/index.html');
  const offered = [...html.match(/<select id="set-interfaceLanguage">(.*?)<\/select>/s)[1].matchAll(/<option value="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(offered.sort(), ['auto', ...INTERFACE_LANGUAGES].sort());
});

for (const code of ['es', 'de', 'fr', 'ru', 'pt', 'ar']) {
  test(`${code}: the pack loads, covers every window / desktop / engine text and keeps every placeholder`, () => {
    const { T, context } = load();
    assert.ok(T.packs.includes(code) && !T.TEXTS[code], 'not loaded until its file runs');
    vm.runInContext(read(`../public/lang/${code}.js`), context);
    const texts = T.TEXTS[code], en = T.TEXTS.en;
    assert.ok(texts, 'the pack registered itself');
    for (const key of Object.keys(en).filter(inScope)) {
      assert.ok(typeof texts[key] === 'string' && texts[key].trim(), `${code}: ${key}`);
      assert.equal(placeholders(texts[key]), placeholders(en[key]), `${code}: placeholders of ${key}`);
      assert.equal((texts[key].match(/\n/g) || []).length, (en[key].match(/\n/g) || []).length, `${code}: line breaks of ${key}`);
    }
    for (const key of Object.keys(texts)) assert.ok(key in en, `${code}: ${key} is not a known text`);
    T.setLanguage(code);
    assert.equal(T.language(), code);
    assert.equal(T.dir(), code === 'ar' ? 'rtl' : 'ltr', 'only Arabic is written right to left');
    assert.equal(T.t('app.settings'), texts['app.settings']);
    assert.equal(T.t('panel.download'), en['panel.download'], 'a text the pack does not carry falls back to English');
  });
}
