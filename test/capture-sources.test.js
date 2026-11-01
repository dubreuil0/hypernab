import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8'), context); vm.runInContext("HypernabText.setLanguage('tr')", context); // these tests read the Turkish texts
vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
const H = context.Hypernab;
const MB = 1048576;
const plain = value => JSON.parse(JSON.stringify(value));

test('MP4 dışındaki tam video ve ses dosyaları yakalanır; altyazı ve CMAF parçası yakalanmaz', () => {
  for (const [url, type, size, expected] of [
    ['https://x.example/a.flv', '', 0, 'OTHER'], ['https://x.example/a.avi', '', 0, 'OTHER'], ['https://x.example/a.wmv', '', 0, 'OTHER'],
    ['https://x.example/a.3gp', '', 0, 'OTHER'], ['https://x.example/a.mpg', '', 0, 'OTHER'], ['https://x.example/opaque', 'video/x-flv', 0, 'OTHER'],
    ['https://x.example/a.webm', '', 0, 'VIDEO'], ['https://x.example/a.mkv', '', 0, 'VIDEO'],
    ['https://x.example/song.mp3', '', 3 * MB, 'AUDIO'], ['https://x.example/opaque', 'audio/ogg', 2 * MB, 'AUDIO'],
    ['https://x.example/click.mp3', '', 20000, null], ['https://x.example/seg-1.aac', 'audio/aac', 150000, null],
    ['https://x.example/sub.vtt', 'text/vtt', 0, null], ['https://x.example/sub.srt', '', 0, null], ['https://x.example/s1.m4s', 'video/mp4', 0, null],
    ['https://x.example/s1.ts', 'video/mp2t', 0, null], ['https://x.example/s1.ts', 'video/mp2t', 2 * MB, null],
    ['https://x.example/full.ts', 'video/mp2t', 400 * MB, 'OTHER'], ['https://x.example/page', 'text/html', 0, null]
  ]) assert.equal(H.mediaKind(url, type, size), expected, `${url} ${type} ${size}`);
});

test('HLS akışı olan karede ts bir parçadır; akış yoksa büyük ts tam dosyadır', () => {
  const ts = { url: 'https://x.example/full.ts', kind: 'OTHER', frameId: 0, mime: 'video/mp2t', size: 400 * MB };
  assert.equal(H.segmentLike(ts, [ts, { url: 'https://x.example/a.m3u8', kind: 'HLS', frameId: 0 }]), true);
  assert.equal(H.segmentLike(ts, [ts]), false);
  assert.equal(H.segmentLike(ts, [ts, { url: 'https://x.example/a.m3u8', kind: 'HLS', frameId: 5 }]), false, 'başka karedeki akış etkilemez');
});

test('diğer tam dosyalar sıralı satır olur: MP4 üstte, ts/flv/ses altta; asıl kaynak ve aralık parçaları dışarıda', () => {
  const e = (url, kind, extra = {}) => ({ url, kind, frameId: 0, size: 1000, frameUrl: 'https://x.example/watch', ...extra });
  const entries = [
    e('https://x.example/a.flv', 'OTHER', { size: 9000 }), e('https://x.example/song.mp3', 'AUDIO', { size: 5000 }),
    e('https://x.example/b.mkv', 'VIDEO', { size: 3000 }), e('https://x.example/big.mp4', 'VIDEO', { size: 8000 }),
    e('https://x.example/small.mp4', 'VIDEO', { size: 2000 }), e('https://x.example/main.mp4', 'VIDEO', { size: 99999 }),
    e('https://x.example/ranged.mp4', 'VIDEO', { rangeLimited: true }), e('https://x.example/drm.mp4', 'VIDEO', { drmSuspected: true }),
    e('https://x.example/big.mp4', 'VIDEO', { size: 8000 }), e('https://x.example/master.m3u8', 'HLS')
  ];
  const rows = plain(H.fileSources(entries, 'https://x.example/watch', 'https://x.example/main.mp4'));
  assert.deepEqual(rows.map(row => row.url.split('/').pop()), ['big.mp4', 'small.mp4', 'b.mkv', 'a.flv', 'song.mp3']);
  assert.deepEqual(rows.map(row => row.label), ['MP4 dosyası', 'MP4 dosyası (2)', 'MKV dosyası', 'FLV dosyası', 'MP3 ses dosyası']);
  assert.deepEqual(rows.map(row => row.rank), [0, 0, 1, 2, 3]);
  assert.equal(rows[0].id, 'file:0'); assert.equal(rows[0].referer, 'https://x.example/watch');
});

test('HLS parçası olan .ts satır olmaz', () => {
  const entries = [{ url: 'https://x.example/seg9.ts', kind: 'OTHER', frameId: 0, mime: 'video/mp2t', size: 20 * MB }, { url: 'https://x.example/a.m3u8', kind: 'HLS', frameId: 0 }];
  assert.equal(H.fileSources(entries, 'https://x.example/').length, 0);
});
