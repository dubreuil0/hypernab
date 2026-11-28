import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ConnectionBudget } from '../src/connection-budget.js';
import { setTimeout as pause } from 'node:timers/promises';
import { downloadParallel, planRanges, spreadIndexes, RangeUnsupportedError, SourceChangedError } from '../src/transfer.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-range-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'video.mp4');
}
function source(data, { etag = '"stable-file"', requests = [], modify = () => {} } = {}) {
  return async (_url, signal, headers) => {
    signal?.throwIfAborted();
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(first), end = Number(last);
    requests.push({ start, end, headers });
    const response = Readable.from([data.subarray(start, end + 1)]);
    response.statusCode = 206;
    response.headers = { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), etag };
    modify(response, start, end);
    return { response };
  };
}
const data = Buffer.from(Array.from({ length: 25000 }, (_, i) => i % 251));
// Same size, every byte different: what a changed file (not another server of the same file) looks like.
const altered = Buffer.from(data.map(b => (b + 1) % 251));

test('byte aralıkları boşluksuz, çakışmasız ve dosyanın tam boyutunda planlanır', () => {
  const ranges = planRanges(10001, 1000);
  assert.equal(ranges.length, 11); assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1).end, 10000);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i - 1].end + 1, ranges[i].start);
  assert.throws(() => planRanges(-1)); assert.throws(() => planRanges(5, 0));
});
test('uyarlanabilir bağlantılar doğru konumlara yazar; doğrulama öncesi tamamlandı sayılmaz', async t => {
  const destination = fixture(t), requests = [], updates = [];
  let verified = false;
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data, { requests }), onProgress: p => updates.push(p), verify: async file => {
    assert.equal(fs.existsSync(destination), false); assert.deepEqual(fs.readFileSync(file), data); verified = true;
  } });
  assert.equal(verified, true); assert.ok(result.connections >= 2 && result.connections <= 8);
  assert.deepEqual(fs.readFileSync(destination), data);
  assert.equal(updates.at(-1).phase, 'completed'); assert.equal(updates.at(-1).received, data.length);
  assert.equal(requests.length, planRanges(data.length, 2000).length + 1);
  assert.equal(fs.existsSync(destination + '.ranges.json'), false);
});
test('Range yoksa kaynak sessizce 8 kez tam indirilmez', async t => {
  const destination = fixture(t);
  const request = async () => { const response = Readable.from([data]); response.statusCode = 200; response.headers = {}; return { response }; };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', request }), RangeUnsupportedError);
  assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(destination + '.parallel.part'), false);
});
test('yanlış Content-Range tamamlanmış parça olarak kaydedilmez', async t => {
  const destination = fixture(t);
  const request = source(data, { modify(response, start, end) { if (end > start) response.headers['content-range'] = `bytes 0-0/${data.length}`; } });
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request }), RangeUnsupportedError);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination + '.ranges.json')).completed, []);
});
test('eksik parça yeniden denenir; bitmeyen parça checkpoint’e girmez', async t => {
  const destination = fixture(t);
  let attempts = 0;
  const request = source(data, { modify(response, start, end) {
    if (end > start) attempts++;
  } });
  // Use an explicitly empty body without changing the advertised range.
  const empty = async (...args) => {
    const { response } = await request(...args);
    if (args[2].Range !== 'bytes=0-0') {
      const replacement = Readable.from([]); replacement.statusCode = response.statusCode; replacement.headers = response.headers; response.destroy(); return { response: replacement };
    }
    return { response };
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request: empty }), /eksik/);
  assert.equal(attempts, 3); assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination + '.ranges.json')).completed, []);
});
test('iptalden sonra tamamlanan parçalar korunur ve sonraki denemede atlanır', async t => {
  const destination = fixture(t), controller = new AbortController();
  const original = source(data);
  const request = async (...args) => {
    if (args[2].Range.endsWith('-3999')) { controller.abort(); controller.signal.throwIfAborted(); }
    return original(...args);
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request, signal: controller.signal }));
  assert.deepEqual(JSON.parse(fs.readFileSync(destination + '.ranges.json')).completed, [0]);
  const requests = [];
  const result = await downloadParallel({ url: 'https://example.com/refreshed-signed-url', destination, sourceKey: 'key', blockSize: 2000, request: source(data, { requests }) });
  assert.equal(result.resumedBytes, 2000);
  assert.equal(requests.filter(r => r.start === 0 && r.end === 1999).length, 0);
  assert.ok(result.verificationBytes > 0);
  assert.deepEqual(fs.readFileSync(destination), data);
});
test('devam kontrolü sırasında sayaç kayıtlı veriyi gösterir; kontrol eşzamanlı yapılır ve veri baştan indirilmez', async t => {
  const destination = fixture(t), controller = new AbortController();
  const original = source(data);
  const request = async (...args) => {
    if (args[2].Range.endsWith('-11999')) { controller.abort(); controller.signal.throwIfAborted(); }
    return original(...args);
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request, signal: controller.signal }));
  const savedParts = JSON.parse(fs.readFileSync(destination + '.ranges.json')).completed.length;
  assert.ok(savedParts >= 3);
  const requests = [], updates = [];
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, maxResumeSamples: 2, request: source(data, { requests }), onProgress: p => updates.push(p) });
  const checking = updates.filter(p => p.phase === 'checking-resume' && p.resumeTotal);
  assert.ok(checking.length > 0);
  assert.ok(checking.every(p => p.received === savedParts * 2000), 'sayaç kayıtlı bloklar kadar olmalı, 0 değil');
  assert.equal(checking.at(-1).resumeChecked, savedParts);
  assert.equal(result.resumedBytes, savedParts * 2000);
  // Remote comparison is bounded: 2 sampled blocks x 2 tiny slices, no matter how many blocks were saved.
  const samples = requests.filter(r => r.end - r.start + 1 > 1 && r.end - r.start + 1 <= 64 && r.end < savedParts * 2000);
  assert.ok(samples.length > 0 && samples.length <= 4, `uzak örnek sayısı sınırlı olmalı (${samples.length})`);
  assert.equal(requests.filter(r => r.end - r.start + 1 > 64 && r.end < savedParts * 2000).length, 0);
  assert.deepEqual(fs.readFileSync(destination), data);
});
test('devam kontrolündeki geçici 401 beklenip tekrar denenir; veri baştan indirilmez', async t => {
  const destination = fixture(t), controller = new AbortController();
  const original = source(data);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, signal: controller.signal,
    request: async (...args) => { if (args[2].Range.endsWith('-5999')) { controller.abort(); controller.signal.throwIfAborted(); } return original(...args); } }));
  let rejected = 0;
  const requests = [];
  const flaky = async (...args) => {
    const reply = await source(data, { requests })(...args);
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(args[2].Range);
    const length = Number(to) - Number(from) + 1; // length 1 is the initial probe, not a resume sample
    if (length > 1 && length <= 64 && rejected < 2) { rejected++; reply.response.statusCode = 401; }
    return reply;
  };
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: flaky, resumeRetryDelay: 5 });
  assert.equal(rejected, 2);
  assert.ok(result.resumedBytes >= 2000);
  assert.equal(result.resumeReason, null);
  assert.deepEqual(fs.readFileSync(destination), data);
});
test('spreadIndexes ilk ve son örneği her zaman içerir ve sınırı aşmaz', () => {
  assert.deepEqual(spreadIndexes(0, 12), []);
  assert.deepEqual(spreadIndexes(3, 12), [0, 1, 2]);
  const picked = spreadIndexes(216, 12);
  assert.ok(picked.length <= 12 && picked[0] === 0 && picked.at(-1) === 215);
  assert.deepEqual(spreadIndexes(10, 1), [9]);
});
test('video doğrulanmazsa dosya son adına taşınmaz; yeniden doğrulama byte indirmez', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data), verify: async () => { throw new Error('Invalid video'); } }), /Invalid video/);
  assert.equal(fs.existsSync(destination), false);
  const requests = [];
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data, { requests }) });
  assert.equal(result.resumedBytes, data.length); assert.equal(result.payloadBytes, 0); assert.equal(result.networkBytes, result.verificationBytes); assert.ok(requests.length > 1);
});
test('kaynak validator değişirse eski dosya korunur ve eski bloklarla karıştırılmaz', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data), verify: async () => { throw new Error('stop'); } }));
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(altered, { etag: '"new-file"' }) });
  assert.equal(result.resumedBytes, 0);
  assert.ok(fs.readdirSync(path.dirname(destination)).some(n => n.includes('.previous-')));
  assert.deepEqual(fs.readFileSync(destination), altered);
});

