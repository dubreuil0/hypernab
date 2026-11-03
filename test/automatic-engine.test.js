import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { ConnectionBudget } from '../src/connection-budget.js';
import { NetworkStallError } from '../src/network.js';

const payload = Buffer.alloc(5 * 1024 * 1024 + 7, 23);
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-auto-test-'));
  fs.writeFileSync(path.join(root, 'yt-dlp.exe'), 'test-double'); fs.writeFileSync(path.join(root, 'ffprobe.exe'), 'test-double'); fs.writeFileSync(path.join(root, 'ffmpeg.exe'), 'test-double');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, mediaVerifier: async () => ({ height: 720, width: 1280, audio: true }), ...options });
  t.after(async () => { queue.stop(); await settled(queue); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue) {
  for (let i = 0; i < 500; i++) { if (!queue.active.size) return; await wait(10); }
  throw new Error('Queue timeout');
}
function rangeSource(data = payload, mime = 'video/mp4', onRequest = () => {}) {
  return async (url, signal, headers) => {
    signal?.throwIfAborted(); onRequest(url, headers);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(first), end = Number(last);
    const response = Readable.from([data.subarray(start, end + 1)]);
    response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), 'content-type': mime, etag: '"stable"' };
    return { response, url: new URL(url) };
  };
}
const info = host => ({ url: `https://${host}/video.mp4?signature=private`, protocol: 'https', ext: 'mp4', format_id: '720', title: 'A video', duration: 10, vcodec: 'h264', acodec: 'aac' });

