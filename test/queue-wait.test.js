import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { ConnectionBudget } from '../src/connection-budget.js';
import { Deadline, anySignal, pauseDeadlines } from '../src/deadline.js';
import { recoverRead } from '../src/recovery.js';

// Waiting for a slot in our own connection queue must never count toward a network time limit.
const payload = Buffer.from(Array.from({ length: 30000 }, (_, i) => i % 249));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-queue-wait-'));
  for (const tool of ['yt-dlp.exe', 'ffprobe.exe', 'ffmpeg.exe']) fs.writeFileSync(path.join(root, tool), 'test-double');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, autoRetries: 0,
    mediaVerifier: async () => ({ height: 720, width: 1280, audio: true }), ...options });
  queue.setSettings({ autoRetries: 0 });
  t.after(async () => { queue.stop(); await settled(queue); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue, rounds = 1500) {
  for (let i = 0; i < rounds; i++) { if (!queue.active.size && !queue.jobs.some(job => job.status === 'queued')) return; await wait(10); }
  throw new Error('Queue timeout');
}
function serve(url, headers, delay = 0, signal) {
  return wait(delay, null, { signal }).then(() => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(first), end = Number(last);
    const response = Readable.from([payload.subarray(start, end + 1)]);
    response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(end - start + 1), 'content-type': 'video/mp4', etag: '"same"' };
    return { response, url: new URL(url) };
  });
}

test('many downloads of one host wait for a slot without a timeout; all finish with the right bytes', async t => {
  const queue = fixture(t, {
    budget: new ConnectionBudget({ total: 2, perHost: 1, reserve: 1 }),
    probeTimeouts: { attemptMs: 150, totalMs: 300 },
    rangeRequest: (url, signal, headers) => serve(url, headers, 40, signal)
  });
  for (let i = 0; i < 8; i++) queue.add({ url: `https://cdn.example.net/${i}.mp4`, engine: 'direct', title: `Video ${i}` });
  await settled(queue);
  assert.ok(queue.jobs.every(job => job.status === 'completed'), queue.jobs.map(job => job.error).join(' | '));
  for (const job of queue.jobs) assert.deepEqual(fs.readFileSync(path.join(queue.dirOf(job), job.file)), payload);
});

test('a server that accepts and never answers still times out, counted from the moment the slot is held', async t => {
  const queue = fixture(t, {
    budget: new ConnectionBudget({ total: 2, perHost: 1, reserve: 1 }),
    probeTimeouts: { attemptMs: 120, totalMs: 250 },
    rangeRequest: (url, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })
  });
  const started = performance.now();
  queue.add({ url: 'https://cdn.example.net/silent.mp4', engine: 'direct', title: 'Silent' });
  await settled(queue);
  const elapsed = performance.now() - started;
  assert.equal(queue.jobs[0].status, 'failed');
  assert.ok(queue.jobs[0].error);
  assert.ok(elapsed >= 100 && elapsed < 2500, `elapsed ${elapsed}`);
});

test('pausing a download that is only waiting for a slot works at once', async t => {
  const queue = fixture(t, {
    budget: new ConnectionBudget({ total: 2, perHost: 1, reserve: 1 }),
    probeTimeouts: { attemptMs: 60000, totalMs: 60000 },
    rangeRequest: (url, signal, headers) => url.includes('hold') ? new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) : serve(url, headers, 0, signal)
  });
  queue.add({ url: 'https://cdn.example.net/hold.mp4', engine: 'direct', title: 'Holder' });
  await wait(100);
  queue.add({ url: 'https://cdn.example.net/queued.mp4', engine: 'direct', title: 'Queued' });
  await wait(100);
  const [holder, waiting] = queue.jobs;
  assert.equal(queue.budget.snapshot().waiting, 1, 'the second download waits for the only slot of the host');
  const before = performance.now();
  queue.pause(waiting.id);
  for (let i = 0; i < 100 && queue.budget.snapshot().waiting; i++) await wait(5);
  assert.equal(queue.budget.snapshot().waiting, 0); assert.ok(performance.now() - before < 500);
  assert.equal(waiting.status, 'paused');
  queue.cancel(holder.id);
});

test('a limit stops while its request waits for a slot and goes on when the slot is granted', async () => {
  const budget = new ConnectionBudget({ total: 1, perHost: 1, reserve: 1 });
  const holder = await budget.acquire('h.example', new AbortController().signal);
  const limit = new Deadline(120, () => new Error('late'));
  const signal = anySignal([new AbortController().signal, limit.signal]);
  const waiting = budget.acquire('h.example', signal);
  await wait(300); // longer than the limit: still alive because it waited in the queue
  assert.equal(signal.aborted, false);
  holder(); const release = await waiting;
  const resumed = performance.now();
  await wait(60); assert.equal(signal.aborted, false);
  await wait(150); assert.equal(signal.aborted, true, 'the limit runs again once the slot is held'); assert.ok(performance.now() - resumed >= 100);
  release(); limit.stop();
});

test('the reserve lane of interactive look-ups keeps its own limits (not paused)', async () => {
  const budget = new ConnectionBudget({ total: 2, perHost: 2, reserve: 1 });
  const holder = await budget.acquire('h.example', new AbortController().signal, 1, { priority: true });
  const limit = new Deadline(100, () => new Error('late'));
  const waiting = budget.acquire('h.example', limit.signal, 1, { priority: true });
  waiting.catch(() => {});
  await wait(200);
  assert.equal(limit.signal.aborted, true); holder(); limit.stop();
});

test('recoverRead counts only the time with a slot: a real timeout is unchanged, a queue wait is free', async () => {
  const budget = new ConnectionBudget({ total: 1, perHost: 1, reserve: 1 });
  const holder = await budget.acquire('h.example', new AbortController().signal);
  const slow = recoverRead(async deadline => { const release = await budget.acquire('h.example', deadline); release(); return 'ok'; }, { maxElapsedMs: 100 });
  await wait(250); holder();
  assert.equal(await slow, 'ok');
  // Slot held, server silent: times out as before.
  await assert.rejects(recoverRead(deadline => new Promise((_resolve, reject) => deadline.addEventListener('abort', () => reject(deadline.reason), { once: true })), { maxElapsedMs: 80 }), error => error.name === 'TimeoutError');
  // The user's cancel still ends the wait at once.
  const stuck = await budget.acquire('h.example', new AbortController().signal), controller = new AbortController();
  const queued = recoverRead(async deadline => budget.acquire('h.example', deadline), { maxElapsedMs: 60000, signal: controller.signal });
  await wait(30); controller.abort(new Error('cancelled'));
  await assert.rejects(queued, /cancelled/); assert.equal(budget.snapshot().waiting, 0); stuck();
  assert.equal(pauseDeadlines(new AbortController().signal), null);
});
