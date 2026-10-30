import { canPause, canResume, canCancel, visibleJobs, selectionState, moveVisible } from './queue-state.js';
import { progressView, durationText } from './progress-view.js';
import { setupAdvanced } from './advanced.js';
import { setupHistory, canPlayFile } from './history-view.js';
import { COLUMNS, GAP, isAuto, effectiveLayout, searchJobs, sortJobs, normalizeLayout, sameLayout, clampWidth, gridTemplate, minimumWidth, visibleColumns, fitWidth, sortLabels } from './list-tools.js';

let token = '', jobs = [], filter = 'all', pending = null, inspected = null, autoTitle = '';
// Search and sort change only what is shown. The real queue order (and what runs) never depends on them.
let search = '', sortKey = 'queue', sortDir = 'asc';
let layout = normalizeLayout(null), layoutPending = false, layoutTimer = null, resizing = null;
const selected = new Set();
const expandedJobs = new Set();
let queueBusy = false, pendingQueueCommand = null;
const $ = id => document.getElementById(id);
let selectedQueueName = 'Genel';
let dragging = null;
const advanced = setupAdvanced(api, status);
const fmt = value => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** i).toLocaleString('tr-TR', { maximumFractionDigits: i ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB'][i]}`;
};
setupHistory({ api, el, icon, fmt });
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'İstek başarısız.');
  return data;
}
function el(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
// Every action uses the shared SVG sprite, including text buttons in settings and confirmation dialogs.
const buttonIcons = { 'add-button': 'download', 'close-preview': 'x', 'deselect-all': 'x', 'cancel-power': 'x', 'open-downloads': 'folder', 'dir-reset': 'reset', 'reset-confirms': 'reset', 'save-speed': 'check', 'new-queue': 'plus', 'cancel-schedule': 'x', 'queue-confirm-cancel': 'x', 'queue-confirm-accept': 'check' };
for (const button of document.querySelectorAll('button.btn')) {
  const text = button.textContent.trim();
  if (text && !button.getAttribute('aria-label')) button.setAttribute('aria-label', text);
  if (text && !button.title) button.title = text;
  if (!button.querySelector('svg') && buttonIcons[button.id]) button.replaceChildren(icon(buttonIcons[button.id]), el('span', '', text));
}
// --- what is shown: filter tab -> search -> visual sort. Selection and bulk actions only ever use what is shown.
const shownJobs = () => sortJobs(searchJobs(visibleJobs(jobs, filter), search), sortKey, sortDir);
const reorderAllowed = () => sortKey === 'queue' && !search.trim();
const selectedShown = () => { const ids = new Set(shownJobs().map(job => job.id)); return new Set([...selected].filter(id => ids.has(id))); };
// Rows are rebuilt only when something they show has changed: an idle list costs almost nothing, even with hundreds of downloads.
let lastPaint = '';
// phaseSeconds is an internal stopwatch that ticks for finished jobs too and is never shown.
const paintKey = () => JSON.stringify([jobs, filter, search, sortKey, sortDir, queueBusy, [...selected], [...expandedJobs], layout, effective.hidden, document.documentElement.dataset.appearance], (name, value) => name === 'phaseSeconds' ? undefined : value);
function render(force = false) {
  if (dragging) return; // polling keeps receiving data, but must not replace the captured handle
  const key = paintKey();
  if (!force && key === lastPaint && document.getElementById('jobs').childElementCount) return;
  lastPaint = key;
  const focusedJob = document.activeElement?.dataset?.jobSelect;
  const focusedMove = document.activeElement?.dataset?.jobMove;
  const focusedLocation = document.activeElement?.dataset?.jobLocation;
  const focusedAction = document.activeElement?.dataset?.jobAction;
  $('stat-active').textContent = String(jobs.filter(j => j.status === 'running').length);
  const speed = fmt(jobs.reduce((n, j) => n + (j.status === 'running' ? j.speed || 0 : 0), 0)).split(' ');
  $('stat-speed').replaceChildren(document.createTextNode(`${speed[0]} `), el('small', '', `${speed[1]}/sn`));
  $('stat-complete').textContent = jobs.filter(j => j.status === 'completed').length;
  $('nav-count').textContent = jobs.length;
  const visible = shownJobs();
  const total = visibleJobs(jobs, filter).length;
  $('queue-count').textContent = search.trim() ? `${visible.length} / ${total}` : visible.length;
  renderListNotice(visible.length, total);
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = el('div', 'empty');
    const tile = el('div', 'empty-icon'); tile.append(icon(search.trim() ? 'search' : 'download'));
    if (search.trim() && total) empty.append(tile, el('strong', '', 'Aramayla eşleşen indirme yok.'), el('p', '', 'Aramayı temizle veya başka bir ad / site dene. İndirmelerin silinmedi, yalnızca gizlendi.'));
    else empty.append(tile, el('strong', '', filter === 'all' ? 'Bir sonraki videon için hazır.' : 'Bu görünümde indirme yok.'), el('p', '', 'Bir bağlantı yapıştır veya tarayıcı eklentisiyle oynatılan videoyu yakala. İndirmelerin burada görünecek.'));
    fragment.append(empty);
  }
  for (const job of visible) {
    const view = progressView(job, fmt);
    const card = el('article', 'job'), top = el('div', 'job-top'), info = el('div', 'job-info');
    card.dataset.jobId = job.id;
    card.classList.toggle('job-selected', selected.has(job.id));
    card.classList.toggle('details-open', expandedJobs.has(job.id));
    const details = el('div', 'job-details'); details.id = `details-${job.id}`;
    const selectLabel = el('label', 'job-select'), checkbox = el('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(job.id); checkbox.disabled = queueBusy;
    checkbox.dataset.jobSelect = job.id; checkbox.setAttribute('aria-label', `${job.title || job.host} seç`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(job.id); else selected.delete(job.id);
      card.classList.toggle('job-selected', checkbox.checked); renderSelection();
    });
    selectLabel.append(checkbox);
    const handle = el('button', 'btn icon-only ghost reorder-handle');
    handle.type = 'button'; handle.dataset.jobMove = job.id; handle.append(icon('grip'));
    handle.title = reorderAllowed() ? 'Basılı tutup sürükle · ↑ ↓ ile taşı' : 'Sıra değiştirmek için önce arama ve sıralamayı kapat (Kuyruk sırasına dön)'; handle.setAttribute('aria-label', `Sırayı değiştir: ${job.title || job.host}`); handle.disabled = queueBusy;
    handle.classList.toggle('reorder-off', !reorderAllowed());
    bindReorder(handle, job.id);
    top.append(handle, selectLabel);
    const title = job.title === 'video' ? job.host : job.title;
    const titleNode = el('div', 'job-title', title); titleNode.title = title;
    const sourceText = `${job.host} · ${job.engine === 'direct' ? 'Dosya' : 'Akış/site'}${job.formatLabel || job.media?.height ? ` · ${job.formatLabel || `${job.media.height}p`}` : ''}`;
    info.append(titleNode, el('div', 'job-meta', `${sourceText} · ${view.size}${view.speed ? ` · ${view.speed}` : ''}`));
    details.append(el('div', 'job-meta compact-source', `${title} · ${sourceText}${job.viaQueue ? ` · Kuyruk: ${job.queueName || 'Genel'}` : ''}`));
    const stage = view.stage;
    if (job.viaQueue) info.append(el('div', 'job-meta', `Kuyruk: ${job.queueName || 'Genel'}`));
    const tile = el('span', 'file-icon'); tile.append(icon(job.status === 'completed' ? 'check' : job.status === 'held' ? 'list' : 'download'));
    const stageNode = el('span', `job-state ${job.status}`, stage); stageNode.title = stage;
    top.append(tile, info, stageNode);
    const eta = job.progress?.etaSeconds;
    const etaText = Number.isFinite(eta) && eta > 0 ? `~${durationText(eta)}` : view.remaining ? job.progress?.etaReason === 'stalled' ? 'Veri bekleniyor' : job.progress?.etaReason === 'unknown-size' || job.progress?.etaReason === 'estimate-exceeded' ? 'Bilinmiyor' : 'Hesaplanıyor' : '';
    for (const [name, text, description] of [['size', view.size, `Boyut: ${view.size}`], ['speed', view.speed || '', `Hız: ${view.speed || 'Aktarım yok'}`], ['eta', etaText, view.remaining || stage]]) {
      const cell = el('span', `compact-cell compact-${name}`, text); cell.title = description; cell.setAttribute('aria-label', description); top.append(cell);
    }
    const actions = el('div', 'job-actions');
    const addAction = (action, text, disabled = false) => {
      const button = el('button', 'btn icon-only ghost'); button.title = text; button.setAttribute('aria-label', text); button.append(icon({ pause: 'pause', resume: 'play', cancel: 'x', 'start-now': 'bolt' }[action])); button.disabled = queueBusy || disabled;
      button.dataset.jobAction = `${job.id}-${action}`;
      button.addEventListener('click', () => action === 'cancel'
        ? confirmQueue({ type: 'bulk', action, ids: [job.id] }, 'İndirmeyi iptal et?', 'İndirme iptal edilir. Dosyalar ve yarım veriler silinmez.')
        : runQueueCommand({ type: 'single', action, id: job.id }));
      actions.append(button);
    };
    if (job.status === 'held') addAction('start-now', 'Şimdi başlat');
    if (canPause(job)) addAction('pause', 'Duraklat');
    if (canResume(job)) addAction('resume', 'Devam et');
    if (canCancel(job)) addAction('cancel', 'İptal');
    const detailButton = el('button', 'btn icon-only ghost job-details-toggle'); detailButton.append(icon('chevron')); detailButton.title = 'Ayrıntıları aç / kapat'; detailButton.setAttribute('aria-label', 'İndirme ayrıntıları'); detailButton.setAttribute('aria-expanded', String(expandedJobs.has(job.id))); detailButton.setAttribute('aria-controls', details.id); detailButton.dataset.jobAction = `${job.id}-details`;
    detailButton.addEventListener('click', () => { if (expandedJobs.has(job.id)) expandedJobs.delete(job.id); else expandedJobs.add(job.id); card.classList.toggle('details-open', expandedJobs.has(job.id)); detailButton.setAttribute('aria-expanded', String(expandedJobs.has(job.id))); });
    actions.append(detailButton);
    const moreButton = el('button', 'btn icon-only ghost'); moreButton.type = 'button'; moreButton.append(icon('more')); moreButton.title = 'Diğer işlemler'; moreButton.setAttribute('aria-label', 'Diğer işlemler'); moreButton.setAttribute('aria-haspopup', 'menu'); moreButton.dataset.jobAction = `${job.id}-more`;
    moreButton.addEventListener('click', () => { const r = moreButton.getBoundingClientRect(); openRowMenu(job.id, r.right, r.bottom, moreButton); });
    actions.append(moreButton);
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      const from = event.target.closest?.('button') || null, r = from?.getBoundingClientRect();
      if (event.clientX === 0 && event.clientY === 0 && r) openRowMenu(job.id, r.left, r.bottom, from); else openRowMenu(job.id, event.clientX, event.clientY, from || moreButton);
    });
    if (globalThis.hypernabDesktop) {
      if (canPlayFile(job)) {
        const play = el('button', 'btn icon-only ghost'); play.title = 'Oynat'; play.setAttribute('aria-label', 'Oynat'); play.append(icon('play')); play.dataset.jobAction = `${job.id}-play`;
        play.addEventListener('click', async () => {
          play.disabled = true;
          try { await globalThis.hypernabDesktop.action('job-play', job.id); }
          catch (error) { queueMessage(error.message, true); }
          finally { play.disabled = false; }
        });
        actions.prepend(play);
      }
      const folder = el('button', 'btn icon-only ghost'); folder.title = 'Dosya konumunu aç'; folder.setAttribute('aria-label', 'Dosya konumunu aç'); folder.append(icon('folder'));
      folder.dataset.jobLocation = job.id;
      folder.addEventListener('click', async () => {
        folder.disabled = true;
        try { await globalThis.hypernabDesktop.action('job-location', job.id); }
        catch { queueMessage('Dosya konumu açılamadı. Klasör taşınmış veya indirme kaydı kaldırılmış olabilir.', true); }
        finally { folder.disabled = false; }
      });
      actions.append(folder);
    }
    if (actions.childElementCount) top.append(actions);
    card.append(top);
    if (job.status === 'running') {
      const progress = el('div', 'progress');
      // Avoid inline styles under strict CSP; SVG width is a presentation attribute.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '100%'); svg.setAttribute('height', '5');
      const rect = document.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('width', `${view.percent ?? 0}%`);
      rect.setAttribute('height', '5'); svg.append(rect); progress.append(svg); card.append(progress);
    }
    if (view.remaining) card.append(el('div', 'job-file job-remaining', view.remaining));
    if (job.error) card.append(el('div', 'job-error', job.error));
    if (job.notice) card.append(el('div', 'job-error', job.notice));
    if (job.transfer?.resumeReason) card.append(el('div', 'job-error', job.transfer.resumeReason));
    if (job.verification) {
      const v = job.verification;
      const description = v.status === 'passed' ? `${v.level === 'bytes' ? v.sizeCompared ? 'Dosya boyutu doğrulandı' : 'Dosya çıktısı kontrol edildi' : v.sizeCompared ? 'Dosya boyutu ve medya yapısı doğrulandı' : 'Medya yapısı doğrulandı'}${v.deep ? ' · Derin tarama tamamlandı' : ''}${v.sha256 ? ' · SHA-256 eşleşti' : ''}`
        : v.status === 'limited' ? 'Sınırlı doğrulama: medya yapısı kontrol edilemedi.' : v.status === 'failed' ? 'Doğrulama başarısız; dosya tamamlandı sayılmadı.' : v.status === 'paused' ? 'Doğrulama duraklatıldı.' : 'Dosya doğrulaması sürüyor…';
      (['failed', 'limited'].includes(v.status) ? card : details).append(el('div', `job-verification ${v.status}`, description));
    }
    if (job.status === 'cancelled') details.append(el('div', 'job-file', job.settling ? 'İşlem kapanıyor; ardından kayıt listeden kaldırılabilir. Dosyalar korunur.' : 'İptal edilmiş kayıt listeden kaldırılabilir; dosyalar korunur.'));
    else if (['failed', 'interrupted'].includes(job.status) && !job.canClear) card.append(el('div', 'job-file', 'Yarım iş korunuyor. Listeden kaldırmak için önce iptal et; dosyalar silinmez.'));
    if (job.status === 'paused' && (job.transfer?.method === 'single-http' || job.transfer?.resumeSupported === false)) card.append(el('div', 'job-error', 'Veriler korunuyor. Bu kaynakta devam ederken aktarım baştan başlayabilir.'));
    if (['parallel-http', 'parallel-streams'].includes(job.transfer?.method) && job.transfer.connections) {
      const transferFacts = [`${job.status === 'completed' ? 'En çok ' : ''}${job.transfer.connections} bağlantı · ${job.transfer.method === 'parallel-streams' ? 'Uyarlanabilir görüntü + ses' : 'Uyarlanabilir HTTP'}`];
      if (job.status === 'running' && job.transfer.targetConnections) transferFacts.push(`Hedef ${job.transfer.targetConnections}/${job.transfer.maxConnections || 8}`);
      if (job.transfer.resumedBytes) transferFacts.push(`${fmt(job.transfer.resumedBytes)} korunmuş parçadan devam`);
      if (job.transfer.splits) transferFacts.push(`${job.transfer.splits} dinamik bölme`);
      if (job.transfer.reductions) transferFacts.push(`${job.transfer.reductions} bağlantı azaltma`);
      if (job.status === 'completed' && job.transfer.averageSpeed) transferFacts.push(`Ortalama ${fmt(job.transfer.averageSpeed)}/sn · Son aktarım ${Math.round(job.transfer.attemptElapsedSeconds ?? job.transfer.elapsedSeconds)} sn`);
      if (job.transfer.reusedExisting) transferFacts.push('Mevcut dosyayla SHA-256 eşleşti');
      if (job.media) transferFacts.push(`${job.media.height ? `${job.media.height}p · Görüntü` : 'Medya'}${job.media.audio ? ' ve ses' : ''} doğrulandı`);
      details.append(el('div', 'job-file', transferFacts.join(' · ')));
    }
    if (job.recovery?.length && expandedJobs.has(job.id)) {
      const eventNames = { resolve: 'Kaynak çözümleme', 'source-refresh': 'Kaynak adresi yenilendi', 'probe-retry': 'Hızlı bağlantı tekrar denendi', 'fast-selected': 'Hızlı HTTP yolu seçildi', 'hls-selected': 'HLS yolu seçildi', 'hls-retry': 'HLS isteği tekrar denendi', 'native-selected': 'Standart medya motoruna geçildi', 'automatic-retry': 'İndirme otomatik tekrarlandı', 'transfer-observed': 'İlk aktarım ölçümü' };
      const reasonNames = { network: 'geçici bağlantı sorunu', http: 'geçici sunucu yanıtı', incomplete: 'eksik parça', range: 'güvenli byte-range doğrulanamadı', 'source-refused': 'yenilenen kaynak da reddedildi', protocol: 'kaynak yapısı standart motor gerektiriyor' };
      for (const item of job.recovery.slice(-6)) {
        if (!eventNames[item.event]) continue;
        const facts = [eventNames[item.event], reasonNames[item.reason], item.status ? `HTTP ${item.status}` : null, item.delayMs ? `${(item.delayMs / 1000).toLocaleString('tr-TR')} sn bekleme` : null, item.event === 'transfer-observed' && Number.isFinite(item.elapsedMs) ? `başlangıçtan ${(item.elapsedMs / 1000).toLocaleString('tr-TR')} sn sonra` : null];
        details.append(el('div', 'job-file', facts.filter(Boolean).join(' · ')));
      }
    }
    if (job.subtitleResult) {
      const s = job.subtitleResult;
      const names = (s.tracks || []).map(track => track.name).join(', ');
      const text = s.mode === 'embedded' ? `Altyazı: ${names} (videoya gömülü)` : s.mode === 'sidecar' ? `Altyazı: ${names} (yan dosya: ${(s.files || []).join(', ')})` : s.note;
      const line = el('div', `job-file${s.mode === 'none' ? ' job-error' : ''}`, [text, s.mode !== 'none' && s.note ? s.note : null].filter(Boolean).join(' · '));
      // The result of a download is worth seeing in the row itself, not only in the details.
      (s.mode === 'none' ? card : details).append(line);
    }
    if (job.file) details.append(el('div', 'job-file', job.directory ? `${job.directory}\\${job.file}` : job.file));
    card.append(details);
    fragment.append(card);
  }
  $('jobs').replaceChildren(fragment);
  renderSelection();
  if (focusedJob) $('jobs').querySelector(`[data-job-select="${focusedJob}"]`)?.focus({ preventScroll: true });
  if (focusedMove) $('jobs').querySelector(`[data-job-move="${focusedMove}"]`)?.focus({ preventScroll: true });
  if (focusedLocation) $('jobs').querySelector(`[data-job-location="${focusedLocation}"]`)?.focus({ preventScroll: true });
  if (focusedAction) $('jobs').querySelector(`[data-job-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}

async function commitOrder(ids, focusId) {
  if (queueBusy) return;
  queueBusy = true; render();
  try {
    await api('/api/queue/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
    await Promise.all([refresh(), status()]);
    queueMessage('Sıra kaydedildi. Çalışan indirmeler yeni önceliğe göre ayarlanıyor.');
  } catch (error) { queueMessage(error.message, true); }
  finally {
    queueBusy = false; render();
    $('jobs').querySelector(`[data-job-move="${focusId}"]`)?.focus({ preventScroll: true });
  }
}
function clearDropMarks() { $('jobs').querySelectorAll('.drop-before,.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after')); }
function updateDragTarget() {
  const drag = dragging;
  if (!drag?.moved) return;
  clearDropMarks(); drag.target = null;
  const rows = [...$('jobs').querySelectorAll('.job')].filter(row => row.dataset.jobId !== drag.id);
  if (!rows.length) return;
  const row = rows.find(row => drag.y < row.getBoundingClientRect().bottom) || rows.at(-1);
  const rect = row.getBoundingClientRect();
  drag.target = row.dataset.jobId; drag.before = drag.y < rect.top + rect.height / 2;
  row.classList.add(drag.before ? 'drop-before' : 'drop-after');
}
function finishDrag(cancelled = false) {
  const drag = dragging; if (!drag) return;
  dragging = null; cancelAnimationFrame(drag.frame); clearDropMarks();
  document.body.classList.remove('reordering');
  drag.handle.closest('.job')?.classList.remove('dragging');
  if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  if (!cancelled && drag.moved && drag.target) void commitOrder(moveVisible(jobs, filter, drag.id, drag.target, drag.before), drag.id);
  else render();
}
function bindReorder(handle, id) {
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || queueBusy || dragging) return;
    event.preventDefault();
    if (!reorderAllowed()) return queueMessage('Arama veya görsel sıralama açıkken kuyruk sırası değiştirilemez. Önce “Kuyruk sırasına dön” de.', true);
    const visible = visibleJobs(jobs, filter), at = visible.findIndex(job => job.id === id), delta = event.key === 'ArrowUp' ? -1 : 1;
    const target = visible[at + delta];
    if (target) void commitOrder(moveVisible(jobs, filter, id, target.id, delta < 0), id);
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || queueBusy || dragging) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    if (!reorderAllowed()) return queueMessage('Arama veya görsel sıralama açıkken kuyruk sırası değiştirilemez. Önce “Kuyruk sırasına dön” de.', true);
    dragging = { id, handle, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, moved: false, target: null, frame: null };
    handle.setPointerCapture(event.pointerId);
    const tick = () => {
      const drag = dragging; if (!drag) return;
      if (drag.moved) {
        // The list scrolls inside itself in the full-window layout; otherwise the page does.
        const list = $('job-list'), inner = list.scrollHeight > list.clientHeight + 1 && getComputedStyle(list).overflowY !== 'visible';
        const box = inner ? list.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }, edge = 72;
        const delta = drag.y < box.top + edge ? -Math.min(16, (box.top + edge - drag.y) / 4) : drag.y > box.bottom - edge ? Math.min(16, (drag.y - box.bottom + edge) / 4) : 0;
        if (delta) { if (inner) list.scrollBy(0, delta); else window.scrollBy(0, delta); }
        updateDragTarget();
      }
      drag.frame = requestAnimationFrame(tick);
    };
    dragging.frame = requestAnimationFrame(tick);
  });
  handle.addEventListener('pointermove', event => {
    if (dragging?.handle !== handle || dragging.pointerId !== event.pointerId) return;
    dragging.y = event.clientY;
    if (!dragging.moved && Math.abs(event.clientY - dragging.startY) > 5) {
      dragging.moved = true; document.body.classList.add('reordering'); handle.closest('.job').classList.add('dragging');
    }
    updateDragTarget();
  });
  handle.addEventListener('pointerup', () => { if (dragging?.handle === handle) finishDrag(); });
  for (const event of ['pointercancel', 'lostpointercapture']) handle.addEventListener(event, () => { if (dragging?.handle === handle) finishDrag(true); });
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && dragging) { event.preventDefault(); finishDrag(true); } });
function queueMessage(text, error = false) { $('queue-message').textContent = text; $('queue-message').className = error ? 'error' : ''; }
function renderSelection() {
  const visible = shownJobs(), scope = selectedShown(), state = selectionState(jobs, visible, scope);
  $('select-all').checked = state.all; $('select-all').indeterminate = state.mixed;
  $('select-all').disabled = queueBusy || !visible.length;
  const hiddenSelected = selected.size - scope.size;
  $('selected-count').textContent = `${state.count} seçili${hiddenSelected ? ` · ${hiddenSelected} gizli (işleme dahil değil)` : ''}`;
  $('selection-actions').hidden = !state.count;
  for (const [id, enabled] of [['pause-selected', state.pause], ['resume-selected', state.resume], ['cancel-selected', state.cancel], ['clear-selected', state.clear], ['deselect-all', state.count]]) $(id).disabled = queueBusy || !enabled;
  // Both bulk buttons stay clickable: there is no queue-wide pause mode to toggle.
  $('pause-all').disabled = queueBusy;
  $('resume-all').disabled = queueBusy;
  $('clear-queue').disabled = queueBusy || !jobs.some(job => job.canClear);
}
async function runQueueCommand(command) {
  if (queueBusy) return;
  queueBusy = true; render();
  try {
    let result;
    if (command.type === 'clear') result = await api('/api/queue/clear', { method: 'POST', body: JSON.stringify({ ids: command.ids }) });
    else if (command.type === 'single') result = await api(`/api/jobs/${command.id}/${command.action}`, { method: 'POST', body: '{}' });
    else result = await api('/api/queue/bulk', { method: 'POST', body: JSON.stringify({ action: command.action, ...(command.all ? { all: true } : { ids: command.ids }) }) });
    const actionText = { pause: 'duraklatıldı', resume: 'devam etmek üzere sıraya alındı', cancel: 'iptal edildi', 'start-now': 'hemen başlatıldı' };
    const nothing = { pause: 'Duraklatılacak aktif veya sıradaki indirme yok.', resume: 'Devam ettirilecek duraklatılmış indirme yok.', cancel: 'İptal edilecek indirme yok.' };
    if (command.type === 'bulk' && command.all && !result.changed) queueMessage(nothing[command.action]);
    else queueMessage(command.type === 'clear' ? `${result.removed} kayıt listeden kaldırıldı. İndirilen dosyalar ve yarım dosyalar silinmedi.` : command.action === 'retry' ? 'İndirme yeniden kuyruğa alındı.' : `${result.changed ?? 1} indirme ${actionText[command.action]}.${result.skipped ? ` ${result.skipped} uygun olmayan kayıt atlandı.` : ''}`);
    await Promise.all([refresh(), status()]);
  } catch (error) { queueMessage(error.message, true); }
  finally { queueBusy = false; render(); }
}
// "Bir daha sorma": remembered per kind of action (cancel / clear list) in this browser only. Nothing here deletes files.
const confirmKind = command => command.type === 'clear' ? 'clear' : 'cancel';
const skipKey = kind => `hypernab-skip-confirm-${kind}`;
const skipping = kind => { try { return localStorage.getItem(skipKey(kind)) === '1'; } catch { return false; } };
// One-time carry-over of the choice saved under the product's former name (HyperDown).
try { for (const kind of ['cancel', 'clear']) { const old = `hyperdown-skip-confirm-${kind}`; if (localStorage.getItem(old) === '1' && localStorage.getItem(skipKey(kind)) === null) localStorage.setItem(skipKey(kind), '1'); localStorage.removeItem(old); } } catch { /* storage unavailable */ }
function showResetConfirms() { $('reset-confirms').hidden = !(skipping('cancel') || skipping('clear')); }
function confirmQueue(command, title, text) {
  if (queueBusy || $('queue-confirm').open) return;
  if (skipping(confirmKind(command))) { runQueueCommand(command); return; }
  pendingQueueCommand = command;
  $('queue-confirm-title').textContent = title; $('queue-confirm-text').textContent = text; $('queue-confirm-skip').checked = false;
  $('queue-confirm').showModal(); $('queue-confirm-cancel').focus();
}
$('queue-confirm-cancel').addEventListener('click', () => $('queue-confirm').close());
$('queue-confirm').addEventListener('close', () => { pendingQueueCommand = null; });
$('queue-confirm-accept').addEventListener('click', () => {
  const command = pendingQueueCommand; pendingQueueCommand = null; $('queue-confirm').close();
  if (command && $('queue-confirm-skip').checked) { try { localStorage.setItem(skipKey(confirmKind(command)), '1'); } catch { /* storage unavailable: just ask again next time */ } showResetConfirms(); }
  if (command) runQueueCommand(command);
});
$('reset-confirms').addEventListener('click', () => { try { localStorage.removeItem(skipKey('cancel')); localStorage.removeItem(skipKey('clear')); } catch { /* nothing stored */ } showResetConfirms(); });
showResetConfirms();
$('select-all').addEventListener('change', event => {
  for (const job of shownJobs()) { if (event.target.checked) selected.add(job.id); else selected.delete(job.id); }
  render();
});
$('deselect-all').addEventListener('click', () => { selected.clear(); render(); });
$('pause-all').addEventListener('click', () => runQueueCommand({ type: 'bulk', action: 'pause', all: true }));
$('resume-all').addEventListener('click', () => runQueueCommand({ type: 'bulk', action: 'resume', all: true }));
for (const action of ['pause', 'resume', 'cancel']) $(`${action}-selected`).addEventListener('click', () => {
  const command = { type: 'bulk', action, ids: [...selectedShown()] };
  if (action === 'cancel') confirmQueue(command, 'Seçili indirmeler iptal edilsin mi?', 'Seçili devam eden veya başarısız işler iptal edilir. Ardından kayıtları listeden kaldırabilirsin. Hiçbir dosya silinmez.');
  else runQueueCommand(command);
});
function requestClear(onlySelected) {
  const scope = selectedShown();
  const ids = jobs.filter(job => job.canClear && (onlySelected ? scope.has(job.id) : true)).map(job => job.id);
  if (!ids.length) return;
  confirmQueue({ type: 'clear', ids }, 'Yalnızca liste kayıtları temizlensin mi?', `${ids.length} bitmiş veya iptal edilmiş kayıt listeden kaldırılacak.\nİndirilen dosyalar ve yarım dosyalar silinmez. Aktif, sıradaki, duraklatılmış ve kesintiye uğramış kayıtlar korunur.`);
}
$('clear-queue').addEventListener('click', () => requestClear(false));
$('clear-selected').addEventListener('click', () => requestClear(true));
// ---------- Column layout: header, resize handles, visibility, focus view (saved in app settings) ----------
const sortableBy = { name: 'name', size: 'size', state: 'status' };
const defaultDir = { name: 'asc', size: 'desc', status: 'asc', date: 'desc', queue: 'asc' };
function buildHeader() {
  const head = $('job-columns'); head.replaceChildren(el('span'), el('span'));
  for (const column of visibleColumns(effective)) {
    const cell = el('div', 'col-head'); cell.dataset.col = column.id; cell.setAttribute('role', 'columnheader');
    const key = sortableBy[column.id];
    if (key) {
      const button = el('button', 'col-sort'); button.type = 'button'; button.append(el('span', '', column.label));
      if (sortKey === key) { button.append(icon('sort')); button.lastChild.classList.add('sm', sortDir === 'asc' ? 'asc' : 'desc'); cell.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending'); }
      button.title = `${column.label} sütununa göre sırala (yalnızca görünüm; indirme sırası değişmez)`;
      // First click: natural direction; second: reverse; third: back to the real queue order.
      button.addEventListener('click', () => {
        if (sortKey !== key) setSort(key, defaultDir[key]);
        else if (sortDir === defaultDir[key]) setSort(key, sortDir === 'asc' ? 'desc' : 'asc');
        else setSort('queue', 'asc');
      });
      cell.append(button);
    } else cell.append(el('span', 'col-sort static', column.label));
    const grip = el('span', 'col-resize'); grip.tabIndex = 0; grip.dataset.col = column.id;
    grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', `${column.label} sütun genişliği`);
    grip.title = 'Sürükleyerek genişlet · çift tıkla sığdır · ← → ile ayarla · Home otomatik';
    bindResize(grip, column.id); cell.append(grip); head.append(cell);
  }
  head.append(el('span', 'col-actions', 'İşlemler'));
  head.setAttribute('aria-hidden', 'false');
}
// `layout` is what the user saved; `effective` also hides Kalan/Hız for now when the window is too narrow (automatic mode only).
let effective = layout;
function applyLayout({ rebuild = true } = {}) {
  const list = $('job-list'), width = list.clientWidth;
  const stacked = getComputedStyle($('job-columns')).display === 'none'; // small window / Normal view: rows are stacked, keep every value
  const next = stacked ? layout : effectiveLayout(layout, width), changed = next.hidden.join() !== effective.hidden.join();
  effective = next; rebuild = rebuild || changed;
  list.style.setProperty('--job-columns', gridTemplate(effective, width));
  list.style.setProperty('--job-min', `${minimumWidth(effective, width)}px`);
  for (const column of COLUMNS) list.classList.toggle(`hide-${column.id}`, effective.hidden.includes(column.id));
  $('layout-mode').textContent = isAuto(layout) ? 'Düzen: Otomatik (pencereye uyar)' : 'Düzen: Elle ayarlı';
  document.documentElement.dataset.focus = layout.focus ? 'on' : 'off';
  $('focus-toggle').setAttribute('aria-pressed', String(layout.focus));
  $('focus-toggle').title = layout.focus ? 'Odak görünümünden çık' : 'Odak görünümü (bağlantı alanını gizle)';
  for (const box of document.querySelectorAll('[data-col]')) if (box.matches('input')) box.checked = !layout.hidden.includes(box.dataset.col);
  if (rebuild) buildHeader();
  for (const grip of $('job-columns').querySelectorAll('.col-resize')) {
    const column = COLUMNS.find(c => c.id === grip.dataset.col), cell = grip.parentElement;
    grip.setAttribute('aria-valuemin', String(column.min)); grip.setAttribute('aria-valuemax', '1600');
    grip.setAttribute('aria-valuenow', String(Math.round(cell.getBoundingClientRect().width)));
  }
}
async function saveLayout() {
  clearTimeout(layoutTimer); layoutTimer = null; layoutPending = true;
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ listLayout: layout }) }); }
  catch (error) { queueMessage(error.message, true); }
  finally { layoutPending = false; }
}
const saveLayoutSoon = () => { clearTimeout(layoutTimer); layoutTimer = setTimeout(saveLayout, 400); };
const changeLayout = (next, save = true) => { layout = normalizeLayout(next); applyLayout({ rebuild: false }); if (save) void saveLayout(); };
// Other tabs / a restart: take the saved layout unless this window is in the middle of changing it.
globalThis.HypernabLayoutSync = value => {
  if (resizing || layoutPending || layoutTimer) return;
  const next = normalizeLayout(value);
  if (!sameLayout(next, layout)) { layout = next; applyLayout(); }
};
function currentWidth(id) { return $('job-columns').querySelector(`.col-head[data-col="${id}"]`)?.getBoundingClientRect().width ?? COLUMNS.find(c => c.id === id).auto; }
// Every visible column gets its current pixel width first, so only the dragged boundary moves (it follows the pointer).
function frozenLayout() {
  const widths = { ...layout.widths };
  for (const column of visibleColumns(effective)) widths[column.id] = clampWidth(column.id, currentWidth(column.id));
  return normalizeLayout({ ...layout, widths });
}
function setWidth(id, width, save, base = frozenLayout()) {
  const widths = { ...base.widths, [id]: clampWidth(id, width) };
  layout = normalizeLayout({ ...base, widths }); applyLayout({ rebuild: false }); if (save) saveLayoutSoon();
}
function textWidth(node) { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().width; }
function fitColumn(id) {
  const selector = { name: '.job-title', size: '.compact-size', speed: '.compact-speed', eta: '.compact-eta', state: '.job-state' }[id];
  const head = $('job-columns').querySelector(`.col-head[data-col="${id}"] .col-sort`);
  const samples = [...$('jobs').querySelectorAll(selector)].map(textWidth);
  samples.push(head ? textWidth(head) + 26 : 0);
  setWidth(id, fitWidth(id, samples), false); void saveLayout();
}
function bindResize(grip, id) {
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || resizing) return;
    event.preventDefault(); event.stopPropagation(); grip.focus({ preventScroll: true });
    resizing = { id, grip, pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidth(id), before: layout, base: frozenLayout() };
    grip.setPointerCapture(event.pointerId); document.body.classList.add('col-resizing');
  });
  grip.addEventListener('pointermove', event => {
    if (resizing?.grip !== grip || resizing.pointerId !== event.pointerId) return;
    setWidth(id, resizing.startWidth + event.clientX - resizing.startX, false, resizing.base);
  });
  const finish = cancelled => {
    if (resizing?.grip !== grip) return;
    const { before } = resizing; resizing = null; document.body.classList.remove('col-resizing');
    if (cancelled) { layout = before; applyLayout({ rebuild: false }); } else void saveLayout();
  };
  grip.addEventListener('pointerup', () => finish(false));
  for (const name of ['pointercancel', 'lostpointercapture']) grip.addEventListener(name, () => finish(true));
  grip.addEventListener('dblclick', event => { event.preventDefault(); fitColumn(id); });
  grip.addEventListener('keydown', event => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(id, currentWidth(id) + (event.key === 'ArrowRight' ? step : -step), true); }
    else if (event.key === 'Home') { event.preventDefault(); const widths = { ...layout.widths }; delete widths[id]; changeLayout({ ...layout, widths }); }
    else if (event.key === 'Enter') { event.preventDefault(); fitColumn(id); }
  });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && resizing) { event.preventDefault(); const { grip, before } = resizing; resizing = null; document.body.classList.remove('col-resizing'); layout = before; applyLayout({ rebuild: false }); grip.blur(); }
});
for (const box of document.querySelectorAll('input[data-col]')) box.addEventListener('change', () => {
  const hidden = box.checked ? layout.hidden.filter(id => id !== box.dataset.col) : [...layout.hidden, box.dataset.col];
  changeLayout({ ...layout, hidden }); buildHeader(); applyLayout({ rebuild: false });
});
// Fit to this window: automatic distribution (Name takes the room); hidden columns stay hidden.
$('layout-fit').addEventListener('click', () => {
  changeLayout({ ...layout, widths: {} }); applyLayout();
});
$('layout-reset').addEventListener('click', () => { changeLayout({ widths: {}, hidden: [], focus: layout.focus }); applyLayout(); });
$('focus-toggle').addEventListener('click', () => changeLayout({ ...layout, focus: !layout.focus }));
// ---------- Search (Ctrl+F) and visual sort ----------
function renderListNotice(shown, total) {
  const notes = [];
  if (search.trim()) notes.push(`${shown} / ${total} kayıt gösteriliyor`);
  if (sortKey !== 'queue') notes.push(`Sıralama: ${sortLabels[sortKey]} (${sortDir === 'asc' ? 'artan' : 'azalan'})`);
  if (notes.length) notes.push('Bunlar yalnızca görünümü değiştirir; indirme önceliği ve çalışan işler aynı kalır.');
  $('list-notice').textContent = notes.join(' · '); $('list-notice').hidden = !notes.length;
}
function setSort(key, dir) {
  sortKey = key; sortDir = dir;
  $('list-sort').value = key; $('sort-direction').hidden = $('sort-reset').hidden = key === 'queue';
  $('sort-direction').setAttribute('aria-label', `Sıralama yönü: ${dir === 'asc' ? 'artan' : 'azalan'}`);
  $('sort-direction').querySelector('svg').classList.toggle('flip', dir === 'asc');
  buildHeader(); applyLayout({ rebuild: false }); render();
}
$('list-sort').addEventListener('change', () => setSort($('list-sort').value, defaultDir[$('list-sort').value]));
$('sort-direction').addEventListener('click', () => setSort(sortKey, sortDir === 'asc' ? 'desc' : 'asc'));
$('sort-reset').addEventListener('click', () => { setSort('queue', 'asc'); queueMessage('Kuyruk sırasına dönüldü; sürükleyerek öncelik verebilirsin.'); });
$('list-search').addEventListener('input', () => { search = $('list-search').value; render(); });
$('list-search').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  if ($('list-search').value) { $('list-search').value = ''; search = ''; render(); } else $('list-search').blur();
});
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f') return;
  if ($('view-downloads').hidden || document.querySelector('dialog[open]')) return;
  event.preventDefault(); $('list-search').focus(); $('list-search').select();
});
// ---------- Row menu: right click, Shift+F10 / Menu key, or the ⋯ button ----------
let menuJob = null;
function closeRowMenu(restore = true) {
  const id = menuJob; menuJob = null; $('row-menu').hidden = true; $('row-menu').replaceChildren();
  if (restore && id) $('jobs').querySelector(`[data-job-action="${id}-more"]`)?.focus({ preventScroll: true });
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); queueMessage(`${what} kopyalandı.`); }
  catch { queueMessage('Panoya erişilemedi. Tarayıcıda panoya erişime izin ver.', true); }
}
function openRowMenu(id, x, y) {
  const job = jobs.find(item => item.id === id); if (!job) return;
  closeRowMenu(false); menuJob = id;
  const menu = $('row-menu'), title = job.title === 'video' ? job.host : job.title;
  const item = (name, label, run, disabled = false) => {
    const button = el('button', 'menu-item'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = disabled;
    button.append(icon(name), el('span', '', label)); button.addEventListener('click', () => { closeRowMenu(); void run(); }); menu.append(button);
  };
  if (globalThis.hypernabDesktop) item('folder', 'Dosya konumunu aç', async () => { try { await globalThis.hypernabDesktop.action('job-location', id); } catch { queueMessage('Dosya konumu açılamadı. Klasör taşınmış veya indirme kaydı kaldırılmış olabilir.', true); } });
  if (globalThis.hypernabDesktop && canPlayFile(job)) item('play', 'Oynat', async () => { try { await globalThis.hypernabDesktop.action('job-play', id); } catch (error) { queueMessage(error.message, true); } });
  item('copy', 'Adı kopyala', () => copyText(title, 'Ad'));
  if (job.file) item('copy', 'Dosya yolunu kopyala', () => copyText(job.directory ? `${job.directory}\\${job.file}` : job.file, 'Dosya yolu'));
  if (job.status === 'held') item('bolt', 'Şimdi başlat', () => runQueueCommand({ type: 'single', action: 'start-now', id }), queueBusy);
  if (canPause(job)) item('pause', 'Duraklat', () => runQueueCommand({ type: 'single', action: 'pause', id }), queueBusy);
  if (canResume(job)) item('play', 'Devam et', () => runQueueCommand({ type: 'single', action: 'resume', id }), queueBusy);
  if (canCancel(job)) item('x', 'İptal et', () => confirmQueue({ type: 'bulk', action: 'cancel', ids: [id] }, 'İndirmeyi iptal et?', 'İndirme iptal edilir. Dosyalar ve yarım veriler silinmez.'), queueBusy);
  item('chevron', expandedJobs.has(id) ? 'Ayrıntıları gizle' : 'Ayrıntıları göster', () => { if (expandedJobs.has(id)) expandedJobs.delete(id); else expandedJobs.add(id); render(); });
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.setProperty('left', `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`);
  menu.style.setProperty('top', `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`);
  menu.querySelector('button:not(:disabled)')?.focus();
}
$('row-menu').addEventListener('keydown', event => {
  const items = [...$('row-menu').querySelectorAll('button:not(:disabled)')], at = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); closeRowMenu(); }
  else if (event.key === 'Tab') closeRowMenu(false);
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
document.addEventListener('pointerdown', event => { if (menuJob && !event.target.closest('#row-menu')) closeRowMenu(false); }, true);
$('job-list').addEventListener('scroll', () => { if (menuJob) closeRowMenu(false); });
window.addEventListener('resize', () => { if (menuJob) closeRowMenu(false); });
window.addEventListener('blur', () => { if (menuJob) closeRowMenu(false); });
// ---------- Possible duplicate: same source and same quality already in the list ----------
const duplicateStatus = { running: 'iniyor', queued: 'sırasını bekliyor', held: 'sonra eklenenlerde', paused: 'duraklatıldı', interrupted: 'kesintiye uğradı', completed: 'tamamlandı' };
let duplicateAsk = null;
function showDuplicate(duplicates, mode) {
  duplicateAsk = { ids: duplicates.map(item => item.id), mode };
  const lines = duplicates.slice(-3).map(item => `• ${item.title === 'video' ? 'İsimsiz video' : item.title}${item.formatLabel ? ` · ${item.formatLabel}` : ''} — ${duplicateStatus[item.status] || item.status}`);
  $('duplicate-text').textContent = `Aynı kaynak ve aynı kalite zaten var:\n${lines.join('\n')}\nİstersen mevcut işi göster; bilerek ikinci bir kopya da indirebilirsin. Mevcut dosyalar silinmez veya üzerine yazılmaz.`;
  $('duplicate-dialog').showModal(); $('duplicate-show').focus();
}
$('duplicate-cancel').addEventListener('click', () => { duplicateAsk = null; $('duplicate-dialog').close(); });
$('duplicate-show').addEventListener('click', () => {
  const ids = duplicateAsk?.ids || []; duplicateAsk = null; $('duplicate-dialog').close();
  filter = 'all'; document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item.dataset.filter === 'all'));
  search = ''; $('list-search').value = ''; setSort('queue', 'asc');
  const row = $('jobs').querySelector(`[data-job-id="${ids.at(-1)}"]`);
  if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('job-new'); setTimeout(() => row.classList.remove('job-new'), 2500); }
});
$('duplicate-accept').addEventListener('click', () => { const mode = duplicateAsk?.mode; duplicateAsk = null; $('duplicate-dialog').close(); if (mode) void submitPending(mode, true); });
async function refresh() {
  jobs = await api('/api/jobs');
  const known = new Set(jobs.map(job => job.id));
  for (const id of selected) if (!known.has(id)) selected.delete(id);
  for (const id of expandedJobs) if (!known.has(id)) expandedJobs.delete(id);
  render();
  $('connection').textContent = '● Yerel bağlantı aktif';
}
async function status() {
  const info = await api('/api/status');
  renderSelection();
  for (const [id, enabled] of [['ytdlp-state', info.ytDlp], ['ffmpeg-state', info.ffmpeg]]) {
    $(id).textContent = enabled ? 'Hazır' : 'Kurulmadı'; $(id).className = `badge${enabled ? ' ok' : ''}`;
  }
  $('dir-current').textContent = info.directory;
  if (document.activeElement !== $('dir-input')) $('dir-input').value = info.directory;
  renderQueueBar(info.queue);
  selectedQueueName = info.queue.selectedQueue || 'Genel';
  advanced.render(info.queue);
  await advanced.poll();
}
$('download-form').addEventListener('submit', async event => {
  event.preventDefault(); $('add-button').disabled = true;
  try {
    pending = null; $('preview').hidden = true; message('Video adı ve formatları inceleniyor… (sayfa özel oynatıcı kullanıyorsa tarayıcıyla yakalama 1 dakikayı bulabilir)');
    const input = { url: $('url').value.trim(), title: $('title').value, engine: $('engine').value };
    const info = await api('/api/inspect', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(135000) });
    // Ignore a stale response if the user changed URL/motor while inspecting.
    if (input.url !== $('url').value.trim() || input.engine !== $('engine').value) return message('Bağlantı değişti; yeniden incele.');
    // A page captured through the browser is downloaded from the media request the player made, with its referer.
    pending = info.resolved ? { ...input, ...info.resolved } : input; inspected = info;
    renderQuality(info);
    if (!$('title').value) { $('title').value = info.title; autoTitle = info.title; }
    $('preview-title').textContent = info.title;
    const duration = info.duration ? `${Math.floor(info.duration / 60)} dk ${Math.round(info.duration % 60)} sn` : 'Süre bilinmiyor';
    // With a quality list, format and size belong to the selected option below; the source's own default pick would contradict it.
    $('preview-facts').textContent = info.options?.length
      ? [duration, `Mevcut çözünürlükler: ${info.heights.map(n => `${n}p`).join(', ')}`].join(' · ')
      : [info.extension?.toUpperCase() || 'Format bilinmiyor', info.filesize ? `${info.estimatedSize ? 'Yaklaşık ' : ''}${fmt(info.filesize)}` : 'Boyut bilinmiyor', duration, info.heights?.length ? info.heights.map(n => `${n}p`).join(', ') : 'Çözünürlük bilinmiyor', info.etaSeconds > 0 ? `Tahmini indirme: ${durationText(info.etaSeconds)} (geçmiş ölçüm)` : 'İndirme süresi henüz hesaplanamıyor'].join(' · ');
    $('preview-warning').textContent = info.warning || '';
    $('preview').hidden = false; message(info.options?.length ? 'Tercihlerine uygun kalite seçili. Değiştirip indirmeyi başlatabilirsin.' : 'Videoyu kontrol edip indirmeyi başlat.');
  } catch (error) {
    // A series / playlist address: offer its videos instead of an error.
    if (/oynatma listesi/.test(error.message) && $('engine').value !== 'direct') { try { await showPlaylist(); } catch (inner) { message(inner.message, true); } }
    else message(error.message, true);
  } finally { $('add-button').disabled = false; }
});
// A link dragged from the browser onto the window fills the address and starts the look-up (nothing downloads until the user chooses).
document.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].some(type => ['text/uri-list', 'text/plain'].includes(type))) event.preventDefault(); });
document.addEventListener('drop', event => {
  const text = (event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '').split(/\r?\n/).find(line => /^https?:\/\/\S+$/i.test(line.trim()));
  if (!text || $('view-downloads').hidden) return;
  event.preventDefault(); $('url').value = text.trim(); $('url').dispatchEvent(new Event('input')); $('download-form').requestSubmit();
});
// ---- Series / playlist: choose videos, they join the waiting queue named "Dizi - S01E03 - Başlık" ----
let playlist = null;
function hidePlaylist() { playlist = null; $('playlist').hidden = true; $('playlist-items').replaceChildren(); }
function playlistCount() {
  const count = playlist ? [...$('playlist-items').querySelectorAll('input:checked')].length : 0;
  $('playlist-add').disabled = !count; $('playlist-add').querySelector('span').textContent = count ? `Seçilen ${count} videoyu sıraya ekle` : 'Seçilenleri sıraya ekle';
  const boxes = [...$('playlist-items').querySelectorAll('input')]; $('playlist-all').checked = boxes.length > 0 && boxes.every(box => box.checked); $('playlist-all').indeterminate = count > 0 && !$('playlist-all').checked;
}
async function showPlaylist() {
  message('Liste okunuyor… (video sayısına göre birkaç saniye sürebilir)');
  const url = $('url').value.trim();
  const list = await api('/api/playlist', { method: 'POST', body: JSON.stringify({ url }), signal: AbortSignal.timeout(100000) });
  if (url !== $('url').value.trim()) return message('Bağlantı değişti; yeniden incele.');
  if (!list.entries.length) throw new Error('Bu listede indirilebilir video bulunamadı.');
  playlist = { url, ...list };
  $('playlist-title').textContent = list.title;
  $('playlist-facts').textContent = `${list.entries.length}${list.more ? '+' : ''} video · yalnızca listede olmayanlar seçili gelir`;
  const rows = list.entries.map((entry, at) => {
    const row = el('label', 'playlist-row'), box = el('input'); box.type = 'checkbox'; box.checked = !entry.duplicate; box.dataset.at = String(at);
    box.addEventListener('change', playlistCount);
    const minutes = entry.duration ? ` · ${Math.max(1, Math.round(entry.duration / 60))} dk` : '';
    row.append(box, el('span', 'playlist-name', entry.name), el('span', 'muted-text', entry.duplicate ? 'zaten listede' : minutes.slice(3)));
    row.title = entry.title; return row;
  });
  $('playlist-items').replaceChildren(...rows); $('preview').hidden = true; $('playlist').hidden = false; playlistCount();
  message(`${list.entries.length} video bulundu. Eklemek istediklerini seç.`);
}
$('playlist-all').addEventListener('change', () => { for (const box of $('playlist-items').querySelectorAll('input')) box.checked = $('playlist-all').checked; playlistCount(); });
$('playlist-close').addEventListener('click', hidePlaylist);
$('playlist-add').addEventListener('click', async () => {
  if (!playlist) return;
  const chosen = [...$('playlist-items').querySelectorAll('input:checked')].map(box => playlist.entries[Number(box.dataset.at)]);
  $('playlist-add').disabled = true;
  try {
    const result = await api('/api/playlist/add', { method: 'POST', body: JSON.stringify({ title: playlist.title, url: playlist.url, total: playlist.entries.length, entries: chosen.map(entry => ({ index: entry.index, title: entry.title, url: entry.url })), allowDuplicates: true }) });
    hidePlaylist(); $('url').value = '';
    message(`${result.added} video sıraya eklendi${result.skipped ? `, ${result.skipped} tanesi zaten listedeydi` : ''}${result.failed ? `, ${result.failed} tanesi eklenemedi` : ''}${result.full ? ' (kuyruk sınırına ulaşıldı)' : ''}. “Kuyruğu başlat” deyince sırayla iner.`, result.full || (!result.added && result.failed));
    await Promise.all([refresh(), status()]);
  } catch (error) { message(error.message, true); playlistCount(); }
});
// Two explicit choices: download at once (no limit) or add to the waiting list (run later with "Kuyruğu başlat").
async function submitPending(mode, confirmedDuplicate = false) {
  if (!pending) return;
  $('confirm-download').disabled = $('queue-download').disabled = true;
  try {
    const chosen = inspected?.options?.length ? $('format').value : undefined;
    if (!confirmedDuplicate) {
      // A failed check must never block the download itself.
      const found = await api('/api/duplicates', { method: 'POST', body: JSON.stringify({ url: pending.url, formatId: chosen }) }).catch(() => ({ duplicates: [] }));
      if (found.duplicates?.length) return showDuplicate(found.duplicates, mode);
    }
    const added = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ ...pending, title: $('title').value, quality: 'best', start: mode, formatId: chosen, deepVerify: $('deep-verify').checked, expectedSha256: $('expected-sha256').value.trim() || null }) });
    pending = null; inspected = null; autoTitle = ''; $('preview').hidden = true; $('url').value = ''; $('title').value = '';
    message(mode === 'queue' ? 'Sonra eklendi. Kuyruğu başlat dediğinde sırayla iner.' : 'İndirme başladı.');
    await Promise.all([refresh(), status()]);
    // New rows go to the bottom of the list: bring the new one into view and mark it for a moment.
    const row = $('jobs').querySelector(`[data-job-id="${added.id}"]`);
    if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); row.classList.add('job-new'); setTimeout(() => row.classList.remove('job-new'), 2500); }
  } catch (error) { message(error.message, true); } finally { $('confirm-download').disabled = $('queue-download').disabled = false; }
}
$('confirm-download').addEventListener('click', () => submitPending('now'));
$('queue-download').addEventListener('click', () => submitPending('queue'));
// Queue bar: how many run together (1–6, can be switched off), start/stop, reordering.
function renderQueueBar(queue) {
  if (!queue) return;
  $('queue-run-state').textContent = queue.waiting ? `${queue.waiting} indirme sırasını bekliyor${queue.held ? ` · ${queue.held} sonra eklenen` : ''}` : queue.held ? `Sırada ${queue.held}${queue.running ? ' · sırayla iniyor' : ''}` : queue.running ? 'Sıra çalışıyor' : 'Sıra boş';
  if (document.activeElement !== $('queue-limit')) $('queue-limit').value = String(queue.limit); // 1–6 or "all" (Hepsi)
  $('queue-toggle').replaceChildren(icon(queue.running ? 'stop' : 'play'), el('span', '', queue.running ? 'Kuyruğu durdur' : 'Kuyruğu başlat'));
  $('queue-toggle').classList.toggle('on', queue.running); $('queue-toggle').disabled = !queue.running && !queue.held;
}
async function queueCall(route, body) {
  try { await api(route, { method: 'POST', body: JSON.stringify(body || {}) }); await Promise.all([refresh(), status()]); }
  catch (error) { queueMessage(error.message, true); }
}
$('queue-limit').addEventListener('change', () => queueCall('/api/settings', { queueLimit: $('queue-limit').value === 'all' ? 'all' : Number($('queue-limit').value) }));
$('queue-toggle').addEventListener('click', () => queueCall($('queue-toggle').classList.contains('on') ? '/api/queue/stop' : '/api/queue/start'));
const sizeText = option => option.filesize ? `${option.sizeKind === 'exact' ? '' : 'Yaklaşık '}${fmt(option.filesize)}` : 'Boyut bilinmiyor';
const audioText = { included: 'Ses dahil', merged: 'Ses ayrı akıştan birleştirilir', none: 'Ses yok' };
function renderQuality(info) {
  const options = info.options || [], select = $('format');
  select.replaceChildren();
  const main = options.filter(option => option.recommended !== false), more = options.filter(option => option.recommended === false);
  const fill = (parent, list) => {
    for (const option of list) {
      const item = document.createElement('option');
      item.value = option.id; item.textContent = `${option.label} · ${sizeText(option)}`; // textContent: never markup
      parent.append(item);
    }
  };
  fill(select, main);
  if (more.length) { const group = document.createElement('optgroup'); group.label = 'Diğer biçimler'; fill(group, more); select.append(group); }
  if (options.length) select.value = info.defaultOptionId;
  $('quality-picker').hidden = !options.length;
  $('quality-count').textContent = options.length ? `(${main.length} seçenek${more.length ? ` + ${more.length} ek biçim` : ''})` : '';
  const note = info.qualityNote || (options.length ? '' : 'Kaynak ayrı kalite seçeneği sunmadı; kaynağın sunduğu en iyi format indirilecek.');
  $('quality-note').textContent = note; $('quality-note').hidden = !note;
  renderFormatDetails();
}
function renderFormatDetails() {
  const option = inspected?.options?.find(item => item.id === $('format').value);
  $('format-details').textContent = option
     ? [audioText[option.audio], `Kapsayıcı: ${option.ext.toUpperCase()}`, option.fps ? `${option.fps} FPS` : null, sizeText(option), option.etaSeconds > 0 ? `Tahmini indirme: ${durationText(option.etaSeconds)} (geçmiş ölçüm)` : 'İndirme süresi henüz hesaplanamıyor', option.id === inspected.defaultOptionId ? 'Varsayılan tercih' : null].filter(Boolean).join(' · ')
    : '';
}
$('format').addEventListener('change', renderFormatDetails);
function clearPreview() {
  pending = null; inspected = null; $('preview').hidden = true;
  if ($('title').value === autoTitle) $('title').value = '';
  autoTitle = '';
}
$('close-preview').addEventListener('click', clearPreview);
$('url').addEventListener('input', clearPreview);
$('engine').addEventListener('change', clearPreview);
$('copy-token').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(token); $('copy-token').replaceChildren(icon('check'), el('span', '', 'Anahtar kopyalandı')); }
  catch { message('Panoya erişilemedi. Tarayıcıda panoya erişime izin ver.', true); }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button)); render();
}));
async function init() {
  try {
    const response = await fetch('/api/bootstrap'); if (!response.ok) throw new Error('Yerel uygulamaya bağlanılamadı.');
    ({ token } = await response.json()); await Promise.all([refresh(), status()]);
  } catch (error) { message(error.message, true); }
}
applyLayout();
new ResizeObserver(() => { if (!resizing) applyLayout({ rebuild: false }); }).observe($('job-list'));
await init();
let refreshing = false;
// A hidden window (minimised, tray) does not poll or redraw; it catches up the moment it is shown again.
const poll = async () => {
  if (refreshing || !token || document.hidden) return; refreshing = true;
  try { await Promise.all([refresh(), status()]); }
  catch { $('connection').textContent = '● Bağlantı kesildi'; }
  finally { refreshing = false; }
};
setInterval(poll, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
