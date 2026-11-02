import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DownloadQueue } from '../src/downloads.js';

// A fake network: ".zip" and ".pdf" addresses are files, "/page" addresses answer with a web page, "/gone" refuses.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-bulk-'));
  const seen = [];
  fs.writeFileSync(path.join(root, 'yt-dlp.exe'), ''); // only its presence counts: pages are added, never run, in these tests
  const rangeRequest = async (url, signal, headers) => {
    seen.push(url); signal?.throwIfAborted();
    const target = new URL(url);
    if (target.pathname === '/gone') return { response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }), url: target };
    const html = target.pathname.startsWith('/page'), total = 5000000;
    const type = html ? 'text/html' : target.pathname.endsWith('.pdf') ? 'application/pdf' : 'application/zip';
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range || 'bytes=0-0');
    return { response: Object.assign(Readable.from([Buffer.alloc(Number(last) - Number(first) + 1)]), { statusCode: 206, headers: { 'content-range': `bytes ${first}-${last}/${total}`, 'content-length': String(Number(last) - Number(first) + 1), 'content-type': type, etag: '"v1"' } }), url: target };
  };
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, rangeRequest });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { queue, seen };
}

test('several links at once: files and pages are told apart, duplicates and bad lines are counted, nothing starts when added for later', async t => {
  const { queue } = fixture(t);
  const result = await queue.addLinks({ start: 'queue', urls: [
    'https://files.example.org/a.zip', 'https://files.example.org/b.pdf', 'https://files.example.org/a.zip', // the same link twice
    'https://video.example.org/page/1', 'not a link', 'http://127.0.0.1/secret.zip', 'https://files.example.org/gone'
  ] });
  assert.equal(result.added, 3, 'a.zip, b.pdf and the page');
  assert.equal(result.skipped, 0, 'the repeated line is dropped before it counts');
  assert.equal(result.failed, 3, 'a bad line, a local address and a refused link');
  assert.equal(result.full, false);
  const jobs = queue.list();
  assert.equal(jobs.length, 3); assert.ok(jobs.every(job => job.status === 'held'), 'added for later: nothing started');
  assert.deepEqual(jobs.map(job => job.engine).sort(), ['direct', 'direct', 'extractor']);
  assert.deepEqual(jobs.filter(job => job.kind === 'file').map(job => job.title).sort(), ['a', 'b']);
  // adding the same list again adds nothing
  const again = await queue.addLinks({ start: 'queue', urls: ['https://files.example.org/a.zip', 'https://files.example.org/b.pdf'] });
  assert.equal(again.added, 0); assert.equal(again.skipped, 2); assert.equal(queue.list().length, 3);
});

test('several links: a file lands in its type folder when sorting is on; limits and a wrong body are refused', async t => {
  const { queue } = fixture(t);
  queue.setSettings({ sortByType: true });
  await queue.addLinks({ start: 'queue', urls: ['https://files.example.org/c.zip'] });
  assert.equal(queue.list()[0].directory ?? queue.jobs[0].directory, path.join(queue.directory, 'Archives'));
  await assert.rejects(queue.addLinks({ urls: [] }), /1–100|1-100/);
  await assert.rejects(queue.addLinks({ urls: Array.from({ length: 101 }, (_, i) => `https://files.example.org/${i}.zip`) }), /1–100|1-100/);
  await assert.rejects(queue.addLinks({}), /1–100|1-100/);
});

test('several links: when the queue is full the rest is not tried and it is said so', async t => {
  const { queue, seen } = fixture(t);
  for (let i = 0; i < 499; i++) queue.add({ url: `https://old.example.org/${i}.zip`, engine: 'direct', start: 'queue' });
  const result = await queue.addLinks({ start: 'queue', urls: Array.from({ length: 6 }, (_, i) => `https://files.example.org/n${i}.zip`) });
  assert.equal(queue.jobs.length, 500);
  assert.equal(result.full, true); assert.ok(result.added >= 1 && result.added <= 3, `added ${result.added}`);
  assert.ok(seen.length < 12, 'it stopped looking at the remaining links');
});
