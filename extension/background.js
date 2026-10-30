// Only media URLs/metadata are kept in session storage. The background never reads cookies; the popup does, per user action.
if (!globalThis.Hypernab && typeof importScripts === 'function') importScripts('native-config.js', 'native.js', 'core.js', 'float.js', 'takeover.js'); // float.js: on-page download panel backend; takeover.js: browser file downloads
const browserApi = globalThis.browser ?? globalThis.chrome;
let writes = Promise.resolve();
const generations = new Map();
const diagnosticTabs = new Set();

function mediaKind(raw, contentType = '', size = 0) {
  return Hypernab.mediaKind(raw, contentType, size);
}

// Length of the whole resource from the response headers (Content-Range total, else Content-Length).
function responseSize(details) {
  const header = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
  return Number(/\/(\d+)$/.exec(header('content-range'))?.[1] || header('content-length')) || 0;
}

// New media or a changed player on a tab: tell its page (all frames) to look up again, merged into one message per burst.
const notifyTimers = new Map();
function notifyTab(tabId) {
  try { // a notification problem must never stop the capture itself
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.set(tabId, setTimeout(() => {
      notifyTimers.delete(tabId);
      try { Promise.resolve(browserApi.tabs.sendMessage(tabId, { type: 'hypernab:refresh' })).catch(() => {}); } catch { /* tab closed or no listener */ }
    }, 800));
  } catch { /* no timers in this environment */ }
}

function capture(details, contentType = '') {
  if (details.tabId < 0 || !/^https?:/i.test(details.url)) return;
  if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) return;
  let kind = mediaKind(details.url, contentType, responseSize(details));
  const size = responseSize(details), declaredLength = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value;
  // Plausible disguised manifests only: no images, scripts, subtitles or TS fragments; never fetch every page request.
  if (!kind && (!details.statusCode || [200, 206].includes(details.statusCode)) && (declaredLength === undefined || Number(declaredLength) !== 0) && (!size || size >= 16) && ['xmlhttprequest', 'media', 'other'].includes(details.type) && /^(?:text\/plain|application\/octet-stream)?(?:;|$)/i.test(contentType) && size <= 2 * 1048576 && !/\.(?:ts|m4s|vtt|srt|js|css|json|png|jpg|webp|woff2?)$/i.test(new URL(details.url).pathname)) kind = 'UNKNOWN';
  if (!kind || details.url.length > 12000) return;
  const generation = generations.get(details.tabId) || 0;
  // Partial MP4 range requests may each have a unique query: cap per-tab storage.
  writes = writes.then(async () => {
    if (generation !== (generations.get(details.tabId) || 0)) return;
    const key = `tab:${details.tabId}`;
    const stored = await browserApi.storage.session.get([key, `context:${details.tabId}`]);
    const entries = stored[key] || [];
    const context = stored[`context:${details.tabId}`] || {};
    const frame = context.frames?.[details.frameId || 0] || {};
    const source = new URL(details.url);
    const identity = new URL(source);
    // Group byte-range variants, but NEVER modify the signed URL used for downloading.
    identity.searchParams.delete('bytes');
    const responseHeader = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
    const contentRange = responseHeader('content-range');
    const total = /\/(\d+)$/.exec(contentRange)?.[1];
    const partial = details.statusCode === 206 || source.searchParams.has('bytes') || Boolean(contentRange);
    const entry = {
      url: details.url, identity: identity.href, kind, host: source.hostname,
      observedBy: details.fromDom ? 'dom' : 'network',
      frameId: details.frameId || 0, frameUrl: frame.url || details.documentUrl || details.originUrl || null,
      pageTitle: context.title || '', frameTitle: frame.title || '', rangeLimited: Hypernab.rangeLimited(details.url), drmSuspected: frame.drm === true,
      playerBlob: frame.playerBlob === true, observedHeight: frame.mediaUrl === details.url ? frame.height : null,
      observedDuration: frame.mediaUrl === details.url ? frame.duration : null,
      mime: contentType.split(';')[0], partial,
      size: Number(total || (!partial ? responseHeader('content-length') : 0)) || null,
      detectedAt: Date.now()
    };
    const index = entries.findIndex(item => (item.identity || item.url) === entry.identity);
    if (index >= 0) {
      const previous = entries[index];
      if (details.fromDom && previous.observedBy === 'network') Object.assign(entry, { observedBy: 'network', partial: previous.partial, size: previous.size, mime: previous.mime });
      entries.splice(index, 1);
    }
    entries.unshift(entry);
    let unknowns = 0;
    const bounded = entries.filter(item => item.kind !== 'UNKNOWN' || ++unknowns <= 8).slice(0, 60);
    await browserApi.storage.session.set({ [key]: bounded });
    await browserApi.action.setBadgeText({ tabId: details.tabId, text: String(Math.min(entries.length, 60)) });
    await browserApi.action.setBadgeBackgroundColor({ tabId: details.tabId, color: '#658e32' });
    notifyTab(details.tabId);
  }).catch(() => {});
}

