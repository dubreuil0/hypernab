// "Download with Hypernab" in the right-click menu of a link. The user asks for one file and Hypernab takes it: nothing is held, paused
// or watched, so it works the same in every browser. The cookies of that one address are read now, because the user just asked;
// they travel only to the app on this computer and are never stored. The result shows on the toolbar icon (a short mark and a tooltip).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const H = globalThis.Hypernab, F = globalThis.HypernabFloat, C = globalThis.HypernabControl;
  if (!api?.contextMenus?.onClicked || !H || !F || !C) return;
  const tasks = new Set(); // lets tests wait for the work
  // A short label for messages: the file part of the address, else the site.
  const labelOf = url => { try { const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || ''); return (last || url.hostname).slice(0, 80); } catch { return url.hostname; } };

  async function download(info, tab) {
    const url = H.httpUrl(info.linkUrl);
    if (!url) { await C.notice('failed', 'link', 'Not a web address'); return; } // mailto:, javascript: ... are not files
    const label = labelOf(url);
    try {
      const client = await F.connection(true); // starts the app when it is closed, like the video button
      // A private window keeps its own cookies; where the browser does not name that store, none are sent (the normal session is never used for it).
      const cookies = tab?.incognito && !tab.cookieStoreId ? [] : await H.sessionCookies(api, [url.href, info.pageUrl], tab?.cookieStoreId);
      const referer = H.httpUrl(info.pageUrl)?.href;
      const submissionId = globalThis.crypto.randomUUID();
      const body = { url: url.href, referer, userAgent: globalThis.navigator?.userAgent, cookies, start: 'now', submissionId };
      let result;
      try { result = await client.request('/api/files/take', { method: 'POST', body: JSON.stringify(body) }); }
      catch (error) {
        // A lost answer is not a lost file: ask whether the app already has this submission.
        if (H.transientError(error)) { try { const receipt = await client.request(`/api/submissions/${submissionId}`); if (receipt.known && receipt.listed !== false) result = { name: label }; } catch { /* still unknown */ } }
        if (!result) throw error;
      }
      await C.notice('added', result?.name || label);
    } catch (error) {
      if (error?.code === 'duplicate') await C.notice('duplicate', label);
      else await C.notice('failed', label, error?.message || '');
    }
  }
  api.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'download-link' || C.on === false) return;
    const task = download(info, tab).catch(() => {}).finally(() => tasks.delete(task));
    tasks.add(task);
  });
  // run: the menu click's work, callable by tests; idle: lets tests wait for it
  globalThis.HypernabLinkDownload = { run: download, idle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); } };
})();
