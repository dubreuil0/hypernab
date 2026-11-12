// Real-browser check of the on-page download button with the REAL extension (isolated temporary profiles, local test pages).
// Usage: node scripts/e2e/overlay-real-browser.js [firefox] [chrome]   (default: both). Needs `node scripts/setup/prepare-browser-tests.js` once.
// A page player lives in a cross-origin iframe, exactly like most film/series sites. The button must be drawn by the TOP page,
// outside the iframe, and nowhere inside the iframe.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { buildExtensions } from '../release/build-extensions.js';
import { chromiumBrowser, firefoxBrowser, browserUntil } from './browser-driver.js';
import { zipFolder } from '../release/zip-store.js';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
const tools = JSON.parse(fs.readFileSync(path.join(base, 'hypernab-browser-tools', 'browsers.json'), 'utf8'));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['firefox', 'chrome'];
const dir = fs.mkdtempSync(path.join(base, 'hypernab-overlay-'));
const listen = handler => new Promise(resolve => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });
const log = [];
const logServer = await listen((req, res) => { log.push(new URL(req.url, 'http://x').searchParams.get('t')); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('ok'); });
const logPort = logServer.address().port;
// The player frame reports (as page JS, light DOM only) whether a button host ended up inside it.
const childServer = await listen((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><body style="margin:0;background:#123"><video id="v" width="640" height="360" style="display:block"></video><script>
    setTimeout(() => document.getElementById('v').dispatchEvent(new Event('playing')), 1200);
    setTimeout(() => fetch('http://127.0.0.1:${logPort}/?t=' + encodeURIComponent('child-host:' + [...document.body.children].some(e => e.style.zIndex === '2147483647')) ).catch(() => {}), 6000);
  </script>`);
});
const childPort = childServer.address().port;
const topServer = await listen((req, res) => {
  const frameTop = Number(new URL(req.url, 'http://x').searchParams.get('top') || 200);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:2500px;font:20px sans-serif"><div style="position:absolute;left:100px;top:120px;width:700px;line-height:28px">Üst sayfadaki yazı: düğmenin arkasında okunabilmeli.</div><iframe id="f" src="http://127.0.0.1:${childPort}/player" style="position:absolute;left:100px;top:${frameTop}px;width:640px;height:360px;border:0"></iframe><div style="position:absolute;left:900px;top:450px;width:300px">Sağdaki site alanı</div><button id="fs-page" style="position:absolute;left:10px;top:450px;width:80px;height:36px" onclick="window.fsr='clicked';document.documentElement.requestFullscreen().then(()=>window.fsr='ok',e=>window.fsr='err:'+e.message)">page</button><button id="fs-frame" style="position:absolute;left:10px;top:510px;width:80px;height:36px" onclick="window.fsr='clicked';document.getElementById('f').requestFullscreen().then(()=>window.fsr='ok',e=>window.fsr='err:'+e.message)">frame</button>`);
});
const topUrl = `http://127.0.0.1:${topServer.address().port}/`;
// The button lives in a closed shadow root, so its box is found by hit-testing: the host element answers for every point of the bar.
const barBox = `(() => {
  const hosts = [...document.body.children].filter(e => e.style.zIndex === '2147483647'); if (!hosts.length) return null;
  let box = null;
  for (let y = 0; y < document.documentElement.clientHeight; y += 3) for (let x = 0; x < document.documentElement.clientWidth; x += 3) {
    if (document.elementFromPoint(x, y) !== hosts[0]) continue;
    box = box ? { l: Math.min(box.l, x), r: Math.max(box.r, x), t: Math.min(box.t, y), b: Math.max(box.b, y) } : { l: x, r: x, t: y, b: y };
  }
  return box;
})()`;
const near = (a, b, tolerance = 6) => Math.abs(a - b) <= tolerance;
// Pictures are for a person to look at, not part of the checks: headless Chrome 157 sometimes never answers a screenshot.
const snap = async (browser, tab, file) => {
  try { await Promise.race([browser.screenshot(tab, file), wait(10000).then(() => { throw new Error('zaman aşımı'); })]); console.log(`     ekran görüntüsü: ${file}`); }
  catch (error) { console.log(`     ekran görüntüsü alınamadı (${error.message})`); }
};
const builds = buildExtensions(path.join(dir, 'extensions'));
const results = [];
const check = (browser, name, ok, detail = '') => { results.push({ browser, name, ok }); console.log(`${ok ? 'OK  ' : 'HATA'} [${browser}] ${name} ${detail}`); };

