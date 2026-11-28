import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';

// "At the same time" = a box (on: the number, off: all) + a remembered number 1-20; and the Dense layout default with its one-time migration.
const roots = [];
test.after(async () => { await wait(100); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function open(saved, root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-queue-limit-'))) {
  roots.push(root);
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  if (saved) fs.writeFileSync(path.join(root, 'queue.json.settings.json'), JSON.stringify(saved));
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools') });
  queue.run = (job, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 5), { once: true }));
  queue.finalizeName = () => {};
  return { queue, root, reopen: () => { queue.stop(); return open(null, root); } };
}
const add = (queue, name) => queue.add({ url: `https://files.example.org/${name}.bin`, engine: 'direct', title: name });

test('a new install: box on with 6, Dense layout', t => {
  const { queue } = open(null); t.after(() => queue.stop());
  assert.equal(queue.settings.queueLimit, 6); assert.equal(queue.settings.queueLimitCount, 6); assert.equal(queue.settings.appearance, 'dense');
  assert.deepEqual(queue.queueInfo(), { limit: 6, limitCount: 6, speedLimitKiB: 0 });
});

test('saved settings migrate: all stays all (box off, number 6); a saved number keeps the box on; the number is remembered', t => {
  const cases = [
    [{ queueLimit: 'all', settingsVersion: 3 }, 'all', 6],
    [{ queueLimit: 3, settingsVersion: 3 }, 3, 3],
    [{ queueLimit: 'all', queueLimitCount: 9, settingsVersion: 4 }, 'all', 9],
    [{ queueLimit: 12, queueLimitCount: 12, settingsVersion: 4 }, 12, 12],
    [{ queueLimit: 2, queueLimitEnabled: false }, 'all', 2], // the oldest files: "limit off" means all
    [{ queueLimit: 99, queueLimitCount: 0 }, 6, 6], // garbage falls back to the default
    [{ theme: 'light' }, 6, 6] // a file that never held the setting
  ];
  for (const [saved, limit, count] of cases) {
    const { queue } = open(saved); t.after(() => queue.stop());
    assert.equal(queue.settings.queueLimit, limit, JSON.stringify(saved)); assert.equal(queue.settings.queueLimitCount, count, JSON.stringify(saved));
  }
});

test('validation: 1-20 or all; the count is 1-20 only', t => {
  const { queue } = open(null); t.after(() => queue.stop());
  for (const ok of [1, 6, 20, 'all']) queue.setSettings({ queueLimit: ok });
  for (const bad of [0, 21, 1.5, '5', null, 'many']) assert.throws(() => queue.setSettings({ queueLimit: bad }), /1 ile 20|1 and 20/, String(bad));
  for (const bad of [0, 21, 2.5, 'all', '7']) assert.throws(() => queue.setSettings({ queueLimitCount: bad }), /1 ile 20|1 and 20/, String(bad));
});

test('box and number: unticking keeps the number, ticking brings it back, a new number applies at once only while the box is on, all of it persists', t => {
  const { queue, reopen } = open(null); t.after(() => queue.stop());
  queue.setSettings({ queueLimit: 'all' });
  assert.equal(queue.settings.queueLimit, 'all'); assert.equal(queue.settings.queueLimitCount, 6, 'the number survives an unticked box');
  queue.setSettings({ queueLimitCount: 9 });
  assert.equal(queue.settings.queueLimit, 'all', 'box off: the number is only remembered'); assert.equal(queue.settings.queueLimitCount, 9);
  queue.setSettings({ queueLimit: queue.settings.queueLimitCount });
  assert.equal(queue.settings.queueLimit, 9, 'ticking the box applies the remembered number');
  queue.setSettings({ queueLimitCount: 4 });
  assert.equal(queue.settings.queueLimit, 4, 'box on: a new number applies at once'); assert.equal(queue.queueInfo().limitCount, 4);
  queue.setSettings({ queueLimit: 'all' }); queue.setSettings({ queueLimitCount: 15 });
  const saved = JSON.parse(fs.readFileSync(queue.settingsFile, 'utf8'));
  assert.equal(saved.queueLimit, 'all'); assert.equal(saved.queueLimitCount, 15); assert.equal(saved.settingsVersion, 4);
  const again = reopen(); t.after(() => again.queue.stop());
  assert.equal(again.queue.settings.queueLimit, 'all'); assert.equal(again.queue.settings.queueLimitCount, 15);
});

test('the limit really is the number: 20 allows 20 at once, lowering never stops running downloads, only new starts wait', async t => {
  const { queue } = open(null); t.after(() => queue.stop());
  queue.setSettings({ queueLimit: 20 });
  for (let i = 0; i < 22; i++) add(queue, `d${i}`);
  assert.equal(queue.active.size, 20);
  assert.equal(queue.jobs.filter(job => job.status === 'queued').length, 2);
  queue.setSettings({ queueLimitCount: 5 }); // lowering: the surplus is put back in line by the scheduler, never lost
  await wait(60);
  assert.equal(queue.active.size, 5);
  assert.equal(queue.jobs.filter(job => ['running', 'queued'].includes(job.status)).length, 22, 'nothing is cancelled');
});

test('Dense layout: default, and the one-time migration from the old default', t => {
  const cases = [
    [{ appearance: 'compact', settingsVersion: 3 }, 'dense'], // the old default (or an old Compact choice, which cannot be told apart)
    [{ appearance: 'normal', settingsVersion: 3 }, 'normal'], // an explicit Normal stays
    [{ appearance: 'compact', settingsVersion: 4 }, 'compact'], // chosen after the migration: kept
    [{ appearance: 'dense', settingsVersion: 4 }, 'dense'],
    [{ appearance: 'normal' }, 'normal'], // a file without a version is the oldest one
    [{ theme: 'light' }, 'dense'],
    [{ appearance: 'tiny', settingsVersion: 4 }, 'dense'] // invalid saved value: the default
  ];
  for (const [saved, appearance] of cases) {
    const { queue } = open(saved); t.after(() => queue.stop());
    assert.equal(queue.settings.appearance, appearance, JSON.stringify(saved));
  }
  const { queue } = open({ appearance: 'compact', settingsVersion: 3 }); t.after(() => queue.stop());
  queue.setSettings({ theme: 'dark' }); // saving stamps the new version: the choice made from here on is kept
  assert.equal(JSON.parse(fs.readFileSync(queue.settingsFile, 'utf8')).settingsVersion, 4);
  queue.setSettings({ appearance: 'compact' });
  assert.equal(JSON.parse(fs.readFileSync(queue.settingsFile, 'utf8')).appearance, 'compact');
  for (const value of ['dense', 'compact', 'normal']) queue.setSettings({ appearance: value });
  assert.throws(() => queue.setSettings({ appearance: 'tiny' }));
});
