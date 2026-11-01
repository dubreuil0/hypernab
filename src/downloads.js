import path from 'node:path';
import { rateLimiter } from './rate-limit.js';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { spawnManaged } from './process.js';
import { randomUUID, createHash } from 'node:crypto';
import { parseRemoteUrl, resolveRemote, safeTitle } from './security.js';
import { finishedName, knownYear, layoutDirectory } from './file-layout.js';
import { HistoryStore } from './history.js';
import { isFormatId, buildQualityOptions, preferredOptionId } from './quality.js';
import { sniffPage } from './sniffer.js';
import os from 'node:os';
import { sanitizeCookies, withCookie, writeCookieJar, removeCookieJar } from './session.js';
import { ProgressMeter, NativeProgress, jobPhase, sourceMeasureKey, estimateBeforeDownload } from './job-progress.js';
import { SubmissionStore, submissionId } from './submissions.js';
import { mediaHeaders, baseExtractorArgs, formatSelector, cleanMediaError, SESSION_REQUIRED, sessionRequired, inspectWithExtractor, extractMediaInfo, verifyVideo, mergeMediaFiles } from './media.js';
import { requestRemote, NetworkStallError } from './network.js';
import { downloadParallel, probeRange, publishFile, RangeUnsupportedError, SourceChangedError, SourceExpiredError, RateLimitedError } from './transfer.js';
import { selectSourcePlan, sourceHeaders, safeExtension, isManifest } from './source-plan.js';
import { ConnectionBudget } from './connection-budget.js';
import { verifyCompletedFile, mediaExpectation, isVideoFile } from './verification.js';
import { fileNameFor, categoryFor, riskOf, verifyFileFormat, markFromInternet } from './file-download.js';
import { readHls, readHlsResponse, hlsInfo, audioChoices } from './hls.js';
import { enrichPlaylistFormats } from './playlist-probe.js';
import { summarizeMedia } from './media.js';
import { downloadHls } from './hls-download.js';
import { recoverRead, RemoteResponseError, recordRecovery } from './recovery.js';
import { hlsTotalEstimate, sourceSize } from './hls-size.js';
import { listPlaylist, episodeName, MAX_PLAYLIST } from './playlist.js';
import { resolveLanguage, validSubtitleLanguage, validAudioLanguage } from './language.js';
import { decodeText } from './text-decode.js';
import { pickLead, classifySubtitle, parseSubtitle, toVtt, signature, languageInfo, guessLanguage, languageFromAddress, embedSubtitles, writeSidecars, canEmbed, MAX_SUBTITLE_BYTES, MAX_SUBTITLE_TRACKS } from './subtitles.js';

export function assertCompleteResponse(response) {
  if (![200, 206].includes(response.statusCode)) {
    const code = response.statusCode;
    response.destroy();
    throw new Error(cleanMediaError(`HTTP ${code}. Sunucu indirme isteğini reddetti.`));
  }
  if (response.statusCode === 206 || response.headers['content-range']) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    if (!range || BigInt(range[1]) + 1n !== BigInt(range[2])) {
      response.destroy();
      throw new Error('Bu bağlantı videonun yalnızca bir parçası. Eklentide “Sayfayı incele” ile tam video kaynağını seç.');
    }
    response.headers['content-length'] ||= range[2];
  }
}

export async function openRemote(raw, signal, redirects = 0, headers = {}) {
  const { response, url } = await requestRemote(raw, signal, headers, redirects);
  assertCompleteResponse(response);
  return { response, url };
}

// Settings shown in the app's Settings screen. Each check returns true or the message shown to the user.
const SETTING_DEFAULTS = {
  appearance: 'compact',
  textSize: 'normal',
  theme: 'dark',            // 'dark', 'light' or 'system' (follows Windows)
  accent: 'green',          // accent colour: green, blue, orange or violet
  listLayout: { widths: {}, hidden: [], focus: false }, // visual only: column widths (px), hidden columns, focus view
  subtitleMode: 'both',     // subtitles found for a video: 'both' (into the file + the leading track as .srt next to it), 'embed' only, 'sidecar' .srt only, or 'off'
  subtitleLanguage: 'auto', // default subtitle when the page names none: 'auto' (system language), 'off', or a language code such as 'de'
  audioLanguage: 'player',  // sound: 'player' (what the page's player plays), 'original', or a language code
  subtitleContainer: 'keep', // video with subtitles: 'keep' its format (mp4) or 'mkv' (lossless copy; VLC then opens the default subtitle by itself)
  smartNames: true,         // new jobs only; existing jobs retain their naming policy
  folderLayout: 'flat',     // flat, site, series or site-series
  downloadDirectory: null,  // null = the default folder; changing it affects new downloads only
  maxQuality: 'best',       // pre-selected quality cap: 'best' or a picture height
  preferCompatible: false,  // pre-select H.264/MP4 at the same height when offered (plays everywhere)
  maxConnections: 8,        // parallel connections per download
  deepVerifyDefault: false, // full decode scan after each media download
  notifyOnFinish: true,     // desktop notification when a download finishes or fails
  closeToTray: true,        // desktop window close button keeps the app in the tray
  startMinimized: false     // when Windows starts the app, keep it in the tray
};
const bool = name => value => typeof value === 'boolean' || `${name} açık veya kapalı olmalı.`;
// Only known column ids and bounded numbers are stored; never free-form CSS or markup.
const LAYOUT_COLUMNS = ['name', 'size', 'speed', 'eta', 'state'], LAYOUT_HIDEABLE = ['size', 'speed', 'eta', 'state'];
const validLayout = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['widths', 'hidden', 'focus'].includes(key))
  && value.widths && typeof value.widths === 'object' && !Array.isArray(value.widths)
  && Object.entries(value.widths).every(([key, width]) => LAYOUT_COLUMNS.includes(key) && Number.isInteger(width) && width >= 48 && width <= 1600)
  && Array.isArray(value.hidden) && value.hidden.length <= LAYOUT_HIDEABLE.length && new Set(value.hidden).size === value.hidden.length && value.hidden.every(id => LAYOUT_HIDEABLE.includes(id))
  && typeof value.focus === 'boolean';
