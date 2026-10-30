import http from 'node:http';
import https from 'node:https';
import { resolveRemote } from './security.js';

// A server that accepted the request but sent nothing for 30 s (some CDNs do this to clients they do not like).
export class NetworkStallError extends Error {}

// Shared by sequential and range transfers. Every redirect gets its own DNS check.
export async function requestRemote(raw, signal, headers = {}, redirects = 0, budget = null) {
  if (redirects > 5) throw new Error('Çok fazla yönlendirme.');
  const { url, records } = await resolveRemote(raw);
  signal?.throwIfAborted();
  const transport = url.protocol === 'https:' ? https : http;
  const release = budget ? await budget.acquire(url.hostname, signal) : () => {};
  const response = await new Promise((resolve, reject) => {
    let req;
    try { req = transport.get(url, {
      signal, headers: { 'User-Agent': 'IDMProMax/0.3', ...headers, 'Accept-Encoding': 'identity' },
      lookup: (_host, options, cb) => options?.all ? cb(null, records) : cb(null, records[0].address, records[0].family)
    }, res => {
      res.once('end', release); res.once('close', release); res.once('error', release); resolve(res);
    }); } catch (error) { release(); reject(error); return; }
    req.setTimeout(30000, () => req.destroy(new NetworkStallError('Sunucu 30 saniye boyunca veri göndermedi.')));
    req.on('error', error => { release(); reject(error); });
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new Error('Yönlendirme adresi eksik.');
    const next = new URL(location, url);
    // A session cookie belongs to the origin it was issued for: never forward it to another host or scheme.
    const forward = next.origin === url.origin ? headers : Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(?:cookie|authorization)$/i.test(name)));
    return requestRemote(next.href, signal, forward, redirects + 1, budget);
  }
  return { response, url };
}
