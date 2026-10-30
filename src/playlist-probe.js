// Some sites hand out a bare HLS "media playlist" (one rendition, no master): yt-dlp then knows the duration but not the picture
// size, so the user would see no quality at all. This measures the stream itself instead of guessing: it reads the playlist,
// downloads the first segment's head and lets ffprobe read the real resolution / frame rate / codecs, and estimates the total
// size from the real sizes of a few segments spread over the playlist. Provider-agnostic; every request goes through the same
// guarded network layer as downloads (no local addresses). Encrypted or unreadable playlists are simply left unmeasured.
import fs from 'node:fs';
import path from 'node:path';
import { requestRemote } from './network.js';
import { spawnManaged } from './process.js';

// A slow CDN must not stall the quality list: ffprobe needs well under 1 MB of a segment, every step has its own short deadline.
const PLAYLIST_MAX = 2 * 1048576, HEAD_MAX = 1048576, SIZE_SAMPLES = 4, STEP_MS = 6000;
const positive = n => Number.isFinite(n) && n > 0;

async function readLimited(response, limit, signal) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response) { chunks.push(chunk); size += chunk.length; signal?.throwIfAborted(); if (size >= limit) break; }
  } finally { response.destroy(); }
  return Buffer.concat(chunks).subarray(0, limit);
}

// Pure: the facts of a media playlist the probe needs. null for a master playlist, an empty one or an encrypted one.
export function parseMediaPlaylist(text, base) {
  if (!/^#EXTM3U/m.test(text) || /#EXT-X-STREAM-INF/.test(text) || /#EXT-X-KEY:(?![^\n]*METHOD=NONE)/.test(text)) return null;
  const segments = []; let pending = null, map = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) { const uri = /URI="([^"]+)"/.exec(line)?.[1]; if (uri) map = new URL(uri, base).href; continue; }
    if (line.startsWith('#EXTINF:')) { pending = Number.parseFloat(line.slice(8)); continue; }
    if (line.startsWith('#')) continue;
    if (positive(pending)) { try { segments.push({ url: new URL(line, base).href, duration: pending }); } catch { /* bad line */ } }
    pending = null;
  }
  if (!segments.length) return null;
  return { segments, map, duration: segments.reduce((sum, s) => sum + s.duration, 0) };
}

function runProbe(toolsDirectory, data, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnManaged(path.join(toolsDirectory, 'ffprobe.exe'), ['-v', 'error', '-protocol_whitelist', 'pipe', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate', '-of', 'json', '-i', 'pipe:0'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (output.length < 262144) output += chunk; });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {}); // ffprobe may stop reading early; that is fine
    child.on('error', reject);
    child.on('close', () => { try { resolve(JSON.parse(output)); } catch { reject(new Error('ffprobe çıktısı okunamadı.')); } });
    child.stdin.end(data);
  });
}

const rate = value => { const [a, b] = String(value || '').split('/').map(Number); return positive(a) && positive(b || 1) ? a / (b || 1) : null; };

/**
 * Measures one media playlist. Returns { height, width, fps, vcodec, acodec, tbr (kbit/s), filesize, duration } or null.
 * `request` is injectable for tests.
 */
