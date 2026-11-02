import { canPause, canResume, canCancel, visibleJobs, selectionState, moveVisible } from './queue-state.js';
import { progressView, durationText } from './progress-view.js';
import { setupAdvanced } from './advanced.js';
import { setupHistory, canPlayFile } from './history-view.js';
import { COLUMNS, GAP, isAuto, effectiveLayout, searchJobs, sortJobs, normalizeLayout, sameLayout, clampWidth, gridTemplate, minimumWidth, visibleColumns, fitWidth, sortLabels } from './list-tools.js';

const T = (key, vars) => globalThis.HypernabText.t(key, vars), TN = (key, count, vars) => globalThis.HypernabText.tn(key, count, vars), LOCALE = () => globalThis.HypernabText.language();
let token = '', jobs = [], filter = 'all', pending = null, inspected = null, autoTitle = '';
// Search and sort change only what is shown. The real queue order (and what runs) never depends on them.
let search = '', sortKey = 'queue', sortDir = 'asc';
let layout = normalizeLayout(null), layoutPending = false, layoutTimer = null, resizing = null;
const selected = new Set();
const expandedJobs = new Set();
let queueBusy = false, pendingQueueCommand = null;
const $ = id => document.getElementById(id);
let selectedQueueName = 'Genel'; // the default queue's stored name is data; it is shown translated
const queueLabel = name => (!name || name === 'Genel' ? T('app.queue.general') : name);
let dragging = null;
const advanced = setupAdvanced(api, status);
const fmt = value => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** i).toLocaleString(LOCALE(), { maximumFractionDigits: i ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB'][i]}`;
};
setupHistory({ api, el, icon, fmt });
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || T('app.err.request'));
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
  $('stat-speed').replaceChildren(document.createTextNode(`${speed[0]} `), el('small', '', T('app.speedPer', { size: speed[1] })));
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
    if (search.trim() && total) empty.append(tile, el('strong', '', T('app.empty.searchTitle')), el('p', '', T('app.empty.searchHint')));
    else empty.append(tile, el('strong', '', filter === 'all' ? T('app.empty.ready') : T('app.empty.view')), el('p', '', T('app.empty.hint')));
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
    checkbox.dataset.jobSelect = job.id; checkbox.setAttribute('aria-label', T('app.select.job', { name: job.title || job.host }));
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(job.id); else selected.delete(job.id);
      card.classList.toggle('job-selected', checkbox.checked); renderSelection();
    });
    selectLabel.append(checkbox);
    const handle = el('button', 'btn icon-only ghost reorder-handle');
    handle.type = 'button'; handle.dataset.jobMove = job.id; handle.append(icon('grip'));
    handle.title = reorderAllowed() ? T('app.drag.hint') : T('app.drag.blocked'); handle.setAttribute('aria-label', T('app.drag.aria', { name: job.title || job.host })); handle.disabled = queueBusy;
    handle.classList.toggle('reorder-off', !reorderAllowed());
    bindReorder(handle, job.id);
    top.append(handle, selectLabel);
    const title = job.title === 'video' ? job.host : job.title;
    const titleNode = el('div', 'job-title', title); titleNode.title = title;
    const sourceText = `${job.host} · ${job.engine === 'direct' ? T('app.kind.file') : T('app.kind.stream')}${job.formatLabel || job.media?.height ? ` · ${job.formatLabel || `${job.media.height}p`}` : ''}`;
    info.append(titleNode, el('div', 'job-meta', `${sourceText} · ${view.size}${view.speed ? ` · ${view.speed}` : ''}`));
    details.append(el('div', 'job-meta compact-source', `${title} · ${sourceText}${job.viaQueue ? ` · ${T('app.queue.name', { name: queueLabel(job.queueName) })}` : ''}`));
    const stage = view.stage;
    if (job.viaQueue) info.append(el('div', 'job-meta', T('app.queue.name', { name: queueLabel(job.queueName) })));
    const tile = el('span', 'file-icon'); tile.append(icon(job.status === 'completed' ? 'check' : job.status === 'held' ? 'list' : 'download'));
    const stageNode = el('span', `job-state ${job.status}`, stage); stageNode.title = stage;
    top.append(tile, info, stageNode);
    const eta = job.progress?.etaSeconds;
    const etaText = Number.isFinite(eta) && eta > 0 ? `~${durationText(eta)}` : view.remaining ? job.progress?.etaReason === 'stalled' ? T('app.eta.waitingData') : job.progress?.etaReason === 'unknown-size' || job.progress?.etaReason === 'estimate-exceeded' ? T('app.eta.unknown') : T('app.eta.calculating') : '';
    for (const [name, text, description] of [['size', view.size, T('app.desc.size', { value: view.size })], ['speed', view.speed || '', T('app.desc.speed', { value: view.speed || T('app.desc.noTransfer') })], ['eta', etaText, view.remaining || stage]]) {
      const cell = el('span', `compact-cell compact-${name}`, text); cell.title = description; cell.setAttribute('aria-label', description); top.append(cell);
    }
    const actions = el('div', 'job-actions');
    const addAction = (action, text, disabled = false) => {
      const button = el('button', 'btn icon-only ghost'); button.title = text; button.setAttribute('aria-label', text); button.append(icon({ pause: 'pause', resume: 'play', cancel: 'x', 'start-now': 'bolt' }[action])); button.disabled = queueBusy || disabled;
      button.dataset.jobAction = `${job.id}-${action}`;
      button.addEventListener('click', () => action === 'cancel'
        ? confirmQueue({ type: 'bulk', action, ids: [job.id] }, T('app.confirm.cancel.title'), T('app.confirm.cancel.text'))
        : runQueueCommand({ type: 'single', action, id: job.id }));
      actions.append(button);
    };
    if (job.status === 'held') addAction('start-now', T('app.startNow'));
    if (canPause(job)) addAction('pause', T('app.pause'));
    if (canResume(job)) addAction('resume', T('app.resume'));
    if (canCancel(job)) addAction('cancel', T('app.cancel'));
    const detailButton = el('button', 'btn icon-only ghost job-details-toggle'); detailButton.append(icon('chevron')); detailButton.title = T('app.details.toggle'); detailButton.setAttribute('aria-label', T('app.details.aria')); detailButton.setAttribute('aria-expanded', String(expandedJobs.has(job.id))); detailButton.setAttribute('aria-controls', details.id); detailButton.dataset.jobAction = `${job.id}-details`;
    detailButton.addEventListener('click', () => { if (expandedJobs.has(job.id)) expandedJobs.delete(job.id); else expandedJobs.add(job.id); card.classList.toggle('details-open', expandedJobs.has(job.id)); detailButton.setAttribute('aria-expanded', String(expandedJobs.has(job.id))); });
    actions.append(detailButton);
    const moreButton = el('button', 'btn icon-only ghost'); moreButton.type = 'button'; moreButton.append(icon('more')); moreButton.title = T('app.more'); moreButton.setAttribute('aria-label', T('app.more')); moreButton.setAttribute('aria-haspopup', 'menu'); moreButton.dataset.jobAction = `${job.id}-more`;
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
      const folder = el('button', 'btn icon-only ghost'); folder.title = T('app.openLocation'); folder.setAttribute('aria-label', T('app.openLocation')); folder.append(icon('folder'));
      folder.dataset.jobLocation = job.id;
      folder.addEventListener('click', async () => {
        folder.disabled = true;
        try { await globalThis.hypernabDesktop.action('job-location', job.id); }
        catch { queueMessage(T('app.openLocation.failed'), true); }
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
    // Notes that are not errors (a different engine was used, a check was limited...) are a quiet info icon with a tooltip, not a line of
    // warning text under the row; the same text is in the row's details. Real errors stay as visible text.
    const notes = [job.notice, job.transfer?.resumeReason].filter(Boolean);
    const addNote = text => notes.push(text);
    if (job.verification) {
      const v = job.verification;
      const description = v.status === 'passed' ? `${v.level === 'format' ? T(v.sizeCompared ? 'app.verify.formatSize' : 'app.verify.format', { format: v.format }) : v.level === 'bytes' ? v.sizeCompared ? T('app.verify.size') : T('app.verify.output') : v.sizeCompared ? T('app.verify.sizeMedia') : T('app.verify.media')}${v.deep ? ` · ${T('app.verify.deep')}` : ''}${v.sha256 ? ` · ${T('app.verify.sha')}` : ''}`
        : v.status === 'limited' ? T('app.verify.limited') : v.status === 'failed' ? T('app.verify.failed') : v.status === 'paused' ? T('app.verify.paused') : T('app.verify.running');
      if (v.status === 'limited') addNote(description);
      else (v.status === 'failed' ? card : details).append(el('div', `job-verification ${v.status}`, description));
    }
    if (job.status === 'cancelled') details.append(el('div', 'job-file', job.settling ? T('app.cancelled.settling') : T('app.cancelled.hint')));
    else if (['failed', 'interrupted'].includes(job.status) && !job.canClear) card.append(el('div', 'job-file', T('app.partial.kept')));
    if (job.status === 'paused' && (job.transfer?.method === 'single-http' || job.transfer?.resumeSupported === false)) addNote(T('app.paused.restart'));
    if (notes.length) {
      const text = notes.join(' ');
      const badge = el('span', 'job-note'); badge.tabIndex = 0; badge.setAttribute('role', 'img'); badge.title = text; badge.setAttribute('aria-label', text); badge.append(icon('info'));
      if (!actions.isConnected) top.append(actions);
      actions.prepend(badge); details.append(el('div', 'job-file', text));
    }
    if (['parallel-http', 'parallel-streams'].includes(job.transfer?.method) && job.transfer.connections) {
      const transferFacts = [`${TN(job.status === 'completed' ? 'app.transfer.connectionsMax' : 'app.transfer.connections', job.transfer.connections)} · ${T(job.transfer.method === 'parallel-streams' ? 'app.transfer.parallel' : 'app.transfer.http')}`];
      if (job.status === 'running' && job.transfer.targetConnections) transferFacts.push(`Hedef ${job.transfer.targetConnections}/${job.transfer.maxConnections || 8}`);
      if (job.transfer.resumedBytes) transferFacts.push(T('app.transfer.resumed', { size: fmt(job.transfer.resumedBytes) }));
      if (job.transfer.splits) transferFacts.push(TN('app.transfer.splits', job.transfer.splits));
      if (job.transfer.reductions) transferFacts.push(TN('app.transfer.reductions', job.transfer.reductions));
      if (job.status === 'completed' && job.transfer.averageSpeed) transferFacts.push(T('app.transfer.average', { speed: fmt(job.transfer.averageSpeed), seconds: Math.round(job.transfer.attemptElapsedSeconds ?? job.transfer.elapsedSeconds) }));
      if (job.transfer.reusedExisting) transferFacts.push(T('app.transfer.reused'));
      if (job.media) transferFacts.push(T(job.media.height ? (job.media.audio ? 'app.media.v.pa' : 'app.media.v.p') : (job.media.audio ? 'app.media.v.ma' : 'app.media.v.m'), { height: job.media.height }));
      details.append(el('div', 'job-file', transferFacts.join(' · ')));
    }
    if (job.recovery?.length && expandedJobs.has(job.id)) {
      const eventNames = { resolve: T('app.ev.resolve'), 'source-refresh': T('app.ev.refresh'), 'probe-retry': T('app.ev.probe'), 'fast-selected': T('app.ev.fast'), 'hls-selected': T('app.ev.hls'), 'hls-retry': T('app.ev.hlsRetry'), 'native-selected': T('app.ev.native'), 'automatic-retry': T('app.ev.auto'), 'transfer-observed': T('app.ev.observed') };
      const reasonNames = { network: T('app.why.network'), http: T('app.why.http'), incomplete: T('app.why.incomplete'), range: T('app.why.range'), 'source-refused': T('app.why.refused'), protocol: T('app.why.protocol') };
      for (const item of job.recovery.slice(-6)) {
        if (!eventNames[item.event]) continue;
        const facts = [eventNames[item.event], reasonNames[item.reason], item.status ? `HTTP ${item.status}` : null, item.delayMs ? T('app.ev.wait', { seconds: (item.delayMs / 1000).toLocaleString(LOCALE()) }) : null, item.event === 'transfer-observed' && Number.isFinite(item.elapsedMs) ? T('app.ev.after', { seconds: (item.elapsedMs / 1000).toLocaleString(LOCALE()) }) : null];
        details.append(el('div', 'job-file', facts.filter(Boolean).join(' · ')));
      }
    }
    if (job.subtitleResult) {
      const s = job.subtitleResult;
      const DS = globalThis.HypernabDS;
      let line;
      if (s.mode === 'none') line = el('div', 'job-file job-error', s.note);
      else {
        // Subtitles as language chips (code + name; the default one in the accent), then where they went: inside the video and/or next to it.
        line = el('div', 'job-file job-subs'); line.append(DS.icon(document, 'subtitle'), el('span', '', T('job.sub.title')));
        for (const track of s.tracks || []) { const base = String(track.lang || '').toLowerCase(); line.append(DS.chip(document, { code: /^[a-z]{2,3}$/.test(base) ? base : undefined, text: track.name, tone: track.default ? 'accent' : undefined })); }
        if (s.mode === 'embedded' || s.mode === 'embedded+sidecar') line.append(DS.badge(document, T('job.sub.embedded')));
        if (s.mode === 'sidecar' || s.mode === 'embedded+sidecar') { const side = DS.badge(document, T('job.sub.sidecar')); side.title = (s.files || []).join(', '); line.append(side); }
        if (s.note) line.append(el('span', '', s.note));
        if (s.encodingNote) line.append(el('span', '', T('job.sub.encoding')));
      }
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
    queueMessage(T('app.order.saved'));
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
    if (!reorderAllowed()) return queueMessage(T('app.order.blocked'), true);
    const visible = visibleJobs(jobs, filter), at = visible.findIndex(job => job.id === id), delta = event.key === 'ArrowUp' ? -1 : 1;
    const target = visible[at + delta];
    if (target) void commitOrder(moveVisible(jobs, filter, id, target.id, delta < 0), id);
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || queueBusy || dragging) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    if (!reorderAllowed()) return queueMessage(T('app.order.blocked'), true);
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
  $('selected-count').textContent = `${T('app.selected.count', { n: state.count })}${hiddenSelected ? ` · ${T('app.selected.hidden', { n: hiddenSelected })}` : ''}`;
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
    const nothing = { pause: T('app.none.pause'), resume: T('app.none.resume'), cancel: T('app.none.cancel') };
    if (command.type === 'bulk' && command.all && !result.changed) queueMessage(nothing[command.action]);
    else queueMessage(command.type === 'clear' ? TN('app.cleared', result.removed) : command.action === 'retry' ? T('app.retry.queued') : `${TN(`app.done.${command.action}`, result.changed ?? 1)}${result.skipped ? ` ${TN('app.done.skipped', result.skipped)}` : ''}`);
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
  if (action === 'cancel') confirmQueue(command, T('app.confirm.cancelSelected.title'), T('app.confirm.cancelSelected.text'));
  else runQueueCommand(command);
});
function requestClear(onlySelected) {
  const scope = selectedShown();
  const ids = jobs.filter(job => job.canClear && (onlySelected ? scope.has(job.id) : true)).map(job => job.id);
  if (!ids.length) return;
  confirmQueue({ type: 'clear', ids }, T('app.confirm.clear.title'), T('app.confirm.clear.text', { n: ids.length }));
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
      button.title = T('app.col.sortBy', { name: column.label });
      // First click: natural direction; second: reverse; third: back to the real queue order.
      button.addEventListener('click', () => {
        if (sortKey !== key) setSort(key, defaultDir[key]);
        else if (sortDir === defaultDir[key]) setSort(key, sortDir === 'asc' ? 'desc' : 'asc');
        else setSort('queue', 'asc');
      });
      cell.append(button);
    } else cell.append(el('span', 'col-sort static', column.label));
    const grip = el('span', 'col-resize'); grip.tabIndex = 0; grip.dataset.col = column.id;
    grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', T('app.col.width', { name: column.label }));
    grip.title = T('app.col.gripHint');
    bindResize(grip, column.id); cell.append(grip); head.append(cell);
  }
  head.append(el('span', 'col-actions', T('app.col.actions')));
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
  $('layout-mode').textContent = isAuto(layout) ? T('app.layout.auto') : T('app.layout.manual');
  document.documentElement.dataset.focus = layout.focus ? 'on' : 'off';
  $('focus-toggle').setAttribute('aria-pressed', String(layout.focus));
  $('focus-toggle').title = layout.focus ? T('app.focus.exit') : T('app.focus.title');
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
  if (search.trim()) notes.push(T('app.showing', { shown, total }));
  if (sortKey !== 'queue') notes.push(T('app.sortNote', { label: sortLabels[sortKey], direction: sortDir === 'asc' ? T('app.asc') : T('app.descending') }));
  if (notes.length) notes.push(T('app.viewOnly'));
  $('list-notice').textContent = notes.join(' · '); $('list-notice').hidden = !notes.length;
}
function setSort(key, dir) {
  sortKey = key; sortDir = dir;
  $('list-sort').value = key; $('sort-direction').hidden = $('sort-reset').hidden = key === 'queue';
  $('sort-direction').setAttribute('aria-label', T('app.sort.direction.label', { direction: dir === 'asc' ? T('app.asc') : T('app.descending') }));
  $('sort-direction').querySelector('svg').classList.toggle('flip', dir === 'asc');
  buildHeader(); applyLayout({ rebuild: false }); render();
}
$('list-sort').addEventListener('change', () => setSort($('list-sort').value, defaultDir[$('list-sort').value]));
$('sort-direction').addEventListener('click', () => setSort(sortKey, sortDir === 'asc' ? 'desc' : 'asc'));
$('sort-reset').addEventListener('click', () => { setSort('queue', 'asc'); queueMessage(T('app.sort.reset.done')); });
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
  try { await navigator.clipboard.writeText(text); queueMessage(T(what)); }
  catch { queueMessage(T('app.clipboard.denied'), true); }
}
function openRowMenu(id, x, y) {
  const job = jobs.find(item => item.id === id); if (!job) return;
  closeRowMenu(false); menuJob = id;
  const menu = $('row-menu'), title = job.title === 'video' ? job.host : job.title;
  const item = (name, label, run, disabled = false) => {
    const button = el('button', 'menu-item'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = disabled;
    button.append(icon(name), el('span', '', label)); button.addEventListener('click', () => { closeRowMenu(); void run(); }); menu.append(button);
  };
  if (globalThis.hypernabDesktop) item('folder', T('app.openLocation'), async () => { try { await globalThis.hypernabDesktop.action('job-location', id); } catch { queueMessage(T('app.openLocation.failed'), true); } });
  if (globalThis.hypernabDesktop && canPlayFile(job)) item('play', T('app.play'), async () => { try { await globalThis.hypernabDesktop.action('job-play', id); } catch (error) { queueMessage(error.message, true); } });
  item('copy', T('app.copyName'), () => copyText(title, 'app.copied.name'));
  if (job.file) item('copy', T('app.copyPath'), () => copyText(job.directory ? `${job.directory}\\${job.file}` : job.file, 'app.copied.path'));
  if (job.status === 'held') item('bolt', T('app.startNow'), () => runQueueCommand({ type: 'single', action: 'start-now', id }), queueBusy);
  if (canPause(job)) item('pause', 'Duraklat', () => runQueueCommand({ type: 'single', action: 'pause', id }), queueBusy);
  if (canResume(job)) item('play', 'Devam et', () => runQueueCommand({ type: 'single', action: 'resume', id }), queueBusy);
  if (canCancel(job)) item('x', T('app.cancelIt'), () => confirmQueue({ type: 'bulk', action: 'cancel', ids: [id] }, T('app.confirm.cancel.title'), T('app.confirm.cancel.text')), queueBusy);
  item('chevron', expandedJobs.has(id) ? T('app.details.hide') : T('app.details.show'), () => { if (expandedJobs.has(id)) expandedJobs.delete(id); else expandedJobs.add(id); render(); });
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
const duplicateStatus = { running: T('app.dupe.s.running'), queued: T('app.dupe.s.queued'), held: T('app.dupe.s.held'), paused: T('app.dupe.s.paused'), interrupted: T('app.dupe.s.interrupted'), completed: T('app.dupe.s.completed') };
let duplicateAsk = null;
function showDuplicate(duplicates, mode) {
  duplicateAsk = { ids: duplicates.map(item => item.id), mode };
  const lines = duplicates.slice(-3).map(item => `• ${item.title === 'video' ? T('app.untitled') : item.title}${item.formatLabel ? ` · ${item.formatLabel}` : ''} — ${duplicateStatus[item.status] || item.status}`);
  $('duplicate-text').textContent = T('app.dupe.text', { lines: lines.join('\n') });
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
// ---- Several links at once (a dialog; the engine does the work and says what it added, skipped and could not add) ----
const MAX_LINKS = 100;
const linksIn = text => [...new Set((String(text).match(/https?:\/\/[^\s<>"'`]+/gi) || []).map(link => link.replace(/[),.;]+$/, '')))];
function bulkState() {
  const count = linksIn($('bulk-text').value).length, tooMany = count > MAX_LINKS;
  $('bulk-count').textContent = tooMany ? T('app.bulk.tooMany', { max: MAX_LINKS }) : count ? TN('app.bulk.count', count) : T('app.bulk.none');
  for (const id of ['bulk-now', 'bulk-later']) $(id).disabled = !count || tooMany;
}
function openBulk(text = '') { $('bulk-text').value = text; bulkState(); $('bulk-dialog').showModal(); $('bulk-text').focus(); }
$('open-bulk').addEventListener('click', () => openBulk());
$('bulk-text').addEventListener('input', bulkState);
$('bulk-cancel').addEventListener('click', () => $('bulk-dialog').close());
async function submitBulk(mode) {
  const urls = linksIn($('bulk-text').value); if (!urls.length || urls.length > MAX_LINKS) return;
  for (const id of ['bulk-now', 'bulk-later']) $(id).disabled = true;
  message(T('app.bulk.working')); $('bulk-dialog').close();
  try {
    const result = await api('/api/links/add', { method: 'POST', body: JSON.stringify({ urls, start: mode }), signal: AbortSignal.timeout(300000) });
    const parts = [result.added ? TN('app.bulk.added', result.added) : T('app.bulk.nothingAdded'), result.skipped ? T('app.playlist.skippedPart', { n: result.skipped }) : '', result.failed ? T('app.playlist.failedPart', { n: result.failed }) : '', result.full ? T('app.playlist.fullPart') : ''];
    message(`${parts.join('')}${result.added && mode === 'queue' ? T('app.playlist.afterAdd') : '.'}${result.errors?.[0] ? ` ${result.errors[0]}` : ''}`, result.full || (!result.added && result.failed > 0));
    await refresh();
  } catch (error) { message(error.message, true); }
}
$('bulk-now').addEventListener('click', () => void submitBulk('now'));
$('bulk-later').addEventListener('click', () => void submitBulk('queue'));
async function refresh() {
  jobs = await api('/api/jobs');
  const known = new Set(jobs.map(job => job.id));
  for (const id of selected) if (!known.has(id)) selected.delete(id);
  for (const id of expandedJobs) if (!known.has(id)) expandedJobs.delete(id);
  render();
  $('connection').textContent = T('app.connected');
}
async function status() {
  const info = await api('/api/status');
  renderSelection();
  for (const [id, enabled] of [['ytdlp-state', info.ytDlp], ['ffmpeg-state', info.ffmpeg]]) {
    $(id).textContent = enabled ? T('app.ready') : T('app.notInstalled'); $(id).className = `badge${enabled ? ' ok' : ''}`;
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
    pending = null; $('preview').hidden = true; message(T('app.preview.loading'));
    const input = { url: $('url').value.trim(), title: $('title').value, engine: $('engine').value };
    const info = await api('/api/inspect', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(135000) });
    // Ignore a stale response if the user changed URL/motor while inspecting.
    if (input.url !== $('url').value.trim() || input.engine !== $('engine').value) return message(T('app.link.changed'));
    // A page captured through the browser is downloaded from the media request the player made, with its referer.
    pending = info.resolved ? { ...input, ...info.resolved } : input; inspected = info;
    renderQuality(info);
    if (!$('title').value) { $('title').value = info.title; autoTitle = info.title; }
    $('preview-title').textContent = info.title;
    const duration = info.duration ? T('app.duration.ms', { m: Math.floor(info.duration / 60), s: Math.round(info.duration % 60) }) : T('app.duration.unknown');
    // With a quality list, format and size belong to the selected option below; the source's own default pick would contradict it.
    $('preview-facts').textContent = info.options?.length
      ? [duration, T('app.resolutions', { list: info.heights.map(n => `${n}p`).join(', ') })].join(' · ')
      : [info.extension?.toUpperCase() || T('app.format.unknown'), info.filesize ? (info.estimatedSize ? T('app.sizeApprox', { size: fmt(info.filesize) }) : fmt(info.filesize)) : T('app.size.unknown'), duration, info.heights?.length ? info.heights.map(n => `${n}p`).join(', ') : T('app.resolution.unknown'), info.etaSeconds > 0 ? T('app.eta.estimate', { time: durationText(info.etaSeconds) }) : T('app.eta.none')].join(' · ');
    $('preview-warning').textContent = info.warning || '';
    $('preview').hidden = false; message(info.options?.length ? T('app.preview.ready') : T('app.preview.check'));
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
  $('playlist-add').disabled = !count; $('playlist-add').querySelector('span').textContent = count ? TN('app.playlist.addCount', count) : T('app.addSelected');
  const boxes = [...$('playlist-items').querySelectorAll('input')]; $('playlist-all').checked = boxes.length > 0 && boxes.every(box => box.checked); $('playlist-all').indeterminate = count > 0 && !$('playlist-all').checked;
}
async function showPlaylist() {
  message(T('app.playlist.loading'));
  const url = $('url').value.trim();
  const list = await api('/api/playlist', { method: 'POST', body: JSON.stringify({ url }), signal: AbortSignal.timeout(100000) });
  if (url !== $('url').value.trim()) return message(T('app.link.changed'));
  if (!list.entries.length) throw new Error(T('app.playlist.none'));
  playlist = { url, ...list };
  $('playlist-title').textContent = list.title;
  $('playlist-facts').textContent = T('app.playlist.facts', { count: `${list.entries.length}${list.more ? '+' : ''}` });
  const rows = list.entries.map((entry, at) => {
    const row = el('label', 'playlist-row'), box = el('input'); box.type = 'checkbox'; box.checked = !entry.duplicate; box.dataset.at = String(at);
    box.addEventListener('change', playlistCount);
    const minutes = entry.duration ? ` · ${Math.max(1, Math.round(entry.duration / 60))} dk` : '';
    row.append(box, el('span', 'playlist-name', entry.name), el('span', 'muted-text', entry.duplicate ? 'zaten listede' : minutes.slice(3)));
    row.title = entry.title; return row;
  });
  $('playlist-items').replaceChildren(...rows); $('preview').hidden = true; $('playlist').hidden = false; playlistCount();
  message(T('app.playlist.found', { n: list.entries.length }));
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
    message(`${TN('app.playlist.added', result.added)}${result.skipped ? T('app.playlist.skippedPart', { n: result.skipped }) : ''}${result.failed ? T('app.playlist.failedPart', { n: result.failed }) : ''}${result.full ? T('app.playlist.fullPart') : ''}${T('app.playlist.afterAdd')}`, result.full || (!result.added && result.failed));
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
    message(mode === 'queue' ? T('app.added.later') : T('app.started'));
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
  $('queue-run-state').textContent = queue.waiting ? `${TN('app.queue.waiting', queue.waiting)}${queue.held ? T('app.queue.heldPart', { n: queue.held }) : ''}` : queue.held ? `${T('app.queue.held', { n: queue.held })}${queue.running ? T('app.queue.runningPart') : ''}` : queue.running ? T('app.queue.running') : T('app.queue.empty');
  if (document.activeElement !== $('queue-limit')) $('queue-limit').value = String(queue.limit); // 1–6 or "all" (Hepsi)
  $('queue-toggle').replaceChildren(icon(queue.running ? 'stop' : 'play'), el('span', '', queue.running ? T('app.queue.stop') : T('app.queue.start')));
  $('queue-toggle').classList.toggle('on', queue.running); $('queue-toggle').disabled = !queue.running && !queue.held;
}
async function queueCall(route, body) {
  try { await api(route, { method: 'POST', body: JSON.stringify(body || {}) }); await Promise.all([refresh(), status()]); }
  catch (error) { queueMessage(error.message, true); }
}
$('queue-limit').addEventListener('change', () => queueCall('/api/settings', { queueLimit: $('queue-limit').value === 'all' ? 'all' : Number($('queue-limit').value) }));
$('queue-toggle').addEventListener('click', () => queueCall($('queue-toggle').classList.contains('on') ? '/api/queue/stop' : '/api/queue/start'));
const sizeText = option => option.filesize ? (option.sizeKind === 'exact' ? fmt(option.filesize) : T('app.sizeApprox', { size: fmt(option.filesize) })) : T('app.size.unknown');
const audioText = { included: T('app.audio.included'), merged: T('app.audio.merged'), none: T('app.audio.none') };
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
  if (more.length) { const group = document.createElement('optgroup'); group.label = T('app.formats.other'); fill(group, more); select.append(group); }
  if (options.length) select.value = info.defaultOptionId;
  $('quality-picker').hidden = !options.length;
  $('quality-count').textContent = options.length ? `(${TN('app.options.count', main.length)}${more.length ? ` + ${T('app.options.extra', { n: more.length })}` : ''})` : '';
  const note = info.qualityNote || (options.length ? '' : T('app.options.none'));
  $('quality-note').textContent = note; $('quality-note').hidden = !note;
  renderFormatDetails();
}
function renderFormatDetails() {
  const option = inspected?.options?.find(item => item.id === $('format').value);
  $('format-details').textContent = option
     ? [audioText[option.audio], T('app.container', { ext: option.ext.toUpperCase() }), option.fps ? `${option.fps} FPS` : null, sizeText(option), option.etaSeconds > 0 ? T('app.eta.estimate', { time: durationText(option.etaSeconds) }) : T('app.eta.none'), option.id === inspected.defaultOptionId ? T('app.defaultChoice') : null].filter(Boolean).join(' · ')
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
  try { await navigator.clipboard.writeText(token); $('copy-token').replaceChildren(icon('check'), el('span', '', T('app.key.copied'))); }
  catch { message(T('app.clipboard.denied'), true); }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button)); render();
}));
async function init() {
  try {
    const response = await fetch('/api/bootstrap'); if (!response.ok) throw new Error(T('app.err.connect'));
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
  catch { $('connection').textContent = T('app.disconnected'); }
  finally { refreshing = false; }
};
setInterval(poll, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
