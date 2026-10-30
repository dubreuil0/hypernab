import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { downloadParallel, probeRange, IntegrityError, SourceChangedError, RateLimitedError } from '../src/transfer.js';
import { ConnectionBudget, AdaptiveWindow } from '../src/connection-budget.js';

function destination(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-adaptive-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, 'file.bin');
}
const bytes = Buffer.from(Array.from({ length: 262144 }, (_, i) => i % 251));
function source(data = bytes, { etag = '"stable"', modified, modify = () => {}, chunkSize = data.length, slow = false, requests = [] } = {}) {
  return async (_url, signal, headers) => {
    signal?.throwIfAborted(); const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range); const start = Number(a), end = Number(b);
    requests.push({ start, end });
    const response = Readable.from((async function* () {
      for (let offset = start; offset <= end; offset += chunkSize) {
        if (slow && end > start) await wait(start === 0 ? 3 : 1, null, { signal });
        yield data.subarray(offset, Math.min(end + 1, offset + chunkSize));
      }
    })());
    response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), etag, 'last-modified': modified };
    modify(response, start, end); return { response };
  };
}
test('uyarlanabilir pencere hız düşüşü ve hatada azalır; sağlıklı yanıtta sınırlı artar', () => {
  const window = new AdaptiveWindow(8); assert.equal(window.target, 2);
  window.sample(1000, 10); window.sample(1000, 10); assert.equal(window.target, 3);
  window.sample(10, 100); assert.equal(window.target, 2);
  window.failure(); assert.equal(window.target, 1);
  for (let i = 0; i < 100; i++) window.sample(1000, 10);
  assert.equal(window.target, 8); assert.ok(window.reductions >= 2);
});
test('global ve host bütçeleri paylaşılır; boşta farklı host bekletilmez', async () => {
  const budget = new ConnectionBudget({ total: 3, perHost: 2 });
  const a = await budget.acquire('a.example'), b = await budget.acquire('a.example');
  let granted = false; const pending = budget.acquire('a.example').then(release => { granted = true; return release; });
  const c = await budget.acquire('b.example'); assert.equal(granted, false); assert.equal(budget.snapshot().active, 3);
  a(); const d = await pending; assert.equal(budget.snapshot().active, 3);
  b(); c(); d(); d(); assert.equal(budget.snapshot().active, 0);
});
test('bütçe beklerken iptal listener ve rezervasyon sızıntısı bırakmaz', async () => {
  const budget = new ConnectionBudget({ total: 1, perHost: 1 }), controller = new AbortController();
  const release = await budget.acquire('a.example');
  const pending = assert.rejects(budget.acquire('a.example', controller.signal), { name: 'AbortError' }); controller.abort(); await pending;
  assert.equal(budget.snapshot().waiting, 0); release(); assert.equal(budget.snapshot().active, 0);
});
test('host cooldown yeni isteği bekletir', async () => {
  const budget = new ConnectionBudget({ total: 2, perHost: 2 }); budget.cooldown('a.example', 30);
  const start = Date.now(), release = await budget.acquire('a.example'); assert.ok(Date.now() - start >= 15); release();
});
test('aktif büyük aralık bölünür; kısmi yazmalarla çakışma veya boşluk oluşmaz', async t => {
  const file = destination(t), updates = [];
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', blockSize: bytes.length * 2, minSplitBytes: 4096, request: source(bytes, { chunkSize: 1024, slow: true }), onProgress: value => updates.push(value) });
  assert.ok(result.splits > 0); assert.ok(result.connections > 1 && result.connections <= 8);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.ok(updates.every(p => p.received <= p.total));
});
test('429 yanıtı bağlantıları azaltır ve sınırlı tekrar ile kurtarılır', async t => {
  const file = destination(t); let limited = false, cooldowns = 0;
  const good = source();
  const request = async (...args) => {
    if (!limited && args[2].Range !== 'bytes=0-0') {
      limited = true; return { response: Object.assign(Readable.from([]), { statusCode: 429, headers: { 'retry-after': '0' } }) };
    }
    return good(...args);
  };
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', request, retryDelay: 1, onThrottle: () => cooldowns++ });
  assert.ok(result.reductions > 0); assert.equal(cooldowns, 1); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('sürekli 429 en fazla üç denemeden sonra durur', async t => {
  const file = destination(t); let attempts = 0;
  const good = source();
  const request = async (...args) => {
    if (args[2].Range === 'bytes=0-0') return good(...args);
    attempts++; return { response: Object.assign(Readable.from([]), { statusCode: 429, headers: { 'retry-after': '0' } }) };
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', request, connections: 1, retryDelay: 1 }), RateLimitedError);
  assert.equal(attempts, 3); assert.equal(fs.existsSync(file), false);
});
test('Last-Modified değişimi yalnızca ETag kontrolüne bırakılmaz', async t => {
  const file = destination(t);
  const request = source(bytes, { etag: null, modified: 'Wed, 01 Jan 2025 00:00:00 GMT', modify(response, a, b) { if (b > a) response.headers['last-modified'] = 'Thu, 02 Jan 2025 00:00:00 GMT'; } });
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', request }), SourceChangedError);
  assert.equal(fs.existsSync(file), false);
});
test('yanlış komşu overlap verisi doğru başlık/uzunluk olsa da reddedilir', async t => {
  const file = destination(t), original = source();
  const request = async (...args) => {
    const result = await original(...args);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(args[2].Range); const start = Number(a), end = Number(b);
    if (start > 0 && end > start) {
      const bad = Buffer.from(bytes.subarray(start, end + 1)); bad[0] ^= 255;
      const response = Readable.from([bad]); response.statusCode = 206; response.headers = result.response.headers; result.response.destroy(); return { response };
    }
    return result;
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', blockSize: 65536, request, connections: 1 }), IntegrityError);
  assert.equal(fs.existsSync(file), false);
});
test('kısmi dosyanın ortası bozulursa yerel blok hash’i eski veriyi koruyarak yeniden başlatır', async t => {
  const file = destination(t), request = source();
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', blockSize: 65536, request, verify: async () => { throw new Error('pause after bytes'); } }));
  const fd = fs.openSync(file + '.parallel.part', 'r+'); fs.writeSync(fd, Buffer.from([255]), 0, 1, 30000); fs.closeSync(fd);
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', blockSize: 65536, request });
  assert.equal(result.resumedBytes, 0); assert.match(result.resumeReason, /özet/);
  assert.ok(fs.readdirSync(path.dirname(file)).some(n => n.includes('.previous-'))); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('sunucu aynı ETag ile değişmiş veri sunarsa devam sınırı bunu yakalar', async t => {
  const file = destination(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', connections: 1, request: source(), verify: async () => { throw new Error('pause'); } }));
  const changed = Buffer.from(bytes); changed[0] ^= 255;
  const result = await downloadParallel({ url: 'https://example.com/new-signed-url', destination: file, sourceKey: 'key', connections: 1, request: source(changed) });
  assert.equal(result.resumedBytes, 0); assert.match(result.resumeReason, /eşleşmedi/); assert.deepEqual(fs.readFileSync(file), changed);
});
test('eski v1 checkpoint tahminle kullanılmaz ve silinmez', async t => {
  const file = destination(t); fs.writeFileSync(file + '.parallel.part', bytes);
  fs.writeFileSync(file + '.ranges.json', JSON.stringify({ identity: { version: 1 }, completed: [0] }));
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'key', request: source() });
  assert.equal(result.resumedBytes, 0); assert.ok(fs.readdirSync(path.dirname(file)).filter(n => n.includes('.previous-')).length === 2);
});
test('doğrulanamayan zayıf ETag devam validator’ı sayılmaz', async () => {
  const probe = await probeRange({ url: 'https://example.com/a', request: source(bytes, { etag: 'W/"weak"' }) });
  assert.equal(probe.validator, null);
});
