// Turns the formats a source really offers into user-selectable quality options.
// Pure and provider-agnostic: no host-specific selection rules or invented resolutions.
import { sourceMeasureKey } from './job-progress.js';

// A leading "-" would let a value pass as a command-line option, so ids must start with a letter, digit or "_".
const ID = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/;
const SELECTION = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}(\+[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99})?$/;
// Higher is better. Segmented manifests are selectable but a plain HTTP file is preferred when both exist.
const PROTOCOL_RANK = { https: 3, http: 3, m3u8_native: 1, m3u8: 1, http_dash_segments: 1, dash: 1 };
const CODEC_RANK = { avc: 0, vp9: 1, hevc: 2, av01: 3, vp8: 4 };

// Most widely playable first: MP4, then WebM, then MKV, then anything else.
const extRank = ext => ({ mp4: 0, webm: 1, mkv: 2 })[String(ext).toLowerCase()] ?? 3;

export function isFormatId(value) {
  return typeof value === 'string' && SELECTION.test(value);
}

export function mergedExtension(videoExt, audioExt) {
  return videoExt === 'mp4' && ['m4a', 'mp4'].includes(audioExt) ? 'mp4'
    : videoExt === 'webm' && ['webm', 'opus'].includes(audioExt) ? 'webm' : 'mkv';
}

export function codecFamily(vcodec = '') {
  const c = String(vcodec).toLowerCase();
  if (c === 'unknown') return { key: 'unknown', name: '' };
  if (c.startsWith('avc') || c.startsWith('h264')) return { key: 'avc', name: 'H.264' };
  if (c.startsWith('vp09') || c.startsWith('vp9')) return { key: 'vp9', name: 'VP9' };
  if (c.startsWith('av01') || c.startsWith('av1')) return { key: 'av01', name: 'AV1' };
  if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return { key: 'hevc', name: 'H.265' };
  if (c.startsWith('vp8')) return { key: 'vp8', name: 'VP8' };
  const key = c.split('.')[0].replace(/[^a-z0-9]/g, '');
  return key ? { key, name: key.toUpperCase() } : { key: 'unknown', name: '' };
}

// Some sources (plain progressive files) report a height but no codec at all: still a real video.
const hasVideo = f => (Boolean(f.vcodec) && f.vcodec !== 'none') || (!f.vcodec && f.acodec !== 'none' && f.height > 0);
// HLS alternate-audio entries can explicitly say "no video" without naming the audio codec.
const hasAudio = f => f.acodec !== 'none' && (Boolean(f.acodec) || (f.vcodec === 'none' && /^(?:m3u8_native|m3u8|http_dash_segments|dash)$/.test(f.protocol || '')));
const isSplitVideo = f => f.acodec === 'none';

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function bytesOf(f) {
  if (f.filesize > 0) return { bytes: f.filesize, kind: 'exact' };
  if (f.filesize_approx > 0) return { bytes: f.filesize_approx, kind: 'approx' };
  return null;
}

function sizeOf(streams, duration) {
  const known = streams.map(bytesOf);
  if (known.every(Boolean)) {
    const bytes = known.reduce((sum, s) => sum + s.bytes, 0);
    // A merged file is a sum of separate streams plus container changes: never claim it is exact.
    return { filesize: bytes, sizeKind: streams.length === 1 && known[0].kind === 'exact' ? 'exact' : 'approx' };
  }
  if (duration > 0 && streams.every(f => f.tbr > 0)) {
    return { filesize: Math.round(streams.reduce((sum, f) => sum + f.tbr * 1000 / 8 * duration, 0)), sizeKind: 'approx' };
  }
  return { filesize: null, sizeKind: 'unknown' };
}

function pickAudio(video, audios, order) {
  const wanted = video.ext === 'mp4' ? ['m4a', 'mp4'] : video.ext === 'webm' ? ['webm', 'opus'] : [];
  let best = null, bestScore = null;
  for (const audio of audios) {
    if (video.hlsAudioId && audio.format_id !== video.hlsAudioId) continue;
    // Same-container audio avoids a Matroska fallback; language/original-track preference comes from the source's own ordering.
    const score = [wanted.includes(audio.ext) ? 1 : 0, PROTOCOL_RANK[audio.protocol] || 0, audio.language_preference || 0, audio.abr || audio.tbr || 0, order.get(audio)];
    if (!bestScore || compare(score, bestScore) > 0) { best = audio; bestScore = score; }
  }
  return best;
}

/**
 * Ordering of the result (documented, deterministic): height, then high frame rate, then HDR,
 * then codec compatibility (H.264 > VP9 > H.265 > AV1). Bit rates of different codecs are never
 * compared as if they meant equal quality. The first option is the default.
 */
