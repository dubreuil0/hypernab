import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { selectionState, canRetry } from '../public/queue-state.js';

// A captured (direct) media address expires; the page it was captured on gives a fresh address of the same file.
const payload = Buffer.alloc(5 * 1024 * 1024 + 7, 41);
const PAGE = 'https://videos.example.org/watch/42/';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0) Test/1.0';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-page-refresh-'));
  for (const tool of ['yt-dlp.exe', 'ffprobe.exe', 'ffmpeg.exe']) fs.writeFileSync(path.join(root, tool), 'test-double');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, mediaVerifier: async () => ({ height: 720, width: 1280, audio: true }), ...options });
  t.after(async () => { queue.stop(); await settled(queue); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue) {
  for (let i = 0; i < 800; i++) { if (!queue.active.size && !queue.jobs.some(job => job.status === 'queued')) return; await wait(10); }
  throw new Error('Queue timeout');
}
const refused = () => ({ response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }) });
function serve(url, headers, etag = '"same-file"') {
  const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
  const start = Number(first), end = Number(last);
  const response = Readable.from([payload.subarray(start, end + 1)]);
  response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(end - start + 1), 'content-type': 'video/mp4', etag };
  return { response, url: new URL(url) };
}
const pageInfo = fresh => ({ title: 'A video', formats: [
  { format_id: 'low', url: 'https://cdn.example.net/low.mp4?sig=new', protocol: 'https', ext: 'mp4', vcodec: 'h264' },
  { format_id: 'hq', url: fresh, protocol: 'https', ext: 'mp4', vcodec: 'h264' }
] });

test('an expired captured address is refreshed from the page it came from (older rows: the Referer), with the browser identity', async t => {
  const asked = [];
  const queue = fixture(t, {
    infoExtractor: async input => { asked.push(input); return pageInfo('https://cdn.example.net/file.mp4?sig=fresh'); },
    rangeRequest: async (url, signal, headers) => url.includes('sig=old') ? refused() : serve(url, headers)
  });
  // An older row: no stored page address, only the Referer the browser sent.
  queue.add({ url: 'https://cdn.example.net/file.mp4?sig=old', engine: 'direct', title: 'A video', referer: PAGE, userAgent: AGENT });
  await settled(queue);
  const [job] = queue.jobs;
  assert.equal(job.status, 'completed', job.error);
  assert.equal(asked.length, 1); assert.equal(asked[0].url, PAGE); assert.equal(asked[0].headers['User-Agent'], AGENT);
  assert.equal(job.sourceRefreshes, 1);
  assert.ok(job.recovery.some(entry => entry.event === 'source-refresh'));
  assert.deepEqual(fs.readFileSync(path.join(queue.dirOf(job), job.file)), payload);
});

test('the same file at a fresh address goes on from the bytes already on disk', async t => {
  const fresh = [];
  const queue = fixture(t, {
    infoExtractor: async () => pageInfo('https://cdn.example.net/file.mp4?sig=fresh'),
    rangeRequest: async (url, signal, headers) => {
      if (url.includes('sig=new')) return serve(url, headers, '"other-file"'); // a different file at the page: not the one on disk
      if (url.includes('sig=fresh')) { if (headers.Range !== 'bytes=0-0') fresh.push(headers.Range); return serve(url, headers); }
      // The old address: the size check and the first block pass, then the signature expires.
      const start = Number(/^bytes=(\d+)/.exec(headers.Range)[1]);
      if (headers.Range === 'bytes=0-0' || start < 2 * 1024 * 1024) return serve(url, headers);
      await wait(80); return refused();
    }
  });
  queue.add({ url: 'https://cdn.example.net/file.mp4?sig=old', engine: 'direct', title: 'A video', pageUrl: PAGE, userAgent: AGENT });
  await settled(queue);
  const [job] = queue.jobs;
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.pageUrl, PAGE);
  assert.ok(job.transfer.resumedBytes > 0, 'the first block was not fetched again');
  assert.ok(!fresh.includes(`bytes=0-${2 * 1024 * 1024 - 1}`), 'only small samples of the kept block were compared');
  assert.match(job.url, /sig=fresh/, 'the matching file was chosen, not the first working address');
  assert.deepEqual(fs.readFileSync(path.join(queue.dirOf(job), job.file)), payload);
});

