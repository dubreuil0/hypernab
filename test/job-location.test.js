import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DownloadQueue } from '../src/downloads.js';
const { openJobLocation, playJob } = createRequire(import.meta.url)('../desktop/job-location.cjs');
const id = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-location-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], shell = { showItemInFolder: file => calls.push(['select', file]), openPath: async directory => { calls.push(['open', directory]); return ''; } };
  return { root, calls, shell };
}
test('bitmiş dosyayı seçer; aktif işte dosyayı çalıştırmadan klasörü açar', async t => {
  const { root, calls, shell } = fixture(t); fs.writeFileSync(path.join(root, 'film.mp4'), 'video');
  await openJobLocation(id, { shell, lookup: async () => ({ directory: root, file: 'film.mp4' }) });
  await openJobLocation(id, { shell, lookup: async () => ({ directory: root, file: null }) });
  assert.deepEqual(calls, [['select', path.join(root, 'film.mp4')], ['open', root]]);
});
test('işin kendi klasörü kullanılır; dosya taşınmışsa klasör açılır; eksik klasör oluşturulmaz', async t => {
  const { root, shell, calls } = fixture(t);
  const queue = { jobs: [{ id, directory: root, status: 'completed', file: 'missing.mp4' }], directory: 'C:/other', dirOf: DownloadQueue.prototype.dirOf };
  const lookup = async value => DownloadQueue.prototype.location.call(queue, value);
  await openJobLocation(id, { shell, lookup }); assert.deepEqual(calls[0], ['open', root]);
  const missing = path.join(root, 'missing-folder'); queue.jobs[0].directory = missing;
  await assert.rejects(openJobLocation(id, { shell, lookup }), /mevcut değil/); assert.equal(fs.existsSync(missing), false);
  await assert.rejects(openJobLocation('22222222-2222-4222-8222-222222222222', { shell, lookup }), /bulunamadı/);
});
test('IPC keyfi yol/URL/nesne kabul etmez; motor kaydındaki bozuk dosya adı da çalıştırılmaz', async t => {
  const { root, shell, calls } = fixture(t); let reads = 0;
  const lookup = async () => { reads++; return { directory: root, file: null }; };
  for (const bad of ['C:/Windows/notepad.exe', '../secret', 'https://evil.example', { id, path: root }, id + '?path=x']) await assert.rejects(openJobLocation(bad, { shell, lookup }), /kimliği/);
  assert.equal(reads, 0);
  for (const file of ['..', '../secret', 'C:\\Windows\\notepad.exe', 'file:stream']) await assert.rejects(openJobLocation(id, { shell, lookup: async () => ({ directory: root, file }) }), /geçersiz/);
  assert.equal(calls.length, 0);
});

test('play uses the default player for completed media only, with opaque ids and no arbitrary paths', async t => {
  const { root, shell, calls } = fixture(t);
  for (const file of ['film.mp4', 'film.mkv', 'song.flac']) {
    fs.writeFileSync(path.join(root, file), 'media');
    await playJob(id, { shell, lookup: async () => ({ directory: root, file }) });
    assert.deepEqual(calls.at(-1), ['open', path.join(root, file)]);
  }
  calls.length = 0;
  for (const file of [null, 'tool.exe', 'film.mp4.lnk', 'film.mp4.part', '../film.mp4', 'file:stream.mp4']) {
    await assert.rejects(playJob(id, { shell, lookup: async () => ({ directory: root, file }) }));
  }
  await assert.rejects(playJob(id, { shell, lookup: async () => ({ directory: root, file: 'missing.mp4' }) }), /taşınmış/);
  await assert.rejects(playJob('C:/film.mp4', { shell, lookup: async () => assert.fail('must not read') }), /kimliği/);
  await assert.rejects(playJob({ id }, { shell, lookup: async () => assert.fail('must not read') }), /kimliği/);
  assert.equal(calls.length, 0);
  await assert.rejects(playJob(id, { shell: { openPath: async () => 'no default app' }, lookup: async () => ({ directory: root, file: 'film.mp4' }) }), /Varsayılan oynatıcı/);
});
