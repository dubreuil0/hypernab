import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnManaged } from '../src/process.js';

test('zaten iptal edilmiş işlem yeni süreç başlatmaz', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => spawnManaged(process.execPath, [], { signal: controller.signal }), { name: 'AbortError' });
});

test('Windows iptali yalnızca başlatıcıyı değil alt süreç ağacını da durdurur', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const controller = new AbortController();
  const code = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);`;
  const child = spawnManaged(process.execPath, ['-e', code], { signal: controller.signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => controller.abort());
  const [chunk] = await once(child.stdout, 'data');
  const worker = Number(chunk.toString().trim()); assert.ok(worker > 0);
  const closed = once(child, 'close'); controller.abort(); await closed;
  let alive = true;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(worker, 0); } catch { alive = false; break; }
    await delay(30);
  }
  assert.equal(alive, false, 'Alt süreç iptalden sonra çalışmaya devam etmemeli.');
});
