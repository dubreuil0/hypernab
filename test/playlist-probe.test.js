import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { parseMediaPlaylist, probeMediaPlaylist, enrichPlaylistFormats } from '../src/playlist-probe.js';
import { buildQualityOptions } from '../src/quality.js';

const tools = path.resolve(import.meta.dirname, '../tools');
const haveTools = fs.existsSync(path.join(tools, 'ffmpeg.exe')) && fs.existsSync(path.join(tools, 'ffprobe.exe'));

test('medya listesi çözülür; ana liste, şifreli veya boş liste ölçülmez', () => {
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:4.5,\nseg0.ts\n#EXTINF:5,\n/abs/seg1.ts\n#EXT-X-ENDLIST\n';
  const parsed = parseMediaPlaylist(media, 'https://cdn.example/v/index.m3u8');
  assert.deepEqual(parsed.segments.map(s => s.url), ['https://cdn.example/v/seg0.ts', 'https://cdn.example/abs/seg1.ts']);
  assert.equal(parsed.duration, 9.5); assert.equal(parsed.map, null);
  assert.equal(parseMediaPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n', 'https://cdn.example/m.m3u8'), null);
  assert.equal(parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns.ts\n', 'https://cdn.example/m.m3u8'), null);
  assert.equal(parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\ns.ts\n', 'https://cdn.example/m.m3u8').segments.length, 1);
  assert.equal(parseMediaPlaylist('<html></html>', 'https://cdn.example/x'), null);
  assert.equal(parseMediaPlaylist('#EXTM3U\n', 'https://cdn.example/x'), null);
  assert.equal(parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n', 'https://cdn.example/v/i.m3u8').map, 'https://cdn.example/v/init.mp4');
});

test('çıplak HLS listesi: gerçek ffprobe ile çözünürlük, codec ve boyut tahmini ölçülür; kalite seçeneği oluşur', { skip: !haveTools }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-probe-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ts = path.join(dir, 'a.ts');
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', ts]);
  assert.equal(made.status, 0, String(made.stderr));
  const data = fs.readFileSync(ts), asked = [];
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts\n#EXTINF:2,\ns1.ts\n#EXTINF:2,\ns2.ts\n#EXTINF:2,\ns3.ts\n#EXT-X-ENDLIST\n';
  const request = async (target, _signal, headers) => {
    asked.push({ target, headers });
    const url = new URL(target);
    if (url.pathname.endsWith('.m3u8')) return { url, response: Object.assign(Readable.from([Buffer.from(playlist)]), { statusCode: 200, headers: {} }) };
    if (headers.Range === 'bytes=0-0') return { url, response: Object.assign(Readable.from([data.subarray(0, 1)]), { statusCode: 206, headers: { 'content-range': `bytes 0-0/${data.length}` } }) };
    return { url, response: Object.assign(Readable.from([data]), { statusCode: 206, headers: { 'content-length': String(data.length) } }) };
  };
  const measured = await probeMediaPlaylist({ url: 'https://cdn.example/v/index.m3u8', headers: { Referer: 'https://site.example/' }, toolsDirectory: tools, request });
  assert.equal(measured.height, 360); assert.equal(measured.width, 640); assert.equal(Math.round(measured.fps), 25);
  assert.equal(measured.vcodec, 'h264'); assert.equal(measured.acodec, 'aac'); assert.equal(measured.duration, 8);
  assert.equal(measured.filesize, data.length * 4, 'dört eşit parçanın gerçek boyutlarından toplam tahmini');
  assert.ok(asked.every(call => call.headers.Referer === 'https://site.example/'), 'başlıklar tüm isteklere gider');
  // The normal quality pipeline then offers it like any measured stream.
  const info = { duration: 8, formats: [{ format_id: '0', protocol: 'm3u8_native', ext: 'mp4', url: 'https://cdn.example/v/index.m3u8' }] };
  assert.equal(buildQualityOptions(info, { ffmpeg: true }).options.length, 0, 'ölçmeden kalite yok');
  await enrichPlaylistFormats(info, { toolsDirectory: tools, probe: async () => measured });
  const { options } = buildQualityOptions(info, { ffmpeg: true });
  assert.equal(options.length, 1); assert.match(options[0].label, /360p/); assert.equal(options[0].filesize, data.length * 4); assert.equal(options[0].audio, 'included');
});

test('ölçüm başarısız olursa bilgi olduğu gibi kalır ve hata fırlatılmaz', async () => {
  const info = { formats: [{ format_id: '0', protocol: 'm3u8_native', url: 'https://cdn.example/i.m3u8' }, { format_id: 'x', protocol: 'https', url: 'https://cdn.example/a.mp4', height: 720 }] };
  await enrichPlaylistFormats(info, { toolsDirectory: tools, probe: async () => { throw new Error('ağ'); } });
  assert.equal(info.formats[0].height, undefined); assert.equal(info.formats[1].height, 720);
  let calls = 0;
  await enrichPlaylistFormats({ formats: [{ format_id: '1', protocol: 'https', url: 'https://cdn.example/a.mp4' }, { format_id: '2', protocol: 'm3u8_native', height: 480, url: 'https://cdn.example/b.m3u8' }] }, { toolsDirectory: tools, probe: async () => { calls++; return null; } });
  assert.equal(calls, 0, 'zaten ölçülü veya HLS olmayan biçim yeniden ölçülmez');
});

test('ölçüm: yalnızca ses olan liste ve sesi olmayan görüntü listesi ayırt edilir', { skip: !haveTools }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-probe-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, args) => { const out = path.join(dir, name); assert.equal(spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', ...args, '-t', '2', '-f', 'mpegts', out]).status, 0); return fs.readFileSync(out); };
  const video = make('v.ts', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const sound = make('a.ts', ['-f', 'lavfi', '-i', 'sine=frequency=440', '-c:a', 'aac']);
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts\n#EXT-X-ENDLIST\n';
  const serve = data => async (target, _signal, headers) => {
    const url = new URL(target);
    if (url.pathname.endsWith('.m3u8')) return { url, response: Object.assign(Readable.from([Buffer.from(playlist)]), { statusCode: 200, headers: {} }) };
    if (headers.Range === 'bytes=0-0') return { url, response: Object.assign(Readable.from([data.subarray(0, 1)]), { statusCode: 206, headers: { 'content-range': `bytes 0-0/${data.length}` } }) };
    return { url, response: Object.assign(Readable.from([data]), { statusCode: 206, headers: {} }) };
  };
  const silent = await probeMediaPlaylist({ url: 'https://cdn.example/v/index.m3u8', toolsDirectory: tools, request: serve(video) });
  assert.equal(silent.audioOnly, false); assert.equal(silent.acodec, null); assert.equal(silent.height, 180);
  const audio = await probeMediaPlaylist({ url: 'https://cdn.example/a/index.m3u8', toolsDirectory: tools, request: serve(sound) });
  assert.equal(audio.audioOnly, true); assert.equal(audio.height, null); assert.equal(audio.acodec, 'aac');
  const silentInfo = { formats: [{ format_id: '0', protocol: 'm3u8_native', url: 'https://cdn.example/v/index.m3u8' }] };
  await enrichPlaylistFormats(silentInfo, { toolsDirectory: tools, probe: async () => silent });
  assert.equal(silentInfo.silentStream, true, 'sessiz görüntü listesi işaretlenir');
  const soundInfo = { formats: [{ format_id: '0', protocol: 'm3u8_native', url: 'https://cdn.example/a/index.m3u8' }] };
  await enrichPlaylistFormats(soundInfo, { toolsDirectory: tools, probe: async () => audio });
  assert.equal(soundInfo.audioOnly, true); assert.equal(soundInfo.formats[0].vcodec, 'none'); assert.equal(buildQualityOptions(soundInfo, { ffmpeg: true }).options.length, 0, 'ses listesi kalite satırı oluşturmaz');
  const withSound = { formats: [{ format_id: '0', protocol: 'm3u8_native', url: 'https://cdn.example/v/index.m3u8' }] };
  await enrichPlaylistFormats(withSound, { toolsDirectory: tools, probe: async () => ({ ...silent, acodec: 'aac' }) });
  assert.equal(withSound.silentStream, undefined, 'sesi olan liste sessiz sayılmaz');
});