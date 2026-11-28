// Time limits that stop running while the request waits for a slot in OUR OWN connection queue.
// A limit protects against a server that does not answer; time spent behind other downloads of this app says nothing about the server.
// Every limit registers itself on its signal; signals derived with anySignal() inherit the registrations, so the connection budget can
// pause the right limits for exactly the signal it was given, without knowing who created them.
const registry = new WeakMap(); // AbortSignal -> Set<Deadline>

export class Deadline {
  constructor(milliseconds, reason) {
    this.controller = new AbortController(); this.reason = reason;
    this.remaining = milliseconds; this.holds = 0; this.since = performance.now(); this.timer = null;
    registry.set(this.controller.signal, new Set([this]));
    this.arm();
  }
  get signal() { return this.controller.signal; }
  arm() {
    clearTimeout(this.timer); this.since = performance.now();
    this.timer = setTimeout(() => this.controller.abort(this.reason()), Math.max(0, this.remaining)); this.timer.unref?.();
  }
  // Milliseconds left on the limit (frozen while paused).
  left() { return this.holds > 0 || this.controller.signal.aborted ? this.remaining : this.remaining - (performance.now() - this.since); }
  pause() {
    if (this.holds++ > 0 || this.controller.signal.aborted) return;
    clearTimeout(this.timer); this.timer = null; this.remaining -= performance.now() - this.since;
  }
  resume() {
    if (--this.holds > 0 || this.controller.signal.aborted) return;
    this.arm();
  }
  stop() { clearTimeout(this.timer); this.timer = null; }
}

// AbortSignal.any() that keeps the limits of its inputs findable.
export function anySignal(signals) {
  const combined = AbortSignal.any(signals), limits = new Set();
  for (const signal of signals) for (const limit of registry.get(signal) || []) limits.add(limit);
  if (limits.size) registry.set(combined, limits);
  return combined;
}

// Pauses every limit behind `signal`; the returned function resumes them (once).
export function pauseDeadlines(signal) {
  const limits = signal && registry.get(signal);
  if (!limits) return null;
  for (const limit of limits) limit.pause();
  let done = false;
  return () => { if (done) return; done = true; for (const limit of limits) limit.resume(); };
}
