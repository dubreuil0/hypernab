// What the extension costs the browser as a whole: memory of the extension's own process (its background) and of the browser in total,
// and the background's CPU while a page makes a lot of network requests (every request passes the extension's request listener).
// The same Chrome with and without the extension; isolated profiles, local pages.
// Usage: node scripts/extension-cost.js   (needs `npm run test:browsers:prepare` once)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromiumBrowser } from './browser-driver.js';
import { buildExtensions } from './build-extensions.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-extcost-'));
const SECONDS = Number(process.env.PERF_SECONDS || 20);

function tree(rootPid) {
  const script = `$all = Get-CimInstance Win32_Process; $ids = @(${rootPid}); do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($ids.Count -ne $n);
    $out = foreach ($i in $ids) { $p = Get-Process -Id $i -ErrorAction SilentlyContinue; if (-not $p) { continue }; $c = ($all | Where-Object ProcessId -eq $i).CommandLine; $t = if ($c -match '--extension-process') { 'extension' } elseif ($c -match '--type=([\\w-]+)') { $Matches[1] } else { 'browser' };
      [pscustomobject]@{ id = $i; type = $t; mb = [math]::Round($p.PrivateMemorySize64 / 1MB, 1); cpu = $p.TotalProcessorTime.TotalMilliseconds } }; @($out) | ConvertTo-Json -Compress`;
  const parsed = JSON.parse(spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function sample(pid, seconds) {
  const a = tree(pid), t = Date.now(); await wait(seconds * 1000); const b = tree(pid), ms = Date.now() - t;
  const parts = {};
  for (const p of b) { const before = a.find(x => x.id === p.id); parts[p.type] ??= { mb: 0, cpu: 0, n: 0 }; parts[p.type].mb += p.mb; parts[p.type].cpu += before ? (p.cpu - before.cpu) / ms * 100 : 0; parts[p.type].n++; }
  for (const v of Object.values(parts)) { v.mb = +v.mb.toFixed(1); v.cpu = +v.cpu.toFixed(2); }
  return { totalMB: +b.reduce((s, p) => s + p.mb, 0).toFixed(1), cpuOneCore: +Object.values(parts).reduce((s, p) => s + p.cpu, 0).toFixed(2), parts };
}

let served = 0;
const pages = {
  // an ordinary page: some text, nothing moving
  plain: '<!doctype html><body><h1>Article</h1>' + '<p>Some text of an ordinary page.</p>'.repeat(200),
  // a page that keeps asking the network: 25 requests a second (feeds, chats, analytics, players)
  storm: '<!doctype html><body><script>let i=0;setInterval(()=>{for(let k=0;k<5;k++)fetch("/data?"+(i++)).catch(()=>{})},200)</script>',
  // a page with a playing-sized video element
  video: '<!doctype html><body><video width="640" height="360" controls></video><p>Video page</p>'
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/data') { served++; res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
  res.setHeader('content-type', 'text/html'); res.end(pages[u.searchParams.get('p')] || '');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const builds = buildExtensions(path.join(dir, 'ext'));

async function measure(label, extensions) {
  const browser = await chromiumBrowser(tools.chrome, path.join(dir, `p-${label}`), extensions);
  const out = {};
  try {
    await wait(5000); // the one-time settings page of a fresh install opens and settles
    for (const target of await browser.targets()) if (target.type === 'page' && target.url.startsWith('chrome-extension://')) await browser.closeTab(target.targetId);
    out.empty = await sample(browser.child.pid, 10);
    const tabs = [];
    for (const page of ['plain', 'video']) { const tab = await browser.create(`${origin}/?p=${page}`); tabs.push(tab); }
    await wait(4000);
    // JavaScript memory of each page (the extension's script on that page included)
    out.pageHeapMB = [];
    for (const tab of tabs) { await browser.cdp(tab, 'Performance.enable'); await browser.cdp(tab, 'HeapProfiler.collectGarbage').catch(() => {}); const m = Object.fromEntries((await browser.cdp(tab, 'Performance.getMetrics')).metrics.map(x => [x.name, x.value])); out.pageHeapMB.push(+(m.JSHeapUsedSize / 1048576).toFixed(2)); }
    out.twoPages = await sample(browser.child.pid, SECONDS);
    const storm = await browser.create(`${origin}/?p=storm`); await browser.front(storm);
    await wait(3000); const before = served;
    out.storm = await sample(browser.child.pid, SECONDS);
    out.storm.requestsPerSecond = +((served - before) / SECONDS).toFixed(1);
  } finally { await browser.close(); }
  return out;
}
const without = await measure('without', []);
const withExt = await measure('with', [builds.chromium]);
const line = (name, a, b) => console.log(`${name.padEnd(34)} | without: ${String(a.totalMB).padStart(7)} MB ${String(a.cpuOneCore).padStart(6)} % | with: ${String(b.totalMB).padStart(7)} MB ${String(b.cpuOneCore).padStart(6)} % | extension process: ${b.parts.extension ? `${b.parts.extension.mb} MB, ${b.parts.extension.cpu} %` : '-'}`);
line('browser, no page', without.empty, withExt.empty);
line('ordinary page + video page', without.twoPages, withExt.twoPages);
line(`busy page (${withExt.storm.requestsPerSecond} requests/s)`, without.storm, withExt.storm);
console.log(`JavaScript memory per page (ordinary, video): without ${without.pageHeapMB.join(' / ')} MB | with ${withExt.pageHeapMB.join(' / ')} MB`);
fs.writeFileSync(path.join(base, `extension-cost-${Date.now()}.json`), JSON.stringify({ without, withExt }, null, 2));
server.close();
