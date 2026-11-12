// Series/playlist flow in the real web UI with the real yt-dlp (needs internet, uses one small public playlist).
// Isolated server/data/profile; adds only to the waiting queue and never starts a download.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromiumBrowser, freePort, browserUntil } from './browser-driver.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools/browsers.json')));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-playlist-web-'));
const LIST = process.env.HD_PLAYLIST;
if (!LIST) throw new Error('HD_PLAYLIST ile bir oynatma listesi adresi ver.');
const port = await freePort(), origin = `http://127.0.0.1:${port}`, data = path.join(dir, 'data'), downloads = path.join(dir, 'downloads');
fs.mkdirSync(data); fs.mkdirSync(downloads);
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: data, HYPERNAB_DOWNLOAD_DIR: downloads }, stdio: 'ignore' });
let browser;
try {
  await browserUntil(() => fetch(origin).then(r => r.ok, () => false));
  const token = fs.readFileSync(path.join(data, 'pairing-token'), 'utf8').trim();
  const api = async route => (await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` } })).json();
  browser = await chromiumBrowser(tools.chrome, path.join(dir, 'profile'), []);
  const tab = await browser.create(origin); await browser.viewport(tab, 1200, 900);
  const ev = expression => browser.eval(tab, expression);
  await browserUntil(() => ev('document.querySelector("#connection")?.textContent.includes("aktif")'));
  await ev(`(()=>{const i=document.querySelector('#url');i.value=${JSON.stringify(LIST)};i.dispatchEvent(new Event('input'));document.querySelector('#download-form').requestSubmit();return true})()`);
  await browserUntil(() => ev('!document.querySelector("#playlist").hidden && document.querySelectorAll("#playlist-items input").length > 5'), 90000);
  const total = await ev('document.querySelectorAll("#playlist-items input").length');
  assert.equal(await ev('document.querySelector("#playlist-add").disabled'), false);
  await browser.screenshot(tab, path.join(dir, 'playlist.png'));
  // choose exactly three
  await ev(`(()=>{const all=document.querySelector('#playlist-all');all.checked=false;all.dispatchEvent(new Event('change'));const b=[...document.querySelectorAll('#playlist-items input')];for(const x of b.slice(0,3)){x.checked=true;x.dispatchEvent(new Event('change'))}return true})()`);
  assert.match(await ev('document.querySelector("#playlist-add").textContent'), /3 videoyu/);
  await ev('document.querySelector("#playlist-add").click()');
  await browserUntil(async () => (await api('/api/jobs')).length === 3, 20000);
  const jobs = await api('/api/jobs');
  assert.ok(jobs.every(job => job.status === 'held'), JSON.stringify(jobs.map(j => j.status))); // added for later: not started
  assert.ok(jobs.every(job => /^.+ - \d{3} - /.test(job.title)), jobs.map(j => j.title).join(' | '));
  console.log(`OK real yt-dlp list of ${total} videos shown, 3 chosen, added to the waiting queue only (${jobs[0].title})`);
  // the same list again: the three queued ones are marked and not selected by default
  await ev(`(()=>{const i=document.querySelector('#url');i.value=${JSON.stringify(LIST)};i.dispatchEvent(new Event('input'));document.querySelector('#download-form').requestSubmit();return true})()`);
  await browserUntil(() => ev('!document.querySelector("#playlist").hidden && document.querySelectorAll("#playlist-items input").length > 5'), 90000);
  assert.equal(await ev('[...document.querySelectorAll("#playlist-items input")].slice(0,3).every(x => !x.checked)'), true);
  assert.match(await ev('document.querySelector("#playlist-items").textContent'), /zaten listede/);
  console.log('OK already queued videos are marked "zaten listede" and not preselected');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill();
  console.log(`Test directory: ${dir}`);
}
