import { m } from './messages.js';
import { pauseDeadlines } from './deadline.js';
// Counts active media requests (not idle keep-alive sockets). One instance is
// shared by all jobs and both tracks of a split-stream job.
export class ConnectionBudget {
  // `reserve` is a small separate lane for interactive look-ups (header reads that close at once). It has its own counters,
  // so a look-up never waits behind a saturated download queue and never takes capacity away from it.
  constructor({ total = 12, perHost = 8, reserve = 2 } = {}) {
    if (![total, perHost].every(n => Number.isInteger(n) && n > 0 && n <= 32) || !Number.isInteger(reserve) || reserve < 1 || reserve > 8) throw new Error(m('e.invalid-connection-budget'));
    this.limit = total; this.perHostOption = perHost; this.perHost = Math.min(perHost, total); this.reserve = reserve;
    this.active = 0; this.hosts = new Map(); this.waiting = []; this.cooldowns = new Map(); this.timer = null;
    this.owners = new Map();
    this.priorityActive = 0; this.priorityHosts = new Map(); this.priorityWaiting = [];
  }

  // Changes the normal total (1..32). Lowering never aborts held connections: new grants simply wait until active < limit.
  setLimit(total) {
    if (!Number.isFinite(total)) return;
    this.limit = Math.min(32, Math.max(1, Math.trunc(total)));
    this.perHost = Math.min(this.perHostOption, this.limit);
    this.drain();
  }

  // options.priority: use the interactive reserve. options.owner: who holds the slots (a download id), for fair sharing.
  acquire(hosts, signal, cost = 1, { priority = false, owner } = {}) {
    signal?.throwIfAborted();
    hosts = [...new Set((Array.isArray(hosts) ? hosts : [hosts]).map(host => String(host).toLowerCase()))];
    if (!hosts.length || !Number.isInteger(cost) || cost < 1 || cost > this.perHost) throw new Error(m('e.invalid-connection-reservation'));
    // Time spent waiting behind our own downloads is not the server's silence: the time limits of this request stand still meanwhile.
    // The interactive reserve keeps its own short limits (it never waits behind downloads).
    const resumeLimits = priority ? null : pauseDeadlines(signal);
    return new Promise((resolveSlot, rejectSlot) => {
      const resolve = value => { resumeLimits?.(); resolveSlot(value); }, reject = error => { resumeLimits?.(); rejectSlot(error); };
      const entry = { hosts, cost, signal, resolve, reject, priority, owner };
      entry.owner = owner ?? entry; // an entry without an owner counts as its own owner
      const queue = priority ? this.priorityWaiting : this.waiting;
      entry.abort = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener('abort', entry.abort); reject(signal.reason); this.drain();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      queue.push(entry); this.drain();
    });
  }

  grant(entry, counters) {
    entry.signal?.removeEventListener('abort', entry.abort);
    const { hosts } = counters;
    const normal = !entry.priority;
    if (normal) { this.active += entry.cost; this.owners.set(entry.owner, (this.owners.get(entry.owner) || 0) + entry.cost); }
    else this.priorityActive += entry.cost;
    for (const host of entry.hosts) hosts.set(host, (hosts.get(host) || 0) + entry.cost);
    let released = false;
    entry.resolve(() => {
      if (released) return; released = true;
      if (normal) {
        this.active -= entry.cost;
        const held = this.owners.get(entry.owner) - entry.cost; if (held > 0) this.owners.set(entry.owner, held); else this.owners.delete(entry.owner);
      } else this.priorityActive -= entry.cost;
      for (const host of entry.hosts) { const n = hosts.get(host) - entry.cost; if (n) hosts.set(host, n); else hosts.delete(host); }
      this.drain();
    });
  }

