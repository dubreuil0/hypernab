// Explicit opt-in network smoke test, excluded from the offline test runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { DownloadQueue } from '../../src/downloads.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const preferred = (process.env.LOCALAPPDATA + '\\Temp\\opencode');
const temp = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-smoke-'));
const queue = new DownloadQueue({ directory: path.join(temp, 'downloads'), stateFile: path.join(temp, 'queue.json'), toolsDirectory: path.join(project, 'tools') });
try {
  const engines = queue.capabilities().ytDlp ? ['direct', 'extractor'] : ['direct'];
  for (const engine of engines) queue.add({ url: 'https://www.w3schools.com/html/mov_bbb.mp4', engine, title: `Türkçe Üİşğ — deneme ${engine}` });
  const deadline = Date.now() + 90000;
  while (queue.active.size && Date.now() < deadline) await delay(100);
  assert.equal(queue.active.size, 0, 'Network smoke test timed out.');
  for (const job of queue.jobs) {
    assert.equal(job.status, 'completed', `${job.engine}: ${job.error}`);
    const file = fs.readFileSync(path.join(queue.directory, job.file));
    assert.ok(file.length > 1000);
    assert.equal(job.received, file.length, 'Final byte count must match the output file.');
    assert.match(job.file, /Türkçe/, 'Unicode filename must survive the Windows process output.');
    assert.equal(file.subarray(4, 8).toString(), 'ftyp', 'Expected MP4 container header.');
    console.log(`PASS ${job.engine}: ${file.length} bytes, valid MP4 header.`);
  }
} finally {
  queue.stop();
  while (queue.active.size) await delay(20);
  fs.rmSync(temp, { recursive: true, force: true });
}