test('aynı hedef zaten varsa SHA256 eşleştirilip yeniden kullanılır, üzerine yazılmaz', async t => {
  const destination = fixture(t); fs.writeFileSync(destination, data);
  const before = fs.statSync(destination).mtimeMs;
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', request: source(data) });
  assert.equal(result.reusedExisting, true); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(destination).mtimeMs, before);
  assert.equal(fs.existsSync(destination + '.parallel.part'), false);
  assert.deepEqual(fs.readFileSync(destination), data);
});
test('aynı boyutta farklı hedef varsa korunur, indirme dosyası da silinmez', async t => {
  const destination = fixture(t), existing = Buffer.alloc(data.length, 44); fs.writeFileSync(destination, existing);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', request: source(data) }), /içeriği farklı/);
  assert.deepEqual(fs.readFileSync(destination), existing);
  assert.deepEqual(fs.readFileSync(destination + '.parallel.part'), data);
});

// ---- Same file, another server of the same site (the validator differs, the content does not) ----
const big = Buffer.from(Array.from({ length: 400000 }, (_, i) => (i * 7 + (i >> 8)) % 253));
const flipFrom = 6000; // slices at or after this offset (and longer than the 1-byte probe) come from "another server"
// The first requests see etag "a"; slices from `flipFrom` on are served by another node: etag "b" and `content`.
function nodes({ content = data, requests = [], ifRange200 = false } = {}) {
  const first = source(data, { etag: '"a"', requests });
  return async (url, signal, headers) => {
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    if (Number(to) === Number(from) || Number(from) < flipFrom) return first(url, signal, headers);
    const reply = await source(content, { etag: '"b"', requests })(url, signal, headers);
    if (ifRange200 && headers['If-Range'] && headers['If-Range'] !== '"b"') {
      const full = Readable.from([content]); full.statusCode = 200; full.headers = { 'content-length': String(content.length), etag: '"b"' };
      reply.response.destroy(); return { response: full };
    }
    return reply;
  };
}

