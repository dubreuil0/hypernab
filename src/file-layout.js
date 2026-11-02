import path from 'node:path';

// Bounded string work only; no filesystem scan, network request or site-specific rules.
// Characters that change how a name is SHOWN without being part of it: direction overrides and isolates (a name can be made to read
// "fdp.exe" backwards as ".exe" hidden behind "pdf"), the byte-order mark, line and paragraph separators and the C1 controls. The
// joiners (U+200C/200D) stay: Persian and Indic words need them.
export const HIDDEN_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\u0080-\u009f]/g;
/** At most `limit` UTF-16 units without cutting a character (an emoji or a rare Han character is a pair) in two. */
export function clipName(value, limit = 100) {
  let out = '', used = 0;
  for (const ch of String(value)) { if (used + ch.length > limit) break; out += ch; used += ch.length; }
  return out;
}
const wellFormed = text => (typeof text.toWellFormed === 'function' ? text.toWellFormed() : text);
export function cleanName(value, fallback = 'video') {
  let name = clipName(wellFormed(String(value || '')).normalize('NFC').replace(HIDDEN_CHARACTERS, '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])\s*(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

export function knownYear(info = {}) {
  const year = Number(info?.release_year);
  if (Number.isInteger(year) && year >= 1888 && year <= 2100) return year;
  // Upload dates are not release dates. Do not infer a movie year from them.
  return null;
}

export function finishedName(job, original, extension = '') {
  if (job.smartNames !== true) return original;
  let base = cleanName(job.title);
  // Strip only a matching media extension, never arbitrary dotted title text.
  if (/^\.(?:mp4|mkv|webm|mov|avi|mp3|m4a|ogg|wav|flac)$/i.test(extension) && base.toLowerCase().endsWith(extension.toLowerCase())) base = base.slice(0, -extension.length);
  let suffix = '';
  if (job.releaseYear && !new RegExp(`\\b${job.releaseYear}\\b`).test(base)) suffix += ` (${job.releaseYear})`;
  const height = job.media?.height;
  // Only verified output dimensions count, not a requested quality cap.
  if (Number.isInteger(height) && height > 0 && height <= 16384 && !new RegExp(`\\b${height}p\\b`, 'i').test(base)) suffix += ` ${height}p`;
  return cleanName(clipName(base, 100 - suffix.length).trimEnd() + suffix);
}

// Folders of the optional "sort by type" setting. Fixed names (not translated) so a language change never splits one kind over two folders.
export const TYPE_FOLDERS = { video: 'Video', audio: 'Music', image: 'Images', document: 'Documents', archive: 'Archives', program: 'Programs', disk: 'Disk images', other: 'Other' };

// root / [type] / [site] / [series]: the type folder (only when sorting by type is on and the type is known) comes first.
export function layoutDirectory(root, mode, { host, series, category } = {}) {
  const parts = [];
  if (TYPE_FOLDERS[category]) parts.push(TYPE_FOLDERS[category]);
  if (['site', 'site-series'].includes(mode) && host) parts.push(cleanName(host, 'site'));
  if (['series', 'site-series'].includes(mode) && series) parts.push(cleanName(series, 'Dizi'));
  return path.join(root, ...parts);
}
