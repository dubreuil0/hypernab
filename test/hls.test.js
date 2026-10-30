import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { parseHls, hlsInfo, hlsAttributes, readHls, readHlsResponse } from '../src/hls.js';
import { buildQualityOptions } from '../src/quality.js';
import { DownloadQueue } from '../src/downloads.js';
import { downloadHls } from '../src/hls-download.js';
import { spawnManaged } from '../src/process.js';
import { verifyVideo } from '../src/media.js';
import { setTimeout as wait } from 'node:timers/promises';

const base = 'https://cdn.example.org/video/master';
const tools = path.resolve('tools');
const temp = (process.env.LOCALAPPDATA + '/Temp/opencode');
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="en",NAME="English, original",DEFAULT=YES,URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="en"\nv1.m3u8\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nv2.m3u8\n';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts\n#EXTINF:2,\ns1.ts\n#EXT-X-ENDLIST\n';
function response(body, statusCode = 200, headers = {}) { return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers }); }
function dir(t) { const root = fs.mkdtempSync(path.join(temp, 'hypernab-hls-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function queueFixture(t, request) {
  const root = dir(t), queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: request, mediaInspector: () => { throw new Error('yt-dlp MUST NOT run'); }, infoExtractor: () => { throw new Error('yt-dlp MUST NOT run'); } });
  t.after(() => queue.stop()); return { root, queue };
}

test('native HLS master: gerçek çözünürlük, bit hızı, virgüllü codec/ad, göreli URL ve ses grubu', () => {
  const parsed = parseHls('\uFEFF' + master, base), info = hlsInfo(parsed, base);
  assert.equal(parsed.audios[0].name, 'English, original');
  assert.equal(parsed.variants[0].url, 'https://cdn.example.org/video/v1.m3u8');
  assert.equal(parsed.variants[1].tbr, 900);
  const { options } = buildQualityOptions(info, { ffmpeg: true });
  assert.deepEqual(options.map(o => o.height), [1080, 720]);
  assert.equal(options[0].id, 'hls_v0+hls_a0'); assert.equal(options[0].audio, 'merged');
  assert.equal(options[1].audio, 'included');
  assert.deepEqual(hlsAttributes('NAME="a,b",BANDWIDTH=42'), { NAME: 'a,b', BANDWIDTH: '42' });
});

