import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { ConnectionBudget } from '../src/connection-budget.js';
import { DownloadQueue } from '../src/downloads.js';

const tick = () => wait(5);
// Resolves with 'granted' as soon as the promise settles, 'pending' if it is still waiting after a short moment.
async function state(promise) { return Promise.race([promise.then(() => 'granted', () => 'rejected'), wait(30).then(() => 'pending')]); }

test('a priority request never waits behind a full normal queue and does not change normal capacity', async () => {
  const budget = new ConnectionBudget();
  const held = [];
  for (let i = 0; i < 8; i++) held.push(await budget.acquire('a.example', null));
  for (let i = 0; i < 4; i++) held.push(await budget.acquire('b.example', null));
  assert.equal(budget.active, 12);
  const order = [];
  const waiters = Array.from({ length: 10 }, (_, i) => budget.acquire(i % 2 ? 'a.example' : 'b.example', null, 1, { owner: `o${i}` }).then(release => { order.push(i); return release; }));
  await tick();
  assert.equal(budget.snapshot().waiting, 10);
  const release = await Promise.race([budget.acquire('a.example', null, 1, { priority: true }), wait(200).then(() => null)]);
  assert.ok(release, 'priority acquire resolves at once');
  assert.equal(budget.active, 12); assert.equal(budget.snapshot().priorityActive, 1);
  release();
  await tick();
  assert.equal(budget.active, 12); assert.equal(order.length, 0); // releasing the reserve must not admit a normal entry
  held.pop()(); await tick();
  assert.equal(budget.active, 12); assert.equal(order.length, 1);
  assert.ok(budget.active <= budget.limit);
  for (const r of held) r();
  const rest = await Promise.all(waiters);
  for (const r of rest) r();
  assert.equal(budget.active, 0); assert.equal(budget.owners.size, 0);
});

test('the priority reserve is limited: a third waits for a release, abort frees nothing extra', async () => {
  const budget = new ConnectionBudget({ reserve: 2 });
  const p1 = await budget.acquire('x.example', null, 1, { priority: true });
  const p2 = await budget.acquire('y.example', null, 1, { priority: true });
  const controller = new AbortController();
  const aborted = budget.acquire('z.example', controller.signal, 1, { priority: true });
  const third = budget.acquire('w.example', null, 1, { priority: true });
  assert.equal(await state(third), 'pending');
  assert.equal(budget.snapshot().priorityWaiting, 2);
  controller.abort(new Error('stop'));
  await assert.rejects(aborted, /stop/);
  assert.equal(budget.priorityActive, 2); assert.equal(await state(third), 'pending');
  p1();
  const r3 = await third;
  assert.equal(budget.priorityActive, 2);
  p2(); r3();
  assert.equal(budget.priorityActive, 0); assert.equal(budget.active, 0);
  assert.equal(budget.priorityHosts.size, 0);
});

test('a host cooldown delays priority entries too', async () => {
  const budget = new ConnectionBudget();
  budget.cooldown('slow.example', 150);
  const started = Date.now();
  const release = await budget.acquire('slow.example', null, 1, { priority: true });
  assert.ok(Date.now() - started >= 100, `waited ${Date.now() - started} ms`);
  release();
  const other = await budget.acquire('other.example', null, 1, { priority: true });
  other();
});

test('slots are shared fairly: owners with no connection are served before the owner that holds many', async () => {
  const budget = new ConnectionBudget();
  const a = [];
  for (let i = 0; i < 8; i++) a.push(await budget.acquire('h.example', null, 1, { owner: 'A' }));
  const got = { B: [], C: [] }, order = [];
  const ask = owner => budget.acquire('h.example', null, 1, { owner }).then(release => { got[owner].push(release); order.push(owner); });
  for (let i = 0; i < 4; i++) ask('B'); // B queued first, with several entries
  await tick();
  for (let i = 0; i < 4; i++) ask('C');
  await tick();
  assert.equal(order.length, 0);
  for (let i = 0; i < 4; i++) { a[i](); await tick(); }
  assert.deepEqual(order, ['B', 'C', 'B', 'C']);
  assert.ok(got.B.length > 0 && got.C.length > 0);
  for (const r of [...a, ...got.B, ...got.C]) r();
  await tick();
  for (const r of [...got.B, ...got.C]) r();
});

test('a lone owner still reaches the per-host limit', async () => {
  const budget = new ConnectionBudget();
  const held = [];
  for (let i = 0; i < 8; i++) held.push(await budget.acquire('h.example', null, 1, { owner: 'solo' }));
  assert.equal(budget.active, 8);
  assert.equal(await state(budget.acquire('h.example', null, 1, { owner: 'solo' })), 'pending'); // the per-host cap, as before
  const other = await budget.acquire('g.example', null, 1, { owner: 'solo' });
  assert.equal(budget.active, 9);
  other(); for (const r of held) r();
});

