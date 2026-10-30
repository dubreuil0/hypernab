import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { downloadHls } from '../src/hls-download.js';
import { parseHls } from '../src/hls.js';
import { SourceExpiredError } from '../src/transfer.js';

const base = 'https://media.example.org/index.m3u8';
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + Array.from({ length: 8 }, (_, i) => `#EXTINF:2,\ns${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n';
const response = (body, statusCode = 200, headers = {}) => Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync((process.env.LOCALAPPDATA + '/Temp/opencode/hypernab-hls-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let merged = false;
  const spawn = (_exe, args) => {
    merged = true;
    const local = args[args.indexOf('-i') + 1], folder = path.dirname(local);
    const names = fs.readFileSync(local, 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
    assert.equal(names.length, 8);
    names.forEach((name, index) => assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), `piece-${index}`));
    assert.ok(args.includes('file')); assert.ok(args.every(arg => !arg.startsWith('https:')));
    const child = new EventEmitter(); child.stderr = new PassThrough();
    fs.writeFileSync(args.at(-1), 'verified-by-separate-layer');
    setImmediate(() => child.emit('close', 0)); return child;
  };
  return { run: extra => downloadHls({ directory, toolsDirectory: directory, sources: [{ url: base, hlsPlaylist: parseHls(playlist, base) }], signal: AbortSignal.timeout(10000), connections: 1, recovery: { baseDelayMs: 1 }, spawn, ...options, ...extra }), merged: () => merged, directory };
}

for (const failure of ['503', '202', 'reset', 'short']) test(`HLS piece ${failure}: only failed piece retries; completed pieces and byte accounting stay correct`, async t => {
  const f = fixture(t), counts = new Map(), updates = [], retries = [];
  const result = await f.run({ request: async target => {
    const index = Number(/s(\d+)\.ts/.exec(target)[1]), count = (counts.get(index) || 0) + 1; counts.set(index, count);
    if (index === 3 && count === 1) {
      if (failure === 'reset') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (failure === 'short') return { response: response('x', 200, { 'content-length': '7' }) };
      return { response: response('', Number(failure), { 'retry-after': '0' }) };
    }
    return { response: response(`piece-${index}`, 200, { 'content-length': '7' }) };
  }, onProgress: (received, _active, metrics) => updates.push({ received, ...metrics }), onRetry: detail => retries.push(detail) });
  assert.equal(f.merged(), true); assert.equal(fs.existsSync(result.output), true);
  assert.equal(counts.get(3), 2); assert.ok([...counts].every(([index, count]) => count === (index === 3 ? 2 : 1)));
  assert.equal(retries.length, 1); assert.equal(updates.at(-1).received, 56);
  assert.equal(updates.at(-1).networkBytes, failure === 'short' ? 57 : 56);
});

test('HLS permanent access error stops without retry, merge or falsely completed output', async t => {
  const f = fixture(t); let count = 0;
  await assert.rejects(f.run({ request: async () => { count++; return { response: response('', 403) }; } }), SourceExpiredError);
  assert.equal(count, 1); assert.equal(f.merged(), false);
});

test('HLS partial body never publishes after exhausted retries; completed neighbouring piece remains', async t => {
  const f = fixture(t), counts = new Map();
  await assert.rejects(f.run({ request: async target => {
    const index = Number(/s(\d+)\.ts/.exec(target)[1]); counts.set(index, (counts.get(index) || 0) + 1);
    return { response: response(index === 1 ? 'x' : `piece-${index}`, 200, { 'content-length': '7' }) };
  } }), /eksik/);
  assert.equal(counts.get(0), 1); assert.equal(counts.get(1), 3); assert.equal(f.merged(), false);
  const stage = path.join(f.directory, fs.readdirSync(f.directory)[0]);
  assert.equal(fs.readFileSync(path.join(stage, '0-0.ts'), 'utf8'), 'piece-0');
  assert.equal(fs.existsSync(path.join(stage, '0-1.ts')), false);
});

test('HLS rate-limit reduces actual request concurrency, including retries already holding reserved pieces', async t => {
  const f = fixture(t, { connections: 4 }); let active = 0, limited = false, peakAfterReduction = 0;
  const result = await f.run({ request: async (target, signal) => {
    if (!limited) { limited = true; return { response: response('', 429, { 'retry-after': '0' }) }; }
    active++; peakAfterReduction = Math.max(peakAfterReduction, active);
    await wait(3, null, { signal });
    const index = Number(/s(\d+)\.ts/.exec(target)[1]);
    const res = response(`piece-${index}`); res.once('close', () => { active--; }); return { response: res };
  } });
  assert.equal(fs.existsSync(result.output), true); assert.ok(peakAfterReduction <= 3, `pre-existing requests may finish; peak ${peakAfterReduction}`); assert.equal(active, 0);
});

test('HLS cancellation during recovery releases responses and never schedules another piece or merge', async t => {
  const f = fixture(t), controller = new AbortController(); let count = 0;
  await assert.rejects(f.run({ signal: controller.signal, request: async () => { count++; return { response: response('', 503) }; }, onRetry: () => controller.abort(new Error('pause')) }), /abort|pause/i);
  assert.equal(count, 1); assert.equal(f.merged(), false);
});
