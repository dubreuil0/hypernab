import { m } from './messages.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { NativeDecoder, nativeFrame, validateNativeCaller, validateNativeRequest, nativeRequestHash } from './native-protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (code, message) => Object.assign(new Error(message), { code });
export function readNativeConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
    !path.isAbsolute(config.dataDirectory || '') || !path.isAbsolute(config.downloadDirectory || '') || !path.isAbsolute(config.launcher || '') ||
    !Array.isArray(config.firefoxIds) || config.firefoxIds.length > 10 || config.firefoxIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9@._{}-]{1,128}$/.test(id)) ||
    !Array.isArray(config.chromiumIds) || config.chromiumIds.length > 10 || config.chromiumIds.some(id => !/^[a-p]{32}$/.test(id))) throw new Error(m('e.invalid-native-configuration'));
  return config;
}
export class NativeGateway {
  constructor(config, { fetcher = fetch } = {}) { this.config = config; this.fetcher = fetcher; }
  async request(command) {
    const c = this.config;
    let token;
    try { token = fs.readFileSync(path.join(c.dataDirectory, 'pairing-token'), 'utf8').trim(); }
    catch { throw fail('APP_OFFLINE', m('e.hypernab-may-be-closed-use-the')); }
    if (!/^[a-f0-9]{64}$/i.test(token)) throw fail('APP_AUTH', m('e.the-local-app-key-is-invalid'));
    let response;
    try {
      response = await this.fetcher(`http://127.0.0.1:${c.port}${command.route}`, { method: command.method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(command.method === 'POST' ? { body: JSON.stringify(command.body) } : {}), signal: AbortSignal.timeout(command.route === '/api/inspect' ? 65000 : 10000) });
    } catch { throw fail('APP_OFFLINE', m('e.could-not-connect-to-hypernab-open')); }
    let length = 0, parts = [];
    for await (const chunk of response.body) { length += chunk.length; if (length > 880000) { await response.body.cancel?.().catch(() => {}); throw fail('RESPONSE_TOO_LARGE', m('e.the-queue-response-is-too-large')); } parts.push(chunk); }
    let result;
    try { result = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw fail('APP_PROTOCOL', m('e.the-app-response-could-not-be')); }
    if (!response.ok) throw fail(response.status === 401 ? 'APP_AUTH' : result.code === 'SELECTION_EXPIRED' ? result.code : 'APP_ERROR', result.error || 'Uygulama komutu reddetti.');
    return result;
  }
  async spawnLauncher(show = false) {
    await new Promise((resolve, reject) => {
      const child = spawn(this.config.launcher, [show ? '--show-app' : '--launch-server'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume(); child.stderr.resume();
      child.on('error', () => reject(fail('APP_LAUNCH', m('e.the-hypernab-launcher-could-not-be'))));
      child.on('close', code => code === 0 ? resolve() : reject(fail('APP_LAUNCH', code === 4 ? m('e.the-desktop-app-is-not-installed') : m('e.windows-could-not-start-the-app'))));
    });
  }
  async launch(show = false) {
    if (this.launching) { const result = await this.launching; if (show) await this.spawnLauncher(true); return result; }
    this.launching = this.launchOnce(show).finally(() => { this.launching = null; });
    return this.launching;
  }
  async launchOnce(show) {
    try { const data = await this.request({ route: '/api/status', method: 'GET' }); if (show) await this.spawnLauncher(true); return { alreadyRunning: true, status: data }; }
    catch (error) { if (error.code !== 'APP_OFFLINE') throw error; }
    const occupied = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: this.config.port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(750, () => done(true));
    });
    if (occupied) {
      for (let i = 0; i < 40; i++) {
        try { const status = await this.request({ route: '/api/status', method: 'GET' }); if (show) await this.spawnLauncher(true); return { alreadyRunning: true, status }; }
        catch (error) { if (error.code !== 'APP_OFFLINE') throw error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw fail('APP_BUSY', m('e.the-app-port-is-in-use'));
    }
    // Only a fixed installed executable may launch the fixed server. No shell or arbitrary path.
    const c = this.config;
    fs.mkdirSync(c.dataDirectory, { recursive: true });
    const lock = path.join(c.dataDirectory, 'native-launch.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw fail('APP_LAUNCH', m('e.the-app-start-lock-could-not'));
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
        if (!alive && Date.now() - owner.at > 15000) { fs.unlinkSync(lock); return this.launchOnce(show); }
      } catch { /* Unknown locks are never overwritten. */ }
    }
    try {
      if (fd !== undefined) {
        await this.spawnLauncher(show);
      }
      for (let i = 0; i < 40; i++) {
        try { const status = await this.request({ route: '/api/status', method: 'GET' }); if (show && fd === undefined) await this.spawnLauncher(true); return { started: fd !== undefined, status }; }
        catch (error) { if (error.code !== 'APP_OFFLINE') throw error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw fail('APP_LAUNCH', m('e.the-app-did-not-open-in'));
    } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
  }
}

export function runNativeHost(config, args, input = process.stdin, output = process.stdout) {
  if (!validateNativeCaller(config, args)) throw fail('CALLER_FORBIDDEN', m('e.the-extension-id-is-not-allowed'));
  const gateway = new NativeGateway(config), seen = new Map();
  let pending = 0, closed = false;
  const send = value => { if (!closed) { try { output.write(nativeFrame(value)); } catch { closed = true; input.destroy(); } } };
  output.on('error', () => { closed = true; input.destroy(); });
  const decoder = new NativeDecoder(message => {
    const id = typeof message?.id === 'string' ? message.id : null;
    let command;
    try { command = validateNativeRequest(message); }
    catch (error) { send({ version: 1, id, ok: false, error: { code: 'INVALID_COMMAND', message: error.message } }); return; }
    const hash = nativeRequestHash(message), existing = seen.get(id);
    if (existing) { if (existing.hash !== hash) send({ version: 1, id, ok: false, error: { code: 'ID_CONFLICT', message: m('e.the-command-id-was-used-for') } }); else existing.promise.then(send); return; }
    if (pending >= 8) { send({ version: 1, id, ok: false, error: { code: 'BUSY', message: m('e.too-many-native-requests-wait-a') } }); return; }
    pending++;
    const promise = Promise.resolve().then(() => ['launch', 'show'].includes(command.action) ? gateway.launch(command.action === 'show') : gateway.request(command))
      .then(data => ({ version: 1, id, ok: true, data }), error => ({ version: 1, id, ok: false, error: { code: error.code || 'NATIVE_ERROR', message: error.code ? error.message : m('e.the-native-action-could-not-be') } }))
      .finally(() => { pending--; });
    seen.set(id, { hash, promise }); if (seen.size > 128) seen.delete(seen.keys().next().value);
    promise.then(send);
  });
  input.on('data', chunk => { try { decoder.push(chunk); } catch { closed = true; input.destroy(); } });
  input.on('end', () => { closed = true; });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--config' || !path.isAbsolute(process.argv[3] || '')) throw new Error('Config required.');
    runNativeHost(readNativeConfig(process.argv[3]), process.argv.slice(4));
  } catch { process.stderr.write('Hypernab Native Messaging baslatilamadi: kimlik veya kurulum gecersiz.\n'); process.exitCode = 1; }
}
