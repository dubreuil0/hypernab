// Measures what the extension's content script costs a page: the same heavy pages with and without the extension,
// script and task time of the page (content scripts included) over a fixed window. Isolated profiles, local pages.
// Usage: node scripts/perf/extension-perf.js   (PERF_SECONDS=20 by default; needs `npm run test:browsers:prepare` once)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { chromiumBrowser } from '../e2e/browser-driver.js';
import { buildExtensions } from '../release/build-extensions.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-perf-'));
const SECONDS = Number(process.env.PERF_SECONDS || 20);
// static: a big page that never changes; feed: a big page that adds and removes items 10 times a second (news feed, chat);
// video: a normal page with one playing-sized video element.
const pages = {
  static: n => `<!doctype html><body><div id="r"></div><script>const r=document.getElementById('r');for(let i=0;i<${n};i++){const d=document.createElement('div');d.textContent='item '+i;r.append(d)}</script>`,
  feed: n => `<!doctype html><body><div id="r"></div><script>const r=document.getElementById('r');for(let i=0;i<${n};i++){const d=document.createElement('div');d.textContent='item '+i;r.append(d)}setInterval(()=>{const d=document.createElement('div');d.textContent='new';r.prepend(d);r.lastChild.remove()},100)</script>`,
  video: n => `<!doctype html><body><video width="640" height="360"></video><div id="r"></div><script>const r=document.getElementById('r');for(let i=0;i<${n};i++){const d=document.createElement('div');d.textContent='item '+i;r.append(d)}</script>`
};
const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'text/html'); if (!pages[u.searchParams.get('p')]) return res.end(''); res.end(pages[u.searchParams.get('p')](Number(u.searchParams.get('n')))); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const builds = buildExtensions(path.join(dir, 'ext'));

async function measure(label, extensions) {
  const browser = await chromiumBrowser(tools.chrome, path.join(dir, `p-${label}`), extensions);
  const out = {};
  try {
    for (const [page, n] of [['static', 5000], ['static', 50000], ['feed', 5000], ['feed', 50000], ['video', 50000]]) {
      const tab = await browser.create(`${origin}/?p=${page}&n=${n}`); await wait(800); await browser.front(tab); await wait(3000);
      const metrics = async () => Object.fromEntries((await browser.cdp(tab, 'Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      await browser.cdp(tab, 'Performance.enable');
      const a = await metrics(); await wait(SECONDS * 1000); const b = await metrics();
      out[`${page}-${n}`] = { scriptMsPerSec: +((b.ScriptDuration - a.ScriptDuration) * 1000 / SECONDS).toFixed(2), taskMsPerSec: +((b.TaskDuration - a.TaskDuration) * 1000 / SECONDS).toFixed(2), heapMB: +(b.JSHeapUsedSize / 1048576).toFixed(1) };
      await browser.closeTab(tab);
    }
  } finally { await browser.close(); }
  return out;
}
const without = await measure('without', []);
const withExt = await measure('with', [builds.chromium]);
console.log('page            | without ext: script ms/s, task ms/s | with ext: script ms/s, task ms/s');
for (const key of Object.keys(without)) console.log(`${key.padEnd(15)} | ${String(without[key].scriptMsPerSec).padStart(7)} ${String(without[key].taskMsPerSec).padStart(7)} | ${String(withExt[key].scriptMsPerSec).padStart(7)} ${String(withExt[key].taskMsPerSec).padStart(7)}`);
server.close();
