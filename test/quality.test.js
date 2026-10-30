import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildQualityOptions, isFormatId, mergedExtension, codecFamily } from '../src/quality.js';
import { DownloadQueue } from '../src/downloads.js';
import { summarizeMedia } from '../src/media.js';

const video = (format_id, height, vcodec, ext, extra = {}) => ({ format_id, height, vcodec, acodec: 'none', ext, protocol: 'https', ...extra });
const audio = (format_id, acodec, ext, extra = {}) => ({ format_id, vcodec: 'none', acodec, ext, protocol: 'https', abr: 128, ...extra });
const combined = (format_id, height, ext = 'mp4', extra = {}) => ({ format_id, height, vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', ext, protocol: 'https', ...extra });

function adaptiveLike() {
  return {
    duration: 100,
    formats: [
      { format_id: 'sb0', protocol: 'mhtml', ext: 'mhtml', vcodec: 'none', acodec: 'none', height: 90 },
      audio('140', 'mp4a.40.2', 'm4a', { filesize: 1600000 }), audio('251', 'opus', 'webm', { abr: 130, filesize: 1700000 }),
      combined('18', 360, 'mp4', { filesize_approx: 9000000 }),
      video('134', 360, 'avc1.4d401e', 'mp4', { filesize: 5000000 }),
      video('137', 1080, 'avc1.640028', 'mp4', { filesize: 90000000, vbr: 4000 }),
      video('248', 1080, 'vp09.00.40.08', 'webm', { filesize: 60000000, vbr: 2500 }),
      video('399', 1080, 'av01.0.08M.08', 'mp4', { filesize_approx: 40000000, vbr: 1800 }),
      video('299', 1080, 'avc1.64002a', 'mp4', { fps: 60, filesize: 140000000, vbr: 6000 }),
      video('400', 1440, 'av01.0.12M.08', 'mp4', { filesize_approx: 90000000, vbr: 4000 }),
      video('313', 2160, 'vp09.00.50.08', 'webm', { filesize: 300000000, vbr: 9000 })
    ]
  };
}

test('seçenekler yalnızca gerçekten sunulan formatlardan, yüksekten düşüğe sıralı üretilir', () => {
  const { options, defaultOptionId } = buildQualityOptions(adaptiveLike(), { ffmpeg: true });
  assert.equal(defaultOptionId, options[0].id);
  assert.deepEqual(options.map(o => o.height), [2160, 1440, 1080, 1080, 1080, 1080, 360]);
  assert.equal(options[0].id, '313+251');
  assert.ok(!options.some(o => o.height === 720 || o.height === 480), 'olmayan çözünürlük uydurulmamalı');
  assert.ok(!options.some(o => o.id.startsWith('sb')), 'storyboard seçenek olmamalı');
});

test('aynı çözünürlükte eşitlik kuralı: yüksek FPS, sonra kapsayıcı (MP4 önce), sonra codec uyumluluğu; kodekler bit hızıyla karşılaştırılmaz', () => {
  const { options } = buildQualityOptions(adaptiveLike(), { ffmpeg: true });
  const at1080 = options.filter(o => o.height === 1080);
  assert.deepEqual(at1080.map(o => o.label), ['1080p60 · MP4 · H.264', '1080p · MP4 · H.264', '1080p · MP4 · AV1', '1080p · WEBM · VP9']);
  // H.264 mp4 video gets the m4a audio, VP9 webm gets the webm audio: no accidental Matroska.
  assert.deepEqual(at1080.map(o => o.id), ['299+140', '137+140', '399+140', '248+251']);
  // One recommended entry per picture size: the first (MP4) one; others stay selectable as "other formats".
  assert.deepEqual(at1080.map(o => o.recommended), [true, true, false, false]);
});

test('ayrı akışlı seçenek ses birleştirilecek diye işaretlenir; boyut toplamdır ve kesin sayılmaz', () => {
  const { options } = buildQualityOptions(adaptiveLike(), { ffmpeg: true });
  const h264 = options.find(o => o.id === '137+140');
  assert.equal(h264.audio, 'merged'); assert.equal(h264.filesize, 90000000 + 1600000); assert.equal(h264.sizeKind, 'approx');
  const low = options.find(o => o.height === 360);
  // 360p: the separate video+audio pair and progressive "18" share a key; the better-bitrate rule picks one, labelled honestly.
  assert.ok(['18', '134+140'].includes(low.id));
});

test('yalnızca 360p/720p sunan kaynakta sadece bu seçenekler çıkar ve 720p seçili gelir', () => {
  const info = { duration: 60, formats: [combined('url360', 360, 'mp4', { filesize: 4000000 }), combined('url720', 720, 'mp4', { filesize: 11000000 })] };
  const { options, defaultOptionId } = buildQualityOptions(info, { ffmpeg: false });
  assert.deepEqual(options.map(o => o.height), [720, 360]);
  assert.equal(defaultOptionId, 'url720');
  assert.deepEqual(options.map(o => [o.audio, o.sizeKind]), [['included', 'exact'], ['included', 'exact']]);
});

test('FFmpeg yoksa ayrı akışlı seçenekler sunulmaz; yalnızca doğrudan indirilebilirler kalır', () => {
  const { options } = buildQualityOptions(adaptiveLike(), { ffmpeg: false });
  assert.deepEqual(options.map(o => o.id), ['18']);
});
test('gerçek HLS alternate-audio düzeninde codec adı verilmemesi kalite listesini boşaltmaz', () => {
  const info = { duration: 60, formats: [
    { format_id: 'default-audio-group-stream_4', vcodec: 'none', ext: 'mp4', protocol: 'm3u8_native' },
    video('482', 144, 'avc1.42c01e', 'mp4', { protocol: 'm3u8_native' }),
    video('1824', 576, 'avc1.4d401f', 'mp4', { protocol: 'm3u8_native' })
  ] };
  const result = buildQualityOptions(info, { ffmpeg: true });
  assert.deepEqual(result.options.map(o => o.height), [576, 144]);
  assert.equal(result.options[0].id, '1824+default-audio-group-stream_4');
  assert.equal(result.options[0].audio, 'merged');
  assert.deepEqual(buildQualityOptions(info, { ffmpeg: false }).options, []);
});

test('aynı kalitenin yinelenen kaynaklarında HTTP dosyası parçalı yayına tercih edilir', () => {
  const info = { duration: 30, formats: [
    combined('hls-2085', 720, 'mp4', { protocol: 'm3u8_native', tbr: 2085 }),
    video('dash_sep-5', 720, 'avc1.64001F', 'mp4', { tbr: 1700 }), audio('dash_sep-6', 'mp4a.40.2', 'm4a'),
    combined('url720', 720, 'mp4', { tbr: 1800 })
  ] };
  const { options } = buildQualityOptions(info, { ffmpeg: true });
  assert.equal(options.length, 1); assert.equal(options[0].id, 'url720');
});

test('gerçek dünya düzeni: codec bilgisi olmayan tek dosya kaynaklar yutulmaz, gereksiz kopya da göstermez', () => {
  const plain = (format_id, height, protocol = 'https', tbr) => ({ format_id, height, protocol, ext: 'mp4', tbr });
  const info = { duration: 300, formats: [
    plain('hls-2085', 720, 'm3u8_native', 2085), { ...video('hls_fmp4-1957', 720, 'avc1.64001F', 'mp4', { protocol: 'm3u8_native', vbr: 1957 }) },
    video('dash_sep-5', 720, 'avc1.64001F', 'mp4', { vbr: 2534, tbr: 2534 }), video('dash_sep-1', 144, 'avc1.4d400c', 'mp4', { vbr: 215, tbr: 215 }),
    audio('dash_sep-10', 'mp4a.40.2', 'm4a', { abr: 128 }), plain('url720', 720), plain('url144', 144)
  ] };
  const { options } = buildQualityOptions(info, { ffmpeg: true });
  assert.deepEqual(options.map(o => o.id), ['dash_sep-5+dash_sep-10', 'dash_sep-1+dash_sep-10']);
  // Without FFmpeg the plain single-file sources are the only choice left, and they must still be offered.
  const noFfmpeg = buildQualityOptions(info, { ffmpeg: false }).options;
  assert.deepEqual(noFfmpeg.map(o => [o.id, o.label, o.audio]), [['url720', '720p · MP4', 'included'], ['url144', '144p · MP4', 'included']]);
});

test('parçalı HLS seçenekleri yalnızca aynı boyutta doğrudan dosya yoksa gösterilir', () => {
  const hls = (id, height, vcodec) => ({ format_id: id, height, vcodec, acodec: 'mp4a.40.2', ext: 'mp4', protocol: 'm3u8_native', tbr: 2500 });
  const mixed = { duration: 50, formats: [audio('140', 'mp4a.40.2', 'm4a'), video('137', 1080, 'avc1.640028', 'mp4'), hls('614', 1080, 'vp09.00.40.08'), hls('603', 144, 'vp09.00.10.08')] };
  const labelsMixed = buildQualityOptions(mixed, { ffmpeg: true }).options.map(o => [o.id, o.height]);
  assert.deepEqual(labelsMixed, [['137+140', 1080], ['603', 144]], '1080p için doğrudan dosya var, 144p için yalnızca HLS var');
  const hlsOnly = buildQualityOptions({ duration: 5, formats: [hls('a', 720, 'avc1.1'), hls('b', 360, 'avc1.1')] }, { ffmpeg: false }).options;
  assert.deepEqual(hlsOnly.map(o => o.id), ['a', 'b']);
});

test('HDR aynı çözünürlükte SDR’nin üstünde ve ayrı seçenek olarak etiketlenir', () => {
  const info = { duration: 10, formats: [audio('a', 'mp4a.40.2', 'm4a'), video('sdr', 2160, 'vp09.00.50.08', 'webm', { dynamic_range: 'SDR' }), video('hdr', 2160, 'vp09.02.50.10', 'webm', { dynamic_range: 'HDR10' })] };
  const { options } = buildQualityOptions(info, { ffmpeg: true });
  assert.deepEqual(options.map(o => o.label), ['2160p HDR · MKV · VP9', '2160p · MKV · VP9']);
});

test('boyut: kesin / yaklaşık / bit hızından yaklaşık / bilinmiyor ayrılır', () => {
  const info = { duration: 80, formats: [
    combined('exact', 1080, 'mp4', { filesize: 1000 }), combined('approx', 720, 'mp4', { filesize_approx: 2000 }),
    combined('rate', 480, 'mp4', { tbr: 800 }), combined('none', 240, 'mp4', {})
  ] };
  const by = Object.fromEntries(buildQualityOptions(info).options.map(o => [o.id, o]));
  assert.deepEqual([by.exact.filesize, by.exact.sizeKind], [1000, 'exact']);
  assert.deepEqual([by.approx.filesize, by.approx.sizeKind], [2000, 'approx']);
  assert.deepEqual([by.rate.filesize, by.rate.sizeKind], [8_000_000, 'approx']);
  assert.deepEqual([by.none.filesize, by.none.sizeKind], [null, 'unknown']);
});

test('DRM, geçersiz kimlik, canlı yayın ve oynatma listesi seçenek üretmez', () => {
  const formats = [combined('ok', 480), { ...combined('drm', 1080), has_drm: true }, combined('bad id;rm', 720), combined('--exec', 720)];
  assert.deepEqual(buildQualityOptions({ formats }, { ffmpeg: true }).options.map(o => o.id), ['ok'], 'tireyle başlayan kimlik komut satırı seçeneği sayılabilir; sunulmaz');
  assert.deepEqual(buildQualityOptions({ is_live: true, formats }).options, []);
  assert.deepEqual(buildQualityOptions({ entries: [], formats }).options, []);
  assert.deepEqual(buildQualityOptions(null).options, []);
});

test('format kimliği tek doğrulanmış simgedir: serbest yt-dlp ifadesi kabul edilmez', () => {
  for (const good of ['137', '137+140', 'url720', 'hls-2085', 'dash_sep-5+dash_sep-6', 'hls_fmp4-1957']) assert.equal(isFormatId(good), true, good);
  for (const bad of ['', '137+140+251', 'bv*+ba', 'best[height<=720]', '137 140', '$(calc)', '--exec x', '--exec', '-f', '137+-exec', 'a;b', 'x'.repeat(101), '137/18', null, 5]) assert.equal(isFormatId(bad), false, String(bad));
});

test('yardımcılar: birleştirme uzantısı ve codec ailesi', () => {
  assert.equal(mergedExtension('mp4', 'm4a'), 'mp4'); assert.equal(mergedExtension('webm', 'opus'), 'webm'); assert.equal(mergedExtension('webm', 'm4a'), 'mkv');
  assert.equal(codecFamily('avc1.64001F').name, 'H.264'); assert.equal(codecFamily('vp09.00.40.08').name, 'VP9'); assert.equal(codecFamily('av01.0.08M.08').name, 'AV1');
});

test('inceleme özeti eski alanları korur', () => {
  assert.deepEqual(summarizeMedia({ title: 'Ad', formats: [combined('a', 720)] }).heights, [720]);
});

function queueFixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-quality-test-'));
  fs.mkdirSync(path.join(root, 'tools')); fs.writeFileSync(path.join(root, 'tools', 'yt-dlp.exe'), '');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools'), ...extra });
  t.after(async () => { queue.stop(); for (let i = 0; i < 100 && queue.active.size; i++) await new Promise(r => setTimeout(r, 10)); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
const URL_A = 'https://example.org/watch?v=1';

test('sunucu yalnızca son incelemede sunduğu format kimliğini kabul eder', t => {
  const queue = queueFixture(t); queue.run = () => new Promise(() => {});
  assert.throws(() => queue.add({ url: URL_A, engine: 'extractor', formatId: '137+140' }), /sunulmadı/);
  queue.rememberOffered(URL_A, [{ id: '137+140', label: '1080p · MP4 · H.264' }]);
  assert.throws(() => queue.add({ url: URL_A, engine: 'extractor', formatId: '399+140' }), /sunulmadı/);
  assert.throws(() => queue.add({ url: 'https://example.org/watch?v=2', engine: 'extractor', formatId: '137+140' }), /sunulmadı/);
  assert.throws(() => queue.add({ url: URL_A, engine: 'extractor', formatId: 'best[height<=720]' }), /Geçersiz format/);
  assert.throws(() => queue.add({ url: URL_A, engine: 'direct', formatId: '137+140' }), /yalnızca akış/);
  const id = queue.add({ url: URL_A, engine: 'extractor', formatId: '137+140' });
  const listed = queue.list().find(j => j.id === id);
  assert.equal(listed.formatId, '137+140'); assert.equal(listed.formatLabel, '1080p · MP4 · H.264'); assert.equal(listed.url, undefined);
  assert.equal(queue.add({ url: URL_A, engine: 'extractor' }) !== id, true, 'kalite seçmeden de eklenebilir (eski davranış)');
});

test('seçilen format kimliği çözümleyiciye aynen iletilir ve plan tarafından doğrulanır', async t => {
  let received = null;
  const queue = queueFixture(t, { infoExtractor: async input => { received = input; return { title: 'T', format_id: 'url360', protocol: 'https', ext: 'mp4', url: 'https://cdn.example.org/a.mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', duration: 10 }; } });
  queue.transferSources = async () => {}; queue.mediaVerifier = async () => ({});
  queue.rememberOffered(URL_A, [{ id: 'url360', label: '360p · MP4 · H.264' }]);
  const id = queue.add({ url: URL_A, engine: 'extractor', formatId: 'url360', quality: '720' });
  for (let i = 0; i < 100 && queue.active.size; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.formatId, 'url360', 'bu 360p, 720p üst sınırına çevrilmemeli');
  assert.equal(queue.jobs.find(j => j.id === id).sourceSelection.format, 'url360');
});

test('seçilen kalite kaynaktan kalkmışsa başka kaliteye geçilmez; açık hata verilir', async t => {
  let calls = 0;
  const queue = queueFixture(t, { infoExtractor: async () => { calls++; throw new Error('Uygun indirilebilir format bulunamadı. Ayrıntı: ERROR: Requested format is not available'); } });
  queue.rememberOffered(URL_A, [{ id: '137+140', label: '1080p · MP4 · H.264' }]);
  const id = queue.add({ url: URL_A, engine: 'extractor', formatId: '137+140' });
  for (let i = 0; i < 100 && queue.active.size; i++) await new Promise(r => setTimeout(r, 10));
  const job = queue.jobs.find(j => j.id === id);
  assert.equal(job.status, 'failed'); assert.equal(calls, 1, 'sessiz yeniden deneme veya başka formata düşme olmamalı');
  assert.match(job.error, /1080p · MP4 · H\.264.*kaynakta artık yok/);
  assert.match(job.error, /otomatik geçilmedi/);
});
