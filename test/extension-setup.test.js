import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromiumExtensionId } from '../scripts/setup/install-native.js';
import { STORES } from '../public/extension-setup.js';

const { STORE_PAGES } = createRequire(import.meta.url)('../desktop/browsers.cjs');
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('the store addresses the page opens are the ones the desktop shell accepts, and the Chrome one is the id the app pairs with', () => {
  assert.ok(STORE_PAGES.chromium.test(STORES.chromium) && STORE_PAGES.firefox.test(STORES.firefox));
  assert.ok(!STORE_PAGES.firefox.test(STORES.chromium) && !STORE_PAGES.chromium.test(STORES.firefox), 'each kind accepts only its own store');
  const key = JSON.parse(read('../extension/chromium-key.json')).key;
  assert.equal(STORES.chromium.split('/').pop(), chromiumExtensionId(key), 'the Chrome Web Store item is the extension the app trusts');
  const gecko = JSON.parse(read('../extension/manifest.json')).browser_specific_settings?.gecko?.id ?? null;
  assert.ok(STORES.firefox.includes('hypernab-video-catcher') && (gecko === null || /^\{[0-9a-f-]{36}\}$/.test(gecko)));
});

test('Settings: the extension row heads the page (one compact row), the old manual setup is gone, and no page names a browser', () => {
  const html = read('../public/index.html');
  assert.ok(html.indexOf('id="s-extension"') > 0 && html.indexOf('id="s-extension"') < html.indexOf('id="s-appearance"'), 'the row is above General');
  assert.ok(!html.includes('id="s-browser"') && !html.includes('href="#s-browser"') && !html.includes('extension-help'), 'the old extension section and its nav entry are gone');
  for (const id of ['ext-state', 'ext-stores', 'ext-store-chromium', 'ext-store-firefox', 'ext-problem', 'repair-native', 'copy-token', 'ext-welcome', 'ext-welcome-default', 'ext-welcome-close']) assert.ok(html.includes(`id="${id}"`), id);
  const row = /<section class="group" id="s-extension">[\s\S]*?<\/section>/.exec(html)[0];
  for (const name of ['Chrome', 'Edge', 'Brave', 'Opera']) assert.ok(!new RegExp(`\\b${name}\\b`).test(row.replace('Chrome Web Store', '')), `${name} is not named`);
  assert.ok(!/<h2/.test(row), 'no heading: the row stays one line');
  for (const button of html.match(/<button class="btn[^>]*id="ext-[^>]*>.*?<\/button>/gs)) assert.ok(button.includes('<svg'), 'every button has an icon');
  assert.ok(!fs.existsSync(new URL('../public/extension-help.js', import.meta.url)));
});

test('the old manual-setup texts are gone from every language and the new ones exist in all of them', () => {
  const strings = read('../public/strings.js');
  assert.ok(!/ext\.(chromium|firefox|wizard)\./.test(strings), 'no manual setup text in strings.js');
  for (const code of ['es', 'de', 'fr', 'ru', 'pt', 'ar']) {
    const pack = read(`../public/lang/${code}.js`);
    assert.ok(!/"ext\.(chromium|firefox|wizard)\./.test(pack), code);
    for (const key of ['ext.row.title', 'ext.row.connected', 'ext.row.disconnected', 'ext.welcome.title', 'ext.welcome.default', 'ext.welcome.later', 'ext.opened', 'ext.copiedLink']) assert.ok(pack.includes(`"${key}"`), `${code}: ${key}`);
  }
});
