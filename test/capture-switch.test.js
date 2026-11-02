import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The toolbar icon (no popup): a click switches capture; the right-click menu carries the rest; the rest of the extension asks
// HypernabControl.on. A tiny fake of the browser API records what the code does.
const read = file => fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
const strings = fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function setup({ stored = {} } = {}) {
  const calls = { icon: [], badge: [], title: [], items: [], sent: [], optionsOpened: 0, tabMessages: [] };
  const local = { ...stored }, handlers = {};
  const api = {
    storage: { local: { async get(key) { return key in local ? { [key]: local[key] } : {}; }, async set(values) { const changes = {}; for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: local[k], newValue: v }; local[k] = v; } for (const fn of handlers.changed || []) fn(changes, 'local'); } },
      onChanged: { addListener(fn) { (handlers.changed ||= []).push(fn); } } },
    action: { async setTitle(v) { calls.title.push(v.title); }, async setIcon(v) { calls.icon.push(v.path); }, async setBadgeText(v) { calls.badge.push(v); }, async setBadgeBackgroundColor() {}, onClicked: { addListener(fn) { handlers.click = fn; } } },
    tabs: { async query() { return [{ id: 7 }]; }, async sendMessage(id, message) { calls.tabMessages.push([id, message.type]); } },
    contextMenus: { removeAll(done) { calls.items = []; done(); }, create(item, done) { calls.items.push(item); done?.(); }, onClicked: { addListener(fn) { handlers.menu = fn; } } },
    runtime: { async sendMessage(message) { calls.sent.push(message); return { ok: true }; }, async openOptionsPage() { calls.optionsOpened++; }, onInstalled: { addListener(fn) { handlers.installed = fn; } }, onStartup: { addListener() {} } },
  };
  const context = vm.createContext({ browser: api, Promise, JSON, Object, Number, String, Boolean, Array, setTimeout, clearTimeout, globalThis: null, HypernabNativeChannel: class { async request() { calls.sent.push({ native: 'show' }); return {}; } close() {} } });
  context.globalThis = context;
  vm.runInContext(strings, context); vm.runInContext("HypernabText.setLanguage('tr')", context); vm.runInContext(read('control.js'), context);
  return { calls, local, handlers, context, control: () => context.HypernabControl };
}

test('capture is on by default; a click on the icon switches it, remembers it and marks the icon', async () => {
  const app = setup(); await flush();
  assert.equal(app.control().on, true);
  const icon = () => JSON.parse(JSON.stringify(app.calls.icon.at(-1)));
  assert.deepEqual(icon(), { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }, 'on: the normal icon');
  app.handlers.click(); await flush();
  assert.equal(app.control().on, false); assert.equal(app.local.captureEnabled, false, 'saved, so it survives a restart');
  assert.deepEqual(icon(), { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' }, 'off: grey icon with a red slash, seen at a glance');
  assert.match(app.calls.title.at(-1), /capture is off/); // the toolbar tooltip is always English
  app.handlers.click(); await flush();
  assert.equal(app.control().on, true); assert.deepEqual(icon(), { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
  for (const size of [16, 32]) assert.ok(fs.existsSync(new URL(`../extension/icons/icon-off-${size}.png`, import.meta.url)), 'the off icons ship with the extension');
});

test('the result of "Download with Hypernab" on a link shows on the icon with an English tooltip, then goes away; capture itself is untouched', async () => {
  const app = setup(); await flush();
  await app.control().notice('added', 'Setup.exe'); await flush();
  assert.equal(app.calls.badge.at(-1).text, 'OK'); assert.match(app.calls.title.at(-1), /Added to Hypernab: .Setup\.exe./);
  await app.control().notice('duplicate', 'Setup.exe'); await flush();
  assert.equal(app.calls.badge.at(-1).text, '='); assert.match(app.calls.title.at(-1), /already in Hypernab/);
  await app.control().notice('failed', 'Setup.exe', 'The link returned a web page.'); await flush();
  assert.equal(app.calls.badge.at(-1).text, '!'); assert.match(app.calls.title.at(-1), /could not take .Setup\.exe.\. The link returned a web page\./);
  await app.control().notice('nonsense', 'x'); await flush();
  assert.equal(app.calls.badge.at(-1).text, '!', 'an unknown kind changes nothing');
  assert.equal(app.control().on, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.icon.at(-1))), { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
});

test('a saved "off" is respected after a restart', async () => {
  const app = setup({ stored: { captureEnabled: false } }); await flush();
  assert.equal(app.control().on, false);
});

test('right-click menu: open the app, inspect the page, capture switch, settings on the icon; "Download with Hypernab" on links', async () => {
  const app = setup(); await flush();
  assert.deepEqual(app.calls.items.map(item => item.id), ['open-app', 'inspect-page', 'sep', 'capture', 'settings', 'download-link']);
  assert.ok(app.calls.items.filter(item => item.id !== 'download-link').every(item => item.contexts.includes('action')), 'the other items are only on the toolbar icon');
  const linkItem = app.calls.items.find(item => item.id === 'download-link');
  assert.deepEqual(JSON.parse(JSON.stringify(linkItem.contexts)), ['link'], 'the file item shows only on links'); assert.equal(linkItem.title, 'Download with Hypernab', 'always English: it is the browser\'s own menu');
  const click = (id, extra = {}) => app.handlers.menu({ menuItemId: id, ...extra }, { id: 7 });
  await click('settings'); assert.equal(app.calls.optionsOpened, 1);
  await click('inspect-page'); assert.deepEqual(app.calls.tabMessages, [[7, 'hypernab:show-panel']]);
  await click('capture', { checked: false }); await flush(); assert.equal(app.control().on, false);
  assert.equal(app.calls.items.some(item => item.id === 'download-link'), false, 'capture off: the link item goes away too');
  await click('capture', { checked: true }); await flush();
  assert.equal(app.calls.items.some(item => item.id === 'download-link'), true, 'and comes back');
  await click('open-app'); assert.ok(app.calls.sent.some(message => message.native === 'show'));
  await click('unknown'); // anything else is ignored
});

test('switching capture on the settings page (a stored value changes) redraws the menu too', async () => {
  const app = setup(); await flush();
  for (const change of app.handlers.changed) change({ captureEnabled: { newValue: false } }, 'local'); await flush();
  assert.equal(app.calls.items.some(item => item.id === 'download-link'), false);
});

test('while capture is off: nothing is recorded, no panel answer, no link download', async () => {
  const context = vm.createContext({ globalThis: null, HypernabControl: { on: false } });
  context.globalThis = context;
  // the three places that must ask the switch
  const background = read('background.js'), float = read('float.js'), link = read('link-download.js');
  for (const name of ['capture(details', 'captureSubtitle(details', 'recordActivity(details']) {
    const at = background.indexOf(`function ${name}`);
    assert.ok(at >= 0, name); assert.match(background.slice(at, at + 220), /HypernabControl\?\.on === false\) return/, name);
  }
  assert.match(float, /HypernabControl\?\.on === false\) \{ respond\(\{ ok: false, code: 'disabled'/);
  assert.match(link, /C\.on === false/);
});


test('a fresh install opens the settings page once (it explains the icon); an update does not', async () => {
  const fresh = setup(); await flush();
  fresh.handlers.installed({ reason: 'install' }); await flush();
  assert.equal(fresh.calls.optionsOpened, 1);
  const update = setup(); await flush();
  update.handlers.installed({ reason: 'update' }); await flush();
  assert.equal(update.calls.optionsOpened, 0);
});
