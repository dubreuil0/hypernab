import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';
import { NativeDecoder, nativeFrame, validateNativeRequest, validateNativeCaller } from '../src/native-protocol.js';
import { NativeGateway } from '../src/native-host.js';
import { chromiumExtensionId, nativeRegistryKeys, installNative } from '../scripts/install-native.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';

test('Native binary framing UTF-8 byte uzunluğunu kullanır, parçalı/birleşik mesajlar bozulmaz', () => {
  const values = [], decoder = new NativeDecoder(value => values.push(value));
  const first = nativeFrame({ title: 'Türkçe ğüşi — 😀' });
  assert.equal(first.readUInt32LE(), first.length - 4);
  const bytes = Buffer.concat([first, nativeFrame({ another: true })]);
  for (let i = 0; i < bytes.length; i += 3) decoder.push(bytes.subarray(i, i + 3));
  decoder.end(); assert.deepEqual(values, [{ title: 'Türkçe ğüşi — 😀' }, { another: true }]);
});
test('Native protokolü taşma, bozuk UTF-8/JSON ve yarım mesajları reddeder', () => {
  const invalidLength = Buffer.alloc(4); invalidLength.writeUInt32LE(50000);
  assert.throws(() => new NativeDecoder(() => {}).push(invalidLength), /uzunluğu/);
  assert.throws(() => new NativeDecoder(() => {}).push(Buffer.from([1, 0, 0, 0, 0xff])));
  const decoder = new NativeDecoder(() => {}); decoder.push(Buffer.from([20, 0, 0, 0, 123])); assert.throws(() => decoder.end(), /Eksik/);
  assert.throws(() => nativeFrame('too long', 2), /sınırı/);
});
test('yalnızca tanımlı Native komutları; keyfi URL, dosya, başlatma parametresi kabul edilmez', () => {
  const base = { version: 1, id: randomUUID(), action: 'request', route: '/api/status', method: 'GET' };
  assert.equal(validateNativeRequest(base).route, '/api/status');
  for (const bad of [{ route: 'https://example.org' }, { route: '/api/bootstrap' }, { route: '/api/jobs/../file' }, { method: 'DELETE' }, { route: '/api/jobs', method: 'POST', body: {} }, { action: 'launch', path: 'calc.exe' }]) assert.throws(() => validateNativeRequest({ ...base, ...bad }));
  assert.deepEqual(validateNativeRequest({ version: 1, id: randomUUID(), action: 'launch' }), { action: 'launch' });
});
test('Native başlatıcı kimliği mesaj gövdesinden değil tarayıcının argv değerlerinden doğrular', () => {
  const manifest = path.resolve('test-native-firefox.json');
  const config = { chromiumIds: ['a'.repeat(32)], firefoxIds: ['test@example.org'], firefoxManifest: manifest };
  assert.equal(validateNativeCaller(config, [`chrome-extension://${'a'.repeat(32)}/`]), true);
  assert.equal(validateNativeCaller(config, [`chrome-extension://${'b'.repeat(32)}/`]), false);
  assert.equal(validateNativeCaller(config, [manifest, 'test@example.org']), true);
  assert.equal(validateNativeCaller(config, [manifest, 'wrong@example.org']), false);
  assert.equal(validateNativeCaller(config, ['fake.json', 'test@example.org']), false);
});
test('Native köprü yerel anahtarı kendisi okur; kimlik dışarı verilmez, yönlendirme takip edilmez', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-native-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pairing-token'), 'a'.repeat(64));
  let request;
  const gateway = new NativeGateway({ port: 17850, dataDirectory: root }, { fetcher: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ version: 'test' })); } });
  assert.deepEqual(await gateway.request({ route: '/api/status', method: 'GET' }), { version: 'test' });
  assert.equal(request.url, 'http://127.0.0.1:17850/api/status'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
});
test('Native köprü uygulamanın bilinen hata nedenlerini eklentiye iletir, bilinmeyenleri APP_ERROR yapar (zaten listede, web sayfası...)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-native-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pairing-token'), 'a'.repeat(64));
  const answer = (status, body) => new Response(JSON.stringify(body), { status });
  for (const [code, expected] of [['duplicate', 'duplicate'], ['NOT_A_FILE', 'NOT_A_FILE'], ['ACCESS_DENIED', 'ACCESS_DENIED'], ['HTTP_ERROR', 'HTTP_ERROR'], ['SELECTION_EXPIRED', 'SELECTION_EXPIRED'], ['SOMETHING_ELSE', 'APP_ERROR']]) {
    const gateway = new NativeGateway({ port: 17850, dataDirectory: root }, { fetcher: async () => answer(400, { error: 'reason', code }) });
    await assert.rejects(() => gateway.request({ route: '/api/files/take', method: 'POST', body: {} }), error => error.code === expected && error.message === 'reason', code);
  }
  const unauthorized = new NativeGateway({ port: 17850, dataDirectory: root }, { fetcher: async () => answer(401, { error: 'no', code: 'duplicate' }) });
  await assert.rejects(() => unauthorized.request({ route: '/api/status', method: 'GET' }), error => error.code === 'APP_AUTH');
});
test('Native kayıtları yalnızca HKCU ve açık kimlikler içindir; paket kimliği sabittir', () => {
  const key = JSON.parse(fs.readFileSync(new URL('../extension/chromium-key.json', import.meta.url), 'utf8')).key;
  assert.equal(chromiumExtensionId(key), 'eggmbijjnndjfnakmgjobdmjkabagbli');
  assert.ok(nativeRegistryKeys('com.hypernab.app').every(entry => entry.key.startsWith('HKCU\\Software\\')));
  assert.throws(() => nativeRegistryKeys('../bad'));
});
test('Native kanal istekleri kimlikle eşleştirir; bağlantı kopması bekleyen istekleri bitirir', async () => {
  let message, disconnect; const posted = [];
  const port = { postMessage(value) { posted.push(value); }, onMessage: { addListener(fn) { message = fn; } }, onDisconnect: { addListener(fn) { disconnect = fn; } }, disconnect() {} };
  const context = vm.createContext({ crypto: webcrypto, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8'), context); vm.runInContext("HypernabText.setLanguage('tr')", context); // these tests read the Turkish texts
vm.runInContext(fs.readFileSync(new URL('../extension/native.js', import.meta.url), 'utf8'), context);
  const channel = new context.HypernabNativeChannel({ connectNative() { return port; } });
  const promise = channel.request({ action: 'request', route: '/api/status', method: 'GET' });
  message({ version: 1, id: posted[0].id, ok: true, data: { works: true } }); assert.deepEqual(await promise, { works: true });
  const waiting = channel.request({ action: 'launch' }); disconnect(); await assert.rejects(waiting, /bağlantısı kesildi/);
});
test('derlenen Windows native exe binary stdio ile gerçek Node köprüsüne bağlanır', { skip: process.platform !== 'win32' }, async t => {
  const preferred = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir();
  const root = fs.mkdtempSync(path.join(preferred, 'hypernab-native-exe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = installNative({ directory: path.join(root, 'host'), dataDirectory: path.join(root, 'data'), downloadDirectory: path.join(root, 'downloads'), register: false });
  const child = spawn(installed.exe, [`chrome-extension://${installed.chromiumId}/`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const replies = []; let resolveReply;
  const ready = new Promise(resolve => { resolveReply = resolve; });
  child.stdout.on('data', data => newDecoder.push(data));
  const newDecoder = new NativeDecoder(value => { replies.push(value); resolveReply(); }, 1000000);
  const id = randomUUID(); child.stdin.write(nativeFrame({ version: 1, id, action: 'request', route: '/api/status', method: 'GET' }));
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Native exe timeout')), 10000).unref())]);
  assert.equal(replies[0].id, id); assert.equal(replies[0].error.code, 'APP_OFFLINE');
  child.stdin.end(); await once(child, 'exit');
});
test('açık launch komutu bağımsız motoru açar; Native port kapanınca motor kapanmaz', { skip: process.platform !== 'win32' }, async t => {
  const preferred = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir();
  const root = fs.mkdtempSync(path.join(preferred, 'hypernab-native-launch-'));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const data = path.join(root, 'data'), downloads = path.join(root, 'downloads');
  const installed = installNative({ directory: path.join(root, 'host'), port, dataDirectory: data, downloadDirectory: downloads, register: false });
  const child = spawn(installed.exe, [`chrome-extension://${installed.chromiumId}/`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = async (route, body) => {
    const token = fs.readFileSync(path.join(data, 'pairing-token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response.json();
  };
  t.after(async () => {
    try { const status = await api('/api/status'); if (path.resolve(status.directory) === path.resolve(downloads)) await api('/api/app/shutdown', { confirm: true, instanceId: status.instanceId }); } catch {}
    if (child.exitCode === null) child.kill();
    await wait(200); fs.rmSync(root, { recursive: true, force: true });
  });
  let resolveReply; const reply = new Promise(resolve => { resolveReply = resolve; });
  const decoder = new NativeDecoder(resolveReply, 1000000); child.stdout.on('data', data => decoder.push(data));
  child.stdin.write(nativeFrame({ version: 1, id: randomUUID(), action: 'launch' }));
  const result = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error('Launch timeout')), 20000).unref())]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(path.resolve(result.data.status.directory), path.resolve(downloads));
  child.stdin.end(); await once(child, 'exit');
  await wait(250);
  assert.equal((await api('/api/status')).processId, result.data.status.processId, 'Native host lifetime must not own the engine.');
});