// Subtitle files the page loaded, found by their type/shape, never by site. Unsure candidates (plain text / binary answers of
// scripts) are only kept as addresses: the app reads them and keeps just what really is a subtitle.
const SUBTITLE_TYPE = /^(?:text\/(?:vtt|srt|x-srt|x-ssa|x-ass)|application\/(?:x-subrip|x-subtitle|ttml\+xml|x-ttml\+xml|vtt))(?:;|$)/i;
function captureSubtitle(details, contentType = '') {
  if (details.tabId < 0 || !/^https?:/i.test(details.url) || details.url.length > 1200) return;
  if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) return;
  let path = ''; try { path = new URL(details.url).pathname; } catch { return; }
  const size = responseSize(details);
  const sure = /\.(?:vtt|srt|ass|ssa|ttml|dfxp)$/i.test(path) || SUBTITLE_TYPE.test(contentType);
  const unsure = !sure && ['xmlhttprequest', 'media', 'other'].includes(details.type) && /^(?:text\/plain|application\/octet-stream)?(?:;|$)/i.test(contentType) && size > 0 && size <= 1500000 && !/\.(?:ts|m4s|mp4|m3u8|mpd|js|css|json|png|jpe?g|gif|webp|svg|ico|woff2?|html?)$/i.test(path);
  if (!sure && !unsure) return;
  const generation = generations.get(details.tabId) || 0;
  writes = writes.then(async () => {
    if (generation !== (generations.get(details.tabId) || 0)) return;
    const key = `subs-net:${details.tabId}`, list = (await browserApi.storage.session.get(key))[key] || [];
    if (list.some(item => item.url === details.url)) return;
    list.unshift({ url: details.url, mime: contentType.split(';')[0], size: size || null, sure, frameId: details.frameId || 0, at: Date.now() });
    let weak = 0;
    await browserApi.storage.session.set({ [key]: list.filter(item => item.sure || ++weak <= 8).slice(0, 24) });
  }).catch(() => {});
}
function recordSubtitles(message, sender) {
  if (sender.id !== browserApi.runtime?.id || !sender.tab || sender.tab.id < 0 || !Hypernab.httpUrl(sender.url) || !Number.isFinite(message.serial)) return Promise.resolve({ ok: false });
  const generation = generations.get(sender.tab.id) || 0;
  writes = writes.then(async () => {
    if (generation !== (generations.get(sender.tab.id) || 0)) return;
    const key = `subs:${sender.tab.id}`, all = (await browserApi.storage.session.get(key))[key] || {};
    const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, 60) : '';
    const tracks = (Array.isArray(message.tracks) ? message.tracks : []).slice(0, 12).filter(track => typeof track?.vtt === 'string' && track.vtt.length <= 1500000)
      .map(track => ({ lang: text(track.lang).slice(0, 20), label: text(track.label), default: track.default === true, vtt: track.vtt }));
    const urls = (Array.isArray(message.urls) ? message.urls : []).slice(0, 12).filter(item => Hypernab.httpUrl(item?.url) && item.url.length <= 1200)
      .map(item => ({ url: item.url, lang: text(item.lang).slice(0, 20), label: text(item.label), default: item.default === true }));
    all[sender.frameId || 0] = { serial: message.serial, tracks, urls };
    let total = 0; // session storage has a small quota: keep the newest frames within a few megabytes
    for (const frame of Object.values(all)) total += frame.tracks.reduce((sum, track) => sum + track.vtt.length, 0);
    if (total > 6000000) return;
    await browserApi.storage.session.set({ [key]: all });
  }).catch(() => {});
  return writes.then(() => ({ ok: true }));
}

