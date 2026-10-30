import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { ProgressMeter, NativeProgress, jobPhase, sourceMeasureKey, estimateBeforeDownload } from '../src/job-progress.js';
import { DownloadQueue } from '../src/downloads.js';
import { progressView, durationText } from '../public/progress-view.js';

function measurement() {
  let now = 0;
  const meter = new ProgressMeter(() => now);
  const job = { status: 'running', received: 0, total: 10000 };
  meter.stage('downloading'); meter.sample(0);
  return { meter, job, at(time, bytes) { now = time; if (bytes !== undefined) { job.received = bytes; meter.sample(bytes); } return meter.snapshot(job, 'downloading'); } };
}
test('ön tahmin yalnızca aynı gerçek medya sunucusundan yeterli, yakın ve tutarlı geçmişle üretilir', () => {
  const now = Date.now(), key = sourceMeasureKey([{ url: 'https://cdn.example.org/video?secret=hidden', protocol: 'https' }]);
  assert.equal(key, 'http:cdn.example.org'); assert.doesNotMatch(key, /secret|hidden/);
  const sample = (seconds = 10, age = 1000) => ({ status: 'completed', speedReference: { key, seconds, networkBytes: 10_000_000, at: now - age } });
  const history = [sample(10), sample(11), sample(9)];
  assert.deepEqual(estimateBeforeDownload(history, key, 20_000_000, now), { etaSeconds: 20, basis: 'source-history' });
  for (const [jobs, source, bytes] of [[history.slice(0, 2), key, 20_000_000], [history, 'http:other.org', 20_000_000], [history, key, null], [[sample(10), sample(11), sample(100)], key, 20_000_000], [[sample(10, 8 * 86400000), sample(), sample()], key, 20_000_000]]) {
    assert.equal(estimateBeforeDownload(jobs, source, bytes, now).etaSeconds, null);
  }
  assert.equal(sourceMeasureKey([{ url: 'not a URL', protocol: 'https' }]), null);
  assert.notEqual(sourceMeasureKey([{ url: 'https://cdn.example.org/a', protocol: 'm3u8_native' }]), key, 'manifest aktarımı ayrı ölçülmeli');
});
test('ilk örneklerde süre yok; yeterli gerçek ölçümden sonra yumuşatılmış ETA', () => {
  const m = measurement();
  assert.equal(m.at(0).etaSeconds, null);
  assert.equal(m.at(500, 500).etaSeconds, null);
  const p = m.at(1500, 1500);
  assert.equal(p.speed, 1000); assert.equal(p.etaSeconds, 9);
  const burst = m.at(2000, 3500);
  assert.ok(burst.speed > 1000 && burst.speed < 4000, 'tek sıçrama ham hız olarak gösterilmez');
});
test('veri kesilince sıfır hız ve bilinmeyen ETA; eski hız ekranda kalmaz', () => {
  const m = measurement(); m.at(500, 500); m.at(1500, 1500);
  const p = m.at(6000);
  assert.equal(p.speed, 0); assert.equal(p.etaSeconds, null); assert.equal(p.etaReason, 'stalled');
});
test('bilinmeyen boyut için yüzde/süre uydurulmaz; NaN ve sonsuz değerler dışlanır', () => {
  const m = measurement(); m.job.total = null;
  m.at(500, 500); const p = m.at(1500, 1500);
  assert.equal(p.percent, null); assert.equal(p.etaSeconds, null); assert.equal(p.etaReason, 'unknown-size');
  m.meter.sample(Infinity); m.meter.sample(NaN);
  assert.ok(Number.isFinite(m.at(1600).speed));
});
test('kayıtlı parça byte sayısı hıza eklenmez; sayaç düşerse ölçüm sıfırlanır', () => {
  const m = measurement(); m.meter.stage('checking-resume');
  m.job.received = 8000; m.meter.sample(8000);
  assert.equal(m.meter.snapshot(m.job, 'checking-resume').speed, 0);
  m.meter.stage('downloading'); m.meter.sample(0);
  m.at(500, 500); m.at(1500, 1500);
  assert.equal(m.at(1600, 0).etaSeconds, null);
});
test('duraklama, iptal ve işlem aşamalarında hız/süre yok; aşama süreleri ayrıdır', () => {
  const m = measurement(); m.at(500, 500); m.at(1500, 1500);
  m.meter.stage('merging'); m.at(3500);
  const p = m.meter.snapshot(m.job, 'merging');
  assert.equal(p.speed, 0); assert.equal(p.etaSeconds, null);
  assert.equal(p.phaseSeconds.downloading, 1.5); assert.equal(p.phaseSeconds.merging, 2);
  for (const status of ['paused', 'cancelled', 'completed', 'interrupted', 'failed', 'queued']) {
    m.job.status = status;
    assert.equal(m.meter.snapshot(m.job, status).speed, 0);
    assert.equal(m.meter.snapshot(m.job, status).etaSeconds, null);
  }
});
test('yeniden devam edince önceki hız veya ETA kullanılmaz', () => {
  const m = measurement(); m.at(500, 500); m.at(1500, 1500);
  m.meter.stage('paused'); m.at(20000);
  m.meter.stage('downloading'); m.meter.sample(1500);
  assert.equal(m.at(21000, 1600).etaSeconds, null);
});
test('standart motor ses/görüntü sayaçlarını toplar, format değişiminde sıfırlamaz', () => {
  const p = new NativeProgress({ requested_formats: [{ format_id: 'v', filesize: 8000 }, { format_id: 'a', filesize: 2000 }] });
  assert.equal(p.update('v', { downloaded_bytes: 8000, status: 'finished' }).received, 8000);
  const a = p.update('a', { downloaded_bytes: 500, total_bytes: 2000 });
  assert.equal(a.received, 8500); assert.equal(a.total, 10000); assert.equal(a.sizeKind, 'approx');
  assert.equal(p.update('a', { downloaded_bytes: 200, total_bytes: 2000 }).received, 8500, 'gecikmiş bildirim sayacı geriletmez');
});
test('standart motorda bilinmeyen diğer akış eksik toplam gibi sunulmaz', () => {
  const p = new NativeProgress({ requested_formats: [{ format_id: 'v' }, { format_id: 'a' }] });
  assert.equal(p.update('v', { downloaded_bytes: 100, total_bytes: 100 }).total, null);
  const both = p.update('a', { downloaded_bytes: 25, total_bytes_estimate: 50 });
  assert.equal(both.total, 150); assert.equal(both.sizeKind, 'approx');
});
test('tek akış yaklaşık boyuttan kesin boyuta geçebilir; yinelenen bitiş iki kez sayılmaz', () => {
  const p = new NativeProgress({ format_id: 'x', filesize_approx: 1000 });
  assert.equal(p.update('x', { downloaded_bytes: 100 }).sizeKind, 'approx');
  const end = p.update('x', { downloaded_bytes: 900, status: 'finished' });
  assert.deepEqual(end, { received: 900, total: 900, sizeKind: 'exact' });
  assert.deepEqual(p.update('x', { downloaded_bytes: 900, status: 'finished' }), end);
});
test('API durumları devam isteği, kapanan worker ve tamamlanmamış yayını ayırır', () => {
  assert.equal(jobPhase({ status: 'paused' }, true), 'pausing');
  assert.equal(jobPhase({ status: 'paused', resumeRequested: true }, true), 'waiting-resume');
  assert.equal(jobPhase({ status: 'running', transfer: { phase: 'completed' } }), 'publishing');
  assert.equal(jobPhase({ status: 'completed', transfer: { phase: 'verifying' } }), 'completed');
});
test('arayüz API ölçümünü kullanır; bilinmeyen boyutu ve her motorda ETA gösterir', () => {
  const job = { status: 'running', transfer: { method: 'single-http' }, progress: { phase: 'downloading', received: 10, total: null, speed: 0, percent: null, etaSeconds: null, etaReason: 'unknown-size' } };
  const view = progressView(job, String);
  assert.match(view.size, /Boyut bilinmiyor/); assert.match(view.remaining, /boyut bilinmiyor/); assert.equal(view.percent, null);
  job.progress.total = 100; job.progress.sizeKind = 'approx'; job.progress.etaSeconds = 65;
  assert.match(progressView(job, String).size, /Yaklaşık/);
  assert.equal(progressView(job, String).remaining, 'Yaklaşık 1 dk 5 sn kaldı');
  job.progress.phase = 'verifying';
  assert.equal(progressView(job, String).remaining, null);
  assert.equal(progressView(job, String).stage, 'Dosya doğrulanıyor');
  assert.equal(durationText(3660), '1 sa 1 dk');
});

