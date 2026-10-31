import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runContentScripts } from './content-scripts.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.hidden = false; this.className = ''; this.events = {}; this.offsetWidth = 120; this.offsetHeight = 28; this.attrs = {}; this.classList = { contains: n => this.className.split(' ').includes(n), add: n => { if (!this.classList.contains(n)) this.className += ` ${n}`; }, remove: n => { this.className = this.className.split(' ').filter(s => s !== n).join(' '); } }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  attachShadow() { return this.shadow = new Element('shadow'); }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelector(selector) { return this.all().find(e => e.classList.contains(selector.slice(1))); }
  all() { return this.children.flatMap(e => [e, ...e.all()]); }
  remove() { this.removed = true; }
  click() { for (const fn of this.events.click || []) fn({ stopPropagation() {}, preventDefault() {} }); }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function setup({ start = async () => ({ ok: true }), inspect } = {}) {
  const body = new Element('body'), sent = [], page = { location: { href: 'https://example.org/watch' }, innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  page.self = page.top = page;
  const video = { paused: false, readyState: 4, isConnected: true, duration: 60, addEventListener() {}, getBoundingClientRect: () => ({ left: 100, top: 200, right: 740, bottom: 560, width: 640, height: 360 }) };
  const document = { title: 'Video', body, documentElement: {}, querySelectorAll: selector => selector === 'video' ? [video] : [], createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) };
  const info = { ok: true, title: 'Film', options: [{ id: '720', label: '720p', size: '~10 MB' }] };
  let refresh;
  const browser = { runtime: { onMessage: { addListener(fn) { refresh = fn; } }, async sendMessage(message) { sent.push(message); return message.action === 'start' ? start(message) : message.action === 'inspect' ? inspect?.(message) || info : {}; } } };
  const context = vm.createContext({ document, window: page, browser, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, MutationObserver: class { observe() {} }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} });
  runContentScripts(context);
  const root = body.children[0].shadow, find = name => root.all().find(e => e.classList.contains(name));
  return { sent, root, page, find, open: () => root.children[0].children[0].click(), refresh: () => refresh({ type: 'hypernab:refresh' }) };
}

test('aynı içerikli canlı yenilemeden SONRA İndir: panel kapanır ve kabul bildirimi görünür', async () => {
  const app = setup(); app.open(); await flush();
  app.refresh(); await flush(); // increments loadSerial, but identical result does not redraw the old handlers
  app.find('now').click(); await flush();
  assert.equal(app.find('panel').hidden, true);
  assert.equal(app.find('toast').hidden, false);
  assert.equal(app.find('toast').textContent, '✓ İndirmeye eklendi');
});

test('gecikmiş sıraya ekleme sırasında yenileme/çift tıklama tek niyet üretir', async () => {
  let accept; const app = setup({ start: () => new Promise(resolve => { accept = resolve; }) });
  app.open(); await flush(); app.find('later').click(); app.refresh(); app.find('now').click();
  assert.equal(app.sent.filter(m => m.action === 'start').length, 1);
  accept({ ok: true, queued: true }); await flush();
  assert.equal(app.find('panel').hidden, true); assert.equal(app.find('toast').textContent, '✓ Kuyruğa eklendi');
});

test('başlatma hatasında panel kapanmaz veya başarı iddia edilmez', async () => {
  const app = setup({ start: async () => ({ ok: false, error: 'Kaynak erişimi reddedildi.' }) });
  app.open(); await flush(); app.find('now').click(); await flush();
  assert.equal(app.find('panel').hidden, false); assert.equal(app.find('toast').hidden, true);
  assert.equal(app.find('err').textContent, 'Kaynak erişimi reddedildi.');
});

test('geciken eski video yanıtı başka sayfanın panelini kapatmaz', async () => {
  let accept; const app = setup({ start: () => new Promise(resolve => { accept = resolve; }) });
  app.open(); await flush(); app.find('now').click();
  app.page.location.href = 'https://example.org/other';
  accept({ ok: true }); await flush();
  assert.equal(app.find('toast').hidden, true);
});

test('kayıp yanıtta otomatik kontrol aynı gönderim kimliğiyle yapılır', async () => {
  let calls = 0; const app = setup({ start: async () => { if (++calls === 1) throw new Error('lost reply'); return { ok: true }; } });
  app.open(); await flush(); app.find('now').click(); await flush();
  const starts = app.sent.filter(m => m.action === 'start'); assert.equal(starts.length, 2);
  assert.equal(starts[0].intentId, starts[1].intentId); assert.equal(app.find('panel').hidden, true); assert.equal(app.find('toast').hidden, false);
});

test('gönderim sürerken kapat/aç ikinci iş başlatmaz', async () => {
  let accept; const app = setup({ start: () => new Promise(resolve => { accept = resolve; }) });
  app.open(); await flush(); app.find('now').click(); app.open(); app.open(); await flush(); app.find('later').click();
  assert.equal(app.sent.filter(m => m.action === 'start').length, 1);
  accept({ ok: true }); await flush(); assert.equal(app.find('panel').hidden, true);
});

test('gönderim sırasında kapatılıp açılan panelde gerçek hata görünür kalır', async () => {
  let accept; const app = setup({ start: () => new Promise(resolve => { accept = resolve; }) });
  app.open(); await flush(); app.find('now').click(); app.open(); app.open(); await flush();
  accept({ ok: false, error: 'Kaynak isteği reddedildi.' }); await flush();
  assert.equal(app.find('panel').hidden, false); assert.equal(app.find('err').hidden, false); assert.equal(app.find('err').textContent, 'Kaynak isteği reddedildi.');
});
