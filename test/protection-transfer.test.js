import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { downloadParallel } from '../src/transfer.js';

const payload = Buffer.from(Array.from({ length: 64007 }, (_, i) => i % 251));
const url = 'https://media.example.org/file?signature=SYNTHETIC';
function fixture(t) {
  const dir = fs.mkdtempSync((process.env.LOCALAPPDATA + '/Temp/opencode/hypernab-protection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'video.mp4');
}
function source({ fault, controller } = {}) {
  let failed = false;
  return async (_url, signal, headers) => {
    signal.throwIfAborted();
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range), start = Number(a), end = Number(b);
    let shortened = false;
    if (end > start && !failed && fault) {
      failed = true;
      if (fault === 'reset') throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' });
      if (fault === 'pause') { controller.abort(new Error('synthetic pause')); signal.throwIfAborted(); }
      if (fault === '503') return { response: Object.assign(Readable.from([]), { statusCode: 503, headers: { 'retry-after': '0' } }) };
      if (fault === 'short') shortened = true;
    }
    const bytes = payload.subarray(start, end + 1);
    return { response: Object.assign(Readable.from([shortened ? bytes.subarray(0, -1) : bytes]), {
      statusCode: 206, headers: { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(bytes.length), etag: '"fixed"' }
    }) };
  };
}

for (const connections of [1, 2, 4, 8]) for (const fault of ['reset', '503', 'short']) test(`protection: ${connections} connections + ${fault}, output bytes remain exact after recovery`, async t => {
  const destination = fixture(t);
  let verified = false;
  await downloadParallel({ url, destination, sourceKey: 'fixture', signal: AbortSignal.timeout(10000), request: source({ fault }), connections, blockSize: 4096, retryDelay: 1,
    verify: async file => { assert.equal(fs.existsSync(destination), false); assert.deepEqual(fs.readFileSync(file), payload); verified = true; } });
  assert.equal(verified, true); assert.deepEqual(fs.readFileSync(destination), payload);
});

for (const connections of [1, 4]) test(`protection: pause with ${connections} connections keeps unpublished data; a clean retry verifies before publishing`, async t => {
  const destination = fixture(t), controller = new AbortController();
  await assert.rejects(downloadParallel({ url, destination, sourceKey: 'fixture', signal: controller.signal, request: source({ fault: 'pause', controller }), connections, blockSize: 4096, retryDelay: 1 }), /pause/);
  assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(destination + '.ranges.json'), true);
  await downloadParallel({ url, destination, sourceKey: 'fixture', signal: AbortSignal.timeout(10000), request: source(), connections, blockSize: 4096, retryDelay: 1,
    verify: async file => assert.deepEqual(fs.readFileSync(file), payload) });
  assert.deepEqual(fs.readFileSync(destination), payload);
});
