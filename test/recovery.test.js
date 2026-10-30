import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { recoverRead, RemoteResponseError, IncompleteResourceError, isTransient, recordRecovery } from '../src/recovery.js';
import { readHls } from '../src/hls.js';
import { SourceExpiredError } from '../src/transfer.js';

const url = 'https://cdn.example.org/list?signature=PRIVATE';
const media = '#EXTM3U\n#EXTINF:2,\ns.ts\n#EXT-X-ENDLIST\n';
const reply = (body, statusCode = 200, headers = {}) => ({ response: Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers }) });

for (const status of [202, 408, 425, 429, 500, 502, 503, 504]) test(`HLS HTTP ${status}: bounded local retry succeeds without accepting the error body`, async () => {
  let count = 0; const delays = [], responses = [];
  const playlist = await readHls({ url, request: async () => { const result = count++ ? reply(media) : reply('<html>not video</html>', status, { 'retry-after': '0.01' }); responses.push(result.response); return result; }, recovery: { sleep: async ms => { delays.push(ms); } } });
  assert.equal(playlist.duration, 2); assert.equal(count, 2); assert.deepEqual(delays, [500]);
  assert.ok(responses.every(r => r.destroyed));
});

test('persistent 202 stops after three GETs; server-controlled body/headers/URLs never enter errors', async () => {
  let count = 0;
  await assert.rejects(readHls({ url, request: async () => { count++; return reply('SECRET COOKIE', 202, { 'set-cookie': 'sid=SECRET' }); }, recovery: { sleep: async () => {} } }), error => error.status === 202 && !/PRIVATE|SECRET|https:/.test(error.message));
  assert.equal(count, 3);
});

for (const status of [401, 403, 410, 404, 451]) test(`HLS HTTP ${status}: no blind retries or access bypass`, async () => {
  let count = 0;
  await assert.rejects(readHls({ url, request: async () => { count++; return reply('', status); } }), error => [401, 403, 410].includes(status) ? error instanceof SourceExpiredError : error instanceof RemoteResponseError && !error.retryable);
  assert.equal(count, 1);
});

test('Retry-After seconds/date are honoured; an over-budget value is not shortened and retried', async () => {
  const delays = []; let count = 0;
  await recoverRead(async () => { if (!count++) throw new RemoteResponseError(503, { 'retry-after': '2' }); return true; }, { sleep: async ms => { delays.push(ms); } });
  assert.deepEqual(delays, [2000]);
  const future = new Date(Date.now() + 10000).toUTCString();
  assert.ok(new RemoteResponseError(429, { 'retry-after': future }).retryAfter >= 8500);
  count = 0;
  await assert.rejects(recoverRead(async () => { count++; throw new RemoteResponseError(429, { 'retry-after': '120' }); }, { sleep: async () => { assert.fail('must not sleep/retry early'); } }));
  assert.equal(count, 1);
});

test('abort while waiting cancels promptly; no next request', async () => {
  const controller = new AbortController(); let count = 0;
  const work = recoverRead(async () => { count++; throw new RemoteResponseError(503); }, { signal: controller.signal, onRetry: () => { controller.abort(new Error('user paused')); } });
  await assert.rejects(work, /abort|paused/i); assert.equal(count, 1);
});

test('overall deadline ends an in-flight attempt, not only its delay', async () => {
  await assert.rejects(recoverRead(async signal => { await wait(10000, null, { signal }); }, { maxElapsedMs: 20 }), /abort|timeout/i);
});

test('truncated manifest retries, but HTML, DRM, invalid URL and disk errors are never guessed transient', async () => {
  let count = 0;
  const result = await readHls({ url, request: async () => count++ ? reply(media) : reply('#EXTM3U\n#EXTINF:2,\n'), recovery: { sleep: async () => {} } });
  assert.equal(count, 2); assert.equal(result.duration, 2);
  count = 0;
  assert.equal(await readHls({ url, request: async () => { count++; return reply('<html>challenge</html>'); } }), null);
  assert.equal(count, 1);
  for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID']) assert.equal(isTransient(Object.assign(new Error('failure'), { code })), false);
  assert.equal(isTransient(new IncompleteResourceError()), true);
  count = 0;
  await assert.rejects(readHls({ url, request: async () => { count++; return reply(media.replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF')); } }), /DRM/);
  assert.equal(count, 1);
});

test('recovery trace is capped and strictly projects known events/numbers, not arbitrary diagnostics', () => {
  const job = {};
  for (let i = 0; i < 100; i++) recordRecovery(job, 'hls-retry', { status: 503, attempt: i, reason: 'http', delayMs: 500, url, headers: { Cookie: 'SECRET' }, message: 'SECRET', connections: 'SECRET' });
  recordRecovery(job, 'SECRET', { reason: 'SECRET' });
  assert.equal(job.recovery.length, 24);
  assert.doesNotMatch(JSON.stringify(job), /PRIVATE|SECRET|https:|headers|Cookie|message/);
  assert.equal(job.recovery.at(-1).attempt, 99);
});