export async function probeMediaPlaylist({ url, headers = {}, toolsDirectory, signal, request = requestRemote, playlist: knownPlaylist = null }) {
  if (!fs.existsSync(path.join(toolsDirectory, 'ffprobe.exe'))) return null;
  const step = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(STEP_MS)]) : AbortSignal.timeout(STEP_MS));
  const get = async (target, extra = {}) => request(target, step(), { ...headers, ...extra });
  let playlist = knownPlaylist;
  if (!playlist) {
    const { response: list, url: finalUrl } = await get(url);
    if (list.statusCode >= 400) { list.destroy(); return null; }
    playlist = parseMediaPlaylist((await readLimited(list, PLAYLIST_MAX, step())).toString('utf8'), finalUrl.href);
  }
  if (!playlist) return null;
  // Head of the first segment (plus the init segment of fragmented MP4) is enough for ffprobe to read the streams.
  const parts = [];
  if (playlist.map) {
    const { response } = await get(playlist.map, { Range: `bytes=0-${HEAD_MAX - 1}` });
    if (response.statusCode >= 400) response.destroy(); else parts.push(await readLimited(response, HEAD_MAX, step()));
  }
  const first = await get(playlist.segments[0].url, { Range: `bytes=0-${HEAD_MAX - 1}` });
  if (first.response.statusCode >= 400) { first.response.destroy(); return null; }
  const head = await readLimited(first.response, HEAD_MAX, step());
  if (!head.length) return null;
  parts.push(head);
  const probed = await runProbe(toolsDirectory, Buffer.concat(parts), signal);
  const video = (probed.streams || []).find(stream => stream.codec_type === 'video' && positive(stream.height));
  const audio = (probed.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video && !audio) return null;
  // Size: real sizes of a few segments spread over the playlist (the first one can be an atypical intro), scaled to the duration.
  const picks = [...new Set(Array.from({ length: SIZE_SAMPLES }, (_, i) => Math.floor(i * playlist.segments.length / SIZE_SAMPLES)))].map(i => playlist.segments[i]);
  let bytes = 0, seconds = 0;
  await Promise.all(picks.map(async segment => {
    try {
      const { response } = await get(segment.url, { Range: 'bytes=0-0' });
      const total = Number(/\/(\d+)$/.exec(response.headers['content-range'] || '')?.[1]) || (response.statusCode === 200 ? Number(response.headers['content-length']) : 0);
      response.destroy();
      if (positive(total)) { bytes += total; seconds += segment.duration; }
    } catch { /* an unreachable sample only lowers accuracy */ }
  }));
  const perSecond = seconds > 0 ? bytes / seconds : null;
  return {
    audioOnly: !video, height: video ? Number(video.height) : null, width: video ? Number(video.width) || null : null, fps: video ? rate(video.avg_frame_rate) || rate(video.r_frame_rate) : null,
    vcodec: video ? String(video.codec_name || '') : '', acodec: audio ? String(audio.codec_name || '') : null,
    tbr: perSecond ? Math.round(perSecond * 8 / 1000) : null, filesize: perSecond ? Math.round(perSecond * playlist.duration) : null, duration: playlist.duration
  };
}

// Fills in what yt-dlp could not say for bare HLS playlists, so the normal quality pipeline can offer them. Never throws.
export async function enrichPlaylistFormats(info, { headers = {}, toolsDirectory, signal, probe = probeMediaPlaylist } = {}) {
  try {
    const timeout = AbortSignal.timeout(10000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const candidates = (info.formats || []).filter(f => f && f.url && /^m3u8/.test(f.protocol || '') && !(f.height > 0) && f.has_drm !== true && f.vcodec !== 'none').slice(0, 3);
    for (const format of candidates) {
      const measured = await probe({ url: format.url, headers: { ...headers, ...format.http_headers }, toolsDirectory, signal: combined }).catch(() => null);
      if (!measured) continue;
      if (measured.audioOnly) { Object.assign(format, { vcodec: 'none', acodec: measured.acodec || 'unknown', ...(measured.tbr ? { abr: measured.tbr } : {}), ...(measured.filesize ? { filesize_approx: measured.filesize } : {}), measured: true }); if (!(info.duration > 0) && measured.duration) info.duration = measured.duration; info.audioOnly = true; continue; }
      Object.assign(format, { height: measured.height, width: measured.width, fps: measured.fps, vcodec: measured.vcodec || format.vcodec, ...(measured.acodec ? { acodec: measured.acodec } : {}), ...(measured.tbr ? { tbr: measured.tbr } : {}), ...(measured.filesize ? { filesize_approx: measured.filesize } : {}), measured: true });
      if (!(info.duration > 0) && measured.duration) info.duration = measured.duration;
      // A measured picture without any sound, and nothing else offers sound: the page keeps the sound in another playlist.
      if (!measured.acodec && !info.formats.some(other => other !== format && other.acodec && other.acodec !== 'none')) info.silentStream = true;
    }
  } catch { /* measuring is optional */ }
  return info;
}
