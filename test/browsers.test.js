import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { detectBrowsers, BROWSERS, STORE_PAGES, familyOfProgId, defaultBrowserFamily, openStorePage } = createRequire(import.meta.url)('../desktop/browsers.cjs');
const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'D:\\LocalData' };
const CHROMIUM = 'https://chromewebstore.google.com/detail/decnigdaajpbapbcaieefjnjapeombpb';
const FIREFOX = 'https://addons.mozilla.org/en-US/firefox/addon/hypernab-video-catcher/';

test('browsers are found by their known install places; the first place that exists wins; nothing found = empty list', () => {
  const present = new Set([path.join(env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(env.ProgramFiles, 'Mozilla Firefox\\firefox.exe'), path.join(env.LOCALAPPDATA, 'Programs\\Opera\\opera.exe')]);
  const found = detectBrowsers({ env, exists: file => present.has(file) });
  assert.deepEqual(found.map(item => item.id), ['firefox', 'edge', 'opera']);
  assert.deepEqual(found.map(item => item.family), ['firefox', 'chromium', 'chromium']);
  assert.deepEqual(detectBrowsers({ env, exists: () => false }), []);
  assert.deepEqual(detectBrowsers({ env: {}, exists: () => true }), [], 'without the Windows folders nothing is guessed');
  assert.equal(new Set(BROWSERS.map(item => item.id)).size, BROWSERS.length);
});

test('the default browser is told apart as Chromium-based or Firefox from the name Windows keeps; unknown is null', async () => {
  for (const [progId, family] of [['ChromeHTML', 'chromium'], ['MSEdgeHTM', 'chromium'], ['BraveHTML', 'chromium'], ['OperaStable', 'chromium'], ['OperaGXStable', 'chromium'], ['VivaldiHTM', 'chromium'], ['FirefoxURL-308046B0AF4A39CB', 'firefox'], ['IE.HTTPS', null], ['', null], [undefined, null], ['SomethingNew', null]]) assert.equal(familyOfProgId(progId), family, String(progId));
  const reg = id => async (file, args) => { assert.equal(file, 'reg'); assert.ok(args.includes('/v') && args.includes('ProgId')); return `\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    ${id}\r\n`; };
  assert.equal(await defaultBrowserFamily({ run: reg('FirefoxURL-308046B0AF4A39CB') }), 'firefox');
  assert.equal(await defaultBrowserFamily({ run: reg('ChromeHTML') }), 'chromium');
  assert.equal(await defaultBrowserFamily({ run: async () => { throw new Error('no such key'); } }), null, 'the registry failing means unknown, never an error');
  assert.equal(await defaultBrowserFamily({ run: async () => 'garbage' }), null);
});

test('store pages: only the two known pages are accepted; the same-kind default browser opens it, else an installed browser of that kind, else the address is copied', async () => {
  assert.ok(STORE_PAGES.chromium.test(CHROMIUM) && STORE_PAGES.firefox.test(FIREFOX));
  for (const bad of ['https://evil.example/detail/decnigdaajpbapbcaieefjnjapeombpb', 'http://chromewebstore.google.com/detail/decnigdaajpbapbcaieefjnjapeombpb', 'https://chromewebstore.google.com/detail/decnigdaajpbapbcaieefjnjapeombpb/../x', 'file:///C:/Windows/System32/cmd.exe', '']) assert.ok(!STORE_PAGES.chromium.test(bad) && !STORE_PAGES.firefox.test(bad), bad);
  const calls = { spawn: [], opened: [], copied: [] };
  const tools = (defaultFamily, installed = []) => ({ defaultFamily, detect: () => installed, spawn: (exe, args, options) => { calls.spawn.push([exe, args, options.detached]); return { on() {}, unref() {} }; }, shell: { openExternal: async url => { calls.opened.push(url); } }, clipboard: { writeText: text => calls.copied.push(text) } });
  assert.deepEqual(await openStorePage('chromium', CHROMIUM, tools('chromium')), { opened: 'default' });
  assert.deepEqual(await openStorePage('firefox', FIREFOX, tools('firefox')), { opened: 'default' });
  assert.deepEqual(calls.opened, [CHROMIUM, FIREFOX]);
  assert.deepEqual(await openStorePage('firefox', FIREFOX, tools('chromium', [{ id: 'firefox', family: 'firefox', exe: 'C:\\ff.exe' }])), { opened: 'browser' });
  assert.deepEqual(calls.spawn, [['C:\\ff.exe', [FIREFOX], true]], 'a browser of the asked kind opens it, with only the store address');
  assert.deepEqual(await openStorePage('chromium', CHROMIUM, tools('firefox', [])), { opened: false, copied: true });
  assert.deepEqual(calls.copied, [CHROMIUM], 'no such browser: nothing is opened, the address is copied');
  assert.deepEqual(await openStorePage('chromium', CHROMIUM, tools(null, [])), { opened: 'default' }, 'unknown default and nothing found: the default browser is tried');
  await assert.rejects(openStorePage('chromium', 'https://evil.example/', tools('chromium')), /unknown store page/);
  await assert.rejects(openStorePage('firefox', CHROMIUM, tools('firefox')), /unknown store page/, 'a store address of the other kind is refused');
  await assert.rejects(openStorePage('../x', FIREFOX, tools('firefox')), /unknown store page/);
});
