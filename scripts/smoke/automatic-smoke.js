// Opt-in real network acceptance test. Does not use the user's queue/downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DownloadQueue } from '../../src/downloads.js';
import { verifyVideo } from '../../src/media.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const preferred = (process.env.LOCALAPPDATA + '\\Temp\\opencode');
const temp = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-auto-smoke-'));
const queue = new DownloadQueue({ directory: path.join(temp, 'downloads'), stateFile: path.join(temp, 'queue.json'), toolsDirectory: path.join(root, 'tools') });
const cases = [
  { name: 'W3Schools / extractor', url: 'https://www.w3schools.com/html/mov_bbb.mp4', engine: 'extractor' },
  { name: 'MDN / extractor', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', engine: 'extractor' },
  { name: 'W3C / direct', url: 'https://media.w3.org/2010/05/bunny/trailer.mp4', engine: 'direct' },
  { name: 'W3Schools / forced unsupported-Range fallback', url: 'https://www.w3schools.com/html/mov_bbb.mp4', engine: 'extractor', forceFallback: true }
];
try {
  for (const sample of cases) {
    const started = performance.now();
    let nativeProgress = null;
    const measure = queue.measure.bind(queue);
    queue.measure = (job, bytes) => {
      measure(job, bytes);
      if (job.transfer?.method === 'yt-dlp' && job.received > 0) nativeProgress = { received: job.received, total: job.total };
    };
    const realRequest = queue.rangeRequest;
    if (sample.forceFallback) queue.rangeRequest = async () => ({ response: Object.assign(Readable.from([]), { statusCode: 200, headers: {} }) });
    const id = queue.add({ ...sample, title: `Türkçe — ${sample.name}` });
    const deadline = Date.now() + 90000;
    while (queue.active.has(id) && Date.now() < deadline) await wait(100);
    const job = queue.jobs.find(job => job.id === id);
    assert.equal(job.status, 'completed', `${sample.name}: ${job.error || job.status}`);
    assert.equal(job.transfer.method, sample.forceFallback ? 'yt-dlp' : 'parallel-http', `${sample.name}: incorrect engine`);
    const media = job.media || await verifyVideo(path.join(queue.directory, job.file), path.join(root, 'tools'), null, AbortSignal.timeout(30000), { requireVideo: true, requireAudio: false });
    assert.ok(media.height > 0, 'Output must pass ffprobe.');
    assert.equal(fs.statSync(path.join(queue.directory, job.file)).size, job.total);
    const progress = queue.list().find(j => j.id === id).progress;
    assert.equal(progress.phase, 'completed'); assert.equal(progress.speed, 0); assert.equal(progress.etaSeconds, null);
    if (sample.forceFallback) {
      assert.ok(nativeProgress?.received > 0, 'Real yt-dlp progress template must report downloaded bytes.');
      assert.equal(nativeProgress.total, job.total, 'Native format id must match the selected stream, without duplicate counters.');
    }
    console.log(JSON.stringify({ sample: sample.name, method: job.transfer.method, connections: job.transfer.connections, bytes: job.total, height: media.height, audio: media.audio, seconds: (performance.now() - started) / 1000 }));
    queue.rangeRequest = realRequest;
    queue.measure = measure;
  }
} finally {
  queue.stop();
  while (queue.active.size) await wait(20);
  fs.rmSync(temp, { recursive: true, force: true });
}
