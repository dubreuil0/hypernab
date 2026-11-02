// The extension's settings page: capture on/off, the link to the app and diagnostics. All texts come from
// strings.js keys; the controls are the design system's (ds.js). What used to live in the toolbar popup lives here now.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const $ = id => document.getElementById(id);
  const DS = globalThis.HypernabDS, T = (key, vars) => globalThis.HypernabText.t(key, vars);
  globalThis.HypernabText.follow?.(api, () => location.reload()); // the page is drawn again in the app's language
  Promise.resolve(api.runtime.sendMessage({ type: 'hypernab:language' })).catch(() => {}); // ask the background to read the app's language now
  { const theme = document.createElement('style'); theme.textContent = DS.tokens('auto', 'green', ':root'); document.head.append(theme); }
  if (document.documentElement) document.documentElement.lang = globalThis.HypernabText.language?.() || 'en';
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = T(node.dataset.t);
  $('token').placeholder = T('opt.conn.token');
  const say = (id, text, tone = '') => { const node = $(id); node.textContent = text; if (tone) node.dataset.tone = tone; else delete node.dataset.tone; };

  // ---- capture on/off (the same switch as a click on the toolbar icon)
  const capture = DS.toggle(document, { text: '', checked: true, onChange: async on => { await api.storage.local.set({ captureEnabled: on }); } });
  capture.input.setAttribute('aria-label', T('opt.capture.label')); $('capture-slot').append(capture.el);
  api.storage.local.get('captureEnabled').then(stored => { capture.input.checked = stored.captureEnabled !== false; }).catch(() => {});
  api.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.captureEnabled) capture.input.checked = changes.captureEnabled.newValue !== false; });

  // ---- the link to the app (native messaging; the key is the backup)
  const client = new Hypernab.Client();
  const channel = () => { if (!client.native || client.native.closed) client.native = new globalThis.HypernabNativeChannel(api.runtime); return client.native; };
  const check = async () => {
    try {
      const info = await client.request('/api/status');
      if (!info.extensionProtocol || info.extensionProtocol < 1) throw new Error(T('opt.conn.old'));
      say('conn-state', T('opt.conn.ok'), 'ok');
    } catch (error) { say('conn-state', error.message || T('opt.conn.fail'), 'error'); }
  };
  (async () => {
    const stored = await api.storage.local.get(['token', 'transport']).catch(() => ({}));
    if (stored.token && stored.transport !== 'native') { client.token = stored.token; $('token').value = stored.token; $('backup').open = true; }
    else if (globalThis.HypernabNativeChannel && api.runtime?.connectNative) { try { channel(); } catch { /* shown by check() */ } }
    await check();
  })();
  $('connect-native').addEventListener('click', async () => {
    try { channel(); await api.storage.local.set({ transport: 'native' }); client.token = ''; await check(); } catch (error) { say('conn-state', error.message, 'error'); }
  });
  $('open-app').addEventListener('click', async () => {
    const button = $('open-app'); button.disabled = true;
    try {
      const result = await channel().request({ action: 'show' });
      if (!result.status?.extensionProtocol) throw new Error(T('opt.conn.old'));
      await api.storage.local.set({ transport: 'native' });
      say('conn-state', T(result.alreadyRunning ? 'opt.conn.already' : 'opt.conn.opened'), 'ok');
    } catch (error) { say('conn-state', error.message || T('opt.conn.fail'), 'error'); }
    finally { button.disabled = false; }
  });
  $('save-token').addEventListener('click', async () => {
    const proposed = $('token').value.trim();
    if (!/^[a-f0-9]{64}$/.test(proposed)) return say('conn-state', T('opt.conn.token.invalid'), 'error');
    try {
      const info = await new Hypernab.Client({ token: proposed }).request('/api/status');
      if (!info.extensionProtocol || info.extensionProtocol < 1) throw new Error(T('opt.conn.old'));
      client.native?.close(); client.native = null; client.token = proposed;
      await api.storage.local.set({ token: proposed, transport: 'http' });
      say('conn-state', T('opt.conn.paired'), 'ok');
    } catch (error) { say('conn-state', error.message || T('opt.conn.fail'), 'error'); }
  });

  // ---- diagnostics: which page tab, watch its requests, copy the report
  let tabs = [], chosen = null;
  const tabPicker = DS.select(document, { label: T('opt.diag.tab'), value: '', options: [], placeholder: T('opt.diag.notabs'), onChange: value => { chosen = Number(value); } });
  $('tab-slot').append(tabPicker.el);
  (async () => {
    try {
      tabs = (await api.tabs.query({})).filter(tab => /^https?:/i.test(tab.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 12);
      tabPicker.setOptions(tabs.map(tab => ({ value: String(tab.id), label: (tab.title || tab.url).slice(0, 60), sub: new URL(tab.url).hostname })), tabs[0] ? String(tabs[0].id) : '');
      chosen = tabs[0]?.id ?? null;
    } catch { /* no tab access: the buttons say so */ }
  })();
  $('diag-watch').addEventListener('click', async () => {
    if (chosen === null) return say('diag-state', T('opt.diag.notabs'), 'error');
    const answer = await api.runtime.sendMessage({ type: 'hypernab:diagnostic-mode', tabId: chosen, enabled: true }).catch(() => null);
    say('diag-state', answer?.ok ? T('opt.diag.watching') : T('opt.diag.failed'), answer?.ok ? 'ok' : 'error');
  });
  $('diag-report').addEventListener('click', async () => {
    const button = $('diag-report'), box = $('diag-text');
    if (chosen === null) return say('diag-state', T('opt.diag.notabs'), 'error');
    button.disabled = true; box.hidden = true; say('diag-state', T('opt.diag.working'));
    try {
      const answer = await api.runtime.sendMessage({ type: 'hypernab:diagnose', tabId: chosen });
      if (!answer?.ok) throw new Error(answer?.error || T('opt.diag.failed'));
      const text = JSON.stringify(answer.data, null, 2);
      box.value = text; box.hidden = false;
      try { await navigator.clipboard.writeText(text); say('diag-state', T('opt.diag.copied'), 'ok'); } catch { box.select(); say('diag-state', T('opt.diag.manual')); }
    } catch (error) { say('diag-state', error.message, 'error'); }
    finally { button.disabled = false; }
  });
})();
