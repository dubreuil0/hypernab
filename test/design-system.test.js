import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ globalThis: null });
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../public/ds.js', import.meta.url), 'utf8'), context);
const DS = context.HypernabDS;
const theme = fs.readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8');
const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const ds = fs.readFileSync(new URL('../public/ds.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const declarations = body => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;{}]+?)\s*(?=;|$)/g)].map(m => [m[1], m[2]]));
const rule = (css, selector) => { const start = css.indexOf(selector); assert.ok(start >= 0, selector); const open = css.indexOf('{', start); return css.slice(open + 1, css.indexOf('}', open)); };

test('extension tokens equal the app theme (theme.css and app.css): one palette, no drift', () => {
  const dark = { ...declarations(rule(appCss, ':root{')), ...declarations(rule(theme, ':root {')) };
  for (const [name, value] of Object.entries(DS.tables.DARK)) assert.equal(dark[name], value, `dark ${name}`);
  const light = declarations(rule(theme, 'html[data-scheme="light"] {'));
  for (const [name, value] of Object.entries(DS.tables.LIGHT)) assert.equal(light[name], value, `light ${name}`);
  for (const accent of ['green', 'blue', 'orange', 'violet']) {
    assert.equal(declarations(rule(theme, `html[data-accent="${accent}"] {`))['--accent'], DS.tables.ACCENTS.dark[accent], `dark accent ${accent}`);
    assert.equal(declarations(rule(theme, `html[data-scheme="light"][data-accent="${accent}"] {`))['--accent'], DS.tables.ACCENTS.light[accent], `light accent ${accent}`);
  }
});

test('tokens(): dark, light and system-following blocks', () => {
  assert.match(DS.tokens('dark', 'blue'), /^:host\{color-scheme:dark;.*--accent:#6cb4ff;/);
  assert.match(DS.tokens('light', 'violet'), /color-scheme:light;.*--accent:#6a45d1;/);
  const auto = DS.tokens('auto', 'orange', '.panel');
  assert.match(auto, /^\.panel\{color-scheme:dark;/);
  assert.match(auto, /@media \(prefers-color-scheme:light\)\{\.panel\{color-scheme:light;.*--accent:#bd5b00;/);
  assert.match(DS.tokens('dark', 'nope'), /--accent:#b6f36b;/, 'an unknown accent falls back to green');
});

test('stylesheet hygiene: no blur, no big shadow, no animation or transition, only theme colours, logical properties', () => {
  assert.doesNotMatch(ds, /backdrop-filter|filter\s*:|blur\(|animation|transition|@keyframes/);
  for (const shadow of ds.match(/box-shadow:[^;]+/g) || []) assert.equal(shadow, 'box-shadow:0 4px 12px #0005', 'only the small list shadow');
  let bare = ds; while (/var\([^()]*\)/.test(bare)) bare = bare.replace(/var\([^()]*\)/g, ''); // colours appear only as var() fallbacks
  assert.deepEqual(bare.match(/#[0-9a-f]{3,8}\b/gi) || [], ['#0005'], 'the only fixed colour is the small list shadow');
  assert.doesNotMatch(ds, /margin-left|margin-right|padding-left|padding-right|(?<![\w-])left:|(?<![\w-])right:|text-align:\s*(left|right)/, 'right-to-left languages mirror');
});

const names = ['Almanca', 'Arapça', 'Bulgarca', 'Çince', 'Türkçe'];
const opts = () => names.map((label, i) => ({ value: String(i), label }));

test('list keyboard: arrows move, skip disabled options, stop at the ends; Enter commits; Escape closes', () => {
  const options = [{ label: 'a' }, { label: 'b', disabled: true }, { label: 'c' }];
  assert.deepEqual({ ...DS.listKey({ open: false, index: -1 }, 'ArrowDown', options) }, { open: true, index: 0, commit: false });
  assert.equal(DS.listKey({ open: true, index: 0 }, 'ArrowDown', options).index, 2, 'the disabled option is skipped');
  assert.equal(DS.listKey({ open: true, index: 2 }, 'ArrowDown', options).index, 2, 'no wrap past the end');
  assert.equal(DS.listKey({ open: true, index: 2 }, 'ArrowUp', options).index, 0);
  assert.equal(DS.listKey({ open: true, index: 0 }, 'End', options).index, 2);
  assert.equal(DS.listKey({ open: true, index: 2 }, 'Home', options).index, 0);
  assert.deepEqual({ ...DS.listKey({ open: true, index: 2 }, 'Enter', options) }, { open: false, index: 2, commit: true });
  assert.deepEqual({ ...DS.listKey({ open: false, index: 2 }, ' ', options) }, { open: true, index: 2, commit: false });
  assert.deepEqual({ ...DS.listKey({ open: true, index: 2 }, 'Escape', options) }, { open: false, index: 2, commit: false });
  assert.equal(DS.listKey({ open: true, index: -1 }, 'Enter', options).commit, false, 'nothing active, nothing chosen');
  assert.equal(DS.listKey({ open: true, index: 0 }, 'Tab', options).commit, true, 'Tab takes the active option and moves on');
});

test('type-ahead: first letters find the option, the same letter cycles, disabled ones are skipped, Unicode letters work', () => {
  const options = opts();
  assert.equal(DS.typeahead(options, 0, 'a'), 1, 'cycles from the next one');
  assert.equal(DS.typeahead(options, 1, 'a'), 0, 'wraps around');
  assert.equal(DS.typeahead(options, 0, 'ar'), 1);
  assert.equal(DS.typeahead(options, 0, 'ç'), 3, 'Turkish letters');
  assert.equal(DS.typeahead(options, 0, 't'), 4, 'case does not matter');
  assert.equal(DS.typeahead(options, 0, 'x'), -1);
  assert.equal(DS.typeahead([{ label: 'Rusça', disabled: true }], 0, 'r'), -1);
});

test('panel stylesheet follows the same hygiene and uses only theme colours', () => {
  const panel = fs.readFileSync(new URL('../extension/panel.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(panel, /backdrop-filter|filter\s*:|blur\(|animation|transition|@keyframes/);
  let bare = panel; while (/var\([^()]*\)/.test(bare)) bare = bare.replace(/var\([^()]*\)/g, '');
  assert.deepEqual((bare.match(/#[0-9a-f]{3,8}\b/gi) || []).sort(), ['#0004', '#0005'], 'fixed colours: only the two small shadows');
  for (const shadow of panel.match(/box-shadow:[^;}]+/g) || []) assert.match(shadow, /^box-shadow:0 [24]px (8|12)px #000[45]$/);
});

test('texts: English and Turkish have exactly the same keys, none empty, and the same placeholders', () => {
  const strings = {}; vm.runInContext(fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8'), vm.createContext({ globalThis: strings }));
  const { en, tr } = strings.HypernabText.TEXTS;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(tr).sort());
  const holes = text => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const key of Object.keys(en)) { assert.ok(en[key].trim() && tr[key].trim(), key); assert.equal(holes(en[key]), holes(tr[key]), `placeholders of ${key}`); }
  assert.equal(strings.HypernabText.t('panel.nonexistent'), 'panel.nonexistent', 'a missing key shows its name, never nothing');
});
