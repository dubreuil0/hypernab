const browserApi = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);
const { bytes, duration, size, jobView } = Hypernab;
const client = new Hypernab.Client();
let currentTab, token = '', pending = null, inspected = null, outbox = null, inspectionSerial = 0;
let sending = false, polling = false, jobsBusy = false, timer = null;
let connected = false, lastJobs = [], syncSerial = 0;
let protocolReady = false;
let outboxContext = null;
let initializedOnce = false;
let stopArmed = false;
function transportControls() {
  $('transport-state').textContent = client.native ? 'Bağlantı: kimlik izin listeli Native Messaging' : 'Bağlantı: anahtarlı yerel HTTP (geliştirme)';
  $('launch-app').disabled = !client.native;
  $('close-app').disabled = !client.native || !connected;
}
function nativeChannel() {
  if (!client.native || client.native.closed) client.native = new globalThis.HypernabNativeChannel(browserApi.runtime);
  return client.native;
}
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function request(route, options = {}) {
  if (route !== '/api/status' && !protocolReady) return Promise.reject(new Error('Eklenti için güncel Hypernab sunucusuna bağlan. Aktif indirmeler bitmeden sunucuyu yeniden başlatma.'));
  client.token = token; return client.request(route, options);
}
async function ensureReady(userAction = false) {
  client.token = token;
  const previous = client.instanceId;
  const info = await client.ready(userAction); protocolReady = true;
  if (previous && previous !== client.instanceId) { inspections.clear(); lastSignature = ''; }
  return info;
}
function showOutbox() {
  $('recovery').hidden = !outbox;
  $('confirm-download').disabled = sending || Boolean(outbox);
  $('retry-submission').disabled = sending;
  $('abandon-submission').disabled = sending;
}
function renderDetails() {
  const option = inspected?.options?.find(item => item.id === $('preview-quality').value);
  const audio = { included: 'Ses dahil', merged: 'Ses ayrı akıştan birleştirilecek', none: 'Ses yok' };
  $('format-details').textContent = option
    ? [audio[option.audio] || 'Ses bilgisi bilinmiyor', option.fps ? `${option.fps} FPS` : null, size(option), option.etaSeconds > 0 ? `Tahmini indirme: ${duration(option.etaSeconds)} (geçmiş ölçüm)` : 'İndirme süresi henüz hesaplanamıyor'].filter(Boolean).join(' · ')
    : [inspected?.qualityNote || 'Kaynak ayrı kalite seçeneği sunmadı; bu dosya için kalite değiştirilemez.', inspected?.etaSeconds > 0 ? `Tahmini indirme: ${duration(inspected.etaSeconds)} (geçmiş ölçüm)` : 'İndirme süresi henüz hesaplanamıyor'].join(' · ');
}
// Inspects one source. The opening of this panel / pressing a card button is the user's action for this video:
// cookies for THIS video's address only are read here and travel with the inspection, never into storage or the outbox.
const inspections = new Map(); // source url -> Promise, one inspection per source per panel session
// Cooldown so reopening the panel does not repeat slow lookups: results live 15 minutes, failures 2 minutes. Session storage only (memory).
const CACHE_OK_MS = 900000, CACHE_FAIL_MS = 120000;
async function cacheRead(url) {
  try { const key = `inspect:${url}`, hit = (await browserApi.storage.session.get(key))[key]; return hit && hit.instanceId === client.instanceId && hit.withCookies === true && hit.cookieStoreId === currentTab?.cookieStoreId && Date.now() - hit.at < (hit.value?.info?.inspectionPending ? 700 : hit.error ? CACHE_FAIL_MS : CACHE_OK_MS) ? hit : null; } catch { return null; }
}
async function cacheWrite(url, value) { try { await browserApi.storage.session.set({ [`inspect:${url}`]: { at: Date.now(), cookieStoreId: currentTab?.cookieStoreId, ...value } }); } catch { /* cache is optional */ } }
function inspectSource(url, kind, entry = {}, { force = false, auto = false } = {}) {
  const work = (async () => {
    await ensureReady(false);
    if (!force) { const hit = await cacheRead(url); if (hit?.error) throw new Error(hit.error); if (hit?.value) { hit.value.info._instanceId = hit.instanceId; hit.value.info._sourceInput = hit.value.sourceInput || hit.value.input; return hit.value; } }
    const input = { url, engine: Hypernab.isFileKind(kind) ? 'direct' : 'extractor', referer: entry.frameUrl || currentTab?.url, pageUrl: currentTab?.url, userAgent: globalThis.navigator?.userAgent };
    if (kind === 'HLS') input.mediaKind = 'HLS';
    if (kind !== 'PAGE' && currentTab?.title) input.title = currentTab.title;
    // An automatic check never makes the app open its own browser; that only happens when the user presses the page button.
    if (auto) input.noBrowser = true;
    const cookies = await Hypernab.sessionCookies(browserApi, [url, input.pageUrl], currentTab?.cookieStoreId);
    let info;
    try { info = await request(kind === 'UNKNOWN' ? '/api/sniff' : '/api/inspect', { method: 'POST', body: JSON.stringify(cookies.length ? { ...input, cookies } : input) }); }
    catch (error) { if (auto && !Hypernab.transientError(error)) await cacheWrite(url, { error: error.message, instanceId: client.instanceId, withCookies: true }); throw error; }
    // A page the server resolved through its own browser is downloaded from the media request it captured.
    info._instanceId = client.instanceId; info._sourceInput = input;
    const value = { input: { ...input, noBrowser: undefined, ...(info.resolved || {}), title: info.title }, sourceInput: input, instanceId: client.instanceId, withCookies: true, info };
    await cacheWrite(url, { value: JSON.parse(JSON.stringify(value)), instanceId: client.instanceId, withCookies: true });
    if (info.inspectionPending) setTimeout(() => refresh({ force: false }).catch(() => {}), 1000);
    return value;
  })();
  inspections.set(url, work);
  work.finally(() => { if (inspections.get(url) === work) inspections.delete(url); }).catch(() => {});
  return work;
}
async function send(url, kind, button, entry = {}) {
  if (outbox) return status('Önce önceki gönderimin sonucunu kontrol et veya gönderimi güvenli şekilde bırak.', true);
  const serial = ++inspectionSerial;
  button.disabled = true; pending = null; inspected = null; $('preview').hidden = true;
  try {
    status('Video bilgileri ve gerçek format seçenekleri alınıyor…');
    await ensureReady(true);
    const { input, info } = await inspectSource(url, kind, entry);
    if (serial !== inspectionSerial) return;
    pending = input; inspected = info;
    $('preview-title').textContent = info.title;
    $('preview-facts').textContent = [info.duration > 0 ? `Video süresi: ${duration(info.duration)}` : entry.observedDuration > 0 ? `Oynatıcı süresi: ${duration(entry.observedDuration)}` : 'Video süresi bilinmiyor', info.options?.length ? `${info.options.length} gerçek format seçeneği` : info.extension?.toUpperCase() || 'Format bilinmiyor', !info.options?.length && entry.observedHeight ? `Oynatıcı: ${entry.observedHeight}p` : null, !info.options?.length ? info.filesize > 0 ? `${info.estimatedSize ? 'Yaklaşık ' : ''}${bytes(info.filesize)}` : 'Boyut bilinmiyor' : null].filter(Boolean).join(' · ');
    $('preview-warning').textContent = [info.warning, info.sessionUsed ? 'Tarayıcı oturumun bu indirme için kullanılıyor; çerezler diske kaydedilmez.' : null, entry.drmSuspected ? 'Bu oynatıcıda DRM bildirimi algılandı. DRM korumalı kaynaklar desteklenmez.' : null].filter(Boolean).join(' ');
    const select = $('preview-quality'); select.replaceChildren();
    for (const option of info.options || []) {
      const item = node('option', '', `${option.label} · ${size(option)}`); item.value = option.id; select.append(item);
    }
    select.disabled = !info.options?.length;
    if (info.options?.length) select.value = info.defaultOptionId || info.options[0].id;
    else { const item = node('option', '', 'Ayrı kalite seçeneği yok'); item.value = ''; select.append(item); select.value = ''; }
    renderDetails(); showOutbox();
    $('preview').hidden = false; status(info.options?.length ? 'En yüksek kalite seçili. Değiştirip İndirmeyi başlat’a basabilirsin; inceleme tek başına indirme başlatmaz.' : 'Bu kaynak ayrı kalite seçeneği sunmuyor. Bilgileri kontrol edip İndirmeyi başlat’a bas.');
  } catch (error) { if (serial === inspectionSerial) status(error.message, true); }
  finally { button.disabled = false; }
}
// Cards inspect one after another: the app answers at most two inspections at a time.
let inspectChain = Promise.resolve(), refreshForce = false; // "Yenile" bypasses the cooldown cache once
const fileName = entry => { try { return decodeURIComponent(new URL(entry.url).pathname.split('/').pop() || entry.host); } catch { return entry.host; } };
function renderCard(area, group, source, entry, { auto = false, force = false } = {}) {
  const variants = !group.stream && group.files.length > 1;
  const audioText = { included: 'Ses dahil', merged: 'Ses ayrı akıştan birleştirilir', none: 'Ses yok' };
  const addStart = (select, getPrepared, getInfo) => {
    // Two explicit choices: download now (no limit), or add to the waiting list ("Start queue" in the download center runs it).
    const start = node('button', 'primary', 'İndir ↓'), later = node('button', 'later', 'Sonra ekle ☰+');
    const act = mode => async () => {
      start.disabled = later.disabled = true;
      try {
        const prepared = await getPrepared(), info = await getInfo();
        if (await startDownload(prepared, info, select ? select.value : null, mode)) { (mode === 'queue' ? later : start).textContent = mode === 'queue' ? 'Sonra eklendi ✓' : 'İndirme başladı ✓'; return; }
      } catch (error) { status(error.message, true); }
      start.disabled = later.disabled = false;
    };
    start.addEventListener('click', act('now')); later.addEventListener('click', act('queue'));
    const row = node('div', 'row'); row.append(start, later); area.append(row);
  };
  const fail = error => {
    area.replaceChildren(node('small', 'warning', error.message));
  };
  if (variants) {
    // Several separate files for one video: let the user pick by what is really known (size), then inspect that one on Start.
    const select = node('select', 'card-select'); const byId = new Map();
    group.files.forEach((file, index) => { const item = node('option', '', `${fileName(file)} · ${file.size > 0 ? bytes(file.size) : 'Boyut bilinmiyor'}${file === group.primary ? ' · en büyük' : ''}`); item.value = String(index); select.append(item); byId.set(String(index), file); });
    select.value = String(group.files.indexOf(group.primary));
    area.append(node('small', '', `Bu videoyu ${group.files.length} ayrı dosya olarak yakaladım. Gerçek çözünürlük indirmeden önce bilinmeyebilir; boyut ve dosya adına göre seç.`), select);
    const chosen = () => byId.get(select.value);
    addStart(null, () => inspectSource(chosen().url, 'VIDEO', chosen()).then(result => result.input), () => inspectSource(chosen().url, 'VIDEO', chosen()).then(result => result.info));
    return;
  }
  area.append(node('small', 'muted', 'Kaliteler aranıyor…'));
  const run = inspectChain.then(() => inspectSource(source.url, source.kind, source.entry, { auto, force }));
  inspectChain = run.catch(() => {});
  run.then(({ input, info }) => {
    area.replaceChildren();
    const options = info.options || [];
    let select = null;
    const detail = node('small', '', '');
    const render = () => {
      const option = options.find(item => item.id === select?.value) || options[0];
      const parts = option
        ? [audioText[option.audio] || 'Ses bilgisi bilinmiyor', option.fps ? `${option.fps} FPS` : null, size(option), option === options[0] ? 'En yüksek' : null]
        : [info.qualityNote || 'Kaynak ayrı kalite seçeneği sunmuyor; en iyi hâliyle indirilir.', info.filesize > 0 ? `${info.estimatedSize ? 'Yaklaşık ' : ''}${bytes(info.filesize)}` : 'Boyut bilinmiyor', info.duration > 0 ? duration(info.duration) : null];
      detail.textContent = parts.filter(Boolean).join(' · ');
    };
    if (options.length > 1) {
      select = node('select', 'card-select');
      // Recommended entries (one per picture size, MP4 first) are shown first; the rest sit under "Diğer biçimler".
      const main = options.filter(option => option.recommended !== false), more = options.filter(option => option.recommended === false);
      const fill = (parent, list) => { for (const option of list) { const item = node('option', '', `${option.label} · ${size(option)}`); item.value = option.id; parent.append(item); } };
      fill(select, main);
      if (more.length) { const group = node('optgroup', ''); group.label = 'Diğer biçimler'; fill(group, more); select.append(group); }
      select.value = info.defaultOptionId || options[0].id; select.addEventListener('change', render);
      area.append(select);
    } else if (options.length === 1) area.append(node('small', '', `Tek kalite: ${options[0].label}`));
    area.append(detail);
    const notes = [info.via === 'browser' ? 'Sayfa uygulamanın tarayıcısıyla çözüldü.' : null, info.sessionUsed ? 'Tarayıcı oturumun kullanılıyor; çerezler diske kaydedilmez.' : null, info.warning].filter(Boolean);
    if (notes.length) area.append(node('small', 'muted', notes.join(' ')));
    render(); addStart(select, () => input, () => info);
  }, fail);
}
// What the cards were last drawn from. An automatic refresh with the same inputs leaves them alone,
// so a quality the user already picked in a card is not reset by unrelated storage activity.
let lastSignature = '';
async function refresh({ force = true } = {}) {
  [currentTab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const stored = await browserApi.storage.session.get([`tab:${currentTab?.id}`, `context:${currentTab?.id}`]);
  const entries = stored[`tab:${currentTab?.id}`] || [];
  // A player exists on the page (video element seen by the content script) even when the network showed no usable file.
  const playerFrames = Object.values(stored[`context:${currentTab?.id}`]?.frames || {});
  const hasPlayer = playerFrames.some(frame => frame.playerBlob || frame.mediaUrl || frame.duration > 0) && !playerFrames.some(frame => frame.drm);
  const pageUrl = Hypernab.httpUrl(currentTab?.url) && !currentTab.url.startsWith(Hypernab.API) ? currentTab.url : null;
  const signature = JSON.stringify([currentTab?.id, pageUrl, hasPlayer, protocolReady, entries.map(entry => entry.url)]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  $('media').replaceChildren();
  // Nothing downloadable captured (e.g. a site that streams through blob:/MSE) but a player is there: look the page up automatically.
  // Cooldown and "no browser" rules live in inspectSource; this never opens the app's own browser.
  const automaticPage = !entries.length && hasPlayer && pageUrl && protocolReady;
  if (!entries.length && !automaticPage) $('media').append(node('div', 'empty', 'Henüz medya bulunamadı. Videoyu normal şekilde oynat; gömülü oynatıcıların istekleri de yakalanır. Sonra Yenile’ye bas.'));
  if (automaticPage) {
    const item = node('article', 'item'), area = node('div', 'card-quality');
    item.append(node('strong', '', currentTab.title || 'Bu sayfadaki video'), node('small', '', `Sayfa · ${new URL(pageUrl).hostname}`), area);
    $('media').append(item);
    const pageEntry = { kind: 'PAGE', host: new URL(pageUrl).hostname, frameUrl: pageUrl };
    renderCard(area, { stream: false, files: [], primary: pageEntry }, { url: pageUrl, kind: 'PAGE', entry: pageEntry }, pageEntry, { auto: true, force: refreshForce });
    refreshForce = false;
  }
  const groups = Hypernab.groupEntries(entries);
  let automatic = 0;
  for (const group of groups) {
    const entry = group.primary, source = Hypernab.sourceFor(entry, entries, currentTab?.url);
    const item = node('article', 'item');
    item.append(node('strong', '', currentTab?.title || entry.pageTitle || entry.frameTitle || 'Ad çözülemedi: yakalanan medya'));
    const warning = entry.rangeLimited ? ' · Sınırlı parça bağlantısı; tam video değil' : entry.playerBlob && entry.kind === 'VIDEO' ? ' · Parçalı oynatıcı; tek akış tam video sayılmaz' : entry.partial ? ' · HTTP aralık isteği' : '';
    item.append(node('small', '', `${entry.kind} · ${entry.host}${entry.frameId ? ' · Gömülü oynatıcı' : ''}${warning}`));
    if (entry.drmSuspected) item.append(node('small', 'warning', 'Bu oynatıcıda DRM bildirimi algılandı. DRM korumalı kaynaklar desteklenmez.'));
    if (source.ambiguous) item.append(node('small', 'warning', 'Aynı oynatıcıda birden fazla manifest var; reklam/bölüm karışmaması için tahmin edilmedi. Sayfayı inceleyebilirsin.'));
    const area = node('div', 'card-quality'); item.append(area); $('media').append(item);
    // A page-level source can take a while (the app opens a browser) and DRM players are not downloadable: both stay manual.
    if (source.kind === 'PAGE' || entry.drmSuspected || automatic >= 4 || !protocolReady) {
      const button = node('button', '', source.kind === 'PAGE' ? 'Tam kaynak için sayfayı incele ↗' : 'Kalitelere bak ↗');
      button.addEventListener('click', () => send(source.url, source.kind, button, source.entry)); area.append(button);
    } else { automatic++; renderCard(area, group, source, entry); }
  }
  $('send-page').disabled = !Hypernab.httpUrl(currentTab?.url) || currentTab?.url?.startsWith(Hypernab.API);
}
function renderJobs(jobs) {
  $('jobs').replaceChildren();
  if (!jobs.length) $('jobs').append(node('div', 'empty', 'Uygulama kuyruğunda indirme yok.'));
  for (const job of jobs) {
    const view = jobView(job), item = node('article', 'item');
    item.append(node('strong', '', job.title && job.title !== 'video' ? job.title : job.host), node('small', '', [job.host, job.formatLabel, view.stage].filter(Boolean).join(' · ')), node('small', '', view.facts));
    if (job.error) item.append(node('small', 'warning', job.error));
    const actions = node('div', 'row');
    for (const [action, label, allowed] of [
      ['pause', 'Duraklat', ['running', 'queued'].includes(job.status)],
      ['resume', 'Devam et', job.status === 'paused' && !job.resumeRequested],
      ['cancel', 'İptal et', ['running', 'queued', 'paused', 'interrupted', 'failed'].includes(job.status)]
    ]) if (allowed) {
      const button = node('button', '', label); button.disabled = jobsBusy || !connected;
      button.addEventListener('click', () => jobCommand(job.id, action)); actions.append(button);
    }
    item.append(actions); $('jobs').append(item);
  }
}
async function jobCommand(id, action) {
  if (jobsBusy) return; jobsBusy = true;
  try { await request(`/api/jobs/${id}/${action}`, { method: 'POST', body: '{}' }); await syncJobs(); }
  catch (error) { status(error.message, true); }
  finally { jobsBusy = false; await syncJobs(); }
}
async function syncJobs() {
  if (!token && !client.native) { $('connection').textContent = 'Eşleştirme gerekli'; return; }
  const serial = ++syncSerial;
  try {
    const previous = client.instanceId, wasConnected = connected;
    await ensureReady(false);
    const jobs = await request('/api/jobs');
    if (serial !== syncSerial) return;
    if (!Array.isArray(jobs)) throw new Error('Uygulama kuyruk biçimi desteklenmiyor; güncel sürümü başlat.');
    connected = true; lastJobs = jobs;
    renderJobs(jobs); $('connection').textContent = '● Uygulamayla senkron';
    if (initializedOnce && (!wasConnected || previous !== client.instanceId)) await refresh({ force: false });
  } catch (error) {
    if (serial !== syncSerial) return;
    connected = false;
    renderJobs(lastJobs.map(job => ({ ...job, progress: { received: job.received, total: job.total, ...(job.progress || {}), phase: 'disconnected', speed: 0, etaSeconds: null } })));
    $('connection').textContent = error.message;
  }
  transportControls();
}
async function clearOutbox() {
  await browserApi.storage.local.set({ outbox: null, outboxContext: null }); outbox = null; outboxContext = null; showOutbox();
}
async function recoverSubmission(resend = false) {
  if (!outbox || sending) return;
  sending = true; showOutbox();
  try {
    const result = await request(`/api/submissions/${outbox.submissionId}`);
    if (result.known || result.abandoned) {
      await clearOutbox();
      status(result.abandoned ? 'Önceki gönderim bırakılmış. Bağlantıyı yeniden incele.' : result.listed ? 'Önceki gönderim zaten kuyrukta. Tekrar başlatılmadı.' : 'Önceki gönderim işlenmiş, kaydı listeden kaldırılmış. Tekrar başlatılmadı.');
    } else if (resend) await deliver();
    else status('Önceki gönderimin sonucu belirsiz. Aynı kimlikle kontrol edip tekrar gönderebilir veya güvenli şekilde bırakabilirsin.', true);
  } catch (error) { status(error.message, true); }
  finally { sending = false; showOutbox(); await syncJobs(); }
}
async function deliver() {
  const info = await ensureReady(true);
  if (!info.extensionProtocol || info.extensionProtocol < 1) { protocolReady = false; throw new Error('Gönderim yapılmadı: çalışan Hypernab sunucusu eski. Güncel sürümü başlatıp aynı gönderimi kontrol et.'); }
  const renew = async () => {
    if (!outboxContext) throw new Error('Önceki gönderimin kalite bilgisi eksik. Gönderimi güvenli şekilde bırakıp kaliteyi seç.');
    const fresh = await Hypernab.reselect(client, outboxContext.source, outboxContext.info, outbox.formatId, browserApi, currentTab?.cookieStoreId);
    outbox = { ...fresh.input, quality: 'best', start: outbox.start, submissionId: outbox.submissionId, ...(fresh.chosen ? { formatId: fresh.chosen } : {}) };
    outboxContext = { ...outboxContext, instanceId: client.instanceId, info: fresh.info };
    await browserApi.storage.local.set({ outbox, outboxContext });
  };
  if (outboxContext && outboxContext.instanceId !== client.instanceId) {
    const receipt = await request(`/api/submissions/${outbox.submissionId}`);
    if (receipt.known) { await clearOutbox(); status('Gönderim zaten alınmış; ikinci indirme oluşturulmadı.'); return; }
    if (receipt.abandoned) throw new Error('Gönderim bırakılmış; tekrar başlatılmadı.');
    await renew();
  }
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { result = await request('/api/jobs', { method: 'POST', body: JSON.stringify(outbox) }); break; }
    catch (error) {
      if (attempt) throw error;
      if (error.code === 'SELECTION_EXPIRED' || /son incelemesinde sunulmad/i.test(error.message)) { await renew(); continue; }
      if (error.code && !['APP_OFFLINE', 'APP_TIMEOUT', 'NATIVE_DISCONNECTED', 'NATIVE_TIMEOUT'].includes(error.code)) throw error;
      // No new id: only an authoritative receipt check permits a bounded resend.
      await ensureReady(true);
      const receipt = await request(`/api/submissions/${outbox.submissionId}`);
      if (receipt.known) { result = { id: receipt.id }; break; }
      if (receipt.abandoned) throw error;
      if (outboxContext && outboxContext.instanceId !== client.instanceId) await renew();
    }
  }
  if (typeof result.id !== 'string') throw new Error('Gönderim yanıtı doğrulanamadı; aynı kimlikle tekrar kontrol et.');
  const queued = outbox.start === 'queue';
  await clearOutbox(); pending = null; inspected = null; $('preview').hidden = true;
  status(queued ? 'Sonra eklendi. İndirme merkezinde Kuyruğu başlat de.' : 'İndirme başladı. Paneli kapatsan da devam eder.');
}
$('save').addEventListener('click', async () => {
  const proposed = $('token').value.trim();
  if (!/^[a-f0-9]{64}$/.test(proposed)) return status('Anahtar 64 karakter olmalı; yerel uygulamadan kopyala.', true);
  try {
    const info = await new Hypernab.Client({ token: proposed }).request('/api/status');
    if (!info.extensionProtocol || info.extensionProtocol < 1) throw new Error('Eklenti için güncel Hypernab sunucusunu başlat.');
    client.native?.close(); client.native = null; token = proposed; protocolReady = true;
    await browserApi.storage.local.set({ token, transport: 'http' }); status('Yerel uygulama eşleştirildi.'); await syncJobs(); await recoverSubmission(); await refresh();
  } catch (error) { status(error.message, true); }
});
$('connect-native').addEventListener('click', async () => {
  try {
    nativeChannel(); await browserApi.storage.local.set({ transport: 'native' });
    const info = await request('/api/status');
    if (!info.extensionProtocol) throw new Error('Uygulamayı güncel sürümle aç.');
    protocolReady = true; status('Native Messaging bağlantısı kuruldu.'); await syncJobs(); await recoverSubmission(); await refresh();
  } catch (error) { protocolReady = false; status(error.message, true); }
  transportControls();
});
// A report for bug reports: what this page made the extension capture (addresses reduced to their shape, no query strings or
// cookies) and how long each look-up step took. It runs one real look-up, which can take a while on slow sources.
$('diagnostic-mode')?.addEventListener('click', async () => {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const answer = await browserApi.runtime.sendMessage({ type: 'hypernab:diagnostic-mode', tabId: tab?.id, enabled: true });
  $('diagnose-state').textContent = answer?.ok ? 'Bu sekmede tanı açık. Videoyu oynat, sonra raporu kopyala. En fazla 200 istek; çerezler ve sorgular kaydedilmez. Sekme kapanınca durur.' : 'Tanı açılamadı.';
});
$('diagnose').addEventListener('click', async () => {
  const button = $('diagnose'), state = $('diagnose-state'), box = $('diagnose-text');
  button.disabled = true; box.hidden = true; state.textContent = 'Rapor hazırlanıyor… (yarım dakikaya kadar sürebilir)';
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    const answer = await browserApi.runtime.sendMessage({ type: 'hypernab:diagnose', tabId: tab?.id });
    if (!answer?.ok) throw new Error(answer?.error || 'Rapor alınamadı.');
    const text = JSON.stringify(answer.data, null, 2);
    box.value = text; box.hidden = false;
    try { await navigator.clipboard.writeText(text); state.textContent = 'Rapor panoya kopyalandı; sohbete yapıştır. (Kutudan da kopyalayabilirsin.)'; }
    catch { box.select(); state.textContent = 'Raporu kutudan kopyala (Ctrl+A, Ctrl+C) ve sohbete yapıştır.'; }
  } catch (error) { state.textContent = error.message; }
  finally { button.disabled = false; }
});
$('launch-app').addEventListener('click', async () => {
  const button = $('launch-app'); button.disabled = true;
  try {
    const result = await nativeChannel().request({ action: 'show' });
    if (!result.status?.extensionProtocol) throw new Error('Başlatılan uygulama güncel değil.');
    protocolReady = true; await browserApi.storage.local.set({ transport: 'native' });
    status(result.alreadyRunning ? 'Uygulama zaten açık; ikinci motor başlatılmadı.' : 'Uygulama açıldı. Paneli kapatsan da motor çalışır.');
    await syncJobs(); await recoverSubmission();
  } catch (error) { status(error.message, true); }
  transportControls();
});
$('show-app').addEventListener('click', async () => {
  try {
    const result = await nativeChannel().request({ action: 'show' });
    if (!result.status?.extensionProtocol) throw new Error('Hypernab uygulamasını güncelle.');
    protocolReady = true; await browserApi.storage.local.set({ transport: 'native' });
    status('Hypernab masaüstü penceresi açıldı.'); await syncJobs(); await refresh();
  } catch (error) { status(error.message, true); }
});
$('close-app').addEventListener('click', async () => {
  if (!stopArmed) { stopArmed = true; $('close-app').textContent = 'Kapatmayı onayla'; status('Yalnızca aktif/sıradaki iş yoksa uygulama kapanır. Duraklatılmış işler ve dosyalar korunur. Tekrar basarak onayla.'); return; }
  stopArmed = false; $('close-app').textContent = 'Uygulamayı kapat';
  try {
    const info = await request('/api/status');
    await request('/api/app/shutdown', { method: 'POST', body: JSON.stringify({ confirm: true, instanceId: info.instanceId }) });
    protocolReady = false; connected = false; status('Uygulama güvenle kapatıldı; dosyalar korunuyor.');
  } catch (error) { status(error.message, true); }
  await syncJobs(); transportControls();
});
$('refresh').addEventListener('click', () => { refreshForce = true; inspections.clear(); refresh({ force: true }).catch(error => status(error.message, true)); });
$('sync-jobs').addEventListener('click', syncJobs);
$('preview-quality').addEventListener('change', renderDetails);
$('send-page').addEventListener('click', () => send(currentTab.url, 'PAGE', $('send-page')));
$('close-preview').addEventListener('click', () => { inspectionSerial++; pending = null; inspected = null; $('preview').hidden = true; });
$('retry-submission').addEventListener('click', () => recoverSubmission(true));
$('abandon-submission').addEventListener('click', async () => {
  if (!outbox || sending) return;
  sending = true; showOutbox();
  try {
    const result = await request(`/api/submissions/${outbox.submissionId}/abandon`, { method: 'POST', body: '{}' });
    await clearOutbox(); pending = null; inspected = null; $('preview').hidden = true;
    status(result.known ? 'Gönderim zaten işlenmiş; mevcut iş iptal edilmedi veya yeniden başlatılmadı.' : 'Gönderim bırakıldı; gecikmiş tekrarları da engellendi. Yeniden inceleyebilirsin.');
  } catch (error) { status(error.message, true); }
  finally { sending = false; showOutbox(); await syncJobs(); }
});
// Shared by the preview button and the per-video cards: nothing starts without the user pressing a Start button.
async function startDownload(prepared, info, chosen, mode = 'now') {
  if (!prepared || sending || outbox) return false;
  if (info?.options?.length && !info.options.some(o => o.id === chosen)) { status('Listeden geçerli bir kalite seç.', true); return false; }
  sending = true; showOutbox();
  try {
    await ensureReady(true);
    // The same source in the same quality may already be in the app: ask once. A failed check never blocks the download.
    const found = await request('/api/duplicates', { method: 'POST', body: JSON.stringify({ url: prepared.url, formatId: info?.options?.length ? chosen : undefined }) }).then(answer => answer.duplicates || [], () => []);
    if (found.length && !confirm(`Bu video aynı kalitede zaten listede (${found.length} kayıt). Yine de ayrı bir kopya indirilsin mi? Mevcut dosyalar silinmez.`)) { status('İndirme başlatılmadı; video zaten listede.'); return false; }
    const payload = { ...prepared, quality: 'best', start: mode === 'queue' ? 'queue' : 'now', ...(info?.options?.length && chosen ? { formatId: chosen } : {}), submissionId: crypto.randomUUID() };
    if (Number.isInteger(currentTab?.id)) Object.assign(payload, await Hypernab.subtitlePayload(browserApi, client, currentTab.id)); // the page's subtitles; never required
    // Persist BEFORE sending, so closing a popup or losing the reply cannot create a second job.
    outboxContext = { source: info?._sourceInput || prepared, info, instanceId: info?._instanceId ?? null };
    await browserApi.storage.local.set({ outbox: payload, outboxContext }); outbox = payload; showOutbox();
    await deliver(); await syncJobs();
    return true;
  } catch (error) {
    if (error.code === 'QUALITY_CHANGED') {
      const source = outboxContext?.source;
      await clearOutbox();
      pending = error.input; inspected = error.info; inspected._instanceId = client.instanceId; inspected._sourceInput = source || error.input;
      $('preview-title').textContent = inspected.title;
      const select = $('preview-quality'); select.replaceChildren();
      for (const option of inspected.options || []) { const item = node('option', '', `${option.label} · ${size(option)}`); item.value = option.id; select.append(item); }
      select.value = inspected.defaultOptionId || inspected.options?.[0]?.id || ''; select.disabled = !inspected.options?.length;
      $('preview').hidden = false; renderDetails();
    }
    status(error.message, true);
    return false;
  }
  finally { sending = false; showOutbox(); }
}
$('confirm-download').addEventListener('click', async () => {
  await startDownload(pending, inspected, inspected?.options?.length ? $('preview-quality').value : null, 'now');
});
$('queue-download').addEventListener('click', async () => {
  await startDownload(pending, inspected, inspected?.options?.length ? $('preview-quality').value : null, 'queue');
});
async function init() {
  const stored = await browserApi.storage.local.get(['token', 'outbox', 'outboxContext', 'transport']);
  outboxContext = stored.outboxContext || null;
  token = stored.token || ''; outbox = stored.outbox || null; $('token').value = token;
  if (!token && stored.transport !== 'native') $('setup').open = true; // connection settings stay folded once paired
  if ((stored.transport === 'native' || (!stored.transport && !token)) && globalThis.HypernabNativeChannel && browserApi.runtime?.connectNative) {
    try { nativeChannel(); } catch (error) { status(error.message, true); }
  }
  transportControls();
  showOutbox(); await refresh();
  if (token || client.native) {
    try {
      const info = await ensureReady(false);
      if (!info.extensionProtocol || info.extensionProtocol < 1) throw new Error('Çalışan Hypernab sunucusu eski. Aktif işler bitince yeni sürümle yeniden başlat.');
      protocolReady = true;
      status('Yerel uygulama bağlı.'); await syncJobs(); await recoverSubmission();
      await refresh(); // connected now: the cards can look up the real qualities by themselves
    } catch (error) { status(error.message, true); $('setup').open = true; }
  }
  if (timer === null && typeof setInterval === 'function') timer = setInterval(async () => {
    if (polling || (!token && !client.native) || document.hidden) return; polling = true;
    try { await syncJobs(); } finally { polling = false; }
  }, 1500);
  initializedOnce = true;
}
// The panel can stay open (pinned/detached) while the user moves on: follow the active tab by itself.
// Only this tab's captured-media and player keys count; the panel's own cache writes (inspect:*) must not retrigger it.
function followActiveTab() {
  if (typeof setTimeout !== 'function') return;
  let wait = null;
  const schedule = () => { clearTimeout(wait); wait = setTimeout(() => refresh({ force: false }).catch(() => {}), 700); };
  browserApi.tabs.onUpdated?.addListener((tabId, change) => { if (tabId === currentTab?.id && (change.url || change.status === 'complete')) schedule(); });
  browserApi.tabs.onActivated?.addListener(schedule);
  browserApi.storage.onChanged?.addListener((changes, area) => {
    if (area === 'session' && currentTab && (`tab:${currentTab.id}` in changes || `context:${currentTab.id}` in changes)) schedule();
  });
}
const initialized = init().then(followActiveTab);
initialized.catch(error => status(error.message, true));
