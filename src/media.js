import path from 'node:path';
import fs from 'node:fs';
import { spawnManaged } from './process.js';
import { parseRemoteUrl, resolveRemote, safeTitle } from './security.js';
import { buildQualityOptions, isFormatId } from './quality.js';
import { enrichPlaylistFormats } from './playlist-probe.js';

export function mediaHeaders(input = {}) {
  const result = {};
  if (typeof input.userAgent === 'string' && input.userAgent.length <= 512 && !/[\r\n]/.test(input.userAgent)) result['User-Agent'] = input.userAgent;
  if (input.referer) {
    // A page we would not download from anyway (local address, odd port) is no reason to refuse the video: just send no Referer.
    try {
      const referer = parseRemoteUrl(input.referer);
      // Do not pass signed page query strings to unrelated CDN hosts.
      result.Referer = `${referer.origin}${referer.pathname}`;
    } catch { /* unusable referer is dropped */ }
  }
  return result;
}

export function baseExtractorArgs(toolsDirectory, headers = {}, cookieFile = null) {
  const args = [
    '--ignore-config', '--no-playlist', '--no-colors', '--encoding', 'utf-8', '--socket-timeout', '20',
    '--js-runtimes', `node:${process.execPath}`, '--no-remote-components'
  ];
  if (fs.existsSync(path.join(toolsDirectory, 'ffmpeg.exe'))) args.push('--ffmpeg-location', toolsDirectory);
  if (headers['User-Agent']) args.push('--user-agent', headers['User-Agent']);
  if (headers.Referer) args.push('--referer', headers.Referer);
  // Session cookies go through a short-lived file, never the command line (visible to other processes).
  if (cookieFile) args.push('--cookies', cookieFile);
  return args;
}

export function formatSelector(quality, hasFFmpeg) {
  const limit = ['1080', '720', '480'].includes(quality) ? `[height<=${quality}]` : '';
  // Do not force pre-merged "best": modern sites often offer only separate streams.
  return hasFFmpeg ? `bv*${limit}+ba/b${limit}` : `b${limit}`;
}

// Access limited to signed-in / following / paying users. Hypernab never works around it; with the user's own session it may work.
export const SESSION_REQUIRED = 'Bu video yalnızca oturum açmış ve izni olan kullanıcılara açık (ör. yalnızca takipçiler, üyeler veya gizli video). Sitede oturum açıp videoyu kendi tarayıcında aç ve sayfadaki Hypernab düğmesiyle indir; oturumun yalnızca bu video için ve diske yazılmadan kullanılır. Hypernab erişim kısıtlamasını aşmaz.';
const sessionPattern = /only available (?:to|for) (?:followers|subscribers|members|registered users|friends)|available (?:only )?to (?:followers|members)|Sign in to confirm|sign in to view|login required|log ?in (?:is )?required|requires? (?:authentication|login|an account)|use --cookies|private video|This video is private|members[- ]only|join this channel|need to log ?in|access (?:to this video )?(?:is )?restricted/i;
export const sessionRequired = message => message === SESSION_REQUIRED || sessionPattern.test(String(message));
export function cleanMediaError(raw) {
  const safe = String(raw).replace(/https?:\/\/[^\s]+/g, '[bağlantı]').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const lastError = safe.split(/\r?\n/).filter(line => /^(?:ERROR:|HTTP \d)/.test(line)).at(-1);
  const detail = (lastError || safe || 'Medya bilgisi alınamadı.').slice(-650);
  if (/Cloudflare|anti-bot challenge/i.test(detail)) return 'Site, otomatik sayfa isteğini Cloudflare doğrulamasıyla engelledi. Tarayıcıda sayfayı normal şekilde açıp videoyu oynat; eklentide yakalanan medya kaynağını incele. Bu da her kaynak için başarı garantisi değildir; oturum gerektiren kaynaklar desteklenmeyebilir.';
  if (/DRM[- ]?(?:protected|protection)|protected (?:by|with) DRM|DRM koruma/i.test(detail)) return 'Kaynak DRM korumalı. Hypernab DRM korumasını kaldırmaz; bu kaynak desteklenmiyor.';
  if (sessionPattern.test(detail)) return SESSION_REQUIRED;
  if (/Unsupported URL|No video formats found|Unsupported webpage/i.test(detail)) return 'Sayfa çözümleyici bu bağlantıda video bulamadı veya sayfa desteklenmiyor. Videoyu tarayıcıda oynatıp eklentide yakalanan MP4/HLS/DASH kaynağını incele.';
  if (/Requested format is not available/i.test(detail)) return 'Uygun indirilebilir format bulunamadı. FFmpeg kurulumunu kontrol et; sayfa bağlantısını yeniden incele. Ayrıntı: ' + detail;
  if (/HTTP (?:Error )?(400|401|403|410)/i.test(detail)) return 'Kaynak isteği reddedildi. Parça bağlantısı, tarayıcı oturumu veya süresi dolan bağlantı olabilir. Videoyu yeniden oynatıp sayfa bağlantısını incele. ' + detail;
  return detail;
}

