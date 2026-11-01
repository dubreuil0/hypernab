import { m } from './messages.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const normalize = text => String(text || '').normalize('NFC').toLocaleLowerCase('tr-TR');
const fields = row => ({ id: row.jobId, title: row.title, file: row.file, directory: row.directory, host: row.host, total: row.total, completedAt: row.completedAt, createdAt: row.createdAt });

// Compact metadata only. No source URL, cookies, headers, tokens or transfer state.
export class HistoryStore {
  constructor(file) { this.file = file; this.seen = new Set(); this.workers = new Set(); }
  open() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
        CREATE TABLE IF NOT EXISTS history (
          sequence INTEGER PRIMARY KEY, jobId TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          file TEXT NOT NULL, directory TEXT NOT NULL, host TEXT NOT NULL,
          total INTEGER, completedAt TEXT, createdAt TEXT, search TEXT NOT NULL
        );`);
      this.insert = db.prepare(`INSERT INTO history (jobId,title,file,directory,host,total,completedAt,createdAt,search)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(jobId) DO NOTHING`);
      this.lookup = db.prepare('SELECT * FROM history WHERE jobId=?');
      this.db = db; return db;
    } catch (error) { db.close(); throw error; }
  }
  record(jobs) {
    const pending = jobs.filter(job => job.status === 'completed' && job.file && !this.seen.has(job.id));
    if (!pending.length) return;
    const db = this.open();
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      for (const job of pending) {
        const host = job.pageHost || (() => { try { return new URL(job.url).hostname; } catch { return ''; } })();
        const title = String(job.title || job.file).slice(0, 200);
        this.insert.run(job.id, title, job.file, job.directory, host, Number.isFinite(job.total) ? job.total : null,
          job.completedAt || null, job.createdAt || null, normalize(`${title} ${job.file} ${host}`));
      }
      db.exec('COMMIT'); transaction = false;
      for (const job of pending) this.seen.add(job.id);
    } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
    finally { this.release(); }
  }
  location(id) {
    try {
      const row = this.open() && this.lookup.get(id);
      if (!row) throw new Error(m('e.history-entry-not-found'));
      return { directory: row.directory, file: row.file };
    } finally { this.release(); }
  }
  async page({ search = '', cursor = null } = {}) {
    if (typeof search !== 'string' || search.length > 200 || (cursor !== null && (!/^\d{1,16}$/.test(String(cursor)) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1))) throw new Error(m('e.invalid-history-search'));
    if (this.workers.size >= 2) throw new Error(m('e.the-history-is-being-read-wait'));
    this.open(); this.release();
    // Searches run outside the engine thread. Only 50 rows reach the renderer, even with years of history.
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { file: this.file, search, cursor } });
      this.workers.add(worker);
      let result;
      worker.once('message', message => { result = message; });
      worker.once('error', reject);
      worker.once('exit', code => {
        this.workers.delete(worker);
        if (code || !result) reject(new Error(m('e.the-history-could-not-be-read')));
        else if (result.error) reject(new Error(result.error));
        else resolve(result);
      });
    });
  }
  close() {
    for (const worker of this.workers) void worker.terminate();
    this.release();
  }
  release() {
    this.db?.close(); this.db = null;
  }
}

if (!isMainThread && workerData?.file) {
  let db;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=3000');
    const term = normalize(workerData.search).trim().replace(/[\\%_]/g, '\\$&');
    const rows = db.prepare(`SELECT * FROM history WHERE sequence < ? AND search LIKE ? ESCAPE '\\' ORDER BY sequence DESC LIMIT 51`)
      .all(workerData.cursor === null ? Number.MAX_SAFE_INTEGER : Number(workerData.cursor), `%${term}%`);
    const page = rows.slice(0, 50);
    parentPort.postMessage({ entries: page.map(fields), cursor: rows.length > 50 ? String(page.at(-1).sequence) : null });
  } catch { parentPort.postMessage({ error: m('e.the-history-could-not-be-read-2') }); }
  finally { db?.close(); }
}
