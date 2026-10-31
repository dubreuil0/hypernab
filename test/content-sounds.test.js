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
  removeAttribute(key) { delete this.attrs[key]; }
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

const withSounds = { ok: true, title: 'Film', options: [{ id: '720', label: '720p', size: '~10 MB' }],
  audioTracks: [{ id: 'a0', name: 'Türkçe Dublaj', language: 'tr', default: true }, { id: 'a1', name: 'Orijinal', language: 'en', default: false }], audioActive: 'a1' };
const textOf = node => [node.textContent || '', ...node.children.map(textOf)].join(' ');
const rows = app => app.root.all().filter(node => node.classList.contains('hd-opt'));
const picker = app => app.find('hd-select-btn');
const choose = (app, index) => { picker(app).click(); rows(app)[index].click(); };

test('several sounds: the panel offers them, preselects the one that plays, and the choice is what the download asks for', async () => {
  const app = setup({ inspect: () => withSounds }); app.open(); await flush();
  assert.ok(picker(app), 'a sound selector is drawn');
  assert.match(textOf(picker(app)), /Orijinal/, 'the sound that is playing is selected');
  picker(app).click();
  assert.equal(rows(app).length, 2);
  assert.match(textOf(rows(app)[1]), /çalıyor/); assert.match(textOf(rows(app)[0]), /sitenin varsayılanı/);
  assert.match(textOf(rows(app)[0]), /\bTR\b/, 'a language chip with its code'); assert.match(textOf(rows(app)[1]), /\bEN\b/);
  assert.deepEqual(rows(app).map(row => row.attrs['aria-selected']), ['false', 'true']);
  picker(app).click();
  app.find('now').click(); await flush();
  assert.equal(app.sent.find(message => message.action === 'start').audioTrack, 'a1');
  const second = setup({ inspect: () => withSounds }); second.open(); await flush();
  choose(second, 0);
  assert.match(textOf(picker(second)), /Türkçe Dublaj/, 'the button shows the new choice');
  second.find('now').click(); await flush();
  assert.equal(second.sent.find(message => message.action === 'start').audioTrack, 'a0', 'the user can override what was detected');
});

test('when the playing sound cannot be told, the site default is selected and the panel says it could not tell', async () => {
  const app = setup({ inspect: () => ({ ...withSounds, audioActive: null }) }); app.open(); await flush();
  assert.match(textOf(picker(app)), /Türkçe Dublaj/);
  assert.match(app.root.all().map(e => e.textContent || '').join(' '), /anlaşılamadı/);
});

test('the sound preference chose it: the panel says so, and what the player plays still wins', async () => {
  const chosen = setup({ inspect: () => ({ ...withSounds, audioActive: null, audioPick: { id: 'a1', why: 'preference' } }) }); chosen.open(); await flush();
  assert.match(textOf(picker(chosen)), /Orijinal/);
  assert.match(chosen.root.all().map(e => e.textContent || '').join(' '), /ses tercihine göre/);
  chosen.find('now').click(); await flush();
  assert.equal(chosen.sent.find(message => message.action === 'start').audioTrack, 'a1');
});

test('one sound or none: no selector and no audioTrack field (as before)', async () => {
  const app = setup(); app.open(); await flush();
  assert.equal(picker(app), undefined);
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