test('iki farkli saglayici ayni otomatik paralel motoru kullanır', async t => {
  for (const host of ['media.example.org', 'cdn.other.example.net']) {
    const queue = fixture(t, { infoExtractor: async () => info(host), rangeRequest: rangeSource() });
    queue.add({ url: `https://${host}/watch`, engine: 'extractor' }); await settled(queue);
    const [job] = queue.list(); assert.equal(job.status, 'completed', job.error); assert.equal(job.transfer.method, 'parallel-http');
    assert.ok(job.transfer.connections > 1); assert.deepEqual(fs.readFileSync(path.join(queue.directory, job.file)), payload);
    assert.doesNotMatch(JSON.stringify(job), /signature=private/);
  }
});
test('doğrudan sıradan dosya da paralel indirilebilir; video doğrulaması uygulanmaz', async t => {
  let verified = false;
  const queue = fixture(t, { rangeRequest: rangeSource(payload, 'application/pdf'), mediaVerifier: async () => { verified = true; throw new Error('not video'); } });
  queue.add({ url: 'https://documents.example.org/report.pdf', engine: 'direct', title: 'Rapor' }); await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error); assert.equal(verified, false);
  assert.equal(job.transfer.method, 'parallel-http'); assert.match(job.file, /\.pdf$/);
});
test('Range desteklemeyen doğrudan kaynak güvenli tek bağlantıya döner', async t => {
  const queue = fixture(t, {
    rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) }),
    remoteOpener: async () => ({ response: Object.assign(Readable.from([Buffer.from('file')]), { headers: { 'content-type': 'application/pdf', 'content-length': '4' } }), url: new URL('https://example.org/file.pdf') })
  });
  queue.add({ url: 'https://example.org/file.pdf', engine: 'direct' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(queue.jobs[0].transfer.method, 'single-http'); assert.match(queue.jobs[0].notice, /Tek bağlantılı/);
});
test('paralel kaynağın reddinde standart motor aynı format kimliğini kullanır', async t => {
  let format;
  const queue = fixture(t, { infoExtractor: async () => info('media.example.org'), rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) }) });
  queue.extractNative = async (job, _signal, selected) => { format = selected; job.transfer = { method: 'yt-dlp' }; };
  queue.add({ url: 'https://example.org/watch', engine: 'extractor', quality: '720' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(format, '720'); assert.match(queue.jobs[0].notice, /standart medya/);
});
test('manifestler byte-range motoruna gönderilmez', async t => {
  let native = false;
  const queue = fixture(t, { infoExtractor: async () => ({ ...info('media.example.org'), protocol: 'm3u8_native' }), rangeRequest: async () => { throw new Error('Should not probe'); } });
  queue.transferHls = async () => { native = true; };
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(native, true);
});
test('doğrudan verilen manifest otomatik olarak akış motoruna yönelir', async t => {
  const queue = fixture(t);
  queue.run = (_job, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  queue.add({ url: 'https://example.org/master.m3u8', engine: 'direct' });
  assert.equal(queue.jobs[0].engine, 'extractor');
});
test('uzantısız manifest yanıtı tek dosya olarak kaydedilmez', async t => {
  let native = false;
  const queue = fixture(t, {
    rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) }),
    remoteOpener: async () => ({ response: Object.assign(Readable.from([]), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), url: new URL('https://example.org/opaque') }),
    infoExtractor: async () => ({ ...info('media.example.org'), protocol: 'm3u8_native' })
  });
  queue.transferHls = async () => { native = true; };
  queue.add({ url: 'https://example.org/opaque', engine: 'direct' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(queue.jobs[0].engine, 'extractor'); assert.equal(native, true); assert.equal(fs.readdirSync(queue.directory).length, 0);
});
test('ayrı görüntü/ses en fazla 8 bağlantıyı paylaşır, birleşmeden tamamlanmaz', async t => {
  let merged = false, verified = false, peak = 0;
  const video = { ...info('video.example.org'), acodec: 'none', format_id: 'v' };
  const audio = { ...info('audio.example.org'), vcodec: 'none', acodec: 'aac', ext: 'm4a', format_id: 'a' };
  const queue = fixture(t, {
    infoExtractor: async () => ({ title: 'Split video', duration: 10, requested_formats: [video, audio] }), rangeRequest: rangeSource(),
    mediaMerger: async (files, output) => {
      assert.equal(queue.jobs[0].status, 'running'); assert.equal(queue.jobs[0].transfer.phase, 'merging');
      for (const file of files) assert.deepEqual(fs.readFileSync(file), payload);
      fs.writeFileSync(output, 'merged bytes'); merged = true;
    },
    mediaVerifier: async () => { assert.equal(merged, true); verified = true; return { height: 720, audio: true }; }
  });
  const original = queue.updateTransfer.bind(queue);
  queue.updateTransfer = (job, value, method) => { peak = Math.max(peak, value.connections); original(job, value, method); };
  queue.add({ url: 'https://example.org/split', engine: 'extractor' }); await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error); assert.equal(verified, true); assert.equal(job.transfer.method, 'parallel-streams');
  assert.ok(peak > 1 && peak <= 8); assert.equal(fs.readFileSync(path.join(queue.directory, job.file), 'utf8'), 'merged bytes');
  assert.equal(fs.readdirSync(queue.directory).some(name => name.includes('.stream-')), false);
});
test('tek bağlantı ayarı ayrı görüntü ve sesi de sırayla indirir', async t => {
  const queue = fixture(t, {
    infoExtractor: async () => ({ title: 'Split', requested_formats: [{ ...info('video.example.org'), acodec: 'none', format_id: 'v' }, { ...info('audio.example.org'), vcodec: 'none', ext: 'm4a', format_id: 'a' }] }),
    rangeRequest: rangeSource(),
    mediaMerger: async (files, output) => { for (const file of files) assert.deepEqual(fs.readFileSync(file), payload); fs.writeFileSync(output, 'merged'); }
  });
  queue.setSettings({ maxConnections: 1 });
  queue.add({ url: 'https://example.org/split', engine: 'extractor' }); await settled(queue);
  const [job] = queue.list();
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.transfer.connections, 1);
  assert.equal(job.transfer.maxConnections, 1);
});
test('bir akış Range desteklemiyorsa iki akış da veri yazmadan standart motora döner', async t => {
  let transfers = 0, native;
  const queue = fixture(t, {
    infoExtractor: async () => ({ requested_formats: [{ ...info('video.example.org'), acodec: 'none', format_id: 'v' }, { ...info('audio.example.org'), ext: 'm4a', vcodec: 'none', format_id: 'a' }] }),
    rangeRequest: async (url, signal, headers) => {
      if (headers.Range !== 'bytes=0-0') transfers++;
      if (url.includes('audio.')) return { response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) };
      return rangeSource()(url, signal, headers);
    }
  });
  queue.extractNative = async (_job, _signal, format) => { native = format; };
  queue.add({ url: 'https://example.org/split', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(native, 'v+a'); assert.equal(transfers, 0); assert.deepEqual(fs.readdirSync(queue.directory), []);
});
test('doğrulama başarısızsa standart motora sessiz geçilmez ve dosya tamamlandı sayılmaz', async t => {
  const queue = fixture(t, { infoExtractor: async () => info('media.example.org'), rangeRequest: rangeSource(), mediaVerifier: async () => { throw new Error('Bad media'); } });
  queue.extractNative = async () => { throw new Error('Unexpected native fallback'); };
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); assert.equal(queue.jobs[0].error, 'Bad media');
  assert.equal(fs.readdirSync(queue.directory).some(name => name.endsWith('.parallel.part')), true);
});

