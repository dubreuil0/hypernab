import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyVideo, decodeMedia } from './media.js';

export class VerificationError extends Error {}

export function mediaExpectation(info = {}) {
  const sources = info.requested_formats?.length ? info.requested_formats : [info];
  const video = sources.find(s => s.vcodec && s.vcodec !== 'none');
  const audio = sources.some(s => s.acodec !== 'none' && (Boolean(s.acodec) || (s.vcodec === 'none' && /^(?:m3u8_native|m3u8|http_dash_segments|dash)$/.test(s.protocol || ''))));
  return { requireVideo: Boolean(video) || info.vcodec !== 'none', requireAudio: audio, expectedDuration: Number(info.duration) || null, expectedHeight: Number(video?.height || info.height) || null };
}

export function isVideoFile(file, contentType = '') {
  return /^video\//i.test(contentType) || /\.(mp4|webm|mkv|mov|m4v|flv|ts|avi|wmv|3gp|ogv|mpg|mpeg)$/i.test(file);
}

export async function verifyCompletedFile({ file, expectedSize, media = null, expectedSha256 = null, deep = false, toolsDirectory, signal, probe = verifyVideo, decoder = decodeMedia, onDeep = () => {} }) {
  signal?.throwIfAborted();
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new VerificationError('Doğrulanacak çıktı normal bir dosya değil.');
  if (expectedSize !== undefined && expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) throw new VerificationError('Beklenen dosya boyutu geçersiz.');
  if (Number.isSafeInteger(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) throw new VerificationError('Dosya boyutu beklenen değerle eşleşmiyor.');
  const result = { status: 'passed', bytes: stat.size, sizeCompared: Number.isSafeInteger(expectedSize), level: 'bytes', sha256: null, media: null, deep: false, warning: null };
  if (expectedSha256) {
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new VerificationError('SHA-256 değeri 64 onaltılık karakter olmalı.');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    result.sha256 = hash.digest('hex');
    if (result.sha256 !== expectedSha256.toLowerCase()) throw new VerificationError('Dosyanın SHA-256 değeri beklenen özetle eşleşmiyor.');
  }
  if (media) {
    if (stat.size === 0) throw new VerificationError('Medya dosyası boş.');
    if (!fs.existsSync(path.join(toolsDirectory, 'ffprobe.exe'))) {
      if (deep) throw new VerificationError('Derin medya doğrulaması için ffprobe gerekli.');
      result.status = 'limited'; result.warning = `${result.sizeCompared ? 'Boyut karşılaştırıldı' : 'Dosya boyutu ölçüldü'}; ffprobe olmadığı için medya yapısı doğrulanamadı.`;
    } else {
      try { result.media = await probe(file, toolsDirectory, media.expectedDuration, signal, media); }
      catch (error) { if (signal?.aborted) throw error; throw new VerificationError(error.message); }
      if (media.expectedHeight && result.media.height !== media.expectedHeight) throw new VerificationError('Çıktının çözünürlüğü seçilmiş kaynakla eşleşmiyor.');
      result.level = 'media';
      if (deep) {
        if (!fs.existsSync(path.join(toolsDirectory, 'ffmpeg.exe'))) throw new VerificationError('Derin doğrulama için FFmpeg gerekli.');
        onDeep();
        try { await decoder(file, toolsDirectory, signal); }
        catch (error) { if (signal?.aborted) throw error; throw new VerificationError(error.message); }
        result.deep = true; result.level = 'deep-media';
      }
    }
  }
  signal?.throwIfAborted(); return result;
}
