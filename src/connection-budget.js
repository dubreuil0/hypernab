import { m } from './messages.js';
// Counts active media requests (not idle keep-alive sockets). One instance is
// shared by all jobs and both tracks of a split-stream job.
export class ConnectionBudget {
  constructor({ total = 12, perHost = 8 } = {}) {
    if (![total, perHost].every(n => Number.isInteger(n) && n > 0 && n <= 32)) throw new Error(m('e.invalid-connection-budget'));
    this.limit = total; this.perHost = Math.min(perHost, total);
    this.active = 0; this.hosts = new Map(); this.waiting = []; this.cooldowns = new Map(); this.timer = null;
  }

  acquire(hosts, signal, cost = 1) {
    signal?.throwIfAborted();
    hosts = [...new Set((Array.isArray(hosts) ? hosts : [hosts]).map(host => String(host).toLowerCase()))];
    if (!hosts.length || !Number.isInteger(cost) || cost < 1 || cost > this.perHost) throw new Error(m('e.invalid-connection-reservation'));
    return new Promise((resolve, reject) => {
      const entry = { hosts, cost, signal, resolve, reject };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', entry.abort); reject(signal.reason); this.drain();
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry); this.drain();
    });
  }

  drain() {
    clearTimeout(this.timer); this.timer = null;
    const now = Date.now(); let nextWake = Infinity;
    for (const [host, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(host);
    for (let index = 0; index < this.waiting.length;) {
      const entry = this.waiting[index];
      const until = Math.max(0, ...entry.hosts.map(host => this.cooldowns.get(host) || 0));
      if (until > now) nextWake = Math.min(nextWake, until);
      if (until > now || this.active + entry.cost > this.limit || entry.hosts.some(host => (this.hosts.get(host) || 0) + entry.cost > this.perHost)) { index++; continue; }
      this.waiting.splice(index, 1); entry.signal?.removeEventListener('abort', entry.abort);
      this.active += entry.cost;
      for (const host of entry.hosts) this.hosts.set(host, (this.hosts.get(host) || 0) + entry.cost);
      let released = false;
      entry.resolve(() => {
        if (released) return; released = true; this.active -= entry.cost;
        for (const host of entry.hosts) { const n = this.hosts.get(host) - entry.cost; if (n) this.hosts.set(host, n); else this.hosts.delete(host); }
        this.drain();
      });
    }
    if (nextWake < Infinity) this.timer = setTimeout(() => this.drain(), Math.max(1, nextWake - now));
  }

  cooldown(host, milliseconds) {
    this.cooldowns.set(host.toLowerCase(), Math.max(this.cooldowns.get(host.toLowerCase()) || 0, Date.now() + Math.min(30000, Math.max(0, milliseconds))));
    this.drain();
  }

  async request(request, url, signal, headers) {
    const release = await this.acquire(new URL(url).hostname, signal);
    try {
      signal?.throwIfAborted();
      const result = await request(url, signal, headers);
      result.response.once('end', release); result.response.once('close', release); result.response.once('error', release);
      if (result.response.destroyed || result.response.readableEnded) release();
      return result;
    } catch (error) { release(); throw error; }
  }

  snapshot() { return { active: this.active, total: this.limit, perHost: this.perHost, waiting: this.waiting.length }; }
}

export class AdaptiveWindow {
  constructor(maximum, initial = 2) { this.maximum = maximum; this.target = Math.min(initial, maximum); this.healthy = 0; this.rate = null; this.reductions = 0; }
  sample(bytes, milliseconds) {
    const rate = bytes * 1000 / Math.max(milliseconds, 1);
    const degraded = this.rate !== null && rate < this.rate * 0.65;
    this.rate = this.rate === null ? rate : this.rate * 0.7 + rate * 0.3;
    if (degraded && this.target > 1) { this.target--; this.healthy = 0; this.reductions++; }
    else if (++this.healthy >= 2 && this.target < this.maximum) { this.target++; this.healthy = 0; }
  }
  failure() { this.target = Math.max(1, Math.floor(this.target / 2)); this.healthy = 0; this.reductions++; }
}
