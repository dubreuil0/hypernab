import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DownloadQueue } from '../src/downloads.js';

const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-noqueue-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const config = root => ({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
const job = (status, extra = {}) => ({ id: randomUUID(), url: 'https://example.org/a.bin', engine: 'direct', title: 'Old', status, received: 0, speed: 0, ...extra });

test('files of the versions that had named queues load without a word: the old fields are not read, nothing is deleted, jobs are kept', t => {
  const root = temp(t), c = config(root);
  const held = job('held', { queueName: 'Videos', viaQueue: true }), plain = job('held', { queueName: 'Genel', viaQueue: true }), done = job('completed', { viaQueue: true, queueName: 'Genel', file: 'x.mp4' });
  fs.writeFileSync(c.stateFile, JSON.stringify([held, plain, done]));
  fs.writeFileSync(`${c.stateFile}.settings.json`, JSON.stringify({ queueLimit: 3, queueNames: ['Genel', 'Videos'], selectedQueue: 'Videos', theme: 'light', speedLimitKiB: 1024, settingsVersion: 3 }));
  const queue = new DownloadQueue(c); t.after(() => queue.stop());
  assert.equal(queue.settings.queueLimit, 3, 'the number at the same time is kept'); assert.equal(queue.settings.theme, 'light'); assert.equal(queue.settings.speedLimitKiB, 1024);
  assert.equal('queueNames' in queue.settings, false); assert.equal('selectedQueue' in queue.settings, false);
  assert.deepEqual(Object.fromEntries(queue.jobs.map(j => [j.id, j.status])), { [held.id]: 'held', [plain.id]: 'held', [done.id]: 'completed' }, 'the jobs of every old queue are in the one list, still not started');
  assert.equal(queue.list().length, 3);
  const launches = []; queue.launch = j => { launches.push(j.id); j.status = 'completed'; };
  queue.resumeAll(); assert.deepEqual([...launches].sort(), [held.id, plain.id].sort(), 'Resume all starts the ones of both old queues');
  queue.setSettings({ theme: 'dark' }); // saving writes a file without the old fields
  const saved = JSON.parse(fs.readFileSync(`${c.stateFile}.settings.json`, 'utf8'));
  assert.equal('queueNames' in saved, false); assert.equal('selectedQueue' in saved, false); assert.equal(saved.queueLimit, 3);
});

test('Resume all starts everything that was paused, interrupted or added for later, and leaves running, finished and cancelled ones alone', t => {
  const root = temp(t), queue = new DownloadQueue(config(root)); t.after(() => queue.stop());
  const set = ['held', 'paused', 'interrupted', 'running', 'completed', 'cancelled', 'failed'].map(status => job(status));
  queue.jobs = set; queue.active.set(set[3].id, new AbortController());
  const launched = []; queue.launch = j => { launched.push(j.status); j.status = 'running'; };
  assert.deepEqual(queue.batch('resume', { all: true }), { changed: 3, skipped: 4 });
  assert.deepEqual(set.map(j => j.status), ['running', 'running', 'running', 'running', 'completed', 'cancelled', 'failed']);
  queue.active.clear();
});

test('the engine answers the calls of older windows and tools: queue/start = resume all, queue/stop = nothing to do, named-queue settings are accepted and ignored', async t => {
  const root = temp(t);
  const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(root, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(root, 'downloads') } });
  t.after(() => server.kill());
  const origin = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${origin}/ds.js`)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  const token = (await (await fetch(`${origin}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json()).token;
  const call = async (route, body) => { const r = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const started = await call('/api/queue/start', {}), stopped = await call('/api/queue/stop', {});
  assert.equal(started.status, 200); assert.equal(stopped.status, 200);
  assert.deepEqual(Object.keys(started.data).sort(), ['limit', 'speedLimitKiB']); assert.deepEqual(stopped.data, started.data);
  const accepted = await call('/api/settings', { addQueue: 'Videos', selectedQueue: 'Videos', queueLimit: 2 });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.queue.limit, 2); assert.equal('queueNames' in accepted.data, false);
  const read = await call('/api/settings');
  assert.deepEqual(Object.keys(read.data.queue).sort(), ['limit', 'speedLimitKiB'], 'the window gets the number at the same time and the speed limit, nothing about queues');
  const schedule = await call('/api/automation', { schedule: { at: Date.now() + 3600000, queue: 'Videos' } });
  assert.equal(schedule.status, 200); assert.deepEqual(Object.keys(schedule.data.schedule), ['at'], 'an older window may still name a queue: ignored');
  assert.equal((await call('/api/automation', { schedule: null })).data.schedule, null);
  assert.equal((await call('/api/automation', { schedule: { at: 5 } })).status >= 400, true, 'a time in the past is refused');
});
