import { setTimeout as wait } from 'node:timers/promises';

// One limiter per job, shared by its audio/video streams and parallel workers.
// The rate can be changed while the job runs (setRate): waiting workers are woken and the new rate applies at once, so lifting a
// limit never leaves anybody asleep for the time the old, slower limit had planned.
export function rateLimiter(bytesPerSecond = 0) {
  let next = 0, rate = bytesPerSecond;
  const sleepers = new Set();
  const limiter = async (bytes, signal) => {
    signal?.throwIfAborted();
    if (!rate) return;
    const now = performance.now();
    next = Math.max(now, next) + bytes * 1000 / rate;
    const delay = next - now;
    if (delay <= 0) return;
    const local = new AbortController(), wake = () => local.abort();
    sleepers.add(wake); signal?.addEventListener('abort', wake, { once: true });
    try { await wait(delay, null, { signal: local.signal }); }
    catch (error) { signal?.throwIfAborted(); if (error?.name !== 'AbortError') throw error; /* the rate changed: go on */ }
    finally { sleepers.delete(wake); signal?.removeEventListener('abort', wake); }
  };
  limiter.setRate = value => {
    rate = Number.isFinite(value) && value > 0 ? value : 0; next = 0;
    for (const wake of [...sleepers]) wake();
  };
  limiter.rate = () => rate;
  return limiter;
}
