// Real local HTTP sockets + real FFmpeg/ffprobe. Never touches the installed engine or user downloads.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { downloadHls } from '../src/hls-download.js';
import { verifyVideo } from '../src/media.js';
import { spawnManaged } from '../src/process.js';

const directory = fs.mkdtempSync((process.env.LOCALAPPDATA + '/Temp/opencode/hypernab-recovery-smoke-'));
const fixture = path.join(directory, 'fixture'); fs.mkdirSync(fixture);
const toolsDirectory = path.resolve(import.meta.dirname, '../tools');
const made = spawnSync(path.join(toolsDirectory, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', 'index.m3u8'], { cwd: fixture });
assert.equal(made.status, 0, String(made.stderr));
const counts = new Map(), retries = [], updates = [];
const server = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://localhost').pathname);
  const count = (counts.get(name) || 0) + 1; counts.set(name, count);
  if (count === 1 && ['index.m3u8', 'index0.ts', 'index2.ts'].includes(name)) {
    res.writeHead(name === 'index.m3u8' ? 202 : name === 'index0.ts' ? 503 : 429, { 'retry-after': '0.05', 'content-type': 'text/html' }); res.end('not a video'); return;
  }
  const bytes = fs.readFileSync(path.join(fixture, name));
  res.writeHead(200, { 'content-length': String(bytes.length), 'content-type': name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl' });
  if (count === 1 && name === 'index1.ts') { res.write(bytes.subarray(0, 100)); setTimeout(() => res.destroy(), 10); return; }
  res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
// The injected adapter maps only our synthetic public fixture origin to this isolated loopback server.
const request = (raw, signal) => new Promise((resolve, reject) => {
  const url = new URL(raw); assert.equal(url.origin, 'https://fixture.example.org');
  const req = http.get({ hostname: '127.0.0.1', port, path: url.pathname, signal }, response => resolve({ response, url }));
  req.on('error', reject);
});
try {
  const result = await downloadHls({ sources: [{ url: 'https://fixture.example.org/index.m3u8' }], directory, toolsDirectory, signal: AbortSignal.timeout(30000), connections: 4, request, spawn: spawnManaged,
    onRetry: detail => retries.push(detail), onProgress: (received, connections, metrics) => updates.push({ received, connections, ...metrics }) });
  const video = await verifyVideo(result.output, toolsDirectory, 5, AbortSignal.timeout(10000));
  assert.equal(video.height, 180); assert.equal(video.audio, true);
  assert.equal(counts.get('index.m3u8'), 2);
  for (const name of fs.readdirSync(fixture).filter(name => name.endsWith('.ts'))) assert.equal(counts.get(name), ['index0.ts', 'index1.ts', 'index2.ts'].includes(name) ? 2 : 1, name);
  assert.ok(retries.some(item => item.status === 202)); assert.ok(retries.some(item => item.status === 429)); assert.ok(retries.some(item => item.status === 503));
  assert.ok(retries.some(item => item.reason === 'network'));
  const expected = fs.readdirSync(fixture).filter(name => name.endsWith('.ts')).reduce((sum, name) => sum + fs.statSync(path.join(fixture, name)).size, 0);
  assert.equal(updates.at(-1).received, expected); assert.ok(updates.at(-1).networkBytes > expected);
  const report = { passed: true, verified: { height: video.height, audio: video.audio }, requests: Object.fromEntries(counts), retries, committedBytes: expected, networkBytes: updates.at(-1).networkBytes };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('OK real HTTP 202/429/503 and interrupted body: same HLS track recovered, healthy pieces fetched once, real audio/video verified.');
  console.log(`Report: ${path.join(directory, 'report.json')}`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
