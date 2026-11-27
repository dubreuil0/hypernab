import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { downloadParallel } from '../src/transfer.js';
import { AdaptiveWindow, ConnectionBudget } from '../src/connection-budget.js';

// Synthetic run: every step is one 3 s window; two healthy blocks finish per step, as in a long download.
function simulate(window, rateOf, steps, { activeOf = w => w.target, window3 = 3000 } = {}) {
  let now = 0; const targets = [];
  for (let i = 0; i < steps; i++) {
    now += window3;
    window.observe(rateOf(window.target), activeOf(window), now);
    window.sample(1000, 10); window.sample(1000, 10);
    targets.push(window.target);
  }
  return targets;
}

test('plato: dosya başına sınırlı sunucuda hedef 3 bağlantıyı geçmez, bekleme boyunca sabit kalır, sonra yeniden dener', () => {
  const window = new AdaptiveWindow(8, 2, { plateauHoldMs: 60000, contended: () => true });
  const targets = simulate(window, t => (t >= 2 ? 1000 : 500) * 1024, 12);
  assert.ok(Math.max(...targets) <= 3, targets.join()); assert.equal(window.target, 2); assert.equal(window.ceiling, 2); assert.ok(window.plateaus >= 1);
  const held = simulate(window, t => (t >= 2 ? 1000 : 500) * 1024, 5);
  assert.ok(held.every(t => t <= 3));
  // hold expires (60 s = 20 windows): one re-probe step happens, then it settles again
  const later = simulate(window, t => (t >= 2 ? 1000 : 500) * 1024, 30);
  assert.ok(Math.max(...later) <= 3);
});
test('plato: bekleme bitince sunucu hızlanmışsa yeniden denemeyle bağlantı artar', () => {
  const window = new AdaptiveWindow(8, 2, { plateauHoldMs: 6000, contended: () => true });
  let fast = false; const rate = t => (fast ? 400 * t : 1000) * 1024;
  simulate(window, rate, 8); assert.equal(window.target, 2);
  fast = true; simulate(window, rate, 40); assert.equal(window.target, 8);
});
test('bağlantı başına sınırlı sunucuda (hız ~ bağlantı sayısı) en yüksek sınıra çıkar', () => {
  const window = new AdaptiveWindow(8, 2, { contended: () => true });
  simulate(window, t => 500 * 1024 * t, 40); assert.equal(window.target, 8); assert.equal(window.plateaus, 0);
});
test('sınırsız/hızlı sunucuda (hız bağlantıyla artar) en yüksek sınıra çıkar', () => {
  const window = new AdaptiveWindow(8, 2, { contended: () => true });
  simulate(window, t => 5e6 * Math.pow(t, 0.9), 40); assert.equal(window.target, 8); assert.equal(window.plateaus, 0);
});
test('aç bırakılmış pencereler (aktif bağlantı < hedef) plato kararı doğurmaz', () => {
  const window = new AdaptiveWindow(8, 2, { contended: () => true });
  simulate(window, t => 500 * 1024 * t, 4);
  const before = window.target;
  simulate(window, () => 1000 * 1024, 40, { activeOf: w => w.target - 1 });
  assert.equal(window.plateaus, 0); assert.equal(window.ceiling, null); assert.ok(window.target >= before);
});
test('plato hedefi 1 altına inmez, azami değeri aşmaz', () => {
  const window = new AdaptiveWindow(1, 2, { contended: () => true }); simulate(window, () => 1000, 10); assert.equal(window.target, 1);
  const w2 = new AdaptiveWindow(8, 1, { contended: () => true }); simulate(w2, () => 1000 * 1024, 20); assert.ok(w2.target >= 1 && w2.target <= 8);
});

