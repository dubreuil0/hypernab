import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

test('the app learns that the extension is talking to it: extension origin or native host header, never from the page itself', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-extstatus-'));
  fs.mkdirSync(path.join(temp, 'data')); fs.mkdirSync(path.join(temp, 'downloads'));
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'ignore',
    env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(temp, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(temp, 'downloads') } });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } fs.rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).status === 200) break; } catch { /* starting */ } await delay(30); }
  const token = (await (await fetch(`${base}/api/bootstrap`, { headers: { 'sec-fetch-site': 'same-origin' } })).json()).token;
  const get = (route, headers = {}) => fetch(base + route, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  assert.equal((await (await get('/api/extension')).json()).connected, false, 'nobody has talked yet');
  await get('/api/status'); // the app's own page: not the extension
  assert.equal((await (await get('/api/extension')).json()).connected, false, 'the local page does not count');
  await get('/api/prefs', { 'X-Hypernab-Client': 'extension' }); // what the native host sends
  const seen = await (await get('/api/extension')).json();
  assert.equal(seen.connected, true); assert.ok(Date.now() - seen.seenAt < 5000);
  assert.equal((await fetch(`${base}/api/extension`)).status, 401, 'needs the key');
  assert.equal((await get('/api/extension', { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).status, 403, 'the answer is for the app window only');
});
