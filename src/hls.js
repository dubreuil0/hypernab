// Small, provider-independent HLS reader. No external resolver and no URL guessing.
import { m } from './messages.js';
import { requestRemote } from './network.js';
import { parseRemoteUrl } from './security.js';
import { recoverRead, RemoteResponseError, IncompleteResourceError } from './recovery.js';
import { SourceExpiredError } from './transfer.js';

const MAX = 2 * 1048576;
export function hlsAttributes(text) {
  const out = {};
  for (const match of text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,\s]+))/g)) out[match[1]] = match[2] ?? match[3];
  return out;
}
const address = (value, base) => parseRemoteUrl(new URL(value, base).href).href;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function parseHls(text, base) {
  if (!/^\uFEFF?#EXTM3U(?:\s|$)/.test(text)) return null;
  const variants = [], audios = [], segments = [], subtitles = [];
  let pending = null, duration = null, map = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
      const attrs = hlsAttributes(line);
      if (attrs.METHOD !== 'NONE') throw new Error(m('e.encrypted-drm-protected-hls-is-not'));
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = hlsAttributes(line);
      if (a.TYPE === 'AUDIO') audios.push({ group: a['GROUP-ID'], url: a.URI ? address(a.URI, base) : null, language: a.LANGUAGE, name: a.NAME, default: a.DEFAULT === 'YES' });
      else if (a.TYPE === 'SUBTITLES' && a.URI && subtitles.length < 32) { try { subtitles.push({ url: address(a.URI, base), language: a.LANGUAGE, name: a.NAME, default: a.DEFAULT === 'YES', forced: a.FORCED === 'YES' }); } catch { /* unusable address */ } }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = hlsAttributes(line);
    else if (line.startsWith('#EXT-X-MAP:')) {
      const a = hlsAttributes(line);
      if (a.BYTERANGE || (map && map !== address(a.URI, base))) throw new Error(m('e.a-changing-or-byte-range-hls'));
      map = address(a.URI, base);
    } else if (/^#EXT-X-(?:BYTERANGE|GAP|DISCONTINUITY)(?::|$)/.test(line)) throw new Error(m('e.byte-range-missing-or-discontinuous-hls'));
    else if (line.startsWith('#EXTINF:')) duration = positive(line.slice(8).split(',')[0]);
    else if (line && !line.startsWith('#')) {
      const url = address(line, base);
      if (pending) {
        const resolution = /^(\d+)x(\d+)$/i.exec(pending.RESOLUTION || '');
        const nameHeight = /^(\d{3,4})p$/i.exec(pending.NAME || '');
        const codecs = (pending.CODECS || '').split(',').map(s => s.trim());
        variants.push({ url, height: resolution ? Number(resolution[2]) : nameHeight ? Number(nameHeight[1]) : null, width: resolution ? Number(resolution[1]) : null,
          tbr: positive(pending['AVERAGE-BANDWIDTH'] || pending.BANDWIDTH) / 1000 || null, fps: positive(pending['FRAME-RATE']), name: pending.NAME,
          vcodec: codecs.find(c => /^(?:avc|hvc|hev|av01|vp09)/i.test(c)) || 'unknown', acodec: codecs.find(c => /^(?:mp4a|ac-3|ec-3|opus)/i.test(c)), audioGroup: pending.AUDIO,
          dynamic_range: pending['VIDEO-RANGE'] });
        pending = null;
      } else if (duration) { segments.push({ url, duration }); duration = null; }
    }
    if (variants.length > 256 || segments.length > 100000) throw new Error(m('e.the-hls-list-limit-was-exceeded'));
  }
  if (pending || duration !== null) throw new IncompleteResourceError(m('e.the-hls-list-was-cut-off'));
  if (!variants.length && !segments.length) throw new Error(m('e.the-hls-list-has-no-usable'));
  return { variants, audios, subtitles, segments, map, duration: segments.length ? segments.reduce((n, s) => n + s.duration, 0) : null, live: !variants.length && !/#EXT-X-ENDLIST(?:\s|$)/m.test(text) };
}

// Sniff the actual body, not its extension or MIME type. Stop immediately on non-HLS data.
export async function readHlsResponse(response, base, signal) {
  const chunks = []; let bytes = 0, prefix = Buffer.alloc(0);
  const abort = () => response.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const chunk of response) {
      signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk)); bytes += chunk.length;
      if (prefix.length < 32) prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 32 - prefix.length)]);
      const head = prefix.toString('utf8');
      if (bytes >= 12 && !/^\uFEFF?#EXTM3U(?:\s|$)/.test(head)) return null;
      if (bytes > MAX) throw new Error(m('e.the-hls-list-size-limit-was'));
    }
    const expected = Number(response.headers?.['content-length']);
    if (expected > 0 && expected !== bytes) throw new IncompleteResourceError(m('e.the-hls-list-was-received-incompletely'));
    return parseHls(Buffer.concat(chunks).toString('utf8'), base);
  } finally { signal?.removeEventListener('abort', abort); response.destroy(); }
}

