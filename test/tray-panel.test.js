import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { TrayPanel, traySnapshot, panelBounds } = createRequire(import.meta.url)('../desktop/tray-panel.cjs');
createRequire(import.meta.url)('../desktop/texts.cjs').setLanguage('tr'); // these tests read the Turkish texts
const id = '11111111-1111-4111-8111-111111111111';

test('tray summary is bounded, ignores stale speeds and never exposes source/session/file data', () => {
  const jobs = ['completed', 'held', 'paused', 'running', 'queued', 'interrupted', 'running', 'paused', 'running'].map((status, n) => ({ id: `${n}`, status, title: `Video ${n}`, speed: 100,
    url: 'https://example.org/private?token=secret', headers: { Cookie: 'private-cookie' }, directory: 'private-path', file: 'private-file' }));
  const order = jobs.map(job => job.id);
  const view = traySnapshot(jobs, { theme: 'light', accent: 'violet', textSize: 'large', token: 'secret' });
  assert.equal(view.speed, 300); assert.equal(view.active, 3); assert.equal(view.queued, 1);
  assert.equal(view.held, 1); assert.equal(view.paused, 3); assert.equal(view.rows.length, 5); assert.equal(view.more, 2);
  assert.deepEqual(view.rows.map(row => row.status), ['running', 'running', 'running', 'queued', 'paused']);
  assert.deepEqual(jobs.map(job => job.id), order, 'real queue priority never changes');
  assert.ok(!/secret|private-cookie|private-path|private-file|https:/.test(JSON.stringify(view)));
  assert.equal(traySnapshot([{ status: 'running', speed: NaN }, { status: 'running', speed: -1 }]).speed, 0);
  assert.equal(traySnapshot([{ status: 'paused', resumeRequested: true }]).canResume, false);
  assert.equal(traySnapshot([{ status: 'held' }]).canResume, false);
});

test('tray bounds stay inside work area on top/bottom/side taskbars and negative-coordinate screens', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -100, width: 1280, height: 720 }, { x: 0, y: 0, width: 320, height: 400 }]) {
    for (const anchor of [{ x: area.x + area.width - 20, y: area.y + area.height, width: 20, height: 40 }, { x: area.x, y: area.y - 40, width: 30, height: 40 }, { x: area.x - 40, y: area.y + 100, width: 40, height: 20 }]) {
      const bounds = panelBounds(anchor, area);
      assert.ok(bounds.x >= area.x && bounds.y >= area.y);
      assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
    }
  }
});

function fixture() {
  const windows = [], actions = []; let reads = 0, opened = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: 'http://127.0.0.1:1234/tray.html' };
      this.sent = []; this.webContents.send = (...args) => this.sent.push(args); this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    focus() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const panel = new TrayPanel({ BrowserWindow: Window, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) }, origin: 'http://127.0.0.1:1234',
    onRefresh: async () => { reads++; }, onOpen: () => { opened++; }, onAction: async body => { actions.push(body); return { changed: 1 }; } });
  const event = () => ({ sender: panel.window.webContents, senderFrame: panel.window.webContents.mainFrame });
  const anchor = { x: 1100, y: 800, width: 20, height: 40 };
  return { panel, windows, actions, event, anchor, reads: () => reads, opened: () => opened };
}

test('panel is lazy, sandboxed, releases renderer on blur/escape/toggle and sends nothing while closed', async () => {
  const f = fixture(); assert.equal(f.windows.length, 0);
  await f.panel.toggle(f.anchor);
  const win = f.windows[0]; assert.equal(f.reads(), 1); assert.equal(f.panel.visible, true);
  assert.deepEqual(win.options.webPreferences.nodeIntegration, false); assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.hasShadow, false); assert.equal(win.options.skipTaskbar, true);
  assert.deepEqual(win.openHandler(), { action: 'deny' });
  f.panel.update([{ id, title: 'Video', status: 'running', speed: 300 }]); assert.equal(win.sent.length, 1);
  f.panel.fail(); assert.deepEqual(win.sent.at(-1), ['tray:state', { connected: false }]);
  win.emit('blur'); assert.equal(f.panel.window, null); assert.equal(win.destroyed, true);
  f.panel.update([]); f.panel.fail(); assert.equal(win.sent.length, 2); assert.equal(f.reads(), 1);
  await f.panel.toggle(f.anchor); await f.panel.toggle(f.anchor); assert.equal(f.panel.window, null);
  await f.panel.toggle(f.anchor); let prevented = false;
  f.panel.window.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true); assert.equal(f.panel.window, null);
});

test('panel IPC admits only its own top frame, fixed commands and opaque ids; queue semantics are shared', async () => {
  const f = fixture(); await f.panel.toggle(f.anchor);
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: f.panel.window.webContents, senderFrame: { url: 'http://127.0.0.1:1234/tray.html' } }]) await assert.rejects(f.panel.command(event, 'pause-all'), /panel/);
  for (const value of ['../secret', 'https://example.org', { id }, id + '?path=x']) await assert.rejects(f.panel.command(f.event(), 'pause', value), /kimliği/);
  await assert.rejects(f.panel.command(f.event(), 'delete', id), /işlemi/);
  await assert.rejects(f.panel.command(f.event(), 'resume-all', id), /kimliği/);
  assert.equal(f.actions.length, 0);
  await f.panel.command(f.event(), 'pause', id); await f.panel.command(f.event(), 'resume-all');
  assert.deepEqual(f.actions, [{ action: 'pause', ids: [id] }, { action: 'resume', all: true }]);
  await f.panel.command(f.event(), 'open'); assert.equal(f.opened(), 1); assert.equal(f.panel.window, null);
});
