// A series / playlist address: list its videos once (flat, nothing is downloaded), then add the chosen ones to the waiting queue.
// Works through yt-dlp for any site it can read a list from; Hypernab does not guess episode pages on its own.
import path from 'node:path';
import { spawnManaged } from './process.js';
import { baseExtractorArgs, mediaHeaders, cleanMediaError } from './media.js';
import { parseRemoteUrl, resolveRemote, safeTitle } from './security.js';

export const MAX_PLAYLIST = 200;

export async function listPlaylist({ url, toolsDirectory, headers = {}, signal }) {
  await resolveRemote(url);
  const args = [...baseExtractorArgs(toolsDirectory, headers), '--yes-playlist', '--flat-playlist', '--skip-download', '--dump-single-json', '--playlist-end', String(MAX_PLAYLIST), '--', url];
  const output = await new Promise((resolve, reject) => {
    const child = spawnManaged(path.join(toolsDirectory, 'yt-dlp.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 8 * 1048576) child.kill(); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => signal?.aborted ? reject(signal.reason) : code === 0 ? resolve(out) : reject(new Error(cleanMediaError(err))));
  });
  return normalizePlaylist(JSON.parse(output));
}

export function normalizePlaylist(info) {
  if (!info || !Array.isArray(info.entries)) throw new Error('Bu bağlantı bir liste değil; tek video olarak indirilebilir.');
  const entries = [];
  for (const entry of info.entries) {
    if (!entry || entries.length >= MAX_PLAYLIST) continue;
    const raw = entry.webpage_url || entry.url; let address;
    try { address = parseRemoteUrl(raw).href; } catch { continue; } // only real web addresses; ids without an address are skipped
    entries.push({ index: entries.length + 1, title: safeTitle(String(entry.title || '').trim() || `Video ${entries.length + 1}`), url: address, duration: Number.isFinite(entry.duration) ? entry.duration : null });
  }
  return { title: safeTitle(String(info.title || 'Liste')), entries, more: Array.isArray(info.entries) && info.entries.length >= MAX_PLAYLIST };
}

// "Dizi - S01E03 - Başlık" from whatever the site calls the episode; plain numbering when no episode marker exists.
const EPISODE = [
  [/\bS(\d{1,2})\s*[ ._-]?\s*E(\d{1,3})\b/i, m => [m[1], m[2]]],
  [/\b(\d{1,2})x(\d{2,3})\b/i, m => [m[1], m[2]]],
  [/(\d{1,2})\s*\.?\s*sezon[^\d]{0,12}(\d{1,3})\s*\.?\s*b[öo]l[üu]m/i, m => [m[1], m[2]]],
  [/season\s*(\d{1,2})[^\d]{0,12}(?:episode|ep\.?)\s*(\d{1,3})/i, m => [m[1], m[2]]],
  [/(?:b[öo]l[üu]m|episode|ep\.?)\s*[-:#]?\s*(\d{1,3})\b/i, m => [null, m[1]]],
  [/\b(\d{1,3})\s*\.?\s*b[öo]l[üu]m/i, m => [null, m[1]]]
];
export function episodeName(seriesTitle, entryTitle, index, total) {
  const pad = (value, size) => String(Number(value)).padStart(size, '0');
  const text = String(entryTitle || ''), series = String(seriesTitle || '').trim();
  let season = null, episode = null, matched = null;
  for (const [pattern, read] of EPISODE) { const m = pattern.exec(text); if (m) { [season, episode] = read(m); matched = m[0]; break; } }
  const label = episode !== null ? `${season !== null ? `S${pad(season, 2)}` : ''}E${pad(episode, 2)}` : pad(index, Math.max(2, String(total).length));
  let rest = matched ? text.replace(matched, ' ') : text;
  if (series) rest = rest.replace(new RegExp(series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  rest = rest.replace(/[\s|–—:._-]{1,}/g, ' ').trim();
  return safeTitle([series, label, rest.length > 2 && rest.toLowerCase() !== label.toLowerCase() ? rest : null].filter(Boolean).join(' - '));
}
