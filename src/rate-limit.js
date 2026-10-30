import { setTimeout as wait } from 'node:timers/promises';

// One limiter per job, shared by its audio/video streams and parallel workers.
export function rateLimiter(bytesPerSecond = 0) {
  let next = 0;
  return async (bytes, signal) => {
    signal?.throwIfAborted();
    if (!bytesPerSecond) return;
    const now = performance.now();
    next = Math.max(now, next) + bytes * 1000 / bytesPerSecond;
    await wait(Math.max(0, next - now), null, { signal });
  };
}
