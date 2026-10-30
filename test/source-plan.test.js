import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSourcePlan, safeExtension, sourceHeaders, selectedFormat } from '../src/source-plan.js';

const tools = { ffmpeg: true, ffprobe: true };
const video = (host = 'media.example.org') => ({ url: `https://${host}/movie.mp4?signature=secret`, protocol: 'https', ext: 'mp4', format_id: '720', vcodec: 'avc1', acodec: 'aac' });
test('tek dosya kararı site adından bağımsızdır', () => {
  for (const host of ['media.example.com', 'cdn.example.org', 'another.example.net', 'www.w3schools.com']) {
    assert.equal(selectSourcePlan(video(host), tools).method, 'parallel-http');
  }
  assert.equal(selectSourcePlan({ ...video(), url: 'https://example.org/video.mp4?signature=.mpd' }, tools).method, 'parallel-http');
});
test('ayrı HTTP görüntü ve ses tek işin iki aktarımı olarak seçilir', () => {
  const source = { requested_formats: [{ ...video(), acodec: 'none' }, { url: 'https://audio.example.org/audio.m4a', protocol: 'https', ext: 'm4a', format_id: 'audio', vcodec: 'none', acodec: 'aac' }] };
  const plan = selectSourcePlan(source, tools);
  assert.equal(plan.method, 'parallel-streams'); assert.equal(plan.extension, 'mp4'); assert.equal(plan.selectedFormat, '720+audio');
  assert.equal(selectSourcePlan(source, { ffmpeg: false, ffprobe: true }).method, 'yt-dlp');
});
test('uyumsuz kapsayıcılar yeniden kodlamak yerine MKV olarak birleştirilir', () => {
  const plan = selectSourcePlan({ requested_formats: [{ ...video(), acodec: 'none' }, { ...video('audio.example.org'), format_id: 'opus', ext: 'opus', vcodec: 'none', acodec: 'opus' }] }, tools);
  assert.equal(plan.extension, 'mkv');
});
test('HLS/DASH ve fragment listeleri byte-range dosyası sayılmaz', () => {
  for (const source of [{ ...video(), protocol: 'm3u8_native' }, { ...video(), protocol: 'http_dash_segments' }, { ...video(), fragments: [{ url: 'part.ts' }] }, { ...video(), url: 'https://example.org/manifest.mpd' }]) {
    assert.equal(selectSourcePlan(source, tools).method, 'yt-dlp');
  }
});
test('DRM ve özel ağ URL’si sessiz fallback ile geçiştirilmez', () => {
  assert.throws(() => selectSourcePlan({ ...video(), has_drm: true }, tools), /DRM/);
  assert.throws(() => selectSourcePlan({ ...video(), url: 'http://127.0.0.1/secret' }, tools), /güvenli/);
});
test('standart motor seçilen formatı korur; keyfi format ifadesi kabul edilmez', () => {
  assert.equal(selectedFormat({ ...video(), format_id: 'hls-720' }), 'hls-720');
  assert.equal(selectedFormat({ ...video(), format_id: 'best[height>0]' }), null);
  assert.equal(selectSourcePlan({ ...video(), protocol: 'm3u8_native' }, tools).selectedFormat, '720');
});
test('header aktarımı yalnızca gerekli bilgileri alır; çerez ve Range aktarılmaz', () => {
  const headers = sourceHeaders({ http_headers: { 'user-agent': 'SourceAgent', Cookie: 'secret', Range: 'bytes=5-6' } }, { http_headers: { Referer: 'https://example.org/watch?token=secret' } });
  assert.deepEqual(headers, { 'User-Agent': 'SourceAgent', Referer: 'https://example.org/watch' });
});
test('normal dosya uzantıları korunur, tehlikeli adlar çalıştırılabilir yapılmaz', () => {
  assert.equal(safeExtension('https://example.org/report.pdf'), 'pdf');
  assert.equal(safeExtension('https://example.org/a.exe'), 'bin');
  assert.equal(safeExtension('https://example.org/opaque', 'video/mp4; charset=binary'), 'mp4');
});
