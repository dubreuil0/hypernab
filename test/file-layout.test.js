import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanName, knownYear, finishedName, layoutDirectory, TYPE_FOLDERS } from '../src/file-layout.js';
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

test('names of any alphabet: kept, never cut inside a character, no hidden direction tricks, no device names in disguise', () => {
  for (const text of ['Фильм «Зима» 2026', 'فيلم عن الشتاء', 'می‌خواهم', '冬天的故事', '冬の物語', '겨울 이야기', 'Χειμώνας', 'חורף', 'हिन्दी फ़िल्म', 'ไทย']) assert.equal(cleanName(text), text.normalize('NFC'), `${text} stays as it is`);
  assert.equal(cleanName('invoice‮fdp.exe'), 'invoicefdp.exe', 'the right-to-left override that would show ".exe" as "pdf" is dropped');
  assert.equal(cleanName('a‏b⁦c⁩d﻿e'), 'abcde');
  for (const name of ['COM¹', 'con .txt', 'AUX  ']) assert.ok(cleanName(name).startsWith('_'), name);
  const emoji = cleanName('🎬'.repeat(80)); // each is two UTF-16 units: 100 units hold 50 whole ones
  assert.equal(emoji.length, 100); assert.equal([...emoji].length, 50); assert.ok(!/[\uD800-\uDFFF]/.test(emoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'no half character');
  assert.equal(cleanName('a\uD83Db'), 'a�b', 'a broken half character cannot reach the file system');
  assert.equal(cleanName('冬'.repeat(500)).length, 100);
  assert.equal(finishedName({ smartNames: true, title: '🎬'.repeat(60), releaseYear: 2026 }, '').length <= 100, true);
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

test('sorting by type is off by default (one folder, like Windows); on, it adds a type folder in front of the site/series layout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-sort-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: path.resolve('tools') });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = path.join(root, 'downloads');
  assert.equal(queue.settings.sortByType, false);
  const directoryOf = input => { const id = queue.add({ start: 'queue', ...input }); return queue.jobs.find(job => job.id === id).directory; };
  assert.equal(directoryOf({ url: 'https://example.org/a.zip', engine: 'direct', fileMode: true, fileName: 'a.zip' }), base, 'off: everything in the one folder');
  queue.setSettings({ sortByType: true });
  assert.equal(directoryOf({ url: 'https://example.org/b.zip', engine: 'direct', fileMode: true, fileName: 'b.zip' }), path.join(base, 'Archives'));
  assert.equal(directoryOf({ url: 'https://example.org/c.pdf', engine: 'direct', fileMode: true, fileName: 'c.pdf' }), path.join(base, 'Documents'));
  assert.equal(directoryOf({ url: 'https://example.org/d.exe', engine: 'direct', fileMode: true, fileName: 'd.exe' }), path.join(base, 'Programs'));
  assert.equal(directoryOf({ url: 'https://example.org/e.mp3', engine: 'direct', fileMode: true, fileName: 'e.mp3' }), path.join(base, 'Music'));
  assert.equal(directoryOf({ url: 'https://example.org/f.unknownext', engine: 'direct', fileMode: true, fileName: 'f.unknownext' }), path.join(base, 'Other'));
  assert.equal(directoryOf({ url: 'https://example.org/v.mp4', engine: 'direct' }), path.join(base, 'Video'), 'a captured video');
  queue.setSettings({ folderLayout: 'site' });
  assert.equal(directoryOf({ url: 'https://example.org/g.zip', engine: 'direct', fileMode: true, fileName: 'g.zip' }), path.join(base, 'Archives', 'example.org'), 'type first, then the site');
  const first = queue.jobs.find(job => job.directory === path.join(base, 'Archives'));
  queue.setSettings({ sortByType: false, folderLayout: 'flat' });
  assert.equal(first.directory, path.join(base, 'Archives'), 'a job already made keeps its folder; nothing is moved');
  assert.equal(directoryOf({ url: 'https://example.org/h.zip', engine: 'direct', fileMode: true, fileName: 'h.zip' }), base, 'off again: back to the one folder');
  assert.throws(() => queue.setSettings({ sortByType: 'yes' }));
  assert.equal(layoutDirectory(base, 'flat', { category: '../../x' }), base, 'an unknown type never makes a folder');
  assert.deepEqual(Object.keys(TYPE_FOLDERS).sort(), ['archive', 'audio', 'disk', 'document', 'image', 'other', 'program', 'video']);
});
