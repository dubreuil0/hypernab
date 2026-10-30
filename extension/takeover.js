// Takes over the browser's own file downloads (zip, pdf, iso, exe ...) when the user wants Hypernab to fetch them.
// The rule that matters most: a download is never lost. The browser's download is only paused while the user decides, and it is
// cancelled ONLY after Hypernab has confirmed it accepted the file. Anything else (app closed, error, closed window,
// no answer) resumes the browser's own download. Cookies are read only when the user presses a button for that file.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const H = globalThis.Hypernab, F = globalThis.HypernabFloat;
  if (!api?.downloads?.onCreated || !api.windows?.create || !H || !F) return;
  const PENDING = 'takeover:pending', WINDOW = 'takeover:window', MAX_PENDING = 30;
  const DEFAULTS = { enabled: true, minBytes: 1048576, autoTypes: [], excludedHosts: [] };
  const PROGRAM = new Set(['exe', 'msi', 'msix', 'appx', 'msp', 'scr', 'com', 'pif', 'dll', 'cpl', 'sys', 'jar', 'apk']);
  const SCRIPT = new Set(['bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'reg', 'msc', 'url', 'docm', 'xlsm', 'pptm']);

  const clean = value => {
    const s = value && typeof value === 'object' ? value : {};
    const list = (items, max) => Array.isArray(items) ? [...new Set(items.filter(item => typeof item === 'string' && /^[a-z0-9.-]{1,80}$/.test(item)))].slice(0, max) : [];
    return { enabled: s.enabled !== false, minBytes: Number.isSafeInteger(s.minBytes) && s.minBytes >= 0 && s.minBytes <= 1073741824 ? s.minBytes : DEFAULTS.minBytes, autoTypes: list(s.autoTypes, 50), excludedHosts: list(s.excludedHosts, 100) };
  };
  const readSettings = async () => clean((await api.storage.local.get('takeover')).takeover);
  const writeSettings = async patch => { const next = clean({ ...(await readSettings()), ...patch }); await api.storage.local.set({ takeover: next }); return next; };

  // One writer at a time: several downloads can start in the same instant.
  let chain = Promise.resolve();
  const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const readPending = async () => { const value = (await api.storage.session.get(PENDING))[PENDING]; return Array.isArray(value) ? value : []; };
  const writePending = list => api.storage.session.set({ [PENDING]: list });

  const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; } };
  const baseName = value => String(value || '').split(/[\\/]/).pop();
  const extOf = name => { const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  const riskOf = name => PROGRAM.has(extOf(name)) ? 'program' : SCRIPT.has(extOf(name)) ? 'script' : null;
  const nameFromUrl = raw => { try { const part = new URL(raw).pathname.split('/').filter(Boolean).pop() || ''; try { return decodeURIComponent(part); } catch { return part; } } catch { return ''; } };

  function eligible(item, s) {
    if (!s.enabled || !item || item.state === 'complete' || item.incognito || item.byExtensionId) return false;
    const url = H.httpUrl(item.url);
    if (!url || /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)) return false; // pages of the app itself and local test servers
    if (/^(?:text\/html|application\/xhtml)/i.test(item.mime || '')) return false;
    if (s.excludedHosts.includes(url.hostname.toLowerCase())) return false;
    if (item.totalBytes > 0 && item.totalBytes < s.minBytes) return false;
    return true;
  }

  // Cancels the browser's own download. Returns true when the browser nevertheless finished a copy (nothing is ever deleted).
  async function dropBrowserDownload(id) {
    try { await api.downloads.cancel(id); } catch { /* already gone */ }
    let copy = false;
    try { copy = (await api.downloads.search({ id }))[0]?.state === 'complete'; } catch { /* unknown: assume no copy */ }
    try { await api.downloads.erase({ id }); } catch { /* list entry already gone */ }
    return copy;
  }
  // Gives the download back to the browser. Some browsers (Firefox) cannot resume a download that was stopped before any data
  // arrived; then the browser is simply asked to download the same address again, so the user never has to click twice.
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const running = item => item && (item.state === 'complete' || (item.state === 'in_progress' && !item.paused));
  async function resumeBrowser(id, address, name) {
    try { await api.downloads.resume(id); } catch { /* maybe it is not paused any more */ }
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(attempt ? 500 : 200);
      let item; try { item = (await api.downloads.search({ id }))[0]; } catch { return; }
      if (!item || running(item)) return; // moving again, finished, or removed by the user's own hand
      if (attempt === 1) { try { await api.downloads.resume(id); } catch { /* still try the fallback below */ } }
    }
    if (!address) return;
    try { const last = (await api.downloads.search({ id }))[0]; if (!last || running(last)) return; } catch { return; }
    try { await api.downloads.erase({ id }); } catch { /* the old entry may already be gone */ }
    try { await api.downloads.download({ url: address, ...(name && !/[\\/:*?"<>|]/.test(name) ? { filename: name } : {}), conflictAction: 'uniquify' }); } catch { /* the page's own link still works */ }
  }

  async function releaseAll() {
    const list = await serial(async () => { const items = await readPending(); await writePending([]); return items; });
    await Promise.all(list.map(record => resumeBrowser(record.id, record.url, record.name)));
    await api.storage.session.remove(WINDOW).catch(() => {});
  }

  async function windowAlive() {
    const stored = (await api.storage.session.get(WINDOW))[WINDOW];
    if (!stored) return false;
    try { await api.windows.get(stored); return true; } catch { return false; }
  }
  async function ensureWindow() {
    if (await windowAlive()) { try { await api.windows.update((await api.storage.session.get(WINDOW))[WINDOW], { focused: true }); } catch { /* best effort */ } return; }
    const created = await api.windows.create({ url: api.runtime.getURL('download-prompt.html'), type: 'popup', width: 520, height: 470, focused: true });
    await api.storage.session.set({ [WINDOW]: created.id });
  }

  async function take(record, { start, allowDuplicate }) {
    const client = await F.connection(true);
    const cookies = await H.sessionCookies(api, [record.url, record.referrer], record.cookieStoreId);
    const submissionId = globalThis.crypto.randomUUID();
    const body = { url: record.url, fileName: record.name, referer: record.referrer || undefined, userAgent: globalThis.navigator?.userAgent, cookies, start, submissionId, ...(allowDuplicate ? { allowDuplicate: true } : {}) };
    let result;
    try { result = await client.request('/api/files/take', { method: 'POST', body: JSON.stringify(body) }); }
    catch (error) {
      // A lost answer is not a lost file: ask whether the app already has this submission.
      if (H.transientError(error)) { try { const receipt = await client.request(`/api/submissions/${submissionId}`); if (receipt.known && receipt.listed !== false) result = { id: receipt.id, name: record.name }; } catch { /* still unknown */ } }
      if (!result) throw error;
    }
    const browserCopy = await dropBrowserDownload(record.id); // only now: the app has the file
    return { ...result, browserCopy };
  }

  async function onCreated(created) {
    const s = await readSettings();
    if (!eligible(created, s)) return;
    // Pause first: a small file can finish within milliseconds. A paused download that is not wanted is simply resumed.
    try { await api.downloads.pause(created.id); } catch { return; } // already finished or not pausable: leave it alone
    try { await F.connection(false); } catch { await resumeBrowser(created.id, created.url, baseName(created.filename) || undefined); return; } // app not running: the browser keeps downloading
    let item = created;
    try { item = (await api.downloads.search({ id: created.id }))[0] || created; } catch { /* use the first information */ }
    if (item.state === 'complete') return; // the browser was faster than the pause: nothing to take over
    if (!eligible(item, s)) { await resumeBrowser(created.id, created.url, baseName(created.filename) || undefined); return; }
    const name = baseName(item.filename) || nameFromUrl(item.url) || 'dosya';
    const record = { id: item.id, url: item.url, referrer: H.httpUrl(item.referrer) ? item.referrer : '', name, bytes: item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : null, mime: item.mime || '', cookieStoreId: item.cookieStoreId || undefined, at: Date.now() };
    if (s.autoTypes.includes(extOf(name))) { // the user said "always" for this type: no window, same safety
      try { await take(record, { start: 'now' }); } catch { await resumeBrowser(record.id, record.url, record.name); }
      return;
    }
    const accepted = await serial(async () => {
      const list = await readPending();
      if (list.length >= MAX_PENDING) return false;
      await writePending([...list, record]); return true;
    });
    if (!accepted) { await resumeBrowser(record.id, record.url, record.name); return; }
    try { await ensureWindow(); } catch { await releaseAll(); }
  }

  async function view() {
    const list = await readPending();
    const record = list[0];
    if (!record) return { ok: true, empty: true };
    let duplicate = false, directory = null;
    try {
      const client = await F.connection(false);
      duplicate = ((await client.request('/api/duplicates', { method: 'POST', body: JSON.stringify({ url: record.url }) })).duplicates || []).length > 0;
      directory = (await client.request('/api/status')).directory || null;
    } catch { /* the choices still work; the app is asked again when one is pressed */ }
    return { ok: true, id: record.id, name: record.name, host: hostOf(record.url), bytes: record.bytes, ext: extOf(record.name), risk: riskOf(record.name), duplicate, directory, remaining: list.length - 1 };
  }

  const busy = new Set();
  async function decide({ id, choice, rememberType, rememberHost, allowDuplicate }) {
    if (busy.has(id)) return { ok: false, error: 'İşlem sürüyor.' };
    busy.add(id);
    try {
      const record = (await readPending()).find(item => item.id === id);
      if (!record) return { ok: true, gone: true };
      const finish = () => serial(async () => { await writePending((await readPending()).filter(item => item.id !== id)); });
      if (choice === 'browser') {
        await finish(); await resumeBrowser(id, record.url, record.name);
        if (rememberHost && hostOf(record.url)) { const s = await readSettings(); await writeSettings({ excludedHosts: [...s.excludedHosts, hostOf(record.url)] }); }
        return { ok: true };
      }
      if (choice === 'cancel') { await finish(); await dropBrowserDownload(id); return { ok: true }; }
      if (choice !== 'now' && choice !== 'later') return { ok: false, error: 'Geçersiz seçim.' };
      let current = null;
      try { current = (await api.downloads.search({ id }))[0] || null; } catch { /* ask the app anyway */ }
      if (!current) { await finish(); return { ok: true, gone: true, name: record.name }; } // removed in the browser meanwhile
      if (current.state === 'complete') { await finish(); return { ok: true, browserDone: true, name: record.name }; } // the browser finished it itself
      try {
        const result = await take(record, { start: choice === 'later' ? 'queue' : 'now', allowDuplicate: allowDuplicate === true });
        await finish();
        if (rememberType && choice === 'now' && extOf(record.name)) { const s = await readSettings(); await writeSettings({ autoTypes: [...s.autoTypes, extOf(record.name)] }); }
        return { ok: true, name: result?.name || record.name, queued: choice === 'later', browserCopy: result?.browserCopy === true };
      } catch (error) {
        // Nothing was cancelled: the browser's download is still paused and can continue.
        return { ok: false, code: error.code || null, error: String(error.message || 'Hypernab dosyayı alamadı.').slice(0, 300), duplicate: error.code === 'duplicate' };
      }
    } finally { busy.delete(id); }
  }

  const ours = sender => sender?.id === api.runtime.id;
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!ours(sender) || typeof message?.type !== 'string' || !message.type.startsWith('hypernab:takeover:')) return false;
    const work = message.type === 'hypernab:takeover:next' ? view()
      : message.type === 'hypernab:takeover:decide' ? decide(message)
        : message.type === 'hypernab:takeover:settings' ? (message.patch ? writeSettings(message.patch) : readSettings()).then(settings => ({ ok: true, settings }))
          : message.type === 'hypernab:takeover:release' ? releaseAll().then(() => ({ ok: true }))
            : Promise.resolve({ ok: false });
    work.then(respond, error => respond({ ok: false, error: String(error?.message || 'Hata').slice(0, 200) }));
    return true;
  });
  api.downloads.onCreated.addListener(item => { onCreated(item).catch(() => {}); });
  api.windows.onRemoved?.addListener(async id => {
    if ((await api.storage.session.get(WINDOW))[WINDOW] === id) await releaseAll();
  });
  // A browser restart or a stopped background must never leave a download paused for good.
  (async () => { if ((await readPending()).length && !(await windowAlive())) await releaseAll(); })().catch(() => {});
})();
