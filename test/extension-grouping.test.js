import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
const { groupEntries } = context.Hypernab;
const hls = (url, extra = {}) => ({ url, kind: 'HLS', frameId: 7, size: null, ...extra });
const file = (url, size, extra = {}) => ({ url, kind: 'VIDEO', frameId: 0, size, ...extra });
// The extension code runs in a vm context: copy into this realm's Array before deepEqual.
const urls = groups => Array.from(groups, g => g.primary.url.replace(/\?.*/, '').split('/').pop());

test('master liste ve alt listeleri tek kart olur, master esas alınır', () => {
  const groups = groupEntries([
    hls('https://s1.cdn.example/hls/01/ab,l,n,.urlset/index-f2-v1-a1.m3u8?t=1'),
    hls('https://s1.cdn.example/hls/01/ab,l,n,.urlset/index-f1-v1-a1.m3u8?t=1'),
    hls('https://s1.cdn.example/hls/01/ab,l,n,.urlset/master.m3u8?t=1')
  ]);
  assert.equal(groups.length, 1); assert.deepEqual(urls(groups), ['master.m3u8']); assert.equal(groups[0].variantCount, 2);
});

test('HLS’yi kendisi oynatan tarayıcıda (Chrome) "playlist" adlı kalite alt listeleri master sanılmaz', () => {
  const base = 'https://storage.example/angel-one-hls/';
  const groups = groupEntries([
    hls(base + 'playlist_v-0576p-1400k-libx264.mp4.m3u8', { detectedAt: 3 }),
    hls(base + 'playlist_a-eng-0128k-aac-2c.mp4.m3u8', { detectedAt: 2 }),
    hls(base + 'hls.m3u8', { detectedAt: 1 })
  ]);
  assert.equal(groups.length, 1); assert.deepEqual(urls(groups), ['hls.m3u8']);
});

test('master yoksa alt liste olmayan, o da yoksa en yeni kayıt esas alınır', () => {
  assert.deepEqual(urls(groupEntries([hls('https://c.example/a/index-f1-v1-a1.m3u8'), hls('https://c.example/a/stream.m3u8')])), ['stream.m3u8']);
  assert.deepEqual(urls(groupEntries([hls('https://c.example/a/index-f2-v1-a1.m3u8'), hls('https://c.example/a/index-f1-v1-a1.m3u8')])), ['index-f2-v1-a1.m3u8']);
});

test('yalnızca kanıt varsa birleşir: farklı iframe, alan adı veya klasör ayrı kart kalır', () => {
  const groups = groupEntries([
    hls('https://c.example/ep7/master.m3u8', { frameId: 7 }),
    hls('https://c.example/ep7/master.m3u8?x=1', { frameId: 9 }),   // another player frame
    hls('https://other.example/ep7/master.m3u8', { frameId: 7 }),   // another host
    hls('https://c.example/ad/master.m3u8', { frameId: 7 })          // another folder (e.g. an advert)
  ]);
  assert.equal(groups.length, 4);
});

test('manifest ile düz dosya aynı klasörde bile birleşmez', () => {
  const groups = groupEntries([hls('https://c.example/v/master.m3u8', { frameId: 0 }), file('https://c.example/v/video.mp4', 9e6)]);
  assert.equal(groups.length, 2);
});

test('aynı klasördeki ayrı video dosyaları tek karttır; en büyüğü varsayılan, hepsi listelenir', () => {
  const groups = groupEntries([file('https://c.example/v/e7_360.mp4', 30e6), file('https://c.example/v/e7_1080.mp4', 300e6), file('https://c.example/v/e7_720.mp4', 120e6)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary.size, 300e6); assert.equal(groups[0].files.length, 3);
});

test('geçersiz adres atlanır, boş girdi boş döner', () => {
  assert.equal(groupEntries([{ url: 'blob:https://x/1', kind: 'HLS' }, { url: 'javascript:1', kind: 'VIDEO' }]).length, 0);
  assert.equal(groupEntries(undefined).length, 0);
});
