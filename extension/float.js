// Backend of the on-page floating download panel. Loaded after core.js by the background.
// The content script only draws the panel; everything that needs the app's key, browser cookies or the network goes through here.
// Cookies are read only when the user has acted (pressed the on-page button) and only for the chosen video's own address;
// they travel with the inspection request and are never stored. A first automatic look-up runs WITHOUT cookies.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const H = globalThis.Hypernab;
  if (!api?.runtime?.onMessage || !H) return;
  const CACHE_OK_MS = 900000, CACHE_FAIL_MS = 120000;
  const inflight = new Map(); // `${tabId}|${cookies}` -> Promise, so a prefetch and the click share one look-up
  let nativeChannel;
  const starts = new Map();
  const inspectionVersion = new Map();

  async function cacheRead(url, instanceId, withCookies, cookieStoreId, sourceKind) {
    try { const key = `inspect:${url}`, hit = (await api.storage.session.get(key))[key]; return hit && hit.sourceKind === sourceKind && hit.instanceId === instanceId && hit.withCookies === withCookies && hit.cookieStoreId === cookieStoreId && Date.now() - hit.at < (hit.value?.info?.inspectionPending ? 700 : hit.error ? CACHE_FAIL_MS : CACHE_OK_MS) ? hit : null; } catch { return null; }
  }
  async function cacheWrite(url, value) { try { await api.storage.session.set({ [`inspect:${url}`]: { at: Date.now(), ...value } }); } catch { /* cache is optional */ } }

  // Which sources of this tab are worth offering: captured streams/files first, the page itself (resolved by yt-dlp) last.
  function candidates(tab, stored) {
    const entries = stored[`tab:${tab.id}`] || [];
    const frames = Object.values(stored[`context:${tab.id}`]?.frames || {});
    const drm = frames.some(frame => frame.drm) || entries.some(entry => entry.drmSuspected);
    const pageUrl = H.httpUrl(tab.url) && !tab.url.startsWith(H.API) ? tab.url : null;
    const found = [], seen = new Set();
    // An exact player URL is stronger evidence than speculative sniffing (often telemetry). Preserve the signed URL unchanged.
    const playingFile = item => H.isFileKind(item.kind) && !item.entry?.rangeLimited && !item.entry?.playerBlob &&
      frames.some(frame => frame.mediaUrl === item.url && frame.height > 0);
    const rank = item => playingFile(item) ? -1 : item.kind === 'HLS' || item.kind === 'DASH' ? 0
      : item.kind === 'UNKNOWN' && item.entry?.kind === 'VIDEO' && item.entry.playerBlob ? 0.5
        : H.isFileKind(item.kind) ? 1 + H.fileRank(item.entry) / 10 : item.kind === 'UNKNOWN' ? 2 : 3;
    const add = item => { if (item.url && !seen.has(item.url)) { seen.add(item.url); found.push(item); } };
    for (const group of H.groupEntries(entries)) {
      // Keep the master choice for streams, but do not let an untyped file in the same folder hide known media.
      for (const entry of group.stream ? [group.primary] : group.entries) {
        if (entry.drmSuspected || H.segmentLike(entry, entries)) continue;
        if (entry.kind === 'UNKNOWN' && entry.size > 0 && entry.size < 16) continue; // cannot contain even a minimal HLS list
        // Some players label a playlist as video/mp4 and expose only a blob URL. Sniff before treating it as a file.
        if (entry.kind === 'VIDEO' && entry.playerBlob && !entry.rangeLimited) add({ url: entry.url, kind: 'UNKNOWN', entry });
        const source = H.sourceFor(entry, entries, tab.url);
        if (source.kind !== 'PAGE') add({ url: source.url, kind: source.kind, entry: source.entry });
      }
    }
    const hasPlayer = frames.some(frame => frame.playerBlob || frame.mediaUrl || frame.duration > 0);
    if (pageUrl && (hasPlayer || entries.length)) add({ url: pageUrl, kind: 'PAGE', entry: { kind: 'PAGE', frameUrl: pageUrl } });
    const list = found.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
    const limited = list.slice(0, 4);
    // A busy player may produce dozens of untyped requests. Keep the page resolver in the bounded budget;
    // otherwise four failed sniff candidates can prevent it from ever being tried.
    const page = list.find(item => item.kind === 'PAGE');
    if (page && !limited.includes(page)) limited[limited.length - 1] = page;
    return { drm, list: limited, entries };
  }

  async function connection(userAction = false) {
    const stored = await api.storage.local.get(['token', 'transport']);
    if (stored.transport === 'native' || (!stored.token && globalThis.HypernabNativeChannel)) {
      if (!nativeChannel || nativeChannel.closed) nativeChannel = new globalThis.HypernabNativeChannel(api.runtime);
      const client = new H.Client({ native: nativeChannel });
      await client.ready(userAction); nativeChannel = client.native;
      return client;
    }
    if (!stored.token) throw new Error(stored.transport === 'native' ? 'Native Messaging bağlantısı için eklenti simgesindeki pencereyi aç.' : 'Önce eklenti simgesine tıklayıp Hypernab anahtarıyla bağlan.');
    const client = new H.Client({ token: stored.token }); await client.ready(false); return client;
  }

  const timings = []; // last look-ups with their duration, for the diagnostic report (addresses are reduced to their shape)
  const redact = raw => { try { const url = new URL(raw); return url.origin + url.pathname.split('/').map(part => part.length > 20 ? `${part.slice(0, 5)}…(${part.length})` : part).join('/'); } catch { return '?'; } };
  async function inspectOne(client, tab, source, withCookies) {
    const started = Date.now();
    try { const value = await inspectOneRaw(client, tab, source, withCookies); timings.push({ kind: source.kind, url: redact(source.url), ms: Date.now() - started, ok: true, options: value.info?.options?.length || 0, silent: value.info?.silentStream === true, audioOnly: value.info?.audioOnly === true }); return value; }
    catch (error) { timings.push({ kind: source.kind, url: redact(source.url), ms: Date.now() - started, ok: false, error: String(error.message).slice(0, 160) }); throw error; }
    finally { while (timings.length > 25) timings.shift(); }
  }
  async function inspectOneRaw(client, tab, source, withCookies) {
    const hit = await cacheRead(source.url, client.instanceId, withCookies, tab.cookieStoreId, source.kind);
    if (hit?.error && !withCookies) throw new Error(hit.error);
    if (hit?.value) return hit.value;
    const input = { url: source.url, engine: H.isFileKind(source.kind) ? 'direct' : 'extractor', referer: source.entry?.frameUrl || tab.url, pageUrl: tab.url, userAgent: globalThis.navigator?.userAgent, noBrowser: true };
    if (source.kind === 'HLS') input.mediaKind = 'HLS';
    if (source.kind !== 'PAGE' && tab.title) input.title = tab.title;
    const cookies = withCookies ? await H.sessionCookies(api, [source.url, input.pageUrl], tab.cookieStoreId) : [];
    let info;
    try { info = await client.request(source.kind === 'UNKNOWN' ? '/api/sniff' : '/api/inspect', { method: 'POST', body: JSON.stringify(cookies.length ? { ...input, cookies } : input) }); }
    catch (error) { if (!withCookies && !H.transientError(error)) await cacheWrite(source.url, { error: error.message, sourceKind: source.kind, instanceId: client.instanceId, withCookies, cookieStoreId: tab.cookieStoreId }); throw error; }
    const value = { input: { ...input, noBrowser: undefined, ...(info.resolved || {}), title: info.title }, sourceInput: input, info, withCookies, instanceId: client.instanceId };
    await cacheWrite(source.url, { value: JSON.parse(JSON.stringify(value)), sourceKind: source.kind, instanceId: client.instanceId, withCookies, cookieStoreId: tab.cookieStoreId });
    if (info.inspectionPending) setTimeout(() => { try { Promise.resolve(api.tabs.sendMessage(tab.id, { type: 'hypernab:refresh' })).catch(() => {}); } catch { /* closed tab */ } }, 1000);
    return value;
  }

  // Other qualities of the same video, found as separate playlists (sites without a master list). Cached answers are used at once;
  // missing ones are looked up in the background, once per page, and the page is told to look again when they are in.
  const altState = new Set();
  async function resolveAlts(client, tab, withCookies, sources) {
    const found = [], started = [];
    for (const [index, source] of sources.entries()) {
      const hit = await cacheRead(source.url, client.instanceId, withCookies, tab.cookieStoreId, source.kind);
      if (hit?.value) { if (hit.value.info?.options?.length || hit.value.info?.audioOnly) found.push({ ...hit.value, index }); continue; }
      const key = `${tab.id}|${tab.url}|${source.url}|${withCookies}`;
      if (hit?.error || altState.has(key)) continue;
      altState.add(key);
      started.push(inspectOne(client, tab, source, withCookies).then(value => { if (value.info?.inspectionPending) altState.delete(key); return value; }).catch(() => null));
    }
    if (started.length) Promise.all(started).then(() => { try { Promise.resolve(api.tabs.sendMessage(tab.id, { type: 'hypernab:refresh' })).catch(() => {}); } catch { /* tab gone */ } });
    return found;
  }

  async function inspectTab(tab, withCookies) {
    const scope = `${tab.id}|${tab.url}`, version = (inspectionVersion.get(scope) || 0) + 1;
    inspectionVersion.set(scope, version);
    const stored = await api.storage.session.get([`tab:${tab.id}`, `context:${tab.id}`]);
    const { drm, list, entries } = candidates(tab, stored);
    // The picture height the page's own player is showing right now (the quality the user picked there).
    const playing = Math.max(0, ...Object.values(stored[`context:${tab.id}`]?.frames || {}).map(frame => Number(frame.height) || 0));
    if (drm) return { ok: false, code: 'drm', error: 'Bu oynatıcıda DRM algılandı. DRM korumalı videolar desteklenmez.' };
    if (!list.length) return { ok: false, code: 'none', error: 'Bu sayfada henüz indirilebilir bir video kaynağı yakalanmadı. Videoyu birkaç saniye oynatıp tekrar dene.' };
    let client;
    try { client = await connection(withCookies); }
    catch (error) { return { ok: false, code: withCookies ? 'failed' : 'needs-session', error: error.message }; }
    let firstError = null, pageError = null;
    for (const source of list) {
      try {
        const held = await inspectOne(client, tab, source, withCookies);
        const { input, info } = held;
        // Other complete files this page loaded (the MP4 next to an HLS list, flv/avi/ts...) become extra rows under the qualities.
        const files = H.fileSources(entries, tab.url, source.kind === 'PAGE' ? null : source.url);
        // No master list (at most one quality known): the page's other playlists are the other qualities.
        const alts = (info.options || []).length <= 1 ? await resolveAlts(client, tab, withCookies, H.streamSources(entries, source.kind === 'PAGE' ? null : source.url)) : [];
        if (inspectionVersion.get(scope) === version) await api.storage.session.set({ [`float:${tab.id}`]: { ...held, files, alts, playing, companionAudio: (alts.find(alt => alt.info?.audioOnly)?.sourceInput?.url) || null, pageUrl: tab.url, optionIds: (info.options || []).map(option => option.id), hasOptions: Boolean(info.options?.length) } });
        return present(info, files, alts, playing);
      } catch (error) { firstError ||= error; if (source.kind === 'PAGE') pageError = error; }
    }
    // A failed speculative HLS sniff is not the diagnosis of the whole video. Prefer the page's actionable reason.
    return { ok: false, code: withCookies ? 'failed' : 'needs-session', error: pageError?.message || firstError?.message || 'Video bilgisi alınamadı.' };
  }
  // Own qualities first; qualities of the page's other playlists join them (same label = same quality, shown once), best picture first.
  function mergedOptions(info, alts) {
    const view = (option, id) => ({ id, label: option.label, size: H.size(option).replace(/^Yaklaşık /, '~'), recommended: option.recommended !== false, audio: option.audio, fps: option.fps, hdr: option.hdr, height: option.height || 0 });
    const options = (info.options || []).map(option => view(option, option.id)), seen = new Set(options.map(option => option.label));
    let added = false;
    for (const alt of alts || []) for (const option of alt.info?.options || []) {
      if (option.recommended === false || seen.has(option.label)) continue;
      seen.add(option.label); added = true; options.push(view(option, `alt:${alt.index}:${option.id}`));
    }
    return added ? options.sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0)) : options;
  }
  function present(info, files = [], alts = [], playing = 0) {
    const options = mergedOptions(info, alts);
    const best = Math.max(0, ...options.map(option => option.height || 0));
    return {
          ok: true,
          // Complete files seen on the page. rank 0-1 (MP4, webm/mkv/mov) are shown with the qualities, the rest under "other sources".
          files: files.map(file => ({ id: file.id, label: file.label, size: file.size > 0 ? H.bytes(file.size) : 'Boyut bilinmiyor', main: file.rank <= 1 })), title: info.title, duration: info.duration > 0 ? H.duration(info.duration) : null, sessionUsed: info.sessionUsed === true,
           options,
          defaultOptionId: options.length > (info.options || []).length ? options[0].id : info.defaultOptionId || null,
          // A picture without sound whose sound is a separate playlist: say what will happen, or that the sound is still missing.
          alert: info.silentStream && !(alts || []).some(alt => alt.info?.audioOnly) ? 'Bu akışta ses yok. Sayfa ses akışını henüz yüklemedi; videoyu oynatıp biraz sonra paneli yenile.'
            : playing > 0 && best > 0 && best + 60 < playing ? `Oynatıcı şu an ${playing}p oynatıyor ama bu kalite henüz yakalanmadı. Birkaç saniye bekleyip paneli yeniden aç.` : null,
          fileNote: info.options?.length ? null : [info.extension ? info.extension.toUpperCase() : null, info.filesize > 0 ? `${info.estimatedSize ? '~' : ''}${H.bytes(info.filesize)}` : 'Boyut bilinmiyor'].filter(Boolean).join(' · '),
          qualityNote: info.qualityNote || null,
          warning: [info.warning, info.silentStream && (alts || []).some(alt => alt.info?.audioOnly) ? 'Ses ayrı akıştan eklenir.' : null].filter(Boolean).join(' ') || null
        };
  }

  // A complete file the page loaded (not part of the inspected stream): plain direct download, no quality choice involved.
  // The submission id makes a lost reply or a double click create one job only.
  // The same source in the same quality may already be in the app. Ask once; a failed check never blocks a download.
  async function duplicatesOf(client, payload) {
    try { return (await client.request('/api/duplicates', { method: 'POST', body: JSON.stringify({ url: payload.url, formatId: payload.formatId }) })).duplicates || []; }
    catch { return []; }
  }
  const duplicateAnswer = duplicates => ({ ok: false, code: 'duplicate', duplicates: duplicates.map(item => ({ title: String(item.title || '').slice(0, 120), status: item.status, formatLabel: item.formatLabel || null })), error: 'Bu video aynı kalitede zaten listede.' });
  async function startFile(tab, held, optionId, mode, intentId, allowDuplicate = false) {
    const file = (held.files || []).find(item => item.id === optionId);
    if (!file) return { ok: false, error: 'Liste güncellendi. Güncel listeden bir kaynak seç.', refresh: present(held.info, held.files, held.alts, held.playing) };
    const payload = { url: file.url, engine: 'direct', referer: file.referer || tab.url, pageUrl: tab.url, userAgent: globalThis.navigator?.userAgent, quality: 'best', start: mode === 'queue' ? 'queue' : 'now', submissionId: intentId || globalThis.crypto.randomUUID() };
    if (tab.title) payload.title = tab.title;
    try {
      let client = await connection(true);
      if (!allowDuplicate) { const found = await duplicatesOf(client, payload); if (found.length) return duplicateAnswer(found); }
      Object.assign(payload, await H.subtitlePayload(api, client, tab.id)); // the page's subtitles travel with the file; never required
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await client.request('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
          if (typeof result.id !== 'string') throw new Error('Gönderim yanıtı doğrulanamadı.');
          return { ok: true, queued: payload.start === 'queue' };
        } catch (error) {
          if (attempt || !['APP_OFFLINE', 'APP_TIMEOUT', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT'].includes(error.code)) throw error;
          client = await connection(true);
          if ((await client.request(`/api/submissions/${payload.submissionId}`)).known) return { ok: true, queued: payload.start === 'queue' };
        }
      }
    } catch (error) { return { ok: false, error: error.message }; }
  }

  async function startDownload(tab, optionId, mode, intentId, allowDuplicate = false) {
    let client = await connection(true);
    let held = (await api.storage.session.get(`float:${tab.id}`))[`float:${tab.id}`];
    if (!held || (held.pageUrl && held.pageUrl !== tab.url)) {
      const refreshed = await inspectTab(tab, true);
      return { ok: false, error: 'Video bilgisi yenilendi. Kaliteyi seçip indirmeyi başlat.', refresh: refreshed };
    }
    if (typeof optionId === 'string' && optionId.startsWith('file:')) return startFile(tab, held, optionId, mode, intentId, allowDuplicate);
    const page = held; // the list the user saw, whichever playlist the chosen quality belongs to
    if (typeof optionId === 'string' && optionId.startsWith('alt:')) {
      const [, index, inner] = /^alt:(\d+):(.+)$/.exec(optionId) || [];
      const alt = (held.alts || []).find(item => item.index === Number(index));
      if (!alt) return { ok: false, error: 'Liste güncellendi. Güncel listeden bir kalite seç.', refresh: present(held.info, held.files, held.alts, held.playing) };
      held = { ...alt, files: page.files, alts: page.alts, pageUrl: page.pageUrl, instanceId: client.instanceId, optionIds: (alt.info.options || []).map(option => option.id), hasOptions: Boolean(alt.info.options?.length) };
      optionId = inner;
    }
    if (held.hasOptions && !held.optionIds.includes(optionId)) return { ok: false, error: 'Liste güncellendi. Güncel listeden bir kalite seç.', refresh: present(page.info, page.files, page.alts, page.playing) };
    const key = `float-outbox:${tab.id}|${tab.url}`;
    let record = (await api.storage.local.get(key))[key];
    const recovered = Boolean(record);
    if (!record) record = { payload: { ...held.input, quality: 'best', start: mode === 'queue' ? 'queue' : 'now', ...(held.hasOptions ? { formatId: optionId } : {}), ...(held.info?.silentStream && page.companionAudio ? { audioUrl: page.companionAudio } : {}), submissionId: intentId || globalThis.crypto.randomUUID() }, held, optionId };
    if (!recovered && !allowDuplicate) { const found = await duplicatesOf(client, record.payload); if (found.length) return duplicateAnswer(found); }
    if (!recovered) Object.assign(record.payload, await H.subtitlePayload(api, client, tab.id)); // read once, kept with the stored payload
    const store = () => api.storage.local.set({ [key]: record });
    const done = async () => { await api.storage.local.set({ [key]: null }); return { ok: true, queued: record.payload.start === 'queue' }; };
    const renew = async () => {
      const fresh = await H.reselect(client, record.held.sourceInput || record.held.input, record.held.info, record.optionId, api, tab.cookieStoreId);
      record.payload = { ...fresh.input, quality: 'best', start: record.payload.start, ...(fresh.chosen ? { formatId: fresh.chosen } : {}), ...(record.payload.audioUrl ? { audioUrl: record.payload.audioUrl } : {}), submissionId: record.payload.submissionId, ...(await H.subtitlePayload(api, client, tab.id)) };
      record.optionId = fresh.chosen;
      record.held = { ...record.held, ...fresh, instanceId: client.instanceId, optionIds: (fresh.info.options || []).map(option => option.id), hasOptions: Boolean(fresh.info.options?.length) };
      await api.storage.session.set({ [`float:${tab.id}`]: record.held });
      await store();
    };
    try {
      if (intentId || recovered || record.held.instanceId !== client.instanceId) {
        const receipt = await client.request(`/api/submissions/${record.payload.submissionId}`);
        if (receipt.known) return done();
        if (receipt.abandoned) throw new Error('Bu gönderim bırakılmış; yeniden indirme başlatılmadı.');
        if (record.held.instanceId !== client.instanceId) await renew();
      }
      await store(); // persist before any POST: a lost answer always reuses this id
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await client.request('/api/jobs', { method: 'POST', body: JSON.stringify(record.payload) });
          if (typeof result.id !== 'string') throw new Error('Gönderim yanıtı doğrulanamadı.');
          return done();
        } catch (error) {
          if (attempt) throw error;
          if (error.code === 'SELECTION_EXPIRED' || /son incelemesinde sunulmad/i.test(error.message)) { await renew(); continue; }
          if (error.code && !['APP_OFFLINE', 'APP_TIMEOUT', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT'].includes(error.code)) throw error;
          client = await connection(true);
          const receipt = await client.request(`/api/submissions/${record.payload.submissionId}`);
          if (receipt.known) return done();
          if (receipt.abandoned) throw error;
          if (record.held.instanceId !== client.instanceId) await renew();
        }
      }
    } catch (error) {
      if (error.code === 'QUALITY_CHANGED') {
        await api.storage.local.set({ [key]: null });
        held = { ...record.held, info: error.info, input: error.input, instanceId: client.instanceId, optionIds: (error.info.options || []).map(option => option.id), hasOptions: Boolean(error.info.options?.length) };
        await api.storage.session.set({ [`float:${tab.id}`]: held });
        return { ok: false, error: error.message, refresh: present(error.info, page.files, page.alts, page.playing) };
      }
      return { ok: false, error: error.message };
    }
  }

  // Report for the user to paste into a bug report: what was captured (addresses reduced to their shape, no query strings, no cookies)
  // and how long the look-up takes, step by step. Only our own extension pages may ask.
  async function diagnose(tab) {
    const stored = await api.storage.session.get([`tab:${tab.id}`, `context:${tab.id}`, `requests:${tab.id}`]);
    const frames = stored[`context:${tab.id}`]?.frames || {};
    const picked = candidates(tab, stored).list.map(item => ({ kind: item.kind, url: redact(item.url) }));
    const started = Date.now(); let result;
    try { result = await inspectTab(tab, false); } catch (error) { result = { ok: false, error: error.message }; }
    // Subtitle candidates (the same look the download makes): track names/sizes and address shapes only, never the text or queries.
    const gathered = await H.gatherSubtitles(api, tab.id, 2600).catch(() => ({ tracks: [], urls: [] }));
    const net = (await api.storage.session.get(`subs-net:${tab.id}`).catch(() => ({})))[`subs-net:${tab.id}`] || [];
    return {
      extension: api.runtime.getManifest?.().version, page: redact(tab.url),
      captured: (stored[`tab:${tab.id}`] || []).map(entry => ({ kind: entry.kind, frame: entry.frameId, url: redact(entry.url), mime: entry.mime || null, size: entry.size || null, partial: entry.partial, rangeLimited: entry.rangeLimited, playerBlob: entry.playerBlob, playingHeight: entry.observedHeight || null })),
      frames: Object.fromEntries(Object.entries(frames).map(([id, frame]) => [id, { url: redact(frame.url || ''), media: frame.mediaUrl ? redact(frame.mediaUrl) : null, blob: frame.playerBlob, height: frame.height, duration: frame.duration, drm: frame.drm }])),
      candidates: picked,
      subtitles: { playerTracks: gathered.tracks.map(track => ({ lang: track.lang || null, label: track.label || null, default: track.default, chars: track.vtt.length })), trackAddresses: gathered.urls.filter(item => item.sure !== undefined).map(item => ({ url: redact(item.url), sure: item.sure })), network: net.map(entry => ({ url: redact(entry.url), mime: entry.mime || null, size: entry.size, sure: entry.sure, frame: entry.frameId })) },
      requests: stored[`requests:${tab.id}`] || [],
      lookup: { ms: Date.now() - started, ok: result.ok, code: result.code || null, error: result.error || null, options: (result.options || []).map(option => option.label), files: (result.files || []).map(file => file.label), alert: result.alert || null },
      steps: timings.slice(-25)
    };
  }

  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'hypernab:diagnose') {
      if (sender.id !== api.runtime?.id || sender.tab || !Number.isInteger(message.tabId)) { respond({ ok: false, error: 'Geçersiz istek.' }); return false; }
      api.tabs.get(message.tabId).then(tab => diagnose(tab)).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type !== 'hypernab:float') return false;
    // Only our own content script, from a real tab. Nothing starts without the user pressing the panel's download button.
    if (sender.id !== api.runtime?.id || !sender.tab || !H.httpUrl(sender.url)) { respond({ ok: false, error: 'Geçersiz istek.' }); return false; }
    const tab = sender.tab;
    let work;
    if (message.action === 'inspect') {
      const withCookies = message.cookies === true, key = `${tab.id}|${withCookies}|${tab.url}`;
      if (!inflight.has(key)) inflight.set(key, inspectTab(tab, withCookies).finally(() => inflight.delete(key)));
      work = inflight.get(key);
    } else if (message.action === 'start' && (typeof message.optionId === 'string' || message.optionId === null)) {
      const intentId = typeof message.intentId === 'string' && /^[a-f0-9-]{36}$/i.test(message.intentId) ? message.intentId : null;
      const allowDuplicate = message.allowDuplicate === true;
      const key = `${tab.id}|${tab.url}|${intentId || `${message.optionId}|${message.mode || 'now'}`}|${allowDuplicate}`;
      if (!starts.has(key)) starts.set(key, startDownload(tab, message.optionId, message.mode, intentId, allowDuplicate).then(answer => {
        if (answer.ok) setTimeout(() => starts.delete(key), 1000); else starts.delete(key);
        return answer;
      }, error => { starts.delete(key); throw error; }));
      work = starts.get(key);
    }
    else { respond({ ok: false, error: 'Geçersiz istek.' }); return false; }
    work.then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
