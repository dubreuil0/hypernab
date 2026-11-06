// The browser extension, from the app window's side: the compact row at the top of Settings (connected or not, and where to get it) and
// the one-time "add the browser extension" window of a new install. A browser never lets an app add an extension silently: a button opens the
// store page (in the default browser when that is the right kind) and the person presses the add button there. Only two kinds of browser
// exist for the extension: Chromium-based ones (the Chrome Web Store) and Firefox.
export const STORES = {
  chromium: 'https://chromewebstore.google.com/detail/decnigdaajpbapbcaieefjnjapeombpb',
  firefox: 'https://addons.mozilla.org/en-US/firefox/addon/hypernab-video-catcher/'
};

export function setupExtension({ api, save, show }) {
  const $ = id => document.getElementById(id), T = globalThis.HypernabText.t, desktop = globalThis.hypernabDesktop;
  let connected = false, defaultFamily = null, welcomed = false;

  async function openStore(family) {
    try {
      if (desktop) {
        const result = await desktop.action('open-store', { family, url: STORES[family] });
        show(T(result?.opened ? 'ext.opened' : 'ext.copiedLink'));
      } else { window.open(STORES[family], '_blank', 'noopener'); show(T('ext.opened')); }
    } catch (error) { show(error.message, true); }
  }
  for (const [id, family] of [['ext-store-chromium', 'chromium'], ['ext-store-firefox', 'firefox'], ['ext-welcome-chromium', 'chromium'], ['ext-welcome-firefox', 'firefox']]) {
    $(id).onclick = async () => { await openStore(family); if (id.startsWith('ext-welcome')) $('ext-welcome').close(); };
  }
  $('ext-welcome-default').onclick = async () => { await openStore(defaultFamily); $('ext-welcome').close(); };
  $('ext-welcome-close').onclick = () => $('ext-welcome').close();
  // closing the window, by any way, is the answer: it never comes back
  $('ext-welcome').addEventListener('close', () => { save({ extensionPromptDone: true }).catch(() => {}); });

  // The store buttons stay whether or not the extension is connected: it may be wanted in another browser, or the default may change. Only the
  // "connection problem?" help is for the not-connected case.
  function render(isConnected) {
    connected = isConnected;
    const badge = $('ext-state'); badge.className = `badge${connected ? ' ok' : ''}`; badge.textContent = T(connected ? 'ext.row.connected' : 'ext.row.disconnected');
    $('ext-problem').hidden = connected;
    if (connected && $('ext-welcome').open) $('ext-welcome').close(); // it arrived while the window was open: nothing left to ask
  }
  async function look() {
    try { render((await api('/api/extension')).connected === true); } catch { /* keep the last mark */ }
    return connected;
  }
  render(false); void look();
  setInterval(() => { if ($('view-settings').hidden && !$('ext-welcome').open) return; void look(); }, 3000);

  /** Called with the settings the app just read: a brand-new install sees the window once (desktop app only), after a moment to let an extension that is already there say hello. */
  async function welcome(settings) {
    if (welcomed || !desktop || settings.extensionPromptDone !== false) return;
    welcomed = true;
    try { defaultFamily = await desktop.action('default-browser'); } catch { defaultFamily = null; }
    await new Promise(resolve => setTimeout(resolve, 2500));
    if (await look()) { save({ extensionPromptDone: true }).catch(() => {}); return; }
    try { if ((await api('/api/settings')).extensionPromptDone !== false) return; } catch { return; } // answered meanwhile
    if (document.querySelector('dialog[open]')) return; // another window is in front: try again at the next start
    $('ext-welcome-default').hidden = !defaultFamily;
    $('ext-welcome').showModal(); $('ext-welcome-close').focus();
  }
  return { welcome, look };
}
