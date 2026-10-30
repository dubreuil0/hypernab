// Subtitles for any site: recognise a subtitle by its CONTENT (never by site or address), normalise it to WebVTT/SRT,
// then put it into the finished video (or next to it). Nothing here knows a website or a player brand.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnManaged } from './process.js';

export const MAX_SUBTITLE_BYTES = 2 * 1048576;
export const MAX_SUBTITLE_TRACKS = 16;

const clock = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;
function seconds(text) {
  text = String(text).trim();
  const match = clock.exec(text);
  if (match) return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '0').padEnd(3, '0')) / 1000;
  const unit = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  if (unit) return Number(unit[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[unit[2]];
  return null;
}
const stamp = (value, separator = '.') => {
  const total = Math.max(0, Math.round(value * 1000)), ms = total % 1000, s = Math.floor(total / 1000) % 60, m = Math.floor(total / 60000) % 60, h = Math.floor(total / 3600000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
};
const entities = text => text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x[0-9a-f]+|#\d+);/gi, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' }[token.toLowerCase()]
  ?? String.fromCodePoint(Math.min(0x10ffff, token[2].toLowerCase() === 'x' ? parseInt(token.slice(3, -1), 16) : parseInt(token.slice(2, -1), 10)) || 32)));

// What kind of subtitle is this text? Looks only at the beginning and structure of the content.
export function classifySubtitle(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/^﻿/, ''), head = body.trimStart().slice(0, 4096);
  if (/^WEBVTT(?:[ \t\r\n]|$)/.test(head)) return 'vtt';
  if (/^\[Script Info\]/i.test(head) && /^Dialogue:/m.test(body)) return 'ass';
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<(?:\w+:)?tt[\s>]/i.test(head) && /<(?:\w+:)?p[\s>]/.test(body)) return 'ttml';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(head) || /^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}/.test(head)) return 'srt';
  return null;
}