test('doğrudan dosyada farklı mevcut hedefin üzerine yazılmaz; yeni veri de korunur', async t => {
  const queue = fixture(t, { rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) }),
    remoteOpener: async () => ({ response: Object.assign(Readable.from([Buffer.from('new')]), { headers: { 'content-type': 'application/pdf', 'content-length': '3' } }), url: new URL('https://example.org/a.pdf') }) });
  queue.batch('pause', { all: true });
  const id = queue.add({ url: 'https://example.org/a.pdf', engine: 'direct', title: 'file' });
  const target = path.join(queue.directory, `${id}-file.pdf`); fs.writeFileSync(target, 'old');
  queue.resume(id); await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); assert.match(queue.jobs[0].error, /farklı/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old'); assert.equal(fs.readFileSync(target + '.part', 'utf8'), 'new');
});
test('çalışan akışta Range reddi olursa diğer worker’lar kapanmadan native fallback başlamaz', async t => {
  let readers = 0, fallback = false;
  const queue = fixture(t, {
    infoExtractor: async () => ({ requested_formats: [{ ...info('video.example.org'), acodec: 'none', format_id: 'v' }, { ...info('audio.example.org'), vcodec: 'none', ext: 'm4a', format_id: 'a' }] }),
    rangeRequest: async (url, signal, headers) => {
      if (headers.Range === 'bytes=0-0') return rangeSource()(url, signal, headers);
      if (url.includes('video.')) return { response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) };
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range); const start = Number(first), end = Number(last);
      const response = Readable.from((async function* () {
        readers++;
        try { yield payload.subarray(start, start + 10); await wait(10000, null, { signal }); yield payload.subarray(start + 10, end + 1); }
        finally { readers--; }
      })());
      response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': String(end - start + 1), etag: '"stable"' };
      return { response };
    }
  });
  queue.extractNative = async () => { assert.equal(readers, 0); fallback = true; };
  queue.add({ url: 'https://example.org/split', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error); assert.equal(fallback, true); assert.equal(readers, 0);
});

