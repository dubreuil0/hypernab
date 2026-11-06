// Shared by Firefox event pages, Chromium service workers and both popup builds.
(() => {
  const T = (key, vars) => globalThis.HypernabText?.t(key, vars) ?? key; // texts: public/strings.js, in the language of the app
  const API = 'http://127.0.0.1:17846';
  const httpUrl = value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
  };
  // Whole-file sizes: a short .ts/.aac is one piece of an HLS stream, a long one is a complete file. Small audio is a UI sound.
  const TS_MIN = 8 * 1048576, AUDIO_MIN = 1048576;
  const TS_NAME = /\.(?:ts|mts|m2ts)$/i, STREAM_KINDS = ['HLS', 'DASH'];
  // VIDEO = mp4/webm/mov/mkv/m4v; OTHER = every other video container (flv, avi, wmv, 3gp, ogv, mpg, whole .ts); AUDIO = sound files.
  // size is optional (response length); without it a possible stream piece is never accepted.
  function mediaKind(raw, contentType = '', size = 0) {
    const url = httpUrl(raw); if (!url) return null;
    const path = url.pathname, type = String(contentType).split(';')[0].trim().toLowerCase();
    if (/\.(?:m4s|vtt|srt|ass|ttml)$/i.test(path) || /^(?:text\/vtt|application\/x-subrip)$/.test(type)) return null;
    if (/\.m3u8$/i.test(path) || /mpegurl/i.test(type)) return 'HLS';
    if (/\.mpd$/i.test(path) || /dash\+xml/i.test(type)) return 'DASH';
    // CMAF initialization/segment files are not complete videos, even when named .mp4.
    if (/(?:^|[\/_.-])(?:init|segment|seg|chunk|frag)(?:[\/_.-]|\d)/i.test(path)) return null;
    if (/\.(?:mp4|webm|mov|mkv|m4v)$/i.test(path) || /^video\/(?:mp4|webm|quicktime)$/.test(type)) return 'VIDEO';
    if (TS_NAME.test(path) || type === 'video/mp2t') return size >= TS_MIN ? 'OTHER' : null;
    if (/\.(?:flv|avi|wmv|3gp|ogv|mpg|mpeg|asf)$/i.test(path) || /^video\//.test(type)) return 'OTHER';
    if (/\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i.test(path) || /^audio\//.test(type)) return size >= AUDIO_MIN ? 'AUDIO' : null;
    return null;
  }
  const isFileKind = kind => kind === 'VIDEO' || kind === 'OTHER' || kind === 'AUDIO';
  // A name or type that looks like one HLS piece, in a frame that also loaded a stream list: not a video of its own.
  const segmentLike = (entry, entries) => entry.kind === 'OTHER' && (TS_NAME.test(httpUrl(entry.url)?.pathname || '') || /mp2t/i.test(entry.mime || '')) &&
    (entries || []).some(other => (other.frameId || 0) === (entry.frameId || 0) && STREAM_KINDS.includes(other.kind));
  const extensionOf = entry => {
    const named = /\.([a-z0-9]{2,5})$/i.exec(httpUrl(entry.url)?.pathname || '')?.[1]?.toLowerCase();
    if (named) return named;
    const sub = String(entry.mime || '').split('/')[1] || '';
    return ({ mp2t: 'ts', 'x-flv': 'flv', 'x-msvideo': 'avi', 'x-ms-wmv': 'wmv', quicktime: 'mov', mpeg: entry.kind === 'AUDIO' ? 'mp3' : 'mpg', ogg: entry.kind === 'AUDIO' ? 'ogg' : 'ogv' })[sub] || sub.replace(/^x-/, '') || 'dosya';
  };
  // Lower is shown higher: MP4 first, other common containers next, odd containers and sound last.
  const fileRank = entry => entry.kind === 'AUDIO' ? 3 : /^(?:mp4|m4v)$/.test(extensionOf(entry)) ? 0 : /^(?:webm|mkv|mov)$/.test(extensionOf(entry)) ? 1 : 2;
  // Other stream lists the page loaded (HLS/DASH). A site without a master list serves each quality as its own playlist, so these
  // are the other qualities of the same video. At most `limit`, newest first, never the one already inspected.
  function streamSources(entries, skipUrl = null, limit = 3) {
    const seen = new Set(), found = [];
    for (const entry of entries || []) {
      if (!STREAM_KINDS.includes(entry.kind) || entry.drmSuspected || entry.url === skipUrl || !httpUrl(entry.url)) continue;
      const identity = entry.identity || entry.url; if (seen.has(identity)) continue; seen.add(identity);
      found.push({ url: entry.url, kind: entry.kind, entry });
      if (found.length >= limit) break;
    }
    return found;
  }
  // Every complete file the page loaded, besides the one already inspected, as ready-to-download rows.
  function fileSources(entries, tabUrl, skipUrl = null, limit = 8) {
    const seen = new Set(), counts = new Map(), rows = [];
    for (const entry of entries || []) {
      if (!isFileKind(entry.kind) || entry.drmSuspected || entry.rangeLimited || entry.playerBlob || entry.url === skipUrl || !httpUrl(entry.url)) continue;
      if (segmentLike(entry, entries)) continue;
      const identity = entry.identity || entry.url; if (seen.has(identity)) continue; seen.add(identity);
      rows.push({ entry, rank: fileRank(entry), ext: extensionOf(entry) });
    }
    rows.sort((a, b) => a.rank - b.rank || (b.entry.size || 0) - (a.entry.size || 0));
    return rows.slice(0, limit).map(({ entry, rank, ext }, index) => {
      const n = (counts.get(ext) || 0) + 1; counts.set(ext, n);
      const noun = entry.kind === 'AUDIO' ? T('x.audio-file') : T('x.file');
      return { id: `file:${index}`, url: entry.url, kind: entry.kind, rank, ext, size: entry.size || null, referer: entry.frameUrl || tabUrl, label: `${ext.toUpperCase()} ${noun}${n > 1 ? ` (${n})` : ''}` };
    });
  }
  function rangeLimited(raw) {
    const url = httpUrl(raw); if (!url) return true;
    return [...url.searchParams.keys()].some(key => /^(?:bytes|range|bytestart|byteend|startbyte|endbyte)$/i.test(key)) || /\/range\/\d+-\d+/i.test(url.pathname);
  }
  function sourceFor(entry, entries, pageUrl) {
    if (entry.rangeLimited || (entry.kind === 'VIDEO' && entry.playerBlob)) {
      const manifests = entries.filter(other => other.frameId === entry.frameId && ['HLS', 'DASH'].includes(other.kind));
      // Several manifests can belong to an ad and the episode in the same frame. Never guess.
      return manifests.length === 1 ? { url: manifests[0].url, kind: manifests[0].kind, entry: manifests[0] } : { url: pageUrl, kind: 'PAGE', entry, ambiguous: manifests.length > 1 };
    }
    return { url: entry.url, kind: entry.kind, entry };
  }
  // One card per video. Evidence-based only: same frame, same host, same folder, same kind (manifest vs file).
  // A master/manifest is preferred over its variant playlists; size or name similarity alone never merges anything.
  const MASTER = /(?:^|[\/_.-])(?:master|manifest|playlist|main)(?:[\/_.-]|$)|\.mpd$/i;
  // A name that carries one rendition's height/bitrate/track (e.g. playlist_v-0576p-1400k…, playlist_a-eng-0128k…) is a variant,
  // even when it also says "playlist": browsers that play HLS themselves (Chrome, Brave) fetch those right after the master.
  const VARIANT = /(?:^|[\/_.-])(?:index-f\d|chunklist|media[_-]?\d|variant|stream[_-]?\d|playlist[_-]\d)|[\/_.-]\d{3,4}p(?:[\/_.-]|$)|[\/_.-]\d{2,5}k(?:[\/_.-]|$)|[_-][av]-/i;
  function groupEntries(entries) {
    const groups = new Map();
    for (const entry of entries || []) {
      const url = httpUrl(entry.url); if (!url) continue;
      const stream = entry.kind === 'HLS' || entry.kind === 'DASH';
      const key = [entry.frameId || 0, url.host, url.pathname.replace(/\/[^/]*$/, ''), stream ? 'stream' : 'file'].join('|');
      if (!groups.has(key)) groups.set(key, { key, stream, entries: [] });
      groups.get(key).entries.push(entry);
    }
    return [...groups.values()].map(group => {
      const list = group.entries; // newest first
      const name = entry => httpUrl(entry.url).pathname;
      // Players load the master first, so among non-variant names the earliest captured one is the master.
      const plain = list.filter(entry => !VARIANT.test(name(entry)));
      const earliest = plain.reduce((best, entry) => best && (best.detectedAt || 0) <= (entry.detectedAt || 0) ? best : entry, null);
      const primary = group.stream
        ? plain.find(entry => MASTER.test(name(entry))) || earliest || list[0]
        : [...list].sort((a, b) => fileRank(a) - fileRank(b) || (b.size || 0) - (a.size || 0))[0];
      return { ...group, primary, files: group.stream ? [] : list, variantCount: group.stream ? list.length - 1 : list.length };
    });
  }
  // A length of time as a clock (2:05, 1:02:05): the same in every language.
  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    seconds = Math.ceil(seconds);
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), two = n => String(n).padStart(2, '0');
    return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
  }
  const locale = () => globalThis.HypernabText?.language?.() || 'en'; // numbers follow the language of the extension
  const bytes = n => {
    if (!(Number.isFinite(n) && n >= 0)) return T('app.size.unknown');
    const unit = (value, name) => `${value.toLocaleString(locale(), { maximumFractionDigits: 1 })} ${name}`;
    return n < 1024 ? `${n} B` : n < 1048576 ? unit(n / 1024, 'KB') : n < 1073741824 ? unit(n / 1048576, 'MB') : unit(n / 1073741824, 'GB');
  };
  // An approximate size is shown with a leading "~" in every language.
  const size = option => option.filesize > 0 ? (option.sizeKind === 'exact' ? bytes(option.filesize) : `~${bytes(option.filesize)}`) : T('app.size.unknown');
  class Client {
    constructor({ token = '', fetcher = (url, options) => globalThis.fetch(url, options), origin = API, native = null } = {}) { this.token = token; this.fetcher = fetcher; this.origin = origin; this.native = native; }
    async ready(userAction = false) {
      let info;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { info = await this.request('/api/status'); break; }
        catch (error) {
          if (attempt === 0 && this.native && (this.native.closed || error.code === 'NATIVE_DISCONNECTED')) {
            this.native = new globalThis.HypernabNativeChannel(globalThis.browser?.runtime || globalThis.chrome?.runtime); continue;
          }
          if (userAction && this.native && error.code === 'APP_OFFLINE') {
            if (!this.starting) this.starting = this.native.request({ action: 'launch' }).finally(() => { this.starting = null; });
            info = (await this.starting).status; break;
          }
          throw error;
        }
      }
      if (!info?.extensionProtocol) throw Object.assign(new Error(T('x.use-the-current-hypernab-app-with')), { code: 'APP_TOO_OLD' });
      this.instanceId = info.instanceId || null;
      return info;
    }
    async request(route, options = {}) {
      if (!/^\/api\/(?:status|prefs|jobs(?:\/[a-f0-9-]+\/(?:pause|resume|cancel|retry))?|inspect|sniff|subtitles|duplicates|files\/take|hls\/active-audio|submissions\/[a-f0-9-]+(?:\/abandon)?|app\/shutdown)$/.test(route)) throw new Error(T('x.invalid-app-command'));
      if (this.native) return this.native.request({ action: 'request', route, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) });
      if (!this.token) throw new Error(T('x.first-pair-with-the-key-of'));
      let response;
      try {
        response = await this.fetcher(`${this.origin}${route}`, { ...options, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(route === '/api/inspect' ? 65000 : 10000) });
      } catch (error) { throw Object.assign(new Error(error.name === 'TimeoutError' ? T('x.the-connection-timed-out-the-result') : T('x.could-not-connect-to-hypernab-check')), { code: error.name === 'TimeoutError' ? 'APP_TIMEOUT' : 'APP_OFFLINE' }); }
      let data;
      try { data = await response.json(); } catch { throw new Error(T('x.the-local-app-did-not-give')); }
      if (!response.ok) {
        const error = new Error(response.status === 401 ? T('x.the-pairing-key-is-invalid-copy') : data.error || T('x.request-failed'));
        error.status = response.status; error.code = data.code || (response.status === 401 ? 'APP_AUTH' : 'APP_ERROR'); throw error;
      }
      return data;
    }
  }
  const optionIdentity = option => JSON.stringify(['height', 'fps', 'hdr', 'codec', 'ext', 'audio'].map(key => option?.[key] ?? null));
  const transientError = error => ['APP_OFFLINE', 'APP_TIMEOUT', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT', 'BUSY'].includes(error?.code) || error?.status === 429;
  async function reselect(client, source, oldInfo, chosen, api, storeId) {
    const cookies = await sessionCookies(api, [source.url, source.pageUrl], storeId);
    const info = await client.request('/api/inspect', { method: 'POST', body: JSON.stringify(cookies.length ? { ...source, cookies } : source) });
    const old = oldInfo?.options?.find(option => option.id === chosen);
    const match = old && info.options?.find(option => optionIdentity(option) === optionIdentity(old));
    if ((old && !match) || (!old && info.options?.length)) {
      throw Object.assign(new Error(T('x.the-quality-you-chose-is-no')), { code: 'QUALITY_CHANGED', info, input: { ...source, noBrowser: undefined, ...(info.resolved || {}), title: info.title } });
    }
    return { info, input: { ...source, noBrowser: undefined, ...(info.resolved || {}), title: info.title }, chosen: match?.id || null };
  }
  // Called ONLY when the user presses "İncele" for one video. `cookies.getAll({ url })` returns exactly the cookies the browser
  // would send to that address, so nothing from unrelated sites is read. Values are never stored by the extension.
  async function sessionCookies(api, urls, storeId) {
    if (!api?.cookies?.getAll) return [];
    const found = new Map();
    for (const raw of urls) {
      const url = httpUrl(raw); if (!url) continue;
      let list = [];
      try { list = await api.cookies.getAll({ url: url.href, ...(storeId ? { storeId } : {}) }); } catch { /* permission or store unavailable */ }
      for (const cookie of list || []) {
        if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
        found.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure === true, hostOnly: cookie.hostOnly === true, expires: Number.isFinite(cookie.expirationDate) ? cookie.expirationDate : null });
      }
    }
    return [...found.values()].slice(0, 80);
  }
  // ---- Subtitles: ask every frame of the tab for its player's tracks (only when the user pressed a download button), add the subtitle
  // files the page loaded, and give the answer back as a payload piece. Nothing here depends on a site.
  async function gatherSubtitles(api, tabId, waitMs = 2600) {
    const empty = { tracks: [], urls: [] };
    try {
      const serial = Date.now(), context = (await api.storage.session.get(`context:${tabId}`))[`context:${tabId}`];
      // Frames that reported a player answer; a page without any player is not waited for.
      const expected = Object.values(context?.frames || {}).filter(frame => frame.mediaUrl || frame.playerBlob || frame.duration).length;
      let frames = [];
      if (expected) try { Promise.resolve(api.tabs.sendMessage(tabId, { type: 'hypernab:collect-subtitles', serial })).catch(() => {}); } catch { /* tab gone */ }
      for (const started = Date.now(); expected && Date.now() - started < waitMs;) {
        await new Promise(resolve => setTimeout(resolve, 150));
        frames = Object.values((await api.storage.session.get(`subs:${tabId}`))[`subs:${tabId}`] || {}).filter(frame => frame.serial === serial);
        if (frames.length >= expected) break;
      }
      const net = (await api.storage.session.get(`subs-net:${tabId}`))[`subs-net:${tabId}`] || [];
      const tracks = frames.flatMap(frame => frame.tracks).slice(0, 12);
      const urls = [], seen = new Set();
      for (const item of [...frames.flatMap(frame => frame.urls), ...net.map(entry => ({ url: entry.url, sure: entry.sure }))]) {
        if (!item.url || seen.has(item.url) || urls.length >= 10) continue; seen.add(item.url);
        urls.push({ url: item.url, ...(item.lang ? { lang: item.lang } : {}), ...(item.label ? { label: item.label } : {}), ...(item.default ? { default: true } : {}), sure: item.sure !== false });
      }
      return { tracks, urls };
    } catch { return empty; }
  }
  // Sends the tracks read from the page's player in small pieces (one native/HTTP message is limited to 32 KB). Returns the upload id.
  async function uploadSubtitles(client, tracks) {
    if (!tracks.length) return null;
    const uploadId = globalThis.crypto.randomUUID();
    for (const [track, item] of tracks.entries()) {
      const pieces = []; for (let at = 0; at < item.vtt.length; at += 9000) pieces.push(item.vtt.slice(at, at + 9000));
      for (const [seq, chunk] of pieces.entries()) await client.request('/api/subtitles', { method: 'POST', body: JSON.stringify({ uploadId, track, seq, count: pieces.length, chunk, lang: item.lang, label: item.label, default: item.default }) });
    }
    return uploadId;
  }
  // The whole subtitle part of a download request; a failure here must never stop the video itself.
  async function subtitlePayload(api, client, tabId) {
    try {
      const { tracks, urls } = await gatherSubtitles(api, tabId);
      const subtitleUpload = await uploadSubtitles(client, tracks).catch(() => null);
      return { ...(subtitleUpload ? { subtitleUpload } : {}), ...(urls.length ? { subtitleUrls: urls } : {}) };
    } catch { return {}; }
  }
  // Which sound is pre-selected, and why (the panel says so). Sound never follows the subtitle language: someone may watch the original
  // sound with subtitles of their own language. Order: what the player is playing now; then the user's sound preference ('original' or
  // a language code), only when exactly one sound matches; then the site's own default; then the first. A preference that matches
  // nothing (or several sounds) is not guessed: the site default stays and the panel shows that it is the site's choice.
  function pickSound(tracks, activeId, preference = 'player') {
    if (!Array.isArray(tracks) || tracks.length < 2) return null;
    const active = tracks.find(track => track.id === activeId);
    if (active) return { id: active.id, why: 'playing' };
    const base = value => String(value || '').toLowerCase().replace(/_/g, '-').split('-')[0];
    const matches = preference === 'original' ? tracks.filter(track => /\b(original|orijinal|orig)\b/i.test(String(track.name || '')))
      : /^[a-z]{2,3}$/.test(preference || '') ? tracks.filter(track => base(track.language) === preference) : [];
    if (matches.length === 1) return { id: matches[0].id, why: 'preference' };
    const site = tracks.find(track => track.default);
    return site ? { id: site.id, why: 'site-default' } : { id: tracks[0].id, why: 'first' };
  }
  globalThis.Hypernab = { pickSound, API, subtitlePayload, gatherSubtitles, httpUrl, mediaKind, isFileKind, fileRank, segmentLike, fileSources, streamSources, rangeLimited, sourceFor, groupEntries, bytes, duration, size, sessionCookies, optionIdentity, transientError, reselect, Client };
})();
