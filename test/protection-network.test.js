import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readHls } from '../src/hls.js';
import { SourceExpiredError } from '../src/transfer.js';

const url = 'https://media.example.org/master?sig=NEVER-ECHO';
const media = '#EXTM3U\n#EXTINF:2,\ns.ts\n#EXT-X-ENDLIST\n';
const response = (statusCode, body = '', headers = {}) => ({ response: Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers }) });
const statuses = [202, 408, 425, 429, 500, 502, 503, 504];
for (const first of statuses) test(`protection: HTTP ${first} followed by each transient status recovers within three GETs`, async () => {
  for (const second of statuses) {
    let calls = 0; const delays = [], responses = [];
    const playlist = await readHls({ url, request: async () => {
      const result = calls === 0 ? response(first, 'NOT-MEDIA') : calls === 1 ? response(second, 'NOT-MEDIA') : response(200, media);
      calls++; responses.push(result.response); return result;
    }, recovery: { sleep: async ms => { delays.push(ms); } } });
    assert.equal(calls, 3); assert.equal(playlist.duration, 2); assert.deepEqual(delays, [500, 1000]);
    assert.ok(responses.every(r => r.destroyed));
  }
});

for (const status of [401, 403, 410]) test(`protection: transient response followed by ${status} stops instead of bypassing/refetching access`, async () => {
  let calls = 0;
  await assert.rejects(readHls({ url, request: async () => response(calls++ ? status : 503), recovery: { sleep: async () => {} } }), SourceExpiredError);
  assert.equal(calls, 2);
});

test('protection: cancellation at either retry prevents the next GET', async () => {
  for (const cancelAt of [1, 2]) {
    const controller = new AbortController(); let calls = 0, sleeps = 0;
    await assert.rejects(readHls({ url, signal: controller.signal, request: async () => { calls++; return response(503); }, recovery: {
      sleep: async (_ms, _value, { signal }) => { if (++sleeps === cancelAt) controller.abort(new Error('synthetic pause')); signal.throwIfAborted(); }
    } }), /pause/);
    assert.equal(calls, cancelAt);
  }
});

test('protection: retry success status does not make HTML, JSON or binary data an HLS playlist', async () => {
  for (const body of ['<html>challenge</html>', '{"ok":true}', 'not a media manifest at all']) {
    let calls = 0;
    assert.equal(await readHls({ url, request: async () => calls++ ? response(200, body) : response(202), recovery: { sleep: async () => {} } }), null);
    assert.equal(calls, 2);
  }
});