test('an aborted waiting entry leaves no owner count behind', async () => {
  const budget = new ConnectionBudget({ total: 2, perHost: 2 });
  const first = await budget.acquire('h.example', null, 2, { owner: 'A' });
  const controller = new AbortController();
  const waiting = budget.acquire('h.example', controller.signal, 1, { owner: 'B' });
  controller.abort(new Error('gone'));
  await assert.rejects(waiting, /gone/);
  first();
  assert.equal(budget.owners.size, 0); assert.equal(budget.active, 0);
});

test('an interactive look-up answers quickly while running downloads hold the whole budget', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-budget-'));
  fs.writeFileSync(path.join(root, 'ffmpeg.exe'), 'test-double');
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nv2.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts\n#EXT-X-ENDLIST\n';
  const base = 'https://cdn.example.org/video/master';
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root,
    rangeRequest: async target => ({ url: new URL(target), response: Object.assign(Readable.from([Buffer.from(target === base ? master : media)]), { statusCode: 200, headers: {} }) }),
    mediaInspector: () => { throw new Error('yt-dlp MUST NOT run'); }, infoExtractor: () => { throw new Error('yt-dlp MUST NOT run'); } });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  // Slow range requests of running downloads hold every slot, and more are queued behind them.
  const holders = [];
  for (let i = 0; i < 8; i++) holders.push(await queue.budget.acquire('cdn.example.org', null, 1, { owner: 'job-a' }));
  for (let i = 0; i < 4; i++) holders.push(await queue.budget.acquire('other.example.org', null, 1, { owner: 'job-b' }));
  const queued = Array.from({ length: 6 }, () => queue.budget.acquire('cdn.example.org', null, 1, { owner: 'job-c' }));
  assert.equal(queue.budget.snapshot().active, 12);
  const started = Date.now();
  const view = await queue.inspect({ url: base, mediaKind: 'HLS' });
  assert.ok(Date.now() - started < 1000, `inspect took ${Date.now() - started} ms`);
  assert.ok(view.options.length > 0);
  for (const r of holders) r();
  for (const release of await Promise.all(queued)) release();
});

test('setLimit raises capacity and drains waiters at once; per-host cap still holds', async () => {
  const budget = new ConnectionBudget();
  const held = [];
  for (let i = 0; i < 8; i++) held.push(await budget.acquire('a.example', null));
  for (let i = 0; i < 4; i++) held.push(await budget.acquire('b.example', null));
  const waiters = [budget.acquire('b.example', null), budget.acquire('b.example', null), budget.acquire('a.example', null)];
  await tick();
  assert.equal(budget.snapshot().waiting, 3);
  budget.setLimit(24);
  await tick();
  assert.equal(budget.limit, 24); assert.equal(budget.perHost, 8);
  assert.equal(budget.snapshot().waiting, 1); // the third wants host a, already at 8
  assert.equal(budget.active, 14);
  held[0]();
  await tick();
  assert.equal(budget.snapshot().waiting, 0);
});

test('lowering the limit never revokes held slots and blocks new grants until under it', async () => {
  const budget = new ConnectionBudget({ total: 12, perHost: 8 });
  const held = [];
  for (let i = 0; i < 10; i++) held.push(await budget.acquire(`h${i % 3}.example`, null));
  budget.setLimit(4);
  assert.equal(budget.active, 10);
  const next = budget.acquire('z.example', null);
  assert.equal(await state(next), 'pending');
  for (let i = 0; i < 6; i++) held[i]();
  assert.equal(await state(next), 'pending'); // active 4, limit 4
  held[6]();
  assert.equal(await state(next), 'granted');
  budget.setLimit(0); assert.equal(budget.limit, 1);
  budget.setLimit(99); assert.equal(budget.limit, 32);
});

test('the queue scales the shared total with running downloads: 12 for 1-3, 16 for 4, 24 for 6, back to 12', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-budget-scale-'));
  for (const tool of ['yt-dlp.exe', 'ffprobe.exe', 'ffmpeg.exe']) fs.writeFileSync(path.join(root, tool), 'test-double');
  let open; const gate = new Promise(resolve => { open = resolve; });
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root,
    rangeRequest: async () => { await gate; throw new Error('stop'); }, autoRetries: 0 });
  t.after(() => { open(); queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const seen = [];
  for (let i = 1; i <= 6; i++) {
    queue.add({ url: `https://cdn${i}.example.net/file.mp4`, engine: 'direct', title: `v${i}` });
    for (let k = 0; k < 100 && queue.active.size < i; k++) await wait(10);
    seen.push([queue.active.size, queue.budget.limit]);
  }
  assert.deepEqual(seen, [[1, 12], [2, 12], [3, 12], [4, 16], [5, 20], [6, 24]]);
  open();
  for (let k = 0; k < 300 && queue.active.size; k++) await wait(10);
  assert.equal(queue.active.size, 0); assert.equal(queue.budget.limit, 12);
});
