import dns from 'node:dns/promises';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { clipName, HIDDEN_CHARACTERS } from './file-layout.js';

export function validToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isPrivateAddress(address) {
  const ip = address.toLowerCase();
  if (ip.includes(':')) {
    // Public IPv6 global-unicast only; reject mapped IPv4 and special-use ranges.
    return !/^[23][0-9a-f]{0,3}:/.test(ip) || ip.startsWith('2001:db8:');
  }
  if (!net.isIPv4(ip)) return true;
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113);
}

export function parseRemoteUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('Yalnızca kimlik bilgisi içermeyen HTTP/HTTPS adresleri destekleniyor.');
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Yerel adresler indirilemez.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('Yerel/özel ağ adresleri indirilemez.');
  url.hash = '';
  return url;
}

export async function resolveRemote(raw) {
  const url = parseRemoteUrl(raw);
  const records = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!records.length || records.some(r => isPrivateAddress(r.address))) throw new Error('Yerel/özel ağ adresleri indirilemez.');
  return { url, records };
}

export function safeTitle(raw) {
  const text = String(raw || 'video'), clean = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
  return clipName(clean.replace(HIDDEN_CHARACTERS, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '')).replace(/[. ]+$/g, '') || 'video';
}
