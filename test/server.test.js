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
import { randomUUID } from 'node:crypto';

test('yerel API: anahtar, Origin/Host, eşleştirme ve kuyruk', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-api-test-'));
  fs.mkdirSync(path.join(temp, 'data')); fs.mkdirSync(path.join(temp, 'downloads'));
  const doneId = randomUUID(), failedId = randomUUID(), pausedId = randomUUID(), halfId = randomUUID();
  fs.writeFileSync(path.join(temp, 'data', 'queue.json'), JSON.stringify([
    { id: doneId, url: 'https://example.com/a.mp4', status: 'completed', file: `${doneId}-video.mp4`, received: 8 },
    { id: failedId, url: 'https://example.com/b.mp4', status: 'failed', received: 0 },
    { id: pausedId, url: 'https://example.com/c.mp4', status: 'paused', received: 4 },
    { id: halfId, url: 'https://example.com/d.mp4', status: 'cancelled', received: 4 }
  ]));
  fs.writeFileSync(path.join(temp, 'downloads', `${doneId}-video.mp4`), 'complete');
  fs.writeFileSync(path.join(temp, 'downloads', `${pausedId}-video.mp4.part`), 'half');
  fs.writeFileSync(path.join(temp, 'downloads', `${halfId}-video.mp4.part`), 'half');
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(temp, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(temp, 'downloads') }
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).status === 200) { ready = true; break; } } catch { /* Starting. */ }
    if (child.exitCode !== null) throw new Error(stderr || 'Server exited.');
    await delay(30);
  }
  assert.equal(ready, true, stderr);
  const html = await fetch(base);
  assert.match(await html.text(), /Hypernab/);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const progressAsset = await fetch(`${base}/progress-view.js`);
  assert.equal(progressAsset.status, 200);
  assert.match(progressAsset.headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${base}/compact.css`)).headers.get('content-type'), /css/);
  assert.match((await fetch(`${base}/appearance.js`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/inspect`, { method: 'POST', body: '{}' })).status, 401);
  for (const route of ['/api/queue/clear', '/api/queue/bulk']) assert.equal((await fetch(`${base}${route}`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 403);
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/jobs`, { headers })).status, 200);
  const location = await (await fetch(`${base}/api/jobs/${doneId}/location`, { headers })).json();
  assert.equal(location.directory, path.join(temp, 'downloads')); assert.equal(location.file, `${doneId}-video.mp4`);
  assert.equal((await fetch(`${base}/api/jobs/${doneId}/location`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/${doneId}/location`, { headers: { ...headers, Origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403);
  const initialJobs = await (await fetch(`${base}/api/jobs`, { headers })).json();
  for (const job of initialJobs) {
    assert.equal(job.progress.phase, job.status);
    assert.equal(job.progress.speed, 0);
    assert.equal(job.progress.etaSeconds, null);
    assert.equal(job.progress.received, job.received);
  }
  assert.equal((await fetch(`${base}/api/jobs`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403);
  const paired = await fetch(`${base}/api/status`, { headers: { ...headers, Origin: `chrome-extension://${'a'.repeat(32)}` } });
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get('access-control-allow-origin'), `chrome-extension://${'a'.repeat(32)}`);
  const preflight = await fetch(`${base}/api/jobs`, { method: 'OPTIONS', headers: { Origin: `chrome-extension://${'a'.repeat(32)}` } });
  assert.equal(preflight.status, 204);
  const firefoxOrigin = 'moz-extension://550e8400-e29b-41d4-a716-446655440000';
  const firefoxHeaders = { ...headers, Origin: firefoxOrigin };
  const firefoxStatus = await fetch(`${base}/api/status`, { headers: firefoxHeaders });
  assert.equal(firefoxStatus.status, 200);
  assert.equal(firefoxStatus.headers.get('access-control-allow-origin'), firefoxOrigin);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Origin: firefoxOrigin } })).status, 401);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: firefoxHeaders })).status, 403);
  const firefoxPreflight = await fetch(`${base}/api/jobs`, { method: 'OPTIONS', headers: { Origin: firefoxOrigin } });
  assert.equal(firefoxPreflight.status, 204);
  assert.match(firefoxPreflight.headers.get('access-control-allow-headers'), /Authorization/);
  for (const badOrigin of [`${firefoxOrigin}.evil.example`, 'moz-extension://not-a-uuid', 'null']) {
    assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: badOrigin } })).status, 403);
  }
  const bad = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1/private', engine: 'direct' }) });
  assert.equal(bad.status, 400);
  const badInspection = await fetch(`${base}/api/inspect`, { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1/private', engine: 'direct' }) });
  assert.equal(badInspection.status, 400);
  const large = await fetch(`${base}/api/jobs`, { method: 'POST', headers, body: JSON.stringify({ url: 'x'.repeat(17000) }) });
  assert.equal(large.status, 400);
  const spoofedHost = await new Promise((resolve, reject) => {
    http.get(`${base}/api/bootstrap`, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(spoofedHost, 403);
  const post = async (route, data) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(data) });
  const downloadFiles = fs.readdirSync(path.join(temp, 'downloads'));
  const clearResponse = await post('/api/queue/clear', {});
  assert.equal(clearResponse.status, 200); assert.equal((await clearResponse.json()).removed, 3);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'downloads')), downloadFiles);
  assert.equal(fs.readFileSync(path.join(temp, 'downloads', `${doneId}-video.mp4`), 'utf8'), 'complete');
  const remaining = await (await fetch(`${base}/api/jobs`, { headers })).json();
  assert.deepEqual(remaining.map(j => j.id), [pausedId]); assert.ok(remaining.every(j => !j.canClear));
  assert.equal(fs.readFileSync(path.join(temp, 'downloads', `${halfId}-video.mp4.part`), 'utf8'), 'half');
  const pauseAll = await post('/api/queue/bulk', { action: 'pause', all: true });
  assert.equal((await pauseAll.json()).queuePaused, undefined, 'kalıcı genel duraklatma modu olmamalı');
  const submissionId = randomUUID();
  const submissionInput = { url: 'https://example.com/test.mp4', engine: 'direct', submissionId };
  const added = await post('/api/jobs', submissionInput);
  const { id: addedId } = await added.json();
  assert.equal((await fetch(`${base}/api/submissions/${submissionId}`)).status, 401);
  const replay = await fetch(`${base}/api/jobs`, { method: 'POST', headers: firefoxHeaders, body: JSON.stringify(submissionInput) });
  assert.equal((await replay.json()).id, addedId, 'Firefox ile HTTP istemcisi aynı gönderimi çoğaltmamalı');
  const receipt = await (await fetch(`${base}/api/submissions/${submissionId}`, { headers })).json();
  assert.equal(receipt.id, addedId); assert.equal(receipt.listed, true);
  assert.equal((await post('/api/jobs', { ...submissionInput, title: 'changed' })).status, 400);
  const queued = await (await fetch(`${base}/api/jobs`, { headers })).json();
  assert.notEqual(queued.find(j => j.id === addedId).status, 'paused', 'tümünü duraklat sonradan eklenen indirmeyi bekletmemeli');
  assert.equal((await post(`/api/jobs/${addedId}/pause`, {})).status, 200);
  const cancelled = await post('/api/queue/bulk', { action: 'cancel', ids: [addedId] });
  assert.equal((await cancelled.json()).changed, 1);
  // The new job really started, so its aborted worker must exit before its row can be cleared.
  for (let i = 0; i < 150; i++) {
    const rows = await (await fetch(`${base}/api/jobs`, { headers })).json();
    if (rows.find(j => j.id === addedId)?.canClear) break;
    await delay(20);
  }
  const selectedClear = await post('/api/queue/clear', { ids: [addedId, pausedId, halfId] });
  assert.equal((await selectedClear.json()).removed, 1);
  const afterClearReplay = await post('/api/jobs', submissionInput);
  assert.equal((await afterClearReplay.json()).id, addedId);
  assert.equal((await (await fetch(`${base}/api/jobs`, { headers })).json()).some(job => job.id === addedId), false);
  const abandoned = randomUUID();
  assert.equal((await post(`/api/submissions/${abandoned}/abandon`, {})).status, 200);
  assert.equal((await post('/api/jobs', { ...submissionInput, submissionId: abandoned })).status, 400);
  assert.equal((await post('/api/queue/bulk', { action: 'cancel' })).status, 400);
  assert.equal((await post('/api/queue/clear', { ids: 'all' })).status, 400);
  assert.equal((await post('/api/queue/bulk', { action: 'cancel', ids: Array.from({ length: 500 }, () => randomUUID()) })).status, 200);
  assert.equal((await post('/api/queue/bulk', { action: 'cancel', ids: Array.from({ length: 501 }, () => randomUUID()) })).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'downloads')), downloadFiles);
  const app = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.match(app.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal((await post('/api/app/shutdown', { confirm: false, instanceId: app.instanceId })).status, 409);
  assert.equal((await post('/api/app/shutdown', { confirm: true, instanceId: randomUUID() })).status, 409);
});
