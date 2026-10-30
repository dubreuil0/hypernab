import path from 'node:path';
import { parseRemoteUrl } from './security.js';
import { mediaHeaders } from './media.js';
import { mergedExtension } from './quality.js';

const mediaExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'ts', 'm4a', 'mp3', 'aac', 'ogg', 'opus', 'wav']);
const unsafeExtensions = new Set(['exe', 'cmd', 'bat', 'ps1', 'com', 'scr', 'msi', 'js', 'vbs', 'lnk', 'html', 'htm', 'svg']);

export function safeExtension(url, contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const known = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf',
    'video/mp2t': 'ts', 'video/x-flv': 'flv', 'video/x-msvideo': 'avi', 'video/x-ms-wmv': 'wmv', 'video/3gpp': '3gp', 'video/ogg': 'ogv', 'video/mpeg': 'mpg', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'weba' };
  if (known[mime]) return known[mime];
  const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{1,6}$/.test(ext) && !unsafeExtensions.has(ext) ? ext : 'bin';
}

export function isManifest(contentType = '', url = '') {
  if (/mpegurl|dash\+xml/i.test(contentType)) return true;
  try { return /\.(m3u8|mpd)$/i.test(new URL(url).pathname); } catch { return false; }
}

export function sourceHeaders(source, info, fallback = {}) {
  const headers = { ...info?.http_headers, ...source?.http_headers };
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return mediaHeaders({ userAgent: normalized['user-agent'] || fallback['User-Agent'], referer: normalized.referer || fallback.Referer });
}

export function selectedFormat(info) {
  const sources = info.requested_formats?.length ? info.requested_formats : [info];
  const ids = sources.map(source => source.format_id);
  return ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(id)) ? ids.join('+') : null;
}

// Decisions depend on the selected resource, never on a provider's hostname.
export function selectSourcePlan(info, { ffmpeg = false, ffprobe = false } = {}) {
  if (info._type === 'playlist' || info.entries) throw new Error('Bu bağlantı bir oynatma listesi (dizi/liste). Uygulamada bağlantıyı yapıştırarak bölümleri tek seferde sıraya ekleyebilirsin.');
  const sources = info.requested_formats?.length ? info.requested_formats : [info];
  if (info.has_drm === true || sources.some(source => source.has_drm === true)) throw new Error('DRM korumalı kaynak desteklenmiyor.');
  const native = reason => ({ method: 'yt-dlp', reason, selectedFormat: selectedFormat(info) });
  if (info.is_live) return native('Canlı kaynak standart akış motoruyla işleniyor.');
  if (!ffprobe) return native('Medya doğrulaması için ffprobe bulunamadı; standart motor kullanılıyor.');
  if (!sources.length || sources.length > 2) return native('Seçilen akış yapısı standart medya motoru gerektiriyor.');
  for (const source of sources) {
    if (!/^https?$/.test(source.protocol || '') || source.fragments?.length || isManifest('', source.url)) return native('Parçalı yayın, uygun HLS/DASH motoruyla indiriliyor.');
    try { parseRemoteUrl(source.url); } catch { throw new Error('Çözümlenen medya adresi güvenli bir HTTP/HTTPS adresi değil.'); }
    if (!mediaExtensions.has(source.ext)) return native('Bu medya biçimi standart motorla işleniyor.');
  }
  if (sources.length === 1) return { method: 'parallel-http', sources, extension: sources[0].ext, selectedFormat: selectedFormat(info) };
  if (!ffmpeg) return native('Ayrı görüntü ve ses için FFmpeg gerekli.');
  const video = sources.find(source => source.vcodec && source.vcodec !== 'none' && source.acodec === 'none');
  const audio = sources.find(source => source.vcodec === 'none' && source.acodec && source.acodec !== 'none');
  if (!video || !audio) return native('Seçilen akışlar güvenle ayrı görüntü ve ses olarak sınıflandırılamadı.');
  const extension = mergedExtension(video.ext, audio.ext);
  return { method: 'parallel-streams', sources: [video, audio], extension, selectedFormat: selectedFormat(info) };
}