test('aynı içerik, başka ETag: devam eder; yalnız küçük örnekler yeniden indirilir', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(big, { etag: '"67cd5ad6-40a4c4f"' }), verify: async () => { throw new Error('stop'); } }), /stop/);
  const requests = [];
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(big, { etag: '"67cd5b0d-40a4c4f"', requests }) });
  assert.equal(result.resumedBytes, big.length); assert.equal(result.payloadBytes, 0); assert.equal(result.resumeReason, null);
  assert.ok(result.verificationBytes > 0 && result.verificationBytes <= 24 * 2 * 1024, `örnek bayt: ${result.verificationBytes}`);
  assert.ok(requests.filter(r => r.end > r.start).length >= 24, 'en az 24 örnek');
  assert.ok(requests.every(r => r.end - r.start + 1 <= 1024), 'blok indirilmedi');
  assert.ok(requests.filter(r => r.end > r.start).every(r => !r.headers['If-Range']), 'örnekler If-Range göndermez');
  assert.ok(!fs.readdirSync(path.dirname(destination)).some(n => n.includes('.previous-')));
  assert.deepEqual(fs.readFileSync(destination), big);
});
test('aynı boyut, farklı içerik, başka ETag: devam edilmez, eski dosya kenara alınır, baştan iner', async t => {
  const destination = fixture(t), other = Buffer.from(big.map(b => b ^ 1));
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(big, { etag: '"a"' }), verify: async () => { throw new Error('stop'); } }), /stop/);
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(other, { etag: '"b"' }) });
  assert.equal(result.resumedBytes, 0);
  const previous = fs.readdirSync(path.dirname(destination)).filter(n => n.includes('.parallel.part.previous-'));
  assert.equal(previous.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(destination), previous[0])), big);
  assert.deepEqual(fs.readFileSync(destination), other);
});
test('örneklenen bir bloğun tek baytı bile farklıysa (başka ETag) devam edilmez', async t => {
  const destination = fixture(t), other = Buffer.from(big); other[0] ^= 1;
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(big, { etag: '"a"' }), verify: async () => { throw new Error('stop'); } }), /stop/);
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 10000, request: source(other, { etag: '"b"' }) });
  assert.equal(result.resumedBytes, 0); assert.deepEqual(fs.readFileSync(destination), other);
});
test('ETag yalnız bir tarafta yoksa bugünkü gibi baştan inilir', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data, { modify: r => { delete r.headers.etag; } }), verify: async () => { throw new Error('stop'); } }), /stop/);
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', blockSize: 2000, request: source(data, { modify: r => { delete r.headers.etag; } }) });
  assert.equal(result.resumedBytes, 0); assert.equal(result.resumeSupported, false);
  assert.deepEqual(fs.readFileSync(destination), data);
});
for (const connections of [1, 3]) {
  test(`indirme ortasında ETag değişir, içerik aynı: tamamlanır (${connections} bağlantı)`, async t => {
    const destination = fixture(t), requests = [];
    const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections, blockSize: 2000, request: nodes({ requests }) });
    assert.ok(requests.some(r => r.start >= flipFrom && r.end > r.start));
    assert.equal(result.payloadBytes, data.length);
    assert.deepEqual(fs.readFileSync(destination), data);
  });
}
test('indirme ortasında ETag ve içerik değişir: SourceChangedError, dosya yayımlanmaz', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request: nodes({ content: altered }) }), SourceChangedError);
  assert.equal(fs.existsSync(destination), false);
});
test('If-Range eski ETag ile 200 döndürürse parça If-Range olmadan yeniden istenir ve tamamlanır', async t => {
  const destination = fixture(t), requests = [];
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request: nodes({ requests, ifRange200: true }) });
  assert.ok(requests.some(r => r.start >= flipFrom && !r.headers['If-Range']), 'If-Range olmadan yeniden istendi');
  assert.deepEqual(fs.readFileSync(destination), data); assert.equal(result.payloadBytes, data.length);
});
test('If-Range 200 yanıtı farklı boyutta ise SourceChangedError', async t => {
  const destination = fixture(t);
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request: nodes({ content: data.subarray(0, 24000), ifRange200: true }) }), SourceChangedError);
});
test('ETag olmayan sunucuda 200 yanıtı bugünkü gibi RangeUnsupportedError', async t => {
  const destination = fixture(t);
  const request = async (url, signal, headers) => {
    const reply = await source(data, { modify: r => { delete r.headers.etag; } })(url, signal, headers);
    if (headers.Range !== 'bytes=0-0') { const full = Readable.from([data]); full.statusCode = 200; full.headers = { 'content-length': String(data.length) }; return { response: full }; }
    return reply;
  };
  await assert.rejects(downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 1, blockSize: 2000, request }), RangeUnsupportedError);
});test('başından beri her parça başka ETag ile gelir, bütçe doluyken bile kilitlenmeden tamamlanır (çapa isteği öncelik hattında)', async t => {
  const destination = fixture(t), budget = new ConnectionBudget({ total: 2, perHost: 2, reserve: 2 });
  const inner = source(data, { etag: '"b"' }), first = source(data, { etag: '"a"' });
  const served = async (url, signal, headers) => {
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    if (from === to) return first(url, signal, headers);
    await pause(Number(from) === 2000 ? 150 : 15, null, { signal });
    return inner(url, signal, headers);
  };
  const lanes = [];
  const request = (url, signal, headers, options) => { lanes.push(Boolean(options?.priority)); return budget.request(served, url, signal, headers, options); };
  const started = performance.now();
  const result = await downloadParallel({ url: 'https://example.com/a', destination, sourceKey: 'key', connections: 2, blockSize: 2000, request, signal: AbortSignal.timeout(8000) });
  assert.ok(performance.now() - started < 6000);
  assert.equal(result.payloadBytes, data.length); assert.ok(result.verificationBytes > 0, 'çapa kullanıldı'); assert.ok(lanes.includes(true), 'çapa isteği öncelik hattından gitti');
  assert.deepEqual(fs.readFileSync(destination), data);
});