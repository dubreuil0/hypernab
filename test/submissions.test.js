import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DownloadQueue } from '../src/downloads.js';
import { SubmissionStore } from '../src/submissions.js';

function fixture(t) {
  const preferred = (process.env.LOCALAPPDATA + '/Temp/opencode');
  const root = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-submission-'));
  const options = { directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root };
  fs.writeFileSync(path.join(root, 'yt-dlp.exe'), 'fake');
  const create = () => { const queue = new DownloadQueue(options); queue.pump = () => {}; return queue; };
  const queue = create();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { url: 'https://cdn.example.org/file.mp4?signature=secret', engine: 'direct', title: 'Türkçe video', submissionId: randomUUID() };
  return { queue, input, create, root, options };
}
test('aynı gönderim ve kayıp yanıt tekrarında tek kalıcı iş kimliği döner', t => {
  const { queue, input } = fixture(t);
  const id = queue.add(input);
  assert.equal(queue.add({ ...input }), id); assert.equal(queue.jobs.length, 1);
  assert.deepEqual(queue.submissionStatus(input.submissionId), { known: true, id, listed: true });
  assert.doesNotMatch(JSON.stringify(queue.list()), /signature=secret|submissionFingerprint/);
});
test('aynı gönderim kimliği farklı URL/kalite/ad için kullanılamaz', t => {
  const { queue, input } = fixture(t); queue.add(input);
  for (const change of [{ url: 'https://example.org/other.mp4' }, { title: 'Başka' }, { quality: '720' }]) assert.throws(() => queue.add({ ...input, ...change }), /farklı bir indirme/);
  assert.equal(queue.jobs.length, 1);
});
test('sunucu yeniden açılınca eski gönderim yeniden başlamaz', t => {
  const { queue, input, create } = fixture(t); const id = queue.add(input);
  const restored = create();
  assert.equal(restored.add(input), id); assert.equal(restored.jobs.length, 1); assert.equal(restored.jobs[0].status, 'interrupted');
});
test('liste kaydı kaldırılsa da gönderim günlüğü ikinci iş oluşturmaz; dosyalar korunur', t => {
  const { queue, input, create } = fixture(t); const id = queue.add(input);
  fs.writeFileSync(path.join(queue.directory, `${id}.parallel.part`), 'half');
  queue.cancel(id); queue.clearFinished();
  assert.equal(queue.jobs.length, 0); assert.equal(queue.add(input), id); assert.equal(queue.jobs.length, 0);
  assert.deepEqual(queue.submissionStatus(input.submissionId), { known: true, id, listed: false });
  assert.equal(create().add(input), id);
  assert.equal(fs.readFileSync(path.join(queue.directory, `${id}.parallel.part`), 'utf8'), 'half');
});
test('iş kaydedilip yan günlük kaydedilmeden kapanılırsa işten toparlanır', t => {
  const { queue, input, create } = fixture(t); const id = queue.add(input);
  fs.unlinkSync(queue.submissions.file);
  const restored = create(); assert.equal(restored.add(input), id); assert.equal(restored.jobs.length, 1);
  restored.cancel(id); restored.clearFinished();
  assert.equal(create().add(input), id, 'toparlanan kayıt liste temizlenmeden önce günlüğe yazılmalı');
});
test('iş kaydı yazılamadıktan sonraki tekrar bellekte ikinci kayıt oluşturmaz', t => {
  const { queue, input } = fixture(t); const save = queue.save.bind(queue);
  queue.save = () => { throw new Error('disk error'); };
  assert.throws(() => queue.add(input), /disk error/);
  queue.save = save;
  const id = queue.add(input); assert.equal(queue.jobs.length, 1); assert.equal(queue.jobs[0].id, id);
});
test('bırakılan belirsiz gönderimin gecikmiş ağ isteği yeni iş oluşturamaz', t => {
  const { queue, input, create } = fixture(t);
  assert.deepEqual(queue.abandonSubmission(input.submissionId), { known: false, abandoned: true });
  assert.throws(() => queue.add(input), /kullanıcı tarafından bırakıldı/);
  assert.throws(() => create().add(input), /kullanıcı tarafından bırakıldı/);
  assert.equal(queue.jobs.length, 0);
});
test('gönderimi bırak mevcut işi iptal etmez, durumunu değiştirmez', t => {
  const { queue, input } = fixture(t); const id = queue.add(input);
  assert.deepEqual(queue.abandonSubmission(input.submissionId), { known: true, id, listed: true });
  assert.equal(queue.jobs[0].status, 'queued');
});
test('bozuk günlük sessizce sıfırlanmaz ve üzerine yazılmaz', t => {
  const { queue, create } = fixture(t);
  fs.writeFileSync(queue.submissions.file, 'not JSON');
  assert.throws(create, /çift indirme riski/);
  assert.equal(fs.readFileSync(queue.submissions.file, 'utf8'), 'not JSON');
});
test('günlükte kimlikler kanonikleştirilir; yinelenen kayıtlar sessizce ezilmez', t => {
  const { queue, input, create } = fixture(t); const id = queue.add(input);
  const record = JSON.parse(fs.readFileSync(queue.submissions.file, 'utf8'))[0];
  fs.writeFileSync(queue.submissions.file, JSON.stringify([{ ...record, submissionId: record.submissionId.toUpperCase(), id: record.id.toUpperCase() }]));
  assert.equal(create().add(input), id);
  fs.writeFileSync(queue.submissions.file, JSON.stringify([record, record]));
  assert.throws(create, /Gönderim günlüğü okunamadı/);
});
test('yan günlükte imzalı URL veya oturum başlığı tutulmaz, yalnızca hash/kimlik vardır', t => {
  const { queue, input } = fixture(t); queue.add(input);
  const text = fs.readFileSync(queue.submissions.file, 'utf8');
  assert.doesNotMatch(text, /secret|https|Referer|User-Agent/);
  assert.throws(() => queue.add({ ...input, submissionId: '../file' }), /Geçersiz gönderim/);
  assert.throws(() => queue.submissionStatus('bad'), /Geçersiz gönderim/);
});
test('video adıyla kaynak site adı korunur, CDN yerine sayfa hostu gösterilir', t => {
  const { queue, input } = fixture(t);
  queue.add({ ...input, pageUrl: 'https://site.example.org/watch?private=hidden' });
  const job = queue.list()[0]; assert.equal(job.host, 'site.example.org'); assert.equal(job.title, 'Türkçe video');
  assert.doesNotMatch(JSON.stringify(job), /private=hidden/);
});
test('günlük kapasitesinde eski alındılar sessizce silinerek tekrar indirme riski yaratılmaz', t => {
  const { root } = fixture(t); const store = new SubmissionStore(path.join(root, 'capacity.json'));
  for (let i = 0; i < 10000; i++) store.entries.set(randomUUID(), {});
  assert.throws(() => store.find(randomUUID()), /sınırına ulaşıldı/); assert.equal(store.entries.size, 10000);
});
