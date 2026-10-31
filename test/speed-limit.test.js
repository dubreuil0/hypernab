import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { rateLimiter } from '../src/rate-limit.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-limit-'));
  const queue = new DownloadQueue({ directory: path.join(dir, 'downloads'), stateFile: path.join(dir, 'queue.json'), toolsDirectory: dir });
  queue.launch = () => {}; // no real transfers
  t.after(() => { queue.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return queue;
}
// A job the engine is "running": registered as active with its limiter, exactly as launch() leaves it.
function running(queue, engine, kib) {
  const id = queue.add({ url: 'https://example.org/a', engine: 'direct', start: 'queue' });
  const job = queue.jobs.find(item => item.id === id);
  job.engine = engine; // adding a yt-dlp job would need the tool installed
  job.status = 'running'; job.speedLimitKiB = kib; job.transfer = { phase: 'downloading', method: 'auto' };
  queue.active.set(id, new AbortController()); queue.limiters.set(id, rateLimiter(kib * 1024));
  return job;
}

test('lifting the limit wakes workers that planned a long wait; no one sleeps for the old, slower limit', async () => {
  const limit = rateLimiter(100); // 100 B/s: 10 000 bytes would take 100 s
  const started = performance.now();
  const waiting = Promise.all([limit(5000), limit(5000)]);
  await wait(30); limit.setRate(0);
  await waiting;
  assert.ok(performance.now() - started < 1000, 'workers were released at once');
  await limit(1e9); // unlimited now: returns without waiting
});

test('a new rate applies to the next chunks; the old debt does not carry over', async () => {
  const limit = rateLimiter(1000);
  await limit(500); // plans 500 ms
  limit.setRate(100000); // 100x faster
  const started = performance.now();
  await limit(10000); // 100 ms at the new rate
  const spent = performance.now() - started;
  assert.ok(spent >= 80 && spent < 400, `took ${spent} ms`);
  assert.equal(limit.rate(), 100000);
});

test('an aborted job stops waiting even when the rate is changed meanwhile', async () => {
  const limit = rateLimiter(1), abort = new AbortController();
  const work = limit(1000000, abort.signal);
  await wait(10); abort.abort();
  await assert.rejects(work, { name: 'AbortError' });
});

test('changing the speed limit reaches downloads that are already running', t => {
  const queue = fixture(t);
  const job = running(queue, 'direct', 0);
  assert.equal(queue.limiters.get(job.id).rate(), 0);
  queue.setSettings({ speedLimitKiB: 256 });
  assert.equal(job.speedLimitKiB, 256); assert.equal(queue.limiters.get(job.id).rate(), 256 * 1024);
  queue.setSettings({ speedLimitKiB: 0 });
  assert.equal(job.speedLimitKiB, 0); assert.equal(queue.limiters.get(job.id).rate(), 0);
  assert.equal(job.status, 'running', 'the program\'s own engines are not interrupted');
});

test('a yt-dlp download only learns its limit at start: it is not restarted (that would discard its data) and says so', t => {
  const queue = fixture(t);
  const ytdlp = running(queue, 'extractor', 0), own = running(queue, 'extractor', 0);
  ytdlp.transfer = { method: 'yt-dlp', phase: 'downloading' };
  const controller = queue.active.get(ytdlp.id);
  queue.setSettings({ speedLimitKiB: 500 });
  assert.equal(controller.signal.aborted, false, 'the process keeps running'); assert.equal(ytdlp.status, 'running');
  assert.match(ytdlp.notice, /yeniden başlayınca/); assert.equal(ytdlp.speedLimitKiB, 0, 'the shown limit is the one really in force');
  queue.setSettings({ speedLimitKiB: 600 });
  assert.equal(ytdlp.notice.split('yeniden başlayınca').length, 2, 'the note is not repeated');
  assert.equal(own.speedLimitKiB, 600); assert.equal(queue.limiters.get(own.id).rate(), 600 * 1024, 'the program\'s own HLS engine follows at once');
});

test('new and paused downloads start with the current limit', t => {
  const queue = fixture(t);
  queue.setSettings({ speedLimitKiB: 64 });
  assert.equal(queue.queueInfo().speedLimitKiB, 64);
  const job = running(queue, 'direct', 64);
  assert.equal(queue.limiters.get(job.id).rate(), 64 * 1024);
});

// ---- A real transfer: the limit is lifted while the file is coming in ----
import { Readable } from 'node:stream';
test('real direct transfer: the speed follows a limit that is set and lifted while the download runs', async t => {
  const data = Buffer.alloc(3 * 1024 * 1024, 7), mime = 'application/octet-stream';
  const chunks = buffer => Array.from({ length: Math.ceil(buffer.length / 32768) }, (_, i) => buffer.subarray(i * 32768, (i + 1) * 32768));
  const rangeRequest = async (url, signal, headers) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range), start = Number(first), end = Math.min(Number(last), data.length - 1);
    return { response: Object.assign(Readable.from(chunks(data.subarray(start, end + 1))), { statusCode: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), 'content-type': mime, etag: '"v1"' } }), url: new URL(url) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-limit-real-'));
  const queue = new DownloadQueue({ directory: path.join(dir, 'downloads'), stateFile: path.join(dir, 'queue.json'), toolsDirectory: dir, rangeRequest });
  t.after(async () => { queue.stop(); for (let i = 0; i < 100 && queue.active.size; i++) await wait(20); fs.rmSync(dir, { recursive: true, force: true }); });
  queue.setSettings({ speedLimitKiB: 512 }); // 3 MB at 512 KiB/s would take about 6 s
  const id = queue.add({ url: 'https://example.org/limit.bin', engine: 'direct', title: 'limit' });
  const started = performance.now();
  await wait(900);
  const job = queue.jobs.find(item => item.id === id);
  assert.equal(job.status, 'running', 'still downloading when the limit is lifted');
  const before = job.received || 0;
  assert.ok(before < 1.6 * 1024 * 1024, `the limit held back the first second (${before} bytes)`);
  queue.setSettings({ speedLimitKiB: 0 });
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(job.status); i++) await wait(25);
  assert.equal(job.status, 'completed', job.error);
  assert.ok(performance.now() - started < 4500, `lifting the limit finished the file early (${Math.round(performance.now() - started)} ms)`);
});