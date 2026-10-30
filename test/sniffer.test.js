import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRequest, pickCandidates, findBrowser } from '../src/sniffer.js';
import { DownloadQueue } from '../src/downloads.js';
import { cleanMediaError, SESSION_REQUIRED } from '../src/media.js';

test('istek sınıflandırma: manifest, dosya; parça/görsel/hata elenir', () => {
  assert.equal(classifyRequest({ url: 'https://cdn.example/a/master.m3u8?t=1', mime: 'application/vnd.apple.mpegurl' }).rank, 0);
  assert.equal(classifyRequest({ url: 'https://cdn.example/a/index-f1.m3u8', mime: 'text/plain' }).rank, 1);
  assert.equal(classifyRequest({ url: 'https://cdn.example/v/manifest.mpd', mime: 'application/dash+xml' }).kind, 'manifest');
  assert.equal(classifyRequest({ url: 'https://cdn.example/v.mp4', mime: 'video/mp4', size: 9000000 }).kind, 'file');
  assert.equal(classifyRequest({ url: 'https://cdn.example/ad.mp4', mime: 'video/mp4', size: 5000 }), null, 'küçük reklam/izleme dosyası');
  assert.equal(classifyRequest({ url: 'https://cdn.example/seg1.ts', mime: 'video/mp2t', size: 900000 }), null);
  assert.equal(classifyRequest({ url: 'https://cdn.example/s.m4s', mime: 'video/iso.segment', size: 900000 }), null);
  assert.equal(classifyRequest({ url: 'https://cdn.example/p.jpg', mime: 'image/jpeg' }), null);
  assert.equal(classifyRequest({ url: 'https://cdn.example/master.m3u8', mime: 'x', status: 403 }), null);
  assert.equal(classifyRequest({ url: 'blob:https://x/abc', mime: 'video/mp4', size: 9e6 }), null);
});

test('adaylar: master liste önce, sonra alt listeler, sonra büyük dosya; yinelenen elenir', () => {
  const list = pickCandidates([
    { url: 'b', rank: 2, size: 50, order: 0 }, { url: 'c', rank: 1, order: 1 }, { url: 'a', rank: 0, order: 2 }, { url: 'a', rank: 0, order: 3 }, { url: 'd', rank: 2, size: 900, order: 4 }
  ]);
  assert.deepEqual(list.map(c => c.url), ['a', 'c', 'd', 'b']);
});

test('tarayıcı bulucu ortam yollarından çalışır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-browser-'));
  try {
    assert.equal(findBrowser({ PROGRAMFILES: dir }), null);
    fs.mkdirSync(path.join(dir, 'Microsoft/Edge/Application'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Microsoft/Edge/Application/msedge.exe'), '');
    assert.equal(findBrowser({ PROGRAMFILES: dir }), path.join(dir, 'Microsoft/Edge/Application/msedge.exe'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function queueWith(t, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-sniff-test-'));
  fs.mkdirSync(path.join(root, 'tools')); fs.writeFileSync(path.join(root, 'tools', 'yt-dlp.exe'), '');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools'), ...extra });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
const PAGE = 'https://example.org/film/bolum-7/';

test('yalnızca takipçilere/üyelere açık video: anlaşılır "oturum gerekli" mesajı, boşuna tarayıcı açılmaz', async t => {
  let sniffed = 0;
  const queue = queueWith(t, {
    mediaInspector: async () => { throw new Error(cleanMediaError('ERROR: [site] -1_2: Video only available to followers')); },
    pageSniffer: async () => { sniffed++; return { candidates: [] }; }
  });
  await assert.rejects(queue.inspect({ url: 'https://video.example.org/video-1_2', engine: 'extractor' }), error => error.message === SESSION_REQUIRED);
  assert.equal(sniffed, 0, 'oturumu olmayan uygulama tarayıcısı denenmez');
  for (const raw of ['ERROR: [site] x: Private video. Sign in if you\'ve been granted access', 'ERROR: [site] login required', 'ERROR: x: This video is only available for registered users'])
    assert.equal(cleanMediaError(raw), SESSION_REQUIRED, raw);
  assert.notEqual(cleanMediaError('ERROR: [generic] Unsupported URL: x'), SESSION_REQUIRED);
});

test('çözümleyici sayfayı bulamazsa tarayıcıyla yakalanan kaynak incelenir ve indirme bilgisi döner', async t => {
  const calls = [];
  const sniffs = [];
  const queue = queueWith(t, { pageSniffer: async (url, options) => { sniffs.push(options.headless); return options.headless ? { candidates: [], challenge: true } : { candidates: [{ url: 'https://cdn.example.net/hls/master.m3u8?t=1', referer: 'https://example.org/', kind: 'manifest', rank: 0 }], pageTitle: 'Bölüm 7 izle | Site', userAgent: 'UA/1' }; } });
  // The page itself fails in the real extractor (the stub yt-dlp.exe is empty); the captured manifest is stubbed.
  const original = queue.inspect.bind(queue);
  queue.inspect = async (input, signal, fromBrowser) => {
    if (!fromBrowser) return original(input, signal);
    calls.push(input);
    return { title: input.title, options: [], defaultOptionId: null, engine: 'extractor' };
  };
  const info = await queue.inspect({ url: PAGE, engine: 'extractor' });
  assert.deepEqual(sniffs, [true, false], 'önce hızlı mod, engel varsa pencereli mod');
  assert.equal(info.via, 'browser');
  assert.deepEqual(info.resolved, { url: 'https://cdn.example.net/hls/master.m3u8?t=1', referer: 'https://example.org/', userAgent: 'UA/1', pageUrl: PAGE });
  assert.equal(calls[0].url, 'https://cdn.example.net/hls/master.m3u8?t=1');
  assert.equal(calls[0].referer, 'https://example.org/');
  assert.equal(info.title, 'Bölüm 7 izle');
});

test('otomatik inceleme (noBrowser) çözümleyici başarısız olunca tarayıcı açmaz; elle yapılan açabilir', async t => {
  let sniffed = 0;
  const queue = queueWith(t, { pageSniffer: async () => { sniffed++; return { candidates: [], challenge: false }; } });
  await assert.rejects(queue.inspect({ url: PAGE, engine: 'extractor', noBrowser: true }));
  assert.equal(sniffed, 0, 'otomatik denemede tarayıcı açılmamalı');
  await assert.rejects(queue.inspect({ url: PAGE, engine: 'extractor' }), /tarayıcıda açıldı|Cloudflare|DRM/);
  assert.ok(sniffed >= 1, 'kullanıcı basınca tarayıcı yedeği çalışabilir');
});

test('hiç aday yoksa Cloudflare engeli açık hata olarak bildirilir', async t => {
  const queue = queueWith(t, { pageSniffer: async () => ({ candidates: [], challenge: true }) });
  await assert.rejects(queue.inspectViaBrowser({ url: PAGE }, PAGE, new Error('x'), AbortSignal.timeout(5000)), /Cloudflare/);
});

test('hiç aday yoksa ve engel de yoksa özgün hata ile açıklama verilir', async t => {
  const queue = queueWith(t, { pageSniffer: async () => ({ candidates: [], challenge: false }) });
  await assert.rejects(queue.inspectViaBrowser({ url: PAGE }, PAGE, new Error('Çözümleyici video bulamadı.'), AbortSignal.timeout(5000)), /Çözümleyici video bulamadı\..*DRM/);
});
