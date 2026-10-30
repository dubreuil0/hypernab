import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanName, knownYear, finishedName, layoutDirectory } from '../src/file-layout.js';
import { DownloadQueue } from '../src/downloads.js';

test('clean names preserve Turkish, contain paths and Windows device names', () => {
  assert.equal(cleanName('  Çığ: Öykü / Bir?  '), 'Çığ Öykü Bir');
  for (const text of ['CON', 'nul.txt', 'LPT1', '..', '../x', 'a\\b', 'x. ']) {
    const name = cleanName(text);
    assert.ok(name && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name));
    assert.ok(!/^(con|nul|lpt1)(\.|$)/i.test(name));
  }
  assert.equal(cleanName('a'.repeat(1000)).length, 100);
});

test('only known release year and verified height; avoid duplicate tags/extensions', () => {
  assert.equal(knownYear({ release_year: 2026 }), 2026);
  assert.equal(knownYear({ upload_date: '20261001' }), null);
  assert.equal(knownYear(null), null);
  assert.equal(knownYear({ release_year: 99999 }), null);
  const job = { smartNames: true, title: 'Öykü.mp4', releaseYear: 2026, media: { height: 1080 } };
  assert.equal(finishedName(job, 'Öykü.mp4', '.mp4'), 'Öykü (2026) 1080p');
  assert.equal(finishedName({ ...job, title: 'Öykü (2026) 1080p' }, ''), 'Öykü (2026) 1080p');
  assert.equal(finishedName({ smartNames: true, title: 'Öykü', quality: '1080', formatSlot: { height: 1080 } }, ''), 'Öykü');
  assert.equal(finishedName({ title: 'yeni' }, 'eski'), 'eski');
  assert.ok(finishedName({ ...job, title: 'a'.repeat(100) }, '').endsWith(' (2026) 1080p'));
});

test('folder modes use only explicit series metadata and safe segments', () => {
  const root = path.resolve('downloads');
  assert.equal(layoutDirectory(root, 'flat', { host: 'example.org' }), root);
  assert.equal(layoutDirectory(root, 'series', { host: 'example.org' }), root);
  assert.equal(layoutDirectory(root, 'site-series', { host: 'example.org', series: 'Dizi' }), path.join(root, 'example.org', 'Dizi'));
  assert.ok(layoutDirectory(root, 'series', { series: '../../CON' }).startsWith(root + path.sep));
});

test('new job snapshots layout; clean completion never overwrites; old jobs retain names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-layout-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.resolve('tools') });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  queue.setSettings({ folderLayout: 'site-series' });
  const id = queue.add({ url: 'https://example.org/a.mp4', engine: 'direct', start: 'queue', title: 'Öykü', seriesTitle: 'Dizi' });
  const job = queue.jobs.find(j => j.id === id);
  assert.equal(job.directory, path.join(root, 'downloads', 'example.org', 'Dizi'));
  queue.setSettings({ folderLayout: 'flat', smartNames: false });
  assert.equal(job.smartNames, true);
  assert.ok(job.directory.endsWith(path.join('example.org', 'Dizi')));
  job.media = { height: 720 }; job.file = `${id}-Öykü.mp4`;
  fs.writeFileSync(path.join(job.directory, job.file), 'new');
  fs.writeFileSync(path.join(job.directory, 'Öykü 720p.mp4'), 'existing');
  queue.finalizeName(job);
  assert.equal(job.file, 'Öykü 720p (2).mp4');
  assert.equal(fs.readFileSync(path.join(job.directory, 'Öykü 720p.mp4'), 'utf8'), 'existing');
  assert.equal(fs.readFileSync(path.join(job.directory, job.file), 'utf8'), 'new');
  const old = { id: 'old', directory: job.directory, title: 'farklı', file: 'old-Eski.mp4' };
  fs.writeFileSync(path.join(old.directory, old.file), 'old'); queue.finalizeName(old);
  assert.equal(old.file, 'Eski.mp4');
  assert.throws(() => queue.setSettings({ folderLayout: '../outside' }));
  assert.throws(() => queue.setSettings({ smartNames: 'yes' }));
});
