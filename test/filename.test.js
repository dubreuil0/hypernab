import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue } from '../src/downloads.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-name-test-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}

test('biten dosya iç kimlik yerine video adıyla kaydedilir', t => {
  const queue = fixture(t);
  const job = { id: '8d820aa9-8960-45f5-8140-c31de9fc76e2', file: '8d820aa9-8960-45f5-8140-c31de9fc76e2-Cyberpunk Edgerunners 2. Sezon 7. Bölüm.mp4' };
  fs.writeFileSync(path.join(queue.directory, job.file), 'data');
  queue.finalizeName(job);
  assert.equal(job.file, 'Cyberpunk Edgerunners 2. Sezon 7. Bölüm.mp4');
  assert.equal(fs.readFileSync(path.join(queue.directory, job.file), 'utf8'), 'data');
  assert.deepEqual(fs.readdirSync(queue.directory), [job.file]);
});

test('aynı ad varsa üzerine yazmaz, (2) ekler; mevcut dosya aynen kalır', t => {
  const queue = fixture(t);
  fs.writeFileSync(path.join(queue.directory, 'Video.mp4'), 'old');
  const a = { id: 'aaaa', file: 'aaaa-Video.mp4' }, b = { id: 'bbbb', file: 'bbbb-Video.mp4' };
  fs.writeFileSync(path.join(queue.directory, a.file), 'A'); fs.writeFileSync(path.join(queue.directory, b.file), 'B');
  queue.finalizeName(a); queue.finalizeName(b);
  assert.deepEqual([a.file, b.file], ['Video (2).mp4', 'Video (3).mp4']);
  assert.equal(fs.readFileSync(path.join(queue.directory, 'Video.mp4'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(queue.directory, 'Video (3).mp4'), 'utf8'), 'B');
});

test('kimlik öneki olmayan, yolu olan veya eksik dosyaya dokunulmaz', t => {
  const queue = fixture(t);
  for (const file of ['Zaten Güzel Ad.mp4', '..\\x-a.mp4', null, 'cccc-Yok.mp4']) { const job = { id: 'cccc', file }; queue.finalizeName(job); assert.equal(job.file, file); }
  assert.deepEqual(fs.readdirSync(queue.directory), []);
});
