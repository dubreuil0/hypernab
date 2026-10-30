import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sanitizeCookies, cookiesForUrl, cookieHeader, withCookie, writeCookieJar, removeCookieJar } from '../src/session.js';
import { DownloadQueue } from '../src/downloads.js';
import { SourceExpiredError } from '../src/transfer.js';

const MEDIA = 'https://cdn.example.org/v/master.m3u8?t=1';
const PAGE = 'https://www.example.org/watch/1';
const c = (name, value, extra = {}) => ({ name, value, domain: '.example.org', path: '/', secure: true, ...extra });

test('çerez doğrulama: yalnızca medya/sayfa alan adına uyanlar kalır', () => {
  const clean = sanitizeCookies([c('sid', 'abc'), c('other', 'x', { domain: 'evil.test' }), c('exp', 'x', { expires: 10 })], [MEDIA, PAGE]);
  assert.deepEqual(clean.map(x => x.name), ['sid']);
  assert.equal(sanitizeCookies(undefined, [MEDIA]).length, 0);
});

test('çerez doğrulama: bozuk ad/değer/alan ve sınırlar reddedilir', () => {
  for (const bad of [c('a b', 'x'), c('n', 'x;y'), c('n', 'x\r\nSet-Cookie: a=b'), c('n', 'x', { domain: 'a/b' }), { name: 'n' }, 'str'])
    assert.throws(() => sanitizeCookies([bad], [MEDIA]), /geçersiz/);
  assert.throws(() => sanitizeCookies('x', [MEDIA]), /geçersiz/);
  assert.throws(() => sanitizeCookies(Array.from({ length: 81 }, (_, i) => c(`n${i}`, 'v')), [MEDIA]), /çok fazla/);
  assert.throws(() => sanitizeCookies(Array.from({ length: 10 }, (_, i) => c(`n${i}`, 'v'.repeat(4000))), [MEDIA]), /çok büyük/);
});

test('çerez eşleştirme: alan adı, yol, Secure, hostOnly ve sıralama', () => {
  const jar = sanitizeCookies([
    c('wide', '1'), c('deep', '2', { path: '/v/' }), c('http', '3', { secure: false }),
    c('host', '4', { domain: 'cdn.example.org', hostOnly: true }), c('sub', '5', { domain: 'other.example.org', hostOnly: true })
  ], [MEDIA, 'https://other.example.org/']);
  assert.equal(cookieHeader(jar, MEDIA), 'deep=2; wide=1; http=3; host=4');
  assert.equal(cookieHeader(jar, 'http://cdn.example.org/v/a'), 'http=3', 'Secure çerez düz HTTP ile gitmez');
  assert.equal(cookieHeader(jar, 'https://cdn.example.org/other'), 'wide=1; http=3; host=4');
  assert.equal(cookieHeader(jar, 'https://notexample.org/'), null, 'benzer görünen başka alan adı');
  assert.equal(cookiesForUrl(jar, 'https://www.example.org/').length, 2);
});

test('withCookie var olan Cookie başlığını değiştirir, yoksa eklemez', () => {
  const jar = sanitizeCookies([c('sid', 'abc')], [MEDIA]);
  assert.deepEqual(withCookie({ Referer: 'r', cookie: 'old=1' }, jar, MEDIA), { Referer: 'r', Cookie: 'sid=abc' });
  assert.deepEqual(withCookie({ Referer: 'r', cookie: 'old=1' }, jar, 'https://other.test/'), { Referer: 'r' });
});