  drain() {
    clearTimeout(this.timer); this.timer = null;
    const now = Date.now(); let nextWake = Infinity;
    for (const [host, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(host);
    const cooled = entry => {
      const until = Math.max(0, ...entry.hosts.map(host => this.cooldowns.get(host) || 0));
      if (until > now) nextWake = Math.min(nextWake, until);
      return until > now;
    };
    for (let index = 0; index < this.priorityWaiting.length;) {
      const entry = this.priorityWaiting[index];
      if (cooled(entry) || this.priorityActive + entry.cost > this.reserve || entry.hosts.some(host => (this.priorityHosts.get(host) || 0) + entry.cost > this.reserve)) { index++; continue; }
      this.priorityWaiting.splice(index, 1); this.grant(entry, { hosts: this.priorityHosts });
    }
    // Among the entries that can run now, the one whose owner holds the fewest connections goes first; ties keep arrival order.
    for (;;) {
      let best = -1, bestHeld = Infinity;
      for (let index = 0; index < this.waiting.length; index++) {
        const entry = this.waiting[index];
        if (cooled(entry) || this.active + entry.cost > this.limit || entry.hosts.some(host => (this.hosts.get(host) || 0) + entry.cost > this.perHost)) continue;
        const held = this.owners.get(entry.owner) || 0;
        if (held < bestHeld) { best = index; bestHeld = held; }
      }
      if (best < 0) break;
      const [entry] = this.waiting.splice(best, 1); this.grant(entry, { hosts: this.hosts });
    }
    if (nextWake < Infinity) this.timer = setTimeout(() => this.drain(), Math.max(1, nextWake - now));
  }

  cooldown(host, milliseconds) {
    this.cooldowns.set(host.toLowerCase(), Math.max(this.cooldowns.get(host.toLowerCase()) || 0, Date.now() + Math.min(30000, Math.max(0, milliseconds))));
    this.drain();
  }

  async request(request, url, signal, headers, options = {}) {
    const release = await this.acquire(new URL(url).hostname, signal, 1, options);
    try {
      signal?.throwIfAborted();
      const result = await request(url, signal, headers);
      result.response.once('end', release); result.response.once('close', release); result.response.once('error', release);
      if (result.response.destroyed || result.response.readableEnded) release();
      return result;
    } catch (error) { release(); throw error; }
  }

  // Normal waiters that belong to someone else than `owner` (an entry without an owner counts as someone else).
  waitingOthers(owner) { let n = 0; for (const entry of this.waiting) if (owner === undefined || entry.owner !== owner) n++; return n; }

  snapshot() { return { active: this.active, total: this.limit, perHost: this.perHost, waiting: this.waiting.length, priorityActive: this.priorityActive, priorityWaiting: this.priorityWaiting.length, reserve: this.reserve }; }
}

export class AdaptiveWindow {
  // Plateau logic (growth judged on the FILE's total throughput, ceiling, drop-back) runs only while the shared budget is
  // contended: a server that caps the whole file gains nothing from more connections, and each extra one is taken from other
  // downloads. While nobody waits, this behaves exactly like the plain per-block window. Windows are still measured meanwhile.
  constructor(maximum, initial = 2, { plateauHoldMs = 60000, minGain = 0.1, contended = () => false } = {}) {
    this.maximum = maximum; this.target = Math.min(initial, maximum); this.healthy = 0; this.rate = null; this.reductions = 0;
    this.plateauHoldMs = plateauHoldMs; this.contended = contended; this.minGain = minGain; this.ceiling = null; this.holdUntil = 0; this.plateaus = 0;
    this.observing = false; this.cleared = false; this.judged = []; this.levelRates = new Map();
  }
  get limit() { return this.ceiling === null ? this.maximum : Math.max(1, Math.min(this.maximum, this.ceiling)); }
  // Contention over: lift any ceiling at once. Returns whether the budget is contended now.
  #sync() {
    const contended = Boolean(this.contended()); if (!contended && this.ceiling !== null) { this.ceiling = null; this.judged = []; this.cleared = false; }
    return contended;
  }
  #lowered() { this.judged = []; this.cleared = false; this.levelRates.clear(); }
  sample(bytes, milliseconds) {
    const contended = this.#sync(), rate = bytes * 1000 / Math.max(milliseconds, 1);
    const degraded = this.rate !== null && rate < this.rate * 0.65;
    this.rate = this.rate === null ? rate : this.rate * 0.7 + rate * 0.3;
    if (degraded && this.target > 1) { this.target--; this.healthy = 0; this.reductions++; this.#lowered(); }
    // While contended, a measured level must have shown that it pays off before the next one is opened (before the first window: up to 4).
    else if (++this.healthy >= 2 && this.target < this.limit && (!contended || (this.observing ? this.cleared : this.target < 4))) { this.target++; this.healthy = 0; this.judged = []; this.cleared = false; }
  }
  // One throughput window: `rate` bytes/s of the whole file, `active` connections that really stayed open for it.
  // Windows where fewer than `target` connections were in use (starved by the budget or by missing parts) are not judged.
  observe(rate, active, now = 0) {
    this.observing = true; const contended = this.#sync();
    if (this.ceiling !== null && now >= this.holdUntil) { this.ceiling = null; this.judged = []; this.cleared = false; }
    if (!(rate >= 0) || active < this.target) return;
    this.judged.push(rate); if (this.judged.length > 4) this.judged.shift();
    const level = this.target, last = rate, recent = this.judged.length >= 2 ? (this.judged.at(-1) + this.judged.at(-2)) / 2 : rate;
    this.levelRates.set(level, Math.max(...this.judged)); // best window: the first one of a level may still include connections ramping up
    let base = null, baseLevel = 0;
    for (let k = level - 1; k >= 1; k--) if (this.levelRates.has(k)) { base = this.levelRates.get(k); baseLevel = k; break; }
    if (base === null) { this.cleared = true; return; }
    const steps = level - baseLevel, need = base * (1 + this.minGain * steps);
    if (last >= base * (1 + 2 * this.minGain * steps) || (this.judged.length >= 2 && recent >= need)) { this.cleared = true; return; }
    if (this.judged.length < 2 || !contended) return;
    // Back to the lowest level that was already as good (levels may have been crossed quickly while nobody was waiting).
    let floor = baseLevel; while (floor > 1 && this.levelRates.has(floor - 1) && this.levelRates.get(floor - 1) * (1 + this.minGain) >= this.levelRates.get(floor)) floor--;
    this.target = floor; this.ceiling = floor; this.holdUntil = now + this.plateauHoldMs; this.plateaus++; this.healthy = 0; this.#lowered();
  }
  failure() { this.target = Math.max(1, Math.floor(this.target / 2)); this.healthy = 0; this.reductions++; this.#lowered(); }
}
