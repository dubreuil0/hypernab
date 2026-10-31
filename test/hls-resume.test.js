import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadHls } from '../src/hls-download.js';

const PIECE = Buffer.alloc(20000, 3);
const playlist = (durations = [2, 2, 2, 2, 2, 2]) => ({ variants: [], live: false, map: null, segments: durations.map((duration, index) => ({ url: `https://cdn.example.org/seg/${index}.ts`, duration })) });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-hls-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asked = [];
  // 'interrupt' stops the attempt while piece number N is requested, like a pause does.
  const request = (interrupt, controller) => async url => {
    const index = Number(/(\d+)\.ts$/.exec(url)[1]);
    asked.push(index);
    if (interrupt !== null && index >= interrupt) { controller.abort(new Error('paused')); throw controller.signal.reason; }
    return { response: Object.assign(Readable.from([PIECE]), { statusCode: 200, headers: { 'content-length': String(PIECE.length), 'content-type': 'video/mp2t' } }) };
  };
  const merges = [];
  const spawn = (_exe, args) => { // the merge step: a fake ffmpeg that checks it may write and writes the output
    const output = args.at(-1), child = new EventEmitter(); child.stderr = new EventEmitter();
    merges.push({ existed: fs.existsSync(output) });
    setImmediate(() => { fs.writeFileSync(output, 'merged'); child.emit('close', 0); });
    return child;
  };
  const run = ({ interrupt = null, durations, name = 'hls-job-1', progress = [] } = {}) => {
    const controller = new AbortController();
    return downloadHls({ sources: [{ url: 'https://cdn.example.org/list.m3u8', hlsPlaylist: playlist(durations) }], directory: dir, toolsDirectory: dir, signal: controller.signal, request: request(interrupt, controller), spawn, connections: 1, stagingName: name,
      onProgress: (received) => progress.push(received) });
  };
  return { dir, asked, run, merges };
}

test('a pause or retry keeps the finished pieces: only the missing ones are fetched again and the progress never falls back', async t => {
  const f = fixture(t), progress = [];
  await assert.rejects(f.run({ interrupt: 3, progress }), /paused/);
  assert.deepEqual(f.asked, [0, 1, 2, 3], 'three pieces done, the fourth was being fetched');
  const staging = path.join(f.dir, 'hls-job-1');
  assert.deepEqual(fs.readdirSync(staging).filter(name => /^0-\d+\.ts$/.test(name)).sort(), ['0-0.ts', '0-1.ts', '0-2.ts']);
  f.asked.length = 0; progress.length = 0;
  const result = await f.run({ progress });
  assert.deepEqual(f.asked, [3, 4, 5], 'the three kept pieces are not requested again');
  assert.equal(progress[0] >= 3 * PIECE.length, true, 'progress starts where the earlier attempt stopped');
  assert.equal(progress.at(-1), 6 * PIECE.length); assert.equal(result.staging, staging);
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'merged');
});

test('a different list under the same job (other piece durations) starts that track afresh', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ interrupt: 3 }), /paused/);
  f.asked.length = 0;
  await f.run({ durations: [2, 2, 2, 2, 2, 3] });
  assert.deepEqual(f.asked, [0, 1, 2, 3, 4, 5], 'nothing from the old list is reused');
});

test('half-written leftovers never count: partial files are removed and an old half-merged output does not block the merge', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ interrupt: 2 }), /paused/);
  const staging = path.join(f.dir, 'hls-job-1');
  fs.writeFileSync(path.join(staging, '0-2.ts.abc.part'), 'half'); fs.writeFileSync(path.join(staging, 'output.mp4'), 'old half merge');
  f.asked.length = 0;
  await f.run();
  assert.deepEqual(f.asked, [2, 3, 4, 5]);
  assert.equal(f.merges.at(-1).existed, false, 'the old output was removed before ffmpeg ran (it never overwrites)');
  assert.equal(fs.readdirSync(staging).some(name => name.endsWith('.part')), false);
});

test('without a staging name every attempt keeps its own private directory, as before', async t => {
  const f = fixture(t);
  const a = await f.run({ name: null }), b = await f.run({ name: null });
  assert.notEqual(a.staging, b.staging); assert.deepEqual(f.asked, [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
});