function parseTimed(text) {
  const cues = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
    if (at < 0 || /^(?:NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [from, to] = lines[at].split('-->'), start = seconds(from.trim().split(/\s+/)[0]), end = seconds((to || '').trim().split(/\s+/)[0]);
    const content = lines.slice(at + 1).join('\n').trim();
    if (start !== null && end !== null && end > start && content) cues.push({ start, end, text: content });
  }
  return cues;
}
function parseAss(text) {
  const cues = []; let columns = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^Format:/i.test(raw) && /Start/i.test(raw) && /Text/i.test(raw)) columns = raw.slice(7).split(',').map(name => name.trim().toLowerCase());
    if (!/^Dialogue:/i.test(raw) || !columns) continue;
    const parts = raw.slice(9).split(','), text = parts.slice(columns.length - 1).join(',');
    const start = seconds(parts[columns.indexOf('start')] || ''), end = seconds(parts[columns.indexOf('end')] || '');
    const clean = text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
    if (start !== null && end !== null && end > start && clean) cues.push({ start, end, text: clean });
  }
  return cues.sort((a, b) => a.start - b.start);
}
function parseTtml(text) {
  const cues = [];
  for (const match of text.matchAll(/<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/g)) {
    const attr = name => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(match[1])?.[1];
    const start = seconds(attr('begin') || ''), end = attr('end') ? seconds(attr('end')) : (attr('dur') && start !== null ? start + (seconds(attr('dur')) ?? 0) : null);
    const clean = entities(match[2].replace(/<(?:\w+:)?br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    if (start !== null && end !== null && end > start && clean) cues.push({ start, end, text: clean });
  }
  return cues;
}

const markup = text => text.replace(/-->/g, '->').replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '').replace(/\n{2,}/g, '\n').trim();
export function parseSubtitle(text) {
  const kind = classifySubtitle(text);
  if (!kind) return null;
  const seen = new Set(); // segmented playlists often repeat a cue in the neighbouring segment
  const cues = (kind === 'ass' ? parseAss(text) : kind === 'ttml' ? parseTtml(text) : parseTimed(text)).slice(0, 60000)
    .map(cue => ({ ...cue, text: markup(cue.text) })).filter(cue => {
      const key = `${cue.start}|${cue.end}|${cue.text}`;
      if (!cue.text || seen.has(key)) return false;
      seen.add(key); return true;
    });
  return cues.length ? { kind, cues } : null;
}
export const toVtt = cues => `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n')}`;
export const toSrt = cues => `${cues.map((cue, i) => `${i + 1}\r\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\r\n${cue.text.replace(/\n/g, '\r\n')}\r\n`).join('\r\n')}`;
// Same language + same timing = the same subtitle seen twice (page track and network file).
export const signature = (cues, lang) => createHash('sha1').update(`${lang}|${cues.length}|${cues[0].start.toFixed(1)}|${cues.at(-1).end.toFixed(1)}`).digest('hex');

// Language names the user may meet; ISO codes for the container's language tag.
const LANGUAGES = [
  ['tr', 'tur', 'Türkçe', /turk|türk/i], ['en', 'eng', 'English', /english|ingiliz|i̇ngiliz/i], ['de', 'deu', 'Deutsch', /german|deutsch|alman/i], ['fr', 'fra', 'Français', /french|fran[cç]|fransız/i],
  ['es', 'spa', 'Español', /spanish|espa|i̇spanyol|ispanyol/i], ['it', 'ita', 'Italiano', /italian|italia|i̇talyan|italyan/i], ['pt', 'por', 'Português', /portug|portekiz/i], ['ru', 'rus', 'Русский', /russian|рус|rusça|rusca/i],
  ['ar', 'ara', 'العربية', /arabic|arap|عرب/i], ['fa', 'fas', 'فارسی', /persian|farsi|fars/i], ['ja', 'jpn', '日本語', /japan|japon/i], ['ko', 'kor', '한국어', /korea|koreli|kore/i],
  ['zh', 'zho', '中文', /chinese|chin|çince|cince|中文/i], ['nl', 'nld', 'Nederlands', /dutch|nederl|felemenk|hollanda/i], ['pl', 'pol', 'Polski', /polish|polski|polon/i], ['uk', 'ukr', 'Українська', /ukrain|ukray/i],
  ['el', 'ell', 'Ελληνικά', /greek|ελλην|yunan/i], ['he', 'heb', 'עברית', /hebrew|ibran|i̇branice/i], ['hi', 'hin', 'हिन्दी', /hindi/i], ['sv', 'swe', 'Svenska', /swed|svensk|isveç/i], ['ro', 'ron', 'Română', /romanian|român|romen/i],
  ['bg', 'bul', 'Български', /bulgar|bulgarca/i], ['hu', 'hun', 'Magyar', /hungar|magyar|macar/i], ['cs', 'ces', 'Čeština', /czech|češ|çek/i], ['az', 'aze', 'Azərbaycanca', /azer|azeri/i]
];
export function languageInfo(code, label = '') {
  const clean = String(code || '').toLowerCase().replace(/_/g, '-').split('-')[0];
  const entry = LANGUAGES.find(([a, b]) => clean === a || clean === b) || LANGUAGES.find(item => item[3].test(String(label || '')));
  if (entry) return { iso1: entry[0], iso3: entry[1], name: entry[2] };
  return { iso1: /^[a-z]{2}$/.test(clean) ? clean : null, iso3: /^[a-z]{3}$/.test(clean) ? clean : 'und', name: String(label || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60) || 'Altyazı' };
}
// A language hint hidden in a file name such as movie.tr.vtt or /subs/eng/1.vtt (only a hint, never required).
export function languageFromAddress(raw) {
  try {
    const parts = new URL(raw).pathname.toLowerCase().split(/[\/._-]/).filter(Boolean);
    for (const part of parts.reverse()) { const entry = LANGUAGES.find(([a, b]) => part === a || part === b); if (entry) return entry[0]; }
  } catch { /* not an address */ }
  return null;
}

// ---- Putting subtitles into the finished video ----
const textCodec = ext => ({ '.mp4': 'mov_text', '.m4v': 'mov_text', '.mov': 'mov_text', '.mkv': 'srt', '.webm': 'webvtt' }[ext.toLowerCase()] || null);
export const canEmbed = file => textCodec(path.extname(file)) !== null;
const run = (command, args, signal, collect = false) => new Promise((resolve, reject) => {
  const child = spawnManaged(command, args, { windowsHide: true, stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'], signal });
  let out = '', err = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { err = (err + chunk).slice(-3000); });
  if (collect) { child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { out = (out + chunk).slice(0, 2000000); }); }
  child.on('error', reject);
  child.on('close', code => signal?.aborted ? reject(signal.reason) : code === 0 ? resolve(out) : reject(new Error(err || `Kod ${code}`)));
});
export async function probeStreams(file, toolsDirectory, signal) {
  const text = await run(path.join(toolsDirectory, 'ffprobe.exe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], signal, true);
  const info = JSON.parse(text);
  const count = type => (info.streams || []).filter(stream => stream.codec_type === type).length;
  return { video: count('video'), audio: count('audio'), subtitle: count('subtitle'), duration: Number(info.format?.duration) || null };
}
export function muxArguments(video, tracks, output) {
  const codec = textCodec(path.extname(video)), args = ['-v', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', video];
  for (const track of tracks) args.push('-protocol_whitelist', 'file,pipe', '-i', track.file);
  args.push('-map', '0:v?', '-map', '0:a?');
  tracks.forEach((_, index) => args.push('-map', `${index + 1}:0`));
  args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', codec);
  tracks.forEach((track, index) => {
    args.push(`-metadata:s:s:${index}`, `language=${track.iso3 || 'und'}`, `-metadata:s:s:${index}`, `title=${track.name}`, `-disposition:s:${index}`, track.default ? 'default' : '0');
  });
  if (['mov_text'].includes(codec)) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}
// Writes a new file next to the video; the original is replaced only after the new one is verified. Returns false when not possible.
export async function embedSubtitles({ video, tracks, toolsDirectory, signal }) {
  if (!tracks.length || !canEmbed(video)) return false;
  const before = await probeStreams(video, toolsDirectory, signal);
  if (before.subtitle > 0 || before.video < 1) return false; // already has subtitles (or no picture): leave it untouched
  const output = `${video}.subtitles.part${path.extname(video)}`;
  fs.rmSync(output, { force: true });
  try {
    await run(path.join(toolsDirectory, 'ffmpeg.exe'), muxArguments(video, tracks, output), signal);
    const after = await probeStreams(output, toolsDirectory, signal);
    const durationOk = !before.duration || !after.duration || Math.abs(after.duration - before.duration) <= Math.max(1.5, before.duration * 0.01);
    if (after.subtitle !== tracks.length || after.video !== before.video || after.audio !== before.audio || !durationOk) throw new Error('Altyazılı dosya doğrulanamadı.');
    fs.renameSync(output, video);
    return true;
  } catch (error) {
    fs.rmSync(output, { force: true });
    if (signal?.aborted) throw error;
    return false;
  }
}
// Sidecar .srt files; never overwrites an existing file.
export function writeSidecars(video, tracks) {
  const base = video.slice(0, video.length - path.extname(video).length), written = [];
  for (const track of tracks) {
    for (let n = 1; n < 100; n++) {
      const file = `${base}.${track.iso1 || track.iso3 || 'und'}${n > 1 ? `.${n}` : ''}.srt`;
      try { fs.writeFileSync(file, `﻿${toSrt(track.cues)}`, { flag: 'wx' }); written.push(path.basename(file)); break; } catch (error) { if (error.code !== 'EEXIST') break; }
    }
  }
  return written;
}
