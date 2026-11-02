import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { fileNameFor, parseDisposition, categoryFor, riskOf, verifyFileFormat, markFromInternet } from '../src/file-download.js';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-file-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const write = (root, name, data) => { const file = path.join(root, name); fs.writeFileSync(file, data); return file; };
const eocd = (cdSize, cdOffset) => { const b = Buffer.alloc(22); b.write('PK\u0005\u0006', 0, 'latin1'); b.writeUInt32LE(cdSize, 12); b.writeUInt32LE(cdOffset, 16); return b; };
const zipBytes = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('a.txt'), Buffer.from('hello'), Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(42), eocd(46, 35)]);

test('file names: browser choice leads, server and address follow; unsafe parts never survive', () => {
  assert.equal(fileNameFor({ hint: ['D:', 'Belgeler', 'Rapor 2026.pdf'].join('\\') }), 'Rapor 2026.pdf');
  assert.equal(fileNameFor({ disposition: 'attachment; filename="a/b\\c.zip"' }), 'c.zip');
  assert.equal(fileNameFor({ disposition: "attachment; filename*=UTF-8''%C5%9Fark%C4%B1%20kitap.pdf; filename=\"x.pdf\"" }), 'şarkı kitap.pdf');
  assert.equal(fileNameFor({ url: 'https://example.org/files/ara%C3%A7%20kutusu.7z?token=1' }), 'araç kutusu.7z');
  assert.equal(fileNameFor({ url: 'https://example.org/download', contentType: 'application/zip' }), 'download.zip');
  assert.equal(fileNameFor({ url: 'https://example.org/', contentType: 'application/octet-stream' }), 'dosya.bin');
  assert.equal(fileNameFor({ hint: 'CON.txt' }), '_CON.txt');
  assert.equal(fileNameFor({ hint: 'fatura\u202Egpj.exe' }), 'faturagpj.exe', 'right-to-left override is removed');
  assert.equal(fileNameFor({ hint: '..' , url: 'https://example.org/x.iso' }), 'x.iso');
  assert.ok(fileNameFor({ hint: `${'a'.repeat(300)}.zip` }).length <= 125);
  assert.equal(fileNameFor({ hint: 'setup.exe' }), 'setup.exe', 'program files keep their real extension');
  assert.equal(parseDisposition('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(parseDisposition(Buffer.from('attachment; filename="çay.txt"', 'utf8').toString('latin1')), 'çay.txt', 'raw UTF-8 sent as header bytes is repaired');
  assert.equal(parseDisposition('inline'), null);
});

test('category and risk hints depend on the file type only', () => {
  assert.deepEqual(categoryFor('a.ZIP'), { id: 'archive', label: 'Arşiv' });
  assert.equal(categoryFor('x', 'video/mp4').id, 'video'); assert.equal(categoryFor('x.unknown').id, 'other');
  assert.equal(riskOf('setup.exe'), 'program'); assert.equal(riskOf('run.ps1'), 'script'); assert.equal(riskOf('macro.docm'), 'script');
  assert.equal(riskOf('photo.jpg'), null); assert.equal(riskOf('archive.zip'), null);
});

test('structure check accepts real formats and rejects wrong, cut and page-instead-of-file bytes', async t => {
  const root = temp(t);
  assert.equal((await verifyFileFormat(write(root, 'ok.zip', zipBytes()), 'ok.zip')).format, 'zip');
  assert.equal((await verifyFileFormat(write(root, 'cut.zip', zipBytes().subarray(0, 60)), 'cut.zip').catch(e => e.message)).includes('ZIP'), true);
  await assert.rejects(verifyFileFormat(write(root, 'page.zip', '<!DOCTYPE html><html><body>Giriş yap</body></html>'), 'page.zip'), /web sayfası/);
  await assert.rejects(verifyFileFormat(write(root, 'rar.zip', Buffer.from('Rar!\u001a\u0007\u0000rest')), 'rar.zip'), /ZIP/);
  await assert.rejects(verifyFileFormat(write(root, 'empty.pdf', Buffer.alloc(0)), 'empty.pdf'), /boş/);
  await assert.rejects(verifyFileFormat(write(root, 'cd.zip', Buffer.concat([zipBytes().subarray(0, 40), eocd(500, 9000)])), 'cd.zip'), /bozuk|sınır/);
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  assert.equal((await verifyFileFormat(write(root, 'a.pdf', pdf), 'a.pdf')).format, 'pdf');
  await assert.rejects(verifyFileFormat(write(root, 'b.pdf', pdf.subarray(0, 20)), 'b.pdf', { sizeCompared: false }), /sonu eksik/);
  assert.equal((await verifyFileFormat(write(root, 'c.pdf', pdf.subarray(0, 20)), 'c.pdf', { sizeCompared: true })).status, 'passed', 'size already matched: only a note');
  const pe = Buffer.alloc(0x100); pe.write('MZ'); pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\u0000\u0000', 0x80, 'latin1');
  assert.equal((await verifyFileFormat(write(root, 's.exe', pe), 's.exe')).format, 'pe');
  await assert.rejects(verifyFileFormat(write(root, 'bad.exe', Buffer.from('MZ' + 'x'.repeat(200))), 'bad.exe'), /başlığ/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20), Buffer.from('IEND'), Buffer.alloc(4)]);
  assert.equal((await verifyFileFormat(write(root, 'i.png', png), 'i.png')).format, 'png');
  await assert.rejects(verifyFileFormat(write(root, 'j.png', png.subarray(0, 20)), 'j.png'), /sonu eksik/);
  assert.deepEqual(await verifyFileFormat(write(root, 'u.dat', 'anything'), 'u.dat'), { status: 'limited', format: null });
  assert.equal((await verifyFileFormat(write(root, 'n.html', '<html></html>'), 'n.html')).status, 'limited', 'a real web page is allowed to be html');
});