async function run(name, open) {
  log.length = 0;
  const browser = await open();
  try {
    const tab = await browser.create(topUrl);
    // A fresh install opens the settings page once and it takes the front: put the test page back in front (a tab behind is slowed
    // down and refused full screen), then give it a usual desktop size (headless Chrome 157 opens 764x429).
    if (browser.front) { await wait(1000); await browser.front(tab); }
    if (browser.windowSize) { await browser.windowSize(tab, 1280, 800); await wait(300); }
    // Wait until the player frame has reported, then inspect the top page.
    await browserUntil(() => log.some(entry => entry?.startsWith('child-host:')), 30000);
    await wait(500);
    const probe = await browser.eval(tab, `(() => {
      const frame = document.getElementById('f').getBoundingClientRect();
      const hosts = [...document.body.children].filter(e => e.style.zIndex === '2147483647');
      const hostAt = (x, y) => hosts.length > 0 && document.elementFromPoint(x, y) === hosts[0];
      // Default spot: above the frame's top-right corner, right edges aligned. Scan the strip right above the frame.
      let found = null;
      for (let y = frame.top - 40; y < frame.top - 2 && !found; y += 4) for (let x = frame.right - 140; x < frame.right - 4; x += 8) if (hostAt(x, y)) { found = { x, y }; break; }
      return { hosts: hosts.length, aboveFrame: Boolean(found), frame: { top: frame.top, right: frame.right } };
    })()`);
    check(name, 'üst sayfada tek düğme çizildi', probe.hosts === 1, `(ana öğe sayısı=${probe.hosts})`);
    check(name, 'düğme iframe\'in dışında, sağ üst köşenin üstünde', probe.aboveFrame === true);
    check(name, 'iframe içinde düğme çizilmedi', log.includes('child-host:false'), `(iframe raporu=${log.filter(x => x?.startsWith('child-host:')).join(',')})`);
    const shot = path.join(dir, `overlay-${name}.png`); await snap(browser, tab, shot);

    // Floating panel: a REAL click on the button opens it under the button (no extension popup), Esc and an outside click close it.
    // (No app key is stored in this fresh profile, so the panel shows its "connect first" message; geometry and open/close are what is checked.)
    const closed = await browser.eval(tab, barBox);
    const clickX = closed.l + 18, clickY = Math.round((closed.t + closed.b) / 2);
    await browser.click(tab, clickX, clickY); await wait(1200);
    const opened = await browser.eval(tab, barBox);
    check(name, 'düğmeye tıklayınca yüzen panel düğmenin altında açılır', Boolean(opened) && opened.b - opened.t > (closed.b - closed.t) + 50 && near(opened.r, closed.r, 12), `(önce=${closed.b - closed.t}px, sonra=${opened?.b - opened?.t}px)`);
    const shotPanel = path.join(dir, `panel-${name}.png`); await snap(browser, tab, shotPanel);
    await browser.key(tab, 'Escape'); await wait(800);
    const afterEsc = await browser.eval(tab, barBox);
    check(name, 'Esc paneli kapatır', Boolean(afterEsc) && afterEsc.b - afterEsc.t <= (closed.b - closed.t) + 6, `(${afterEsc?.b - afterEsc?.t}px)`);
    await browser.click(tab, clickX, clickY); await wait(1000);
    await browser.click(tab, 40, 400); await wait(800); // empty page area (left of the player frame)
    const afterOutside = await browser.eval(tab, barBox);
    check(name, 'panelin dışına tıklayınca kapanır', Boolean(afterOutside) && afterOutside.b - afterOutside.t <= (closed.b - closed.t) + 6, `(${afterOutside?.b - afterOutside?.t}px)`);

    // Scrolling: same side position, travels with the video, slides out and is gone, comes back in the same spot.
    const scrollTo = async y => { await browser.eval(tab, `(window.scrollTo(0, ${y}), true)`); await wait(1700); }; // headless Chrome throttles timers of background tabs (about 1 s): give the button time to follow
    const at0 = await browser.eval(tab, barBox);
    await scrollTo(40); const at40 = await browser.eval(tab, barBox);
    check(name, 'kaydırınca düğme yatayda sabit kalır, videoyla birlikte yukarı kayar', Boolean(at0 && at40) && near(at40.l, at0.l) && near(at40.r, at0.r) && near(at40.t, at0.t - 40), `(önce=${JSON.stringify(at0)} sonra=${JSON.stringify(at40)})`);
    await scrollTo(120); const at120 = await browser.eval(tab, barBox);
    check(name, 'biraz daha kaydırınca aynı yatay konumda kalır', Boolean(at120) && near(at120.l, at0.l) && near(at120.r, at0.r), `(${JSON.stringify(at120)})`);
    await scrollTo(300); const stuck = await browser.eval(tab, barBox); // video top already above the window, most of the video still visible
    check(name, 'video üstü pencereden çıksa da büyük kısmı görünürken düğme üstte kalır', Boolean(stuck) && near(stuck.l, at0.l) && stuck.t <= 8, `(${JSON.stringify(stuck)})`);
    await scrollTo(600); const gone = await browser.eval(tab, barBox);
    check(name, 'tamamen pencereden çıkınca kaybolur', gone === null, `(${JSON.stringify(gone)})`);
    await scrollTo(0); const back = await browser.eval(tab, barBox);
    check(name, 'yukarı dönünce aynı yerde yeniden belirir', Boolean(back && at0) && near(back.l, at0.l) && near(back.t, at0.t) && near(back.r, at0.r), `(${JSON.stringify(back)})`);

    // Full screen (a real click, as the browser demands): the whole page, then the player frame. Nothing of ours over the picture;
    // on leaving, the button is back in its spot.
    for (const [button, what] of [['fs-page', 'tüm sayfa'], ['fs-frame', 'oynatıcı karesi']]) {
      await browser.click(tab, 50, button === 'fs-page' ? 468 : 528); await wait(1200);
      const state = await browser.eval(tab, `({ fsr: window.fsr, on: Boolean(document.fullscreenElement), host: [...document.body.children].some(e => e.style.zIndex === '2147483647' && e.style.display !== 'none') })`);
      const shotFull = path.join(dir, `fullscreen-${button}-${name}.png`); await snap(browser, tab, shotFull);
      check(name, `tam ekranda (${what}) düğme görünmez`, state.on === true && state.host === false && (await browser.eval(tab, barBox)) === null, `(tam ekran=${state.on}, istek=${state.fsr}, düğme görünür=${state.host})`);
      await browser.eval(tab, `(document.exitFullscreen(), true)`); await wait(1500);
      const restored = await browser.eval(tab, barBox);
      check(name, `tam ekrandan (${what}) çıkınca aynı yerde geri gelir`, Boolean(restored && at0) && near(restored.l, at0.l) && near(restored.t, at0.t), `(${JSON.stringify(restored)})`);
    }

    // Video close to the top of the page (no room above): the side must not flip while scrolling.
    log.length = 0; await browser.navigate(tab, `${topUrl}?top=10`);
    await browserUntil(() => log.some(entry => entry?.startsWith('child-host:')), 30000); await wait(800);
    const high0 = await browser.eval(tab, barBox);
    await scrollTo(4); const high1 = await browser.eval(tab, barBox);
    await scrollTo(30); const high2 = await browser.eval(tab, barBox);
    check(name, 'videosu sayfanın en üstünde olan sayfada kaydırınca sağa sola atlamaz', Boolean(high0 && high1 && high2) && near(high1.l, high0.l) && near(high2.l, high0.l) && near(high1.r, high0.r) && near(high2.r, high0.r), `(sol: ${high0?.l}, ${high1?.l}, ${high2?.l})`);
  } finally { await browser.close(); }
}

try {
  if (wanted.includes('firefox')) {
    const addon = zipFolder(builds.firefox, path.join(dir, 'hypernab.xpi'));
    await run('firefox', () => firefoxBrowser('C:/Program Files/Mozilla Firefox/firefox.exe', tools.geckodriver, path.join(dir, 'profile-firefox'), addon));
  }
  if (wanted.includes('chrome')) await run('chrome', () => chromiumBrowser(tools.chrome, path.join(dir, 'profile-chrome'), [builds.chromium]));
} catch (error) { console.log('BETİK HATASI ' + error.message); results.push({ browser: 'betik', name: error.message, ok: false }); }
finally {
  for (const server of [logServer, childServer, topServer]) server.close();
  console.log(results.every(item => item.ok) && results.length ? 'SONUÇ: hepsi geçti' : 'SONUÇ: başarısız var');
  console.log(`çıktı klasörü (silinmedi, ekran görüntüleri için): ${dir}`);
  process.exit(results.every(item => item.ok) && results.length ? 0 : 1);
}