browserApi.webRequest.onHeadersReceived.addListener(details => {
  const type = details.responseHeaders?.find(header => header.name.toLowerCase() === 'content-type')?.value || '';
  capture(details, type);
  captureSubtitle(details, type);
  if (diagnosticTabs.has(details.tabId)) {
    const generation = generations.get(details.tabId) || 0;
    writes = writes.then(async () => {
      if (!diagnosticTabs.has(details.tabId) || generation !== (generations.get(details.tabId) || 0)) return;
      const url = new URL(details.url);
      if (!/^https?:$/.test(url.protocol)) return;
      const safe = url.origin + url.pathname.split('/').map(part => part ? `[${part.length}]` : '').join('/');
      const key = `requests:${details.tabId}`, stored = await browserApi.storage.session.get(key);
      await browserApi.storage.session.set({ [key]: [{ url: safe, type: details.type, mime: type.split(';')[0], status: details.statusCode, size: responseSize(details) }, ...(stored[key] || [])].slice(0, 200) });
    }).catch(() => {});
  }
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

browserApi.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && change.status !== 'loading') notifyTab(tabId); // in-page navigation (no reload)
  if (change.status !== 'loading') return;
  generations.set(tabId, (generations.get(tabId) || 0) + 1);
  writes = writes.then(async () => {
    await browserApi.storage.session.remove(`tab:${tabId}`);
    await browserApi.storage.session.remove(`context:${tabId}`);
    await browserApi.storage.session.remove(`requests:${tabId}`);
    await browserApi.storage.session.remove([`subs:${tabId}`, `subs-net:${tabId}`]);
    await browserApi.action.setBadgeText({ tabId, text: '' });
  }).catch(() => {});
});
browserApi.tabs.onRemoved.addListener(tabId => {
  diagnosticTabs.delete(tabId);
  generations.set(tabId, (generations.get(tabId) || 0) + 1);
  writes = writes.then(async () => {
    await browserApi.storage.session.remove(`tab:${tabId}`);
    await browserApi.storage.session.remove(`context:${tabId}`);
    await browserApi.storage.session.remove(`requests:${tabId}`);
    await browserApi.storage.session.remove([`subs:${tabId}`, `subs-net:${tabId}`]);
    generations.delete(tabId);
  }).catch(() => {});
});

function recordFrame(message, sender) {
  if (sender.id !== browserApi.runtime?.id || !sender.tab || sender.tab.id < 0 || !Hypernab.httpUrl(sender.url) || message?.type !== 'hypernab:media-context') return Promise.resolve({ ok: false });
  const generation = generations.get(sender.tab.id) || 0;
  writes = writes.then(async () => {
    if (generation !== (generations.get(sender.tab.id) || 0)) return;
    const key = `context:${sender.tab.id}`, mediaKey = `tab:${sender.tab.id}`;
    const stored = await browserApi.storage.session.get([key, mediaKey]);
    const context = stored[key] || { frames: {} };
    const frameId = sender.frameId || 0;
    if (!context.frames[frameId] && Object.keys(context.frames).length >= 40) return;
    const title = typeof message.title === 'string' ? message.title.slice(0, 240) : '';
    const height = Number.isFinite(message.height) && message.height > 0 && message.height <= 16384 ? Math.round(message.height) : null;
    const duration = Number.isFinite(message.duration) && message.duration > 0 && message.duration <= 604800 ? message.duration : null;
    context.frames[frameId] = { url: sender.url, title, drm: message.drm === true || context.frames[frameId]?.drm === true, playerBlob: message.playerBlob === true, mediaUrl: Hypernab.httpUrl(message.url) ? message.url : null, height, duration };
    if (frameId === 0) context.title = title;
    const entries = (stored[mediaKey] || []).map(entry => entry.frameId === frameId ? { ...entry, frameUrl: sender.url, frameTitle: title, pageTitle: context.title || entry.pageTitle, drmSuspected: context.frames[frameId].drm, playerBlob: context.frames[frameId].playerBlob, observedHeight: message.url === entry.url ? height : null, observedDuration: message.url === entry.url ? duration : null } : { ...entry, pageTitle: context.title || entry.pageTitle });
    await browserApi.storage.session.set({ [key]: context, [mediaKey]: entries });
    notifyTab(sender.tab.id);
    if (Hypernab.httpUrl(message.url) && message.url.length <= 12000 && !message.drm) {
      // Schedule after the current write (never await the same serialized chain).
      capture({ tabId: sender.tab.id, frameId, documentUrl: sender.url, url: message.url, statusCode: 200, fromDom: true });
    }
  }).catch(() => {});
  return writes.then(() => ({ ok: true }));
}
browserApi.runtime?.onMessage?.addListener((message, sender, respond) => {
  if (message?.type === 'hypernab:diagnostic-mode') {
    if (sender.id !== browserApi.runtime?.id || sender.tab || !Number.isInteger(message.tabId)) { respond({ ok: false }); return false; }
    if (message.enabled === true) diagnosticTabs.add(message.tabId); else diagnosticTabs.delete(message.tabId);
    respond({ ok: true }); return false;
  }
  if (message?.type === 'hypernab:open-panel') {
    // Only our own content script, from a real tab. The panel still needs the user's explicit Start.
    if (sender.id !== browserApi.runtime?.id || !sender.tab || !Hypernab.httpUrl(sender.url)) { respond({ ok: false }); return false; }
    Promise.resolve().then(() => browserApi.action.openPopup()).then(() => respond({ ok: true, opened: true }), () => respond({ ok: true, opened: false }));
    return true;
  }
  if (message?.type === 'hypernab:subtitles') { recordSubtitles(message, sender).then(respond, () => respond({ ok: false })); return true; }
  if (message?.type !== 'hypernab:media-context') return false;
  recordFrame(message, sender).then(respond, () => respond({ ok: false }));
  return true;
});
