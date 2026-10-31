import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { classifySubtitle, parseSubtitle, toVtt, toSrt, languageInfo, languageFromAddress, canEmbed, probeStreams } from '../src/subtitles.js';
import { DownloadQueue } from '../src/downloads.js';
import { parseHls } from '../src/hls.js';

const tools = path.resolve('tools');
const haveTools = fs.existsSync(path.join(tools, 'ffmpeg.exe')) && fs.existsSync(path.join(tools, 'ffprobe.exe'));

const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nBeni çözün, <c.red>sizi</c> ona götüreyim.\n\n00:00:03.000 --> 00:00:04.000\n<i>İkinci</i> satır\n';
const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\nÇığ düştü şüphesiz\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nİkinci\r\n';
const ASS = '[Script Info]\nTitle: x\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}Merhaba\\Ndünya, nasılsın\n';
const TTML = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.500">Tek<br/>satır &amp; tırnak</p></div></body></tt>';

test('subtitles are recognised by content, whatever their address or extension', () => {
  assert.equal(classifySubtitle(VTT), 'vtt'); assert.equal(classifySubtitle(SRT), 'srt'); assert.equal(classifySubtitle(ASS), 'ass'); assert.equal(classifySubtitle(TTML), 'ttml');
  for (const junk of ['', 'plain text', '{"a":1}', '<html><body>Not found</body></html>', '#EXTM3U\n#EXT-X-VERSION:3', 'MZ\u0090\u0000binary', null]) assert.equal(classifySubtitle(junk), null);
});
test('every format becomes the same clean cues, Turkish characters intact', () => {
  const vtt = parseSubtitle(VTT).cues; assert.equal(vtt.length, 2); assert.equal(vtt[0].text, 'Beni çözün, sizi ona götüreyim.'); assert.equal(vtt[1].text, '<i>İkinci</i> satır');
  assert.equal(parseSubtitle(SRT).cues[0].text, 'Çığ düştü şüphesiz'); assert.equal(parseSubtitle(SRT).cues[0].start, 1);
  assert.equal(parseSubtitle(ASS).cues[0].text, 'Merhaba\ndünya, nasılsın');
  assert.equal(parseSubtitle(TTML).cues[0].text, 'Tek\nsatır & tırnak');
  const round = parseSubtitle(toVtt(vtt)).cues; assert.deepEqual(round, vtt);
  assert.match(toSrt(vtt), /^1\r\n00:00:01,000 --> 00:00:02,500\r\n/);
  assert.equal(parseSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsame\n\n00:00:01.000 --> 00:00:02.000\nsame\n').cues.length, 1);
  assert.equal(parseSubtitle('WEBVTT\n\nNOTE only a note\n'), null);
});
test('language comes from the code, the label or a hint in the address', () => {
  assert.deepEqual(languageInfo('tr-TR'), { iso1: 'tr', iso3: 'tur', name: 'Türkçe' });
  assert.equal(languageInfo('eng').iso1, 'en'); assert.equal(languageInfo('', 'Türkçe Altyazı').iso3, 'tur'); assert.equal(languageInfo('', 'English CC').iso1, 'en');
  assert.deepEqual(languageInfo('', 'Kişisel'), { iso1: null, iso3: 'und', name: 'Kişisel' });
  assert.equal(languageFromAddress('https://cdn.example.org/subs/movie.tr.vtt'), 'tr'); assert.equal(languageFromAddress('https://cdn.example.org/a/eng/1.vtt'), 'en'); assert.equal(languageFromAddress('https://cdn.example.org/x/1234.vtt'), null);
  assert.equal(canEmbed('a.mp4'), true); assert.equal(canEmbed('a.mkv'), true); assert.equal(canEmbed('a.avi'), false);
});
test('HLS master playlist subtitle tracks are listed (any site, no guessing)', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,URI="tr/index.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="https://cdn.example.org/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,SUBTITLES="s"\n720/index.m3u8\n';
  const parsed = parseHls(master, 'https://cdn.example.org/m/master.m3u8');
  assert.deepEqual(parsed.subtitles.map(s => [s.language, s.name, s.default, s.url]), [['tr', 'Türkçe', true, 'https://cdn.example.org/m/tr/index.m3u8'], ['en', 'English', false, 'https://cdn.example.org/en.m3u8']]);
});

