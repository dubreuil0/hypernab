const { t } = require('./texts.cjs');
const path = require('node:path');
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const pauseable = job => ['running', 'queued'].includes(job.status);
// A download added for later (held) is just one that has not been started: for the panel it is a paused one.
const resumable = job => ['paused', 'interrupted', 'held'].includes(job.status) && !job.resumeRequested;
const speed = job => job.status === 'running' && Number.isFinite(job.speed) && job.speed > 0 ? job.speed : 0;

// At most five rows; no URLs, headers, cookies or file paths cross this bridge.
function traySnapshot(jobs, appearance = {}) {
  const wanted = ['running', 'queued', 'paused', 'interrupted'];
  const shown = job => (job.status === 'held' ? 'paused' : job.status);
  const rows = jobs.filter(job => wanted.includes(shown(job)));
  rows.sort((a, b) => wanted.indexOf(shown(a)) - wanted.indexOf(shown(b)));
  return {
    connected: true, active: jobs.filter(job => job.status === 'running').length,
    queued: jobs.filter(job => job.status === 'queued').length,
    paused: jobs.filter(resumable).length,
    speed: jobs.reduce((sum, job) => sum + speed(job), 0),
    canPause: jobs.some(pauseable), canResume: jobs.some(resumable), more: Math.max(0, rows.length - 5),
    rows: rows.slice(0, 5).map(job => ({ id: job.id, title: String(job.title === 'video' ? job.host || 'Video' : job.title || 'Video').slice(0, 140), status: shown(job), speed: speed(job), canPause: pauseable(job), canResume: resumable(job) })),
    appearance: {
      theme: ['dark', 'light', 'system'].includes(appearance.theme) ? appearance.theme : 'dark',
      accent: ['green', 'blue', 'orange', 'violet'].includes(appearance.accent) ? appearance.accent : 'green',
      textSize: ['small', 'normal', 'large'].includes(appearance.textSize) ? appearance.textSize : 'normal'
    }
  };
}
function panelBounds(anchor, area) {
  const gap = 8, width = Math.min(360, area.width - gap * 2), height = Math.min(480, area.height - gap * 2);
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const below = anchor.y + anchor.height / 2 < area.y + area.height / 2;
  return { width, height,
    x: Math.round(clamp(anchor.x + anchor.width - width, area.x + gap, area.x + area.width - width - gap)),
    y: Math.round(clamp(below ? anchor.y + anchor.height + gap : anchor.y - height - gap, area.y + gap, area.y + area.height - height - gap)) };
}
class TrayPanel {
  constructor({ BrowserWindow, screen, origin, onRefresh, onOpen, onAction }) {
    Object.assign(this, { BrowserWindow, screen, origin, onRefresh, onOpen, onAction });
    this.window = null; this.busy = false;
  }
  get visible() { return !!this.window && !this.window.isDestroyed() && this.window.isVisible(); }
  async toggle(anchor) {
    if (this.window && !this.window.isDestroyed()) { this.close(); return; }
    const area = this.screen.getDisplayMatching(anchor).workArea;
    const win = new this.BrowserWindow({ ...panelBounds(anchor, area), title: t('desk.panel.title'), frame: false,
      show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, roundedCorners: false,
      backgroundColor: '#0e1113', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'tray-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, address) => { if (address !== `${this.origin}/tray.html`) event.preventDefault(); });
    win.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.close(); } });
    win.on('blur', () => { if (this.window === win) this.close(); });
    win.on('closed', () => { if (this.window === win) this.window = null; });
    try {
      await win.loadURL(`${this.origin}/tray.html`);
      if (this.window !== win || win.isDestroyed()) return;
      win.show(); win.focus(); await this.onRefresh();
    } catch { if (this.window === win) this.close(); }
  }
  close() {
    const win = this.window; this.window = null;
    if (win && !win.isDestroyed()) win.destroy(); // no hidden renderer, timer or poller remains
  }
  update(jobs, appearance) {
    if (this.visible) this.window.webContents.send('tray:state', traySnapshot(jobs, appearance));
  }
  fail() { if (this.visible) this.window.webContents.send('tray:state', { connected: false }); }
  async command(event, command, id) {
    const win = this.window;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== `${this.origin}/tray.html`) throw new Error(t('desk.err.panel'));
    if (command === 'close') { this.close(); return true; }
    if (command === 'open') { this.close(); this.onOpen(); return true; }
    if (command === 'refresh') { await this.onRefresh(); return true; }
    if (!['pause', 'resume', 'pause-all', 'resume-all'].includes(command)) throw new Error(t('desk.err.panelAction'));
    const all = command.endsWith('-all');
    if ((!all && (typeof id !== 'string' || !ID.test(id))) || (all && id !== undefined)) throw new Error(t('desk.err.jobId'));
    if (this.busy) throw new Error(t('desk.err.busy'));
    this.busy = true;
    try {
      const result = await this.onAction({ action: command.startsWith('pause') ? 'pause' : 'resume', ...(all ? { all: true } : { ids: [id] }) });
      await this.onRefresh(); return result;
    } finally { this.busy = false; }
  }
}
module.exports = { TrayPanel, traySnapshot, panelBounds };
