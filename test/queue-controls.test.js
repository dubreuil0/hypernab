import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { DownloadQueue } from '../src/downloads.js';
import { selectionState, visibleJobs } from '../public/queue-state.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-controls-test-'));
  const rangeRequest = async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) });
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root, rangeRequest, ...options });
  t.after(async () => { queue.stop(); await settled(queue); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function settled(queue) {
  for (let i = 0; i < 200; i++) { if (!queue.active.size) return; await wait(10); }
  throw new Error('Worker did not settle.');
}
async function writtenPartial(queue, bytes) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = fs.readdirSync(queue.directory).find(name => name.endsWith('.part'));
    if (name && fs.statSync(path.join(queue.directory, name)).size >= bytes) return;
    await wait(5);
  }
  throw new Error('Expected bytes were not written to the partial file.');
}
function job(status, extra = {}) { return { id: randomUUID(), url: 'https://example.com/a.mp4', engine: 'direct', title: 'Test', status, received: 0, speed: 0, ...extra }; }
function blocked(_job, signal) { return wait(10000, null, { signal }); }

test('kuyruk temizleme yalnızca bitmiş kayıtları siler, hiçbir dosyaya dokunmaz', t => {
  const queue = fixture(t);
  const completed = job('completed'), failed = job('failed'), cancelled = job('cancelled');
  const protectedJobs = ['running', 'queued', 'paused', 'interrupted'].map(status => job(status));
  const halfFailed = job('failed', { received: 50 }), halfCancelled = job('cancelled');
  completed.file = `${completed.id}-video.mp4`;
  fs.writeFileSync(path.join(queue.directory, completed.file), 'completed bytes');
  fs.writeFileSync(path.join(queue.directory, `${halfCancelled.id}.f137.mp4.part`), 'half bytes');
  queue.jobs = [completed, failed, cancelled, ...protectedJobs, halfFailed, halfCancelled];
  queue.active.set(protectedJobs[0].id, new AbortController());
  const before = fs.readdirSync(queue.directory).map(name => [name, fs.readFileSync(path.join(queue.directory, name)).toString('hex')]);
  const result = queue.clearFinished();
  assert.equal(result.removed, 4);
  assert.deepEqual(queue.jobs.map(j => j.id), [...protectedJobs, halfFailed].map(j => j.id));
  assert.deepEqual(fs.readdirSync(queue.directory).map(name => [name, fs.readFileSync(path.join(queue.directory, name)).toString('hex')]), before);
  queue.active.clear();
});
test('seçili temizleme kapsam dışındaki bitmiş kayıtları da korur', t => {
  const queue = fixture(t), first = job('completed'), second = job('completed'), partial = job('paused');
  queue.jobs = [first, second, partial];
  const result = queue.clearFinished({ ids: [first.id, partial.id] });
  assert.deepEqual(result.removedIds, [first.id]);
  assert.deepEqual(queue.jobs.map(j => j.id), [second.id, partial.id]);
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).length, 2);
});
test('yarım dosyalı iptal kaydı seçilerek kaldırılabilir; dosya byte’ları korunur', t => {
  const queue = fixture(t), cancelled = job('cancelled', { received: 123 }), paused = job('paused', { received: 123 });
  const partial = path.join(queue.directory, `${cancelled.id}-video.mp4.part`);
  fs.writeFileSync(partial, 'keep exactly these partial bytes'); queue.jobs = [cancelled, paused];
  assert.equal(queue.list().find(j => j.id === cancelled.id).canClear, true);
  assert.deepEqual(queue.clearFinished({ ids: [cancelled.id, paused.id] }).removedIds, [cancelled.id]);
  assert.equal(fs.readFileSync(partial, 'utf8'), 'keep exactly these partial bytes');
  assert.deepEqual(queue.jobs.map(j => j.id), [paused.id]);
});
test('başarısız yarım iş açıkça iptal edilince kaydı kaldırılabilir', t => {
  const queue = fixture(t), failed = job('failed', { received: 10 }); queue.jobs = [failed];
  assert.equal(queue.list()[0].canClear, false); queue.cancel(failed.id);
  assert.equal(queue.list()[0].canClear, true); assert.equal(queue.clearFinished().removed, 1);
});
test('iptal edilmiş ama worker kapanmamış kayıt temizlenmez', t => {
  const queue = fixture(t), entry = job('cancelled'); queue.jobs = [entry]; queue.active.set(entry.id, new AbortController());
  assert.equal(queue.list()[0].canClear, false); assert.equal(queue.clearFinished().removed, 0);
  queue.active.clear(); assert.equal(queue.clearFinished().removed, 1);
});
test('tümünü duraklat yalnızca mevcut aktif ve sıradaki işleri durdurur; sonradan eklenen iş başlar', async t => {
  const queue = fixture(t, { concurrency: 1 }); queue.run = blocked;
  const first = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  const second = queue.add({ url: 'https://example.com/b', engine: 'direct' });
  assert.equal(queue.batch('pause', { all: true }).changed, 2); await settled(queue);
  assert.ok(queue.jobs.every(j => j.status === 'paused'));
  assert.equal('schedulingPaused' in queue, false, 'kalıcı genel duraklatma modu kalmamalı');
  const third = queue.add({ url: 'https://example.com/c', engine: 'direct' });
  assert.equal(queue.jobs.find(j => j.id === third).status, 'running'); assert.equal(queue.active.size, 1);
  assert.equal(queue.jobs.find(j => j.id === first).status, 'paused'); assert.equal(queue.jobs.find(j => j.id === second).status, 'paused');
  // Pressing it again only touches the new job; the old ones stay paused and can be resumed independently.
  const again = queue.batch('pause', { all: true }); assert.equal(again.changed, 1); await settled(queue);
  assert.ok(queue.jobs.every(j => j.status === 'paused'));
});
test('duraklatılmış işler varken tekrar denenen iş de bekletilmez', async t => {
  const queue = fixture(t, { concurrency: 1 }); queue.run = blocked;
  const paused = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  queue.batch('pause', { all: true }); await settled(queue);
  const failed = job('failed'); queue.jobs.push(failed);
  queue.retry(failed.id);
  assert.equal(queue.jobs.find(j => j.id === failed.id).status, 'running');
  assert.equal(queue.jobs.find(j => j.id === paused).status, 'paused');
});
test('seçili duraklat diğer işleri etkilemez, seçili devam yalnızca seçileni çalıştırır', async t => {
  const queue = fixture(t, { concurrency: 1 }); queue.run = blocked;
  const first = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  const second = queue.add({ url: 'https://example.com/b', engine: 'direct' });
  queue.batch('pause', { ids: [second] });
  assert.equal(queue.jobs.find(j => j.id === first).status, 'running');
  assert.equal(queue.jobs.find(j => j.id === second).status, 'paused');
  queue.batch('pause', { all: true }); await settled(queue);
  queue.batch('resume', { ids: [second] });
  assert.equal(queue.jobs.find(j => j.id === second).status, 'running');
  assert.equal(queue.jobs.find(j => j.id === first).status, 'paused');
  queue.batch('pause', { all: true }); await settled(queue);
});
test('duraklatma kapanırken devam et tıklanırsa iki worker aynı dosyaya yazmaz', async t => {
  const queue = fixture(t); let calls = 0, simultaneous = 0, maximum = 0;
  queue.run = async (_job, signal) => {
    calls++; simultaneous++; maximum = Math.max(maximum, simultaneous);
    try { if (calls === 1) await wait(10000, null, { signal }); }
    finally { await wait(15); simultaneous--; }
  };
  const id = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  queue.pause(id); queue.resume(id);
  assert.equal(queue.jobs[0].resumeRequested, true); await settled(queue);
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(queue.jobs[0].status, 'completed');
});
test('toplu iptal yalnızca seçili uygun işleri etkiler ve kayıtları silmez', async t => {
  const queue = fixture(t); queue.run = blocked;
  const first = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  const second = queue.add({ url: 'https://example.com/b', engine: 'direct' });
  const done = job('completed'); queue.jobs.push(done);
  const result = queue.batch('cancel', { ids: [first, done.id] });
  assert.equal(result.changed, 1); assert.equal(result.skipped, 1);
  assert.equal(queue.jobs.find(j => j.id === second).status, 'running');
  assert.equal(queue.jobs.find(j => j.id === first).status, 'cancelled'); assert.equal(queue.jobs.length, 3);
  queue.batch('pause', { all: true }); await settled(queue);
});
test('duraklatılmış kayıtlar yeniden açılışta korunur; eski genel duraklatma dosyası yeni işleri bekletmez', async t => {
  const queue = fixture(t); queue.run = blocked;
  const id = queue.add({ url: 'https://example.com/a', engine: 'direct' });
  queue.batch('pause', { all: true }); await settled(queue);
  // Leftover from versions that had a sticky queue-wide pause must be ignored.
  fs.writeFileSync(`${queue.stateFile}.control.json`, JSON.stringify({ paused: true }));
  const loaded = new DownloadQueue({ directory: queue.directory, stateFile: queue.stateFile, toolsDirectory: queue.toolsDirectory });
  assert.equal(loaded.capabilities().queuePaused, undefined);
  assert.equal(loaded.jobs.find(j => j.id === id).status, 'paused'); assert.equal(loaded.active.size, 0);
  loaded.run = blocked;
  const next = loaded.add({ url: 'https://example.com/b', engine: 'direct' });
  assert.equal(loaded.jobs.find(j => j.id === next).status, 'running');
  loaded.stop(); await settled(loaded);
});
test('hatalı veya belirsiz toplu istek sessizce tüm işleri hedeflemez', t => {
  const queue = fixture(t); const entry = job('paused'); queue.jobs = [entry];
  assert.throws(() => queue.batch('cancel', {}));
  assert.throws(() => queue.batch('cancel', { ids: [entry.id], all: true }));
  assert.throws(() => queue.batch('cancel', { ids: ['not-an-id'] }));
  assert.throws(() => queue.clearFinished({ ids: 'all' }));
  assert.equal(entry.status, 'paused');
});
test('doğrudan dosya duraklatılınca yazılmış byte’lar korunur', async t => {
  const queue = fixture(t, { remoteOpener: async (_url, signal) => {
    const response = Readable.from((async function* () { yield Buffer.from('first'); await wait(10000, null, { signal }); yield Buffer.from('last'); })());
    response.headers = { 'content-type': 'video/mp4', 'content-length': '9' };
    return { response, url: new URL('https://example.com/a.mp4') };
  }});
  const id = queue.add({ url: 'https://example.com/a.mp4', engine: 'direct' });
  await writtenPartial(queue, 5);
  queue.pause(id); await settled(queue);
  assert.equal(queue.jobs[0].status, 'paused'); assert.equal(queue.jobs[0].received, 5);
  const file = fs.readdirSync(queue.directory).find(name => name.endsWith('.part'));
  assert.equal(fs.readFileSync(path.join(queue.directory, file), 'utf8'), 'first');
  assert.equal(queue.clearFinished().removed, 0);
});
test('tümünü seç görünür listeyle sınırlıdır ve karma checkbox durumu doğru hesaplanır', () => {
  const jobs = [job('completed', { canClear: true }), job('running'), job('paused')];
  const visible = visibleJobs(jobs, 'running'); assert.equal(visible.length, 2);
  let state = selectionState(jobs, visible, new Set([jobs[0].id, jobs[1].id]));
  assert.equal(state.mixed, true); assert.equal(state.all, false); assert.equal(state.hidden, 1);
  assert.equal(state.pause, 1); assert.equal(state.clear, 1);
  state = selectionState(jobs, visible, new Set(jobs.map(j => j.id)));
  assert.equal(state.all, true); assert.equal(state.resume, 1); assert.equal(state.cancel, 2);
});

