import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { DownloadQueue } from '../../src/downloads.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const preferred = (process.env.LOCALAPPDATA + '\\Temp\\opencode');
const temp = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(), 'hypernab-merge-'));
function run(tool, args) {
  const result = spawnSync(path.join(root, 'tools', `${tool}.exe`), args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.slice(-1200));
  return result.stdout;
}
let queue;
try {
  const video = path.join(temp, 'video.mp4'), audio = path.join(temp, 'audio.m4a'), merged = path.join(temp, 'merged.mp4');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10', '-t', '1', '-an', '-c:v', 'libx264', video]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-vn', '-c:a', 'aac', audio]);
  run('ffmpeg', ['-v', 'error', '-i', video, '-i', audio, '-c', 'copy', '-shortest', merged]);
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', merged]));
  assert.ok(info.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
  console.log('PASS FFmpeg/ffprobe: separate video + audio merged and both streams verified.');
  const data = { video: fs.readFileSync(video), audio: fs.readFileSync(audio) };
  queue = new DownloadQueue({
    directory: path.join(temp, 'queue-downloads'), stateFile: path.join(temp, 'queue.json'), toolsDirectory: path.join(root, 'tools'),
    infoExtractor: async () => ({ title: 'Sessiz görüntü + ayrı ses', duration: 1, requested_formats: [
      { url: 'https://example.com/video', protocol: 'https', ext: 'mp4', format_id: 'v', vcodec: 'h264', acodec: 'none' },
      { url: 'https://example.com/audio', protocol: 'https', ext: 'm4a', format_id: 'a', vcodec: 'none', acodec: 'aac' }
    ] }),
    rangeRequest: async (url, signal, headers) => {
      signal.throwIfAborted(); const bytes = data[url.endsWith('/video') ? 'video' : 'audio'];
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
      const start = Number(first), end = Number(last);
      const response = Readable.from([bytes.subarray(start, end + 1)]);
      response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1), etag: '"local-fixture"' };
      return { response, url: new URL(url) };
    }
  });
  queue.add({ url: 'https://example.com/split', engine: 'extractor', deepVerify: true });
  const deadline = Date.now() + 30000;
  while (queue.active.size && Date.now() < deadline) await wait(20);
  assert.equal(queue.jobs[0].status, 'completed', queue.jobs[0].error);
  assert.equal(queue.jobs[0].transfer.method, 'parallel-streams');
  assert.equal(queue.jobs[0].media.audio, true); assert.equal(queue.jobs[0].media.height, 90);
  assert.equal(queue.jobs[0].verification.deep, true);
  console.log('PASS split-stream queue: adaptive transfers -> actual FFmpeg merge -> ffprobe -> full FFmpeg decode.');
} finally {
  queue?.stop(); while (queue?.active.size) await wait(20);
  fs.rmSync(temp, { recursive: true, force: true });
}