test('her varyant kendi ses grubuyla eşleşir; yüksek bit hızlı başka dil seçilmez', () => {
  const p = parseHls(master + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="tr",URI="tr.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="tr"\ntr-v.m3u8\n', base);
  const info = hlsInfo(p, base); info.formats.find(f => f.format_id === 'hls_a0').abr = 9999;
  const variants = info.formats.filter(f => f.height);
  for (const video of variants.filter(v => v.hlsAudioId)) {
    const { options } = buildQualityOptions({ ...info, formats: [...info.formats.filter(f => f.vcodec === 'none'), video] }, { ffmpeg: true });
    assert.equal(options[0].id, `${video.format_id}+${video.hlsAudioId}`);
  }
});

test('kalite uydurulmaz; NAME=1080p gerçek etiket, rastgele isim çözünürlük sayılmaz', () => {
  const p = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400,NAME="1080p"\na\n#EXT-X-STREAM-INF:BANDWIDTH=900,NAME="best"\nb\n', base);
  assert.equal(p.variants[0].height, 1080); assert.equal(p.variants[1].height, null);
  assert.deepEqual(buildQualityOptions(hlsInfo(p, base), { ffmpeg: true }).options.map(o => o.height), [1080]);
});

test('gövde koklama yanlış video/mp4 ve uzantısız HLS yanıtını tanır; ikili dosyayı okumayı keser', async () => {
  assert.equal((await readHlsResponse(response(media), base)).duration, 4);
  const res = response('not an HLS binary video');
  assert.equal(await readHlsResponse(res, base), null); assert.ok(res.destroyed);
  assert.equal(parseHls('<html>#EXTM3U</html>', base), null);
});

test('DRM/şifreleme, özel URL, byte-range ve eksik parça güvenle reddedilir', () => {
  for (const tag of ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"', '#EXT-X-BYTERANGE:200@0', '#EXT-X-GAP']) assert.throws(() => parseHls(media.replace('#EXTINF:2,', `${tag}\n#EXTINF:2,`), base));
  assert.throws(() => parseHls(media.replace('s0.ts', 'http://127.0.0.1/secret'), base));
  assert.throws(() => parseHls(media.replace('s0.ts', 'file:///secret'), base));
  assert.equal(parseHls(media.replace('#EXT-X-ENDLIST', ''), base).live, true);
});

test('tek kullanımlık URL: okuyucu bir istekte okur, tekrar reddedilirse başarı iddia etmez', async () => {
  let count = 0;
  const request = async target => ({ url: new URL(target), response: response(count++ ? '' : media, count > 1 ? 403 : 200) });
  assert.equal((await readHls({ url: base, request })).duration, 4);
  assert.equal(count, 1);
  await assert.rejects(readHls({ url: base, request }), /HTTP 403/);
});

test('ana liste anında döner; süre ve boyut arkadan güncellenir, yt-dlp çalışmaz, çerez sızmaz', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let asked = 0;
  const { queue, root } = queueFixture(t, async target => {
    asked++;
    if (target !== base) await gate;
    return { url: new URL(target), response: response(target === base ? master : media) };
  });
  const input = { url: base, mediaKind: 'HLS', title: 'Film', cookies: [{ name: 'sid', value: 'SECRET123', domain: 'cdn.example.org', hostOnly: true, path: '/', secure: true }] };
  const first = await queue.inspect(input);
  assert.equal(first.inspectionPending, true); assert.equal(first.options[0].height, 1080); assert.equal(first.duration, null);
  assert.ok(!JSON.stringify(first).includes('SECRET123'));
  release(); await [...queue.hlsInspections.values()][0].work;
  const updated = await queue.inspect(input);
  assert.equal(updated.duration, 4); assert.equal(updated.options[0].filesize, 1000000); assert.equal(updated.options[0].sizeKind, 'approx');
  assert.equal(updated.inspectionPending, false); assert.equal(asked, 2, 'ana liste tekrar istenmez');
  const id = queue.add({ url: base, engine: 'extractor', formatId: updated.options[0].id, start: 'queue' });
  assert.equal(queue.jobs.find(j => j.id === id).nativeHls, true);
  assert.ok(!fs.readFileSync(path.join(root, 'queue.json'), 'utf8').includes('SECRET123'));
});

test('/sniff yalnızca gerçek HLS gövdesini kabul eder; ilk liste isteğini tekrar etmez', async t => {
  let count = 0;
  const { queue } = queueFixture(t, async target => { count++; return { url: new URL(target), response: response(target.endsWith('not-media') ? 'not media at all' : media) }; });
  const info = await queue.sniff({ url: base });
  assert.equal(info.nativeHls, true); assert.equal(info.resolved.mediaKind, 'HLS');
  await assert.rejects(queue.sniff({ url: base + '/not-media' }), /HLS/);
  await Promise.all([...queue.hlsInspections.values()].map(e => e.work));
  assert.ok(count >= 2);
});

for (const fragmented of [false, true]) test(`gerçek FFmpeg: ${fragmented ? 'fMP4' : 'MPEG-TS'} HLS seçilen video+ses indirilir ve doğrulanır; FFmpeg ağ açmaz`, async t => {
  const root = dir(t), fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture);
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod'];
  if (fragmented) args.push('-hls_segment_type', 'fmp4');
  args.push(path.join(fixture, 'index.m3u8'));
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), args, { cwd: fixture });
  assert.equal(made.status, 0, String(made.stderr));
  const asked = [], commands = [];
  const request = async target => {
    asked.push(target); const file = path.basename(new URL(target).pathname), data = fs.readFileSync(path.join(fixture, file));
    return { url: new URL(target), response: response(data, 200, { 'content-length': String(data.length) }) };
  };
  const result = await downloadHls({ sources: [{ url: 'https://cdn.example.org/index.m3u8' }], directory: root, toolsDirectory: tools, signal: AbortSignal.timeout(20000), request, connections: 2,
    spawn: (exe, command, opts) => { commands.push(command); return spawnManaged(exe, command, opts); } });
  const verified = await verifyVideo(result.output, tools, 2, AbortSignal.timeout(10000));
  assert.equal(verified.height, 180); assert.equal(verified.audio, true);
  assert.ok(commands[0].every(arg => !arg.startsWith('https:'))); assert.ok(commands[0].includes('file'));
  assert.ok(asked.some(url => url.endsWith(fragmented ? '.m4s' : '.ts')));
});

test('HLS indirme canlı veya master listeyi yanlışlıkla seçilmiş kalite gibi indirmez', async t => {
  const root = dir(t);
  for (const body of [master, media.replace('#EXT-X-ENDLIST', '')]) await assert.rejects(downloadHls({ sources: [{ url: base }], directory: root, toolsDirectory: tools, signal: AbortSignal.timeout(1000), request: async target => ({ url: new URL(target), response: response(body) }), spawn: () => { throw new Error('must not run'); } }), /varyant/);
});

test('yerel HLS kalite seçimi ve kuyruğa ekleme yt-dlp dosyasına bağımlı değildir', async t => {
  const root = dir(t); fs.writeFileSync(path.join(root, 'ffmpeg.exe'), 'test double');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root,
    rangeRequest: async target => ({ url: new URL(target), response: response(target === base ? master : media) }) });
  t.after(() => queue.stop());
  const view = await queue.inspect({ url: base, mediaKind: 'HLS' });
  assert.equal(queue.capabilities().ytDlp, false);
  assert.ok(queue.add({ url: base, engine: 'extractor', formatId: view.options[0].id, start: 'queue' }));
  await Promise.all([...queue.hlsInspections.values()].map(e => e.work));
});

