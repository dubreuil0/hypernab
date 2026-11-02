import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { detectBrowsers, openBrowserSetup, BROWSERS } = createRequire(import.meta.url)('../desktop/browsers.cjs');
const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'D:\\LocalData' };

test('browsers are found by their known install places; the first place that exists wins; nothing found = empty list', () => {
  const present = new Set([path.join(env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(env.ProgramFiles, 'Mozilla Firefox\\firefox.exe'), path.join(env.LOCALAPPDATA, 'Programs\\Opera\\opera.exe')]);
  const found = detectBrowsers({ env, exists: file => present.has(file) });
  assert.deepEqual(found.map(item => item.id), ['firefox', 'edge', 'opera']);
  assert.deepEqual(found.map(item => item.family), ['firefox', 'chromium', 'chromium']);
  assert.deepEqual(detectBrowsers({ env, exists: () => false }), []);
  assert.deepEqual(detectBrowsers({ env: {}, exists: () => true }), [], 'without the Windows folders nothing is guessed');
  assert.equal(new Set(BROWSERS.map(item => item.id)).size, BROWSERS.length);
});

test('set up: opens only a found browser, on its own extensions page, shows the folder and copies the path to pick', async () => {
  const calls = { spawn: [], opened: [], copied: [] };
  const detect = () => [{ id: 'edge', name: 'Edge', family: 'chromium', exe: 'C:\\edge.exe', url: 'edge://extensions' }, { id: 'firefox', name: 'Firefox', family: 'firefox', exe: 'C:\\ff.exe', url: 'about:debugging#/runtime/this-firefox' }];
  const spawn = (exe, args, options) => { calls.spawn.push([exe, args, options.detached]); return { on() {}, unref() {} }; };
  const tools = { detect, spawn, shell: { openPath: async folder => { calls.opened.push(folder); return ''; } }, clipboard: { writeText: text => calls.copied.push(text) }, extensionsFolder: 'C:\\app\\build\\extensions' };
  const edge = await openBrowserSetup('edge', tools);
  assert.deepEqual(calls.spawn[0], ['C:\\edge.exe', ['edge://extensions'], true]);
  assert.deepEqual(calls.opened, [path.join('C:\\app\\build\\extensions', 'chromium')]);
  assert.deepEqual(calls.copied, [path.join('C:\\app\\build\\extensions', 'chromium')]); assert.equal(edge.family, 'chromium');
  const firefox = await openBrowserSetup('firefox', tools);
  assert.deepEqual(calls.spawn[1], ['C:\\ff.exe', ['about:debugging#/runtime/this-firefox'], true]);
  assert.equal(calls.copied[1], path.join('C:\\app\\build\\extensions', 'firefox', 'manifest.json'), 'Firefox wants the manifest file'); assert.equal(firefox.family, 'firefox');
  await assert.rejects(openBrowserSetup('chrome', tools), /unknown browser/, 'a browser that was not found is never launched');
  await assert.rejects(openBrowserSetup('../../evil', tools), /unknown browser/);
  assert.equal(calls.spawn.length, 2);
});
