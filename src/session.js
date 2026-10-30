// Browser session cookies handed over by the extension for ONE video the user chose to inspect.
// They live in memory only: never in queue.json, logs, API responses or error messages.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const VALUE = /^[^\x00-\x1f\x7f;]{0,4096}$/;
const DOMAIN = /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const MAX_COUNT = 80, MAX_BYTES = 32768;

function domainMatches(host, domain) {
  const d = domain.replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

// Returns a clean copy. Throws on malformed input; silently drops cookies for unrelated hosts.
export function sanitizeCookies(input, allowedUrls) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_COUNT) throw new Error('Oturum çerezleri geçersiz veya çok fazla.');
  const hosts = allowedUrls.filter(Boolean).map(raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean);
  const clean = []; let bytes = 0;
  for (const cookie of input) {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') throw new Error('Oturum çerezi biçimi geçersiz.');
    if (!NAME.test(cookie.name) || !VALUE.test(cookie.value) || !DOMAIN.test(cookie.domain)) throw new Error('Oturum çerezi biçimi geçersiz.');
    if (!hosts.some(host => domainMatches(host, cookie.domain))) continue;
    const cookiePath = typeof cookie.path === 'string' && /^\/[^\x00-\x1f\x7f;]{0,512}$/.test(cookie.path) ? cookie.path : '/';
    const expires = Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : null;
    if (expires !== null && expires * 1000 < Date.now()) continue;
    bytes += cookie.name.length + cookie.value.length;
    if (bytes > MAX_BYTES) throw new Error('Oturum çerezleri çok büyük.');
    clean.push({ name: cookie.name, value: cookie.value, domain: cookie.domain.toLowerCase(), hostOnly: cookie.hostOnly === true, path: cookiePath, secure: cookie.secure === true, expires });
  }
  return clean;
}

export function cookiesForUrl(cookies, raw) {
  if (!cookies?.length) return [];
  let url; try { url = new URL(raw); } catch { return []; }
  const host = url.hostname.toLowerCase();
  return cookies.filter(cookie => {
    if (cookie.secure && url.protocol !== 'https:') return false;
    if (cookie.expires !== null && cookie.expires * 1000 < Date.now()) return false;
    const domain = cookie.domain.replace(/^\./, '');
    if (cookie.hostOnly ? host !== domain : !domainMatches(host, domain)) return false;
    const base = cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`;
    return url.pathname === cookie.path || url.pathname.startsWith(base);
  });
}

// Longest path first, like browsers do.
export function cookieHeader(cookies, raw) {
  const matching = cookiesForUrl(cookies, raw).sort((a, b) => b.path.length - a.path.length);
  return matching.length ? matching.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : null;
}

export function withCookie(headers, cookies, raw) {
  const header = cookieHeader(cookies, raw);
  const base = Object.fromEntries(Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== 'cookie'));
  return header ? { ...base, Cookie: header } : base;
}

// Netscape jar for yt-dlp. Short-lived: the caller deletes it as soon as the process ends.
export function writeCookieJar(cookies, directory) {
  if (!cookies?.length) return null;
  const lines = ['# Netscape HTTP Cookie File'];
  const tomorrow = Math.floor(Date.now() / 1000) + 86400;
  for (const cookie of cookies) {
    lines.push([cookie.hostOnly ? cookie.domain.replace(/^\./, '') : `.${cookie.domain.replace(/^\./, '')}`, cookie.hostOnly ? 'FALSE' : 'TRUE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE', cookie.expires ?? tomorrow, cookie.name, cookie.value].join('\t'));
  }
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `cookies-${randomUUID()}.txt`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

export function removeCookieJar(file) {
  if (file) try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}
