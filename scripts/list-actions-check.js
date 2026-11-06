// Real-browser check of the download list's ONE action bar: scope of the buttons (selection or everything), labels, dimming, the select menu,
// Shift/Ctrl+A/Escape, the always-asked cancel for several downloads, "Remove" with Undo, one compact row, and the same in German, Russian
// and Arabic. The engine is isolated (own port, temporary folders); the job list the page sees is made from one real job (other statuses are
// copies), and the POST calls the buttons make are recorded and answered by the page itself. Usage: node scripts/list-actions-check.js [firefox] [chrome]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromiumBrowser, firefoxBrowser, freePort } from './browser-driver.js';
import { buildExtensions } from './build-extensions.js';
import { zipFolder } from './zip-store.js';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-list-actions-'));
const shots = path.join(base, 'ds-shots'); fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (browser, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HYPERNAB_LOCALE: 'en-US', HYPERNAB_PORT: String(port), HYPERNAB_DATA_DIR: path.join(dir, 'data'), HYPERNAB_DOWNLOAD_DIR: path.join(dir, 'downloads') } });
for (let n = 0; n < 50; n++) { try { if ((await fetch(origin + '/ds.js')).ok) break; } catch { /* starting */ } await sleep(200); }
const token = () => fs.readFileSync(path.join(dir, 'data', 'pairing-token'), 'utf8').trim();
const api = (route, body) => fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

// the page shows seven jobs: running, queued, paused, completed (removable), failed (removable), held, completed (removable)
const FAKE = String.raw`(() => {
  window.__calls = []; const real = window.fetch.bind(window);
  const ids = ['00000000-0000-4000-8000-00000000000' + 1, '00000000-0000-4000-8000-00000000000' + 2, '00000000-0000-4000-8000-00000000000' + 3, '00000000-0000-4000-8000-00000000000' + 4, '00000000-0000-4000-8000-00000000000' + 5, '00000000-0000-4000-8000-00000000000' + 6, '00000000-0000-4000-8000-00000000000' + 7];
  const kinds = [['running', 5000000], ['queued', 0], ['paused', 3000000], ['completed', 9000000], ['failed', 0], ['held', 0], ['completed', 4000000]];
  window.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET', u = String(url);
    if (method === 'GET' && u === '/api/jobs') {
      const jobs = await (await real(url, options)).json(); const model = jobs[0];
      return new Response(JSON.stringify(kinds.map(([status, received], i) => ({ ...model, id: ids[i], title: 'File ' + (i + 1), status, received, speed: status === 'running' ? 1000000 : 0, canClear: ['completed', 'failed'].includes(status) }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'POST' && /^\/api\/jobs\/[0-9a-f-]+\/retry$/.test(u)) { window.__calls.push([u, {}]); return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    if (method === 'POST' && /^\/api\/queue\/(bulk|clear|restore)$/.test(u)) {
      const body = JSON.parse(options.body); window.__calls.push([u, body]);
      const out = u.endsWith('clear') ? { removed: body.ids.length, removedIds: body.ids, undoToken: 'tok-1' } : u.endsWith('restore') ? { restored: 3 } : { changed: 1 };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, options);
  };
})()`;

