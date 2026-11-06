import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../src/downloads.js';

// A queue whose downloads are gates the test opens by hand: no network, no files.
function fixture(t, root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-queue-order-'))) {
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true }); fs.writeFileSync(path.join(root, 'tools', 'yt-dlp.exe'), '');
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools') });
  const gates = new Map();
   queue.run = (job, signal) => new Promise((resolve, reject) => {
     gates.set(job.id, resolve);
     signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 10), { once: true });
   });
  queue.finalizeName = () => {};
  roots.push(root); cleanups.push(() => { queue.stop(); for (const open of gates.values()) open(); });
  return { queue, gates, root };
}
const roots = [], cleanups = [];
test.after(async () => { for (const clean of cleanups) clean(); await wait(150); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }); // let late saves land first
const add = (queue, name, start) => queue.add({ url: `https://files.example.org/${name}.bin`, engine: 'direct', title: name, ...(start ? { start } : {}) });
const status = (queue, id) => queue.jobs.find(job => job.id === id).status;
const finish = async (queue, gates, id) => { gates.get(id)(); await wait(20); };

 test('varsayılan Hepsi: basıldıkça hepsi aynı anda başlar', () => {
   const { queue } = fixture(test);
   assert.equal(queue.settings.queueLimit, 'all');
  const ids = Array.from({ length: 12 }, (_, i) => add(queue, `d${i}`));
  assert.ok(ids.every(id => status(queue, id) === 'running'));
  assert.equal(queue.active.size, 12);
});

test('sıraya ekle: bekler, sıra numarası verir, kuyruk başlatılmadan hiçbir şey başlamaz', () => {
  const { queue } = fixture(test);
  const a = add(queue, 'a', 'queue'), b = add(queue, 'b', 'queue'), c = add(queue, 'c', 'queue');
  assert.deepEqual([a, b, c].map(id => status(queue, id)), ['held', 'held', 'held']);
  assert.deepEqual(queue.jobs.map(job => job.id), [a, b, c], 'liste ilk eklenen üstte; sıra numarası alanı yok');
  assert.equal(queue.list().some(job => 'queuePosition' in job), false);
  assert.equal(queue.active.size, 0);
});

test('Hepsini sürdür: sınır 1 iken sonra için eklenenler teker teker, sırayla başlar; sonradan eklenen yine hemen başlamaz', async () => {
  const { queue, gates } = fixture(test);
  queue.setSettings({ queueLimit: 1 });
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(queue, name, 'queue'));
  assert.equal(queue.queueInfo().limit, 1);
  assert.equal(queue.active.size, 0, 'sonra için eklenenler kendiliğinden başlamaz');
  queue.resumeAll();
  assert.deepEqual([a, b, c].map(id => status(queue, id)), ['running', 'queued', 'queued'], 'hepsi sürdürüldü; sınır 1: biri çalışır, diğerleri sırasını bekler');
  await finish(queue, gates, a);
  assert.deepEqual([a, b, c].map(id => status(queue, id)), ['completed', 'running', 'queued']);
  await finish(queue, gates, b); await finish(queue, gates, c);
  assert.deepEqual([a, b, c].map(id => status(queue, id)), ['completed', 'completed', 'completed']);
  const late = add(queue, 'late', 'queue');
  assert.equal(status(queue, late), 'held', 'listeyi bitirmek sonradan eklenenleri başlatmaz: "sonra için" yalnızca hemen başlamaz');
});

test('sınır ayarı: azaltınca fazla çalışan bekler, Hepsi ile kalanlar başlar', async () => {
  const { queue, gates } = fixture(test);
  const ids = ['a', 'b', 'c', 'd'].map(name => add(queue, name, 'queue'));
  queue.setSettings({ queueLimit: 2 }); queue.resumeAll();
  assert.deepEqual(ids.map(id => status(queue, id)), ['running', 'running', 'queued', 'queued']);
  queue.setSettings({ queueLimit: 1 });
  assert.equal(status(queue, ids[1]), 'queued', 'fazla çalışan güvenle duraklatılıp otomatik devam için bekler');
  await wait(20);
  assert.equal(queue.active.size, 1);
  await finish(queue, gates, ids[0]);
  assert.deepEqual(ids.map(id => status(queue, id)), ['completed', 'running', 'queued', 'queued'], 'sınır 1: ikinci biterken yeni başlamaz');
  queue.setSettings({ queueLimit: 'all' });
  assert.deepEqual(ids.map(id => status(queue, id)), ['completed', 'running', 'running', 'running'], 'Hepsi: kalanların hepsi birden başlar');
});

test('genel sınır sonra eklenenlerle direkt indirmelerin toplamına uygulanır', () => {
  const { queue } = fixture(test);
  queue.setSettings({ queueLimit: 1 });
  add(queue, 'q1', 'queue'); add(queue, 'q2', 'queue'); queue.resumeAll();
  const direct = ['x', 'y', 'z'].map(name => add(queue, name));
  assert.ok(direct.every(id => status(queue, id) === 'queued'));
  assert.equal(queue.active.size, 1, 'tek bütçe: hepsi aynı sınırı paylaşır');
});