function video(file, extra = []) {
  const result = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, file], { windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr));
}
function queueFixture(t, rangeRequest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-subs-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest });
  queue.setSettings({ subtitleMode: 'embed' }); // these tests are about the embedding itself; the default ("both") is covered in subtitle-lead.test.js
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'd'), { recursive: true });
  return { root, queue, directory: path.join(root, 'd') };
}
const response = (body, statusCode = 200) => ({ response: Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]), { statusCode }), url: new URL('https://cdn.example.org/x') });
const streams = file => JSON.parse(spawnSync(path.join(tools, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default', '-of', 'json', file]).stdout).streams;

test('real download: page tracks + network files are embedded in the video, video/audio untouched', { skip: !haveTools }, async t => {
  // Windows-1254 file (Turkish SRT) and an extension-less address, the way real sites serve them.
  const cp1254 = Buffer.from([0x31, 0x0d, 0x0a, ...Buffer.from('00:00:02,000 --> 00:00:03,000\r\n'), 0xdd, 0x73, 0x74, 0x61, 0x6e, 0x62, 0x75, 0x6c, 0x0d, 0x0a]); // "İstanbul" in cp1254
  const served = new Map([['https://cdn.example.org/api/getsub?id=7', SRT], ['https://cdn.example.org/subs/film.tr.srt', cp1254], ['https://cdn.example.org/api/notsub', '{"error":true}']]);
  const { queue, directory } = queueFixture(t, async url => served.has(url) ? response(served.get(url)) : response('nope', 404));
  const mp4 = path.join(directory, 'job-Film.mp4'); video(mp4);
  const before = await probeStreams(mp4, tools);
  const job = { id: 'job', title: 'Film', status: 'running', directory, file: 'job-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4' };
  job.subtitlePending = queue.storeSubtitleInputs('job', { subtitleTracks: [{ lang: 'en', label: 'English', default: false, text: VTT }, { lang: 'tr', label: 'Türkçe', default: true, text: VTT.replace('Beni çözün', 'Farklı') }, { lang: 'xx', text: 'not a subtitle' }],
    subtitleUrls: [{ url: 'https://cdn.example.org/api/getsub?id=7' }, { url: 'https://cdn.example.org/subs/film.tr.srt', sure: true }, { url: 'https://cdn.example.org/api/notsub' }] });
  assert.equal(job.subtitlePending.length, 6);
  queue.jobs.push(job);
  await queue.attachSubtitles(job, new AbortController().signal);
  assert.equal(job.subtitleResult.mode, 'embedded', JSON.stringify(job.subtitleResult));
  const info = streams(mp4), subs = info.filter(s => s.codec_type === 'subtitle');
  assert.equal(subs.length, 4); assert.ok(subs.every(s => s.codec_name === 'mov_text'));
  assert.equal(subs[0].tags.language, 'tur'); assert.equal(subs[0].disposition.default, 1); assert.equal(subs[1].disposition.default, 0);
  const after = await probeStreams(mp4, tools);
  assert.equal(after.video, before.video); assert.equal(after.audio, before.audio); assert.equal(after.subtitle, 4);
  assert.ok(Math.abs(after.duration - before.duration) < 0.5);
  assert.equal(job.subtitlePending, undefined);
  assert.ok(!fs.existsSync(queue.subtitleDirectory('job')), 'temporary copies are removed');
  assert.deepEqual(fs.readdirSync(directory), ['job-Film.mp4']); // no leftovers, no sidecars when embedded
  assert.ok(job.subtitleResult.tracks.some(track => track.name === 'Türkçe'));
});

test('a video that already has subtitles, or a type that cannot hold them, keeps its file and gets side files', { skip: !haveTools }, async t => {
  const { queue, directory } = queueFixture(t, async () => response('x', 404));
  const mkv = path.join(directory, 'a-Film.mkv'); video(mkv);
  const sub = path.join(directory, 's.vtt'); fs.writeFileSync(sub, VTT);
  const embedJob = { id: 'a', status: 'running', directory, file: 'a-Film.mkv', headers: {}, url: 'https://cdn.example.org/v.mkv', subtitlePending: queue.storeSubtitleInputs('a', { subtitleTracks: [{ lang: 'tr', text: VTT }] }) };
  await queue.attachSubtitles(embedJob, new AbortController().signal);
  assert.equal(embedJob.subtitleResult.mode, 'embedded'); assert.equal(streams(mkv).find(s => s.codec_type === 'subtitle').codec_name, 'subrip');
  // second pass on the same file: it already has a subtitle track, so nothing is added and the file stays valid
  const again = { id: 'b', status: 'running', directory, file: 'a-Film.mkv', headers: {}, url: 'https://cdn.example.org/v.mkv', subtitlePending: queue.storeSubtitleInputs('b', { subtitleTracks: [{ lang: 'en', text: SRT }] }) };
  await queue.attachSubtitles(again, new AbortController().signal);
  assert.equal(again.subtitleResult.mode, 'sidecar'); assert.match(again.subtitleResult.note, /gömülemedi/);
  assert.equal((await probeStreams(mkv, tools)).subtitle, 1);
  assert.ok(fs.readdirSync(directory).includes('a-Film.en.srt'));
  // unwritable container (avi): sidecar only, and an existing file is never overwritten
  const avi = path.join(directory, 'c-Film.avi'); video(avi, ['-c:v', 'mpeg4']);
  fs.writeFileSync(path.join(directory, 'c-Film.tr.srt'), 'mine');
  const aviJob = { id: 'c', status: 'running', directory, file: 'c-Film.avi', headers: {}, url: 'https://cdn.example.org/v.avi', subtitlePending: queue.storeSubtitleInputs('c', { subtitleTracks: [{ lang: 'tr', text: VTT }] }) };
  await queue.attachSubtitles(aviJob, new AbortController().signal);
  assert.equal(aviJob.subtitleResult.mode, 'sidecar'); assert.equal(fs.readFileSync(path.join(directory, 'c-Film.tr.srt'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(path.join(directory, 'c-Film.tr.2.srt')));
});

test('unreadable or empty subtitles never fail or change a download; "off" and no-subtitle jobs are untouched', { skip: !haveTools }, async t => {
  const { queue, directory } = queueFixture(t, async () => response('{"nope":1}'));
  const mp4 = path.join(directory, 'z-Film.mp4'); video(mp4); const hash = fs.readFileSync(mp4).toString('base64');
  const job = { id: 'z', status: 'running', directory, file: 'z-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4', subtitlePending: queue.storeSubtitleInputs('z', { subtitleUrls: [{ url: 'https://cdn.example.org/s', sure: true }], subtitleTracks: [{ lang: 'tr', text: 'garbage' }] }) };
  await queue.attachSubtitles(job, new AbortController().signal);
  assert.equal(job.subtitleResult.mode, 'none'); assert.match(job.subtitleResult.note, /altyazı vardı/);
  assert.equal(fs.readFileSync(mp4).toString('base64'), hash);
  queue.setSettings({ subtitleMode: 'off' });
  const off = { id: 'y', status: 'running', directory, file: 'z-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4', subtitlePending: queue.storeSubtitleInputs('y', { subtitleTracks: [{ lang: 'tr', text: VTT }] }) };
  await queue.attachSubtitles(off, new AbortController().signal);
  assert.equal(off.subtitleResult, undefined); assert.equal(fs.readFileSync(mp4).toString('base64'), hash);
  assert.throws(() => queue.setSettings({ subtitleMode: 'burn' }));
  const plain = { id: 'x', status: 'running', directory, file: 'z-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4' };
  queue.setSettings({ subtitleMode: 'embed' }); await queue.attachSubtitles(plain, new AbortController().signal); assert.equal(plain.subtitleResult, undefined);
});

test('subtitle text sent in pieces joins the download that names its upload; bad pieces are refused', t => {
  const { queue } = queueFixture(t, async () => response('x', 404));
  const uploadId = '11111111-2222-4333-8444-555555555555', text = VTT.repeat(3);
  const half = Math.floor(text.length / 2);
  assert.deepEqual(queue.receiveSubtitle({ uploadId, track: 0, seq: 1, count: 2, chunk: text.slice(half), lang: 'tr', label: 'Türkçe', default: true }), { received: 1, complete: false });
  assert.deepEqual(queue.receiveSubtitle({ uploadId, track: 0, seq: 0, count: 2, chunk: text.slice(0, half), lang: 'tr', label: 'Türkçe', default: true }), { received: 2, complete: true });
  queue.receiveSubtitle({ uploadId, track: 1, seq: 0, count: 2, chunk: 'unfinished' }); // incomplete tracks are dropped, never half-used
  for (const bad of [{}, { uploadId: 'x', track: 0, seq: 0, count: 1, chunk: 'a' }, { uploadId, track: 99, seq: 0, count: 1, chunk: 'a' }, { uploadId, track: 0, seq: 5, count: 2, chunk: 'a' }, { uploadId, track: 0, seq: 0, count: 1, chunk: 'x'.repeat(12001) }, { uploadId, track: 0, seq: 0, count: 1, chunk: 5 }]) assert.throws(() => queue.receiveSubtitle(bad), /geçersiz/);
  const id = queue.add({ url: 'https://example.org/v.mp4', engine: 'direct', start: 'queue', subtitleUpload: uploadId, subtitleUrls: [{ url: 'https://example.org/s.vtt', sure: true }, { url: 'http://127.0.0.1/private.vtt' }, 'nonsense'] });
  const job = queue.jobs.find(item => item.id === id);
  assert.equal(job.subtitlePending.length, 2); // the finished upload + the one usable address
  assert.equal(job.subtitlePending[0].kind, 'file'); assert.equal(fs.readFileSync(job.subtitlePending[0].file, 'utf8'), text); assert.equal(job.subtitlePending[0].default, true);
  assert.equal(queue.list().find(item => item.id === id).subtitlePending, undefined); // never shown in responses
  assert.equal(queue.takeSubtitleUpload(uploadId).length, 0); // used once
  const lostId = queue.add({ url: 'https://example.org/w.mp4', engine: 'direct', start: 'queue', subtitleUpload: '99999999-2222-4333-8444-555555555555' }), lost = queue.jobs.find(item => item.id === lostId);
  assert.match(lost.subtitleResult.note, /ulaşmadı/); // an expired upload is said out loud, not hidden
});
test('the native bridge allows the subtitle upload route and nothing broader', async () => {
  const { validateNativeRequest } = await import('../src/native-protocol.js');
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(validateNativeRequest({ version: 1, id, action: 'request', method: 'POST', route: '/api/subtitles', body: { a: 1 } }).route, '/api/subtitles');
  assert.throws(() => validateNativeRequest({ version: 1, id, action: 'request', method: 'GET', route: '/api/subtitles' }));
  assert.throws(() => validateNativeRequest({ version: 1, id, action: 'request', method: 'POST', route: '/api/subtitles/extra', body: {} }));
});
test('extension: collects the player tracks of every frame once asked, plus subtitle files seen on the network', async () => {
  await import('../extension/core.js');
  const H = globalThis.Hypernab; const store = {};
  const api = { storage: { session: { get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, store[k]])) } },
    tabs: { sendMessage: async (_tab, message) => { store['subs:7'] = { 0: { serial: message.serial, tracks: [{ lang: 'tr', label: 'Türkçe', default: true, vtt: VTT }], urls: [{ url: 'https://cdn.example.org/s.vtt', lang: 'tr', label: '', default: false }] } }; } } };
  store['context:7'] = { frames: { 0: { mediaUrl: 'https://cdn.example.org/v.mp4' } } };
  store['subs-net:7'] = [{ url: 'https://cdn.example.org/s.vtt', sure: true }, { url: 'https://cdn.example.org/api/x', sure: false }];
  const result = await H.gatherSubtitles(api, 7, 1500);
  assert.equal(result.tracks.length, 1); assert.deepEqual(result.urls.map(item => [item.url, item.sure]), [['https://cdn.example.org/s.vtt', true], ['https://cdn.example.org/api/x', false]]);
  const none = await H.gatherSubtitles({ ...api, storage: { session: { get: async () => ({}) } } }, 8, 1500); // a page without a player is not waited for
  assert.deepEqual(none, { tracks: [], urls: [] });
  const sent = [];
  const client = { request: async (route, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; } };
  const payload = await H.subtitlePayload(api, client, 7);
  assert.match(payload.subtitleUpload, /^[a-f0-9-]{36}$/); assert.equal(payload.subtitleUrls.length, 2);
  assert.ok(sent.length >= 1 && sent.every(piece => piece.uploadId === payload.subtitleUpload && piece.chunk.length <= 9000));
  assert.deepEqual(await H.subtitlePayload(api, { request: async () => { throw new Error('offline'); } }, 7).then(item => Object.keys(item)), ['subtitleUrls']); // upload failure never blocks the download
});
