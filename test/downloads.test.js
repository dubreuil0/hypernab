import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadQueue, assertCompleteResponse } from '../src/downloads.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-test-'));
  const rangeRequest = async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) });
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'state.json'), toolsDirectory: root, rangeRequest, ...options });
  t.after(async () => { queue.stop(); await settled(queue); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue) {
  for (let i = 0; i < 100; i++) {
    if (!queue.active.size) return;
    await delay(10);
  }
  throw new Error('Kuyruk zamanında bitmedi.');
}
function response(data, headers = {}) {
  const stream = Readable.from([Buffer.from(data)]);
  stream.headers = { 'content-type': 'video/mp4', 'content-length': String(Buffer.byteLength(data)), ...headers };
  return { response: stream, url: new URL('https://example.com/movie.mp4') };
}
test('206 yanıtı tam dosyayı kapsamıyorsa reddedilir; parça video diye kaydedilmez', () => {
  for (const range of ['bytes 0-99/1000', 'bytes 100-199/1000', 'bytes 0-99/*', '']) {
    let destroyed = false;
    assert.throws(() => assertCompleteResponse({ statusCode: 206, headers: { 'content-range': range }, destroy() { destroyed = true; } }), /parçası/);
    assert.equal(destroyed, true);
  }
  const full = { statusCode: 206, headers: { 'content-range': 'bytes 0-999/1000' }, destroy() {} };
  assertCompleteResponse(full);
  assert.equal(full.headers['content-length'], '1000');
});
test('dosyayı indirir, kaydeder ve hassas kaynak URL’sini API listesinden gizler', async t => {
  const queue = fixture(t, { remoteOpener: async () => response('video-bytes') });
  queue.add({ url: 'https://example.com/a.mp4?secret=yes', engine: 'direct', title: 'deneme' });
  await settled(queue);
  const [job] = queue.list();
  assert.equal(job.status, 'completed'); assert.equal(job.received, 11);
  assert.equal(fs.readFileSync(path.join(queue.directory, job.file), 'utf8'), 'video-bytes');
  assert.equal(job.url, undefined);
  assert.equal(job.headers, undefined);
  assert.equal(fs.readdirSync(queue.directory).some(f => f.endsWith('.part')), false);
});
test('HTML sayfasını video gibi kaydetmez', async t => {
  const queue = fixture(t, { remoteOpener: async () => response('<html>', { 'content-type': 'text/html' }) });
  queue.add({ url: 'https://example.com/a', engine: 'direct' });
  await settled(queue);
  assert.equal(queue.list()[0].status, 'failed');
  assert.equal(fs.readdirSync(queue.directory).length, 0);
});
test('eksik dosyayı tamamlandı saymaz ve alınmış veriyi korur', async t => {
  const queue = fixture(t, { autoRetries: 0, remoteOpener: async () => response('short', { 'content-length': '100' }) });
  queue.add({ url: 'https://example.com/a', engine: 'direct' });
  await settled(queue);
  assert.equal(queue.list()[0].status, 'failed');
  assert.equal(fs.readdirSync(queue.directory).length, 1);
  assert.equal(fs.readFileSync(path.join(queue.directory, fs.readdirSync(queue.directory)[0]), 'utf8'), 'short');
});
test('geçici hata kullanıcıya yansımadan program tarafından kendiliğinden yeniden denenir', async t => {
  let attempts = 0;
  const queue = fixture(t, { remoteOpener: async () => {
    if (!attempts++) throw new Error('Geçici ağ sorunu');
    return response('ok');
  } });
  queue.add({ url: 'https://example.com/a', engine: 'direct' });
  await settled(queue);
  assert.equal(queue.list()[0].status, 'completed', queue.list()[0].error); assert.equal(attempts, 2);
});
test('tekrar denemeyle çözülmeyecek hata (ör. DRM) hemen başarısız görünür, boşuna denenmez', async t => {
  let attempts = 0;
  const queue = fixture(t, { remoteOpener: async () => { attempts++; throw new Error('DRM korumalı kaynak desteklenmiyor.'); } });
  queue.add({ url: 'https://example.com/a', engine: 'direct' });
  await settled(queue);
  assert.equal(queue.list()[0].status, 'failed'); assert.equal(attempts, 1);
});
test('hatalı dosya yeniden denenebilir (API)', async t => {
  let attempts = 0;
  const queue = fixture(t, { autoRetries: 0, remoteOpener: async () => {
    if (!attempts++) throw new Error('Geçici ağ sorunu');
    return response('ok');
  } });
  const id = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  await settled(queue); assert.equal(queue.list()[0].status, 'failed');
  queue.retry(id); await settled(queue); assert.equal(queue.list()[0].status, 'completed');
});
test('eşzamanlılık sınırına uyar, sıradaki iş iptal edilebilir', async t => {
  const pending = [];
  const queue = fixture(t, { concurrency: 1, remoteOpener: (_url, signal) => new Promise((resolve, reject) => {
    pending.push(() => resolve(response('ok')));
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  queue.add({ url: 'https://example.com/a', engine: 'direct' });
  const id = queue.add({ url: 'https://example.com/b', engine: 'direct' });
  assert.equal(queue.active.size, 1);
  queue.cancel(id); assert.equal(queue.list().at(-1).status, 'cancelled'); // the list keeps the order of adding: the newest row is last
  for (let i = 0; i < 100 && !pending.length; i++) await delay(5);
  pending[0](); await settled(queue);
  assert.equal(queue.jobs.filter(j => j.status === 'completed').length, 1);
});
test('çalışan iş iptal edilince dosya bırakmaz', async t => {
  const queue = fixture(t, { remoteOpener: async (_url, signal) => {
    await delay(500, null, { signal }); return response('late');
  } });
  const id = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  queue.cancel(id); await settled(queue);
  assert.equal(queue.list()[0].status, 'cancelled');
  assert.equal(fs.readdirSync(queue.directory).length, 0);
});
test('eksik medya aracı için anlaşılır hata verir; manifest dosya motoruna zorlanmaz', t => {
  const queue = fixture(t);
  assert.throws(() => queue.add({ url: 'https://example.com/video', engine: 'extractor' }), /yt-dlp/);
  assert.throws(() => queue.add({ url: 'https://example.com/a.m3u8', engine: 'direct' }), /FFmpeg/);
});
test('doğrudan önizleme dosya oluşturmadan ad ve boyut döndürür', async t => {
  let forwardedHeaders;
  const queue = fixture(t, { remoteOpener: async (_url, _signal, _redirects, headers) => { forwardedHeaders = headers; return response('video'); } });
  const info = await queue.inspect({ url: 'https://example.com/a.mp4', engine: 'direct', title: 'Örnek', userAgent: 'Firefox/158', referer: 'https://example.com/watch?secret=yes' });
  assert.equal(info.title, 'Örnek'); assert.equal(info.filesize, 5); assert.equal(info.extension, 'mp4');
  assert.deepEqual(info.heights, []);
  assert.equal(forwardedHeaders['User-Agent'], 'Firefox/158');
  assert.equal(forwardedHeaders.Referer, 'https://example.com/watch');
  assert.equal(queue.jobs.length, 0); assert.equal(fs.readdirSync(queue.directory).length, 0);
});
test('yeniden açılan uygulama yarım işleri otomatik yeniden başlatmaz', t => {
  const queue = fixture(t);
  fs.writeFileSync(queue.stateFile, JSON.stringify([{ id: 'test', url: 'https://example.com/a', status: 'running' }]));
  const reloaded = new DownloadQueue({ directory: queue.directory, stateFile: queue.stateFile, toolsDirectory: queue.toolsDirectory });
  assert.equal(reloaded.list()[0].status, 'interrupted');
  assert.equal(reloaded.active.size, 0);
});
