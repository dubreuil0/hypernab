// Real, isolated browser processes. No personal profile, proxy, DNS or browser security changes.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

export async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
class RPC {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data); const item = this.pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error || message.type === 'error') item.reject(new Error(message.message || message.error?.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
    });
    socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser debugging connection closed.')); } this.pending.clear(); });
  }
  call(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timeout: ${method}`)); }, 75000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}
async function connect(url) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); return new RPC(socket); }
async function until(fn, timeout = 20000) { const deadline = Date.now() + timeout; let error; while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await wait(150); } throw error || new Error('Browser wait timeout.'); }
function profileDirectory(directory) {
  const marker = path.join(directory, '.hypernab-browser-test-profile');
  if (fs.existsSync(directory) && !fs.existsSync(marker)) throw new Error('Refusing an existing personal/unknown profile.');
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(marker, 'Isolated automated Hypernab test profile.');
}
const wrapped = expression => `(async()=>JSON.stringify(await (${expression})))()`;
const parsed = value => value === undefined ? undefined : JSON.parse(value);

export async function chromiumBrowser(binary, profile, extensions) {
  profileDirectory(profile); const port = await freePort();
  const child = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--headless=new', '--no-first-run', '--no-default-browser-check', `--load-extension=${extensions.join(',')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  try {
  const version = await until(async () => { const response = await fetch(`http://127.0.0.1:${port}/json/version`); return response.ok && response.json(); }, 30000);
  const rpc = await connect(version.webSocketDebuggerUrl);
  const sessions = new Map();
  async function session(id) { if (!sessions.has(id)) sessions.set(id, (await rpc.call('Target.attachToTarget', { targetId: id, flatten: true })).sessionId); return sessions.get(id); }
  return {
    name: version.Browser, child,
    async create(url, background = false) { return (await rpc.call('Target.createTarget', { url, background })).targetId; },
    async navigate(id, url) { await rpc.call('Page.navigate', { url }, await session(id)); await until(() => this.eval(id, 'document.readyState === "complete"')); },
    async eval(id, expression) {
      const result = await rpc.call('Runtime.evaluate', { expression: wrapped(expression), awaitPromise: true, returnByValue: true, userGesture: true }, await session(id));
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return parsed(result.result.value);
    },
    async click(id, x, y) { // a real mouse click at viewport coordinates (reaches closed shadow roots like a user would)
      const target = await session(id);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await rpc.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }, target);
    },
    async viewport(id, width, height) { await rpc.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, await session(id)); },
    async mouse(id, type, x, y) { await rpc.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 }, await session(id)); },
    async wheel(id, x, y, deltaY) { await rpc.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, await session(id)); },
    async key(id, key) { const target = await session(id); for (const type of ['keyDown', 'keyUp']) await rpc.call('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 }, target); },
    async closeTab(id) { await rpc.call('Target.closeTarget', { targetId: id }); sessions.delete(id); },
    async targets() { return (await rpc.call('Target.getTargets')).targetInfos; },
    async screenshot(id, file) { const result = await rpc.call('Page.captureScreenshot', { format: 'png' }, await session(id)); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); },
    async close() { try { await rpc.call('Browser.close'); } catch {} rpc.socket.close(); if (child.exitCode === null) { await wait(1000); if (child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } }
  };
  } catch (error) { if (child.pid && child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); throw error; }
}

export async function firefoxBrowser(binary, geckodriver, profile, addon, extraPrefs = {}) {
  profileDirectory(profile); const port = await freePort();
  const child = spawn(geckodriver, ['--host', '127.0.0.1', '--port', String(port), '--websocket-port', String(await freePort()), '--allow-system-access', '--log', 'error'], { windowsHide: true, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  const http = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
    const value = (await response.json()).value; if (!response.ok || value?.error) throw new Error(value?.message || 'WebDriver error.'); return value;
  };
  let sessionId;
  try {
  await until(() => http('/status'), 15000);
  const created = await http('/session', { capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true, 'moz:firefoxOptions': { binary, args: ['-headless', '-no-remote', '-profile', profile], prefs: { 'media.autoplay.default': 0, ...extraPrefs } } } } });
  const id = created.sessionId, base = `/session/${id}`;
  sessionId = id;
  const addonId = await http(`${base}/moz/addon/install`, { path: addon, temporary: true });
  await http(`${base}/moz/context`, { context: 'chrome' });
  const uuid = await http(`${base}/execute/sync`, { script: 'return JSON.parse(Services.prefs.getCharPref("extensions.webextensions.uuids"))[arguments[0]];', args: [addonId] });
  await http(`${base}/moz/context`, { context: 'content' });
  const rpc = await connect(created.capabilities.webSocketUrl);
  return {
    name: `Firefox/${created.capabilities.browserVersion}`, child, extensionUrl: `moz-extension://${uuid}/`,
    async create(url, background = false) { const context = (await rpc.call('browsingContext.create', { type: 'tab', background })).context; await rpc.call('browsingContext.navigate', { context, url, wait: 'complete' }); return context; },
    async navigate(context, url) { await rpc.call('browsingContext.navigate', { context, url, wait: 'complete' }); },
    async eval(context, expression) {
      const result = await rpc.call('script.evaluate', { expression: wrapped(expression), target: { context }, awaitPromise: true });
      if (result.type === 'exception') throw new Error(result.exceptionDetails?.text || 'Firefox script error.');
      return parsed(result.result.value);
    },
    async click(context, x, y) {
      await rpc.call('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    },
    async wheel(context, x, y, deltaY) {
      await rpc.call('input.performActions', { context, actions: [{ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(deltaY) }] }] });
    },
    async key(context, key) {
      // WebDriver wants single characters; named keys are private-use codes.
      const value = { Escape: '\uE00C', Enter: '\uE007', ArrowDown: '\uE015', ArrowUp: '\uE013', ArrowLeft: '\uE012', ArrowRight: '\uE014', Home: '\uE011', End: '\uE010', Tab: '\uE004', Backspace: '\uE003' }[key] ?? key;
      await rpc.call('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
    },
    async closeTab(context) { await rpc.call('browsingContext.close', { context }); },
    async screenshot(context, file) { const result = await rpc.call('browsingContext.captureScreenshot', { context }); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); },
    async close() { try { await http(base, undefined, 'DELETE'); } catch {} rpc.socket.close(); if (child.exitCode === null) child.kill(); }
  };
  } catch (error) {
    if (sessionId) { try { await http(`/session/${sessionId}`, undefined, 'DELETE'); } catch {} }
    if (child.pid && child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    throw error;
  }
}
export const browserUntil = until;
