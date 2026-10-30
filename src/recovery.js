import { setTimeout as delay } from 'node:timers/promises';
import { NetworkStallError } from './network.js';

const transientStatuses = new Set([202, 408, 425, 429, 500, 502, 503, 504]);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export class RemoteResponseError extends Error {
  constructor(status, headers = {}, resource = 'Kaynak') {
    super(`HTTP ${status}: ${resource} alınamadı.${status === 202 ? ' Sunucu henüz kullanılabilir medya göndermedi.' : ''}`);
    this.status = status;
    this.retryable = transientStatuses.has(status);
    const value = headers['retry-after'];
    const ms = /^\d+(?:\.\d+)?$/.test(String(value ?? '')) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    this.retryAfter = Number.isFinite(ms) ? Math.max(0, ms) : null;
  }
}
export class IncompleteResourceError extends Error {}

export function isTransient(error) {
  return error instanceof RemoteResponseError ? error.retryable
    : error instanceof NetworkStallError || error instanceof IncompleteResourceError || error?.name === 'TimeoutError' || networkCodes.has(error?.code);
}

// Only idempotent GET/reads belong here. No parsing, permission, disk or integrity failure is guessed transient.
// The parent's cancellation always wins; neither server input nor a jitter can create an endless wait.
export async function recoverRead(operation, { signal, retries = 2, maxElapsedMs = 20000, baseDelayMs = 500, sleep = delay, onRetry = () => {} } = {}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('İstek süre sınırını aştı.', 'TimeoutError')), maxElapsedMs);
  timer.unref?.();
  const deadline = timeout.signal;
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = performance.now();
  try {
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted();
      try { return await operation(combined, attempt); }
      catch (error) {
        signal?.throwIfAborted();
        if (deadline.aborted || !isTransient(error) || attempt >= retries) throw error;
        const backoff = Math.min(4000, baseDelayMs * 2 ** attempt);
        const milliseconds = Math.max(backoff, error.retryAfter ?? 0);
        // Never shorten a long Retry-After and hammer the server. Leave the error to the caller instead.
        if (milliseconds >= maxElapsedMs - (performance.now() - started)) throw error;
        onRetry({ attempt: attempt + 1, delayMs: milliseconds, status: error.status || 0, reason: error instanceof IncompleteResourceError ? 'incomplete' : error.status ? 'http' : 'network' });
        await sleep(milliseconds, null, { signal: combined });
      }
    }
  } finally { clearTimeout(timer); }
}

const events = new Set(['resolve', 'source-refresh', 'probe-retry', 'fast-selected', 'hls-selected', 'hls-retry', 'native-selected', 'automatic-retry', 'transfer-observed']);
const reasons = new Set(['network', 'http', 'incomplete', 'range', 'source-refused', 'protocol']);
export function recordRecovery(job, event, detail = {}) {
  if (!events.has(event)) return;
  const entry = { event, at: Date.now() };
  if (reasons.has(detail.reason)) entry.reason = detail.reason;
  for (const key of ['attempt', 'delayMs', 'status', 'connections', 'elapsedMs']) {
    if (Number.isFinite(detail[key]) && detail[key] >= 0) entry[key] = Math.min(1e9, Math.round(detail[key]));
  }
  job.recovery = [...(job.recovery || []).slice(-23), entry];
}
