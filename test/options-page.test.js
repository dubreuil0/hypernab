import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// The extension's settings page on a small fake document. It carries what the old toolbar popup used to guarantee about the link to the
// app: a closed app is never started on its own, the key is not needed with native messaging, a wrong key and a missing app are told
// apart, and every change reaches the right place (storage, the file-download settings).
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.attrs = {}; this.className = ''; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false;
    this.classList = { add: name => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); }, contains: name => this.className.split(' ').includes(name) }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  removeEventListener() {}
  focus() {} select() {}
  click() { for (const fn of this.events.click || []) fn({ preventDefault() {}, stopPropagation() {} }); }
  change() { for (const fn of this.events.change || []) fn({}); }
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const json = data => ({ ok: true, status: 200, async json() { return data; } });

function setup({ stored = {}, nativeHandler, fetchHandler, tabs = [] } = {}) {
  const nodes = new Map(), calls = { fetch: [], native: [], sent: [] }, local = { ...stored };
  const byId = id => { if (!nodes.has(id)) nodes.set(id, new El('node')); return nodes.get(id); };
  const document = { getElementById: byId, createElement: tag => new El(tag), createElementNS: (_ns, tag) => new El(tag), querySelectorAll: () => [], addEventListener() {}, head: new El('head'), defaultView: null };
  const browser = {
    runtime: { connectNative() {}, async sendMessage(message) { calls.sent.push(JSON.parse(JSON.stringify(message))); return { ok: true }; } },
    storage: { local: { async get(key) { return Array.isArray(key) ? Object.fromEntries(key.filter(k => k in local).map(k => [k, local[k]])) : key in local ? { [key]: local[key] } : {}; }, async set(values) { Object.assign(local, JSON.parse(JSON.stringify(values))); } }, onChanged: { addListener() {} } },
    tabs: { async query() { return tabs; } },
  };
  const context = vm.createContext({ URL, AbortSignal, crypto: webcrypto, document, browser, navigator: { clipboard: { async writeText() {} } }, Promise, JSON, Object, Number, String, Boolean, Array, Math, setTimeout, clearTimeout,
    HypernabNativeChannel: class { constructor() { this.closed = false; } request(command) { calls.native.push(JSON.parse(JSON.stringify(command))); return nativeHandler(command); } close() { this.closed = true; } },
    fetch: async (url, options) => { calls.fetch.push({ url, options }); const custom = await fetchHandler?.(url, options); if (custom instanceof Error) throw custom; return custom || json({ extensionProtocol: 1 }); }, globalThis: null });
  context.globalThis = context;
  for (const file of ['../public/strings.js', '../public/ds.js', '../extension/core.js']) vm.runInContext(read(file), context);
  vm.runInContext("HypernabText.setLanguage('tr')", context); // these tests read the Turkish texts
  vm.runInContext(read('../extension/options.js'), context);
  return { nodes, calls, local, context, text: id => nodes.get(id)?.textContent, input: slot => nodes.get(slot).children[0].children[0] };
}

test('with native messaging: no key is used, and a closed app is not started until the user presses the button', async () => {
  let running = false; const instanceId = 'engine-1';
  const app = setup({ stored: { transport: 'native' }, nativeHandler: async command => {
    if (command.action === 'show') { running = true; return { status: { extensionProtocol: 1, instanceId } }; }
    if (!running) throw new Error('Hypernab kapalı olabilir. Uygulamayı aç düğmesini kullan.');
    return { extensionProtocol: 1, instanceId };
  } });
  await flush();
  assert.equal(app.calls.native.some(command => ['launch', 'show'].includes(command.action)), false, 'opening the page never starts the app');
  assert.equal(app.calls.fetch.length, 0, 'native messaging uses no HTTP key');
  assert.match(app.text('conn-state'), /kapalı olabilir/, 'a closed app is explained');
  app.nodes.get('open-app').click(); await flush();
  assert.equal(running, true); assert.equal(app.calls.native.filter(command => command.action === 'show').length, 1);
  assert.match(app.text('conn-state'), /açıldı|açık/);
  assert.equal(app.local.transport, 'native');
});

test('a wrong key and a missing app are told apart; a closed app is not launched by it', async () => {
  const wrong = setup({ stored: { token: 'b'.repeat(64) }, fetchHandler: async url => url.endsWith('/api/status') ? { ok: false, status: 401, async json() { return {}; } } : null });
  await flush();
  assert.match(wrong.text('conn-state'), /anahtarı geçersiz/);
  assert.equal(wrong.calls.fetch.some(call => /launch|start/.test(call.url)), false);
  const offline = setup({ stored: { token: 'b'.repeat(64) }, fetchHandler: async () => new Error('offline') });
  await flush();
  assert.match(offline.text('conn-state'), /bağlantı kurulamadı/);
});

test('pairing with a key: a malformed key is refused, a good one is checked against the app and stored', async () => {
  const app = setup({ fetchHandler: async () => json({ extensionProtocol: 1 }), nativeHandler: async () => { throw new Error('no native'); } });
  await flush();
  app.nodes.get('token').value = 'short'; app.nodes.get('save-token').click(); await flush();
  assert.match(app.text('conn-state'), /64 karakter/); assert.equal(app.local.token, undefined);
  app.nodes.get('token').value = 'a'.repeat(64); app.nodes.get('save-token').click(); await flush();
  assert.equal(app.local.token, 'a'.repeat(64)); assert.equal(app.local.transport, 'http');
  assert.match(app.text('conn-state'), /eşleştirildi/);
  const old = setup({ nativeHandler: async () => { throw new Error('no native'); }, fetchHandler: async () => json({ extensionProtocol: 0 }) });
  await flush(); old.nodes.get('token').value = 'c'.repeat(64); old.nodes.get('save-token').click(); await flush();
  assert.equal(old.local.token, undefined, 'an app too old for the extension is not paired with');
});

test('the capture switch reaches the stored value; the page no longer has a file-download section', async () => {
  const app = setup({ nativeHandler: async () => { throw new Error('no native') } });
  await flush();
  const capture = app.input('capture-slot'); capture.checked = false; capture.change(); await flush();
  assert.equal(app.local.captureEnabled, false);
  assert.equal(app.calls.sent.some(message => /takeover/.test(message.type || '')), false, 'nothing asks a file-capture feature that no longer exists');
});

test('diagnostics: a page tab is chosen, the request watch and the report ask the background for exactly that tab', async () => {
  const app = setup({ nativeHandler: async () => { throw new Error('no native'); }, tabs: [{ id: 5, url: 'https://film.example.org/watch', title: 'Film', lastAccessed: 10 }, { id: 9, url: 'https://other.example.org/', title: 'Other', lastAccessed: 99 }, { id: 2, url: 'about:blank', title: 'x' }] });
  await flush();
  app.nodes.get('diag-watch').click(); await flush();
  assert.deepEqual(app.calls.sent.at(-1), { type: 'hypernab:diagnostic-mode', tabId: 9, enabled: true }, 'the most recently used page tab, never an extension or blank tab');
  app.nodes.get('diag-report').click(); await flush();
  assert.deepEqual(app.calls.sent.at(-1), { type: 'hypernab:diagnose', tabId: 9 });
  const none = setup({ nativeHandler: async () => { throw new Error('no native'); }, tabs: [] }); await flush();
  none.nodes.get('diag-report').click(); await flush();
  assert.match(none.text('diag-state'), /Sayfa sekmesi bulunamadı/);
});
