// Shared by Firefox event pages, Chromium service workers and both popup builds.
(() => {
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
      const noun = entry.kind === 'AUDIO' ? 'ses dosyası' : 'dosyası';
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
  const bytes = n => Number.isFinite(n) && n >= 0 ? n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} KB` : n < 1073741824 ? `${(n / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB` : `${(n / 1073741824).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} GB` : 'Boyut bilinmiyor';
  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'hesaplanamıyor';
    seconds = Math.ceil(seconds);
    return seconds < 60 ? `${seconds} sn` : seconds < 3600 ? `${Math.floor(seconds / 60)} dk ${seconds % 60} sn` : `${Math.floor(seconds / 3600)} sa ${Math.floor(seconds % 3600 / 60)} dk`;
  }
  const size = option => option.filesize > 0 ? `${option.sizeKind === 'exact' ? '' : 'Yaklaşık '}${bytes(option.filesize)}` : 'Boyut bilinmiyor';
  const phases = { queued: 'Başlatılıyor', held: 'Sırada', resolving: 'Kaynak hazırlanıyor', probing: 'Kaynak kontrol ediliyor', downloading: 'İndiriliyor', running: 'Çalışıyor',
    'checking-resume': 'Önceki parçalar karşılaştırılıyor', 'waiting-connection': 'Bağlantı bekleniyor', pausing: 'Duraklatılıyor', paused: 'Duraklatıldı',
    'waiting-resume': 'Devam için bekliyor', merging: 'Ses ve görüntü birleştiriliyor', processing: 'Son işlem yapılıyor', verifying: 'Dosya doğrulanıyor',
    'deep-verifying': 'Derin hata taraması', publishing: 'Dosya kaydediliyor', disconnected: 'Son kayıt; bağlantı bekleniyor', completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi', interrupted: 'Kesintiye uğradı' };
  function jobView(job) {
    const p = job.progress || { phase: job.status, received: job.received, total: job.total, speed: 0, etaSeconds: null };
    const facts = [`${bytes(p.received || 0)} / ${p.total > 0 ? `${p.sizeKind === 'approx' ? 'Yaklaşık ' : ''}${bytes(p.total)}` : 'Boyut bilinmiyor'}`];
    if (job.status === 'running' && p.phase === 'downloading') {
      facts.push(`${bytes(p.speed || 0)}/sn`);
      facts.push(p.etaSeconds !== null && Number.isFinite(p.etaSeconds) ? `Yaklaşık ${duration(p.etaSeconds)} kaldı` : 'Kalan süre hesaplanamıyor');
    }
    return { stage: phases[p.phase] || phases[job.status] || 'Durum bilinmiyor', facts: facts.join(' · ') };
  }
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
      if (!info?.extensionProtocol) throw new Error('Eklenti için güncel Hypernab uygulamasını kullan. İndirmeler tamamlanınca uygulamayı güncelle.');
      this.instanceId = info.instanceId || null;
      return info;
    }
    async request(route, options = {}) {
      if (!/^\/api\/(?:status|jobs(?:\/[a-f0-9-]+\/(?:pause|resume|cancel|retry))?|inspect|sniff|subtitles|duplicates|files\/take|hls\/active-audio|submissions\/[a-f0-9-]+(?:\/abandon)?|app\/shutdown)$/.test(route)) throw new Error('Geçersiz uygulama komutu.');
      if (this.native) return this.native.request({ action: 'request', route, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) });
      if (!this.token) throw new Error('Önce yerel uygulamanın anahtarıyla eşleştir.');
      let response;
      try {
        response = await this.fetcher(`${this.origin}${route}`, { ...options, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(route === '/api/inspect' ? 65000 : 10000) });
      } catch (error) { throw Object.assign(new Error(error.name === 'TimeoutError' ? 'Bağlantı zaman aşımına uğradı. Gönderimin sonucu kontrol ediliyor.' : 'Hypernab ile bağlantı kurulamadı. Uygulamanın kurulu olduğunu ve tarayıcı bağlantısını kontrol et.'), { code: error.name === 'TimeoutError' ? 'APP_TIMEOUT' : 'APP_OFFLINE' }); }
      let data;
      try { data = await response.json(); } catch { throw new Error('Yerel uygulama geçerli bir yanıt vermedi.'); }
      if (!response.ok) {
        const error = new Error(response.status === 401 ? 'Eşleştirme anahtarı geçersiz. Uygulamadan yeniden kopyalayıp bağlan.' : data.error || 'İstek başarısız.');
        error.status = response.status; error.code = data.code || (response.status === 401 ? 'APP_AUTH' : 'APP_ERROR'); throw error;
      }
      return data;
    }
  }
  const optionIdentity = option => JSON.stringify(['height', 'fps', 'hdr', 'codec', 'ext', 'audio'].map(key => option?.[key] ?? null));
  const transientError = error => ['APP_OFFLINE', 'APP_TIMEOUT', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT', 'BUSY'].includes(error?.code) || error?.status === 429 || /zaman aşım|time.?out|bağlantı|zaten çalışıyor/i.test(error?.message || '');
  async function reselect(client, source, oldInfo, chosen, api, storeId) {
    const cookies = await sessionCookies(api, [source.url, source.pageUrl], storeId);
    const info = await client.request('/api/inspect', { method: 'POST', body: JSON.stringify(cookies.length ? { ...source, cookies } : source) });
    const old = oldInfo?.options?.find(option => option.id === chosen);
    const match = old && info.options?.find(option => optionIdentity(option) === optionIdentity(old));
    if ((old && !match) || (!old && info.options?.length)) {
      throw Object.assign(new Error('Seçtiğin kalite artık sunulmuyor. Güncel listeden bir kalite seç; başka kalite otomatik indirilmedi.'), { code: 'QUALITY_CHANGED', info, input: { ...source, noBrowser: undefined, ...(info.resolved || {}), title: info.title } });
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
  globalThis.Hypernab = { API, subtitlePayload, gatherSubtitles, httpUrl, mediaKind, isFileKind, fileRank, segmentLike, fileSources, streamSources, rangeLimited, sourceFor, groupEntries, bytes, duration, size, jobView, sessionCookies, optionIdentity, transientError, reselect, Client };
})();
