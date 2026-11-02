const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog, ipcMain, clipboard } = require('electron');
const { offerFor } = require('./clipboard-links.cjs');
const { detectBrowsers, openBrowserSetup } = require('./browsers.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openJobLocation, playJob } = require('./job-location.cjs');
const { TrayPanel } = require('./tray-panel.cjs');
const { Updater } = require('./updater.cjs');
const { t, setLanguage } = require('./texts.cjs');
if (process.env.HD_DESKTOP_TEST === '1' && process.env.HD_DESKTOP_PROFILE) app.setPath('userData', process.env.HD_DESKTOP_PROFILE);
app.setAppUserModelId('com.hypernab.desktop'); // Windows shows the app's own name and icon on notifications and the taskbar

const port = Number(process.env.HYPERNAB_PORT || 17846);
const origin = `http://127.0.0.1:${port}`;
let window, tray, trayPanel, updater, engine, quitting = false, owned = false, token, instanceId;
let settings = { closeToTray: true, startMinimized: false, notifyOnFinish: true, watchClipboard: false }; // refreshed from the engine's Settings
const root = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(__dirname, '..');
const data = process.env.HYPERNAB_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(root, 'data'));
const downloads = process.env.HYPERNAB_DOWNLOAD_DIR || (app.isPackaged ? path.join(app.getPath('downloads'), 'Hypernab') : path.join(root, 'downloads'));
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : process.env.HYPERNAB_NODE || 'node.exe';
const iconFile = path.join(__dirname, 'icon.ico');
const startedByWindows = process.argv.includes('--startup');
const nativeBackground = process.argv.includes('--native-background');
let showRequested = process.argv.includes('--native-show'), windowReady = false;
let trayClickTimer = null, lastTrayDoubleClick = 0;
async function request(route, body) {
  token ||= fs.readFileSync(path.join(data, 'pairing-token'), 'utf8').trim();
  const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || t('desk.err.connect')); return result;
}
async function startEngine() {
  try { const status = await request('/api/status'); instanceId = status.instanceId; return; } catch {}
  // A listener with a different data directory must never be replaced or killed.
  if (await fetch(origin, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)) throw new Error(t('desk.err.otherEngine'));
  fs.mkdirSync(data, { recursive: true });
  engine = spawn(node, [path.join(root, 'src/server.js')], { cwd: root, env: { ...process.env, HYPERNAB_DATA_DIR: data, HYPERNAB_DOWNLOAD_DIR: downloads, HYPERNAB_LOCALE: process.env.HYPERNAB_LOCALE || app.getLocale() }, windowsHide: true, stdio: 'ignore' });
  let error; engine.on('error', e => { error = e; });
  owned = true;
  for (let i = 0; i < 80; i++) {
    if (error) throw error;
    if (engine.exitCode !== null) throw new Error(t('desk.err.engineStart'));
    try { const status = await request('/api/status'); instanceId = status.instanceId; return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(t('desk.err.engineLate'));
}
// Optional (Settings, off by default): when the window gets focus and the clipboard holds link(s) not offered before, the window shows a quiet
// "add them?" strip. The clipboard is read only then and only while the setting is on; the text stays in memory and is never stored or sent.
let lastOffered = '';
async function offerClipboard() {
  if (!settings.watchClipboard || !window || window.isDestroyed()) return;
  let text = ''; try { text = await clipboard.readText(); } catch { return; } // newer Electron versions read it asynchronously
  if (typeof text !== 'string' || !settings.watchClipboard || !window || window.isDestroyed()) return;
  const links = offerFor(text, lastOffered); if (!links) return;
  lastOffered = text;
  window.webContents.send('desktop:clipboard', links);
}
function show() { clearTimeout(trayClickTimer); trayPanel?.close(); if (window) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); } }
async function quit(finish) {
  if (quitting) return;
  clearTimeout(trayClickTimer);
  trayPanel?.close();
  if (owned) {
    try {
      await request('/api/queue/stop', {});
      await request('/api/queue/bulk', { action: 'pause', all: true });
      for (let i = 0; i < 100; i++) {
        const jobs = await request('/api/jobs');
        if (!jobs.some(job => job.settling || ['queued', 'running'].includes(job.status))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await request('/api/app/shutdown', { confirm: true, instanceId });
    } catch (error) { dialog.showErrorBox(t('desk.keptTitle'), t('desk.err.shutdown', { message: error.message })); return; }
  }
  quitting = true; typeof finish === 'function' ? finish() : app.quit(); // a menu click passes an event object here, not a function
}
function action(route, body) { request(route, body).catch(error => dialog.showErrorBox('Hypernab', error.message)); }
async function currentDownloads() { try { return (await request('/api/status')).directory || downloads; } catch { return downloads; } }
// Window size/position: first run fits the screen (about 80% of the work area); later runs restore the last state.
const windowStateFile = path.join(data, 'window-state.json');
function initialWindow() {
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    const numbers = ['x', 'y', 'width', 'height'].every(key => Number.isInteger(saved[key]));
    if (numbers && saved.width >= 720 && saved.height >= 520 && saved.width <= 10000 && saved.height <= 10000) {
      // Only reuse a position that is still clearly visible on a connected screen.
      const visible = screen.getAllDisplays().some(({ workArea: a }) => Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x) >= 200 && Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y) >= 120);
      if (visible) return { bounds: { x: saved.x, y: saved.y, width: saved.width, height: saved.height }, maximized: saved.maximized === true };
    }
  } catch { /* first run or unreadable file: use the default below */ }
  const width = Math.min(area.width, Math.max(1120, Math.round(area.width * 0.8))), height = Math.min(area.height, Math.max(720, Math.round(area.height * 0.8)));
  return { bounds: { width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2) }, maximized: false };
}
function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    fs.mkdirSync(path.dirname(windowStateFile), { recursive: true });
    fs.writeFileSync(`${windowStateFile}.tmp`, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    fs.renameSync(`${windowStateFile}.tmp`, windowStateFile);
  } catch { /* remembering the window is optional */ }
}
// The desktop texts follow the app's interface language; the tray menu is rebuilt when it changes.
let menuLanguage = null, rebuildMenu = () => {};
async function loadSettings() {
  try { settings = { ...settings, ...await request('/api/settings') }; } catch { /* keep the last known values */ }
  if (settings.interfaceLanguageResolved && settings.interfaceLanguageResolved !== menuLanguage) { menuLanguage = settings.interfaceLanguageResolved; setLanguage(menuLanguage); rebuildMenu(); }
}