export function summarizeMedia(info, input = {}) {
  if (info._type === 'playlist' || info.entries) throw new Error('Bu bağlantı bir oynatma listesi (dizi/liste). Uygulamada bağlantıyı yapıştırarak bölümleri tek seferde sıraya ekleyebilirsin.');
  const formats = (info.formats || []).filter(f => f.has_drm !== true && f.vcodec && f.vcodec !== 'none');
  const heights = [...new Set(formats.map(f => f.height).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => b - a);
  const selected = info.requested_formats || info.requested_downloads || [];
  const sizes = selected.map(f => f.filesize || f.filesize_approx);
  const filesize = info.filesize || info.filesize_approx || (sizes.length && sizes.every(n => n > 0) ? sizes.reduce((a, b) => a + b, 0) : null);
  return {
    title: safeTitle(input.title || info.title || 'video'),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    extension: /^[a-z0-9]{1,8}$/i.test(info.ext || '') ? info.ext : null,
    filesize: filesize || null,
    estimatedSize: !info.filesize,
    heights,
    formatCount: formats.length,
    extractor: String(info.extractor_key || info.extractor || 'Medya').slice(0, 80)
  };
}

export async function extractMediaInfo({ url, quality = 'best', formatId = null, toolsDirectory, headers = {}, cookieFile = null, signal }) {
  await resolveRemote(url);
  if (formatId !== null && !isFormatId(formatId)) throw new Error('Geçersiz format seçimi.');
  const overflow = new AbortController();
  const processSignal = signal ? AbortSignal.any([signal, overflow.signal]) : overflow.signal;
  // An explicit id is passed as one validated token; it is never a free-form yt-dlp expression.
  const selector = formatId ?? formatSelector(quality, fs.existsSync(path.join(toolsDirectory, 'ffmpeg.exe')));
  // --flat-playlist: an address that is a whole series/playlist is recognised at once (list only) instead of resolving every video first.
  const args = [...baseExtractorArgs(toolsDirectory, headers, cookieFile), '--flat-playlist', '--skip-download', '--dump-single-json', '-f', selector, '--', url];
  return new Promise((resolve, reject) => {
    const child = spawnManaged(path.join(toolsDirectory, 'yt-dlp.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: processSignal });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let output = '', errors = '', oversized = false;
    child.stdout.on('data', chunk => {
      if (oversized) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > 12 * 1024 * 1024) { oversized = true; output = ''; overflow.abort(); }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => {
      if (oversized) return reject(new Error('Medya bilgisi sınırı aşıldı.'));
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(cleanMediaError(errors)));
      try { resolve(JSON.parse(output)); }
      catch (error) { reject(new Error(error instanceof SyntaxError ? 'Medya motorundan geçerli bilgi alınamadı.' : error.message)); }
    });
  });
}

export async function inspectWithExtractor(input) {
  const info = await extractMediaInfo(input);
  await enrichPlaylistFormats(info, input); // bare HLS playlists: measure the real picture size instead of showing no quality
  const { options, defaultOptionId } = buildQualityOptions(info, { ffmpeg: fs.existsSync(path.join(input.toolsDirectory, 'ffmpeg.exe')) });
  // rawInfo stays on the server (never sent to clients): it lets a download that starts a moment later skip a second, slow resolve.
  return { ...summarizeMedia(info, { title: input.title }), options, defaultOptionId, rawInfo: info, silentStream: info.silentStream === true, audioOnly: info.audioOnly === true };
}

export async function verifyVideo(file, toolsDirectory, expectedDuration, signal, { requireVideo = true, requireAudio = true } = {}) {
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const info = await new Promise((resolve, reject) => {
    const child = spawnManaged(path.join(toolsDirectory, 'ffprobe.exe'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type,width,height:format=duration,size', '-of', 'json', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: combined });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (output.length < 1048576) output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => {
      if (combined.aborted) return reject(combined.reason);
      if (code !== 0) return reject(new Error('İndirilen video ffprobe doğrulamasından geçemedi.'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Video doğrulama çıktısı okunamadı.')); }
    });
  });
  const duration = Number(info.format?.duration);
  const video = info.streams?.find(stream => stream.codec_type === 'video');
  const audio = info.streams?.some(stream => stream.codec_type === 'audio') || false;
  if ((requireVideo && !video) || (requireAudio && !audio) || !(duration > 0)) throw new Error('Dosyada beklenen görüntü, ses veya geçerli süre bulunamadı.');
  if (expectedDuration > 0 && Math.abs(duration - expectedDuration) > Math.max(3, expectedDuration * 0.02)) throw new Error('İndirilen videonun süresi kaynakla eşleşmiyor.');
  return { duration, width: video?.width || null, height: video?.height || null, audio };
}

export async function mergeMediaFiles(files, output, toolsDirectory, signal) {
  signal?.throwIfAborted();
  if (files.length !== 2) throw new Error('Bir görüntü ve bir ses dosyası gerekli.');
  const args = ['-v', 'error', '-nostdin', '-n'];
  for (const file of files) args.push('-protocol_whitelist', 'file,pipe', '-i', file);
  args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', output);
  await new Promise((resolve, reject) => {
    const child = spawnManaged(path.join(toolsDirectory, 'ffmpeg.exe'), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let errors = ''; child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => {
      if (signal?.aborted) return reject(signal.reason);
      if (code === 0) resolve(); else reject(new Error(cleanMediaError(errors || 'Ses ve görüntü birleştirilemedi.')));
    });
  });
}

export async function decodeMedia(file, toolsDirectory, signal, timeoutMilliseconds = 600000) {
  const deadline = AbortSignal.timeout(timeoutMilliseconds);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  await new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'];
    const child = spawnManaged(path.join(toolsDirectory, 'ffmpeg.exe'), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: combined });
    let errors = ''; child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => {
      if (combined.aborted) return reject(signal?.aborted ? signal.reason : new Error('Derin doğrulama 10 dakikalık süre sınırını aştı.'));
      if (code === 0) resolve(); else reject(new Error(cleanMediaError(errors || 'Dosya baştan sona çözümlenirken hata bulundu.')));
    });
  });
}
