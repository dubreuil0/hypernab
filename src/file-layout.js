import path from 'node:path';

// Bounded string work only; no filesystem scan, network request or site-specific rules.
export function cleanName(value, fallback = 'video') {
  let name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
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
  return cleanName(base.slice(0, 100 - suffix.length).trimEnd() + suffix);
}

export function layoutDirectory(root, mode, { host, series } = {}) {
  const parts = [];
  if (['site', 'site-series'].includes(mode) && host) parts.push(cleanName(host, 'site'));
  if (['series', 'site-series'].includes(mode) && series) parts.push(cleanName(series, 'Dizi'));
  return path.join(root, ...parts);
}
