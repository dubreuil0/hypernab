// Standalone web UI, two real Chromium tabs, isolated server/data/profile. Never uses the installed app.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromiumBrowser, freePort, browserUntil } from './browser-driver.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools/browsers.json')));
const dir = fs.mkdtempSync(path.join(base, 'hypernab-appearance-web-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const data = path.join(dir, 'data'), downloads = path.join(dir, 'downloads');
fs.mkdirSync(data); fs.mkdirSync(downloads);
fs.writeFileSync(path.join(downloads, 'fixture.mp4'), 'test fixture');
fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify([{ id: randomUUID(), title: 'Görünüm denemesi', engine: 'direct', status: 'completed', url: 'https://example.org/test.mp4', file: 'fixture.mp4', directory: downloads }]));
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: data, HYPERNAB_DOWNLOAD_DIR: downloads }, stdio: 'ignore' });
let browser;
try {
  await browserUntil(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromiumBrowser(tools.chrome, path.join(dir, 'profile'), []);
  const one = await browser.create(origin), two = await browser.create(origin);
  for (const tab of [one, two]) await browserUntil(() => browser.eval(tab, 'document.querySelector("#connection")?.textContent.includes("aktif")'));
  assert.equal(await browser.eval(one, 'document.documentElement.dataset.appearance'), 'compact');
  assert.equal(await browser.eval(one, 'typeof hypernabDesktop'), 'undefined');
  assert.equal(await browser.eval(one, 'document.querySelectorAll("[data-job-location]").length'), 0);
  await browser.eval(one, `(()=>{document.querySelector('#open-settings').click();const s=document.querySelector('#set-appearance');s.value='normal';s.dispatchEvent(new Event('change'));return true;})()`);
  await browserUntil(() => browser.eval(two, 'document.documentElement.dataset.appearance === "normal"'));
  await browser.eval(one, `(()=>{const s=document.querySelector('#set-textSize');s.value='large';s.dispatchEvent(new Event('change'));return true;})()`);
  await browserUntil(() => browser.eval(two, 'document.documentElement.dataset.textSize === "large"'));
  await browser.navigate(two, origin);
  await browserUntil(() => browser.eval(two, 'document.querySelector("#connection")?.textContent.includes("aktif")'));
  assert.equal(await browser.eval(two, 'document.documentElement.dataset.appearance'), 'normal');
  assert.equal(await browser.eval(two, 'document.documentElement.dataset.textSize'), 'large');
  await browser.screenshot(two, path.join(dir, 'normal-web.png'));
  console.log('OK real web UI: compact default, two-tab appearance/text sync, reload persistence and no desktop-only folder action');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) child.kill(); // only the isolated server this script created
  console.log(`Test directory: ${dir}`);
}