test('süresi dolan çözümlenmiş kaynak bir kez yenilenir; eski URL’ye sonsuz tekrar yapılmaz', async t => {
  let extractions = 0;
  const queue = fixture(t, {
    infoExtractor: async () => ({ ...info('cdn.example.org'), url: `https://cdn.example.org/file?version=${++extractions === 1 ? 'old' : 'fresh'}` }),
    rangeRequest: async (url, signal, headers) => {
      if (url.includes('old') && headers.Range !== 'bytes=0-0') return { response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }) };
      return rangeSource()(url, signal, headers);
    }
  });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error); assert.equal(extractions, 2); assert.equal(queue.jobs[0].sourceRefreshes, 1);
  assert.equal(queue.jobs[0].verification.status, 'passed');
});
test('kaynak yenilenirken format değişirse sessiz kalite düşüşü yapılmaz', async t => {
  let extractions = 0;
  const queue = fixture(t, {
    infoExtractor: async () => ({ ...info('cdn.example.org'), format_id: ++extractions === 1 ? '720' : '480' }),
    rangeRequest: async (url, signal, headers) => headers.Range === 'bytes=0-0' ? rangeSource()(url, signal, headers) : { response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }) }
  });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); assert.match(queue.jobs[0].error, /format değişti/); assert.equal(extractions, 2);
});
test('hızlı yol yenilemeden sonra da reddedilirse aynı kalite yt-dlp kendi indirmesiyle alınır (yöntem merdiveni)', async t => {
  let extractions = 0, nativeFormat = null;
  const queue = fixture(t, {
    infoExtractor: async () => { extractions++; return info('cdn.example.org'); },
    rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }) }),
    processSpawner: fakeNative((_file, args) => { nativeFormat = args[args.indexOf('-f') + 1]; })
  });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error);
  assert.equal(extractions, 2, 'bir kez yenilendi, sonra standart motora geçildi');
  assert.match(queue.jobs[0].notice, /standart medya motoruyla/);
  assert.ok(nativeFormat);
});
test('kalite listesi gösterildikten hemen sonra başlayan indirme ikinci (yavaş) çözümlemeyi beklemeden başlar', async t => {
  let resolves = 0;
  const raw = { title: 'A video', duration: 10, http_headers: {}, formats: [{ ...info('cdn.example.org'), format_id: '720' }] };
  const queue = fixture(t, { infoExtractor: async () => { resolves++; return info('cdn.example.org'); }, rangeRequest: rangeSource() });
  const url = 'https://example.org/watch';
  queue.rememberOffered(url, [{ id: '720', label: '720p · MP4', height: 720, ext: 'mp4', codec: 'H.264' }], [], raw);
  queue.add({ url, engine: 'extractor', formatId: '720' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error);
  assert.equal(resolves, 0, 'yt-dlp ikinci kez çalıştırılmadı');
  assert.ok(!JSON.stringify(queue.list()).includes('signature=private'), 'ham çözümleme istemciye sızmaz');
});
test('hızlı yol ilk bayttan önce sessiz kalırsa (30 sn veri yok) aynı kalite yt-dlp ile alınır', async t => {
  let nativeRan = false;
  const queue = fixture(t, {
    infoExtractor: async () => info('cdn.example.org'),
    rangeRequest: async () => { throw new NetworkStallError('Sunucu 30 saniye boyunca veri göndermedi.'); },
    processSpawner: fakeNative(() => { nativeRan = true; })
  });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error); assert.equal(nativeRan, true);
  assert.match(queue.jobs[0].notice, /standart medya motoruyla/);
});
test('geçici ilk bağlantı kopması manuel duraklat/sürdür gerektirmeden hızlı yolda toparlanır', async t => {
  let probes = 0;
  const queue = fixture(t, { infoExtractor: async () => info('cdn.example.org'), rangeRequest: async (...args) => {
    if (args[2].Range === 'bytes=0-0' && !probes++) throw Object.assign(new Error('reset https://private.invalid/?secret=SECRET'), { code: 'ECONNRESET' });
    return rangeSource()(...args);
  } });
  queue.extractNative = () => { assert.fail('temporary probe failure must not choose the slower route'); };
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  const [job] = queue.list();
  assert.equal(job.status, 'completed', job.error); assert.equal(job.transfer.method, 'parallel-http');
  assert.equal(job.autoRetries || 0, 0); assert.equal(probes, 2);
  assert.ok(job.recovery.some(e => e.event === 'probe-retry' && e.reason === 'network'));
  assert.doesNotMatch(JSON.stringify(job.recovery), /SECRET|private|https:/);
});
test('hızlı probe geçici 202/503 yanıtını Range yok sanmaz; seçili kalite değişmez', async t => {
  let probes = 0;
  const queue = fixture(t, { infoExtractor: async () => info('cdn.example.org'), rangeRequest: async (...args) => {
    if (args[2].Range === 'bytes=0-0' && probes++ < 2) return { response: Object.assign(Readable.from([]), { statusCode: probes === 1 ? 202 : 503, headers: { 'retry-after': '0' } }) };
    return rangeSource()(...args);
  } });
  queue.extractNative = () => { assert.fail('must stay on fast route'); };
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error);
  assert.equal(queue.jobs[0].sourceSelection.format, '720');
  assert.deepEqual(queue.jobs[0].recovery.filter(e => e.event === 'probe-retry').map(e => e.status), [202, 503]);
});
test('birden fazla iş aynı host ve global bütçeyi gerçekten paylaşır', async t => {
  const budget = new ConnectionBudget({ total: 3, perHost: 2 }); let peak = 0, hostPeak = 0;
  const queue = fixture(t, { concurrency: 3, budget, rangeRequest: async (url, signal, headers) => {
    peak = Math.max(peak, budget.active); hostPeak = Math.max(hostPeak, budget.hosts.get(new URL(url).hostname) || 0);
    const result = await rangeSource(payload, 'application/pdf')(url, signal, headers);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const replacement = Readable.from((async function* () { await wait(3, null, { signal }); yield payload.subarray(Number(a), Number(b) + 1); })());
    replacement.statusCode = result.response.statusCode; replacement.headers = result.response.headers; result.response.destroy(); return { response: replacement, url: new URL(url) };
  } });
  for (const host of ['same.example.org', 'same.example.org', 'other.example.org']) queue.add({ url: `https://${host}/${queue.jobs.length}.pdf`, engine: 'direct' });
  await settled(queue); assert.ok(queue.jobs.every(job => job.status === 'completed'), JSON.stringify(queue.jobs.map(j => j.error)));
  assert.ok(peak <= 3 && peak >= 2); assert.ok(hostPeak <= 2); assert.equal(budget.active, 0); assert.equal(budget.waiting.length, 0);
});
function fakeNative(onOutput) {
  return (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'); fs.writeFileSync(output, 'native-video-bytes');
      onOutput?.(output, args);
      child.stdout.end(`HYPERNAB_FILE:${JSON.stringify(output)}\n`); child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}
test('native çıktı ortak doğrulamayı geçmeden son dosya adına taşınmaz', async t => {
  let staged;
  const queue = fixture(t, { infoExtractor: async () => ({ ...info('cdn.example.org'), protocol: 'http_dash_segments' }), processSpawner: fakeNative(file => { staged = file; }), mediaVerifier: async () => { throw new Error('bad native media'); } });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); assert.equal(queue.jobs[0].verification.status, 'failed');
  assert.equal(queue.jobs[0].file, null); assert.equal(fs.existsSync(staged), true); assert.equal(queue.budget.active, 0);
});
test('native motor başarılı doğrulamadan sonra yayınlar ve parça bütçesini geçirir', async t => {
  let slots;
  const budget = new ConnectionBudget({ total: 1, perHost: 1 });
  const queue = fixture(t, { budget, infoExtractor: async () => ({ ...info('cdn.example.org'), protocol: 'http_dash_segments' }), processSpawner: fakeNative((_file, args) => {
    slots = args[args.indexOf('--concurrent-fragments') + 1]; assert.ok(args.includes('--continue') && !args.includes('--no-continue')); assert.equal(budget.active, 1);
  }) });
  queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error); assert.equal(slots, '1'); assert.equal(queue.jobs[0].verification.status, 'passed');
  assert.equal(fs.readFileSync(path.join(queue.directory, queue.jobs[0].file), 'utf8'), 'native-video-bytes'); assert.equal(budget.active, 0);
});
test('yanlış checksum ve derin tarama parametreleri kuyruğa iş eklemez', t => {
  const queue = fixture(t); queue.batch('pause', { all: true });
  for (const expectedSha256 of ['bad', 123, false]) assert.throws(() => queue.add({ url: 'https://example.org/a', engine: 'direct', expectedSha256 }), /SHA-256/);
  assert.throws(() => queue.add({ url: 'https://example.org/a', engine: 'direct', deepVerify: 'true' }), /Derin/);
  assert.equal(queue.jobs.length, 0);
});

