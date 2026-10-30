import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';
import { moveVisible } from '../public/queue-state.js';

function fixture(t, limit = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-priority-'));
  const config = { directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root };
  const queue = new DownloadQueue(config), workers = new Map(), starts = [];
  queue.setSettings({ queueLimit: limit });
  queue.run = (job, signal) => new Promise((resolve, reject) => {
    assert.equal(workers.has(job.id), false, 'aynı dosyada iki worker olamaz');
    starts.push(job.id); workers.set(job.id, resolve);
    signal.addEventListener('abort', () => setTimeout(() => { workers.delete(job.id); reject(signal.reason); }, 25), { once: true });
  });
  queue.finalizeName = () => {};
  t.after(async () => { queue.stop(); for (const finish of workers.values()) finish(); await wait(70); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (name, start = 'now') => queue.add({ url: `https://example.org/${name}.bin`, title: name, engine: 'direct', start });
  const finish = async id => { const resolve = workers.get(id); workers.delete(id); resolve(); await wait(15); };
  const running = () => queue.jobs.filter(job => job.status === 'running').map(job => job.id);
  return { queue, add, finish, running, starts, config };
}
for (const limit of [1, 2, 'all']) test(`tümünü sürdür ve tekli sürdür genel ${limit} sınırına uyar`, async t => {
  const { queue, add, running, finish } = fixture(t, limit);
  const ids = ['a', 'b', 'c'].map(name => add(name));
  queue.batch('pause', { all: true }); await wait(45);
  assert.deepEqual(running(), []);
  queue.batch('resume', { all: true });
  assert.deepEqual(running(), ids.slice(0, limit === 'all' ? 3 : limit));
  if (limit === 1) {
    await finish(ids[0]); assert.deepEqual(running(), [ids[1]]);
    await finish(ids[1]); assert.deepEqual(running(), [ids[2]]);
  }
});
test('ikinci video en üste taşınınca birinci güvenle durur, ikinci başlar, birinci sonra devam eder', async t => {
  const { queue, add, running, starts, finish } = fixture(t);
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(name));
  const original = queue.jobs.find(job => job.id === a);
  original.received = 1234; fs.writeFileSync(path.join(queue.directory, `${a}.parallel.part`), 'partial-data');
  queue.reorder([b, a, c]);
  assert.deepEqual(running(), []);
  assert.equal(queue.active.has(a), true, 'kapanan worker yeri hâlâ tutar');
  assert.deepEqual(starts, [a], 'eski worker çıkmadan yenisi başlamaz');
  await wait(45); assert.deepEqual(running(), [b]);
  assert.equal(original.received, 1234);
  assert.equal(fs.readFileSync(path.join(queue.directory, `${a}.parallel.part`), 'utf8'), 'partial-data');
  await finish(b); assert.deepEqual(running(), [a]);
  await finish(a); assert.deepEqual(running(), [c]);
  assert.deepEqual(queue.jobs.map(job => job.id), [b, a, c]);
});
test('N sınırında yalnızca öncelikten çıkan worker durur; Hepsi sıralaması kesinti yapmaz', async t => {
  const { queue, add, running } = fixture(t, 2);
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(name));
  const aController = queue.active.get(a);
  queue.reorder([c, a, b]); await wait(45);
  assert.deepEqual(running(), [c, a]); assert.equal(queue.active.get(a), aController);
  queue.setSettings({ queueLimit: 'all' });
  const controllers = new Map(queue.active);
  queue.reorder([b, a, c]);
  assert.deepEqual(running(), [b, a, c]);
  for (const [id, controller] of controllers) assert.equal(queue.active.get(id), controller);
});
test('hızlı ters taşıma ve sınır azaltma kapanan workerı iki kez başlatmaz', async t => {
  const { queue, add, running } = fixture(t, 'all');
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(name));
  queue.setSettings({ queueLimit: 1 });
  queue.reorder([b, a, c]); queue.reorder([a, c, b]);
  assert.equal(queue.active.size, 3, 'önce mevcut süreçlerin güvenli kapanışı beklenir');
  await wait(55); assert.deepEqual(running(), [a]); assert.equal(queue.active.size, 1);
});
test('elle duraklatılan ve Sonra ekle işleri taşımak onları başlatmaz', async t => {
  const { queue, add, running } = fixture(t);
  const a = add('a'), b = add('b'), held = add('held', 'queue');
  queue.pause(b); queue.reorder([b, held, a]);
  await wait(35); assert.deepEqual(running(), [a]);
  assert.equal(queue.jobs[0].status, 'paused'); assert.equal(queue.jobs[1].status, 'held');
  queue.startNow(held); await wait(45); assert.deepEqual(running(), [held]);
  assert.equal(queue.jobs[0].status, 'paused');
});
test('filtreli taşıma gizli satırları korur, sıra kaydedilir ve yeniden açılış indirme başlatmaz', t => {
  const { queue, add, config } = fixture(t);
  const [a, hidden, b] = ['a', 'hidden', 'b'].map(name => add(name, 'queue'));
  queue.jobs.find(job => job.id === hidden).status = 'completed';
  const ids = moveVisible(queue.jobs, 'running', b, a);
  assert.deepEqual(ids, [b, hidden, a]); queue.reorder(ids);
  const reopened = new DownloadQueue(config);
  assert.deepEqual(reopened.jobs.map(job => job.id), ids); assert.equal(reopened.active.size, 0); reopened.stop();
  assert.throws(() => queue.reorder([a, a]));
  assert.throws(() => queue.reorder(['00000000-0000-0000-0000-000000000000']));
});