test('Sürdür tek bir indirmeyi başlatır; Duraklat bekleyene dokunmaz; Şimdi başlat, yeniden sırala ve iptal', () => {
  const { queue } = fixture(test);
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(queue, name, 'queue'));
  queue.reorder([c, a]);
  assert.deepEqual(queue.jobs.map(job => job.id), [c, a, b]);
  assert.deepEqual(queue.batch('pause', { all: true }), { changed: 0, skipped: 3 }, 'duraklat, henüz başlamamış indirmelere dokunmaz');
  queue.resume(b); assert.equal(status(queue, b), 'running', 'Sürdür, sonra için eklenen indirmeyi de başlatır');
  queue.startNow(c); assert.equal(status(queue, c), 'running', 'eski "şimdi başlat" yolu çalışır');
  assert.deepEqual(queue.jobs.filter(job => job.status === 'held').map(job => job.id), [a]);
  queue.cancel(a); assert.equal(status(queue, a), 'cancelled');
  assert.throws(() => queue.startNow(a), /sırada değil|sirada degil|not in the queue/i);
});

test('ayarlar doğrulanır ve kalıcıdır; bekleyenler yeniden başlatmada bekler, sıra korunur', () => {
  const { queue, root } = fixture(test);
  assert.throws(() => queue.setSettings({ queueLimit: 7 }), /1 ile 6|1 and 6/);
  assert.throws(() => queue.setSettings({ queueLimit: 0 }), /1 ile 6|1 and 6/);
  assert.throws(() => queue.setSettings({ queueLimit: 'many' }), /Hepsi|All/);
  assert.throws(() => add(queue, 'bad', 'later'), /geçersiz|Invalid/i);
  const a = add(queue, 'a', 'queue'), b = add(queue, 'b', 'queue');
  queue.setSettings({ queueLimit: 3 });
  const again = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools') });
  again.run = () => new Promise(() => {}); // never let a downloaded job proceed in this check
  assert.equal(again.settings.queueLimit, 3);
  assert.deepEqual(again.jobs.map(job => job.id), [a, b], 'sıra yeniden başlatmada aynı');
  assert.deepEqual(again.jobs.map(job => job.status), ['held', 'held'], 'sonra için eklenenler yeniden açılışta kendiliğinden başlamaz');
  assert.equal(again.active.size, 0);
  assert.deepEqual(Object.keys(again.queueInfo()).sort(), ['limit', 'speedLimitKiB'], 'kuyruk durumu diye bir şey kalmadı');
  again.stop();
});

test('satır sırası değişmez: ilk eklenen üstte; iş bitse de hata alsa da yerinde kalır; yeni iş en alta eklenir', async () => {
  const { queue, gates } = fixture(test);
  const [a, b, c] = ['a', 'b', 'c'].map(name => add(queue, name));
  await finish(queue, gates, b); // the middle one completes
  queue.cancel(a);
  const d = add(queue, 'd');
  assert.deepEqual(queue.list().map(job => job.id), [a, b, c, d]);
  assert.deepEqual(queue.list().map(job => job.status), ['cancelled', 'completed', 'running', 'running']);
});

test('eski düzende (yeni üstte) kayıtlı kuyruk bir kez ters çevrilir; işaret sonrası tekrar çevrilmez; eski ayar dosyası göçer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-queue-migrate-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    const job = (id, title) => ({ id, url: 'https://files.example.org/x.bin', engine: 'direct', title, status: 'completed', received: 0, total: null, speed: 0, createdAt: new Date().toISOString(), error: null, file: null, headers: {} });
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'];
    fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify([job(ids[2], 'newest'), job(ids[1], 'middle'), job(ids[0], 'oldest')])); // old layout: newest first
    fs.writeFileSync(path.join(root, 'queue.json.settings.json'), JSON.stringify({ queueLimit: 2, queueLimitEnabled: false })); // old "limit off"
    const open = () => new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.join(root, 'tools') });
    const first = open(); assert.deepEqual(first.jobs.map(item => item.id), ids, 'oldest first after the one-time flip'); assert.equal(first.settings.queueLimit, 'all'); first.stop();
    const second = open(); assert.deepEqual(second.jobs.map(item => item.id), ids, 'the marker prevents a second flip'); second.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Tümünü duraklat sıradaki işlere ve kuyruk durumuna dokunmaz; eski istemci (start yok) hemen indirir', () => {
  const { queue } = fixture(test);
  const held = add(queue, 'h', 'queue'), direct = add(queue, 'd');
  queue.batch('pause', { all: true });
  assert.equal(status(queue, held), 'held'); assert.equal(status(queue, direct), 'paused');
});
