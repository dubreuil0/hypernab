import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
  vm.runInContext(fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), context);
  const root = body.children[0].shadow, find = name => root.all().find(e => e.classList.contains(name));
  return { sent, root, page, find, open: () => root.children[0].children[0].click(), refresh: () => refresh({ type: 'hypernab:refresh' }) };
}

const withSounds = { ok: true, title: 'Film', options: [{ id: '720', label: '720p', size: '~10 MB' }],
  audioTracks: [{ id: 'a0', name: 'Türkçe Dublaj', language: 'tr', default: true }, { id: 'a1', name: 'Orijinal', language: 'en', default: false }], audioActive: 'a1' };
const choose = (select, value) => { select.value = value; for (const fn of select.events.change || []) fn({}); };

test('several sounds: the panel offers them, preselects the one that plays, and the choice is what the download asks for', async () => {
  const app = setup({ inspect: () => withSounds }); app.open(); await flush();
  const select = app.find('quality');
  assert.ok(select, 'a sound selector is drawn');
  assert.deepEqual(select.children.map(option => option.value), ['a0', 'a1']);
  assert.equal(select.value, 'a1', 'the sound that is playing is selected');
  assert.match(select.children[1].textContent, /çalıyor/); assert.match(select.children[0].textContent, /sitenin varsayılanı/);
  app.find('now').click(); await flush();
  assert.equal(app.sent.find(message => message.action === 'start').audioTrack, 'a1');
  const second = setup({ inspect: () => withSounds }); second.open(); await flush();
  choose(second.find('quality'), 'a0'); second.find('now').click(); await flush();
  assert.equal(second.sent.find(message => message.action === 'start').audioTrack, 'a0', 'the user can override what was detected');
});

test('when the playing sound cannot be told, the site default is selected and the panel says it could not tell', async () => {
  const app = setup({ inspect: () => ({ ...withSounds, audioActive: null }) }); app.open(); await flush();
  assert.equal(app.find('quality').value, 'a0');
  assert.match(app.root.all().map(e => e.textContent || '').join(' '), /anlaşılamadı/);
});

test('one sound or none: no selector and no audioTrack field (as before)', async () => {
  const app = setup(); app.open(); await flush();
  assert.equal(app.find('quality'), undefined);
  app.find('now').click(); await flush();
  assert.equal('audioTrack' in app.sent.find(message => message.action === 'start'), false);
});

test('Yenile looks at the page from scratch (fresh) while the panel stays open', async () => {
  const app = setup({ inspect: () => withSounds }); app.open(); await flush();
  const before = app.sent.filter(message => message.action === 'inspect').length;
  const again = app.find('rfr');
  assert.ok(again, 'a refresh button exists');
  again.click(); await flush();
  const inspects = app.sent.filter(message => message.action === 'inspect');
  assert.equal(inspects.length, before + 1); assert.equal(inspects.at(-1).fresh, true); assert.equal(app.find('panel').hidden, false);
});