test('doğrudan dosya devamında sayaç çift sayılmaz ve önceki parça silinmez', async t => {
  let attempt = 0;
  const queue = fixture(t, { remoteOpener: async (_url, signal) => {
    attempt++;
    const response = attempt === 1
      ? Readable.from((async function* () { yield Buffer.from('first'); await wait(10000, null, { signal }); yield Buffer.from('last'); })())
      : Readable.from([Buffer.from('firstlast')]);
    response.headers = { 'content-type': 'video/mp4', 'content-length': '9' };
    return { response, url: new URL('https://example.com/a.mp4') };
  }});
  const id = queue.add({ url: 'https://example.com/a.mp4', engine: 'direct' });
  await writtenPartial(queue, 5);
  queue.pause(id); await settled(queue); queue.resume(id); await settled(queue);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(queue.jobs[0].received, 9);
  const previous = fs.readdirSync(queue.directory).find(name => name.includes('.part.previous-'));
  assert.equal(fs.readFileSync(path.join(queue.directory, previous), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(queue.directory, queue.jobs[0].file), 'utf8'), 'firstlast');
  assert.match(queue.jobs[0].notice, /baştan/);
});
test('tümünü devam ettir duraklatılmış işleri çalıştırır; iş yoksa güvenle hiçbir şey yapmaz', async t => {
  const queue = fixture(t); queue.run = blocked;
  assert.equal(queue.batch('resume', { all: true }).changed, 0);
  assert.equal(queue.batch('pause', { all: true }).changed, 0);
  queue.add({ url: 'https://example.com/a', engine: 'direct' }); queue.add({ url: 'https://example.com/b', engine: 'direct' });
  queue.batch('pause', { all: true }); await settled(queue);
  queue.run = async () => {};
  const result = queue.batch('resume', { all: true }); await settled(queue);
  assert.equal(result.changed, 2);
  assert.ok(queue.jobs.every(j => j.status === 'completed'));
});

