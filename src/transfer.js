import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { requestRemote } from './network.js';
import { createHash, randomUUID } from 'node:crypto';
import { AdaptiveWindow } from './connection-budget.js';
import { RemoteResponseError } from './recovery.js';

export class RangeUnsupportedError extends Error {}

// Up to `limit` indexes spread over [0, count), always including the first and the last.
export function spreadIndexes(count, limit) {
  if (count <= 0 || limit <= 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  if (limit === 1) return [count - 1];
  return [...new Set(Array.from({ length: limit }, (_, i) => Math.round(i * (count - 1) / (limit - 1))))];
}
export class SourceChangedError extends Error {}
export class SourceExpiredError extends Error {}
export class IntegrityError extends Error {}
export class RateLimitedError extends RemoteResponseError {
  constructor(milliseconds, status = 429) { super(status); this.message = 'Sunucu geçici bağlantı sınırı uyguladı.'; this.retryAfter = milliseconds; }
}

function checkStatus(response) {
  if ([401, 403, 410].includes(response.statusCode)) throw new SourceExpiredError(`HTTP ${response.statusCode}: kaynak adresi/erişimi yenilenmeli.`);
  if ([429, 503].includes(response.statusCode)) {
    const value = response.headers['retry-after'];
    const ms = /^\d+(?:\.\d+)?$/.test(value || '') ? Number(value) * 1000 : Date.parse(value) - Date.now();
    throw new RateLimitedError(Number.isFinite(ms) ? Math.max(0, ms) : 1000, response.statusCode);
  }
  if ([202, 408, 425, 500, 502, 504].includes(response.statusCode)) throw new RemoteResponseError(response.statusCode, response.headers);
}

function checkValidator(response, validator) {
  if (!validator) return;
  const value = response.headers[validator.type === 'etag' ? 'etag' : 'last-modified'];
  if (value && value !== validator.value) throw new SourceChangedError('Kaynak dosya indirme sırasında değişti; eski parçalarla birleştirilmedi.');
}

async function hashRange(file, start, end, signal) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { start, end, signal })) hash.update(chunk);
  return hash.digest('hex');
}

async function hashFile(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function publishFile(partial, destination, signal) {
  signal?.throwIfAborted();
  const total = fs.statSync(partial).size;
  let reusedExisting = false, sha256 = null;
  if (fs.existsSync(destination)) {
    if (fs.statSync(destination).size !== total) throw new Error('Hedef dosya zaten var ve farklı; üzerine yazılmadı.');
    const hashes = await Promise.all([hashFile(partial, signal), hashFile(destination, signal)]);
    if (hashes[0] !== hashes[1]) throw new Error('Hedef dosyanın içeriği farklı; üzerine yazılmadı.');
    sha256 = hashes[0]; reusedExisting = true;
    signal?.throwIfAborted(); fs.rmSync(partial);
  } else {
    try { await fs.promises.link(partial, destination); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
      await fs.promises.copyFile(partial, destination, fs.constants.COPYFILE_EXCL);
    }
    fs.rmSync(partial);
  }
  return { reusedExisting, sha256 };
}

export async function probeRange({ url, headers = {}, signal, request = requestRemote }) {
  signal?.throwIfAborted();
  const { response, url: finalUrl } = await request(url, signal, { ...headers, Range: 'bytes=0-0' });
  try {
    checkStatus(response);
    const match = /^bytes 0-0\/(\d+)$/.exec(response.headers['content-range'] || '');
    const total = match ? Number(match[1]) : 0;
    // What the server did say stays with the error, so a caller can use the headers without asking a second time.
    if (!Number.isSafeInteger(total) || total <= 0) throw Object.assign(new RangeUnsupportedError('Kaynak byte-range indirmeyi desteklemiyor.'), { observed: { status: response.statusCode, headers: { ...response.headers }, url: String(finalUrl?.href || finalUrl || url) } });
    validateRange(response, 0, 0, total);
    const etag = response.headers.etag;
    const modified = response.headers['last-modified'];
    const validator = typeof etag === 'string' && /^"[^"\x00-\x20\x7f]*"$/.test(etag) ? { type: 'etag', value: etag }
      : typeof modified === 'string' && /GMT$/.test(modified) && Number.isFinite(Date.parse(modified)) ? { type: 'modified', value: modified } : null;
    return { total, validator, contentType: String(response.headers['content-type'] || ''), disposition: String(response.headers['content-disposition'] || ''), url: String(finalUrl || url) };
  } catch (error) {
    if (error instanceof RateLimitedError) error.host = new URL(finalUrl || url).hostname;
    throw error;
  } finally { response.destroy(); }
}

