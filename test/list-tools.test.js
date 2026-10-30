import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue } from '../src/downloads.js';
import { searchJobs, sortJobs, normalizeLayout, gridTemplate, minimumWidth, clampWidth, fitWidth, autoWidth, effectiveLayout, isAuto } from '../public/list-tools.js';

const jobs = [
  { id: 'a', title: 'Zeytin Belgeseli', host: 'ornek.org', status: 'completed', total: 500, createdAt: '2026-01-02T00:00:00Z' },
  { id: 'b', title: 'İstanbul Turu', host: 'video.test', status: 'running', progress: { total: 900 }, createdAt: '2026-01-03T00:00:00Z' },
  { id: 'c', title: 'ardışık', host: 'ornek.org', status: 'queued', total: null, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'd', title: 'Aynı', host: 'x.test', status: 'queued', total: 500, createdAt: '2026-01-04T00:00:00Z' }
];
test('search matches name or site, Turkish case-insensitively, and never mutates', () => {
  assert.deepEqual(searchJobs(jobs, 'ISTANBUL'.replace('I', 'İ')).map(j => j.id), ['b']);
  assert.deepEqual(searchJobs(jobs, 'ornek').map(j => j.id), ['a', 'c']);
  assert.deepEqual(searchJobs(jobs, 'zeytin ornek').map(j => j.id), ['a']);
  assert.equal(searchJobs(jobs, '   '), jobs);
  assert.equal(jobs.length, 4);
});
test('visual sort is stable, keeps unknown sizes last and leaves queue order alone', () => {
  assert.equal(sortJobs(jobs, 'queue'), jobs);
  assert.deepEqual(sortJobs(jobs, 'size', 'desc').map(j => j.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(sortJobs(jobs, 'size', 'asc').map(j => j.id), ['a', 'd', 'b', 'c']);
  assert.deepEqual(sortJobs(jobs, 'date', 'desc').map(j => j.id), ['d', 'b', 'a', 'c']);
  assert.deepEqual(sortJobs(jobs, 'status', 'asc').map(j => j.id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(jobs.map(j => j.id), ['a', 'b', 'c', 'd']);
});
test('layout normalisation only keeps known columns and sane numbers', () => {
  const n = normalizeLayout({ widths: { name: 300, size: 5, evil: 100, speed: 90.5 }, hidden: ['size', 'name', 'size', 'x'], focus: 'yes' });
  assert.deepEqual(n, { widths: { name: 300 }, hidden: ['size'], focus: false });
  assert.equal(gridTemplate(n), '24px 24px 300px 90px 100px 130px minmax(152px,1fr)');
  assert.equal(gridTemplate(normalizeLayout(null)), '24px 24px minmax(110px,1fr) 160px 90px 100px 130px 152px');
  assert.equal(gridTemplate(normalizeLayout(null)).split(' ').length, 8);
  assert.equal(gridTemplate(n).split(' ').length, 7);
  assert.ok(minimumWidth(normalizeLayout({ hidden: ['size', 'speed', 'eta', 'state'] })) < minimumWidth(normalizeLayout(null)));
  assert.equal(clampWidth('speed', 1), 64); assert.equal(clampWidth('name', 99999), 1600);
  assert.equal(fitWidth('name', [5000]), 700); assert.equal(fitWidth('eta', [10]), 64);
});
test('automatic widths grow with the window within limits; narrow space hides Kalan then Hız only for now', () => {
  assert.equal(autoWidth('size', 900), 150); assert.equal(autoWidth('size', 5000), 220); assert.equal(autoWidth('name', 1200), undefined);
  assert.ok(autoWidth('state', 1400) > autoWidth('state', 1000));
  const auto = normalizeLayout({ widths: {}, hidden: ['state'], focus: false });
  assert.deepEqual(effectiveLayout(auto, 1920).hidden, ['state']);
  assert.deepEqual(effectiveLayout(auto, 700).hidden, ['state', 'eta', 'speed']);
  assert.deepEqual(auto.hidden, ['state']); // the saved choice is untouched
  assert.equal(isAuto(auto), true);
  const manual = normalizeLayout({ widths: { size: 200 }, hidden: [], focus: false });
  assert.equal(isAuto(manual), false); assert.equal(effectiveLayout(manual, 500), manual);
  assert.notEqual(gridTemplate(auto, 1900), gridTemplate(auto, 1000));
  assert.equal(gridTemplate(auto, undefined), gridTemplate(normalizeLayout({ ...auto, hidden: ['state'] })));
});
test('saved layout is validated, persisted, and never touches the scheduler', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-layout-'));
  const config = { directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root };
  const queue = new DownloadQueue(config); t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  let pumps = 0; queue.pump = () => { pumps++; };
  const layout = { widths: { name: 420, speed: 80 }, hidden: ['eta'], focus: true };
  queue.setSettings({ listLayout: layout }); assert.equal(pumps, 0);
  for (const bad of [null, [], { widths: {}, hidden: [], focus: 1 }, { widths: { name: 10 }, hidden: [], focus: false }, { widths: { x: 100 }, hidden: [], focus: false }, { widths: {}, hidden: ['name'], focus: false }, { widths: {}, hidden: ['eta', 'eta'], focus: false }, { widths: {}, hidden: [], focus: false, css: 'body{}' }]) assert.throws(() => queue.setSettings({ listLayout: bad }));
  const restored = new DownloadQueue(config); assert.deepEqual(restored.settings.listLayout, layout); restored.stop();
});
test('duplicate check: same source and same quality only; never edits anything', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-dup-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  queue.jobs.push({ id: 'one', url: 'https://example.org/v.mp4', title: 'v', status: 'completed', formatId: '22', formatLabel: '720p', file: 'v.mp4' },
    { id: 'two', url: 'https://example.org/v.mp4', title: 'v', status: 'cancelled', formatId: '18' },
    { id: 'three', url: 'https://example.org/w.mp4', title: 'w', status: 'running', formatId: null });
  const before = JSON.stringify(queue.jobs);
  assert.deepEqual(queue.findDuplicates({ url: 'https://example.org/v.mp4', formatId: '22' }).map(d => d.id), ['one']);
  assert.deepEqual(queue.findDuplicates({ url: 'https://example.org/v.mp4', formatId: '18' }), []); // cancelled: not wanted any more
  assert.deepEqual(queue.findDuplicates({ url: 'https://example.org/v.mp4', formatId: '137' }), []); // other quality = separate download
  assert.deepEqual(queue.findDuplicates({ url: 'https://example.org/w.mp4' }).map(d => d.id), ['three']);
  assert.deepEqual(queue.findDuplicates({ url: 'not a url' }), []);
  assert.equal(JSON.stringify(queue.jobs), before);
});
