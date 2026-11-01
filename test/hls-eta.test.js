import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsTotalEstimate } from '../src/hls-size.js';
import { ProgressMeter } from '../src/job-progress.js';
import { DownloadQueue } from '../src/downloads.js';
import '../public/strings.js';
import { progressView } from '../public/progress-view.js';
globalThis.HypernabText.setLanguage('tr'); // these tests read the Turkish texts

test('HLS ana liste boyutu sesi zaten içerir, tekrar ses boyutu eklenmez', () => {
  const info = { nativeHls: true, duration: 80, requested_formats: [{ vcodec: 'h264', tbr: 1000 }, { vcodec: 'none', abr: 128 }] };
  assert.equal(hlsTotalEstimate({ offeredBytes: 10000000, info }), 10000000);
  assert.equal(hlsTotalEstimate({ info }), 10000000);
});
test('çıplak video + ayrı ses: ikisinin boyutu toplanır; eksik ses boyutunda kısmi toplam sunulmaz', () => {
  const info = { filesize_approx: 8000000 };
  assert.equal(hlsTotalEstimate({ savedBytes: 8000000, info, separateAudio: true }), null);
  const companion = { duration: 100, formats: [{ vcodec: 'none', abr: 128 }] };
  assert.equal(hlsTotalEstimate({ savedBytes: 8000000, info, separateAudio: true, companion }), 9600000);
  assert.equal(hlsTotalEstimate({ savedBytes: 8000000, offeredBytes: 9000000, info }), 9000000);
});
test('yt-dlp sayfa çözümlemesinden gelen ayrı HLS boyutları eksiksiz toplanır', () => {
  const info = { requested_formats: [{ filesize_approx: 1000 }, { filesize: 100 }] };
  assert.equal(hlsTotalEstimate({ info }), 1100);
  assert.equal(hlsTotalEstimate({ info: { requested_formats: [{ filesize_approx: 1000 }, {}] } }), null);
  for (const value of [NaN, Infinity, -100]) assert.equal(hlsTotalEstimate({ offeredBytes: value, savedBytes: value }), null);
});

test('ayrı sesin güvenilir boyut ölçümü duraklama/yeniden açılış için işte korunur', () => {
  const job = { url: 'https://example.org/v', audioUrl: 'https://example.org/a', estimateBytes: 8000000 };
  const offered = new Map([[job.audioUrl, { raw: { duration: 100, formats: [{ vcodec: 'none', abr: 128 }] } }]]);
  const queue = { offered, cachedSelection: () => null };
  assert.equal(DownloadQueue.prototype.hlsEstimate.call(queue, job, {}), 9600000);
  assert.equal(job.audioEstimateBytes, 1600000);
  offered.clear();
  const restored = JSON.parse(JSON.stringify(job));
  assert.equal(DownloadQueue.prototype.hlsEstimate.call(queue, restored, {}), 9600000);
});
test('HLS aktarımı yaklaşık toplamı korur; gerçek hız ısındıktan sonra ortak ETA üretir', () => {
  let now = 0; const meter = new ProgressMeter(() => now);
  const queue = { active: new Map(), meter: () => meter, measure: DownloadQueue.prototype.measure, observedTransfers: new WeakSet() };
  const job = { id: 'test', status: 'running', startedAt: new Date().toISOString() };
  const sample = received => DownloadQueue.prototype.updateTransfer.call(queue, job, { phase: 'downloading', received, total: 10000000, sizeKind: 'approx', speed: 0 }, 'hls');
  sample(0); assert.equal(meter.snapshot(job, 'downloading').etaSeconds, null);
  now = 1000; sample(1000000); now = 2000; sample(2000000);
  const p = meter.snapshot(job, 'downloading');
  assert.equal(p.sizeKind, 'approx'); assert.equal(p.total, 10000000); assert.equal(p.etaSeconds, 8);
  assert.equal(job.recovery.filter(item => item.event === 'transfer-observed').length, 1, 'first transfer is recorded once, not on every progress update');
  assert.match(progressView({ ...job, progress: p }, String).remaining, /Yaklaşık 8 sn/);
  now = 7000; assert.equal(meter.snapshot(job, 'downloading').speed, 0); assert.equal(meter.snapshot(job, 'downloading').etaSeconds, null);
  job.status = 'paused'; meter.stage('paused'); assert.equal(meter.snapshot(job, 'paused').etaSeconds, null);
  job.status = 'running'; meter.stage('downloading'); assert.equal(meter.snapshot(job, 'downloading').etaSeconds, null);
  meter.stage('merging'); assert.equal(meter.snapshot(job, 'merging').etaSeconds, null);
});
test('yaklaşık boyut aşılınca sahte yüzde 100 veya sıfır saniye gösterilmez', () => {
  const meter = new ProgressMeter(); const job = { status: 'running', total: 100, received: 120, sizeKind: 'approx' };
  const p = meter.snapshot(job, 'downloading');
  assert.equal(p.total, null); assert.equal(p.percent, null); assert.equal(p.etaSeconds, null); assert.equal(p.etaReason, 'estimate-exceeded');
  assert.match(progressView({ ...job, progress: p }, String).remaining, /tahmini aşıldı/);
});
