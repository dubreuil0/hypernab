import test from 'node:test';
import assert from 'node:assert/strict';
import { baseExtractorArgs, mediaHeaders, formatSelector, summarizeMedia, cleanMediaError } from '../src/media.js';

test('yt-dlp kurulu Node.js’i açıkça kullanır, uzaktan kod indirmeye izin vermez', () => {
  const args = baseExtractorArgs('C:/not-installed');
  assert.ok(args.includes(`node:${process.execPath}`));
  assert.ok(args.includes('--no-remote-components'));
  assert.equal(args[args.indexOf('--encoding') + 1], 'utf-8');
  assert.equal(formatSelector('best', true), 'bv*+ba/b');
  assert.equal(formatSelector('720', true), 'bv*[height<=720]+ba/b[height<=720]');
  assert.equal(formatSelector('best', false), 'b');
});
test('yalnızca User-Agent ve sorgusuz Referer aktarılır, çerez ve başlık enjeksiyonu alınmaz', () => {
  const headers = mediaHeaders({ userAgent: 'Firefox/158', referer: 'https://example.com/watch?token=secret#hash', Cookie: 'secret', Authorization: 'secret' });
  assert.deepEqual(headers, { 'User-Agent': 'Firefox/158', Referer: 'https://example.com/watch' });
  assert.deepEqual(mediaHeaders({ userAgent: 'x\r\nCookie: secret' }), {});
  assert.deepEqual(mediaHeaders({ referer: 'file:///C:/secret' }), {}, 'kullanılamayan sayfa adresi Referer olarak gönderilmez');
});
test('önizleme doğrulanmış ad, süre, mevcut çözünürlükler ve bilinen boyutu döndürür', () => {
  const info = summarizeMedia({ title: 'Bir video', ext: 'mp4', duration: 90, formats: [
    { vcodec: 'avc1', height: 720 }, { vcodec: 'avc1', height: 720 }, { vcodec: 'vp9', height: 1080 },
    { vcodec: 'avc1', height: 2160, has_drm: true }, { vcodec: 'none' }
  ], requested_formats: [{ filesize: 100 }, { filesize: 20 }] });
  assert.equal(info.title, 'Bir video');
  assert.equal(info.duration, 90);
  assert.deepEqual(info.heights, [1080, 720]);
  assert.equal(info.filesize, 120);
  assert.equal(info.estimatedSize, true);
});
test('bilinmeyen metadata uydurulmaz ve imzalı kaynaklar önizlemeye sızmaz', () => {
  const info = summarizeMedia({ title: 'Video', url: 'https://example.com/?token=secret', formats: [] });
  assert.equal(info.filesize, null); assert.equal(info.duration, null);
  assert.equal(info.url, undefined); assert.deepEqual(info.heights, []);
  assert.throws(() => summarizeMedia({ _type: 'playlist', entries: [] }), /oynatma listesi/);
});
test('hata mesajında gereksiz uyarılar ve hassas URL yerine esas hata gösterilir', () => {
  const message = cleanMediaError('WARNING: uzun uyarı\nERROR: HTTP Error 403: https://example.com/?token=secret');
  assert.doesNotMatch(message, /secret|WARNING/);
  assert.match(message, /403/);
});
test('Cloudflare, DRM ve desteklenmeyen sayfa ayrılır; aşma komutu veya hassas URL gösterilmez', () => {
  const cloudflare = cleanMediaError('ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge; try --extractor-args generic:impersonate https://example.org/?secret=x');
  assert.match(cloudflare, /Cloudflare/); assert.match(cloudflare, /eklenti/); assert.doesNotMatch(cloudflare, /impersonate|secret|--extractor/);
  assert.equal(cleanMediaError(cloudflare), cloudflare);
  assert.match(cleanMediaError('ERROR: This video is DRM protected'), /DRM korumalı/);
  assert.match(cleanMediaError('ERROR: Unsupported URL: https://example.org/?secret=x'), /desteklenmiyor/);
});