test('the internet-zone mark is written without the address and failures are harmless', t => {
  const root = temp(t), file = write(root, 'setup.exe', 'x');
  assert.equal(markFromInternet(file), true);
  assert.equal(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.equal(markFromInternet(path.join(root, 'missing', 'x.exe')), false);
});

// ---- Queue integration ----
const body = Buffer.concat([zipBytes(), Buffer.alloc(3 * 1024 * 1024, 7)]);
// The central directory must sit before the end record, so build a bigger valid zip around the payload.
const bigZip = (() => { const head = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('a.bin'), Buffer.alloc(3 * 1024 * 1024, 7)]); const cd = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(42)]); return Buffer.concat([head, cd, eocd(cd.length, head.length)]); })();
function queueFixture(t, { data = bigZip, mime = 'application/zip', headers = {}, ranges = true, status = 206, requests = [] } = {}) {
  const root = temp(t);
  const rangeRequest = async (url, signal, requestHeaders) => {
    signal?.throwIfAborted(); requests.push({ url, headers: requestHeaders });
    if (!ranges) return { response: Object.assign(Readable.from([]), { statusCode: 200, headers: { 'content-type': mime, ...headers } }), url: new URL(url) };
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(requestHeaders.Range); const start = Number(first), end = Number(last);
    return { response: Object.assign(Readable.from([data.subarray(start, end + 1)]), { statusCode: status, headers: { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), 'content-type': mime, etag: '"v1"', ...headers } }), url: new URL(url) };
  };
  const remoteOpener = async (url) => ({ response: Object.assign(Readable.from([data]), { statusCode: 200, headers: { 'content-type': mime, 'content-length': String(data.length), ...headers } }), url: new URL(url) });
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, rangeRequest, remoteOpener });
  t.after(async () => { queue.stop(); for (let i = 0; i < 300 && queue.active.size; i++) await wait(10); });
  return queue;
}
async function settled(queue) { for (let i = 0; i < 600; i++) { if (!queue.active.size && !queue.jobs.some(job => ['queued', 'running'].includes(job.status))) return; await wait(10); } throw new Error('Queue timeout'); }