test('a cancelled download discards its half-written files; a paused one keeps them; a finished file is never touched', async t => {
  const queue = fixture(t), dir = queue.directory; fs.mkdirSync(dir, { recursive: true });
  const pieces = id => [`${id}-Film.mp4.parallel.part`, `${id}-Film.mp4.ranges.json`, `${id}.f137.mp4.part`];
  const write = id => { for (const name of pieces(id)) fs.writeFileSync(path.join(dir, name), 'half'); fs.mkdirSync(path.join(dir, `${id}.native-stage`)); fs.writeFileSync(path.join(dir, `${id}.native-stage`, 'a.ts'), 'half'); };
  const unrelated = path.join(dir, 'Holiday.mp4'); fs.writeFileSync(unrelated, 'mine');
  const paused = job('paused', { received: 50 }), cancelledPaused = job('paused', { received: 50 }), cancelledFailed = job('failed', { received: 5 });
  const finished = job('paused', { received: 9 }); finished.file = `${finished.id}-Done.mp4`; // a complete file that carries the job id
  for (const j of [paused, cancelledPaused, cancelledFailed, finished]) write(j.id);
  fs.writeFileSync(path.join(dir, finished.file), 'complete');
  queue.jobs = [paused, cancelledPaused, cancelledFailed, finished];
  queue.cancel(cancelledPaused.id); queue.cancel(cancelledFailed.id); queue.cancel(finished.id);
  for (const j of [cancelledPaused, cancelledFailed, finished]) { for (const name of pieces(j.id)) assert.equal(fs.existsSync(path.join(dir, name)), false, name); assert.equal(fs.existsSync(path.join(dir, `${j.id}.native-stage`)), false); }
  assert.equal(fs.readFileSync(path.join(dir, finished.file), 'utf8'), 'complete', 'a finished file is never touched');
  for (const name of pieces(paused.id)) assert.equal(fs.existsSync(path.join(dir, name)), true, `paused keeps ${name}`);
  assert.equal(fs.existsSync(path.join(dir, `${paused.id}.native-stage`)), true);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'mine', 'files of other downloads are never touched');
});

test('cancelling a running download discards its pieces once the worker has stopped', async t => {
  const queue = fixture(t), dir = queue.directory; fs.mkdirSync(dir, { recursive: true });
  queue.run = blocked; const running = job('queued'); queue.jobs = [running]; queue.launch(running);
  const piece = path.join(dir, `${running.id}-Film.mp4.parallel.part`); fs.writeFileSync(piece, 'half');
  queue.cancel(running.id); await settled(queue);
  assert.equal(running.status, 'cancelled'); assert.equal(fs.existsSync(piece), false);
});

test('pieces left by an older version for an already cancelled download are removed at the next start', t => {
  const queue = fixture(t), dir = queue.directory; fs.mkdirSync(dir, { recursive: true });
  const old = job('cancelled', { received: 7 }), piece = path.join(dir, `${old.id}-Film.mp4.parallel.part`); fs.writeFileSync(piece, 'half');
  queue.jobs = [old]; queue.save(); queue.stop();
  const next = new DownloadQueue({ directory: dir, stateFile: queue.stateFile, toolsDirectory: path.dirname(dir) });
  t.after(() => next.stop());
  assert.equal(fs.existsSync(piece), false);
});