const VISUAL_SETTINGS = ['appearance', 'textSize', 'theme', 'accent', 'listLayout'];
const SETTING_CHECKS = {
  subtitleLanguage: value => validSubtitleLanguage(value) || 'Altyazı dili geçersiz.',
  audioLanguage: value => validAudioLanguage(value) || 'Ses dili geçersiz.',
  subtitleContainer: value => ['keep', 'mkv'].includes(value) || 'Altyazılı video biçimi geçersiz.',
  smartNames: bool('Akıllı dosya adı'),
  folderLayout: value => ['flat', 'site', 'series', 'site-series'].includes(value) || 'Klasör düzeni geçersiz.',
  subtitleMode: value => ['both', 'embed', 'sidecar', 'off'].includes(value) || 'Altyazı seçimi geçersiz.',
  listLayout: value => validLayout(value) || 'Liste düzeni geçersiz.',
  appearance: value => ['compact', 'normal'].includes(value) || 'Görünüm geçersiz.',
  textSize: value => ['small', 'normal', 'large'].includes(value) || 'Yazı boyutu geçersiz.',
  theme: value => ['dark', 'light', 'system'].includes(value) || 'Tema geçersiz.',
  accent: value => ['green', 'blue', 'orange', 'violet'].includes(value) || 'Vurgu rengi geçersiz.',
  downloadDirectory: value => value === null || (typeof value === 'string' && path.isAbsolute(value) && value.length <= 240 && !/[\x00-\x1f<>"|?*]/.test(value.slice(2))) || 'İndirme klasörü tam bir klasör yolu olmalı (ör. D:\\Videolar).',
  maxQuality: value => value === 'best' || [2160, 1440, 1080, 720, 480, 360].includes(value) || 'Kalite sınırı geçersiz.',
  preferCompatible: bool('Uyumlu biçim tercihi'),
  maxConnections: value => (Number.isInteger(value) && value >= 1 && value <= 16) || 'Bağlantı sayısı 1 ile 16 arasında olmalı.',
  autoRetries: value => (Number.isInteger(value) && value >= 0 && value <= 5) || 'Otomatik yeniden deneme 0 ile 5 arasında olmalı.',
  deepVerifyDefault: bool('Derin doğrulama'),
  notifyOnFinish: bool('Bildirim'),
  closeToTray: bool('Tepsiye küçültme'),
  startMinimized: bool('Gizli başlatma')
};
// A chosen folder must exist (or be creatable) and accept files, before any download is sent there.
function usableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.hypernab-write-test-${randomUUID()}`);
    fs.writeFileSync(probe, '', { flag: 'wx' }); fs.rmSync(probe);
  } catch { throw new Error('Bu klasöre yazılamıyor. Başka bir klasör seç.'); }
}

// An upload id is a UUID the browser made up; anything else simply means no upload.
const uploadKey = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;

export class DownloadQueue {
  constructor({ directory, stateFile, toolsDirectory, locale = undefined, concurrency = Infinity, autoRetries = 2, remoteOpener = openRemote, rangeRequest = requestRemote, infoExtractor = extractMediaInfo, mediaInspector = inspectWithExtractor, mediaVerifier = verifyVideo, mediaMerger = mergeMediaFiles, budget = new ConnectionBudget(), deepVerifier, processSpawner = spawnManaged, pageSniffer = sniffPage, remoteResolver = resolveRemote, playlistLister = listPlaylist }) {
    this.playlistLister = playlistLister;
    this.pageSniffer = pageSniffer;
    // Browser session cookies: memory only, per job. Never written to queue.json, logs or API responses.
    this.sessions = new Map();
    this.cookieless = new Set(); // job ids whose retry runs without browser cookies
    // One private folder per queue instance (never shared: another queue/process starting up must not wipe a live cookie file).
    this.cookieDirectory = path.join(os.tmpdir(), `hypernab-cookies-${process.pid}-${randomUUID().slice(0, 8)}`);
    try { // leftovers of crashed runs: only folders whose owning process is gone
      for (const name of fs.readdirSync(os.tmpdir())) {
        const owner = /^hypernab-cookies-(\d+)-/.exec(name); if (!owner) continue;
        let alive = true; try { process.kill(Number(owner[1]), 0); } catch (error) { alive = error.code === 'EPERM'; }
        if (!alive) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
    this.directory = directory;
    this.remoteResolver = remoteResolver; // DNS/address check of a source before an external tool fetches it
    this.stateFile = stateFile;
    this.history = new HistoryStore(`${stateFile}.history.sqlite`);
    this.toolsDirectory = toolsDirectory;
    this.concurrency = concurrency;
    this.budget = budget;
    this.remoteOpener = remoteOpener === openRemote ? async (url, signal, redirects = 0, headers = {}) => {
      const result = await requestRemote(url, signal, headers, redirects, budget); assertCompleteResponse(result.response); return result;
    } : remoteOpener;
    this.rangeRequest = rangeRequest === requestRemote ? (url, signal, headers) => requestRemote(url, signal, headers, 0, budget) : (url, signal, headers) => budget.request(rangeRequest, url, signal, headers);
    this.infoExtractor = infoExtractor;
    this.mediaInspector = mediaInspector;
    this.mediaVerifier = mediaVerifier;
    this.mediaMerger = mediaMerger;
    this.deepVerifier = deepVerifier;
    this.processSpawner = processSpawner;
    this.jobs = [];
    this.active = new Map();
    this.offered = new Map(); // url -> { at, options: Map(formatId -> label) } from the latest inspection
    this.subtitleUploads = new Map(); // upload id -> subtitle text pieces sent by the browser (memory only)
    this.hlsInspections = new Map();
    this.meters = new WeakMap();
    this.observedTransfers = new WeakSet();
    this.stopping = false;
    fs.mkdirSync(directory, { recursive: true });
    try {
      this.jobs = JSON.parse(fs.readFileSync(stateFile, 'utf8')).map(job => ({
        ...job, resumeRequested: false, speed: 0, status: ['queued', 'running'].includes(job.status) ? 'interrupted' : job.status,
        sizeKind: job.sizeKind || (job.total > 0 ? job.status === 'completed' || job.transfer?.method === 'parallel-http' ? 'exact' : 'approx' : 'unknown'),
        error: ['queued', 'running'].includes(job.status) ? 'Uygulama kapandı; yeniden deneyebilirsin.' : job.error
      }));
    } catch { /* First launch; no queue yet. */ }
    for (const job of this.jobs) {
      if (job.status === 'completed' && job.file && path.basename(job.file) === job.file) {
        try {
          const size = fs.statSync(path.join(job.directory || directory, job.file)).size;
          job.received = size; job.total = size;
        } catch { /* Keep history even if the user moved the completed file. */ }
      }
    }
    // The list is oldest first and its order never changes (a row stays where it was added). Older state files kept the newest first:
    // flip them exactly once, recorded in a small marker file.
    this.metaFile = `${stateFile}.meta.json`;
    let orderVersion = 0;
    try { orderVersion = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')).order || 0; } catch { /* no marker yet */ }
    if (orderVersion < 2) {
      this.jobs.reverse();
      try { fs.writeFileSync(this.metaFile, JSON.stringify({ order: 2 })); } catch { /* retried at the next start */ }
    }
    this.submissions = new SubmissionStore(`${stateFile}.submissions.json`, this.jobs);
    // Queue ("add to queue") state. The list order is persisted with the jobs; "queue running" is deliberately NOT: after a restart
    // nothing starts by itself until the user presses "Start queue".
    this.settingsFile = `${stateFile}.settings.json`;
    this.locale = locale; // the system language for the default subtitle; tests pass their own
    this.settings = { queueLimit: 'all', queueNames: ['Genel'], selectedQueue: 'Genel', speedLimitKiB: 0, ...SETTING_DEFAULTS, autoRetries }; // speed limit is per download; 0 means unlimited
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      for (const [key, check] of Object.entries(SETTING_CHECKS)) if (key in saved && check(saved[key]) === true) this.settings[key] = saved[key];
      if (saved.queueLimit === 'all' || saved.queueLimitEnabled === false) this.settings.queueLimit = 'all'; // older files: "limit off" means all
      else if (Number.isInteger(saved.queueLimit) && saved.queueLimit >= 1 && saved.queueLimit <= 6) this.settings.queueLimit = saved.queueLimit;
      if (Array.isArray(saved.queueNames) && saved.queueNames.length && saved.queueNames.length <= 20 && saved.queueNames.every(name => typeof name === 'string' && name.trim() && name.length <= 40)) this.settings.queueNames = [...new Set(['Genel', ...saved.queueNames])];
      if (this.settings.queueNames.includes(saved.selectedQueue)) this.settings.selectedQueue = saved.selectedQueue;
      if (Number.isInteger(saved.speedLimitKiB) && saved.speedLimitKiB >= 0 && saved.speedLimitKiB <= 1048576) this.settings.speedLimitKiB = saved.speedLimitKiB;
      // The first version saved "embed only" as the default; the default is now "embed + side .srt": a file still holding the old value moves over once.
      if (saved.settingsVersion !== 2 && this.settings.subtitleMode === 'embed') this.settings.subtitleMode = 'both';
    } catch { /* defaults: one at a time */ }
    this.queueRunning = false;
    this.runningQueue = null;
    this.limiters = new Map();
  }

  capabilities() {
    return {
      ytDlp: fs.existsSync(path.join(this.toolsDirectory, 'yt-dlp.exe')),
      ffmpeg: fs.existsSync(path.join(this.toolsDirectory, 'ffmpeg.exe')),
      nodeRuntime: process.version,
      parallelConnections: this.settings.maxConnections,
      connectionBudget: this.budget.snapshot(),
      directory: this.currentDirectory(),
      queue: this.queueInfo()
    };
  }

  // Each job keeps the folder it was started in: changing the download folder in Settings affects new downloads only, so
  // half-finished work (and its resume data) is never looked for in the wrong place.
  dirOf(job) { return job.directory || this.directory; }
  currentDirectory() { return this.settings.downloadDirectory || this.directory; }
  fileLister() {
    const seen = new Map();
    return dir => { if (!seen.has(dir)) { try { seen.set(dir, fs.readdirSync(dir)); } catch { seen.set(dir, []); } } return seen.get(dir); };
  }

  location(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job) throw new Error('İndirme bulunamadı.');
    const directory = this.dirOf(job);
    if (!path.isAbsolute(directory)) throw new Error('İndirme konumu geçersiz.');
    // Partial files are never executed or selected as if they were finished.
    return { directory, file: job.status === 'completed' ? job.file : null };
  }

  archiveCompleted(jobs = this.jobs) {
    this.history.record(jobs.filter(job => job.status === 'completed').map(job => ({ ...job, directory: this.dirOf(job) })));
  }

  async historyPage(input) {
    this.archiveCompleted(); // imports completed records from older versions once, without scanning downloads
    return this.history.page(input);
  }

  list() {
    const filesIn = this.fileLister();
    // Signed source URLs are persisted locally but not exposed in queue responses.
    return this.jobs.map(original => {
      const { url, headers, submissionFingerprint, audioUrl, subtitlePending, ...job } = original;
      const settling = this.active.has(job.id) && job.status !== 'running';
      const phase = jobPhase(job, settling);
      const meter = this.meter(original); meter.stage(phase);
      const progress = meter.snapshot(job, phase);
      return { ...job, speed: progress.speed, progress, settling, canClear: this.canClear(job, filesIn(this.dirOf(job))), error: job.error ? cleanMediaError(job.error) : null, host: job.pageHost || new URL(url).hostname };
    });
  }

  meter(job) {
    if (!this.meters.has(job)) this.meters.set(job, new ProgressMeter());
    return this.meters.get(job);
  }

  phase(job, phase) {
    if (job.transfer) job.transfer.phase = phase;
    this.meter(job).stage(phase);
    if (phase !== 'downloading') job.speed = 0;
  }

  measure(job, bytes = job.received) {
    const phase = jobPhase(job, this.active.has(job.id) && job.status !== 'running');
    const meter = this.meter(job); meter.stage(phase);
    if (phase === 'downloading') {
      meter.sample(bytes); job.measuredNetworkBytes = Math.max(job.measuredNetworkBytes || 0, bytes || 0);
      if (bytes > 0 && !this.observedTransfers.has(job)) {
        this.observedTransfers.add(job);
        recordRecovery(job, 'transfer-observed', { elapsedMs: Math.max(0, Date.now() - Date.parse(job.startedAt)) });
      }
    }
    job.speed = meter.snapshot(job, phase).speed;
  }

  canClear(job, files) {
    if (this.active.has(job.id) || !['completed', 'failed', 'cancelled'].includes(job.status)) return false;
    // Explicit cancellation ends the job, not ownership of its files. Its row
    // can be removed once the worker exits, without deleting any partial data.
    if (['completed', 'cancelled'].includes(job.status)) return true;
    // Failed work with partial data remains protected until explicitly cancelled.
    const id = job.id.toLowerCase();
    return !(job.received > 0) && !files.some(name => name.toLowerCase().startsWith(`${id}-`) || name.toLowerCase().startsWith(`${id}.`));
  }

  validateIds(ids) {
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Geçerli indirme kimlikleri seç.');
    return new Set(ids);
  }

  clearFinished({ ids } = {}) {
    const selected = ids === undefined ? null : this.validateIds(ids);
    if (this.submissions.entries.size) this.submissions.save();
    const filesIn = this.fileLister();
    const removed = [];
    // If history cannot be saved, leave queue records intact as well as their files.
    this.archiveCompleted(this.jobs.filter(job => (!selected || selected.has(job.id)) && this.canClear(job, filesIn(this.dirOf(job)))));
    this.jobs = this.jobs.filter(job => {
      if ((!selected || selected.has(job.id)) && this.canClear(job, filesIn(this.dirOf(job)))) { removed.push(job.id); this.dropSession(job); return false; }
      return true;
    });
    // Deliberately no file operations: clearing history never touches downloads.
    this.save();
    return { removed: removed.length, removedIds: removed };
  }

  transition(job, action) {
    if (action === 'pause' && ['running', 'queued'].includes(job.status)) {
      job.status = 'paused'; job.resumeRequested = false; job.speed = 0;
      this.meter(job).stage('pausing');
      this.active.get(job.id)?.abort(); return true;
    }
    if (action === 'resume' && ['paused', 'interrupted'].includes(job.status) && !job.resumeRequested) {
      job.error = null; job.speed = 0;
      if (this.active.has(job.id)) job.resumeRequested = true;
      else job.status = 'queued';
      return true;
    }
    if (action === 'cancel' && ['running', 'queued', 'held', 'paused', 'interrupted', 'failed'].includes(job.status)) {
      job.status = 'cancelled'; job.resumeRequested = false; job.speed = 0; this.dropSession(job);
      this.meter(job).stage('cancelled');
      this.active.get(job.id)?.abort(); return true;
    }
    return false;
  }

  batch(action, { ids, all = false } = {}) {
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Geçersiz toplu işlem.');
    if (typeof all !== 'boolean' || (all && ids !== undefined) || (!all && ids === undefined)) throw new Error('Tüm işler veya belirli bir seçim belirt.');
    const selected = all ? null : this.validateIds(ids);
    let changed = 0, skipped = 0;
    for (const job of this.jobs) {
      if (selected && !selected.has(job.id)) continue;
      if (this.transition(job, action)) changed++; else skipped++;
    }
    // "Pause all" only touches the jobs that exist right now; there is no sticky queue-wide
    // pause, so downloads added or retried afterwards start normally.
    this.save(); this.pump();
    return { changed, skipped };
  }

  pause(id) { return this.singleAction('pause', id); }
  resume(id) { return this.singleAction('resume', id); }
  singleAction(action, id) {
    if (!this.jobs.some(job => job.id === id)) throw new Error('İndirme bulunamadı.');
    return this.batch(action, { ids: [id] });
  }

  // Pages whose player runs in JavaScript (iframes, anti-bot pages) cannot be read by the extractor.
  // Open them in a real browser, record the media request the player makes and inspect that instead.
  async inspectViaBrowser(input, url, original, signal) {
    const attempt = headless => this.pageSniffer(url, { signal, headless, timeoutMs: headless ? 30000 : 50000 });
    let result = await attempt(true);
    if (!result.candidates.length) result = await attempt(false);
    for (const candidate of result.candidates.slice(0, 4)) {
      const resolved = { url: candidate.url, referer: candidate.referer || url, userAgent: result.userAgent || undefined };
      try {
        const info = await this.inspect({ ...resolved, title: input.title || result.pageTitle?.split(/\s[|–—-]\s/)[0], engine: 'extractor' }, signal, true);
        return { ...info, via: 'browser', resolved: { ...resolved, pageUrl: url } };
      } catch (error) { if (signal.aborted) throw error; }
    }
    throw new Error(result.challenge
      ? 'Site, otomatik tarayıcıyı Cloudflare doğrulamasıyla engelledi. Sayfayı kendi tarayıcında açıp videoyu oynat; eklenti kaynağı yakalayıp gönderir.'
      : `${original.message} Sayfa tarayıcıda açıldı ancak indirilebilir (DRM’siz) bir video isteği görülmedi.`);
  }

  async inspectHls(input, cookies, signal, playlist = null) {
    const url = parseRemoteUrl(input.url).href, headers = mediaHeaders(input);
    const key = createHash('sha256').update(JSON.stringify([url, headers, cookies])).digest('hex');
    let entry = this.hlsInspections.get(key);
    if (!entry || Date.now() - entry.at > 900000) {
      const request = (target, requestSignal, extra = {}) => this.rangeRequest(target, requestSignal, withCookie({ ...headers, ...extra }, cookies, target));
      playlist ||= await readHls({ url, headers, signal, request });
      if (!playlist) throw new Error('Yakalanan kaynak geçerli bir HLS listesi değil.');
      const raw = hlsInfo(playlist, url, input.title);
      entry = { raw, at: Date.now(), pending: true };
      this.hlsInspections.set(key, entry);
      while (this.hlsInspections.size > 50) this.hlsInspections.delete(this.hlsInspections.keys().next().value);
      // The first response contains the master facts immediately. Measurements never hold up the panel.
      entry.work = (async () => {
        if (playlist.variants.length) {
          const first = playlist.variants.find(v => v.height > 0) || playlist.variants[0];
          const child = await readHls({ url: first.url, signal, request }).catch(() => null);
          if (child?.duration && !child.live) {
            raw.duration = child.duration;
            raw.formats.find(f => f.url === first.url).hlsPlaylist = child;
          }
          await enrichPlaylistFormats(raw, { headers, toolsDirectory: this.toolsDirectory, signal, probe: args => import('./playlist-probe.js').then(m => m.probeMediaPlaylist({ ...args, request })) });
        } else await enrichPlaylistFormats(raw, { headers, toolsDirectory: this.toolsDirectory, signal, probe: args => import('./playlist-probe.js').then(m => m.probeMediaPlaylist({ ...args, request, playlist })) });
      })().catch(() => {}).finally(() => { entry.pending = false; });
    }
    const { options, defaultOptionId } = buildQualityOptions(entry.raw, { ffmpeg: this.capabilities().ffmpeg });
    for (const option of options) {
      const variant = entry.raw.formats.find(f => f.format_id === option.id.split('+')[0]);
      // Master BANDWIDTH includes the audio group: do not count it twice or pretend it is an exact file size.
      if (entry.raw.duration > 0 && variant?.tbr > 0) { option.filesize = Math.round(variant.tbr * 1000 / 8 * entry.raw.duration); option.sizeKind = 'approx'; }
    }
    this.rememberOffered(url, options, cookies, entry.raw);
    return { ...summarizeMedia(entry.raw, { title: input.title }), options, defaultOptionId: preferredOptionId(options, this.settings) || defaultOptionId,
      engine: 'extractor', resolved: { engine: 'extractor', mediaKind: 'HLS' }, nativeHls: true, inspectionPending: entry.pending, sessionUsed: cookies.length > 0,
      silentStream: entry.raw.silentStream === true, audioOnly: entry.raw.audioOnly === true,
      ...(audioChoices(entry.raw).length ? { audioTracks: audioChoices(entry.raw) } : {}),
      qualityNote: entry.pending && !options.length ? 'Kalite arka planda ölçülüyor; liste otomatik güncellenecek.' : null };
  }

  async inspect(input, signal = AbortSignal.timeout(60000), fromBrowser = false) {
    const url = parseRemoteUrl(input.url).href;
    const headers = mediaHeaders(input);
    // Only cookies for the media URL's (or its page's) own host are accepted; others are dropped.
    const cookies = sanitizeCookies(input.cookies, [url, input.pageUrl]);
    if (input.mediaKind === 'HLS' || /\.m3u8(?:\?|$)/i.test(url)) return this.inspectHls(input, cookies, signal);
    if (input.engine !== 'direct') {
      if (!this.capabilities().ytDlp) throw new Error('Video bilgisi için yt-dlp kurulmalı.');
      let info, usedCookies = cookies;
      const resolveWith = async list => {
        const jar = writeCookieJar(list, this.cookieDirectory);
        try { return await this.mediaInspector({ url, title: input.title, toolsDirectory: this.toolsDirectory, headers, cookieFile: jar, signal }); }
        finally { removeCookieJar(jar); }
      };
      const tallest = result => Math.max(0, ...(result?.options || []).map(option => option.height || 0));
      try {
        if (!cookies.length) info = await resolveWith([]);
        else {
          // Cookies are an upgrade, not a requirement: some sites hand out stream addresses that refuse our own requests when
          // resolved WITH cookies. Resolve both ways at once; the cookieless result wins unless cookies really unlock a taller picture.
          const [plain, withSession] = await Promise.allSettled([resolveWith([]), resolveWith(cookies)]);
          if (signal.aborted) throw signal.reason;
          const plainOk = plain.status === 'fulfilled' && plain.value.options.length > 0 ? plain.value : null;
          const sessionOk = withSession.status === 'fulfilled' ? withSession.value : null;
          if (plainOk && !(sessionOk && tallest(sessionOk) > tallest(plainOk))) { info = plainOk; usedCookies = []; }
          else if (sessionOk) info = sessionOk;
          else throw (withSession.reason ?? plain.reason);
        }
      }
      catch (error) {
        // Automatic checks (input.noBrowser) never open a browser window on their own; only a user-pressed inspection may.
        // A sign-in/followers-only video cannot be opened by the app's own browser either (it has no session): say so at once.
        if (sessionRequired(error.message)) throw new Error(SESSION_REQUIRED);
        if (fromBrowser || input.noBrowser === true || signal.aborted || /DRM/i.test(error.message)) throw error;
        return this.inspectViaBrowser(input, url, error, AbortSignal.timeout(120000));
      }
      info.options = info.options.map(option => {
        const { measurementKey, ...publicOption } = option;
        return { ...publicOption, ...estimateBeforeDownload(this.jobs, measurementKey, option.filesize) };
      });
      info.defaultOptionId = preferredOptionId(info.options, this.settings) ?? info.defaultOptionId;
      const { rawInfo, ...publicInfo } = info;
      this.rememberOffered(url, info.options, usedCookies, rawInfo);
      return { ...publicInfo, sessionUsed: usedCookies.length > 0, engine: 'extractor', warning: this.capabilities().ffmpeg ? null : 'FFmpeg yok: ayrı ses ve görüntü akışları indirilemez.' };
    }
    const { response, url: finalUrl } = await this.remoteOpener(url, signal, 0, withCookie(headers, cookies, url));
    this.rememberOffered(url, [], cookies);
    try {
      const mime = String(response.headers['content-type'] || '');
      const playlist = await readHlsResponse(response, finalUrl.href, signal);
      if (playlist) return this.inspectHls(input, cookies, signal, playlist);
      if (/text\/html|mpegurl|dash\+xml/i.test(mime)) throw new Error('Bu bir sayfa veya akış listesi. Akış/site motorunu seç.');
      const extension = mime.includes('video/mp4') ? 'mp4' : mime.includes('video/webm') ? 'webm' : path.extname(finalUrl.pathname).slice(1) || safeExtension(finalUrl.href, mime).replace(/^bin$/, '') || null;
      const filesize = Number(response.headers['content-length']) || null;
      const estimate = estimateBeforeDownload(this.jobs, sourceMeasureKey([{ url: finalUrl.href, protocol: 'https' }]), filesize);
      return { title: safeTitle(input.title || path.basename(finalUrl.pathname) || 'video'), extension, filesize, ...estimate, estimatedSize: false, heights: [], duration: null, sessionUsed: cookies.length > 0, engine: 'direct', options: [], defaultOptionId: null, qualityNote: 'Doğrudan dosyada seçilebilir kalite yok; dosya olduğu gibi indirilir.' };
    } finally { response.destroy(); }
  }

  async sniff(input, signal = AbortSignal.timeout(6000)) {
    const url = parseRemoteUrl(input.url).href;
    const cookies = sanitizeCookies(input.cookies, [url, input.pageUrl]);
    const headers = mediaHeaders(input);
    const playlist = await readHls({ url, signal, request: (target, requestSignal, extra) => this.rangeRequest(target, requestSignal, withCookie({ ...headers, ...extra }, cookies, target)) });
    if (!playlist) throw new Error('Yanıt bir HLS listesi değil.');
    return this.inspectHls(input, cookies, signal, playlist);
  }

  // Work files carry the job id (resume depends on it); the finished file gets the video's own name.
  // Never overwrites: an existing "Name.mp4" makes this one "Name (2).mp4".
  finalizeName(job) {
    try {
      const prefix = `${job.id}-`;
      if (!job.file || path.basename(job.file) !== job.file || !job.file.startsWith(prefix)) return;
      const ext = path.extname(job.file), original = job.file.slice(prefix.length, job.file.length - ext.length);
      const base = finishedName(job, original, ext);
      if (!base) return;
      const from = path.join(this.dirOf(job), job.file);
      if (!fs.existsSync(from)) return;
      for (let n = 1; n < 1000; n++) {
        const name = `${base}${n > 1 ? ` (${n})` : ''}${ext}`, to = path.join(this.dirOf(job), name);
        if (fs.existsSync(to)) continue;
        // Atomic no-clobber publication, including simultaneous completions.
        try { fs.linkSync(from, to); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        job.file = name;
        try { fs.unlinkSync(from); } catch { /* keep the valid published file */ }
        return;
      }
    } catch { /* keep the working name; the download itself succeeded */ }
  }

  // Browser cookies are an upgrade, not a requirement. Some sites hand out stream addresses that refuse our own requests
  // when the resolver ran WITH cookies, yet work without them. After such a refusal the retry runs cookieless.
  jobCookies(job) { return this.cookieless.has(job.id) ? [] : this.sessions.get(job.id) || []; }
  requestHeaders(job, url, base = job.headers) { return withCookie(base, this.jobCookies(job), url); }
  jarFor(job) { return writeCookieJar(this.jobCookies(job), this.cookieDirectory); }
  dropSession(job) { this.sessions.delete(job.id); this.cookieless.delete(job.id); }

  // The resolver's full answer of the last inspections is kept IN MEMORY ONLY (never persisted or sent out). A download that starts
  // soon after the quality list was shown reuses it instead of running a second slow resolve: it starts within a second or two.
  cachedSelection(job) {
    const offered = this.offered.get(job.url);
    if (!offered?.raw || !job.formatId || Date.now() - offered.at > 1800000) return null; // stream addresses stay valid for hours; 30 min is a safe margin
    const formats = offered.raw.formats;
    if (!Array.isArray(formats)) return null;
    const parts = String(job.formatId).split('+').map(id => formats.find(format => format.format_id === id));
    if (!parts.length || parts.length > 2 || parts.some(part => !part || !part.url)) return null;
    // The sound the user picked (another language than the site's default): same group as the picture, same name and language.
    const tracks = offered.raw.audioTracks, video = parts.find(part => part.vcodec !== 'none'), audio = parts.find(part => part.vcodec === 'none');
    if (job.audioTrack && Array.isArray(tracks) && video?.audioGroup && audio) {
      const wanted = tracks.find(track => track.id === job.audioTrack), inGroup = tracks.filter(track => track.group === video.audioGroup);
      const chosen = wanted && (inGroup.find(track => track.url === wanted.url) || inGroup.find(track => track.name === wanted.name && track.language === wanted.language));
      if (chosen && chosen.url !== audio.url) parts[parts.indexOf(audio)] = { ...audio, url: chosen.url };
    }
    const { formats: _omitted, requested_formats: _requested, requested_downloads: _downloads, ...rest } = offered.raw;
    return parts.length === 1 ? { ...rest, ...parts[0], format_id: job.formatId } : { ...rest, requested_formats: parts, format_id: job.formatId };
  }

  rememberOffered(url, options = [], cookies = [], raw = null) {
    this.offered.delete(url);
    this.offered.set(url, { at: Date.now(), cookies, raw, options: new Map(options.map(option => [option.id, option.label])), sizes: new Map(options.filter(o => Number.isFinite(o.filesize) && o.filesize > 0).map(o => [o.id, o.filesize])), slots: new Map(options.map(option => [option.id, { height: option.height, fps: option.fps ?? null, hdr: Boolean(option.hdr), ext: option.ext, codec: option.codec }])) });
    while (this.offered.size > 50) this.offered.delete(this.offered.keys().next().value);
    const entries = [...this.offered.values()]; // keep the big raw answers of the newest few only
    for (const entry of entries.slice(0, Math.max(0, entries.length - 8))) entry.raw = null;
  }

  add(input) {
    const url = parseRemoteUrl(input.url).href;
    const nativeHls = this.offered.get(url)?.raw?.nativeHls === true || /\.m3u8(?:\?|$)/i.test(url);
    const engine = !nativeHls && input.engine === 'direct' && !isManifest('', url) ? 'direct' : 'extractor';
    const sid = submissionId(input.submissionId);
    if (input.start !== undefined && !['now', 'queue'].includes(input.start)) throw new Error('Başlatma seçimi geçersiz (şimdi veya sıraya).');
    const toQueue = input.start === 'queue';
    let pageHost = null; // only a label; an unusable page address (local, odd port) must not block the download itself
    try { pageHost = input.pageUrl ? parseRemoteUrl(input.pageUrl).hostname : null; } catch { /* label stays empty */ }
    const fingerprint = sid ? createHash('sha256').update(JSON.stringify({ url, engine, pageHost, title: safeTitle(input.title), headers: mediaHeaders(input), quality: input.quality || 'best', audioUrl: input.audioUrl || null, audioTrack: input.audioTrack || null, formatId: input.formatId || null, deepVerify: input.deepVerify === true, expectedSha256: input.expectedSha256?.toLowerCase?.() || null })).digest('hex') : null;
    const receipt = this.findSubmission(sid, fingerprint);
    if (receipt?.abandoned) throw new Error('Bu gönderim kullanıcı tarafından bırakıldı; bağlantıyı yeniden incele.');
    if (receipt) { this.pump(); return receipt.id; }
    if (this.jobs.length >= 500) throw new Error('Kuyruk sınırı 500 kayıt.');
    let formatId = null, formatLabel = null, formatSlot = null;
    if (input.formatId !== undefined && input.formatId !== null && input.formatId !== '') {
      if (engine !== 'extractor') throw new Error('Kalite seçimi yalnızca akış/site motorunda kullanılabilir.');
      if (!isFormatId(input.formatId)) throw new Error('Geçersiz format seçimi.');
      // Only an id the server itself offered for this exact URL a moment ago is accepted.
      const offered = this.offered.get(url);
      if (!offered || Date.now() - offered.at > 3600000 || !offered.options.has(input.formatId)) throw Object.assign(new Error('Bu kalite bağlantının son incelemesinde sunulmadı. Bağlantıyı yeniden incele ve listeden seç.'), { code: 'SELECTION_EXPIRED' });
      formatId = input.formatId; formatLabel = offered.options.get(formatId); formatSlot = offered.slots?.get(formatId) ?? null;
    }
    if (input.deepVerify !== undefined && typeof input.deepVerify !== 'boolean') throw new Error('Derin doğrulama seçimi geçersiz.');
    const expectedSha256 = input.expectedSha256 === undefined || input.expectedSha256 === null || input.expectedSha256 === '' ? null : input.expectedSha256;
    if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256))) throw new Error('SHA-256 değeri 64 onaltılık karakter olmalı.');
    if (input.deepVerify && !this.capabilities().ffmpeg) throw new Error('Derin doğrulama için FFmpeg kurulmalı.');
    // Separate sound playlist for a silent video playlist (both shown by the page's own player).
    let audioUrl = null;
    if (input.audioUrl !== undefined && input.audioUrl !== null && input.audioUrl !== '') {
      if (engine !== 'extractor' || !this.capabilities().ffmpeg || (!nativeHls && !this.capabilities().ytDlp)) throw new Error('Ayrı ses akışı için desteklenen medya motoru ve FFmpeg gerekli.');
      audioUrl = parseRemoteUrl(input.audioUrl).href;
    }
    // Another sound of the same master (dubbed / original ...): only one the server itself offered for this exact address.
    let audioTrack = null, audioName = null;
    if (input.audioTrack !== undefined && input.audioTrack !== null && input.audioTrack !== '') {
      const picked = typeof input.audioTrack === 'string' && /^a\d{1,2}$/.test(input.audioTrack) ? this.offered.get(url)?.raw?.audioTracks?.find(track => track.id === input.audioTrack) : null;
      if (!nativeHls || !picked) throw Object.assign(new Error('Seçtiğin ses bu bağlantının son incelemesinde sunulmadı. Bağlantıyı yeniden incele ve listeden seç.'), { code: 'SELECTION_EXPIRED' });
      audioTrack = picked.id; audioName = String(picked.name || picked.language || '').slice(0, 60) || null;
    }
    if (engine === 'extractor' && !nativeHls && !this.capabilities().ytDlp) throw new Error('Bu indirme için önce yt-dlp kurulmalı. Kurulum adımlarına bak.');
    if (nativeHls && !this.capabilities().ffmpeg) throw new Error('HLS indirmek için FFmpeg gerekli.');
    // A plain file taken over from the browser keeps its real name (with extension) and never gets video-style naming.
    const fileName = engine === 'direct' && input.fileMode === true && typeof input.fileName === 'string' ? fileNameFor({ hint: input.fileName }) : null;
    const job = {
      id: randomUUID(), url, engine, title: safeTitle(fileName ? fileName.replace(/\.[^.]+$/, '') : input.title),
      ...(fileName ? { kind: 'file', fileName } : {}),
      pageHost, submissionId: sid, submissionFingerprint: fingerprint,
      headers: mediaHeaders(input),
      deepVerify: input.deepVerify === true || (input.deepVerify === undefined && this.settings.deepVerifyDefault && this.capabilities().ffmpeg), expectedSha256: expectedSha256?.toLowerCase() || null,
      directory: layoutDirectory(this.currentDirectory(), this.settings.folderLayout, { host: pageHost || new URL(url).hostname, series: input.seriesTitle }),
      smartNames: fileName ? false : this.settings.smartNames,
      releaseYear: knownYear(this.offered.get(url)?.raw),
      quality: ['best', '1080', '720', '480'].includes(input.quality) ? input.quality : 'best',
      formatId, formatLabel, formatSlot, ...(nativeHls ? { nativeHls: true } : {}), ...(audioUrl ? { audioUrl } : {}), ...(audioTrack ? { audioTrack, audioName } : {}),
      estimateBytes: this.offered.get(url)?.sizes?.get(formatId) || null,
      status: toQueue ? 'held' : 'queued', received: 0, total: null, speed: 0, createdAt: new Date().toISOString(), error: null, file: null
    };
    if (nativeHls) { job.total = this.hlsEstimate(job, this.cachedSelection(job) || {}); job.sizeKind = job.total ? 'approx' : 'unknown'; }
    if (toQueue) { job.viaQueue = true; job.queueName = this.settings.selectedQueue; }
    fs.mkdirSync(job.directory, { recursive: true });
    // Cookies are only taken from the inspection the user just made for this exact URL (never from the request body).
    const session = this.offered.get(url);
    if (session?.cookies?.length && Date.now() - session.at <= 3600000) this.sessions.set(job.id, session.cookies);
    const uploaded = this.takeSubtitleUpload(input.subtitleUpload);
    job.subtitlePending = this.storeSubtitleInputs(job.id, { ...input, subtitleTracks: [...(Array.isArray(input.subtitleTracks) ? input.subtitleTracks : []), ...uploaded] });
    if (typeof input.subtitleUpload === 'string' && !uploaded.length) job.subtitleResult = { mode: 'none', note: 'Sayfadaki altyazılar uygulamaya ulaşmadı (bağlantı yenilenmiş olabilir).' };
    // Subtitle tracks listed in the stream's own master playlist (read once during the look-up; no extra request).
    for (const item of nativeHls ? (this.offered.get(url)?.raw?.hlsSubtitles || []).slice(0, 16) : []) job.subtitlePending.push({ kind: 'url', url: item.url, lang: String(item.language || '').slice(0, 20), label: String(item.name || '').slice(0, 60), default: item.default === true, sure: true });
    if (!job.subtitlePending.length) delete job.subtitlePending;
    this.jobs.push(job); // new rows go to the bottom; existing rows never move
    this.save();
    if (sid) this.submissions.remember({ submissionId: sid, fingerprint, id: job.id });
    this.pump();
    return job.id;
  }

  // ---- Subtitles: any track the browser or the stream offered, put into the finished video ----
  subtitleDirectory(id) { return path.join(path.dirname(this.stateFile), 'subtitle-work', id); }
  storeSubtitleInputs(id, input = {}) {
    const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').trim().slice(0, max) : '';
    const pending = []; let n = 0;
    for (const track of Array.isArray(input.subtitleTracks) ? input.subtitleTracks.slice(0, MAX_SUBTITLE_TRACKS) : []) {
      if (!track || typeof track.text !== 'string' || !track.text || Buffer.byteLength(track.text) > MAX_SUBTITLE_BYTES) continue;
      try {
        const directory = this.subtitleDirectory(id); fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `inline-${n++}.txt`); fs.writeFileSync(file, track.text);
        pending.push({ kind: 'file', file, lang: clean(track.lang, 20), label: clean(track.label, 60), default: track.default === true });
      } catch { /* a track we cannot store is skipped; the video still downloads */ }
    }
    for (const item of Array.isArray(input.subtitleUrls) ? input.subtitleUrls.slice(0, 24) : []) {
      try { pending.push({ kind: 'url', url: parseRemoteUrl(typeof item === 'string' ? item : item?.url).href, lang: clean(item?.lang, 20), label: clean(item?.label, 60), default: item?.default === true, sure: item?.sure === true }); } catch { /* not a usable address */ }
    }
    return pending.slice(0, 40);
  }
  // Subtitle text the browser read from the page's player arrives in small pieces (both transports limit one message to 32 KB),
  // is held in memory for a while, and joins the download that names its upload id.
  receiveSubtitle(input = {}) {
    const id = uploadKey(input.uploadId);
    const track = Number(input.track), seq = Number(input.seq), count = Number(input.count);
    if (!id || !Number.isInteger(track) || track < 0 || track >= MAX_SUBTITLE_TRACKS || !Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(seq) || seq < 0 || seq >= count || typeof input.chunk !== 'string' || input.chunk.length > 12000) throw new Error('Altyazı parçası geçersiz.');
    const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').trim().slice(0, max) : '';
    const now = Date.now();
    for (const [key, upload] of this.subtitleUploads) if (now - upload.at > 3600000) this.subtitleUploads.delete(key);
    while (this.subtitleUploads.size >= 40 && !this.subtitleUploads.has(id)) this.subtitleUploads.delete(this.subtitleUploads.keys().next().value);
    const upload = this.subtitleUploads.get(id) || { at: now, tracks: new Map() };
    const entry = upload.tracks.get(track) || { parts: new Map(), count, lang: clean(input.lang, 20), label: clean(input.label, 60), default: input.default === true };
    if (entry.count !== count) throw new Error('Altyazı parça sayısı değişti.');
    entry.parts.set(seq, input.chunk); upload.tracks.set(track, entry); upload.at = now; this.subtitleUploads.set(id, upload);
    const size = [...entry.parts.values()].reduce((sum, part) => sum + part.length, 0);
    const total = [...this.subtitleUploads.values()].reduce((sum, item) => sum + [...item.tracks.values()].reduce((s, t) => s + [...t.parts.values()].reduce((n, p) => n + p.length, 0), 0), 0);
    if (size > MAX_SUBTITLE_BYTES || total > 32 * 1048576) { upload.tracks.delete(track); throw new Error('Altyazı çok büyük.'); }
    return { received: entry.parts.size, complete: entry.parts.size === count };
  }
  takeSubtitleUpload(raw) {
    const id = uploadKey(raw), upload = id && this.subtitleUploads.get(id);
    if (!upload) return [];
    this.subtitleUploads.delete(id);
    return [...upload.tracks.entries()].sort(([a], [b]) => a - b).filter(([, entry]) => entry.parts.size === entry.count)
      .map(([, entry]) => ({ lang: entry.lang, label: entry.label, default: entry.default, text: [...entry.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part).join('') }));
  }
  async fetchSubtitleText(raw, signal, headers, cookies, hint) {
    const { response, url } = await this.rangeRequest(raw, signal, withCookie({ ...headers }, cookies, raw));
    if (response.statusCode !== 200) { response.destroy(); return null; }
    const chunks = []; let bytes = 0;
    try { for await (const chunk of response) { bytes += chunk.length; if (bytes > MAX_SUBTITLE_BYTES) { response.destroy(); return null; } chunks.push(chunk); } } catch { return null; }
    const buffer = Buffer.concat(chunks);
    const decoded = decodeText(buffer, { hint }); // UTF-8 or UTF-16, else the legacy code page that reads as real language (see text-decode.js)
    return { text: decoded.text, suspect: decoded.suspect, url: String(url?.href || url || raw) };
  }
  // A playlist of small WebVTT pieces (HLS subtitle track) becomes one WebVTT text.
  async readSubtitlePlaylist(text, base, signal, headers, cookies) {
    const pieces = []; let total = 0;
    for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(item => item && !item.startsWith('#')).slice(0, 4000)) {
      let target; try { target = parseRemoteUrl(new URL(line, base).href).href; } catch { continue; }
      const piece = await this.fetchSubtitleText(target, signal, headers, cookies).catch(() => null);
      if (!piece) continue;
      total += piece.text.length; if (total > 3 * MAX_SUBTITLE_BYTES) break;
      pieces.push(piece.text.replace(/^﻿?WEBVTT[^\n]*\n(?:[^\n]+\n)*?\r?\n/, '').replace(/^X-TIMESTAMP-MAP[^\n]*\n/gm, ''));
    }
    return pieces.length ? `WEBVTT\n\n${pieces.join('\n\n')}` : null;
  }
  async readSubtitleSource(item, signal, headers, cookies) {
    const hint = languageInfo(item.lang || (item.url && languageFromAddress(item.url)), item.label).iso1;
    if (item.kind === 'file') {
      const buffer = fs.readFileSync(item.file);
      if (buffer.length > MAX_SUBTITLE_BYTES) return null;
      const decoded = decodeText(buffer, { hint }); item.encodingSuspect = decoded.suspect;
      return decoded.text;
    }
    const fetched = await this.fetchSubtitleText(item.url, signal, headers, cookies, hint);
    if (!fetched) return null;
    item.encodingSuspect = fetched.suspect;
    return /^﻿?#EXTM3U/.test(fetched.text) ? this.readSubtitlePlaylist(fetched.text, fetched.url, signal, headers, cookies) : fetched.text;
  }
  // Runs on the finished video of ANY download path. It must never fail the download.
  subtitleLanguage() { return resolveLanguage(this.settings.subtitleLanguage, this.locale); }
  async attachSubtitles(job, signal) {
    const directory = this.subtitleDirectory(job.id);
    try {
      const mode = this.settings.subtitleMode, pending = job.subtitlePending || [];
      if (mode === 'off' || !pending.length || !job.file || !isVideoFile(job.file)) return;
      let video = path.join(this.dirOf(job), job.file);
      if (!fs.existsSync(video)) return;
      this.phase(job, 'processing');
      const combined = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      const headers = job.headers || {}, cookies = this.jobCookies(job);
      const candidates = pending.slice(0, 40);
      const found = [], seen = new Set(); let encodingSuspect = false;
      for (const item of candidates) {
        if (combined.aborted || found.length >= MAX_SUBTITLE_TRACKS) break;
        const raw = await this.readSubtitleSource(item, combined, headers, cookies).catch(() => null);
        const parsed = raw && parseSubtitle(raw);
        if (!parsed) continue;
        if (item.encodingSuspect) encodingSuspect = true; // the letters of this one may be wrong: the row says so
        let lang = languageInfo(item.lang || (item.url && languageFromAddress(item.url)), item.label);
        if (lang.iso3 === 'und') { const guessed = guessLanguage(parsed.cues); if (guessed) lang = languageInfo(guessed, item.label); } // "1.vtt" / "2.vtt": the words tell the language
        const key = signature(parsed.cues, lang.iso3);
        if (seen.has(key)) continue; seen.add(key);
        found.push({ ...lang, name: item.label && item.label.length <= 60 ? item.label : lang.name, default: item.default === true, cues: parsed.cues });
      }
      const expected = candidates.some(item => item.kind === 'file' || item.sure);
      if (!found.length) { if (expected) job.subtitleResult = { mode: 'none', note: 'Sayfada altyazı vardı ama okunabilir bir altyazı dosyası alınamadı.' }; return; }
      // The track the page was showing leads; otherwise a full-length one in the user's subtitle language (system language unless changed).
      // No such track: nothing is flagged and no side file is written, so no player shows a wrong language by itself.
      found.sort((a, b) => Number(b.default) - Number(a.default));
      const lead = pickLead(found, this.subtitleLanguage());
      found.forEach((track, index) => { track.default = index === lead; });
      if (lead > 0) found.unshift(...found.splice(lead, 1));
      fs.mkdirSync(directory, { recursive: true });
      found.forEach((track, index) => { track.file = path.join(directory, `track-${index}.vtt`); fs.writeFileSync(track.file, toVtt(track.cues)); });
      let embedded = false, note = null;
      if (mode === 'embed' || mode === 'both') {
        if (!canEmbed(video)) note = 'Bu dosya türüne altyazı gömülemedi; altyazılar yan dosya olarak kaydedildi.';
        else { try { const finished = await embedSubtitles({ video, tracks: found, toolsDirectory: this.toolsDirectory, signal: combined, preferred: this.subtitleLanguage(), container: this.settings.subtitleContainer }); embedded = Boolean(finished); if (finished && finished !== video) { video = finished; job.file = path.basename(finished); } } catch { embedded = false; } if (!embedded) note = 'Altyazılar videoya gömülemedi (videoda zaten altyazı olabilir); yan dosya olarak kaydedildi.'; }
      }
      // 'both': the file carries every track, and the leading (default) one is also written next to it: players such as Windows Media Player
      // and Films & TV ignore tracks inside an mp4 but load a same-named .srt on their own (VLC does too).
      const files = embedded ? (mode === 'both' && lead >= 0 ? writeSidecars(video, found.slice(0, 1)) : []) : writeSidecars(video, found);
      job.subtitleResult = { mode: embedded ? (files.length ? 'embedded+sidecar' : 'embedded') : 'sidecar', tracks: found.map(track => ({ name: track.name, lang: track.iso1 || track.iso3, default: track.default })), files, note, ...(encodingSuspect ? { encodingNote: true } : {}) };
      job.subtitlePending = undefined;
    } catch (error) {
      if (!signal.aborted) job.subtitleResult = { mode: 'none', note: 'Altyazı eklenirken sorun oluştu; video indirildi.' };
    } finally {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* temp copies only */ }
      delete job.subtitlePending;
    }
  }

  // ---- Series / playlist: list the videos of one address, then queue the chosen ones (never started all at once) ----
  async playlist(input = {}, signal = AbortSignal.timeout(90000)) {
    const url = parseRemoteUrl(input.url).href;
    if (!this.capabilities().ytDlp) throw new Error('Liste için önce yt-dlp kurulmalı. Kurulum adımlarına bak.');
    const list = await this.playlistLister({ url, toolsDirectory: this.toolsDirectory, headers: mediaHeaders(input), signal });
    return { title: list.title, more: list.more === true, entries: list.entries.map(entry => ({ ...entry, duplicate: this.findDuplicates({ url: entry.url }).length > 0, name: episodeName(list.title, entry.title, entry.index, list.entries.length) })) };
  }
  addPlaylist(input = {}) {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (!entries.length || entries.length > MAX_PLAYLIST) throw new Error(`Listeden 1–${MAX_PLAYLIST} video seç.`);
    const series = safeTitle(String(input.title || 'Liste')), ids = [], listSize = Number.isInteger(input.total) && input.total >= entries.length && input.total <= 100000 ? input.total : entries.length; let skipped = 0, failed = 0, full = false;
    for (const [at, entry] of entries.entries()) {
      try {
        const url = parseRemoteUrl(entry?.url).href;
        if (input.allowDuplicates !== true && this.findDuplicates({ url }).length) { skipped++; continue; }
        ids.push(this.add({ url, engine: 'extractor', start: 'queue', quality: 'best', seriesTitle: series, title: episodeName(series, String(entry.title || ''), Number(entry.index) || at + 1, listSize), referer: typeof input.url === 'string' ? input.url : undefined, pageUrl: typeof input.url === 'string' ? input.url : undefined }));
      } catch (error) { failed++; if (/sınırı/.test(error.message)) { full = true; break; } }
    }
    return { added: ids.length, skipped, failed, full, ids };
  }

  // ---- Files taken over from the browser's own download ----
  // First look at the file (headers only, a few seconds), always with the address the browser was downloading. Servers that refuse
  // byte ranges are still fine: one connection is used. Nothing is created unless the file is really reachable.
  async probeFile(url, headers, signal) {
    try {
      const probe = await probeRange({ url, headers, signal, request: this.rangeRequest });
      return { url: probe.url, total: probe.total, contentType: probe.contentType, disposition: probe.disposition || '', ranges: true, raw: probe };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof SourceExpiredError) throw Object.assign(new Error('Sunucu erişimi reddetti (giriş veya izin gerekebilir).'), { code: 'ACCESS_DENIED' });
      if (!(error instanceof RangeUnsupportedError)) throw error;
      // The server answered the range request with the whole file (200): its headers already tell what the file is.
      const seen = error.observed;
      const length = Number(seen?.headers?.['content-length']);
      if (seen?.status === 200 && Number.isSafeInteger(length) && length > 0) { // without a length the plain request below tells more
        return { url: seen.url, total: Number.isSafeInteger(length) && length > 0 ? length : null, contentType: String(seen.headers['content-type'] || ''), disposition: String(seen.headers['content-disposition'] || ''), ranges: false };
      }
    }
    const { response, url: finalUrl } = await this.remoteOpener(url, signal, 0, headers);
    try {
      const status = response.statusCode;
      if (status && (status < 200 || status >= 300)) throw Object.assign(new Error(status === 401 || status === 403 ? 'Sunucu erişimi reddetti (giriş veya izin gerekebilir).' : `Sunucu HTTP ${status} yanıtı verdi.`), { code: [401, 403].includes(status) ? 'ACCESS_DENIED' : 'HTTP_ERROR' });
      const length = Number(response.headers['content-length']);
      return { url: String(finalUrl?.href || finalUrl || url), total: Number.isSafeInteger(length) && length > 0 ? length : null, contentType: String(response.headers['content-type'] || ''), disposition: String(response.headers['content-disposition'] || ''), ranges: false };
    } finally { response.destroy(); }
  }

  async takeFile(input = {}) {
    const url = parseRemoteUrl(input.url).href;
    let referer; try { referer = input.referer ? parseRemoteUrl(input.referer).href : undefined; } catch { referer = undefined; }
    const cookies = sanitizeCookies(input.cookies, [url, referer]);
    const headers = withCookie(mediaHeaders({ userAgent: input.userAgent, referer }), cookies, url);
    const start = input.start === 'queue' ? 'queue' : 'now';
    if (input.allowDuplicate !== true) {
      const found = this.findDuplicates({ url });
      if (found.length) throw Object.assign(new Error('Bu dosya zaten listede.'), { code: 'duplicate', duplicates: found.map(item => ({ title: item.title, status: item.status })) });
    }
    const probe = await this.probeFile(url, headers, AbortSignal.timeout(12000));
    if (/text\/html/i.test(probe.contentType)) throw Object.assign(new Error('Bağlantı dosya yerine bir web sayfası döndürdü.'), { code: 'NOT_A_FILE' });
    if (isManifest(probe.contentType, probe.url) || isManifest('', url)) throw Object.assign(new Error('Bu bağlantı bir akış listesi; video olarak yakalanmalı.'), { code: 'NOT_A_FILE' });
    const name = fileNameFor({ hint: typeof input.fileName === 'string' ? input.fileName : '', disposition: probe.disposition, url: probe.url, contentType: probe.contentType });
    // The cookies live in memory only, for this job, exactly like the ones of a video the user picked.
    this.rememberOffered(url, [], cookies);
    // The job that starts a moment from now would look at the same source again; hand it this fresh look instead (memory only,
    // short-lived, consumed once) so the first byte does not wait for a second round trip.
    // A source without byte ranges is remembered as such, so the job goes straight to its single connection.
    this.probeSeeds ??= new Map();
    for (const [key, seed] of this.probeSeeds) if (Date.now() - seed.at > 30000) this.probeSeeds.delete(key);
    this.probeSeeds.set(url, { probe: probe.raw || null, at: Date.now() });
    const id = this.add({ url, engine: 'direct', fileMode: true, fileName: name, referer, userAgent: input.userAgent, pageUrl: referer, start, submissionId: input.submissionId, quality: 'best' });
    const job = this.jobs.find(item => item.id === id);
    return { id, name, total: probe.total, ranges: probe.ranges, category: categoryFor(name, probe.contentType), risk: riskOf(name), directory: job?.directory || this.currentDirectory(), queued: start === 'queue' };
  }

  // Same source and same chosen quality as a job that is still wanted. Never changes or removes anything.
  findDuplicates(input = {}) {
    let url; try { url = parseRemoteUrl(input.url).href; } catch { return []; }
    const formatId = typeof input.formatId === 'string' && input.formatId ? input.formatId : null;
    const audioTrack = typeof input.audioTrack === 'string' && input.audioTrack ? input.audioTrack : null; // another sound is another download
    return this.jobs.filter(job => job.url === url && (job.formatId || null) === formatId && (job.audioTrack || null) === audioTrack && ['running', 'queued', 'held', 'paused', 'interrupted', 'completed'].includes(job.status))
      .slice(-5).map(job => ({ id: job.id, title: job.title, status: job.status, formatLabel: job.formatLabel || null, file: job.file || null }));
  }

  // Which of a master's sounds is the page's player fetching right now? The newest request that belongs to one of the sounds' own
  // lists says so: requests are compared with the addresses of each list's pieces (never by folder or name). Addresses sent by the
  // extension are only compared and forgotten. Unknown is a valid answer; the user then chooses.
  async activeAudio(input = {}) {
    const url = parseRemoteUrl(input.url).href;
    const offered = this.offered.get(url), choices = audioChoices(offered?.raw);
    if (!choices.length) return { active: null };
    const tracks = offered.raw.audioTracks.filter(track => choices.some(choice => choice.id === track.id));
    const normal = value => { try { const parsed = new URL(value); return /^https?:$/.test(parsed.protocol) ? parsed.href : null; } catch { return null; } };
    const recent = (Array.isArray(input.recent) ? input.recent : []).slice(-200).map(item => ({ url: normal(item?.url), at: Number(item?.at) || 0 })).filter(item => item.url);
    if (!recent.length) return { active: null };
    const headers = mediaHeaders(input), cookies = offered.cookies || [];
    const request = (target, signal, extra = {}) => this.rangeRequest(target, signal, withCookie({ ...headers, ...extra }, cookies, target));
    this.audioLists ??= new Map();
    const pieces = new Map();
    await Promise.all(tracks.map(async track => {
      const known = this.audioLists.get(track.url);
      if (known && Date.now() - known.at < 600000) { pieces.set(track.id, known.set); return; }
      try {
        const playlist = await readHls({ url: track.url, headers, signal: AbortSignal.timeout(8000), request });
        const set = new Set([...(playlist?.map ? [playlist.map] : []), ...(playlist?.segments || []).map(segment => segment.url)]);
        this.audioLists.set(track.url, { at: Date.now(), set }); pieces.set(track.id, set);
        while (this.audioLists.size > 40) this.audioLists.delete(this.audioLists.keys().next().value);
      } catch { /* this sound cannot be read right now: it takes no part */ }
    }));
    for (const item of [...recent].sort((a, b) => b.at - a.at)) for (const [id, set] of pieces) if (set.has(item.url)) return { active: id };
    return { active: null };
  }

  submissionStatus(id) {
    const record = this.findSubmission(id);
    if (record?.abandoned) return { known: false, abandoned: true };
    return record ? { known: true, id: record.id, listed: this.jobs.some(job => job.id === record.id) } : { known: false };
  }

  findSubmission(id, fingerprint) {
    id = submissionId(id);
    let record = this.submissions.find(id, fingerprint);
    if (id && !record) {
      const job = this.jobs.find(job => job.submissionId === id);
      if (job) {
        this.save();
        record = { submissionId: id, fingerprint: job.submissionFingerprint, id: job.id };
        this.submissions.remember(record);
        this.submissions.find(id, fingerprint);
      }
    }
    return record;
  }

  abandonSubmission(id) {
    id = submissionId(id);
    if (!id) throw new Error('Gönderim kimliği gerekli.');
    const status = this.submissionStatus(id);
    if (status.known) return status; // Never cancel or restart an already-created job.
    this.submissions.remember({ submissionId: id, abandoned: true });
    return { known: false, abandoned: true };
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.jobs, null, 2));
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  cancel(id) {
    return this.singleAction('cancel', id);
  }

  retry(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status) || this.active.has(id)) throw new Error('Bu indirme şu anda yeniden başlatılamaz.');
    if (['parallel-http', 'parallel-streams'].includes(job.transfer?.method) && job.transfer.networkBytes > 0 && job.transfer.elapsedSeconds > 0) {
      job.transferHistory = [...(job.transferHistory || []).slice(-9), { networkBytes: job.transfer.networkBytes, elapsedSeconds: job.transfer.elapsedSeconds }];
    }
    job.notice = null;
    job.status = 'queued'; job.resumeRequested = false; job.error = null; job.received = 0; job.speed = 0; job.total = null;
    this.save(); this.pump();
  }

   // One global scheduler: every entry point shares the same limit and persisted row priority.
   // An aborted worker still owns a slot until its finally block releases it. Never launch a replacement early.
  pump() {
    if (this.stopping) return;
    const limit = Math.min(this.concurrency, this.settings.queueLimit === 'all' ? Infinity : this.settings.queueLimit);
    const ready = this.jobs.filter(job => ['running', 'queued'].includes(job.status) ||
      (job.status === 'paused' && job.resumeRequested) ||
      (job.status === 'held' && this.queueRunning && (job.queueName || 'Genel') === this.runningQueue));
    const desired = new Set(ready.slice(0, limit));
    let changed = false;
    for (const job of this.jobs) {
      if (job.status !== 'running' || desired.has(job) || !this.active.has(job.id)) continue;
      // Capacity/priority pause is not a manual pause: stay ready for automatic continuation.
      job.status = 'queued'; job.speed = 0; job.resumeRequested = false;
      this.meter(job).stage('pausing'); this.active.get(job.id).abort(); changed = true;
    }
    for (const job of desired) {
      if (this.active.has(job.id) || job.status === 'running') continue;
      if (this.active.size >= limit) break;
      if (job.status === 'held') job.viaQueue = true;
      job.resumeRequested = false; this.launch(job); changed = true;
    }
    if (this.queueRunning && !this.heldJobs(this.runningQueue).length) { this.queueRunning = false; this.runningQueue = null; }
    if (changed) this.save();
  }

  heldJobs(name = this.settings.selectedQueue) { return this.jobs.filter(job => job.status === 'held' && (job.queueName || 'Genel') === name); } // in list order

  queueInfo() {
    return { running: this.queueRunning, limit: this.settings.queueLimit, waiting: this.jobs.filter(job => job.status === 'queued' || (job.status === 'paused' && job.resumeRequested)).length, held: this.heldJobs(this.settings.selectedQueue).length, selectedQueue: this.settings.selectedQueue, runningQueue: this.runningQueue, queueNames: this.settings.queueNames, speedLimitKiB: this.settings.speedLimitKiB };
  }

  setSettings(input = {}) {
    const next = { ...this.settings };
    if (input.addQueue !== undefined) {
      if (typeof input.addQueue !== 'string' || !input.addQueue.trim() || input.addQueue.trim().length > 40 || /[\x00-\x1f]/.test(input.addQueue) || next.queueNames.length >= 20) throw new Error('Kuyruk adı 1–40 karakter olmalı (en fazla 20 kuyruk).');
      next.queueNames = [...new Set([...next.queueNames, input.addQueue.trim()])];
      next.selectedQueue = input.addQueue.trim();
    }
    if (input.selectedQueue !== undefined) {
      if (!next.queueNames.includes(input.selectedQueue)) throw new Error('Kuyruk bulunamadı.');
      next.selectedQueue = input.selectedQueue;
    }
    if (input.speedLimitKiB !== undefined) {
      if (!Number.isInteger(input.speedLimitKiB) || input.speedLimitKiB < 0 || input.speedLimitKiB > 1048576) throw new Error('Hız sınırı 0–1048576 KiB/sn olmalı.');
      next.speedLimitKiB = input.speedLimitKiB;
    }
    if (input.queueLimit !== undefined) {
      if (input.queueLimit !== 'all' && (!Number.isInteger(input.queueLimit) || input.queueLimit < 1 || input.queueLimit > 6)) throw new Error('Aynı anda indirme sayısı 1 ile 6 arasında ya da Hepsi olmalı.');
      next.queueLimit = input.queueLimit;
    }
    for (const [key, check] of Object.entries(SETTING_CHECKS)) {
      if (input[key] === undefined) continue;
      const verdict = check(input[key]);
      if (verdict !== true) throw new Error(verdict);
      next[key] = key === 'downloadDirectory' && input[key] !== null ? path.resolve(input[key]) : input[key];
    }
    if (input.downloadDirectory) usableDirectory(next.downloadDirectory);
    this.settings = next;
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(`${this.settingsFile}.tmp`, JSON.stringify({ ...next, settingsVersion: 2 }, null, 2)); fs.renameSync(`${this.settingsFile}.tmp`, this.settingsFile);
    if (input.speedLimitKiB !== undefined) this.applySpeedLimit();
    if (!Object.keys(input).length || !Object.keys(input).every(key => VISUAL_SETTINGS.includes(key))) this.pump();
    return { ...next };
  }

  // A new speed limit reaches downloads that are already running, not only the ones that start later.
  // The program's own engines read the rate live. A yt-dlp process only learns its limit when it starts and cannot continue
  // its partial data safely, so restarting it just to change the limit would throw the finished part away: that job says so
  // instead, and takes the new limit the next time it starts.
  applySpeedLimit() {
    const kib = this.settings.speedLimitKiB;
    const later = 'Yeni hız sınırı bu indirme yeniden başlayınca uygulanır (bu motor sınırı yalnız başlarken alır).';
    for (const job of this.jobs) {
      if (job.status !== 'running' || !this.active.has(job.id) || job.speedLimitKiB === kib) continue;
      if (job.transfer?.method === 'yt-dlp') { if (!String(job.notice || '').includes(later)) job.notice = [job.notice, later].filter(Boolean).join(' '); continue; }
      job.speedLimitKiB = kib;
      this.limiters.get(job.id)?.setRate(kib * 1024);
    }
  }

  startQueue(name = this.settings.selectedQueue) {
    if (!this.settings.queueNames.includes(name)) throw new Error('Kuyruk bulunamadı.');
    if (this.queueRunning && this.runningQueue !== name) throw new Error('Önce çalışan kuyruğu durdur.');
    this.runningQueue = name; this.queueRunning = this.heldJobs(name).length > 0; this.pump(); return this.queueInfo();
  }
  stopQueue() { this.queueRunning = false; this.runningQueue = null; return this.queueInfo(); } // running downloads continue; nothing new starts from the queue

  startNow(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== 'held') throw new Error('Bu indirme sırada değil.');
    job.status = 'queued'; job.viaQueue = false;
    this.save(); this.pump();
    return { ok: true };
  }

  reorder(ids) {
    if (!Array.isArray(ids) || ids.length > 500) throw new Error('Geçersiz sıra listesi.');
    const selected = this.validateIds(ids), byId = new Map(this.jobs.map(job => [job.id, job]));
    if (selected.size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('Sıralanacak indirmeler değişti; listeyi yenile.');
    this.jobs = [...ids.map(id => byId.get(id)), ...this.jobs.filter(job => !selected.has(job.id))];
    this.save(); this.pump();
    return { ok: true };
  }

  launch(job) {
    job.speedLimitKiB = this.settings.speedLimitKiB;
    this.limiters.set(job.id, rateLimiter(job.speedLimitKiB * 1024));
    const controller = new AbortController();
    this.active.set(job.id, controller);
    job.status = 'running';
    this.meter(job).reset();
    this.meter(job).stage('resolving');
    job.measuredNetworkBytes = 0; job.speedReference = null; job.measurementKey = null;
    job.startedAt = new Date().toISOString();
    this.observedTransfers.delete(job);
    this.run(job, controller.signal).then(async () => {
      if (job.status === 'running') {
        const seconds = this.meter(job).snapshot(job, jobPhase(job)).phaseSeconds.downloading || 0;
        if (job.measurementKey && !job.sourceRefreshes && job.measuredNetworkBytes > 0 && seconds > 0) job.speedReference = { key: job.measurementKey, networkBytes: job.measuredNetworkBytes, seconds, at: Date.now() };
        this.finalizeName(job);
        if (job.kind === 'file' && job.file) markFromInternet(path.join(this.dirOf(job), job.file));
        await this.attachSubtitles(job, controller.signal);
      }
      if (job.status === 'running') {
        job.status = 'completed'; job.completedAt = new Date().toISOString(); this.dropSession(job);
        try { this.archiveCompleted([job]); }
        catch { job.notice = [job.notice, 'Geçmiş kaydı yazılamadı; indirme kaydı listede korunuyor.'].filter(Boolean).join(' '); }
      }
    }).catch(error => {
      if (job.status !== 'running') return;
      // The user never sees "try again": a transient failure is retried by the program itself (twice at most, each time from a fresh
      // resolve). Only a problem that retrying cannot fix (DRM, private/removed video, full disk, unsupported) is shown as failed.
      const fatal = error instanceof RemoteResponseError || /DRM|desteklenm|geçersiz|bulunamad|Seçtiğin kalite|yetki|ENOSPC|EACCES|EPERM|private|unavailable|not available|Sign in|copyright|removed|404|değişti/i.test(`${error.code || ''} ${error.message}`);
      if (!fatal && !this.stopping && (job.autoRetries || 0) < this.settings.autoRetries) { job.autoRetries = (job.autoRetries || 0) + 1; recordRecovery(job, 'automatic-retry', { attempt: job.autoRetries }); job.status = 'queued'; job.error = null; job.speed = 0; return; }
      job.status = 'failed'; job.error = error.message;
    }).finally(() => {
      job.speed = 0;
      this.meter(job).stage(jobPhase(job));
      this.active.delete(job.id);
      this.limiters.delete(job.id);
      if (job.status === 'paused' && job.resumeRequested && !this.stopping) {
        job.resumeRequested = false; job.status = 'queued';
      }
      this.save(); this.pump();
    });
  }

  async run(job, signal) {
    job.sourceRefreshes = 0;
    job.file = null; job.media = null; job.verification = null;
    for (let attempt = 0; ; attempt++) {
      try { return await this.runAttempt(job, signal); }
      catch (error) {
        if (signal.aborted || attempt >= 1 || !(error instanceof SourceChangedError || (error instanceof SourceExpiredError && job.engine === 'extractor'))) throw error;
        job.sourceRefreshes++; job.speed = 0;
        recordRecovery(job, 'source-refresh', { attempt: job.sourceRefreshes });
        if (error instanceof SourceExpiredError && this.sessions.get(job.id)?.length) this.cookieless.add(job.id);
      }
    }
  }

  async probeSource(url, headers, signal, job) {
    const started = performance.now();
    return recoverRead(async parent => {
      // The first look at a source must be quick: a source that does not answer within 10 s is treated as stalled right away
      // (the caller then switches to another way) instead of making the user wait for the 30 s socket timeout.
      const quick = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
      try { return await probeRange({ url, headers, signal: quick, request: this.rangeRequest }); }
      catch (error) {
        parent.throwIfAborted();
        if (quick.aborted) throw new NetworkStallError('Kaynak 10 saniye içinde yanıt vermedi.');
        throw error;
      }
    }, { signal, maxElapsedMs: 25000, onRetry: detail => {
      if (job) recordRecovery(job, 'probe-retry', { ...detail, elapsedMs: performance.now() - started });
      if ([429, 503].includes(detail.status)) this.budget.cooldown(new URL(url).hostname, detail.delayMs);
    } });
  }

  // Work file name: files taken over from the browser keep their real name, everything else gets "<id>-<title>.<ext>".
  outputName(job, url, contentType) {
    return job.kind === 'file' && job.fileName ? `${job.id}-${job.fileName}` : `${job.id}-${safeTitle(job.title)}.${safeExtension(url, contentType)}`;
  }

  async verifyOutput(job, file, expectedSize, media, signal) {
    this.phase(job, 'verifying');
    job.verification = { status: 'running', level: job.deepVerify ? 'deep-media' : media ? 'media' : 'bytes' };
    try {
      const result = await verifyCompletedFile({ file, expectedSize, media, expectedSha256: job.expectedSha256, deep: job.deepVerify, toolsDirectory: this.toolsDirectory, signal,
        probe: this.mediaVerifier, decoder: this.deepVerifier,
        onDeep: () => this.phase(job, 'deep-verifying')
      });
      // Plain files: the bytes must also look like what the name says (a login page saved as ".zip" is not a finished download).
      if (job.kind === 'file' && !media) {
        const format = await verifyFileFormat(file, job.fileName, { sizeCompared: result.sizeCompared });
        if (format.format) { result.level = 'format'; result.format = format.format; }
        if (format.note) result.warning = [result.warning, format.note].filter(Boolean).join(' ');
      }
      job.verification = { ...result, media: undefined };
      if (result.media) job.media = result.media;
      if (result.warning) job.notice = [job.notice, result.warning].filter(Boolean).join(' ');
      return result;
    } catch (error) {
      job.verification = { status: signal.aborted ? 'paused' : 'failed', error: cleanMediaError(error.message) }; throw error;
    }
  }

  async runAttempt(job, signal) {
    if (job.engine === 'extractor') return this.extract(job, signal);
    job.notice = null;
    job.transfer = { method: 'auto', phase: 'probing', connections: 0 };
    this.phase(job, 'probing');
    try {
      let seed = job.kind === 'file' ? this.probeSeeds?.get(job.url) : null; this.probeSeeds?.delete(job.url);
      if (seed && Date.now() - seed.at >= 30000) seed = null;
      if (seed && !seed.probe) throw new RangeUnsupportedError('Kaynak byte-range indirmeyi desteklemiyor.'); // the takeover already asked
      const probe = seed ? seed.probe : await this.probeSource(job.url, this.requestHeaders(job, job.url), signal);
      job.measurementKey = sourceMeasureKey([{ url: probe.url, protocol: 'https' }]);
      if (isManifest(probe.contentType, probe.url)) return this.routeManifest(job, signal);
      if (/text\/html/i.test(probe.contentType)) throw new RangeUnsupportedError('Kaynak dosya yerine HTML sayfası döndürdü.');
      const filename = this.outputName(job, probe.url, probe.contentType);
      const isVideo = isVideoFile(filename, probe.contentType);
      const result = await downloadParallel({
        throttle: this.limiters.get(job.id), connections: this.settings.maxConnections,
        url: job.url, headers: this.requestHeaders(job, job.url), sourceProbe: probe, signal, request: this.rangeRequest,
        sourceKey: createHash('sha256').update(`${job.url}|direct`).digest('hex'),
        destination: path.join(this.dirOf(job), filename),
        onThrottle: (host, ms) => this.budget.cooldown(host, ms),
        onProgress: progress => this.updateTransfer(job, progress),
        verify: async (file, verifySignal) => {
          await this.verifyOutput(job, file, probe.total, isVideo ? { requireVideo: true, requireAudio: false } : null, verifySignal);
        }
      });
      job.file = filename; this.completeTransfer(job, result);
      return;
    } catch (error) {
      if (signal.aborted || !(error instanceof RangeUnsupportedError)) throw error;
      job.notice = `${cleanMediaError(error.message)} Tek bağlantılı dosya motoru kullanılıyor.`;
    }
    return this.directSequential(job, signal);
  }

  updateTransfer(job, progress, method = 'parallel-http') {
    if (job.status !== 'running') return;
    job.received = progress.received; job.total = progress.total; job.speed = progress.speed;
    job.sizeKind = progress.total > 0 ? progress.sizeKind || (method === 'parallel-streams' ? 'approx' : 'exact') : 'unknown';
    job.transfer = { method, ...progress };
    this.measure(job, progress.networkBytes ?? progress.received);
  }

  routeManifest(job, signal) {
    signal.throwIfAborted();
    if (!this.capabilities().ytDlp) throw new Error('Akış/manifest indirmesi için yt-dlp kurulmalı.');
    job.engine = 'extractor';
    return this.extract(job, signal);
  }

  completeTransfer(job, result, method = 'parallel-http') {
    job.received = result.total; job.total = result.total;
    job.sizeKind = 'exact';
    const phaseSeconds = this.meter(job).snapshot(job, jobPhase(job)).phaseSeconds;
    const attemptSeconds = phaseSeconds.downloading || result.elapsedSeconds;
    const elapsedSeconds = attemptSeconds + (job.transferHistory || []).reduce((sum, p) => sum + p.elapsedSeconds, 0);
    const cumulativeNetworkBytes = result.networkBytes + (job.transferHistory || []).reduce((sum, p) => sum + p.networkBytes, 0);
    job.transfer = { method, phase: 'completed', ...result, attemptElapsedSeconds: attemptSeconds, elapsedSeconds, cumulativeNetworkBytes, averageSpeed: cumulativeNetworkBytes / Math.max(elapsedSeconds, 0.001) };
  }

  async directSequential(job, signal) {
    job.transfer = { method: 'single-http', phase: 'downloading', connections: 1 };
    this.phase(job, 'downloading');
    const { response, url } = await this.remoteOpener(job.url, signal, 0, this.requestHeaders(job, job.url, job.headers || {}));
    job.measurementKey = sourceMeasureKey([{ url: url.href, protocol: 'https' }]);
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (isManifest(contentType, url.href)) {
      response.destroy(); return this.routeManifest(job, signal);
    }
    if (contentType.includes('text/html')) {
      response.destroy();
      throw new Error('Bu bağlantı bir sayfa veya akış listesi; akış/site motoruyla yeniden ekle.');
    }
    const filename = this.outputName(job, url.href, contentType);
    const destination = path.join(this.dirOf(job), filename);
    const partial = `${destination}.part`;
    if (fs.existsSync(partial)) {
      fs.renameSync(partial, `${partial}.previous-${Date.now()}`);
      job.notice = 'Bu doğrudan dosya yeniden baştan indiriliyor; önceki parça korunuyor.';
    }
    job.received = 0;
    const total = Number(response.headers['content-length']);
    job.total = Number.isFinite(total) && total > 0 ? total : null;
    job.sizeKind = job.total ? 'exact' : 'unknown';
    this.measure(job, 0);
    const queue = this;
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      if (job.status !== 'running') return callback(new Error('Aktarım durduruldu.'));
      (queue.limiters.get(job.id)?.(chunk.length, signal) || Promise.resolve()).then(() => {
        job.received += chunk.length; queue.measure(job); callback(null, chunk);
      }, callback);
    }});
    try {
      await pipeline(response, progress, fs.createWriteStream(partial), { signal });
      signal.throwIfAborted();
      if (job.total && job.received !== job.total) throw new Error('Dosya eksik indirildi.');
      await this.verifyOutput(job, partial, job.total, isVideoFile(filename, contentType) ? { requireVideo: true, requireAudio: false } : null, signal);
      await publishFile(partial, destination, signal);
      job.file = filename; job.total = fs.statSync(destination).size;
      job.received = job.total; job.sizeKind = 'exact';
    } catch (error) {
      try { job.received = fs.statSync(partial).size; } catch { /* No bytes written. */ }
      throw error;
    }
  }

  async extract(job, signal) {
    signal.throwIfAborted();
    if (job.nativeHls) return this.extractHls(job, signal);
    const caps = this.capabilities();
    job.notice = null;
    job.transfer = { method: 'auto', phase: 'resolving', connections: 0 };
    this.phase(job, 'resolving');
    recordRecovery(job, 'resolve');
    let info;
    const jar = this.jarFor(job);
    const resolve = (formatId, cookieFile) => this.infoExtractor({ url: job.url, quality: job.quality, formatId, toolsDirectory: this.toolsDirectory, headers: job.headers, cookieFile, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
    // First attempt right after the quality list was shown: the resolver's answer is already in memory, so no second wait.
    const cached = !job.sourceRefreshes && !job.autoRetries ? this.cachedSelection(job) : null;
    try {
      try { info = cached ?? await resolve(job.formatId || null, jar); }
      catch (error) {
        if (!(job.formatId && !signal.aborted && /format bulunamad|not available/i.test(error.message))) throw error;
        // Format ids are not stable: they differ between resolver clients, cookies and moments. The user chose a PICTURE (size, frame
        // rate, HDR), so look for the same one under whatever id is offered now. Same size with another codec/container is fine;
        // a different size is never substituted: the user re-chooses then.
        const replacement = await this.findSameQuality(job, resolve, jar, signal);
        if (!replacement) throw new Error(`Seçtiğin kalite (${job.formatLabel || job.formatId}) kaynakta artık yok. Başka bir kaliteye otomatik geçilmedi; bağlantıyı yeniden incele ve kaliteyi tekrar seç.`);
        job.formatId = replacement.id; job.formatLabel = replacement.label;
        info = await resolve(replacement.id, jar);
      }
    } finally { removeCookieJar(jar); }
    if (job.title === 'video' && info.title) job.title = safeTitle(info.title);
    job.releaseYear ||= knownYear(info);
    const resolvedSources = info.requested_formats?.length ? info.requested_formats : [info];
    if (resolvedSources.length <= 2 && resolvedSources.every(source => /^m3u8/.test(source.protocol || ''))) return this.transferHls(job, info, signal);
    const plan = selectSourcePlan(info, { ...caps, ffprobe: fs.existsSync(path.join(this.toolsDirectory, 'ffprobe.exe')) });
    if (job.sourceSelection?.format && plan.selectedFormat && job.sourceSelection.format !== plan.selectedFormat) throw new SourceChangedError('Seçili format değişti; kaliteyi yeniden inceleyip onayla.');
    job.sourceSelection = { format: plan.selectedFormat, media: mediaExpectation(info) };
    this.phase(job, 'probing');
    if (plan.method !== 'yt-dlp') {
      recordRecovery(job, 'fast-selected');
      try { await this.transferSources(job, info, plan, signal); return; }
      catch (error) {
        if (signal.aborted) throw error;
        // The fast engine is only ONE way to get the file. When it is refused (403/401/410) even after a fresh resolve (and a
        // cookieless one), the resolver's own downloader still can: it knows the site's access tricks. Same quality, slower route.
        const refused = error instanceof SourceExpiredError && job.sourceRefreshes >= 1 && job.engine === 'extractor';
        // A server that goes silent or resets before the first byte (a CDN that dislikes our requests) is treated the same way.
        const silent = job.engine === 'extractor' && !(job.received > 0) && (error instanceof NetworkStallError || error.name === 'TimeoutError' || /ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR/i.test(`${error.code || ''} ${error.message}`));
        if (!(error instanceof RangeUnsupportedError) && !refused && !silent) throw error;
        job.notice = refused || silent ? 'Hızlı indirme yolu çalışmadı (site yanıt vermedi veya reddetti); aynı kalite standart medya motoruyla indiriliyor (daha yavaş olabilir).' : `${cleanMediaError(error.message)} Seçili format standart medya motoruyla indiriliyor.`;
        recordRecovery(job, 'native-selected', { reason: refused ? 'source-refused' : silent ? 'network' : 'range' });
      }
    } else { job.notice = plan.reason; recordRecovery(job, 'native-selected', { reason: 'protocol' }); }
    return this.extractNative(job, signal, plan.selectedFormat, info);
  }

  async extractHls(job, signal) {
    if (!this.capabilities().ffmpeg) throw new Error('HLS indirmek için FFmpeg gerekli.');
    this.phase(job, 'resolving');
    // Re-read the master after restart or source refusal; validate the picture before using the new addresses.
    if (!this.offered.get(job.url)?.raw || job.sourceRefreshes || job.autoRetries) {
      if (job.sourceRefreshes || job.autoRetries) this.hlsInspections.clear();
      const input = { url: job.url, title: job.title, referer: job.headers.Referer, userAgent: job.headers['User-Agent'] };
      let view = await this.inspectHls(input, this.jobCookies(job), signal);
      if (job.formatSlot && !view.options.length && view.inspectionPending) {
        await [...this.hlsInspections.values()].find(e => e.raw === this.offered.get(job.url)?.raw)?.work;
        view = await this.inspectHls(input, this.jobCookies(job), signal);
      }
      const match = job.formatSlot && view.options.find(o => o.height === job.formatSlot.height && (o.fps >= 48 ? o.fps : null) === (job.formatSlot.fps >= 48 ? job.formatSlot.fps : null) && Boolean(o.hdr) === Boolean(job.formatSlot.hdr));
      if (job.formatId && !match) throw new Error('Seçtiğin HLS kalitesi artık sunulmuyor; başka kalite indirilmedi.');
      if (match) job.formatId = match.id;
      else if (!job.formatId && view.options.length) {
        const desired = job.quality === 'best' ? view.options[0] : view.options.find(o => o.height <= Number(job.quality)) || view.options.at(-1);
        job.formatId = desired.id; job.formatLabel = desired.label;
      }
    }
    const raw = this.offered.get(job.url)?.raw;
    const info = this.cachedSelection(job) || (raw?.formats?.length === 1 ? { ...raw, ...raw.formats[0] } : null);
    if (!info) throw new Error('HLS kalite listesini yeniden incele; varyant seçilmedi.');
    return this.transferHls(job, info, signal);
  }

  hlsEstimate(job, info) {
    const offered = this.offered.get(job.url), raw = offered?.raw;
    const latest = this.cachedSelection(job) || (raw?.formats?.length === 1 ? { ...raw, ...raw.formats[0] } : info);
    const companion = this.offered.get(job.audioUrl)?.raw;
    const audioBytes = sourceSize(companion?.formats?.find(s => s.vcodec === 'none') || companion, companion?.duration);
    if (audioBytes) job.audioEstimateBytes = audioBytes; // trusted measurement survives pause/restart, never taken from the POST body
    return hlsTotalEstimate({ offeredBytes: offered?.sizes?.get(job.formatId), savedBytes: job.estimateBytes, savedAudioBytes: job.audioEstimateBytes, info: latest,
      separateAudio: Boolean(job.audioUrl), companion });
  }

  async transferHls(job, info, signal) {
    if (!this.capabilities().ffmpeg) throw new Error('HLS indirmek için FFmpeg gerekli.');
    job.measurementKey = sourceMeasureKey(info.requested_formats?.length ? info.requested_formats : [info]);
    const sources = info.requested_formats?.length ? info.requested_formats : [info];
    if (job.audioUrl && sources.length === 1) sources.push({ url: job.audioUrl });
    this.phase(job, 'downloading');
    recordRecovery(job, 'hls-selected');
    const started = performance.now();
    const result = await downloadHls({ sources, directory: this.dirOf(job), toolsDirectory: this.toolsDirectory, signal,
      request: this.rangeRequest, headersFor: url => this.requestHeaders(job, url), spawn: this.processSpawner,
      connections: this.settings.maxConnections, throttle: this.limiters.get(job.id), stagingName: `hls-${job.id}`, // pieces survive a pause, a restart and a retry
      onPhase: phase => this.phase(job, phase),
      onRetry: detail => recordRecovery(job, 'hls-retry', detail),
      onProgress: (received, connections, metrics) => this.updateTransfer(job, { received, ...metrics, total: this.hlsEstimate(job, info), sizeKind: 'approx', speed: (metrics?.networkBytes ?? received) / Math.max(0.1, (performance.now() - started) / 1000), connections, phase: 'downloading', resumeSupported: true }, 'hls') });
    // A file that fails its check is never trusted again: the next attempt must fetch its pieces afresh.
    try { await this.verifyOutput(job, result.output, null, { ...mediaExpectation(info), requireAudio: true }, signal); }
    catch (error) { if (!signal.aborted) fs.rmSync(result.staging, { recursive: true, force: true }); throw error; }
    const filename = `${job.id}-${safeTitle(job.title)}.mp4`;
    await publishFile(result.output, path.join(this.dirOf(job), filename), signal);
    job.file = filename; job.total = fs.statSync(path.join(this.dirOf(job), filename)).size; job.received = job.total; job.sizeKind = 'exact';
    // Only this successful attempt's private staging directory is removed. Failed attempts remain available.
    fs.rmSync(result.staging, { recursive: true });
  }

  async findSameQuality(job, resolve, jar, signal) {
    // Jobs created before slots were stored carry only the label ("1440p60 · WEBM · VP9"): read the picture from it.
    const fromLabel = /^(\d{3,4})p(\d{2,3})?( HDR)?(?: · ([A-Z0-9]+))?(?: · ([A-Za-z0-9.]+))?/.exec(job.formatLabel || '');
    const slot = job.formatSlot || (fromLabel ? { height: Number(fromLabel[1]), fps: fromLabel[2] ? Number(fromLabel[2]) : null, hdr: Boolean(fromLabel[3]), ext: fromLabel[4]?.toLowerCase(), codec: fromLabel[5] } : null);
    if (!slot?.height) return null;
    let current;
    try { current = await resolve(null, jar); } catch { return null; }
    if (signal.aborted) return null;
    const { options } = buildQualityOptions(current, { ffmpeg: fs.existsSync(path.join(this.toolsDirectory, 'ffmpeg.exe')) });
    const rate = fps => (fps >= 48 ? fps : null); // like the labels: only high frame rates tell qualities apart
    const same = options.filter(option => option.height === slot.height && rate(option.fps) === rate(slot.fps) && Boolean(option.hdr) === Boolean(slot.hdr));
    // Prefer the very same container and codec, then the same container, then whatever the options order (container compatibility) says.
    return same.find(o => o.ext === slot.ext && o.codec === slot.codec) || same.find(o => o.ext === slot.ext) || same[0] || null;
  }

  async transferSources(job, info, plan, signal) {
    const sources = plan.sources;
    const maxConnections = this.settings.maxConnections;
    job.measurementKey = sourceMeasureKey(sources);
    const probes = [];
    const headers = sources.map(source => this.requestHeaders(job, source.url, sourceHeaders(source, info, job.headers)));
    for (let i = 0; i < sources.length; i++) {
      const probe = await this.probeSource(sources[i].url, headers[i], signal, job);
      if (/text\/html/i.test(probe.contentType) || isManifest(probe.contentType, probe.url)) throw new RangeUnsupportedError('Medya kaynağı tek dosya yerine sayfa veya manifest döndürdü.');
      probes.push(probe);
    }
    const filename = `${job.id}-${safeTitle(job.title)}.${plan.extension}`;
    const destination = path.join(this.dirOf(job), filename);
    const files = sources.map((source, index) => sources.length === 1 ? destination : path.join(this.dirOf(job), `${job.id}.stream-${index}.${source.ext}`));
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const started = performance.now();
    const states = probes.map(probe => ({ received: 0, total: probe.total, speed: 0, connections: 0, resumedBytes: 0, networkBytes: 0, splits: 0, reductions: 0, phase: 'waiting', resumeSupported: Boolean(probe.validator) }));
    let peakConnections = 0;
    const progress = (index, value) => {
      states[index] = value;
      const connections = states.reduce((sum, state) => sum + (state.phase === 'downloading' ? state.connections : 0), 0);
      peakConnections = Math.max(peakConnections, connections);
      this.updateTransfer(job, {
        received: states.reduce((sum, state) => sum + state.received, 0), total: probes.reduce((sum, probe) => sum + probe.total, 0),
        speed: states.reduce((sum, state) => sum + state.speed, 0), connections,
        resumedBytes: states.reduce((sum, state) => sum + state.resumedBytes, 0), networkBytes: states.reduce((sum, state) => sum + state.networkBytes, 0),
        resumeSupported: states.every(state => state.resumeSupported), phase: value.phase === 'checking-resume' && !states.some(s => s.phase === 'downloading') ? 'checking-resume' : value.phase === 'verifying' && sources.length === 1 ? 'verifying' : 'downloading',
        resumeReason: states.map(state => state.resumeReason).filter(Boolean).join(' ') || null, maxConnections,
        targetConnections: states.reduce((sum, state) => sum + (state.targetConnections || 0), 0),
        resumeChecked: states.reduce((sum, state) => sum + (state.resumeChecked || 0), 0), resumeTotal: states.reduce((sum, state) => sum + (state.resumeTotal || 0), 0),
        splits: states.reduce((sum, state) => sum + (state.splits || 0), 0), reductions: states.reduce((sum, state) => sum + (state.reductions || 0), 0),
        elapsedSeconds: (performance.now() - started) / 1000
      }, plan.method);
    };
    const downloadSource = (source, index) => downloadParallel({
      throttle: this.limiters.get(job.id),
      url: source.url, headers: headers[index], sourceProbe: probes[index], request: this.rangeRequest,
      sourceKey: createHash('sha256').update(`${job.url}|${source.format_id || 'single'}`).digest('hex'),
      destination: files[index], signal: combined, connections: Math.max(1, Math.floor(maxConnections / sources.length)),
      onThrottle: (host, ms) => this.budget.cooldown(host, ms),
      onProgress: value => progress(index, value),
      verify: async (file, verifySignal) => {
        if (sources.length === 1) await this.verifyOutput(job, file, probes[index].total, mediaExpectation(info), verifySignal);
      }
    }).catch(error => { controller.abort(error); throw error; });
    const outcomes = [];
    if (maxConnections === 1) {
      // Separate audio/video must also respect a one-connection limit.
      for (const [index, source] of sources.entries()) {
        try { outcomes.push({ status: 'fulfilled', value: await downloadSource(source, index) }); }
        catch (reason) { outcomes.push({ status: 'rejected', reason }); break; }
      }
    } else outcomes.push(...await Promise.allSettled(sources.map(downloadSource)));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw controller.signal.reason || failed.reason;
    signal.throwIfAborted();
    const results = outcomes.map(outcome => outcome.value);
    let publication = { reusedExisting: results[0].reusedExisting, sha256: results[0].sha256 };
    if (sources.length === 2) {
      this.phase(job, 'merging');
      const merged = path.join(this.dirOf(job), `${job.id}-${safeTitle(job.title)}.merge.part.${plan.extension}`);
      if (fs.existsSync(merged)) fs.renameSync(merged, `${merged}.previous-${randomUUID()}`);
      await this.mediaMerger(files, merged, this.toolsDirectory, signal);
      this.phase(job, 'verifying');
      await this.verifyOutput(job, merged, null, { ...mediaExpectation(info), requireVideo: true, requireAudio: true }, signal);
      publication = await publishFile(merged, destination, signal);
      // Delete only component files created by this attempt, never reused inputs.
      for (let i = 0; i < files.length; i++) if (!results[i].reusedExisting) fs.rmSync(files[i]);
    }
    job.file = filename;
    this.completeTransfer(job, {
      total: fs.statSync(destination).size, connections: peakConnections, maxConnections,
      resumedBytes: results.reduce((sum, result) => sum + result.resumedBytes, 0),
      networkBytes: results.reduce((sum, result) => sum + result.networkBytes, 0),
      resumeSupported: results.every(result => result.resumeSupported), resumeReason: results.map(r => r.resumeReason).filter(Boolean).join(' ') || null,
      splits: results.reduce((sum, r) => sum + r.splits, 0), reductions: results.reduce((sum, r) => sum + r.reductions, 0),
      elapsedSeconds: (performance.now() - started) / 1000, ...publication
    }, plan.method);
  }

  async extractNative(job, signal, selectedFormat = null, info = {}) {
    job.file = null;
    job.transfer = { method: 'yt-dlp', phase: 'waiting-connection', connections: 0 };
    this.phase(job, 'waiting-connection');
    const selectedSources = info.requested_formats?.length ? info.requested_formats : [info];
    job.measurementKey = sourceMeasureKey(selectedSources);
    const hosts = selectedSources.map(source => { try { return new URL(source.url).hostname; } catch { return null; } }).filter(Boolean);
    if (!hosts.length) hosts.push(new URL(job.url).hostname);
    const slots = job.speedLimitKiB ? 1 : Math.min(2, this.budget.perHost);
    const release = await this.budget.acquire(hosts, signal, slots);
    try { return await this.extractNativeStage(job, signal, selectedFormat, info, slots, release); }
    finally { release(); }
  }

  async extractNativeStage(job, signal, selectedFormat, info, slots, release) {
    const caps = this.capabilities();
    const staging = path.join(this.dirOf(job), `${job.id}.native-stage`);
    let stagedOutput = null;
    signal.throwIfAborted();
    // Native resumability cannot be independently proven for all manifests.
    // Preserve old stages rather than trusting an expired/changed source.
    if (fs.existsSync(staging)) {
      fs.renameSync(staging, `${staging}.previous-${randomUUID()}`);
      job.notice = [job.notice, 'Standart motorda güvenli devam doğrulanamadı; önceki veriler korunarak yeniden başlanıyor.'].filter(Boolean).join(' ');
    }
    fs.mkdirSync(staging);
    job.transfer = { method: 'yt-dlp', phase: 'downloading', connections: slots, resumeSupported: false };
    this.phase(job, 'downloading');
    const nativeProgress = new NativeProgress(info);
    Object.assign(job, nativeProgress.update(info.requested_formats?.[0]?.format_id ?? info.format_id, {}));
    this.measure(job, 0);
    const jar = this.jarFor(job);
    const args = [
      ...baseExtractorArgs(this.toolsDirectory, job.headers, jar),
      '--no-overwrites', '--no-continue', '--abort-on-unavailable-fragments', '--newline', '--progress', '--retries', '3', '--fragment-retries', '3', '--concurrent-fragments', String(slots), '--windows-filenames', '--no-mtime',
      '--progress-template', 'download:HYPERNAB_PROGRESS:{"formatId":%(info.format_id)j,"progress":%(progress)j}',
      '--progress-template', 'postprocess:HYPERNAB_POSTPROCESS:%(progress)j',
      '--print', 'before_dl:HYPERNAB_TITLE:%(title)j',
      '--print', 'after_move:HYPERNAB_FILE:%(filepath)j', '--no-simulate',
      '-f', selectedFormat || formatSelector(job.quality, caps.ffmpeg),
      '-o', path.join(staging, 'payload.%(ext)s')
    ];
    if (job.speedLimitKiB) args.push('--limit-rate', String(job.speedLimitKiB * 1024));
    args.push('--', job.url);
    await new Promise((resolve, reject) => {
      const child = this.processSpawner(path.join(this.toolsDirectory, 'yt-dlp.exe'), args, {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal
      });
      child.once('close', () => removeCookieJar(jar)); child.once('error', () => removeCookieJar(jar));
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stderr = '', buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('HYPERNAB_TITLE:')) {
            try { if (job.title === 'video') job.title = safeTitle(JSON.parse(line.slice('HYPERNAB_TITLE:'.length))); } catch { /* Non-JSON extractor title. */ }
          }
          if (line.startsWith('HYPERNAB_PROGRESS:')) {
            try {
              if (job.status !== 'running') continue;
              const payload = JSON.parse(line.slice('HYPERNAB_PROGRESS:'.length));
              const data = payload.progress || payload;
              this.phase(job, 'downloading');
              Object.assign(job, nativeProgress.update(payload.formatId, data));
              this.measure(job);
            } catch { /* Ignore unrelated extractor output. */ }
          }
          if (line.startsWith('HYPERNAB_POSTPROCESS:') && job.status === 'running') {
            try {
              const data = JSON.parse(line.slice('HYPERNAB_POSTPROCESS:'.length));
              this.phase(job, /merger/i.test(data.postprocessor || '') ? 'merging' : 'processing');
            } catch { /* Ignore malformed progress without inventing a processing stage. */ }
          }
          if (line.startsWith('HYPERNAB_FILE:')) {
            try {
              const output = path.resolve(JSON.parse(line.slice('HYPERNAB_FILE:'.length)));
              if (path.dirname(output) === path.resolve(staging) && /^payload\.[a-z0-9_-]{1,24}$/i.test(path.basename(output))) stagedOutput = output;
            } catch { /* Only accept a JSON path inside our output directory. */ }
          }
        }
        if (buffer.length > 65536) buffer = '';
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0 && stagedOutput && fs.existsSync(stagedOutput)) resolve();
        else {
          // Do not echo signed URLs, request headers or cookies into the UI.
          reject(new Error(cleanMediaError(stderr || `Medya motoru dosya üretemedi (kod ${code}).`)));
        }
      });
    });
    release();
    // Video and sound published as two separate playlists (no master): fetch the sound, then join them without re-encoding.
    if (job.audioUrl) stagedOutput = await this.attachCompanionAudio(job, signal, staging, stagedOutput);
    const size = fs.statSync(stagedOutput).size;
    job.received = size; job.total = size;
    job.sizeKind = 'exact';
    const expectedSize = !job.audioUrl && !info.requested_formats?.length && /^https?$/.test(info.protocol || '') && Number.isSafeInteger(info.filesize) ? info.filesize : null;
    await this.verifyOutput(job, stagedOutput, expectedSize, job.audioUrl ? { ...mediaExpectation(info), requireVideo: true, requireAudio: true } : mediaExpectation(info), signal);
    const extension = safeExtension(`https://output.invalid/${path.basename(stagedOutput)}`);
    const filename = `${job.id}-${safeTitle(job.title)}.${extension}`;
    await publishFile(stagedOutput, path.join(this.dirOf(job), filename), signal);
    job.file = filename; job.transfer.phase = 'completed';
    try { fs.rmdirSync(staging); } catch { /* Preserve any remaining native partials. */ }
  }

  // The sound playlist the page loaded next to a silent video playlist. Same guarded extractor, own output file, then a stream copy join.
  async attachCompanionAudio(job, signal, staging, videoFile) {
    this.phase(job, 'downloading');
    job.notice = [job.notice, 'Ses akışı ayrı indiriliyor ve videoyla birleştirilecek.'].filter(Boolean).join(' ');
    await this.remoteResolver(job.audioUrl);
    const args = [
      ...baseExtractorArgs(this.toolsDirectory, job.headers, null),
      '--no-overwrites', '--no-continue', '--abort-on-unavailable-fragments', '--newline', '--retries', '3', '--fragment-retries', '3', '--concurrent-fragments', '2', '--windows-filenames', '--no-mtime',
      '--print', 'after_move:HYPERNAB_FILE:%(filepath)j', '--no-simulate', '-f', 'best', '-o', path.join(staging, 'audio.%(ext)s')
    ];
    if (job.speedLimitKiB) args.push('--limit-rate', String(job.speedLimitKiB * 1024));
    args.push('--', job.audioUrl);
    const audioFile = await new Promise((resolve, reject) => {
      const child = this.processSpawner(path.join(this.toolsDirectory, 'yt-dlp.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stderr = '', buffer = '', output = null;
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) if (line.startsWith('HYPERNAB_FILE:')) {
          try { const file = path.resolve(JSON.parse(line.slice('HYPERNAB_FILE:'.length))); if (path.dirname(file) === path.resolve(staging) && /^audio\.[a-z0-9_-]{1,24}$/i.test(path.basename(file))) output = file; } catch { /* only our own output path counts */ }
        }
        if (buffer.length > 65536) buffer = '';
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
      child.on('error', reject);
      child.on('close', code => code === 0 && output && fs.existsSync(output) ? resolve(output) : reject(new Error(cleanMediaError(stderr || `Ses akışı indirilemedi (kod ${code}).`))));
    });
    this.phase(job, 'merging');
    const merged = path.join(staging, 'merged.mp4');
    await this.mediaMerger([videoFile, audioFile], merged, this.toolsDirectory, signal);
    return merged;
  }

  stop() {
    this.stopping = true;
    for (const job of this.jobs) job.resumeRequested = false;
    for (const job of this.jobs) if (['running', 'queued'].includes(job.status)) job.status = 'interrupted';
    for (const job of this.jobs) if (job.status === 'interrupted') { job.speed = 0; this.meter(job).stage('interrupted'); }
    for (const controller of this.active.values()) controller.abort();
    this.save();
    try { fs.rmSync(this.cookieDirectory, { recursive: true, force: true }); } catch { /* nothing to remove */ }
    this.history.close();
  }
}
