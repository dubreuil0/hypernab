import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePlaylist, episodeName } from '../src/playlist.js';
import { DownloadQueue } from '../src/downloads.js';

test('episode names: season/episode found in many spellings, plain numbering otherwise, series name not repeated', () => {
  assert.equal(episodeName('Ada Günlükleri', 'Ada Günlükleri S01E03 - Yeni Başlangıç', 3, 10), 'Ada Günlükleri - S01E03 - Yeni Başlangıç');
  assert.equal(episodeName('Dizi', '2x07 Final', 7, 20), 'Dizi - S02E07 - Final');
  assert.equal(episodeName('Dizi', '1. Sezon 4. Bölüm', 4, 20), 'Dizi - S01E04');
  assert.equal(episodeName('Dizi', 'Bölüm 12: Sürpriz', 12, 30), 'Dizi - E12 - Sürpriz');
  assert.equal(episodeName('Dizi', 'Episode 5', 5, 8), 'Dizi - E05');
  assert.equal(episodeName('Dizi', 'Rastgele başlık', 3, 120), 'Dizi - 003 - Rastgele başlık');
  assert.equal(episodeName('', 'Tek', 1, 5), '01 - Tek');
  assert.ok(!/[<>:"\/\\|?*]/.test(episodeName('A/B', 'S01E01 <x>', 1, 1)));
});
test('playlist listing keeps only real web addresses, caps the size and never invents titles', () => {
  const list = normalizePlaylist({ title: 'Seri', entries: [{ title: 'Bir', url: 'https://example.org/v/1', duration: 600 }, { title: '', webpage_url: 'https://example.org/v/2' }, { title: 'yerel', url: 'http://127.0.0.1/x' }, { title: 'kimlik', url: 'abc123' }, null] });
  assert.deepEqual(list.entries.map(item => [item.index, item.title, item.url]), [[1, 'Bir', 'https://example.org/v/1'], [2, 'Video 2', 'https://example.org/v/2']]);
  assert.throws(() => normalizePlaylist({ title: 'x' }), /liste değil/);
  assert.equal(normalizePlaylist({ title: 'Çok', entries: Array.from({ length: 500 }, (_, i) => ({ title: `v${i}`, url: `https://example.org/${i}` })) }).entries.length, 200);
});
test('series flow: list, mark what is already queued, add the chosen ones to the waiting queue in order', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-series-'));
  const tools = path.resolve('tools');
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools,
    playlistLister: async ({ url }) => normalizePlaylist({ title: 'Ada Günlükleri', entries: [1, 2, 3].map(n => ({ title: `Ada Günlükleri S01E0${n}`, url: `https://example.org/watch/${n}` })) }) });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  if (!queue.capabilities().ytDlp) return t.skip('yt-dlp yok');
  queue.jobs.push({ id: 'old', url: 'https://example.org/watch/2', title: 'eski', status: 'completed', formatId: null });
  const listing = await queue.playlist({ url: 'https://example.org/series' });
  assert.deepEqual(listing.entries.map(item => [item.name, item.duplicate]), [['Ada Günlükleri - S01E01', false], ['Ada Günlükleri - S01E02', true], ['Ada Günlükleri - S01E03', false]]);
  const result = queue.addPlaylist({ title: listing.title, url: 'https://example.org/series', entries: listing.entries.map(({ index, title, url }) => ({ index, title, url })) });
  assert.deepEqual([result.added, result.skipped, result.failed], [2, 1, 0]);
  const added = result.ids.map(id => queue.jobs.find(job => job.id === id));
  assert.deepEqual(added.map(job => [job.title, job.status]), [['Ada Günlükleri - S01E01', 'held'], ['Ada Günlükleri - S01E03', 'held']]); // added for later: not started
  assert.throws(() => queue.addPlaylist({ entries: [] }), /seç/);
  assert.equal(queue.addPlaylist({ title: 'x', entries: [{ url: 'http://127.0.0.1/x', title: 'a' }, { url: 'nonsense', title: 'b' }] }).failed, 2);
});