// Copy of the original per-block window: with contended() false the new class must follow it step for step.
class OriginalWindow {
  constructor(maximum, initial = 2) { this.maximum = maximum; this.target = Math.min(initial, maximum); this.healthy = 0; this.rate = null; this.reductions = 0; }
  sample(bytes, milliseconds) {
    const rate = bytes * 1000 / Math.max(milliseconds, 1);
    const degraded = this.rate !== null && rate < this.rate * 0.65;
    this.rate = this.rate === null ? rate : this.rate * 0.7 + rate * 0.3;
    if (degraded && this.target > 1) { this.target--; this.healthy = 0; this.reductions++; }
    else if (++this.healthy >= 2 && this.target < this.maximum) { this.target++; this.healthy = 0; }
  }
  failure() { this.target = Math.max(1, Math.floor(this.target / 2)); this.healthy = 0; this.reductions++; }
}
test('cekisme yokken pencere ozgun surumle adim adim aynidir (plato pencereleri araya girse de)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const maximum of [1, 2, 8]) {
    const old = new OriginalWindow(maximum), now = new AdaptiveWindow(maximum, 2, { contended: () => false });
    let clock = 0, growth = 0, previous = old.target;
    for (let i = 0; i < 600; i++) {
      const roll = rnd();
      if (roll < 0.05) { old.failure(); now.failure(); }
      else if (roll < 0.35) { clock += 3000; now.observe(1000 * 1024, now.target, clock); } // flat windows: must change nothing
      else { const ms = 5 + Math.floor(rnd() * 40), bytes = roll < 0.45 ? 100 : 1000; old.sample(bytes, ms); now.sample(bytes, ms); }
      assert.equal(now.target, old.target, `step ${i}`); assert.equal(now.reductions, old.reductions);
      if (old.target > previous) growth++; previous = old.target;
    }
    assert.equal(now.plateaus, 0); assert.equal(now.ceiling, null); assert.ok(maximum === 1 || growth > 0);
  }
});
test('cekisme baslayinca plato uygulanir, bitince tavan hemen kalkar ve pencere yeniden serbestce buyur', () => {
  let contended = false; const window = new AdaptiveWindow(8, 2, { plateauHoldMs: 60000, contended: () => contended });
  const flat = t => (t >= 2 ? 1000 : 500) * 1024;
  simulate(window, flat, 40); assert.equal(window.target, 8); assert.equal(window.plateaus, 0); assert.equal(window.ceiling, null);
  contended = true; const targets = simulate(window, flat, 12);
  assert.ok(window.plateaus >= 1); assert.ok(window.ceiling !== null && window.ceiling <= 3); assert.ok(targets.at(-1) <= 3);
  contended = false; window.sample(1000, 10); assert.equal(window.ceiling, null);
  simulate(window, flat, 10); assert.equal(window.target, 8);
});
// downloadParallel against fake range sources
const data = Buffer.from(Array.from({ length: 5 * 1024 * 1024 }, (_, i) => (i * 7) % 251));
function limitedSource({ total = 0, perConnection = 0 }) {
  const step = total ? 32768 : 4096; // chunks must be large enough that timer granularity does not become a hidden per-connection cap
  const shared = { free: 0 };
  const take = (bucket, n, rate) => { const now = performance.now(), start = Math.max(now, bucket.free); bucket.free = start + n / rate * 1000; return start - now; };
  return async (_url, signal, headers) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range); const start = Number(a), end = Number(b), own = { free: 0 };
    const response = Readable.from((async function* () {
      for (let offset = start; offset <= end; offset += step) {
        const chunk = data.subarray(offset, Math.min(end + 1, offset + step));
        if (end > start) { const delay = Math.max(total ? take(shared, chunk.length, total) : 0, perConnection ? take(own, chunk.length, perConnection) : 0); if (delay > 0) await wait(delay, null, { signal }); }
        yield chunk;
      }
    })());
    response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1), etag: '"stable"' };
    return { response };
  };
}
function destination(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-plateau-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, 'file.bin');
}
test('downloadParallel: cekisme varken dosya toplami sinirliysa plato olur, baglantilar en yuksek sinira cikmaz; dosya dogru', async t => {
  const file = destination(t);
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'k', blockSize: 262144, throughputWindowMs: 120, contended: () => true, request: limitedSource({ total: 2.5 * 1024 * 1024 }) });
  assert.deepEqual(fs.readFileSync(file), data); assert.ok(result.plateaus >= 1, 'plateaus ' + result.plateaus); assert.ok(result.connections <= 7, 'peak ' + result.connections);
});
test('downloadParallel: cekisme yokken plato mantigi hic devreye girmez', async t => {
  const file = destination(t);
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'k', blockSize: 262144, throughputWindowMs: 120, contended: () => false, request: limitedSource({ total: 2.5 * 1024 * 1024 }) });
  assert.deepEqual(fs.readFileSync(file), data); assert.equal(result.plateaus, 0);
});
test('downloadParallel: baglanti basina sinirliysa baglantilar cekisme olsun olmasin buyur', async t => {
  for (const contended of [false, true]) {
    const file = destination(t);
    const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'k', blockSize: 65536, throughputWindowMs: 100, contended: () => contended, request: limitedSource({ perConnection: 400 * 1024 }) });
    assert.deepEqual(fs.readFileSync(file), data); assert.ok(result.connections >= 5, 'contended ' + contended + ' peak ' + result.connections);
  }
});
test('ConnectionBudget.waitingOthers yalniz baska sahiplerin bekleyenlerini sayar', async () => {
  const budget = new ConnectionBudget({ total: 12, perHost: 2 });
  const held = [await budget.acquire('h.example', undefined, 1, { owner: 'a' }), await budget.acquire('h.example', undefined, 1, { owner: 'a' })];
  const own = budget.acquire('h.example', undefined, 1, { owner: 'a' }), other = budget.acquire('h.example', undefined, 1, { owner: 'b' }), nobody = budget.acquire('h.example');
  assert.equal(budget.snapshot().waiting, 3);
  assert.equal(budget.waitingOthers('a'), 2); assert.equal(budget.waitingOthers('b'), 2); assert.equal(budget.waitingOthers('c'), 3);
  held.forEach(release => release()); for (const p of [own, other, nobody]) (await p)();
  assert.equal(budget.waitingOthers('a'), 0);
});
test('downloadParallel: kendi istekleri bekleyen tek indirme cekismeli sayilmaz, plato uygulanmaz', async t => {
  const file = destination(t), budget = new ConnectionBudget({ total: 12, perHost: 2 }), inner = limitedSource({ perConnection: 400 * 1024 });
  let sawOwnWait = false, sawContended = false;
  const request = (url, signal, headers) => { const pending = budget.request(inner, url, signal, headers, { owner: 'job' }); if (budget.snapshot().waiting > 0) sawOwnWait = true; return pending; };
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'k', blockSize: 65536, throughputWindowMs: 100, request, contended: () => { const c = budget.waitingOthers('job') > 0; sawContended ||= c; return c; } });
  assert.deepEqual(fs.readFileSync(file), data); assert.ok(sawOwnWait); assert.equal(sawContended, false); assert.equal(result.plateaus, 0); assert.ok(result.connections >= 2);
});
test('downloadParallel: baska sahip beklerken cekismeli sayilir', async t => {
  const file = destination(t), budget = new ConnectionBudget({ total: 12, perHost: 8 }), inner = limitedSource({ total: 2.5 * 1024 * 1024 });
  const held = []; for (let i = 0; i < 8; i++) held.push(await budget.acquire('busy.example', undefined, 1, { owner: 'other' }));
  const waiting = budget.acquire('busy.example', undefined, 1, { owner: 'other2' });
  t.after(async () => { held.forEach(release => release()); (await waiting)(); });
  assert.equal(budget.waitingOthers('job'), 1);
  const request = (url, signal, headers) => budget.request(inner, url, signal, headers, { owner: 'job' });
  const result = await downloadParallel({ url: 'https://example.com/a', destination: file, sourceKey: 'k', blockSize: 262144, throughputWindowMs: 120, request, contended: () => budget.waitingOthers('job') > 0 });
  assert.deepEqual(fs.readFileSync(file), data); assert.ok(result.plateaus >= 1, 'plateaus ' + result.plateaus);
});