test('geçici yt-dlp çerez dosyası: Netscape biçimi, silinir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-jar-'));
  try {
    const file = writeCookieJar(sanitizeCookies([c('sid', 'abc', { expires: Math.floor(Date.now() / 1000) + 5000 }), c('h', 'v', { domain: 'cdn.example.org', hostOnly: true, secure: false })], [MEDIA]), dir);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines[0], '# Netscape HTTP Cookie File');
    assert.match(lines[1], /^\.example\.org\tTRUE\t\/\tTRUE\t\d+\tsid\tabc$/);
    assert.match(lines[2], /^cdn\.example\.org\tFALSE\t\/\tFALSE\t\d+\th\tv$/);
    removeCookieJar(file); assert.equal(fs.existsSync(file), false);
    assert.equal(writeCookieJar([], dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture(t, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-session-test-'));
  fs.mkdirSync(path.join(root, 'tools')); fs.writeFileSync(path.join(root, 'tools', 'yt-dlp.exe'), '');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools'), ...extra });
  queue.run = () => new Promise(() => {});
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { queue, root };
}

test('çerezle çözülen adres 403 verirse yeniden deneme çerezsiz yapılır (bazı kaynaklar)', async t => {
  const { queue } = fixture(t);
  const job = { id: 'job-1', engine: 'extractor' };
  queue.sessions.set(job.id, [{ name: 'SID', value: 'x', domain: 'example.org', path: '/', secure: true }]);
  const seen = [];
  queue.runAttempt = async () => { seen.push(queue.jobCookies(job).length); if (seen.length === 1) throw new SourceExpiredError('HTTP 403'); };
  await DownloadQueue.prototype.run.call(queue, job, new AbortController().signal);
  assert.deepEqual(seen, [1, 0], 'ilk deneme çerezli, yenileme çerezsiz');
  assert.equal(queue.sessions.get(job.id).length, 1, 'oturum silinmez; yalnızca bu işin yeniden denemesinde kullanılmaz');
});

test('seçilen kalite başka kimlikle sunulursa aynı görüntü (boyut/fps) bulunur; farklı boyuta geçilmez', async t => {
  const formats = [
    { format_id: '299', ext: 'mp4', vcodec: 'avc1.64002a', acodec: 'none', height: 1080, fps: 60, protocol: 'https', tbr: 4000 },
    { format_id: '298', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, fps: 60, protocol: 'https', tbr: 2000 },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'https', abr: 128 }
  ];
  const calls = [];
  const infoExtractor = async ({ formatId }) => {
    calls.push(formatId);
    if (formatId === '308+251-drc' || formatId === '137+140') throw new Error('Uygun indirilebilir format bulunamadı.');
    return { formats, duration: 60, title: 'x' };
  };
  const { queue } = fixture(t, { infoExtractor });
  fs.writeFileSync(path.join(queue.toolsDirectory, 'ffmpeg.exe'), '');
  const signal = new AbortController().signal;
  const same = { id: 'a', url: 'https://example.org/v', quality: 'best', formatId: '308+251-drc', formatLabel: '1080p60 · WEBM · VP9' };
  const found = await queue.findSameQuality(same, (id, jar) => infoExtractor({ formatId: id }), null, signal);
  assert.equal(found.id, '299+140'); // 1080p60 stays 1080p60, other codec/container is acceptable
  const gone = { id: 'b', url: 'https://example.org/v', quality: 'best', formatId: '137+140', formatSlot: { height: 1440, fps: 60, hdr: false, ext: 'webm', codec: 'VP9' } };
  assert.equal(await queue.findSameQuality(gone, (id, jar) => infoExtractor({ formatId: id }), null, signal), null, '1440p yoksa 1080p verilmez');
});

test('doğrudan dosya incelemesi çerezle yapılır ve indirmeye bellekten aktarılır; diske yazılmaz', async t => {
  const seen = [];
  const { queue, root } = fixture(t, { remoteOpener: async (url, signal, redirects, headers) => { seen.push(headers); return { url: new URL(url), response: Object.assign(Readable.from([Buffer.from('not-an-hls-video-body')]), { headers: { 'content-type': 'video/mp4', 'content-length': '123456' } }) }; } });
  const url = 'https://cdn.example.org/v/movie.mp4';
  const info = await queue.inspect({ url, engine: 'direct', referer: PAGE, pageUrl: PAGE, cookies: [c('sid', 'TOPSECRET'), c('other', 'zzz', { domain: 'evil.test' })] });
  assert.equal(seen[0].Cookie, 'sid=TOPSECRET'); assert.equal(info.sessionUsed, true);
  const id = queue.add({ url, engine: 'direct', referer: PAGE });
  const job = queue.jobs.find(j => j.id === id);
  assert.equal(queue.requestHeaders(job, url).Cookie, 'sid=TOPSECRET');
  assert.equal(queue.requestHeaders(job, 'https://elsewhere.test/x').Cookie, undefined, 'başka alan adına gitmez');
  const saved = fs.readFileSync(path.join(root, 'queue.json'), 'utf8');
  assert.ok(!saved.includes('TOPSECRET') && !JSON.stringify(queue.list()).includes('TOPSECRET') && !JSON.stringify(info).includes('TOPSECRET'), 'çerez kuyruk dosyasında veya yanıtlarda görünmemeli');
  queue.batch('cancel', { ids: [id] });
  assert.equal(queue.sessions.has(id), false, 'iptalde çerez silinir');
});

test('çerez gövdeden eklenemez; yalnızca aynı adresin son incelemesinden gelir', t => {
  const { queue } = fixture(t);
  const url = 'https://cdn.example.org/v/a.mp4';
  const id = queue.add({ url, engine: 'direct', cookies: [c('sid', 'forged')] });
  assert.equal(queue.sessions.has(id), false);
  queue.rememberOffered('https://cdn.example.org/v/b.mp4', [], sanitizeCookies([c('sid', 'x')], [url]));
  const other = queue.add({ url, engine: 'direct' });
  assert.equal(queue.sessions.has(other), false, 'başka adresin çerezi kullanılmaz');
});

test('giriş gerektiren kaynak: çerezsiz 403, eklentiden gelen çerezle uçtan uca indirilir', async t => {
  const body = Buffer.alloc(300000, 7);
  const seen = [];
  const server = async (url, signal, headers) => {
    seen.push(headers.Cookie || null);
    const reply = (statusCode, headers2, chunks) => ({ url: new URL(url), response: Object.assign(Readable.from(chunks), { statusCode, headers: headers2 }) });
    if (headers.Cookie !== 'sid=ok') return reply(403, {}, []);
    const match = /bytes=(\d+)-(\d*)/.exec(headers.Range || '');
    if (!match) return reply(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'accept-ranges': 'bytes' }, [body]);
    const start = Number(match[1]), end = Math.min(Number(match[2] || body.length - 1), body.length - 1);
    return reply(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' }, [body.subarray(start, end + 1)]);
  };
  const { queue, root } = fixture(t, { rangeRequest: server, remoteOpener: server });
  queue.run = DownloadQueue.prototype.run.bind(queue);
  const url = 'https://cdn.example.org/files/data.bin';
  const anonymous = queue.add({ url, engine: 'direct' });
  for (let i = 0; i < 300 && queue.active.size; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(queue.jobs.find(j => j.id === anonymous).status, 'failed', 'çerezsiz istek reddedilmeli');
  queue.rememberOffered(url, [], sanitizeCookies([c('sid', 'ok', { secure: true })], [url]));
  const id = queue.add({ url: `${url}?again`, engine: 'direct' });
  assert.equal(queue.sessions.has(id), false, 'farklı adres çerez devralmaz');
  queue.rememberOffered(`${url}?again`, [], sanitizeCookies([c('sid', 'ok')], [url]));
  const withSession = queue.add({ url: `${url}?again`, engine: 'direct' });
  for (let i = 0; i < 500 && queue.active.size; i++) await new Promise(r => setTimeout(r, 10));
  const job = queue.jobs.find(j => j.id === withSession);
  assert.equal(job.status, 'completed', job.error || '');
  assert.ok(seen.includes('sid=ok'));
  assert.equal(job.file, 'video.bin', 'son dosya iç kimlik değil, başlığıyla kaydedilir (başlık verilmediği için varsayılan)');
  assert.equal(fs.statSync(path.join(root, 'downloads', job.file)).size, body.length);
  assert.equal(queue.sessions.has(withSession), false, 'tamamlanınca çerez bellekten silinir');
  assert.ok(!fs.readFileSync(path.join(root, 'queue.json'), 'utf8').includes('sid=ok'));
});

test('yt-dlp çözümleyiciye çerez geçici dosyayla verilir ve iş bitince silinir', async t => {
  let during = null, file = null;
  const { queue } = fixture(t, { infoExtractor: async input => { file = input.cookieFile; during = fs.readFileSync(file, 'utf8'); throw new Error('stop'); } });
  queue.run = DownloadQueue.prototype.run.bind(queue);
  const url = 'https://cdn.example.org/v/page';
  queue.rememberOffered(url, [], sanitizeCookies([c('sid', 'JARVALUE')], [url]));
  const id = queue.add({ url, engine: 'extractor' });
  // Wait for the condition itself (extractor called and the job settled), not a fixed delay: the full suite runs under load.
  for (let i = 0; i < 600 && (during === null || queue.active.size); i++) await new Promise(r => setTimeout(r, 10));
  assert.match(during, /sid\tJARVALUE/);
  assert.equal(fs.existsSync(file), false, 'çerez dosyası silinmeli');
  assert.ok(!JSON.stringify(queue.list()).includes('JARVALUE'));
  assert.ok(id);
});