export function buildQualityOptions(info, { ffmpeg = false } = {}) {
  if (!info || info._type === 'playlist' || info.entries || info.is_live) return { options: [], defaultOptionId: null };
  const formats = (info.formats || []).filter(f => f && f.has_drm !== true && ID.test(String(f.format_id)) && PROTOCOL_RANK[f.protocol]);
  const order = new Map(formats.map((format, index) => [format, index]));
  const audios = formats.filter(f => f.vcodec === 'none' && hasAudio(f));
  const groups = new Map();
  for (const video of formats.filter(f => hasVideo(f) && f.height > 0)) {
    const split = isSplitVideo(video);
    if (split && (!ffmpeg || !audios.length)) continue;
    const audio = split ? pickAudio(video, audios, order) : null;
    const fps = Number.isFinite(video.fps) && video.fps > 0 ? Math.round(video.fps) : null;
    const highFps = fps !== null && fps >= 48;
    const hdr = Boolean(video.dynamic_range) && !/^sdr$/i.test(video.dynamic_range);
    const codec = codecFamily(video.vcodec);
    const ext = split ? mergedExtension(video.ext, audio.ext) : video.ext;
    const key = [video.height, highFps ? fps : 'std', hdr ? 'hdr' : 'sdr', codec.key, ext].join('|');
    const videoRate = video.vbr || (video.tbr ? video.tbr - (split ? 0 : video.abr || 0) : 0);
    const score = [PROTOCOL_RANK[video.protocol], videoRate, split ? 0 : 1, order.get(video)];
    if (groups.has(key) && compare(score, groups.get(key).score) <= 0) continue;
    groups.set(key, { score, video, audio, split, fps, highFps, hdr, codec, ext, direct: PROTOCOL_RANK[video.protocol] >= 3 });
  }
  // Segmented manifests (HLS/DASH) only matter when the same picture size has no plain HTTP file.
  const sizeKey = g => [g.video.height, g.highFps ? g.fps : 'std', g.hdr].join('|');
  const directSizes = new Set([...groups.values()].filter(g => g.direct).map(sizeKey));
  for (const [key, g] of groups) if (!g.direct && directSizes.has(sizeKey(g))) groups.delete(key);
  // A copy with no codec info is redundant once the same picture size is offered with a known codec.
  const described = new Set([...groups.values()].filter(g => g.codec.key !== 'unknown').map(g => [g.video.height, g.highFps ? g.fps : 'std', g.hdr, g.ext].join('|')));
  for (const [key, g] of groups) if (g.codec.key === 'unknown' && described.has([g.video.height, g.highFps ? g.fps : 'std', g.hdr, g.ext].join('|'))) groups.delete(key);
  const options = [...groups.values()].map(({ video, audio, split, fps, highFps, hdr, codec, ext }) => {
    const streams = split ? [video, audio] : [video];
    return {
      id: split ? `${video.format_id}+${audio.format_id}` : video.format_id,
      measurementKey: sourceMeasureKey(streams),
      label: [`${video.height}p${highFps ? fps : ''}${hdr ? ' HDR' : ''}`, ext.toUpperCase(), codec.name].filter(Boolean).join(' · '),
      height: video.height, fps, hdr, ext, codec: codec.name,
      audio: split ? 'merged' : hasAudio(video) || video.acodec === undefined || video.acodec === null ? 'included' : 'none',
      ...sizeOf(streams, info.duration), rank: codec.key in CODEC_RANK ? CODEC_RANK[codec.key] : 5
    };
  }).sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0) || Number(b.hdr) - Number(a.hdr) || extRank(a.ext) - extRank(b.ext) || a.rank - b.rank)
    .map(({ rank, ...option }) => option);
  // Curation for people who do not want to think about formats: ONE recommended entry per picture size (the most widely playable
  // container/codec), the rest stay selectable under "other formats". Tiny pictures only count when nothing bigger exists.
  const seen = new Set();
  const hasBig = options.some(option => option.height >= 240);
  for (const option of options) {
    const sizeKey = [option.height, option.fps >= 48 ? option.fps : 'std', option.hdr].join('|');
    option.recommended = !seen.has(sizeKey) && (option.height >= 240 || !hasBig);
    seen.add(sizeKey);
  }
  return { options, defaultOptionId: options[0]?.id ?? null };
}

// The pick that is pre-selected for the user (Settings → default quality). Never invents a quality: it only chooses among the
// offered options. maxQuality caps the picture height ('best' = no cap); preferCompatible picks H.264 in MP4 at that height when
// it exists (plays on every device), otherwise the normal recommendation stays.
export function preferredOptionId(options, { maxQuality = 'best', preferCompatible = false } = {}) {
  if (!options?.length) return null;
  const recommended = options.filter(option => option.recommended !== false);
  const pool = recommended.length ? recommended : options;
  const capped = maxQuality === 'best' ? pool : pool.filter(option => option.height <= maxQuality);
  const top = (capped.length ? capped : [pool.at(-1) ?? options.at(-1)])[0];
  if (!preferCompatible || /H\.264/.test(top.codec || '')) return top.id;
  const compatible = options.find(option => option.height === top.height && option.fps === top.fps && /H\.264/.test(option.codec || '') && option.ext === 'mp4' && option.hdr === top.hdr);
  return (compatible ?? top).id;
}