// "Finished" / "failed" notices, only for changes seen while the app runs (never for history loaded at start).
const lastStatus = new Map();
let watching = false;
async function watchJobs() {
  if (watching || quitting) return; watching = true;
  try {
    const jobs = await request('/api/jobs');
    trayPanel?.update(jobs, settings);
    void updater?.idle(jobs).catch(() => {});
    for (const job of jobs) {
      const before = lastStatus.get(job.id); lastStatus.set(job.id, job.status);
      if (!before || before === job.status || !settings.notifyOnFinish || !Notification.isSupported()) continue;
      const name = job.title && job.title !== 'video' ? job.title : job.host;
      const notice = job.status === 'completed' ? { title: t('desk.notice.done'), body: name }
        : job.status === 'failed' ? { title: t('desk.notice.failed'), body: `${name}\n${job.error || ''}`.trim() } : null;
      if (!notice) continue;
      const toast = new Notification({ ...notice, icon: iconFile, silent: false });
      toast.on('click', show); toast.show();
    }
  } catch { trayPanel?.fail(); /* engine busy or closing */ }
  finally { watching = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--native-background')) return;
    showRequested = true; if (windowReady) show();
  });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    await startEngine();
    await loadSettings();
    const start = initialWindow();
    window = new BrowserWindow({ ...start.bounds, minWidth: 720, minHeight: 520, show: false, title: 'Hypernab', icon: iconFile, autoHideMenuBar: true, backgroundColor: '#0e1113', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    if (start.maximized) window.maximize();
    let saveTimer = null;
    const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveWindowState(window), 400); };
    for (const name of ['resize', 'move', 'maximize', 'unmaximize']) window.on(name, remember);
    window.on('focus', offerClipboard);
    window.on('close', event => {
      clearTimeout(saveTimer); saveWindowState(window);
      if (quitting) return;
      event.preventDefault();
      if (settings.closeToTray) window.hide(); else void quit();
    });
    // F11 toggles real full screen; Escape leaves it. (Maximizing with the title-bar button is a separate, normal window state.)
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.control || input.alt || input.meta) return;
      if (input.key === 'F11') { event.preventDefault(); window.setFullScreen(!window.isFullScreen()); }
      else if (input.key === 'Escape' && window.isFullScreen()) { event.preventDefault(); window.setFullScreen(false); }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    const fromApp = event => {
      const url = new URL(event.senderFrame.url);
      if (url.origin !== origin || url.pathname !== '/') throw new Error(t('desk.err.window'));
    };
    ipcMain.handle('desktop:settings', event => {
      fromApp(event);
      return { packaged: app.isPackaged, startup: app.getLoginItemSettings({ args: ['--startup'] }).openAtLogin, downloads, version: app.getVersion(), extensions: path.join(root, 'build', 'extensions') };
    });
    ipcMain.handle('desktop:action', async (event, command, value) => {
      fromApp(event);
      if (command === 'downloads') return shell.openPath(await currentDownloads());
      if (command === 'job-location') return openJobLocation(value, { lookup: id => request(`/api/jobs/${id}/location`), shell });
      if (command === 'job-play') return playJob(value, { lookup: id => request(`/api/jobs/${id}/location`), shell });
      if (command === 'history-play') return playJob(value, { lookup: id => request(`/api/history/${id}/location`), shell });
      if (command === 'history-location') return openJobLocation(value, { lookup: id => request(`/api/history/${id}/location`), shell });
      if (command === 'extensions') return shell.openPath(path.join(root, 'build/extensions'));
    if (command === 'browsers') return detectBrowsers().map(({ id, name, family }) => ({ id, name, family }));
    if (command === 'browser-setup' && typeof value === 'string') return openBrowserSetup(value, { spawn, shell, clipboard, extensionsFolder: path.join(root, 'build', 'extensions') });
      if (command === 'startup' && typeof value === 'boolean' && app.isPackaged) { app.setLoginItemSettings({ openAtLogin: value, args: ['--startup'] }); return true; }
      if (command === 'settings-changed') { await loadSettings(); return true; }
      if (command === 'pick-folder') {
        const result = await dialog.showOpenDialog(window, { title: t('desk.pickFolder'), defaultPath: await currentDownloads(), properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0] || null;
      }
      if (command === 'native') {
        const { installNative } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/install-native.js')).href);
        return installNative({ rootDirectory: root, nodePath: node, dataDirectory: data, downloadDirectory: downloads, desktopExecutable: app.isPackaged ? process.execPath : undefined });
      }
      throw new Error(t('desk.err.command'));
    });
    trayPanel = new TrayPanel({ BrowserWindow, screen: require('electron').screen, origin,
      onRefresh: watchJobs, onOpen: show, onAction: body => request('/api/queue/bulk', body) });
    if (app.isPackaged && process.env.HD_DESKTOP_TEST !== '1') {
      const { autoUpdater } = require('electron-updater');
      updater = new Updater({ autoUpdater, dialog, version: app.getVersion(), onInstall: finish => quit(finish) });
      setTimeout(() => { void updater.check(false); }, 60000).unref(); // one quiet check after start; installing always needs a click
    }
    ipcMain.handle('tray:command', (event, command, id) => trayPanel.command(event, command, id));
    tray = new Tray(nativeImage.createFromPath(iconFile)); tray.setToolTip('Hypernab');
    const quickPanel = () => { if (!quitting) void trayPanel.toggle(tray.getBounds()); };
    tray.on('click', () => {
      if (Date.now() - lastTrayDoubleClick < 300) return;
      clearTimeout(trayClickTimer); trayClickTimer = setTimeout(quickPanel, 250);
    });
    tray.on('double-click', () => { lastTrayDoubleClick = Date.now(); show(); });
    // Automated acceptance uses only this isolated instance's native tray event.
    if (process.env.HD_DESKTOP_TEST === '1') { globalThis.__hypernabTestTray = tray; globalThis.__hypernabTestWatching = () => settings.watchClipboard === true; globalThis.__hypernabTestOffered = () => lastOffered; }
    rebuildMenu = () => {
      if (!tray) return;
      tray.setContextMenu(Menu.buildFromTemplate([{ label: t('desk.menu.quick'), click: quickPanel }, { label: t('desk.menu.open'), click: show }, { label: t('app.dir'), click: async () => shell.openPath(await currentDownloads()) }, { type: 'separator' },
        { label: t('app.pauseAll'), click: () => action('/api/queue/bulk', { action: 'pause', all: true }) }, { label: t('app.resumeAll'), click: () => action('/api/queue/bulk', { action: 'resume', all: true }) }, { type: 'separator' },
        { label: t('desk.menu.update'), click: () => { if (updater) void updater.check(true); else void dialog.showMessageBox({ type: 'info', message: t('desk.update.installedOnly') }); } }, { label: t('desk.menu.quit'), click: () => quit() }]));
    };
    rebuildMenu();
    await window.loadURL(origin);
    engine?.once('exit', code => { if (code === 0 && !quitting) { quitting = true; app.quit(); } }); // explicit Native shutdown must also close the owning desktop
    windowReady = true;
    if (showRequested || (!nativeBackground && !(startedByWindows && settings.startMinimized))) show();
    await watchJobs(); setInterval(watchJobs, 2000).unref();
    if (app.isPackaged && process.env.HD_DESKTOP_TEST !== '1') {
      try { const { installNative } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/install-native.js')).href); installNative({ rootDirectory: root, nodePath: node, dataDirectory: data, downloadDirectory: downloads, desktopExecutable: process.execPath }); }
      catch { /* Repair is available in Settings; HTTP pairing remains available. */ }
    }
  }).catch(error => { dialog.showErrorBox(t('desk.err.startTitle'), error.message); quitting = true; app.quit(); });
}
