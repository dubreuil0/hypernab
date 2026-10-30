// Browser-side capture for pages yt-dlp cannot resolve (JavaScript players, iframes, anti-bot pages).
// Opens the page in a real, throw-away browser profile, lets the player start and records the media
// requests the page itself makes, like a download manager's network sniffer. Provider-agnostic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnManaged } from './process.js';
import { parseRemoteUrl, resolveRemote } from './security.js';

const MANIFEST = /\.(m3u8|mpd)(?:$|[?#])/i;
const FILE = /\.(mp4|webm|mkv|mov|m4v|flv|m4a|mp3|ogg|opus)(?:$|[?#])/i;
const SEGMENT = /\.(ts|m4s|aac|vtt|srt|jpg|jpeg|png|gif|webp|svg|css|js|woff2?)(?:$|[?#])/i;

export function findBrowser(env = process.env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const relative = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe'];
  for (const rel of relative) for (const root of roots) { const file = path.join(root, rel); if (fs.existsSync(file)) return file; }
  return null;
}

// Pure classification so it can be tested without a browser.
export function classifyRequest({ url, mime = '', status = 200, size = null }) {
  if (!/^https?:/i.test(url) || (status && status >= 400)) return null;
  const type = String(mime).split(';')[0].trim().toLowerCase();
  if (MANIFEST.test(url) || /mpegurl|dash\+xml/.test(type)) return { kind: 'manifest', rank: /master|manifest|playlist/i.test(url) ? 0 : 1 };
  if (SEGMENT.test(url) && !FILE.test(url)) return null;
  if (/^video\/(mp2t|mp2ts)$/.test(type)) return null; // transport-stream chunks belong to a manifest
  if (/^(video|audio)\//.test(type) || FILE.test(url)) {
    if (size !== null && size < 150000) return null; // tracking pixels, ad stingers, thumbnails
    return { kind: 'file', rank: 2 };
  }
  return null;
}

export function pickCandidates(found) {
  const seen = new Map();
  for (const item of found) if (!seen.has(item.url)) seen.set(item.url, item);
  return [...seen.values()].sort((a, b) => a.rank - b.rank || (b.size || 0) - (a.size || 0) || a.order - b.order);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', () => reject(new Error('Tarayıcı kontrol bağlantısı kurulamadı.')), { once: true }); });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
      else if (message.method) for (const handler of this.handlers) handler(message);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  on(handler) { this.handlers.push(handler); }
  close() { try { this.socket.close(); } catch {} }
}

const wait = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });

const PLAY_SCRIPT = `(() => {
  const clicked = [];
  for (const video of document.querySelectorAll('video')) { try { video.muted = true; video.play(); clicked.push('video'); } catch {} }
  const selectors = ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', '.ytp-large-play-button', '[class*="play" i][class*="btn" i]', '[class*="play" i][class*="button" i]', '[aria-label*="play" i]', '[title*="play" i]', '[class*="poster" i]', '#player', '.video-js'];
  for (const selector of selectors) { const el = document.querySelector(selector); if (el) { try { el.click(); clicked.push(selector); } catch {} break; } }
  const sources = [...document.querySelectorAll('video, video source')].map(v => v.currentSrc || v.src).filter(Boolean);
  return JSON.stringify({ title: document.title, clicked, sources });
})()`;

export async function sniffPage(pageUrl, { signal, timeoutMs = 40000, challengeGraceMs = 10000, headless = true, browser = findBrowser(), tick = ms => wait(ms, signal) } = {}) {
  const page = parseRemoteUrl(pageUrl);
  await resolveRemote(page.href);
  if (!browser) throw new Error('Sayfa yakalama için Edge, Chrome veya Brave gerekli; bilgisayarda bulunamadı.');
  const profile = path.join(os.tmpdir(), `hypernab-sniff-${randomUUID()}`);
  fs.mkdirSync(profile, { recursive: true });
  const stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-extensions', '--disable-background-networking', '--window-size=1280,800', ...(headless ? ['--headless=new'] : ['--window-position=-32000,-32000']), 'about:blank'];
  const child = spawnManaged(browser, args, { windowsHide: true, stdio: 'ignore', signal: combined });
  child.on('error', () => {});
  const found = []; const requests = new Map(); let order = 0; let cdp; let userAgent = null; const sessions = new Set();
  const deadline = Date.now() + timeoutMs;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    while (!fs.existsSync(portFile)) { if (Date.now() > deadline || child.exitCode !== null) throw new Error('Tarayıcı başlatılamadı.'); await tick(150); }
    await tick(100);
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
    cdp = new Cdp(`ws://127.0.0.1:${port}${wsPath}`); await cdp.ready;
    const record = (sessionId, requestId, extra) => {
      const entry = requests.get(`${sessionId}:${requestId}`); if (!entry) return;
      Object.assign(entry, extra);
      const verdict = classifyRequest({ url: entry.url, mime: entry.mime, status: entry.status, size: entry.size });
      if (verdict && entry.mime !== undefined && !entry.done) { entry.done = true; found.push({ url: entry.url, referer: entry.referer, ...verdict, size: entry.size, mime: entry.mime, order: order++ }); }
    };
    cdp.on(message => {
      const { method, params, sessionId = '' } = message;
      if (method === 'Network.requestWillBeSent') {
        requests.set(`${sessionId}:${params.requestId}`, { url: params.request.url, referer: params.request.headers?.Referer || params.request.headers?.referer || params.documentURL, userAgent: params.request.headers?.['User-Agent'] });
        userAgent ||= params.request.headers?.['User-Agent'] || null;
      } else if (method === 'Network.responseReceived') {
        const length = Number(params.response.headers?.['content-length'] ?? params.response.headers?.['Content-Length']);
        record(sessionId, params.requestId, { mime: params.response.mimeType || '', status: params.response.status, size: Number.isFinite(length) ? length : null });
      } else if (method === 'Target.attachedToTarget') attach(params.sessionId);
    });
    async function attach(sessionId) {
      if (sessions.has(sessionId)) return; sessions.add(sessionId);
      try {
        await cdp.send('Network.enable', {}, sessionId);
        await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      } catch {}
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessions.add(sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await cdp.send('Page.navigate', { url: page.href }, sessionId);
    let challenge = false, title = '', lastFound = 0, domSources = [], challengeSince = 0;
    while (Date.now() < deadline) {
      await tick(1500);
      const state = await cdp.send('Runtime.evaluate', { expression: PLAY_SCRIPT, returnByValue: true }, sessionId).catch(() => null);
      try { const parsed = JSON.parse(state?.result?.value || '{}'); title = parsed.title || title; domSources = parsed.sources || domSources; } catch {}
      challenge = /just a moment|bir dakika|checking your browser|attention required|cloudflare/i.test(title);
      // A headless browser usually stays stuck on the anti-bot page: give up early so the caller can retry with a window.
      challengeSince = challenge ? challengeSince || Date.now() : 0;
      if (challengeSince && Date.now() - challengeSince > challengeGraceMs && !found.length) break;
      // Many players start after a real click; click the middle of the viewport as well.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 }, sessionId).catch(() => {});
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1 }, sessionId).catch(() => {});
      if (found.length && !lastFound) lastFound = Date.now();
      if (lastFound && Date.now() - lastFound > 4000) break;
    }
    const direct = domSources.filter(src => /^https?:/i.test(src)).map(src => ({ url: src, referer: page.href, kind: MANIFEST.test(src) ? 'manifest' : 'file', rank: MANIFEST.test(src) ? 1 : 2, size: null, mime: '', order: order++ }));
    return { candidates: pickCandidates([...found, ...direct]), pageTitle: title, challenge: challenge && !found.length, userAgent };
  } finally {
    stop.abort(); cdp?.close();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }), 1500).unref();
  }
}
