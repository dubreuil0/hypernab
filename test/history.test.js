import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { HistoryStore } from '../src/history.js';
import { DownloadQueue } from '../src/downloads.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-history-'));
  const store = new HistoryStore(path.join(root, 'history.sqlite'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, cleanup };
}
const completed = (root, title = 'İstanbul Öyküsü') => ({ id: randomUUID(), title, status: 'completed', directory: root, file: `${title}.mp4`, total: 123,
  completedAt: '2026-10-28T10:00:00.000Z', createdAt: '2026-10-28T09:00:00.000Z', url: 'https://example.org/movie?secret=source-token', headers: { Cookie: 'cookie-secret' } });

test('history survives queue clearing and restart, never deletes files and never stores secrets', async t => {
  const { root, store, cleanup } = fixture(t);
  const job = completed(root); fs.writeFileSync(path.join(root, job.file), 'file-bytes');
  const queue = new DownloadQueue({ directory: root, stateFile: path.join(root, 'queue.json'), toolsDirectory: path.resolve('tools') });
  cleanup.push(() => queue.stop());
  queue.jobs.push(job);
  assert.equal(queue.clearFinished().removed, 1);
  assert.equal(queue.jobs.length, 0);
  assert.equal(fs.readFileSync(path.join(root, job.file), 'utf8'), 'file-bytes');
  const page = await queue.historyPage({ search: 'İSTANBUL' });
  assert.deepEqual(page.entries.map(row => row.id), [job.id]);
  const reopened = new HistoryStore(`${path.join(root, 'queue.json')}.history.sqlite`);
  cleanup.push(() => reopened.close());
  assert.equal((await reopened.page()).entries[0].file, job.file);
  assert.deepEqual(reopened.location(job.id), { directory: root, file: job.file });
  const db = new DatabaseSync(reopened.file, { readOnly: true });
  const rows = db.prepare('SELECT * FROM history').all(); db.close();
  assert.ok(!JSON.stringify(rows).includes('source-token'));
  assert.ok(!JSON.stringify(rows).includes('cookie-secret'));
  assert.equal((await store.page()).entries.length, 0);
});

test('history is idempotent, paginated newest first, and cursor is stable after new completions', async t => {
  const { root, store } = fixture(t);
  const jobs = Array.from({ length: 113 }, (_, n) => completed(root, `Film ${n}`));
  store.record(jobs); store.record(jobs);
  const again = new HistoryStore(store.file); again.record(jobs); again.close();
  const first = await store.page(); assert.equal(first.entries.length, 50); assert.equal(first.entries[0].title, 'Film 112');
  store.record([completed(root, 'New completion')]);
  const second = await store.page({ cursor: first.cursor }); assert.equal(second.entries.length, 50);
  const third = await store.page({ cursor: second.cursor }); assert.equal(third.entries.length, 13); assert.equal(third.cursor, null);
  assert.equal(new Set([...first.entries, ...second.entries, ...third.entries].map(row => row.id)).size, 113);
});

test('search matches Turkish title, file and host literally; incomplete jobs stay out', async t => {
  const { root, store } = fixture(t);
  store.record([completed(root), completed(root, '100%_Özel'), { ...completed(root, 'Secret pending'), status: 'paused' }]);
  assert.equal((await store.page({ search: 'İSTANBUL' })).entries.length, 1);
  assert.equal((await store.page({ search: 'example.org' })).entries.length, 2);
  assert.equal((await store.page({ search: '.mp4' })).entries.length, 2);
  assert.equal((await store.page({ search: '%' })).entries.length, 1);
  assert.equal((await store.page({ search: '_' })).entries.length, 1);
  assert.equal((await store.page({ search: "' OR 1=1 --" })).entries.length, 0);
  await assert.rejects(store.page({ cursor: '../x' }), /geçersiz/);
  await assert.rejects(store.page({ search: 'a'.repeat(201) }), /geçersiz/);
});

test('unwritable/corrupt history prevents clearing completed queue records; downloads remain intact', t => {
  const { root, cleanup } = fixture(t);
  const queue = new DownloadQueue({ directory: root, stateFile: path.join(root, 'queue.json'), toolsDirectory: path.resolve('tools') });
  cleanup.push(() => queue.stop());
  const job = completed(root); queue.jobs.push(job); fs.writeFileSync(path.join(root, job.file), 'protected');
  fs.writeFileSync(queue.history.file, 'not-a-database');
  assert.throws(() => queue.clearFinished());
  assert.equal(queue.jobs.length, 1); assert.equal(fs.readFileSync(path.join(root, job.file), 'utf8'), 'protected');
  assert.equal(fs.readFileSync(queue.history.file, 'utf8'), 'not-a-database');
});

test('abrupt process exit preserves committed history and rolls back an unfinished transaction', { timeout: 20000 }, async t => {
  const { root, store } = fixture(t);
  const job = completed(root);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { HistoryStore } from ${JSON.stringify(new URL('../src/history.js', import.meta.url).href)};
    import { DatabaseSync } from 'node:sqlite';
    const store = new HistoryStore(${JSON.stringify(store.file)});
    store.record([${JSON.stringify(job)}]);
    const db = new DatabaseSync(store.file);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE history SET title=? WHERE jobId=?').run('uncommitted title', ${JSON.stringify(job.id)});
    process.send('ready');
    setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'message', { signal: AbortSignal.timeout(10000) });
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.equal((await store.page()).entries[0].title, job.title);
  const db = new DatabaseSync(store.file);
  assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok'); db.close();
});
