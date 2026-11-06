import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Automation } from '../src/automation.js';
import { DownloadQueue } from '../src/downloads.js';
import { rateLimiter } from '../src/rate-limit.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-automation-'));
  const queue = new DownloadQueue({ directory: path.join(dir, 'downloads'), stateFile: path.join(dir, 'queue.json'), toolsDirectory: dir });
  t.after(() => { queue.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { queue, file: path.join(dir, 'automation.json') };
}
test('"add for later" is a download not started yet: Resume all starts every one of them in list order, nothing else changes', t => {
  const { queue } = fixture(t), launches = [];
  queue.launch = job => { launches.push(job.id); job.status = 'completed'; };
  const a = queue.add({ url: 'https://example.org/a', engine: 'direct', start: 'queue' });
  const b = queue.add({ url: 'https://example.org/b', engine: 'direct', start: 'queue' });
  const c = queue.add({ url: 'https://example.org/c', engine: 'direct', start: 'queue' });
  assert.deepEqual(queue.jobs.map(job => job.status), ['held', 'held', 'held']); assert.deepEqual(launches, [], 'nothing starts by itself');
  assert.deepEqual(queue.batch('pause', { all: true }), { changed: 0, skipped: 3 }, 'pausing leaves what has not started alone');
  queue.resumeAll();
  assert.deepEqual(launches, [a, b, c]); assert.deepEqual(queue.jobs.map(job => job.id), [a, b, c], 'row order never changes');
  assert.throws(() => queue.setSettings({ speedLimitKiB: -1 }));
  queue.setSettings({ addQueue: 'Videos', selectedQueue: 'Videos' }); // a window of an older version may still send these: there are no named queues, nothing breaks
  assert.equal('queueNames' in queue.settings, false); assert.equal('selectedQueue' in queue.settings, false);
});
test('scheduler fires once (Resume all at the time); future schedules survive restart but missed schedules do not; an older file naming a queue still loads', async t => {
  const { queue, file } = fixture(t); let now = 1000, calls = 0;
  queue.resumeAll = () => { calls++; };
  const options = { now: () => now, execute: () => assert.fail('No real power action') };
  const automation = new Automation(queue, file, options);
  assert.deepEqual(automation.configure({ schedule: { at: 2000, queue: 'Genel' } }).schedule, { at: 2000 }, 'a named queue in the request is ignored');
  assert.equal(new Automation(queue, file, options).info().schedule.at, 2000);
  fs.writeFileSync(file, JSON.stringify({ schedule: { at: 5000, queue: 'Videos' } })); // written by an older version
  assert.deepEqual(new Automation(queue, file, options).info().schedule, { at: 5000 }, 'older file: the queue name is dropped, the time is kept');
  automation.configure({ schedule: { at: 2000 } });
  await automation.tick(); assert.equal(calls, 0);
  now = 2100; assert.equal(new Automation(queue, file, options).info().schedule, null);
  await automation.tick(); await automation.tick(); assert.equal(calls, 1);
  assert.throws(() => automation.configure({ schedule: { at: 100 } }), /./, 'a time in the past is refused');
  assert.throws(() => automation.configure({ schedule: { at: 'soon' } }), /./);
});
test('power action waits for verified success and countdown; cancel and restart disarm it', async t => {
  const { queue, file } = fixture(t); let now = 0, calls = [];
  const id = queue.add({ url: 'https://example.org/a', engine: 'direct', start: 'queue' });
  const automation = new Automation(queue, file, { now: () => now, execute: action => calls.push(action) });
  automation.configure({ power: 'shutdown' });
  await automation.tick(); assert.equal(automation.info().power.deadline, null);
  queue.jobs.find(job => job.id === id).status = 'completed';
  await automation.tick(); assert.equal(automation.info().power.deadline, 60000);
  now = 59999; await automation.tick(); assert.deepEqual(calls, []);
  assert.equal(new Automation(queue, file).info().power, null);
  automation.configure({ power: null }); now = 61000; await automation.tick(); assert.deepEqual(calls, []);
  queue.jobs[0].status = 'held'; automation.configure({ power: 'sleep' });
  queue.jobs[0].status = 'completed'; await automation.tick(); now += 60000; await automation.tick(); await automation.tick();
  assert.deepEqual(calls, ['sleep']);
});
test('failed or paused jobs disarm power action and extra pending jobs block countdown', async t => {
  const { queue, file } = fixture(t);
  queue.add({ url: 'https://example.org/a', engine: 'direct', start: 'queue' });
  const automation = new Automation(queue, file, { execute: () => assert.fail('must not execute') });
  automation.configure({ power: 'shutdown' }); queue.jobs[0].status = 'failed'; await automation.tick();
  assert.equal(automation.info().power, null);
  queue.jobs[0].status = 'held'; automation.configure({ power: 'shutdown' }); queue.jobs[0].status = 'completed';
  queue.add({ url: 'https://example.org/b', engine: 'direct', start: 'queue' }); await automation.tick();
  assert.equal(automation.info().power.deadline, null);
});
test('shared rate limiter accounts for concurrent chunks and aborts promptly', async () => {
  const limit = rateLimiter(10000), start = performance.now();
  await Promise.all([limit(1000), limit(1000), limit(1000)]);
  assert.ok(performance.now() - start >= 270);
  const abort = new AbortController(); const work = rateLimiter(1)(100000, abort.signal); abort.abort();
  await assert.rejects(work, { name: 'AbortError' });
});
