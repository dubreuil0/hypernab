// Capture on/off, the toolbar icon (a click switches capture, no popup; off = grey icon with a red slash) and its right-click menu. Loaded before background.js; the rest
// of the extension only asks HypernabControl.on. The state lives in storage.local ("captureEnabled", on unless saved as false), so it
// survives restarts, and content scripts follow it through storage.onChanged without any message.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // The toolbar tooltip and the right-click menu are the browser's own surface, shared with other extensions: always English, whatever the app's language.
  const T = (key, vars) => (globalThis.HypernabText?.TEXTS?.en?.[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
  const control = { on: true };
  globalThis.HypernabControl = control;
  const MENU = ['open-app', 'inspect-page', 'capture', 'settings'];
  // What the toolbar icon says about the last "Download with Hypernab" on a link: a short mark and a tooltip, then it goes back to normal.
  const NOTICES = {
    added: { badge: 'OK', color: '#1e7e34', title: 'ctl.title.added', ms: 6000 },
    duplicate: { badge: '=', color: '#a56a00', title: 'ctl.title.duplicate', ms: 20000 },
    failed: { badge: '!', color: '#c0392b', title: 'ctl.title.failed', ms: 120000 }
  };
  let notice = null, noticeTimer = null;

  const paint = async () => {
    try {
      await api.action.setTitle({ title: notice ? T(NOTICES[notice.kind].title, notice) : T(control.on ? 'ctl.title.on' : 'ctl.title.off') });
      // Off is seen at a glance: the icon turns grey and faded with a red slash across it (icons/icon-off-*.png). On: the normal icon.
      await api.action.setIcon({ path: control.on ? { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } : { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' } });
      await api.action.setBadgeText({ text: notice ? NOTICES[notice.kind].badge : '' });
      if (notice) { try { await api.action.setBadgeBackgroundColor({ color: NOTICES[notice.kind].color }); } catch { /* no colour: the mark is still there */ } }
      if (!control.on) { // a count of captured items left on a tab belongs to the time capture was on
        for (const tab of await api.tabs.query({})) { try { await api.action.setBadgeText({ tabId: tab.id, text: '' }); } catch { /* tab went away */ } }
      }
    } catch { /* icon state is cosmetic; capture does not depend on it */ }
  };
  const load = async () => {
    try { control.on = (await api.storage.local.get('captureEnabled')).captureEnabled !== false; } catch { control.on = true; }
    await paint();
  };
  control.ready = load();
  // kind: 'added' | 'duplicate' | 'failed'; name: the file; reason: why it failed (short, may be in the app's language)
  control.notice = async (kind, name, reason = '') => {
    if (!NOTICES[kind]) return;
    notice = { kind, name: String(name || '').slice(0, 80) || 'file', reason: String(reason || '').slice(0, 120) };
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = null; void paint(); }, NOTICES[kind].ms);
    await paint();
  };
  control.set = async on => { control.on = Boolean(on); await api.storage.local.set({ captureEnabled: control.on }); await paint(); await menus(); };
  api.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.captureEnabled) { control.on = changes.captureEnabled.newValue !== false; paint(); menus(); }
  });

  // The toolbar icon: one click switches capture. (The menu below carries everything else.)
  api.action.onClicked.addListener(() => { control.set(!control.on).catch(() => {}); });

  async function menus() {
    if (!api.contextMenus?.create) return;
    try {
      await new Promise(resolve => api.contextMenus.removeAll(resolve));
      const add = (id, title, extra = {}) => api.contextMenus.create({ id, title, contexts: ['action'], ...extra }, () => void api.runtime.lastError);
      add('open-app', T('ctl.menu.open'));
      add('inspect-page', T('ctl.menu.inspect'));
      add('sep', '', { type: 'separator' });
      add('capture', T('ctl.menu.capture'), { type: 'checkbox', checked: control.on });
      add('settings', T('ctl.menu.settings'));
      // On a link of a page (not on the toolbar icon): the user asks for this one file. Only while capture is on.
      if (control.on) add('download-link', T('ctl.menu.link'), { contexts: ['link'] });
    } catch { /* the menu is optional */ }
  }
  control.menus = menus;
  api.contextMenus?.onClicked?.addListener(async (info, tab) => {
    if (!MENU.includes(info.menuItemId)) return;
    try {
      if (info.menuItemId === 'capture') await control.set(info.checked === true);
      else if (info.menuItemId === 'settings') await api.runtime.openOptionsPage();
      else if (info.menuItemId === 'inspect-page' && tab?.id >= 0) await api.tabs.sendMessage(tab.id, { type: 'hypernab:show-panel' });
      else if (info.menuItemId === 'open-app') { const channel = new globalThis.HypernabNativeChannel(api.runtime); try { await channel.request({ action: 'show' }); } finally { channel.close?.(); } }
    } catch { /* a failed menu action changes nothing; the settings page shows connection problems */ }
  });
  // A fresh install opens the settings page once: it shows how the icon works (click = capture on/off, right-click = menu). Updates stay quiet.
  api.runtime.onInstalled?.addListener(details => { menus(); if (details?.reason === 'install') Promise.resolve(api.runtime.openOptionsPage()).catch(() => {}); });
  api.runtime.onStartup?.addListener(() => { menus(); });
  control.ready.then(menus);
})();
