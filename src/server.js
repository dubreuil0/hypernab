import { m } from './messages.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DownloadQueue } from './downloads.js';
import { Automation } from './automation.js';
import { validToken } from './security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.HYPERNAB_PORT || 17846);
const origin = `http://127.0.0.1:${port}`;
const instanceId = randomUUID();
const dataDir = process.env.HYPERNAB_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, 'pairing-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const queue = new DownloadQueue({ directory: process.env.HYPERNAB_DOWNLOAD_DIR || path.join(root, 'downloads'), stateFile: path.join(dataDir, 'queue.json'), toolsDirectory: path.join(root, 'tools'), locale: process.env.HYPERNAB_LOCALE });
const automation = new Automation(queue, path.join(dataDir, 'automation.json'));
const automationTimer = setInterval(() => { if (!queue.stopping) void automation.tick(); }, 1000);
automationTimer.unref();

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = 32768) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (Buffer.byteLength(content) > limit) throw new Error(m('e.the-request-is-too-large'));
  }
  return JSON.parse(content || '{}');
}

const assets = new Map([
  ['/tray.html', ['tray.html', 'text/html; charset=utf-8']],
  ['/tray.css', ['tray.css', 'text/css; charset=utf-8']],
  ['/tray.js', ['tray.js', 'text/javascript; charset=utf-8']],
  ['/history-view.js', ['history-view.js', 'text/javascript; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/ds.css', ['ds.css', 'text/css; charset=utf-8']],
  ['/ds.js', ['ds.js', 'text/javascript; charset=utf-8']],
  ['/strings.js', ['strings.js', 'text/javascript; charset=utf-8']],
  ['/ui-language.js', ['ui-language.js', 'text/javascript; charset=utf-8']],
  ['/t.js', ['t.js', 'text/javascript; charset=utf-8']],
  ['/select-upgrade.js', ['select-upgrade.js', 'text/javascript; charset=utf-8']],
  ['/extension-help.js', ['extension-help.js', 'text/javascript; charset=utf-8']],
  ['/list-tools.js', ['list-tools.js', 'text/javascript; charset=utf-8']],
  ['/compact.css', ['compact.css', 'text/css; charset=utf-8']],
  ['/appearance.js', ['appearance.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/reorder.css', ['reorder.css', 'text/css; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/advanced.js', ['advanced.js', 'text/javascript; charset=utf-8']],
  ['/queue-state.js', ['queue-state.js', 'text/javascript; charset=utf-8']],
  ['/progress-view.js', ['progress-view.js', 'text/javascript; charset=utf-8']],
  ['/queue.css', ['queue.css', 'text/css; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: m('e.invalid-server-address') });
  const requestOrigin = req.headers.origin;
  const extension = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(requestOrigin || '');
  const local = requestOrigin === origin;
  if (requestOrigin && !local && !extension) return json(res, 403, { error: m('e.this-source-is-not-allowed') });
  if (extension) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, origin);
  try {
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(root, 'public', file)));
    }
    // Local UI bootstrap is same-origin only; token never appears in HTML or URLs.
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      if (extension || req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: m('e.local-interface-only') });
      return json(res, 200, { token });
    }
    if (!validToken(req.headers.authorization?.replace(/^Bearer /, ''), token)) return json(res, 401, { error: m('e.the-pairing-key-is-invalid') });
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { version, extensionProtocol: 1, instanceId, processId: process.pid, ...queue.capabilities() });
    if (req.method === 'POST' && url.pathname === '/api/app/shutdown') {
      const input = await body(req);
      if (input.confirm !== true || input.instanceId !== instanceId) return json(res, 409, { error: m('e.the-shutdown-confirmation-or-the-app') });
      if (queue.active.size || queue.jobs.some(job => ['running', 'queued'].includes(job.status))) return json(res, 409, { error: m('e.there-are-active-or-queued-jobs') });
      res.once('finish', () => setImmediate(shutdown));
      return json(res, 200, { stopped: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, queue.list());
    if (req.method === 'GET' && url.pathname === '/api/history') {
      if (extension) return json(res, 403, { error: m('e.the-history-is-only-available-in') });
      return json(res, 200, await queue.historyPage({ search: url.searchParams.get('search') || '', cursor: url.searchParams.get('cursor') }));
    }
    const historyLocation = /^\/api\/history\/([a-f0-9-]{36})\/location$/i.exec(url.pathname);
    if (req.method === 'GET' && historyLocation) {
      if (extension) return json(res, 403, { error: m('e.the-history-is-only-available-in') });
      return json(res, 200, queue.history.location(historyLocation[1]));
    }
    const location = /^\/api\/jobs\/([a-f0-9-]{36})\/location$/i.exec(url.pathname);
    if (req.method === 'GET' && location) {
      if (extension) return json(res, 403, { error: m('e.the-file-location-is-only-available') });
      return json(res, 200, queue.location(location[1]));
    }
    if (req.method === 'GET' && url.pathname === '/api/automation') return json(res, 200, automation.info());
    if (req.method === 'POST' && url.pathname === '/api/automation') return json(res, 200, automation.configure(await body(req)));
    const submission = /^\/api\/submissions\/([a-f0-9-]+)$/i.exec(url.pathname);
    if (req.method === 'GET' && submission) return json(res, 200, queue.submissionStatus(submission[1]));
    const abandon = /^\/api\/submissions\/([a-f0-9-]+)\/abandon$/i.exec(url.pathname);
    if (req.method === 'POST' && abandon) return json(res, 200, queue.abandonSubmission(abandon[1]));
    if (req.method === 'POST' && ['/api/inspect', '/api/sniff'].includes(url.pathname)) {
      const input = await body(req, 131072); // session cookies (up to 32 KB of values) travel with the inspection only
      if (inspections >= 2) return json(res, 429, { error: m('e.two-inspections-are-already-running-wait') });
      inspections++;
      try { return json(res, 200, await (url.pathname === '/api/sniff' ? queue.sniff(input) : queue.inspect(input))); }
      finally { inspections--; }
    }
    if (req.method === 'POST' && url.pathname === '/api/hls/active-audio') return json(res, 200, await queue.activeAudio(await body(req, 131072))); // recent request addresses of the page, compared only
    if (req.method === 'POST' && url.pathname === '/api/playlist') {
      const input = await body(req);
      if (inspections >= 2) return json(res, 429, { error: m('e.two-inspections-are-already-running-wait') });
      inspections++;
      try { return json(res, 200, await queue.playlist(input)); } finally { inspections--; }
    }
    if (req.method === 'POST' && url.pathname === '/api/links/add') return json(res, 200, await queue.addLinks(await body(req, 262144)));
    if (req.method === 'POST' && url.pathname === '/api/playlist/add') return json(res, 200, queue.addPlaylist(await body(req, 786432)));
    if (req.method === 'POST' && url.pathname === '/api/subtitles') return json(res, 200, queue.receiveSubtitle(await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/duplicates') return json(res, 200, { duplicates: queue.findDuplicates(await body(req)) });
    if (req.method === 'POST' && url.pathname === '/api/jobs') { const id = queue.add(await body(req)); return json(res, 201, { id }); }
    if (req.method === 'POST' && url.pathname === '/api/files/take') return json(res, 200, await queue.takeFile(await body(req, 131072))); // cookies of the one file travel with it
    // The extension may read only the two language preferences and the look (theme, accent), never the other settings.
    if (req.method === 'GET' && url.pathname === '/api/prefs') return json(res, 200, { interfaceLanguage: queue.interfaceLanguage(), subtitleLanguage: queue.settings.subtitleLanguage, audioLanguage: queue.settings.audioLanguage, theme: queue.settings.theme, accent: queue.settings.accent });
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, { ...queue.settings, interfaceLanguageResolved: queue.interfaceLanguage(), queue: queue.queueInfo() });
    if (req.method === 'POST' && url.pathname === '/api/settings') return json(res, 200, { ...queue.setSettings(await body(req)), interfaceLanguageResolved: queue.interfaceLanguage(), queue: queue.queueInfo() });
    if (req.method === 'POST' && url.pathname === '/api/queue/start') return json(res, 200, queue.startQueue());
    if (req.method === 'POST' && url.pathname === '/api/queue/stop') return json(res, 200, queue.stopQueue());
    if (req.method === 'POST' && url.pathname === '/api/queue/reorder') return json(res, 200, queue.reorder((await body(req)).ids));
    const startNow = /^\/api\/jobs\/([a-f0-9-]+)\/start-now$/.exec(url.pathname);
    if (req.method === 'POST' && startNow) return json(res, 200, queue.startNow(startNow[1]));
    if (req.method === 'POST' && url.pathname === '/api/queue/clear') return json(res, 200, queue.clearFinished(await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/queue/bulk') {
      const { action, ...selection } = await body(req);
      return json(res, 200, queue.batch(action, selection));
    }
    const action = /^\/api\/jobs\/([a-f0-9-]+)\/(cancel|retry|pause|resume)$/.exec(url.pathname);
    if (req.method === 'POST' && action) {
      const result = queue[action[2]](action[1]); return json(res, 200, result || { ok: true });
    }
    return json(res, 404, { error: m('e.not-found') });
  } catch (error) {
    return json(res, 400, { error: error.message.replace(/https?:\/\/[^\s]+/g, m('e.link')), ...(['SELECTION_EXPIRED', 'duplicate', 'NOT_A_FILE', 'ACCESS_DENIED', 'HTTP_ERROR'].includes(error.code) ? { code: error.code } : {}), ...(error.code === 'duplicate' ? { duplicates: error.duplicates } : {}) });
  }
});
let inspections = 0;
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? m('e.port-port-is-in-use-the', { port, origin }) : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(m('e.hypernab-is-ready-origin-press-ctrl', { origin, directory: queue.directory }));
  if (process.argv.includes('--open')) spawn('cmd.exe', ['/c', 'start', '', origin], { windowsHide: true, stdio: 'ignore' });
});
function shutdown() { clearInterval(automationTimer); queue.stop(); server.close(); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
