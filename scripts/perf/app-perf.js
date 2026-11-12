// Measures what the desktop app costs the computer: memory and CPU of its whole process tree in the tray, with the window open, with a long
// changing list, while scrolling, while downloading (one big file, four at once, an HLS video), how fast the window comes up, and the
// same with the graphics card left unused (--disable-gpu) and on two CPU cores. Isolated copy of the built app (own port, data, profile,
// download folder); the user's app and downloads are never touched. Downloads use public speed-test files and a public HLS test stream.
// Usage: node scripts/perf/app-perf.js [gpu] [nogpu] [twocores]   (default: all three; needs `npm run dist` first)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { freePort, browserUntil } from '../e2e/browser-driver.js';

const root = path.resolve(import.meta.dirname, '../..');
const exe = path.join(root, 'dist/win-unpacked/Hypernab.exe');
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['gpu', 'nogpu', 'twocores'];
const SAMPLE = Number(process.env.PERF_SECONDS || 20);
const BIG = process.env.PERF_BIG_URL || 'https://download.blender.org/release/Blender4.2/blender-4.2.0-windows-x64.zip';
const HLS = process.env.PERF_HLS_URL || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const report = {};

// The app's whole process tree (Electron parts, the engine, its tools) with private memory and CPU time.
function tree(rootPid) {
  const script = `$all = Get-CimInstance Win32_Process; $ids = @(${rootPid}); do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($ids.Count -ne $n);
    $out = foreach ($i in $ids) { $p = Get-Process -Id $i -ErrorAction SilentlyContinue; if (-not $p) { continue }; $c = ($all | Where-Object ProcessId -eq $i).CommandLine; $t = if ($c -match '--type=([\\w-]+)') { $Matches[1] } else { $p.ProcessName };
      [pscustomobject]@{ id = $i; type = $t; mb = [math]::Round($p.PrivateMemorySize64 / 1MB, 1); cpu = $p.TotalProcessorTime.TotalMilliseconds } }; @($out) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(result.stdout || '[]'); return Array.isArray(parsed) ? parsed : [parsed];
}
const CORES = Number(spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::ProcessorCount'], { encoding: 'utf8' }).stdout.trim());
// Memory at the end of the window; CPU as percent of ONE core (100 = one core fully busy) over the window.
async function sample(pid, seconds = SAMPLE, during = null) {
  const a = tree(pid), started = Date.now();
  const work = during ? during() : null;
  await wait(seconds * 1000); await work;
  const b = tree(pid), ms = Date.now() - started;
  const parts = {};
  for (const p of b) { const before = a.find(x => x.id === p.id); const cpu = before ? (p.cpu - before.cpu) / ms * 100 : 0; const key = p.type; parts[key] ??= { mb: 0, cpu: 0, n: 0 }; parts[key].mb += p.mb; parts[key].cpu += cpu; parts[key].n++; }
  for (const value of Object.values(parts)) { value.mb = +value.mb.toFixed(1); value.cpu = +value.cpu.toFixed(2); }
  return { totalMB: +b.reduce((s, p) => s + p.mb, 0).toFixed(1), cpuOneCore: +Object.values(parts).reduce((s, p) => s + p.cpu, 0).toFixed(2), parts };
}

function rpcClient(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url); let id = 0; const pending = new Map();
    socket.onerror = reject;
    socket.onmessage = event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
    socket.onopen = () => resolve({ socket, call: (method, params = {}) => new Promise((ok, fail) => { const n = ++id; pending.set(n, { resolve: ok, reject: fail }); socket.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.delete(n)) fail(new Error(method + ' timeout')); }, 60000); }) });
  });
}

async function launch(label, extra = []) {
  const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-appperf-'));
  const port = await freePort(), debug = await freePort(), inspector = await freePort();
  const env = { ...process.env, HYPERNAB_LOCALE: 'en-US', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads'), HD_DESKTOP_TEST: '1', HD_DESKTOP_PROFILE: path.join(dir, 'profile'), HD_WINDOW_DROP_MS: '5000' };
  const child = spawn(exe, ['--native-background', `--remote-debugging-port=${debug}`, `--inspect=${inspector}`, ...extra], { env, stdio: 'ignore' });
  await browserUntil(() => fs.existsSync(path.join(dir, 'data/pairing-token')), 30000);
  const token = fs.readFileSync(path.join(dir, 'data/pairing-token'), 'utf8').trim();
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  await call('/api/settings', { extensionPromptDone: true }).catch(() => {}); // no one-time welcome window in the measurement
  const main = await rpcClient((await browserUntil(async () => (await (await fetch(`http://127.0.0.1:${inspector}/json/list`)).json())[0], 30000)).webSocketDebuggerUrl);
  const mainEval = async expression => { const r = await main.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const electron = 'process.mainModule.require("electron")';
  const appWindow = `${electron}.BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('/tray.html'))`;
  const renderer = async () => {
    const target = await browserUntil(async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith(`http://127.0.0.1:${port}`) && !item.url.endsWith('/tray.html')), 30000);
    const r = await rpcClient(target.webSocketDebuggerUrl);
    const evaluate = async expression => { const x = await r.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value; };
    return { ...r, evaluate };
  };
  const stop = async () => {
    try { for (const job of await call('/api/jobs')) if (['queued', 'running', 'paused', 'held', 'interrupted'].includes(job.status)) await call(`/api/jobs/${job.id}/cancel`, {}).catch(() => {}); } catch { /* engine gone */ }
    for (const p of tree(child.pid)) spawnSync('taskkill.exe', ['/pid', String(p.id), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await wait(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  };
  return { label, child, call, mainEval, appWindow, renderer, stop, dir, electron };
}

// A long list whose numbers keep changing: the window's own job list is answered with 200 copies of one job, the running ones advancing.
const FAKE_LIST = `(() => { if (window.__perfList) return true; window.__perfList = true; const real = window.fetch.bind(window); let tick = 0;
  window.fetch = async (url, options) => { const response = await real(url, options); if (String(url) !== '/api/jobs' || (options?.method || 'GET') !== 'GET') return response;
    const jobs = await response.json(); const base = jobs[0]; if (!base) return new Response(JSON.stringify(jobs), { status: 200, headers: { 'Content-Type': 'application/json' } }); tick++;
    const many = Array.from({ length: 200 }, (_, i) => { const running = i < 8; const total = 500e6; const done = running ? Math.min(total, (tick * 3e6 + i * 1e7) % total) : (i % 3 ? total : total / 2);
      return { ...base, id: base.id.slice(0, 24) + String(i).padStart(12, '0'), title: 'Video file number ' + i, file: 'file-' + i + '.mp4', status: running ? 'running' : (i % 3 ? 'completed' : 'paused'), received: done, total, progress: { ...(base.progress || {}), phase: running ? 'download' : null, received: done, total, speed: running ? 2e6 + i * 1e5 : 0, etaSeconds: running ? 120 : null } }; });
    return new Response(JSON.stringify(many), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; return true; })()`;
// Scrolls the list for a few seconds and records how long every frame took.
const SCROLL = `new Promise(resolve => { const box = document.scrollingElement; const frames = []; let last = performance.now(), start = last, dir = 1;
  const step = now => { frames.push(now - last); last = now; box.scrollTop += 40 * dir; if (box.scrollTop + innerHeight >= box.scrollHeight - 2) dir = -1; if (box.scrollTop <= 0) dir = 1;
    if (now - start < 6000) requestAnimationFrame(step); else { frames.shift(); frames.sort((a, b) => a - b); const avg = frames.reduce((s, f) => s + f, 0) / frames.length;
      resolve({ frames: frames.length, fps: +(1000 / avg).toFixed(1), p95ms: +frames[Math.floor(frames.length * 0.95)].toFixed(1), worstMs: +frames.at(-1).toFixed(1), over50ms: frames.filter(f => f > 50).length }); } };
  requestAnimationFrame(step); })`;

async function waitJobs(app, ids, statuses, timeout) { await browserUntil(async () => (await app.call('/api/jobs')).filter(job => ids.includes(job.id)).every(job => statuses.includes(job.status)), timeout).catch(() => {}); }
async function bytes(app, ids) { return (await app.call('/api/jobs')).filter(job => ids.includes(job.id)).reduce((s, job) => s + (job.received || job.progress?.received || 0), 0); }
async function downloading(app, ids, label) {
  const before = await bytes(app, ids), t0 = Date.now();
  const measured = await sample(app.child.pid);
  const after = await bytes(app, ids);
  measured.speedMBps = +((after - before) / ((Date.now() - t0) / 1000) / 1048576).toFixed(2);
  measured.status = (await app.call('/api/jobs')).filter(job => ids.includes(job.id)).map(job => job.status).join(',');
  for (const id of ids) await app.call(`/api/jobs/${id}/cancel`, {}).catch(() => {});
  await wait(2000);
  console.log(`  ${label}: ${JSON.stringify(measured)}`);
  return measured;
}

async function scenario(label, extra = [], { affinity = null, downloads = true } = {}) {
  console.log(`== ${label}`);
  const app = await launch(label, extra);
  const out = report[label] = {};
  try {
    if (affinity) for (const p of tree(app.child.pid)) spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${p.id}).ProcessorAffinity = ${affinity}`], { windowsHide: true });
    await wait(15000);
    out.trayIdle = await sample(app.child.pid); console.log(`  tray idle: ${JSON.stringify(out.trayIdle)}`);
    // the quick panel from the tray icon, opened and closed again
    if (await app.mainEval('Boolean(globalThis.__hypernabTestTray)')) {
      await app.mainEval('globalThis.__hypernabTestTray.emit("click"), true'); await wait(2500);
      out.trayPanelOpen = await sample(app.child.pid, 8); console.log(`  quick panel open: ${JSON.stringify(out.trayPanelOpen)}`);
      await app.mainEval('globalThis.__hypernabTestTray.emit("click"), true'); await wait(2500);
      out.trayAfterPanel = await sample(app.child.pid, 8); console.log(`  tray after the quick panel: ${JSON.stringify(out.trayAfterPanel)}`);
    }
    // the window: from hidden to drawn
    const showWindow = () => app.mainEval(`new Promise(resolve => { const t = Date.now(); globalThis.__hypernabTestShow(); const wait = () => { const w = ${app.appWindow}; if (w && w.isVisible()) w.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').then(() => resolve(Date.now() - t)); else setTimeout(wait, 10); }; wait(); })`);
    const shown = await showWindow();
    out.showHiddenWindowMs = shown;
    const view = await app.renderer();
    await view.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait(4000);
    out.windowIdle = await sample(app.child.pid); console.log(`  window open, idle (show took ${shown} ms): ${JSON.stringify(out.windowIdle)}`);
    // a real job so the list has a shape to copy, then the long changing list
    const seed = await app.call('/api/jobs', { url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', engine: 'direct', start: 'queue', quality: 'best' });
    await browserUntil(async () => (await app.call('/api/jobs')).some(job => job.id === seed.id), 20000);
    await view.evaluate(FAKE_LIST); await wait(5000);
    out.windowList200 = await sample(app.child.pid); console.log(`  window with 200 changing rows: ${JSON.stringify(out.windowList200)}`);
    out.scroll200 = await view.evaluate(SCROLL); console.log(`  scrolling 200 rows: ${JSON.stringify(out.scroll200)}`);
    await view.evaluate('location.reload(), true'); await wait(4000);
    await app.call(`/api/jobs/${seed.id}/cancel`, {}).catch(() => {});
    view.socket.close();
    if (downloads) {
      const fresh = await app.renderer(); await fresh.call('Emulation.setFocusEmulationEnabled', { enabled: true }); fresh.socket.close();
      const one = await app.call('/api/jobs', { url: BIG, engine: 'direct', start: 'now', quality: 'best' });
      await wait(5000); out.downloadOneWindow = await downloading(app, [one.id], 'one big file, window open');
      const many = [];
      for (let i = 0; i < 4; i++) many.push((await app.call('/api/jobs', { url: `${BIG}?n=${i}`, engine: 'direct', start: 'now', quality: 'best' })).id);
      await wait(5000); out.downloadFourWindow = await downloading(app, many, 'four files at once, window open');
      try {
        const info = await app.call('/api/inspect', { url: HLS, engine: 'auto' });
        const hls = await app.call('/api/jobs', { url: HLS, engine: info.engine || 'auto', start: 'now', quality: 'best', formatId: info.defaultOptionId, title: 'hls' });
        await wait(8000); out.downloadHlsWindow = await downloading(app, [hls.id], 'HLS video, window open');
      } catch (error) { console.log(`  HLS skipped: ${error.message}`); out.downloadHlsWindow = { error: error.message }; }
      // the same big file with the window back in the tray
      await app.mainEval(`(${app.appWindow}).hide(), true`); await wait(3000);
      const tray = await app.call('/api/jobs', { url: `${BIG}?tray=1`, engine: 'direct', start: 'now', quality: 'best' });
      await wait(5000); out.downloadOneTray = await downloading(app, [tray.id], 'one big file, window in the tray');
    } else { await app.mainEval(`(${app.appWindow}).hide(), true`); }
    await wait(5000);
    out.trayAfterUse = await sample(app.child.pid); console.log(`  back in the tray after use: ${JSON.stringify(out.trayAfterUse)}`);
    // the real flow: the window is closed to the tray, freed a moment later (5 s in this test, 60 s for users), then opened again
    if (!(await app.mainEval(`Boolean(${app.appWindow})`))) await showWindow();
    await app.mainEval(`(${app.appWindow}).close(), true`);
    await wait(8000);
    out.trayWindowFreed = await sample(app.child.pid); out.trayWindowFreed.windows = await app.mainEval(`${app.electron}.BrowserWindow.getAllWindows().length`);
    console.log(`  tray, window freed: ${JSON.stringify(out.trayWindowFreed)}`);
    out.reopenFreedMs = await showWindow();
    console.log(`  freed window opened again in ${out.reopenFreedMs} ms (first show ${out.showHiddenWindowMs} ms)`);
  } catch (error) { console.log(`  ERROR ${error.stack}`); out.error = error.message; }
  finally { await app.stop(); }
}

if (!fs.existsSync(exe)) throw new Error('Build the app first: npm run dist');
if (wanted.includes('gpu')) await scenario('gpu');
if (wanted.includes('nogpu')) await scenario('nogpu', ['--disable-gpu']);
if (wanted.includes('twocores')) { await scenario('twocores-gpu', [], { affinity: 3, downloads: true }); await scenario('twocores-nogpu', ['--disable-gpu'], { affinity: 3, downloads: true }); }
const file = path.join(process.env.LOCALAPPDATA, 'Temp/opencode', `app-perf-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({ cores: CORES, sampleSeconds: SAMPLE, report }, null, 2));
console.log(`report: ${file}`);