test('without a page the refused download fails as before, and nothing is resolved', async t => {
  let resolves = 0;
  const queue = fixture(t, { autoRetries: 0, infoExtractor: async () => { resolves++; return pageInfo('https://cdn.example.net/x.mp4'); }, rangeRequest: async () => refused() });
  queue.setSettings({ autoRetries: 0 });
  queue.add({ url: 'https://cdn.example.net/file.mp4?sig=old', engine: 'direct', title: 'A video' });
  await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); assert.match(queue.jobs[0].error, /403/); assert.equal(resolves, 0);
});

test('"Retry failed" queues only failed downloads again and keeps the size they had', async t => {
  const queue = fixture(t, { rangeRequest: async () => refused() });
  queue.stopping = true; // nothing starts: only the list is checked
  for (const name of ['a', 'b', 'c']) queue.add({ url: `https://cdn.example.net/${name}.mp4`, engine: 'direct', start: 'queue' });
  const [failed, paused, done] = queue.jobs;
  Object.assign(failed, { status: 'failed', error: 'HTTP 403', total: 1234, autoRetries: 2 });
  paused.status = 'paused'; done.status = 'completed';
  assert.deepEqual(queue.batch('retry', { all: true }), { changed: 1, skipped: 2 });
  assert.equal(failed.status, 'queued'); assert.equal(failed.lastTotal, 1234); assert.equal(failed.autoRetries, 0); assert.equal(failed.error, null);
  assert.equal(paused.status, 'paused'); assert.equal(done.status, 'completed');
  assert.throws(() => queue.batch('explode', { all: true }));
  const state = selectionState(queue.jobs, queue.jobs, new Set(queue.jobs.map(job => job.id)));
  assert.equal(state.retry, 0); assert.equal(canRetry({ status: 'failed' }), true); assert.equal(canRetry({ status: 'paused' }), false);
});

test('many expired downloads read their pages at most two at a time', async t => {
  let reading = 0, most = 0;
  const queue = fixture(t, {
    infoExtractor: async input => { reading++; most = Math.max(most, reading); await wait(40); reading--; return pageInfo(`https://cdn.example.net/${encodeURIComponent(input.url)}.mp4?sig=fresh`); },
    rangeRequest: async (url, signal, headers) => url.includes('sig=old') ? refused() : serve(url, headers)
  });
  for (let i = 0; i < 6; i++) queue.add({ url: `https://cdn.example.net/${i}.mp4?sig=old`, engine: 'direct', title: `Video ${i}`, pageUrl: `${PAGE}${i}`, userAgent: AGENT });
  await settled(queue);
  assert.ok(queue.jobs.every(job => job.status === 'completed'), queue.jobs.map(job => job.error).join(' '));
  assert.equal(most, 2);
});

test('a fresh address with the same size but another validator is preferred over one of another size, and the content is compared before resuming', async t => {
  const queue = fixture(t, {
    infoExtractor: async () => pageInfo('https://cdn.example.net/file.mp4?sig=fresh'),
    rangeRequest: async (url, signal, headers) => {
      if (url.includes('sig=fresh')) { // probed first, but it is another (shorter) file
        const reply = serve(url, headers, '"shorter"'); const m = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
        reply.response.headers['content-range'] = `bytes ${m[1]}-${m[2]}/${payload.length - 100}`; return reply;
      }
      if (url.includes('sig=new')) return serve(url, headers, '"67cd5b0d-other-node"'); // same file, another node: another ETag
      const start = Number(/^bytes=(\d+)/.exec(headers.Range)[1]);
      if (headers.Range === 'bytes=0-0' || start < 2 * 1024 * 1024) return serve(url, headers);
      await wait(80); return refused();
    }
  });
  queue.add({ url: 'https://cdn.example.net/file.mp4?sig=old', engine: 'direct', title: 'A video', pageUrl: PAGE, userAgent: AGENT });
  await settled(queue);
  const [job] = queue.jobs;
  assert.equal(job.status, 'completed', job.error);
  assert.match(job.url, /sig=new/, 'the same-size candidate was chosen');
  assert.ok(job.transfer.resumedBytes > 0, 'the bytes on disk were kept');
  assert.deepEqual(fs.readFileSync(path.join(queue.dirOf(job), job.file)), payload);
});