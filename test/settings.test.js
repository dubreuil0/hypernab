import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue } from '../src/downloads.js';
import { preferredOptionId } from '../src/quality.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-settings-'));
  const config = { directory: path.join(root, 'default'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root };
  const queue = new DownloadQueue(config);
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, queue, config };
}
test('settings validate atomically and persist across restarts', t => {
  const { queue, config } = fixture(t);
  const values = { appearance: 'normal', textSize: 'large', theme: 'system', accent: 'orange', subtitleMode: 'sidecar', maxQuality: 720, preferCompatible: true, maxConnections: 3, autoRetries: 4, deepVerifyDefault: true, notifyOnFinish: false, closeToTray: false, startMinimized: true };
  queue.setSettings(values);
  const restored = new DownloadQueue(config);
  for (const [key, value] of Object.entries(values)) assert.equal(restored.settings[key], value);
  for (const input of [{ maxQuality: 999 }, { maxConnections: 0 }, { maxConnections: 17 }, { autoRetries: 6 }, { closeToTray: 'false' }, { downloadDirectory: '../relative' }]) assert.throws(() => queue.setSettings(input));
  assert.throws(() => queue.setSettings({ maxQuality: 1080, maxConnections: 50 }));
  assert.equal(queue.settings.maxQuality, 720);
});
test('compact is the default for new/old settings; visual changes do not touch the scheduler', t => {
  const { queue, config } = fixture(t);
  assert.equal(queue.settings.appearance, 'compact'); assert.equal(queue.settings.textSize, 'normal');
  let pumps = 0; queue.pump = () => { pumps++; };
  queue.setSettings({ appearance: 'normal', textSize: 'small' }); assert.equal(pumps, 0);
  for (const input of [{ appearance: 'tiny' }, { textSize: 12 }, { appearance: 'compact', textSize: 'invalid' }, { theme: 'neon' }, { accent: '#fff' }, { subtitleMode: 'burn' }]) assert.throws(() => queue.setSettings(input));
  assert.equal(queue.settings.appearance, 'normal');
  const restored = new DownloadQueue(config); assert.equal(restored.settings.appearance, 'normal'); restored.stop();
  const saved = JSON.parse(fs.readFileSync(queue.settingsFile)); delete saved.appearance; delete saved.textSize;
  fs.writeFileSync(queue.settingsFile, JSON.stringify(saved));
  const migrated = new DownloadQueue(config); assert.equal(migrated.settings.appearance, 'compact'); migrated.stop();
});
test('folder changes affect new jobs only; history and partial data stay in their own folders', t => {
  const { queue, config, root } = fixture(t);
  const add = name => queue.add({ url: `https://example.org/${name}`, engine: 'direct', start: 'queue' });
  add('old'); const old = queue.jobs[0];
  old.file = `${old.id}-old.mp4`; old.status = 'cancelled';
  fs.writeFileSync(path.join(config.directory, old.file), 'preserved');
  const next = path.join(root, 'chosen'); queue.setSettings({ downloadDirectory: next }); add('new');
  assert.equal(queue.dirOf(old), config.directory);
  assert.equal(queue.jobs[1].directory, next);
  assert.equal(queue.capabilities().directory, next);
  assert.equal(queue.list()[0].canClear, true);
  queue.clearFinished([old.id]);
  assert.equal(fs.readFileSync(path.join(config.directory, old.file), 'utf8'), 'preserved');
  const restored = new DownloadQueue(config);
  assert.equal(restored.jobs[0].directory, next);
  restored.setSettings({ downloadDirectory: null });
  assert.equal(restored.currentDirectory(), config.directory);
  assert.equal(restored.dirOf(restored.jobs[0]), next);
});
test('quality preferences preselect real offers without changing same-height FPS or HDR', () => {
  const offers = [
    { id: '4k', height: 2160, fps: 60, codec: 'AV1', ext: 'mp4', hdr: true },
    { id: '720-av1', height: 720, fps: 60, codec: 'AV1', ext: 'mp4', hdr: false },
    { id: '720-h264', height: 720, fps: 60, codec: 'H.264', ext: 'mp4', hdr: false, recommended: false },
    { id: '360', height: 360, fps: 30, codec: 'H.264', ext: 'mp4', hdr: false }
  ];
  assert.equal(preferredOptionId(offers), '4k');
  assert.equal(preferredOptionId(offers, { maxQuality: 1080 }), '720-av1');
  assert.equal(preferredOptionId(offers, { maxQuality: 720, preferCompatible: true }), '720-h264');
  assert.equal(preferredOptionId([]), null);
  assert.equal(preferredOptionId(offers, { maxQuality: 240 }), '360');
  assert.equal(preferredOptionId([{ ...offers[0], recommended: false }]), '4k');
  assert.equal(preferredOptionId([offers[1], { ...offers[2], fps: 30 }], { preferCompatible: true }), '720-av1');
});

test('the engine reports the default of every preference, and applying them restores a fresh queue\'s settings', t => {
  const { queue, config } = fixture(t);
  const fresh = JSON.parse(JSON.stringify(queue.settings)), defaults = queue.settingDefaults();
  const keys = ['interfaceLanguage', 'appearance', 'theme', 'accent', 'textSize', 'downloadDirectory', 'maxQuality', 'preferCompatible', 'speedLimitKiB', 'subtitleMode', 'subtitleLanguage', 'audioLanguage', 'subtitleContainer', 'maxConnections', 'autoRetries', 'smartNames', 'sortByType', 'folderLayout', 'deepVerifyDefault', 'closeToTray', 'startMinimized', 'watchClipboard', 'notifyOnFinish'];
  for (const key of keys) assert.ok(key in defaults, `no default for ${key}`);
  for (const key of keys) assert.deepEqual(defaults[key], fresh[key], `${key}: the default is what a fresh queue starts with`);
  queue.setSettings({ theme: 'light', accent: 'blue', maxQuality: 720, speedLimitKiB: 2048, autoRetries: 5, smartNames: false, subtitleMode: 'sidecar', maxConnections: 2, folderLayout: 'site', sortByType: true, subtitleLanguage: 'de', startMinimized: true });
  queue.setSettings(Object.fromEntries(keys.map(key => [key, defaults[key]])));
  for (const key of keys) assert.deepEqual(queue.settings[key], fresh[key], `${key} is back to its default`);
  const restored = new DownloadQueue(config); for (const key of keys) assert.deepEqual(restored.settings[key], fresh[key], `${key} stays at its default after a restart`); restored.stop();
});