test('takeFile: real name kept, parallel download, structure verified, marked, no video naming', async t => {
  const requests = [], queue = queueFixture(t, { requests, headers: { 'content-disposition': 'attachment; filename="Proje Dosyaları.zip"' } });
  const answer = await queue.takeFile({ url: 'https://files.example.org/get?id=42&sig=SECRET', fileName: '', referer: 'https://files.example.org/page', userAgent: 'UA/1', submissionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(answer.name, 'Proje Dosyaları.zip'); assert.equal(answer.category.id, 'archive'); assert.equal(answer.risk, null); assert.equal(answer.ranges, true);
  await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error); assert.equal(job.file, 'Proje Dosyaları.zip');
  assert.equal(job.verification.status, 'passed'); assert.equal(job.verification.format, 'zip'); assert.equal(job.verification.sizeCompared, true);
  assert.deepEqual(fs.readFileSync(path.join(queue.directory, job.file)), bigZip);
  assert.equal(fs.readFileSync(`${path.join(queue.directory, job.file)}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.doesNotMatch(JSON.stringify(job), /SECRET/); assert.equal(job.smartNames, false);
  assert.ok(requests.some(item => item.headers.Referer === 'https://files.example.org/page' && item.headers['User-Agent'] === 'UA/1'));
});

test('takeFile with sorting by type on: the finished file really lies in its type folder, verified and marked', async t => {
  const queue = queueFixture(t, { headers: { 'content-disposition': 'attachment; filename="Sirali.zip"' } });
  queue.setSettings({ sortByType: true });
  const answer = await queue.takeFile({ url: 'https://files.example.org/sorted', fileName: '', submissionId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(answer.directory, path.join(queue.directory, 'Archives'), 'the window shows the folder the file will go to');
  await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error);
  const file = path.join(queue.directory, 'Archives', 'Sirali.zip');
  assert.deepEqual(fs.readFileSync(file), bigZip); assert.equal(job.verification.status, 'passed');
  assert.equal(fs.existsSync(path.join(queue.directory, 'Sirali.zip')), false, 'nothing is left in the main folder');
  assert.equal(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n');
});

test('takeFile: name collisions get a number and never overwrite; resubmitting the same id adds nothing', async t => {
  const queue = queueFixture(t), id = '22222222-2222-4222-8222-222222222222';
  fs.mkdirSync(queue.directory, { recursive: true }); fs.writeFileSync(path.join(queue.directory, 'veri.zip'), 'ESKI');
  const first = await queue.takeFile({ url: 'https://files.example.org/a', fileName: 'veri.zip', submissionId: id });
  const again = await queue.takeFile({ url: 'https://files.example.org/a', fileName: 'veri.zip', submissionId: id, allowDuplicate: true });
  assert.equal(first.id, again.id); assert.equal(queue.jobs.length, 1);
  await settled(queue);
  assert.equal(fs.readFileSync(path.join(queue.directory, 'veri.zip'), 'utf8'), 'ESKI'); assert.equal(queue.jobs[0].file, 'veri (2).zip');
});

test('takeFile: duplicates are reported unless the user insists; held files wait in the queue', async t => {
  const queue = queueFixture(t);
  await queue.takeFile({ url: 'https://files.example.org/b', fileName: 'b.zip', start: 'queue' });
  assert.equal(queue.jobs[0].status, 'held');
  await assert.rejects(queue.takeFile({ url: 'https://files.example.org/b', fileName: 'b.zip' }), error => error.code === 'duplicate' && error.duplicates.length === 1);
  await queue.takeFile({ url: 'https://files.example.org/b', fileName: 'b.zip', allowDuplicate: true, start: 'queue' });
  assert.equal(queue.jobs.length, 2);
});

test('takeFile: pages, streams and refused access create nothing', async t => {
  let queue = queueFixture(t, { mime: 'text/html; charset=utf-8', data: Buffer.from('<html>login</html>') });
  await assert.rejects(queue.takeFile({ url: 'https://files.example.org/c', fileName: 'c.zip' }), error => error.code === 'NOT_A_FILE');
  queue = queueFixture(t, { mime: 'application/vnd.apple.mpegurl', data: Buffer.from('#EXTM3U') });
  await assert.rejects(queue.takeFile({ url: 'https://files.example.org/d.m3u8' }), error => error.code === 'NOT_A_FILE');
  assert.equal(queue.jobs.length, 0);
  queue = queueFixture(t, { ranges: false });
  queue.rangeRequest = async () => ({ response: Object.assign(Readable.from([]), { statusCode: 403, headers: {} }) });
  await assert.rejects(queue.takeFile({ url: 'https://files.example.org/e', fileName: 'e.zip' }), error => error.code === 'ACCESS_DENIED');
  assert.equal(queue.jobs.length, 0);
  await assert.rejects(queue.takeFile({ url: 'file:///C:/secret.txt' }), /./); await assert.rejects(queue.takeFile({ url: 'http://127.0.0.1:17846/api/jobs' }), /./);
});

test('takeFile: a server without byte ranges still downloads on one connection and is verified', async t => {
  const queue = queueFixture(t, { ranges: false });
  const answer = await queue.takeFile({ url: 'https://files.example.org/f', fileName: 'f.zip' });
  assert.equal(answer.ranges, false); assert.equal(answer.total, bigZip.length);
  await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'completed', job.error); assert.equal(job.transfer.method, 'single-http'); assert.equal(job.verification.format, 'zip');
});

test('takeFile: the job reuses the first look at the source instead of probing it a second time', async t => {
  const requests = [], queue = queueFixture(t, { requests });
  await queue.takeFile({ url: 'https://files.example.org/once', fileName: 'once.zip' });
  await settled(queue);
  assert.equal(queue.list()[0].status, 'completed');
  assert.equal(requests.filter(item => item.headers.Range === 'bytes=0-0').length, 1, 'probe repeated');
  const plain = [], other = queueFixture(t, { ranges: false, requests: plain });
  await other.takeFile({ url: 'https://files.example.org/plain', fileName: 'plain.zip' });
  await settled(other);
  assert.equal(other.list()[0].status, 'completed'); assert.equal(plain.length, 1, 'a source known to have no ranges is not asked again');
});

test('a login page saved as an archive fails verification and is never published or marked complete', async t => {
  const queue = queueFixture(t, { ranges: false, mime: 'application/zip', data: Buffer.from('<!DOCTYPE html><html><body>Oturum süresi doldu</body></html>') });
  await queue.takeFile({ url: 'https://files.example.org/g', fileName: 'g.zip' });
  await settled(queue);
  const [job] = queue.list(); assert.equal(job.status, 'failed'); assert.match(job.error || '', /web sayfası/);
  assert.equal(fs.existsSync(path.join(queue.directory, 'g.zip')), false);
});

test('cookies for a taken-over file stay in memory only and never reach the saved state or the API view', async t => {
  const queue = queueFixture(t, { requests: [] }), seen = [];
  const original = queue.rangeRequest; queue.rangeRequest = async (url, signal, headers) => { seen.push(headers.Cookie || ''); return original(url, signal, headers); };
  await queue.takeFile({ url: 'https://files.example.org/h', fileName: 'h.zip', referer: 'https://files.example.org/', cookies: [{ name: 'sid', value: 'COOKIEVALUE', domain: 'files.example.org', path: '/', hostOnly: true }, { name: 'other', value: 'NO', domain: 'elsewhere.example.net', path: '/' }] });
  await settled(queue);
  assert.ok(seen.some(value => value.includes('sid=COOKIEVALUE')) && seen.every(value => !value.includes('NO')));
  assert.doesNotMatch(JSON.stringify(queue.list()), /COOKIEVALUE/); assert.doesNotMatch(fs.readFileSync(queue.stateFile, 'utf8'), /COOKIEVALUE/);
});