function fixture(t, options = {}) {
  const root = path.join((process.env.LOCALAPPDATA + '/Temp/opencode'), `hypernab-progress-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  for (const tool of ['yt-dlp', 'ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(root, `${tool}.exe`), 'fake');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, ...options });
  t.after(async () => { queue.stop(); for (let i = 0; queue.active.size && i < 300; i++) await wait(10); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue) { for (let i = 0; queue.active.size && i < 300; i++) await wait(10); assert.equal(queue.active.size, 0); }
test('standart motor gerçek stdout ayrıştırması: iki akış, postprocess, doğrulama ve bitiş', async t => {
  let queue;
  const info = { protocol: 'm3u8_native', requested_formats: [{ format_id: 'v', filesize: 80, vcodec: 'h264', acodec: 'none' }, { format_id: 'a', filesize: 20, vcodec: 'none', acodec: 'aac' }] };
  queue = fixture(t, { infoExtractor: async () => info,
    mediaVerifier: async () => { const p = queue.list()[0].progress; assert.equal(p.phase, 'verifying'); assert.equal(p.speed, 0); assert.equal(p.etaSeconds, null); return { audio: true, height: 720 }; },
    processSpawner: (_cmd, args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => {
        assert.ok(args.some(a => a.includes('info.format_id')));
        const emit = (formatId, downloaded_bytes, total_bytes) => child.stdout.write(`HYPERNAB_PROGRESS:${JSON.stringify({ formatId, progress: { downloaded_bytes, total_bytes } })}\n`);
        emit('v', 80, 80); emit('a', 5, 20);
        assert.equal(queue.list()[0].received, 85); assert.equal(queue.list()[0].total, 100);
        child.stdout.write('HYPERNAB_POSTPROCESS:{"status":"started","postprocessor":"Merger"}\n');
        assert.equal(queue.list()[0].progress.phase, 'merging'); assert.equal(queue.list()[0].status, 'running');
        const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
        fs.writeFileSync(output, 'native video'); child.stdout.end(`HYPERNAB_FILE:${JSON.stringify(output)}\n`);
        child.emit('close', 0);
      });
      return child;
    }
  });
  queue.add({ url: 'https://example.org/video', engine: 'extractor' }); await settled(queue);
  const job = queue.list()[0]; assert.equal(job.status, 'completed', job.error);
  assert.equal(job.progress.phase, 'completed'); assert.equal(job.progress.speed, 0); assert.equal(job.received, job.total);
});
test('tek bağlantılı dosya doğrulanırken aktarım bitmiş görünür ama iş tamamlanmaz', async t => {
  let queue;
  queue = fixture(t, { rangeRequest: async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) }),
    remoteOpener: async () => ({ response: Object.assign(Readable.from(['data']), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } }), url: new URL('https://example.org/a.mp4') }),
    mediaVerifier: async () => { const job = queue.list()[0]; assert.equal(job.status, 'running'); assert.equal(job.progress.phase, 'verifying'); assert.equal(job.progress.percent, 100); assert.equal(job.progress.etaSeconds, null); return { height: 360, audio: true }; }
  });
  queue.add({ url: 'https://example.org/a.mp4', engine: 'direct' }); await settled(queue);
  assert.equal(queue.list()[0].status, 'completed');
});
test('kuyruk kaydı yeniden yüklenince eski hız ve süre kullanılmaz', t => {
  const queue = fixture(t);
  fs.writeFileSync(queue.stateFile, JSON.stringify([{ id: randomUUID(), url: 'https://example.org/file', status: 'running', speed: 99999, total: 10000, received: 9000, transfer: { phase: 'downloading' } }]));
  const restored = new DownloadQueue({ directory: queue.directory, stateFile: queue.stateFile, toolsDirectory: queue.toolsDirectory });
  const job = restored.list()[0]; assert.equal(job.status, 'interrupted'); assert.equal(job.speed, 0); assert.equal(job.progress.etaSeconds, null); assert.equal(job.received, 9000);
});