export async function readHls({ url, headers = {}, signal, request = requestRemote, recovery = {} }) {
  return recoverRead(async parent => {
    const combined = AbortSignal.any([parent, AbortSignal.timeout(6000)]);
    try {
      const result = await request(url, combined, headers);
      if (result.response.statusCode !== 200) {
        const { statusCode, headers: responseHeaders } = result.response;
        result.response.destroy();
        if ([401, 403, 410].includes(statusCode)) throw new SourceExpiredError(m('e.http-code-the-hls-source-address', { code: statusCode }));
        throw new RemoteResponseError(statusCode, responseHeaders, m('e.resource.hls-list'));
      }
      return await readHlsResponse(result.response, String(result.url || url), combined);
    } catch (error) { combined.throwIfAborted(); throw error; }
  }, { ...recovery, signal });
}

export function hlsInfo(playlist, url, title = 'video') {
  const formats = [];
  for (const [index, variant] of playlist.variants.entries()) {
    const audioGroup = playlist.audios.filter(a => a.group === variant.audioGroup);
    const audio = audioGroup.find(a => a.default) || audioGroup[0];
    const audioId = audio?.url ? `hls_a${index}` : null;
    if (audioId) formats.push({ format_id: audioId, url: audio.url, vcodec: 'none', acodec: variant.acodec || 'unknown', ext: 'm4a', protocol: 'm3u8_native' });
    formats.push({ ...variant, format_id: `hls_v${index}`, ext: 'mp4', protocol: 'm3u8_native', acodec: audioId ? 'none' : variant.acodec || undefined, hlsAudioId: audioId });
  }
  if (!formats.length) formats.push({ format_id: 'hls_media', url, protocol: 'm3u8_native', ext: 'mp4', vcodec: 'unknown', hlsPlaylist: playlist });
  // Every sound the master offers (dubbed, original ...), not only the one the site marks as default.
  const audioTracks = [], seen = new Set();
  for (const audio of playlist.audios || []) {
    if (!audio.url || seen.has(audio.url) || audioTracks.length >= 16) continue;
    seen.add(audio.url);
    audioTracks.push({ id: `a${audioTracks.length}`, group: audio.group, url: audio.url, name: audio.name || null, language: audio.language || null, default: audio.default === true });
  }
  return { title, url, ext: 'mp4', extractor: 'Hypernab HLS', nativeHls: true, hlsSubtitles: playlist.subtitles || [], duration: playlist.duration, is_live: playlist.live, formats, audioTracks };
}

// The sounds the user can pick between: those of the group the first picture uses (what the player lets one switch between).
// Only offered when there really is a choice; addresses stay inside the program.
export function audioChoices(raw) {
  const tracks = Array.isArray(raw?.audioTracks) ? raw.audioTracks : [];
  const group = raw?.formats?.find(format => format.audioGroup)?.audioGroup ?? tracks[0]?.group;
  const mine = tracks.filter(track => track.group === group);
  return mine.length > 1 ? mine.map(({ id, name, language, default: isDefault }) => ({ id, name, language, default: isDefault })) : [];
}