test('sessiz video listesi + ayrı ses listesi: ses indirilir, kopyalayarak birleştirilir, sesli doğrulanır ve adres istemciye sızmaz', async t => {
  const outputs = []; let merged = null, verified = null;
  const spawner = (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      const target = args[args.indexOf('-o') + 1], url = args[args.length - 1];
      const output = target.replace('%(ext)s', 'mp4'); fs.writeFileSync(output, url.includes('audio') ? 'sound' : 'picture'); outputs.push({ url, output });
      child.stdout.end(`HYPERNAB_FILE:${JSON.stringify(output)}\n`); child.stderr.end(); setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const queue = fixture(t, {
    infoExtractor: async () => ({ ...info('cdn.example.org'), protocol: 'http_dash_segments' }), processSpawner: spawner, remoteResolver: async () => {},
    mediaMerger: async (files, output) => { merged = files.map(file => fs.readFileSync(file, 'utf8')); fs.writeFileSync(output, 'picture+sound'); },
    mediaVerifier: async (file, _tools, _duration, _signal, expectation) => { verified = expectation; return { height: 720, width: 1280, audio: true }; }
  });
  queue.add({ url: 'https://example.org/video.mpd?token=a', audioUrl: 'https://example.org/sound.mpd?token=secret-audio', engine: 'extractor' }); await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(outputs.map(item => item.url.replace(/\?.*/, '')), ['https://example.org/video.mpd', 'https://example.org/sound.mpd']);
  assert.deepEqual(merged, ['picture', 'sound'], 'önce görüntü, sonra ses birleştirilir');
  assert.equal(fs.readFileSync(path.join(queue.directory, job.file), 'utf8'), 'picture+sound');
  assert.equal(verified.requireAudio, true, 'birleşik dosyada ses zorunlu doğrulanır');
  assert.ok(!JSON.stringify(queue.list()).includes('secret-audio'), 'ses adresi istemciye sızmaz');
});
test('ses akışı yalnızca yt-dlp ve ffmpeg ile, geçerli adresle ve extractor motoruyla kabul edilir', t => {
  const queue = fixture(t, {});
  assert.throws(() => queue.add({ url: 'https://example.org/v.mp4', audioUrl: 'https://example.org/a.m3u8', engine: 'direct' }), /ses akışı/i);
  assert.throws(() => queue.add({ url: 'https://example.org/v.m3u8', audioUrl: 'file:///C:/secret', engine: 'extractor' }));
});

// The media engine carries on from its own half-written files, but only for the very same source.
function resumeFixture(t, sizeOf) {
  const seen = []; let run = 0;
  const spawner = (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); const index = run++;
    setImmediate(() => {
      const stage = path.dirname(args[args.indexOf('-o') + 1]), part = path.join(stage, 'payload.f137.mp4.part');
      seen.push({ args, kept: fs.existsSync(part) ? fs.readFileSync(part, 'utf8') : null, files: fs.readdirSync(stage).sort() });
      if (index === 0) { fs.writeFileSync(part, 'half-written'); child.stderr.end('ERROR: Video unavailable'); setImmediate(() => child.emit('close', 1)); return; } // a source that stops (not retried by itself)
      const output = path.join(stage, 'payload.mp4'); fs.writeFileSync(output, 'native-video-bytes'); fs.rmSync(part, { force: true });
      child.stdout.end(`HYPERNAB_FILE:${JSON.stringify(output)}\n`); child.stderr.end(); setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const queue = fixture(t, { autoRetries: 0, infoExtractor: async () => ({ ...info('cdn.example.org'), protocol: 'http_dash_segments', requested_formats: [{ format_id: '137', filesize: sizeOf(), url: 'https://cdn.example.org/v' }] }), processSpawner: spawner });
  return { queue, seen };
}
test('yt-dlp indirmesi duraklatilip/kesilip yeniden baslatilinca kaldigi yerden devam eder (ayni kaynak)', async t => {
  const { queue, seen } = resumeFixture(t, () => 1000);
  const id = queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  assert.equal(queue.jobs[0].status, 'failed'); queue.retry(id); await settled(queue);
  const job = queue.jobs[0]; assert.equal(job.status, 'completed', job.error);
  assert.ok(seen[1].args.includes('--continue') && !seen[1].args.includes('--no-continue'));
  assert.equal(seen[1].kept, 'half-written', 'the half-written file was still there when the engine started again');
  assert.equal(job.transfer.resumedFromPartial, true);
  assert.equal(fs.readdirSync(queue.directory).some(name => name.includes('.previous-')), false, 'no copy of the earlier data is set aside any more');
  assert.equal(fs.readFileSync(path.join(queue.directory, job.file), 'utf8'), 'native-video-bytes');
  assert.equal(fs.readdirSync(queue.directory).filter(name => name.includes('native-stage')).length, 0, 'the work folder is gone when the file is published');
});
test('yt-dlp: kaynak degistiyse (boyut farkli) yarim veri kullanilmaz, guvenle bastan baslar', async t => {
  let size = 1000;
  const { queue, seen } = resumeFixture(t, () => size);
  const id = queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  size = 2000; queue.retry(id); await settled(queue);
  const job = queue.jobs[0]; assert.equal(job.status, 'completed', job.error);
  assert.equal(seen[1].kept, null, 'a changed source never inherits the old half-written file');
  assert.equal(job.transfer.resumedFromPartial, false);
});
test('yt-dlp: eski surumun kimliksiz calisma klasoru guvenilmez, bastan baslanir ve ayrilmis kopyalar temizlenir', async t => {
  const { queue, seen } = resumeFixture(t, () => 1000);
  const id = queue.add({ url: 'https://example.org/watch', engine: 'extractor' }); await settled(queue);
  const stage = path.join(queue.directory, `${id}.native-stage`); fs.rmSync(path.join(stage, 'resume.json'), { force: true }); // what an earlier version left
  fs.mkdirSync(`${stage}.previous-old`); fs.writeFileSync(path.join(`${stage}.previous-old`, 'x.part'), 'old');
  queue.retry(id); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error); assert.equal(seen[1].kept, null);
  assert.equal(fs.existsSync(`${stage}.previous-old`), false);
});