export function planRanges(total, blockSize = 2 * 1024 * 1024) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('Geçersiz dosya/parça boyutu.');
  if (Math.ceil(total / blockSize) > 100000) throw new Error('Dosyada çok fazla parça var.');
  return Array.from({ length: Math.ceil(total / blockSize) }, (_, index) => ({ index, start: index * blockSize, end: Math.min(total - 1, (index + 1) * blockSize - 1) }));
}

export function validateRange(response, start, end, total) {
  checkStatus(response);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
  if (response.statusCode !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== total) {
    throw new RangeUnsupportedError(`Sunucu istenen byte aralığını doğrulamadı (HTTP ${response.statusCode}).`);
  }
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new RangeUnsupportedError('Sıkıştırılmış yanıt üzerinde güvenli parçalı indirme yapılamaz.');
  if (response.headers['content-length'] && Number(response.headers['content-length']) !== end - start + 1) throw new RangeUnsupportedError('Parça boyutu sunucu yanıtıyla eşleşmiyor.');
}

// Checkpoint v2 stores an exact partition plus hashes of committed segments.
// v1/malformed/changed checkpoints are archived, never guessed or discarded.
export async function downloadParallel({ url, headers = {}, destination, sourceKey, signal, connections = 8, blockSize = 2 * 1024 * 1024, request = requestRemote, sourceProbe, onProgress = () => {}, verify = async () => {}, overlap = 64, minSplitBytes = 128 * 1024, retryDelay = 250, maxResumeSamples = 12, resumeRetryDelay = 1500, onThrottle = () => {}, throttle = async () => {} }) {
  signal?.throwIfAborted();
  const { total, validator } = sourceProbe || await probeRange({ url, headers, signal, request });
  if (!Number.isInteger(overlap) || overlap < 1 || overlap > 4096) throw new Error('Geçersiz örtüşme boyutu.');
  const maximum = Math.min(Math.max(1, Math.trunc(connections) || 1), 8);
  const window = new AdaptiveWindow(maximum);
  const partial = `${destination}.parallel.part`, checkpoint = `${destination}.ranges.json`;
  const identity = { version: 2, total, blockSize, sourceKey, validator, overlap };
  let parts = planRanges(total, blockSize).map(p => ({ id: p.index, start: p.start, end: p.end, cursor: p.start, reservedEnd: p.start, state: 'pending', hash: null, leftHash: null }));
  const started = performance.now();
  let networkBytes = 0, payloadBytes = 0, verificationBytes = 0, resume = false, resumeReason = null;
  async function remoteSlice(start, end) {
    let response;
    try {
      const h = { ...headers, Range: `bytes=${start}-${end}`, 'If-Range': validator.value };
      ({ response } = await request(url, signal, h)); validateRange(response, start, end, total); checkValidator(response, validator);
      const chunks = []; let bytes = 0;
      for await (const chunk of response) { bytes += chunk.length; if (bytes > end - start + 1) throw new IntegrityError('Devam kontrolünde fazla veri alındı.'); chunks.push(chunk); }
      if (bytes !== end - start + 1) throw new IntegrityError('Devam kontrolünde eksik veri alındı.');
      verificationBytes += bytes; networkBytes += bytes; return Buffer.concat(chunks);
    } finally { response?.destroy(); }
  }
  // A 401/403 on a tiny sample right after a fresh URL is usually a per-URL rate limit: back off, then let the caller refresh.
  async function remoteSampleWithRetry(start, end) {
    for (let attempt = 0; ; attempt++) {
      try { return await remoteSlice(start, end); }
      catch (error) {
        if (!(error instanceof SourceExpiredError) || attempt >= 2) throw error;
        await delay(resumeRetryDelay * (attempt + 1), null, { signal });
      }
    }
  }
  if (fs.existsSync(partial) || fs.existsSync(checkpoint)) {
    onProgress({ received: 0, total, speed: 0, connections: 0, targetConnections: window.target, phase: 'checking-resume', resumeSupported: Boolean(validator), networkBytes: 0, resumedBytes: 0 });
    try {
      const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      if (!validator || JSON.stringify(saved.identity) !== JSON.stringify(identity) || !fs.statSync(partial).isFile() || fs.statSync(partial).size !== total) throw new IntegrityError('Kaynak kimliği/validator veya checkpoint sürümü aynı değil.');
      if (!Array.isArray(saved.parts) || !saved.parts.length || saved.parts.length > 100000 || !Array.isArray(saved.completed)) throw new IntegrityError('Checkpoint yapısı geçersiz.');
      const ids = new Set(); let nextByte = 0;
      for (const p of [...saved.parts].sort((a, b) => a.start - b.start)) {
        if (!Number.isSafeInteger(p.id) || p.id < 0 || p.id >= 100000 || ids.has(p.id) || p.start !== nextByte || !Number.isSafeInteger(p.end) || p.end < p.start || p.end >= total) throw new IntegrityError('Checkpoint aralıklarında boşluk/çakışma var.');
        ids.add(p.id); nextByte = p.end + 1;
      }
      if (nextByte !== total || saved.completed.some(id => !ids.has(id))) throw new IntegrityError('Checkpoint tam dosyayı kapsamıyor.');
      const completed = new Set(saved.completed);
      const toCheck = saved.parts.filter(p => completed.has(p.id));
      // Disk already holds these bytes; show them while they are being compared instead of "0".
      const claimed = toCheck.reduce((sum, p) => sum + p.end - p.start + 1, 0);
      let checked = 0;
      const report = () => onProgress({ received: claimed, total, speed: 0, connections: 0, targetConnections: window.target, phase: 'checking-resume', resumeSupported: true, networkBytes, resumedBytes: 0, resumeChecked: checked, resumeTotal: toCheck.length });
      report();
      // Local digests cover every committed block (disk only). Remote comparison is a bounded,
      // evenly spread sample: hundreds of tiny parallel requests make some CDNs answer 401 per URL.
      const sampled = new Set(spreadIndexes(toCheck.length, maxResumeSamples));
      const checkLocal = async p => {
        if (!/^[a-f0-9]{64}$/.test(p.hash || '') || (p.start && !/^[a-f0-9]{64}$/.test(p.leftHash || '')) || await hashRange(partial, p.start, p.end, signal) !== p.hash) throw new IntegrityError('Yerel kısmi dosyanın blok özeti eşleşmedi.');
        checked++; report();
      };
      let next = 0, checkFailure = null;
      await Promise.all(Array.from({ length: Math.min(4, toCheck.length) }, async () => {
        while (!checkFailure && next < toCheck.length) {
          try { await checkLocal(toCheck[next++]); } catch (error) { checkFailure ||= error; }
        }
      }));
      if (checkFailure) throw checkFailure;
      for (const index of sampled) {
        const p = toCheck[index];
        for (const [start, end] of [[p.start, Math.min(p.end, p.start + overlap - 1)], [Math.max(p.start, p.end - overlap + 1), p.end]]) {
          const bytes = await remoteSampleWithRetry(start, end);
          if (await hashRange(partial, start, end, signal) !== createHash('sha256').update(bytes).digest('hex')) throw new IntegrityError('Yeni kaynak verisi eski parçayla eşleşmedi.');
        }
      }
      parts = saved.parts.map(p => ({ id: p.id, start: p.start, end: p.end, hash: completed.has(p.id) ? p.hash : null, leftHash: completed.has(p.id) ? p.leftHash : null, state: completed.has(p.id) ? 'done' : 'pending', cursor: completed.has(p.id) ? p.end + 1 : p.start, reservedEnd: p.start }));
      resume = true;
    } catch (error) {
      if (signal?.aborted || error instanceof SourceExpiredError || error instanceof RateLimitedError) throw error;
      resumeReason = `${error.message} Önceki veriler korundu; aktarım baştan başlıyor.`;
    }
    if (!resume) {
      const suffix = `.previous-${randomUUID()}`;
      if (fs.existsSync(partial)) fs.renameSync(partial, partial + suffix);
      if (fs.existsSync(checkpoint)) fs.renameSync(checkpoint, checkpoint + suffix);
    }
  }
  const file = await fs.promises.open(partial, resume ? 'r+' : 'wx');
  const localAbort = new AbortController(), combined = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
  const resumedBytes = parts.filter(p => p.state === 'done').reduce((sum, p) => sum + p.end - p.start + 1, 0);
  const active = new Map(); let peak = 0, networkActive = 0, splits = 0, failure = null, phase = 'downloading';
  let lastTime = performance.now(), lastBytes = networkBytes;
  let nextId = parts.reduce((max, p) => Math.max(max, p.id), -1) + 1;
  function save() {
    const snapshot = parts.map(({ id, start, end, hash, leftHash }) => ({ id, start, end, hash, leftHash }));
    fs.writeFileSync(`${checkpoint}.tmp`, JSON.stringify({ identity, parts: snapshot, completed: parts.filter(p => p.state === 'done').map(p => p.id).sort((a, b) => a - b) }));
    fs.renameSync(`${checkpoint}.tmp`, checkpoint);
  }
  function progress(force = false) {
    const now = performance.now(); if (!force && now - lastTime < 300) return;
    onProgress({ received: parts.reduce((sum, p) => sum + (p.state === 'done' ? p.end - p.start + 1 : p.cursor - p.start), 0), total,
      speed: phase === 'downloading' ? (networkBytes - lastBytes) * 1000 / Math.max(1, now - lastTime) : 0,
      connections: networkActive, targetConnections: window.target, maxConnections: maximum, splits, reductions: window.reductions,
      resumedBytes, resumeSupported: Boolean(validator), resumeReason, phase, elapsedSeconds: (now - started) / 1000, networkBytes, payloadBytes, verificationBytes });
    lastTime = now; lastBytes = networkBytes;
  }
  function claim() {
    let part = parts.find(p => p.state === 'pending');
    if (!part && maximum > 1 && parts.length < 100000) {
      const candidates = parts.filter(p => p.state === 'active' && p.end + 1 - Math.max(p.cursor, p.reservedEnd) >= minSplitBytes * 2);
      const owner = candidates.sort((a, b) => (b.end + 1 - Math.max(b.cursor, b.reservedEnd)) - (a.end + 1 - Math.max(a.cursor, a.reservedEnd)))[0];
      if (owner) {
        const begin = Math.max(owner.cursor, owner.reservedEnd), midpoint = begin + Math.floor((owner.end + 1 - begin) / 2);
        part = { id: nextId++, start: midpoint, end: owner.end, cursor: midpoint, reservedEnd: midpoint, state: 'pending', hash: null, leftHash: null };
        owner.end = midpoint - 1; parts.push(part); splits++; save();
      }
    }
    if (part) part.state = 'active'; return part;
  }
  async function worker(part) {
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted(); let response, counted = false, effectiveUrl = url;
      const attemptStart = performance.now();
      part.cursor = part.start; part.reservedEnd = part.start; part.hash = null; part.leftHash = null;
      const requestStart = Math.max(0, part.start - overlap), requestEnd = part.end;
      try {
        const h = { ...headers, Range: `bytes=${requestStart}-${requestEnd}` }; if (validator) h['If-Range'] = validator.value;
        const reply = await request(url, combined, h); response = reply.response; effectiveUrl = String(reply.url || url);
        networkActive++; counted = true; peak = Math.max(peak, networkActive);
        progress(true);
        checkValidator(response, validator); validateRange(response, requestStart, requestEnd, total);
        let wire = 0; const prefixes = [];
        for await (const chunk of response) {
          combined.throwIfAborted();
          await throttle(chunk.length, combined);
          if (wire + chunk.length > requestEnd - requestStart + 1) throw new IntegrityError('Sunucu fazla parça verisi gönderdi.');
          networkBytes += chunk.length;
          const position = requestStart + wire, prefixLength = Math.max(0, Math.min(chunk.length, part.start - position));
          if (prefixLength) prefixes.push(chunk.subarray(0, prefixLength));
          const payload = chunk.subarray(prefixLength), absolute = position + prefixLength;
          const length = Math.max(0, Math.min(payload.length, part.end - absolute + 1));
          if (length) {
            if (absolute !== part.cursor) throw new IntegrityError('Parça yazma konumunda boşluk oluştu.');
            part.reservedEnd = absolute + length;
            let offset = 0;
            while (offset < length) {
              const written = await file.write(payload, offset, length - offset, absolute + offset);
              if (!written.bytesWritten) throw new Error('Dosya yazılamadı.'); offset += written.bytesWritten;
            }
            part.cursor = absolute + length; payloadBytes += length;
          }
          wire += chunk.length; progress();
          if (part.cursor === part.end + 1 && part.end < requestEnd) { response.destroy(); break; }
        }
        if (part.cursor !== part.end + 1) throw new Error('Sunucu parçayı eksik gönderdi.');
        if (part.end === requestEnd && wire !== requestEnd - requestStart + 1) throw new Error('Sunucu parçayı eksik gönderdi.');
        part.leftHash = part.start ? createHash('sha256').update(Buffer.concat(prefixes)).digest('hex') : null;
        await file.sync(); part.hash = await hashRange(partial, part.start, part.end, combined);
        part.state = 'done'; save(); window.sample(part.end - part.start + 1, performance.now() - attemptStart); return;
      } catch (error) {
        response?.destroy(); part.cursor = part.start; part.reservedEnd = part.start; window.failure();
        if (combined.aborted || error instanceof RangeUnsupportedError || error instanceof SourceChangedError || error instanceof SourceExpiredError || error instanceof IntegrityError || attempt >= 2) throw error;
        if (error instanceof RemoteResponseError && (!error.retryable || error.retryAfter > 30000)) throw error;
        const wait = Math.max(retryDelay * (attempt + 1), error instanceof RemoteResponseError ? error.retryAfter ?? 0 : 0);
        if (error instanceof RateLimitedError) onThrottle(new URL(effectiveUrl).hostname, wait);
        await delay(wait, null, { signal: combined });
      } finally { if (counted) { networkActive--; progress(true); } response?.destroy(); }
    }
  }
  try {
    if (!resume) { await file.truncate(total); save(); }
    progress(true);
    while (true) {
      combined.throwIfAborted();
      while (active.size < window.target) {
        const part = claim(); if (!part) break;
        const task = worker(part).catch(error => { failure ||= error; localAbort.abort(error); }).finally(() => active.delete(part.id));
        active.set(part.id, task);
      }
      if (!active.size) break;
      await Promise.race(active.values());
      if (failure) { await Promise.allSettled(active.values()); throw failure; }
    }
    if (parts.some(p => p.state !== 'done')) throw new IntegrityError('Tüm parçalar tamamlanmadı.');
    await file.sync();
    for (const part of parts.filter(p => p.start > 0)) {
      if (await hashRange(partial, Math.max(0, part.start - overlap), part.start - 1, combined) !== part.leftHash) throw new IntegrityError('Komşu parçaların örtüşen byte’ları eşleşmedi; dosya tamamlandı sayılmadı.');
    }
    await file.close(); phase = 'verifying'; progress(true); await verify(partial, combined); combined.throwIfAborted();
    const publication = await publishFile(partial, destination, combined); fs.rmSync(checkpoint, { force: true });
    phase = 'completed'; progress(true);
    return { total, connections: peak, maxConnections: maximum, targetConnections: window.target, splits, reductions: window.reductions, resumedBytes, resumeSupported: Boolean(validator), resumeReason, networkBytes, payloadBytes, verificationBytes, elapsedSeconds: (performance.now() - started) / 1000, ...publication };
  } finally {
    if (active.size) { localAbort.abort(); await Promise.allSettled(active.values()); }
    await file.close().catch(() => {});
  }
}