async function run(name, launch) {
  let browser;
  try {
    browser = await launch();
    const tab = await browser.create(origin + '/');
    await browser.navigate(tab, origin + '/');
    if (browser.viewport) await browser.viewport(tab, 1280, 800);
    const ev = expr => browser.eval(tab, expr);
    const act = code => browser.eval(tab, `(() => { ${code} })()`); // several statements
    await sleep(1200);
    // one real job to copy: a page link added for later
    await ev(`(async () => { const b = await fetch('/api/bootstrap').then(r => r.json()); await fetch('/api/queue/bulk-add', { method: 'POST', headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); })()`);
    await api('/api/jobs', { url: 'https://example.org/a-page', title: 'model', engine: 'extractor', start: 'queue' }).catch(() => {});
    for (let n = 0; n < 20 && !(await api('/api/jobs')).length; n++) await sleep(300);
    const haveModel = (await api('/api/jobs')).length > 0;
    check(name, 'a real job exists to copy', haveModel);
    if (!haveModel) return;
    await browser.navigate(tab, origin + '/'); await sleep(1500); await ev(FAKE); await sleep(3500);
    const text = id => ev(`document.getElementById('${id}')?.textContent.trim()`);
    const state = id => ev(`(() => { const b = document.getElementById('${id}'); return { text: b.textContent.trim(), disabled: b.disabled, hidden: b.closest('[hidden]') !== null }; })()`);
    const calls = () => ev(`JSON.stringify(window.__calls)`).then(JSON.parse);
    const reset = async () => { await act(`window.__calls = []; document.getElementById('deselect-all').click();`); await sleep(300); };
    const rows = () => ev(`document.querySelectorAll('#jobs .job').length`);

    check(name, 'seven jobs are shown', (await rows()) === 7, String(await rows()));
    // ---------- no selection: every button is about everything
    const none = { pause: await state('act-pause'), resume: await state('act-resume'), cancel: await state('act-cancel'), clear: await state('act-clear') };
    check(name, 'no selection: "Pause all", "Resume all", "Remove finished" are on, Cancel is dimmed', none.pause.text === 'Pause all' && !none.pause.disabled && none.resume.text === 'Resume all' && !none.resume.disabled && none.clear.text === 'Remove finished' && !none.clear.disabled && none.cancel.disabled, JSON.stringify(none));
    check(name, 'the figures sit beside the "Downloads" title (one row less)', await ev(`(() => { const head = document.querySelector('.queue-head'); return Boolean(head.querySelector('#stat-active') && head.querySelector('#stat-speed') && head.querySelector('#stat-complete')); })()`));
    check(name, 'the old three-button header and the second selection row are gone', await ev(`!document.getElementById('pause-all') && !document.getElementById('clear-queue') && !document.querySelector('.select-bar')`));
    await ev(`document.getElementById('act-pause').click()`); await sleep(500);
    check(name, '"Pause all" asks the engine to pause everything', JSON.stringify((await calls()).at(-1)) === JSON.stringify(['/api/queue/bulk', { action: 'pause', all: true }]), JSON.stringify(await calls()));
    await ev(`document.getElementById('act-resume').click()`); await sleep(500);
    check(name, '"Resume all" asks the engine to resume everything', JSON.stringify((await calls()).at(-1)) === JSON.stringify(['/api/queue/bulk', { action: 'resume', all: true }]));
    await reset();
    // ---------- a failed download is one click from another try (and no other row offers it)
    const retries = await ev(`[...document.querySelectorAll('#jobs [data-job-action$="-retry"]')].map(b => b.closest('.job').querySelector('.job-title').textContent)`);
    check(name, 'only the failed row shows a "Try again" button', JSON.stringify(retries) === '["File 5"]', JSON.stringify(retries));
    await ev(`document.querySelector('#jobs [data-job-action$="-retry"]').click()`); await sleep(500);
    check(name, '"Try again" asks the engine to retry that download', /^\/api\/jobs\/00000000-0000-4000-8000-000000000005\/retry$/.test((await calls()).at(-1)?.[0] || ''), JSON.stringify(await calls()));
    await reset();
    // ---------- no queue: "At the same time" sits in the header, a download added for later is a paused one (Resume starts it), Settings has a Schedule
    check(name, 'no queue row, no start/stop button, no named queues; "At the same time" is in the header', await ev(`(() => !document.querySelector('.queue-bar') && !document.getElementById('queue-toggle') && !document.getElementById('named-queue') && Boolean(document.querySelector('.queue-head #queue-limit')))()`));
    const resumable = await ev(`[...document.querySelectorAll('#jobs [data-job-action$="-resume"]')].map(b => b.closest('.job').querySelector('.job-title').textContent)`);
    check(name, 'a paused row and the added-for-later row both offer Resume (no separate "Start now")', JSON.stringify(resumable) === '["File 3","File 6"]' && (await ev(`document.querySelectorAll('#jobs [data-job-action$="-start-now"]').length`)) === 0, JSON.stringify(resumable));
    await act(`document.querySelectorAll('#jobs .job input[type=checkbox]')[5].click();`); await sleep(300);
    check(name, 'selecting only the added-for-later row: "Resume (1)" is on', (await text('act-resume-label')) === 'Resume (1)' && !(await state('act-resume')).disabled, await text('act-resume-label'));
    await ev(`document.getElementById('act-resume').click()`); await sleep(500);
    check(name, 'Resume on it asks the engine to resume exactly that download', (await calls()).at(-1)?.[1]?.ids?.length === 1 && (await calls()).at(-1)?.[1]?.action === 'resume', JSON.stringify((await calls()).at(-1)));
    await reset();
    await ev(`document.getElementById('open-settings').click()`); await sleep(500);
    check(name, 'Settings has "Schedule" (time + finish action) and no queue targets', await ev(`(() => Boolean(document.getElementById('s-schedule') && document.getElementById('schedule-at') && document.getElementById('power-action')) && !document.getElementById('new-queue') && !document.getElementById('new-queue-name') && !document.querySelector('a[href="#s-queue"]'))()`));
    await ev(`document.getElementById('close-settings').click()`); await sleep(300);
    // ---------- one row on a wide window: the select box, the buttons and the search sit on one line
    const geo = await ev(`(() => { const y = id => Math.round(document.getElementById(id).getBoundingClientRect().y); return { select: y('select-all'), pause: y('act-pause'), search: y('list-search'), width: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    check(name, 'select box, action buttons and search are on one line and the page does not scroll sideways', Math.abs(geo.select - geo.pause) < 14 && Math.abs(geo.pause - geo.search) < 18 && geo.width <= 1, JSON.stringify(geo));
    // ---------- a selection: the buttons are about the selection, with its counts
    await act(`document.querySelectorAll('#jobs .job input[type=checkbox]')[0].click(); document.querySelectorAll('#jobs .job input[type=checkbox]')[3].click();`); await sleep(400);
    const sel = { pause: await text('act-pause-label'), resume: await state('act-resume'), cancel: await text('act-cancel-label'), clear: await text('act-clear-label'), count: await text('selected-count') };
    check(name, 'two selected (running + completed): "Pause (1)", Resume dimmed, "Cancel (1)…", "Remove (1)"', sel.pause === 'Pause (1)' && sel.resume.disabled && sel.cancel === 'Cancel (1)…' && sel.clear === 'Remove (1)' && /2 selected/.test(sel.count), JSON.stringify(sel));
    await ev(`document.getElementById('act-pause').click()`); await sleep(500);
    check(name, 'Pause acts on the selection only', JSON.stringify((await calls()).at(-1)) === JSON.stringify(['/api/queue/bulk', { action: 'pause', ids: ['00000000-0000-4000-8000-000000000001'] }]) || (await calls()).at(-1)?.[1]?.ids?.length === 2, JSON.stringify(await calls()));
    await reset();
    // ---------- cancelling several: always asked, how many and how much, no "don't ask again", the safe answer has the focus
    await ev(`document.getElementById('select-all').click()`); await sleep(400);
    await ev(`document.getElementById('act-cancel').click()`); await sleep(400);
    const dlg = await ev(`(() => { const d = document.getElementById('queue-confirm'); return { open: d.open, title: document.getElementById('queue-confirm-title').textContent, text: document.getElementById('queue-confirm-text').textContent, skipHidden: document.getElementById('queue-confirm-skip').closest('label').hidden, accept: document.getElementById('queue-confirm-accept').textContent.trim(), back: document.getElementById('queue-confirm-cancel').textContent.trim(), focus: document.activeElement.id }; })()`);
    check(name, 'cancelling several asks: count in the title, size of the half-written files, no "don\'t ask again", "Go back" has the focus', dlg.open && /^Cancel 5 downloads\?$/.test(dlg.title) && /8\.\d* MB|7\.\d* MB|8 MB/.test(dlg.text) && dlg.skipHidden && /Cancel 5 downloads/.test(dlg.accept) && dlg.back === 'Go back' && dlg.focus === 'queue-confirm-cancel', JSON.stringify(dlg));
    await browser.screenshot(tab, path.join(shots, `${name}-list-cancel-dialog.png`));
    await ev(`document.getElementById('queue-confirm-cancel').click()`); await sleep(300);
    check(name, '"Go back" cancels nothing', !(await calls()).some(([, body]) => body.action === 'cancel'));
    // even with "don't ask again" saved for single cancels, several are still asked
    await ev(`localStorage.setItem('hypernab-skip-confirm-cancel', '1')`);
    await ev(`document.getElementById('act-cancel').click()`); await sleep(400);
    check(name, 'a saved "don\'t ask again" never skips cancelling several', await ev(`document.getElementById('queue-confirm').open`));
    await ev(`document.getElementById('queue-confirm-accept').click()`); await sleep(500);
    const cancelCall = (await calls()).find(([, body]) => body.action === 'cancel');
    check(name, 'confirming cancels exactly the cancellable ones', cancelCall && cancelCall[1].ids.length === 5, JSON.stringify(cancelCall));
    await ev(`localStorage.removeItem('hypernab-skip-confirm-cancel')`); await reset();
    // ---------- Remove: no question, Undo
    await ev(`document.getElementById('act-clear').click()`); await sleep(600);
    const clearCall = (await calls()).find(([url]) => url === '/api/queue/clear');
    check(name, '"Remove finished" asks nothing and removes the three removable records', clearCall && clearCall[1].ids.length === 3 && !(await ev(`document.getElementById('queue-confirm').open`)), JSON.stringify(clearCall));
    const undoShown = await ev(`(() => { const t = document.getElementById('undo-toast'); return { shown: !t.hidden, text: document.getElementById('undo-text').textContent, button: document.getElementById('undo-button').textContent.trim() }; })()`);
    check(name, 'a notification says how many were removed and offers Undo', undoShown.shown && /3 entries removed/.test(undoShown.text) && undoShown.button === 'Undo', JSON.stringify(undoShown));
    await browser.screenshot(tab, path.join(shots, `${name}-list-undo.png`));
    await ev(`document.getElementById('undo-button').click()`); await sleep(600);
    check(name, 'Undo asks the engine to restore with the token and says so', JSON.stringify((await calls()).at(-1)) === JSON.stringify(['/api/queue/restore', { token: 'tok-1' }]) && /3 entries are back/.test(await text('queue-message')), JSON.stringify((await calls()).at(-1)));
    await reset();
    // ---------- the select menu, Shift + click, Ctrl+A, Escape
    await ev(`document.querySelector('#select-menu summary').click()`); await sleep(200);
    await ev(`document.querySelector('[data-select=completed]').click()`); await sleep(300);
    check(name, 'Select > Completed selects only the completed ones and the menu closes', (await text('selected-count')) === '2 selected' && !(await ev(`document.getElementById('select-menu').open`)), await text('selected-count'));
    await reset();
    await ev(`document.querySelectorAll('#jobs .job input[type=checkbox]')[0].click()`); await sleep(200);
    await ev(`(() => { const box = document.querySelectorAll('#jobs .job input[type=checkbox]')[2]; box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); })()`); await sleep(300);
    check(name, 'Shift + click selects the range between two rows', (await text('selected-count')) === '3 selected', await text('selected-count'));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300);
    check(name, 'Escape clears the selection', (await text('selected-count')) === '');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))`); await sleep(300);
    check(name, 'Ctrl+A selects everything shown', (await text('selected-count')) === '7 selected', await text('selected-count'));
    await reset();
    // ---------- narrow window: buttons keep only their icons (their names stay as tooltips) and nothing scrolls sideways
    if (browser.viewport) {
      await browser.viewport(tab, 640, 800); await sleep(600);
      const narrow = await ev(`(() => ({ label: getComputedStyle(document.querySelector('#act-pause span')).display, title: document.getElementById('act-pause').title, width: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`);
      check(name, 'at 640px the action buttons are icon-only with a tooltip and the page does not scroll sideways', narrow.label === 'none' && narrow.title.length > 0 && narrow.width <= 1, JSON.stringify(narrow));
      await browser.viewport(tab, 1280, 800); await sleep(400);
    }
    await browser.screenshot(tab, path.join(shots, `${name}-list-bar.png`));
    // ---------- other languages: the bar fits (no extra rows) and Arabic mirrors
    for (const lang of ['de', 'ru', 'ar']) {
      await api('/api/settings', { interfaceLanguage: lang });
      await browser.navigate(tab, origin + '/'); await sleep(2500); await ev(FAKE); await sleep(3500);
      await act(`document.querySelectorAll('#jobs .job input[type=checkbox]')[0].click(); document.querySelectorAll('#jobs .job input[type=checkbox]')[3].click();`); await sleep(400);
      const fit = await ev(`(() => { const bar = document.querySelector('.list-actions'), r = id => document.getElementById(id).getBoundingClientRect(); return { rows: Math.round(bar.getBoundingClientRect().height), pause: Math.round(r('act-pause').height), x: Math.round(r('act-pause').x), selectX: Math.round(r('select-all').x), sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, widths: ['.select-group', '#list-buttons', '.list-actions .list-tools'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().width)), dir: document.documentElement.dir, labels: ['act-pause-label', 'act-cancel-label', 'act-clear-label'].map(id => document.getElementById(id).textContent) }; })()`);
      check(name, `${lang}: the action bar stays one tidy row (no wrapped buttons) and the page does not scroll sideways`, fit.pause < 40 && fit.rows < 60 && fit.sideways <= 1, JSON.stringify(fit));
      if (lang === 'ar') check(name, 'ar: right to left, the select box is on the right of the buttons', fit.dir === 'rtl' && fit.selectX > fit.x, JSON.stringify(fit));
      await browser.screenshot(tab, path.join(shots, `${name}-list-bar-${lang}.png`));
    }
    await api('/api/settings', { interfaceLanguage: 'auto' });
  } catch (error) { check(name, 'finished without an exception', false, String(error.stack || error).slice(0, 400)); }
  finally { await browser?.close(); }
}

try {
  if (wanted.includes('firefox')) { const builds = buildExtensions(path.join(dir, 'ext')); await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'ff-profile'), zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi')))); }
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'chrome-profile'), []));
} finally { server.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(results.every(Boolean) ? 'SONUÇ: hepsi geçti' : 'SONUÇ: hata var');
process.exitCode = results.every(Boolean) ? 0 : 1;
