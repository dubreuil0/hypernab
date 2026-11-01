import { m } from './messages.js';
import fs from 'node:fs';
import path from 'node:path';

export function submissionId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error(m('e.invalid-submission-id'));
  return value.toLowerCase();
}

// Separate, additive journal: clearing queue rows never forgets an acknowledged submission.
export class SubmissionStore {
  constructor(file, jobs = []) {
    this.file = file;
    this.entries = new Map();
    try {
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(records) || records.length > 10000) throw new Error(m('e.invalid-submission-log'));
      for (const record of records) {
        if (!record || !submissionId(record.submissionId) || (record.abandoned !== true && (!submissionId(record.id) || !/^[a-f0-9]{64}$/.test(record.fingerprint)))) throw new Error(m('e.invalid-submission-record'));
        const sid = submissionId(record.submissionId);
        if (this.entries.has(sid)) throw new Error(m('e.duplicate-submission-record'));
        this.entries.set(sid, { ...record, submissionId: sid, ...(record.id ? { id: submissionId(record.id) } : {}) });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(m('e.the-submission-log-could-not-be')); }
    // Recover the narrow crash window between saving a job and writing its receipt.
    for (const job of jobs) if (job.submissionId && job.submissionFingerprint && !this.entries.has(job.submissionId)) {
      this.entries.set(job.submissionId, { submissionId: job.submissionId, fingerprint: job.submissionFingerprint, id: job.id });
    }
  }
  find(id, fingerprint) {
    id = submissionId(id);
    const record = id ? this.entries.get(id) : null;
    if (record && !record.abandoned && fingerprint && record.fingerprint !== fingerprint) throw new Error(m('e.this-submission-id-was-used-for'));
    if (id && !record && this.entries.size >= 10000) throw new Error(m('e.the-submission-log-limit-was-reached'));
    return record || null;
  }
  remember(record) {
    this.find(record.submissionId, record.fingerprint);
    this.entries.set(record.submissionId, record);
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.entries.values()], null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