test('HLS işinin yaklaşık boyutu sunucunun gerçek seçeneğinden gelir, istemci tahmini kabul edilmez', async t => {
  const { queue } = queueFixture(t, async target => ({ url: new URL(target), response: response(target === base ? master : media) }));
  await queue.inspect({ url: base, mediaKind: 'HLS' });
  await Promise.all([...queue.hlsInspections.values()].map(e => e.work));
  const view = await queue.inspect({ url: base, mediaKind: 'HLS' });
  const id = queue.add({ url: base, formatId: view.options[0].id, start: 'queue', estimateBytes: 1, total: 1 });
  const job = queue.jobs.find(j => j.id === id);
  assert.equal(job.total, view.options[0].filesize); assert.equal(job.estimateBytes, view.options[0].filesize); assert.equal(job.sizeKind, 'approx');
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).find(j => j.id === id).estimateBytes, view.options[0].filesize);
});

test('gerçek kuyruk: seçilen varyant + doğru ayrı ses, yt-dlp olmadan sesli doğrulanıp yayınlanır', async t => {
  const root = dir(t), fixture = path.join(root, 'fixtures'); fs.mkdirSync(fixture);
  for (const [name, inputs, codec] of [
    ['v', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25'], ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
    ['a', ['-f', 'lavfi', '-i', 'sine=frequency=440'], ['-c:a', 'aac']]
  ]) {
    const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', ...inputs, '-t', '2', ...codec, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(fixture, `${name}.m3u8`)], { cwd: fixture });
    assert.equal(made.status, 0, String(made.stderr));
  }
  const offeredMaster = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="a.m3u8",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180,CODECS="avc1.64000c,mp4a.40.2",AUDIO="a"\nv.m3u8\n';
  const asked = [];
  const { queue } = queueFixture(t, async target => {
    asked.push(target);
    const data = target === base ? Buffer.from(offeredMaster) : fs.readFileSync(path.join(fixture, path.basename(new URL(target).pathname)));
    return { url: new URL(target), response: Object.assign(Readable.from(Array.from({ length: Math.ceil(data.length / 4096) }, (_, i) => data.subarray(i * 4096, (i + 1) * 4096))), { statusCode: 200, headers: { 'content-length': String(data.length) } }) };
  });
  const view = await queue.inspect({ url: base, mediaKind: 'HLS', title: 'Native film' });
  let processError = '';
  queue.processSpawner = (exe, args, opts) => { const child = spawnManaged(exe, args, opts); child.stderr.on('data', chunk => { processError += chunk; }); return child; };
  await Promise.all([...queue.hlsInspections.values()].map(e => e.work));
  queue.setSettings({ speedLimitKiB: 8 }); // real throttled bytes, long enough for the shared speed warm-up
  const id = queue.add({ url: base, engine: 'extractor', formatId: view.options[0].id, title: 'Native film' });
  const observed = [];
  for (let i = 0; i < 600 && !['completed', 'failed'].includes(queue.jobs.find(j => j.id === id).status); i++) { observed.push(queue.list().find(j => j.id === id).progress); await wait(25); }
  const job = queue.jobs.find(j => j.id === id);
  assert.equal(job.status, 'completed', job.error + processError); assert.equal(job.media.audio, true); assert.equal(job.media.height, 180);
  assert.ok(asked.some(url => url.endsWith('/a.m3u8'))); assert.ok(asked.some(url => url.endsWith('/v.m3u8')));
  assert.equal(job.file, 'Native film 180p.mp4');
  assert.ok(observed.some(p => p.phase === 'downloading' && p.sizeKind === 'approx' && p.total > 0 && p.etaSeconds > 0), 'gerçek HLS aktarımında ısınmadan sonra yaklaşık kalan süre üretilmeli');
  assert.equal(job.sizeKind, 'exact');
  queue.setSettings({ speedLimitKiB: 0 });
  // Also the no-master case: a silent playlist plus an explicitly captured sound playlist.
  const videoUrl = new URL('v.m3u8', base).href, audioUrl = new URL('a.m3u8', base).href;
  await queue.inspect({ url: videoUrl, mediaKind: 'HLS' });
  await Promise.all([...queue.hlsInspections.values()].map(e => e.work));
  const bare = await queue.inspect({ url: videoUrl, mediaKind: 'HLS' });
  assert.equal(bare.silentStream, true); assert.equal(bare.options[0].height, 180);
  const bareId = queue.add({ url: videoUrl, audioUrl, engine: 'extractor', formatId: bare.options[0].id, title: 'Bare film' });
  for (let i = 0; i < 200 && !['completed', 'failed'].includes(queue.jobs.find(j => j.id === bareId).status); i++) await wait(25);
  const bareJob = queue.jobs.find(j => j.id === bareId);
  assert.equal(bareJob.status, 'completed', bareJob.error); assert.equal(bareJob.media.audio, true);
  assert.equal(asked.filter(url => url === videoUrl).length, 2, 'ana liste incelemesi bir kez, çıplak liste incelemesi bir kez; ölçüm/indirme aynı manifesti tekrar istemez');
  assert.ok(!JSON.stringify(bare).includes('hlsPlaylist'), 'özel manifest içeriği istemciye gönderilmez');
});
