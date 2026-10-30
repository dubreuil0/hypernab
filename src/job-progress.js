// Runtime measurements are deliberately not restored from disk: old speeds are not predictions.
const positive = n => Number.isFinite(n) && n > 0;
export function sourceMeasureKey(sources) {
  try {
    if (!sources?.length || sources.some(s => !/^https?:/.test(s.url || ''))) return null;
    return [...new Set(sources.map(s => `${/^https?$/.test(s.protocol || '') ? 'http' : 'manifest'}:${new URL(s.url).hostname}`))].sort().join('|');
  } catch { return null; }
}

export function estimateBeforeDownload(jobs, key, bytes, now = Date.now()) {
  if (!key || !positive(bytes)) return { etaSeconds: null, basis: 'insufficient-history' };
  const samples = jobs.filter(j => j.status === 'completed').map(j => j.speedReference).filter(s =>
    s?.key === key && s.networkBytes >= 1024 * 1024 && s.seconds >= 5 && now - s.at >= 0 && now - s.at < 7 * 86400000)
    .slice(0, 5).map(s => s.networkBytes / s.seconds).filter(positive).sort((a, b) => a - b);
  // Different connection conditions are not interchangeable: decline unstable measurements.
  if (samples.length < 3 || samples.at(-1) / samples[0] > 2) return { etaSeconds: null, basis: 'insufficient-history' };
  return { etaSeconds: Math.ceil(bytes / samples[Math.floor(samples.length / 2)]), basis: 'source-history' };
}
export class ProgressMeter {
  constructor(clock = () => performance.now()) { this.clock = clock; this.reset(); }
  reset() { this.at = this.clock(); this.bytes = null; this.speed = 0; this.samples = 0; this.first = null; this.lastData = null; this.phase = null; this.phaseAt = this.at; this.seconds = {}; }
  stage(phase) {
    const now = this.clock();
    if (phase !== this.phase) {
      if (this.phase) this.seconds[this.phase] = (this.seconds[this.phase] || 0) + (now - this.phaseAt) / 1000;
      this.phase = phase; this.phaseAt = now;
      this.bytes = null; this.speed = 0; this.samples = 0; this.first = null; this.lastData = null;
    }
  }
  sample(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    const now = this.clock();
    if (this.bytes === null || bytes < this.bytes) { this.bytes = bytes; this.at = now; this.first = now; this.speed = 0; this.samples = 0; this.lastData = null; return; }
    const dt = now - this.at;
    if (dt < 250) return;
    const delta = bytes - this.bytes, rate = delta * 1000 / dt;
    const alpha = 1 - Math.exp(-dt / 2000);
    this.speed = this.samples ? this.speed + alpha * (rate - this.speed) : rate;
    if (delta > 0) { this.samples++; this.lastData = now; }
    this.bytes = bytes; this.at = now;
  }
  snapshot(job, phase) {
    const now = this.clock();
    const active = job.status === 'running' && phase === 'downloading';
    const fresh = this.lastData !== null && now - this.lastData <= 4000;
    const speed = active && fresh ? this.speed : 0;
    const received = Number.isFinite(job.received) && job.received >= 0 ? job.received : 0;
    const exceeded = active && job.sizeKind === 'approx' && positive(job.total) && received >= job.total;
    const total = !exceeded && positive(job.total) ? job.total : null;
    const ready = this.samples >= 2 && this.lastData !== null && this.lastData - this.first >= 1500;
    const etaSeconds = active && ready && speed > 0 && total > received ? Math.ceil((total - received) / speed) : null;
    const phaseSeconds = { ...this.seconds };
    if (this.phase) phaseSeconds[this.phase] = (phaseSeconds[this.phase] || 0) + (now - this.phaseAt) / 1000;
    return { phase, received, total, sizeKind: total ? job.sizeKind || 'exact' : 'unknown', speed,
      percent: total ? Math.min(100, received / total * 100) : null,
      etaSeconds, etaReason: etaSeconds !== null ? null : !active ? phase : exceeded ? 'estimate-exceeded' : !total ? 'unknown-size' : received >= total ? 'processing' : !ready ? 'warming-up' : 'stalled', phaseSeconds };
  }
}

// yt-dlp reports each component independently. Retain the other components' counters.
export class NativeProgress {
  constructor(info = {}) {
    const sources = info.requested_formats?.length ? info.requested_formats : [info];
    this.streams = new Map(sources.map((s, i) => [String(s.format_id ?? i), { received: 0, total: positive(s.filesize) ? s.filesize : positive(s.filesize_approx) ? s.filesize_approx : null, exact: positive(s.filesize) }]));
  }
  update(id, data) {
    const key = String(id ?? [...this.streams.keys()][0]);
    const old = this.streams.get(key) || { received: 0, total: null, exact: false };
    const received = Number.isFinite(data.downloaded_bytes) && data.downloaded_bytes >= 0 ? Math.max(old.received, data.downloaded_bytes) : old.received;
    const exact = positive(data.total_bytes) || data.status === 'finished';
    const total = positive(data.total_bytes) ? data.total_bytes : data.status === 'finished' && received > 0 ? received : positive(data.total_bytes_estimate) ? data.total_bytes_estimate : old.total;
    this.streams.set(key, { received, total, exact: exact || old.exact });
    const streams = [...this.streams.values()];
    return { received: streams.reduce((sum, s) => sum + s.received, 0), total: streams.every(s => positive(s.total)) ? streams.reduce((sum, s) => sum + s.total, 0) : null,
      sizeKind: streams.length === 1 && streams.every(s => s.exact) ? 'exact' : 'approx' };
  }
}

export function jobPhase(job, settling = false) {
  if (job.status === 'paused') return job.resumeRequested ? 'waiting-resume' : settling ? 'pausing' : 'paused';
  if (job.status !== 'running') return job.status;
  return job.transfer?.phase === 'completed' ? 'publishing' : job.transfer?.phase || 'resolving';
}
