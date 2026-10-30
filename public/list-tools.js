// Pure helpers for the download list: search, visual sort and column layout. None of them touch real queue order.
export const COLUMNS = [
  { id: 'name', label: 'Ad', min: 110, auto: 360, hideable: false },
  { id: 'size', label: 'Boyut / ilerleme', min: 90, auto: 160, hideable: true },
  { id: 'speed', label: 'Hız', min: 64, auto: 90, hideable: true },
  { id: 'eta', label: 'Kalan', min: 64, auto: 100, hideable: true },
  { id: 'state', label: 'Durum', min: 80, auto: 130, hideable: true }
];
export const FIXED = { handle: 24, select: 24, actions: 152 }, GAP = 6, PAD = 16;
export const DEFAULT_LAYOUT = Object.freeze({ widths: {}, hidden: [], focus: false });
export const sortLabels = { queue: 'Kuyruk sırası', name: 'Ad', size: 'Boyut', status: 'Durum', date: 'Eklenme' };

const fold = text => String(text ?? '').toLocaleLowerCase('tr-TR');
export function matchesSearch(job, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold([job.title, job.host, job.file, job.formatLabel].filter(Boolean).join(' '));
  return words.every(word => haystack.includes(word));
}
export const searchJobs = (jobs, query) => query.trim() ? jobs.filter(job => matchesSearch(job, query)) : jobs;

const statusRank = { running: 0, queued: 1, held: 2, paused: 3, interrupted: 4, failed: 5, cancelled: 6, completed: 7 };
const sizeOf = job => { const n = job.progress?.total ?? job.total; return Number.isFinite(n) && n > 0 ? n : null; };
// Stable: equal values keep queue order, so rows do not jump around on every progress update. Unknown sizes always go last.
export function sortJobs(jobs, key, direction = 'asc') {
  if (key === 'queue') return jobs;
  const sign = direction === 'desc' ? -1 : 1;
  const value = {
    name: job => fold(job.title === 'video' ? job.host : job.title),
    size: sizeOf,
    status: job => statusRank[job.status] ?? 99,
    date: job => Date.parse(job.createdAt) || null
  }[key];
  if (!value) return jobs;
  return jobs.map((job, index) => ({ job, index, v: value(job) })).sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === b.v ? a.index - b.index : a.v === null ? 1 : -1;
    const order = typeof a.v === 'string' ? a.v.localeCompare(b.v, 'tr') : a.v - b.v;
    return order * sign || a.index - b.index;
  }).map(item => item.job);
}

export function normalizeLayout(value) {
  const ids = COLUMNS.map(c => c.id), hideable = COLUMNS.filter(c => c.hideable).map(c => c.id);
  const widths = {};
  for (const [id, width] of Object.entries(value?.widths || {})) if (ids.includes(id) && Number.isInteger(width) && width >= 48 && width <= 1600) widths[id] = width;
  const hidden = [...new Set(Array.isArray(value?.hidden) ? value.hidden.filter(id => hideable.includes(id)) : [])];
  return { widths, hidden, focus: value?.focus === true };
}
export const sameLayout = (a, b) => JSON.stringify(normalizeLayout(a)) === JSON.stringify(normalizeLayout(b));

export const clampWidth = (id, width) => Math.max(COLUMNS.find(c => c.id === id).min, Math.min(1600, Math.round(width)));
export const visibleColumns = layout => COLUMNS.filter(c => !layout.hidden.includes(c.id));
export const isAuto = layout => !Object.keys(layout.widths).length;
// Automatic widths grow smoothly with the list width (900px -> narrowest, 1900px+ -> widest); Name takes the rest.
const RANGE = { size: [150, 220], speed: [80, 120], eta: [90, 130], state: [120, 170] };
export function autoWidth(id, listWidth) {
  const range = RANGE[id]; if (!range) return undefined;
  if (!Number.isFinite(listWidth) || listWidth <= 0) return COLUMNS.find(c => c.id === id).auto;
  const t = Math.max(0, Math.min(1, (listWidth - 900) / 1000));
  return Math.round(range[0] + (range[1] - range[0]) * t);
}
// Not enough room: hide Kalan first, then Hız, for now only. The saved choice is never touched.
export function effectiveLayout(layout, listWidth) {
  if (!isAuto(layout) || !Number.isFinite(listWidth) || listWidth <= 0) return layout;
  const hidden = [...layout.hidden];
  const need = () => FIXED.handle + FIXED.select + FIXED.actions + 280 + PAD + visibleColumns({ ...layout, hidden }).filter(c => c.id !== 'name').reduce((n, c) => n + autoWidth(c.id, listWidth) + GAP, 0);
  for (const id of ['eta', 'speed']) if (need() > listWidth && !hidden.includes(id)) hidden.push(id);
  return { ...layout, hidden };
}
// Name keeps the leftover space (minmax(.., 1fr)); the others take their saved width, or a sensible default.
export function gridTemplate(layout, listWidth) {
  const parts = [`${FIXED.handle}px`, `${FIXED.select}px`];
  const manual = layout.widths.name !== undefined; // a chosen Name width is exact; the spare room then goes after the last column
  for (const column of visibleColumns(layout)) {
    const width = layout.widths[column.id];
    if (column.id === 'name' && !manual) parts.push(`minmax(${column.min}px,1fr)`);
    else parts.push(`${width ?? autoWidth(column.id, listWidth) ?? column.auto}px`);
  }
  parts.push(manual ? `minmax(${FIXED.actions}px,1fr)` : `${FIXED.actions}px`);
  return parts.join(' ');
}
export function minimumWidth(layout, listWidth) {
  const columns = visibleColumns(layout);
  const sum = FIXED.handle + FIXED.select + FIXED.actions + columns.reduce((n, c) => n + (layout.widths[c.id] ?? (c.id === 'name' ? c.min : autoWidth(c.id, listWidth) ?? c.auto)), 0);
  return sum + GAP * (columns.length + 2) + PAD;
}
// Width that makes the column's longest sample fit, bounded so one huge name cannot take the whole list.
export function fitWidth(id, samples) {
  const column = COLUMNS.find(c => c.id === id), longest = Math.max(0, ...samples);
  return clampWidth(id, Math.min(longest + 12, id === 'name' ? 700 : 320));
}
