import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/appearance.js', import.meta.url), 'utf8');
function boot(value, broken = false) {
  let stored;
  const context = vm.createContext({ document: { documentElement: { dataset: {} } }, localStorage: { getItem() { if (broken) throw Error(); return value; }, setItem(_key, data) { if (broken) throw Error(); stored = data; } } });
  vm.runInContext(script, context);
  return { context, data: context.document.documentElement.dataset, stored: () => stored };
}
test('appearance bootstrap defaults compact before paint; saved normal is respected', () => {
  assert.equal(boot(null).data.appearance, 'compact');
  const saved = boot(JSON.stringify({ appearance: 'normal', textSize: 'large' }));
  assert.equal(saved.data.appearance, 'normal'); assert.equal(saved.data.textSize, 'large');
  saved.context.HypernabAppearance.apply({ appearance: 'compact', textSize: 'small', token: 'NEVER-CACHE' });
  assert.equal(saved.data.appearance, 'compact'); assert.ok(!saved.stored().includes('NEVER-CACHE'));
});
test('theme and accent are validated, cached, and "system" follows the operating system', () => {
  const dark = boot(JSON.stringify({ theme: 'light', accent: 'violet' }));
  assert.equal(dark.data.theme, 'light'); assert.equal(dark.data.scheme, 'light'); assert.equal(dark.data.accent, 'violet');
  const bad = boot(JSON.stringify({ theme: 'neon', accent: 'pink' })); assert.equal(bad.data.theme, 'dark'); assert.equal(bad.data.scheme, 'dark'); assert.equal(bad.data.accent, 'green');
  assert.equal(boot(null).data.scheme, 'dark');
  assert.match(boot(JSON.stringify({ theme: 'system' })).data.scheme, /^(dark|light)$/);
});
test('bad cache, invalid values or denied storage never break the app', () => {
  for (const cache of ['not json', '{"appearance":"evil","textSize":100}', 'null']) assert.equal(boot(cache).data.appearance, 'compact');
  assert.equal(boot(null, true).data.textSize, 'normal');
});
