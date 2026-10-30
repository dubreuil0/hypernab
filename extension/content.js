// Isolated-world metadata only. No page scripts, cookies, keys or request headers are read. Also draws the optional download button.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const videos = new WeakSet();
  let last = '', drm = false, queued = false;
  const closers = new Set(); // every open overlay of this window can close its panel
  const refreshers = new Set(); // ...and look the page up again when it changes
  // In Firefox a content script's globalThis is a sandbox, NOT the page window: comparing against it is always "different".
  // Every window identity check therefore uses the real window object.
  const win = globalThis.window ?? globalThis;
  const STAY_VISIBLE_PX = 140; // the button hides once the video's bottom edge is this close to the top of the window
  // A frame inside another page (the usual embedded player). The top-level page draws the button for it.
  const isChild = (() => { try { return Boolean(win.top) && win.self !== win.top; } catch { return true; } })();
  function report(video) {
    const url = video?.currentSrc || video?.src || '';
    const message = { type: 'hypernab:media-context', title: document.title.slice(0, 240), url: /^https?:/i.test(url) ? url : null, playerBlob: /^blob:/i.test(url), height: video?.videoHeight || null, width: video?.videoWidth || null, duration: Number.isFinite(video?.duration) ? video.duration : null, drm };
    const identity = JSON.stringify(message);
    if (identity === last) return; last = identity;
    try { Promise.resolve(api.runtime.sendMessage(message)).catch(() => {}); }
    catch { /* A reloaded/uninstalled extension can invalidate an older content script. */ }
  }

  // Floating "download this video" button. Same rule on every site; closed shadow root so page styles/scripts cannot
  // reach it. It only asks the extension to open its panel: nothing starts without the user pressing Start.
  // getRect() returns the video's box in THIS window's viewport, or null when it is gone. onClose(why) gets 'closed' or 'gone'.
  function drawOverlay(getRect, onClose = () => {}) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
    const root = host.attachShadow({ mode: 'closed' });
    // Semi-transparent on purpose: the page text behind stays readable. Full strength on hover or while dragging.
    const css = '.panel{overscroll-behavior:contain;position:fixed;width:min(320px,calc(100vw - 16px));box-sizing:border-box;background:#161b13;color:#e8f0e0;border:1px solid #3b4a2c;border-radius:10px;box-shadow:0 8px 28px #0009;font:13px system-ui,sans-serif;padding:12px;display:flex;flex-direction:column;gap:8px}.panel[hidden]{display:none}.ptitle{font-weight:600;line-height:1.3;max-height:2.6em;overflow:hidden}.pmeta{color:#9fb08e;font-size:11px}.opts{overscroll-behavior:contain;display:flex;flex-direction:column;gap:4px;max-height:210px;overflow:auto}.opt{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:6px;padding:5px 6px 5px 9px;border-radius:6px;cursor:pointer;border:1px solid transparent;background:#1f2819;box-sizing:border-box}.opt:hover{background:#2a3822;border-color:#47603a}.opt:focus-visible{outline:2px solid #c7ff90}.opt small{color:#9fb08e;padding-right:4px;font-size:11px;white-space:nowrap}.oname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ib{all:unset;cursor:pointer;min-width:24px;height:24px;padding:0 4px;box-sizing:border-box;border-radius:6px;display:grid;place-items:center;border:1px solid #47603a;background:#10170c;color:#c7ff90;font:700 12px system-ui,sans-serif}.ib:hover{background:#2f4126}.ib.now{background:#c7ff90;color:#10170c;border-color:#c7ff90}.ib.now:hover{background:#d8ffb0}.panel.busy{opacity:.6;pointer-events:none}.go{all:unset;text-align:center;cursor:pointer;color:#10170c;background:#c7ff90;padding:9px;border-radius:6px;font-weight:700}.go:disabled{opacity:.5;cursor:default}.sub{all:unset;cursor:pointer;color:#9fd070;font-size:11px;text-align:center}.skel{height:32px;border-radius:6px;background:linear-gradient(90deg,#1f2819,#2a3822,#1f2819);background-size:200% 100%;animation:sh 1.2s linear infinite}@keyframes sh{to{background-position:-200% 0}}.err{color:#ffb4a0;line-height:1.4}.toast{position:fixed;font:600 11px system-ui,sans-serif;color:#10170c;background:#c7ff90;padding:4px 9px;border-radius:5px;box-shadow:0 2px 8px #0006;white-space:nowrap}.toast[hidden]{display:none}.bar{position:fixed;display:flex;align-items:center;gap:2px;font:600 12px system-ui,sans-serif;border-radius:6px;overflow:hidden;box-shadow:0 1px 6px #0005;opacity:.5;transition:opacity .15s;cursor:grab;user-select:none;touch-action:none}.bar:hover,.bar.drag{opacity:1}.bar.drag{cursor:grabbing}button{all:unset;cursor:pointer;color:#10170c;background:#c7ff90;padding:7px 11px}button.x{background:#2a3322;color:#c7ff90;padding:7px 8px}button:hover{filter:brightness(1.1)}.hint{position:fixed;font:12px system-ui,sans-serif;color:#fff;background:#222c;padding:5px 8px;border-radius:4px}';
    const bar = document.createElement('div'); bar.className = 'bar';
    const start = document.createElement('button'); try { const dot = document.createElement('span'); dot.className = 'dot'; const svg = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg') ?? document.createElement('i'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M12 4v11M7 10.5l5 5 5-5M5 20h14'); svg.append(path); dot.append(svg); const label = document.createElement('span'); label.textContent = 'İndir'; start.append(dot, label); } catch { start.textContent = 'İndir'; } start.title = 'Hypernab ile indir — kaliteleri göster'; start.setAttribute?.('aria-label', 'Hypernab ile indir');
    const close = document.createElement('button'); close.className = 'x'; close.textContent = '×'; close.title = 'Bu sayfada gizle';
    const hint = document.createElement('div'); hint.className = 'hint'; hint.hidden = true;
    const panel = document.createElement('div'); panel.className = 'panel'; panel.hidden = true;
    // Scrolling inside the panel never scrolls the page behind it: the quality list scrolls on its own and, once it hits either end,
    // the wheel is swallowed instead of being passed on; elsewhere on the panel the wheel does nothing to the page.
    panel.addEventListener('wheel', event => {
      const list = panel.querySelector?.('.opts');
      const overList = Boolean(list) && (event.composedPath?.() || []).includes(list);
      if (overList && list.scrollHeight > list.clientHeight) {
        const up = event.deltaY < 0, atTop = list.scrollTop <= 0, atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
        if ((up && atTop) || (!up && atBottom)) event.preventDefault();
      } else event.preventDefault();
    }, { passive: false });
    const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = '✓ Kuyruğa eklendi'; toast.hidden = true;
    toast.setAttribute?.('role', 'status'); toast.setAttribute?.('aria-live', 'polite');
    bar.append(start, close); root.append(bar, panel, toast, hint);
    // A constructed stylesheet is not blocked by a page's Content-Security-Policy (an inline <style> can be); fall back to <style> only without it.
    const dupeCss = '.dupe{background:#262015;border:1px solid #6b5a2c;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;font-size:11px;line-height:1.5;color:#f2e3b8}.dupe .pactions{display:flex;gap:8px}.dupe .go{padding:7px;font-size:11px;background:#e3c870;color:#1a1608}.dupe .sub{padding:7px;border:1px solid #6b5a2c;border-radius:8px;color:#f2e3b8}';
    // Calm, solid look: no blur, no large shadows. Motion is one short fade-in per open (transform/opacity only) and is off with reduced motion.
    const premiumCss = '.bar{border-radius:999px!important;background:#171c1f!important;border:1px solid #354039!important;box-shadow:0 2px 8px #0004!important;opacity:.8;transition:opacity .12s ease!important}.bar:hover,.bar.drag{opacity:1!important}.bar button{display:flex!important;align-items:center;gap:6px;color:#edf2ee!important;background:transparent!important;padding:4px 10px 4px 4px!important;font:600 11px system-ui,sans-serif!important}.bar .x{padding:4px 9px!important;color:#93a19f!important;font-weight:400!important}.bar .dot{width:20px;height:20px;border-radius:50%;background:#b6f36b;color:#142010;display:grid;place-items:center;flex:none}.bar .dot svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.panel{border-radius:14px!important;background:#14181a!important;border:1px solid #2b3439!important;box-shadow:0 8px 20px #0006!important;animation:rise .14s ease-out}@keyframes rise{from{opacity:0;transform:translateY(4px)}}.ptitle{font-size:12.5px!important;font-weight:600;color:#edf2ee}.pmeta{color:#93a19f!important}.pactions .go{border-radius:10px!important;background:#b6f36b!important;color:#142010!important}.pactions .sub{border-radius:10px!important}.quality,.opt{border-radius:10px!important}.opt.preferred{border-color:#b6f36b66!important}.toast{border-radius:999px!important;box-shadow:none!important;background:#b6f36b!important;color:#142010!important}@media(prefers-reduced-motion:reduce){.panel{animation:none}.bar{transition:none!important}}';
    const compactCss = '.panel{width:min(280px,calc(100vw - 16px));background:#171c1f;border-color:#354039;border-radius:12px;padding:12px;gap:10px;max-height:calc(100vh - 16px);overflow:auto}.bar{border-radius:7px!important;background:#b6f36b!important;box-shadow:0 2px 8px #0003!important}.bar button{font:600 11px system-ui,sans-serif!important;padding:5px 8px!important}.bar .x{padding:5px!important}.ptitle{font-size:12px;white-space:nowrap;text-overflow:ellipsis;max-height:none;color:#edf2ee}.pmeta{color:#93a19f;font-size:11px;line-height:1.5}.quality{width:100%;box-sizing:border-box;background:#101618;color:#edf2ee;border:1px solid #3b4840;border-radius:8px;padding:9px;font:12px system-ui,sans-serif}.quality:focus-visible,.go:focus-visible,.sub:focus-visible{outline:2px solid #b6f36b;outline-offset:2px}.pactions{display:flex;gap:8px;align-items:center}.pactions .go{flex:1;padding:8px;border-radius:8px;font-size:12px;background:#b6f36b}.pactions .sub{padding:8px;border:1px solid #354039;border-radius:8px;color:#d0dacd;font-size:11px}.detail{font:11px system-ui,sans-serif;color:#93a19f}.detail summary{cursor:pointer}.detail p{margin:6px 0 0;line-height:1.6}.skel{height:34px;background:#26312a;animation:none}.panel.busy{pointer-events:auto}.panel.busy button,.panel.busy select{pointer-events:none;opacity:.5}';
    const listCss = '.opts{max-height:min(300px,55vh);gap:5px}.opt{grid-template-columns:minmax(0,1fr) 26px 26px;gap:6px;padding:7px 8px;background:#20272b;border-color:#2b3439;border-radius:8px;min-height:44px}.opt:hover{background:#2a3430;border-color:#638447}.opt.preferred{border-color:#638447;background:#222e23}.option-copy{min-width:0}.oname{display:block;font-size:11px;font-weight:600}.opt small{display:block;font-size:10px;color:#93a19f;margin-top:3px;padding:0}.ib{padding:0;width:26px;height:26px;background:transparent;color:#b6f36b;border-color:#3b4b3b}.ib.now{background:#b6f36b;border-color:#b6f36b;color:#142010}.ib svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.ib:focus-visible{outline:2px solid #b6f36b;outline-offset:2px}.opts>.sub{padding:7px;font-size:10px}.panel.busy .opt{pointer-events:none;opacity:.55}';
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) { const sheet = new CSSStyleSheet(); sheet.replaceSync(css + compactCss + listCss + dupeCss + premiumCss); root.adoptedStyleSheets = [sheet]; }
      else throw new Error('no constructed stylesheets');
    } catch { const style = document.createElement('style'); style.textContent = css + compactCss + listCss + dupeCss + premiumCss; root.append(style); }
    document.body.append(host);
    // Default spot: just OUTSIDE the video, above its top-right corner. If the video touches the top of the window,
    // use the space to its right, and only as a last resort the inside corner. The user can drag it anywhere on the page:
    // that shift lives in this variable only (never stored; gone on reload) and follows the video while scrolling.
    let offset = { x: 0, y: 0 }, timer = null, drag = null, moved = false, removed = false;
    // A click inside an embedded player frame never reaches this window; the frame tells us (hypernab:outside) and we close here too.
    const closer = () => { if (!panel.hidden) closePanel(); };
    closers.add(closer);
    const remove = why => {
      if (removed) return; removed = true; closers.delete(closer); refreshers.delete(refresher); clearInterval(timer); stopDrag(); closePanel(); host.remove(); if (why) onClose(why);
    };
    // The placement mode is decided ONCE from where the video sits in the page, then kept. Re-deciding on every tick made the
    // button jump left/right while scrolling. Vertically the button is never clamped to the window: it travels with the video,
    // slides out of the window and is simply hidden once fully out; scrolling back brings it up again in the same spot.
    let mode = null;
    const place = () => {
      const rect = getRect();
      if (!rect) { remove('gone'); return; }
      const width = win.innerWidth || 1200, height = win.innerHeight || 800;
      // The button stays while a good part of the video is still on screen (not only until its top edge leaves the window).
      const visible = rect.width >= 240 && rect.bottom > STAY_VISIBLE_PX && rect.top < height;
      bar.style.display = visible ? 'flex' : 'none';
      panel.style.visibility = toast.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      const w = bar.offsetWidth, h = bar.offsetHeight, gap = 6;
      if (!mode) {
        const roomAbove = rect.top + (win.scrollY || win.pageYOffset || 0) >= h + gap + 4; // room in the PAGE, not in the current window
        mode = roomAbove ? 'above' : rect.right + gap + w <= width ? 'side' : 'inside';
      }
      let left = mode === 'above' ? rect.right - w : mode === 'side' ? rect.right + gap : rect.right - w - 8;
      let top = mode === 'above' ? rect.top - h - gap : mode === 'side' ? rect.top : rect.top + 8;
      left = Math.min(Math.max(4, left + offset.x), Math.max(4, width - w - 4)); // sideways stays inside the window
      top += offset.y;
      // Instead of sliding out with the video's top edge, the button sticks to the top of the window while the video is still
      // visible, and disappears only once little of the video is left (it reappears in its own spot when scrolling back).
      if (top < 4) top = 4;
      if (top >= height) { bar.style.display = 'none'; panel.style.visibility = toast.style.visibility = 'hidden'; return; }
      bar.style.left = `${left}px`; bar.style.top = `${top}px`;
      if (!toast.hidden) { toast.style.left = `${Math.max(4, left + w - (toast.offsetWidth || 110))}px`; toast.style.top = `${top + h + 4}px`; }
      if (!panel.hidden) { // the panel hangs under the button, right edges aligned; above it when the window has no room below
        const pw = panel.offsetWidth || 320, ph = panel.offsetHeight || 0;
        panel.style.left = `${Math.min(Math.max(4, left + w - pw), Math.max(4, width - pw - 4))}px`;
        panel.style.top = `${top + h + 6 + ph > height - 4 && top - ph - 6 >= 4 ? top - ph - 6 : top + h + 6}px`;
      }
      hint.style.left = bar.style.left; hint.style.top = `${Math.min(Math.max(0, top + h + 4), height - 30)}px`;
    };
    const onMove = event => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 4) return; // a plain click is not a drag
      moved = true; offset = { x: drag.ox + dx, y: drag.oy + dy }; place();
    };
    function stopDrag() {
      drag = null; bar.classList.remove('drag');
      win.removeEventListener?.('pointermove', onMove, true); win.removeEventListener?.('pointerup', stopDrag, true); win.removeEventListener?.('pointercancel', stopDrag, true);
    }
    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; moved = false; bar.classList.add('drag');
      // Listen on the window, not the bar: a quick move can leave the small bar, and pointer capture would redirect clicks.
      win.addEventListener('pointermove', onMove, true); win.addEventListener('pointerup', stopDrag, true); win.addEventListener('pointercancel', stopDrag, true);
      event.preventDefault();
    });
    // After a real drag the browser still fires a click on release: swallow that one so dragging never opens the panel or hides the button.
    bar.addEventListener('click', event => { if (moved) { moved = false; event.stopImmediatePropagation(); event.preventDefault(); } }, true);
    close.addEventListener('click', () => remove('closed'));
    // ---- Floating panel (floating panel): quality list + Download, right on the page. Nothing starts until the user presses the button.
    const message = body => {
      try { return Promise.resolve(api.runtime.sendMessage({ type: 'hypernab:float', ...body })).then(answer => answer || { ok: false, code: 'REPLY_LOST', error: 'Gönderimin sonucu doğrulanamadı.' }, () => ({ ok: false, code: 'REPLY_LOST', error: 'Eklentiyle bağlantı kesildi; gönderimin sonucu doğrulanamadı.' })); }
      catch { return Promise.resolve({ ok: false, code: 'REPLY_LOST', error: 'Eklentiyle bağlantı kesildi; gönderimin sonucu doğrulanamadı.' }); }
    };
    const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
    // The first look-up starts when the button appears and runs WITHOUT cookies; the user's click later may add the session.
    let lookup = null, lookupPage = '', loadSerial = 0, outside = null, shownSig = '';
    let pendingStart = null, toastTimer = null, refreshPending = false;
    // Single-page sites switch videos without reloading: an old look-up must not be shown for the new video.
    const prefetch = () => {
      const page = String(win.location?.href || '');
      if (lookupPage !== page) { lookup = null; lookupPage = page; }
      return (lookup ||= message({ action: 'inspect', cookies: false }));
    };
    async function load() {
      let result = await prefetch();
      if (!result.ok && result.code === 'none') { lookup = null; result = await prefetch(); }
      if (!result.ok && result.code === 'needs-session') result = await message({ action: 'inspect', cookies: true }); // the click is the user's action
      if (!result.ok) lookup = null;
      return result;
    }
    function closePanel() {
      loadSerial++; panel.hidden = true; panel.replaceChildren?.();
      if (outside) { win.removeEventListener?.('pointerdown', outside, true); win.removeEventListener?.('keydown', outside, true); outside = null; }
    }
    function openPanel() {
      if (!panel.hidden) { closePanel(); return; }
      panel.hidden = false; showLoading(); place();
      outside = event => { if (event.type === 'keydown' ? event.key === 'Escape' : event.target !== host) closePanel(); };
      win.addEventListener('pointerdown', outside, true); win.addEventListener('keydown', outside, true);
      const serial = ++loadSerial;
      load().then(result => { if (serial === loadSerial && !panel.hidden) { showResult(result); place(); } });
    }
    function showLoading() {
      panel.replaceChildren(el('div', 'ptitle', 'Hazırlanıyor…'), el('div', 'skel'));
    }
    function showError(text, retry = true) {
      const children = [el('div', 'err', text)];
      const open = el('button', 'sub', 'Eklenti penceresini aç'); open.addEventListener('click', () => { closePanel(); try { api.runtime.sendMessage({ type: 'hypernab:open-panel' }); } catch { /* extension reloaded */ } }); children.push(open);
      panel.replaceChildren(...children);
    }
    function showResult(result) {
      shownSig = JSON.stringify(result);
      if (!result.ok) { showError(result.error || 'Video bilgisi alınamadı.', result.code !== 'drm'); return; }
      const options = result.options || [], main = options.filter(option => option.recommended !== false), more = options.filter(option => option.recommended === false);
      const list = el('div', 'opts'), note = el('div', 'err'); note.hidden = true;
      let expanded = false, go = null;
      async function begin(optionId, mode, allowDuplicate = false) {
        if (pendingStart?.working) return;
        const page = String(win.location?.href || '');
        // The outbox and receipt check in float.js use this SAME id after an ambiguous reply, even if the panel redraws.
        if (!pendingStart || !pendingStart.ambiguous || pendingStart.page !== page) pendingStart = { page, optionId, mode, intentId: globalThis.crypto?.randomUUID?.() || null };
        const intent = pendingStart; intent.working = true;
        note.hidden = true; panel.classList.add('busy'); panel.setAttribute?.('aria-busy', 'true');
        const previous = go?.textContent; if (go) go.textContent = 'Hazırlanıyor…';
        note.className = 'pmeta'; note.textContent = 'Hazırlanıyor…'; note.hidden = false;
        let answer;
        for (let attempt = 0; attempt < 3; attempt++) {
          answer = await message({ action: 'start', optionId: intent.optionId, mode: intent.mode, intentId: intent.intentId, ...(allowDuplicate ? { allowDuplicate: true } : {}) });
          if (answer.code !== 'REPLY_LOST') break;
        }
        intent.working = false; intent.ambiguous = answer.code === 'REPLY_LOST';
        if (!intent.ambiguous) pendingStart = null;
        panel.classList.remove('busy'); panel.setAttribute?.('aria-busy', 'false'); if (go) go.textContent = previous; note.hidden = true;
        if (removed || page !== String(win.location?.href || '')) return;
        if (answer.ok) {
          toast.textContent = answer.queued ? '✓ Kuyruğa eklendi' : '✓ İndirmeye eklendi';
          closePanel(); toast.hidden = false; place(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
          if (refreshPending) { refreshPending = false; refresher(); }
          return;
        }
        if (panel.hidden) return;
        if (answer.code === 'duplicate') { askDuplicate(answer, optionId, mode); return; }
        if (answer.refresh?.ok) { lookup = Promise.resolve(answer.refresh); showResult(answer.refresh); const warning = panel.querySelector?.('.err'); if (warning) { warning.textContent = answer.error; warning.hidden = false; } place(); return; }
        const errorNote = panel.querySelector?.('.err') || note;
        errorNote.className = 'err'; errorNote.textContent = answer.error || 'Başlatılamadı.'; errorNote.hidden = false;
      }
      // The same source in the same quality is already in the app: say so, and let the user decide. Nothing is removed or replaced.
      const states = { running: 'iniyor', queued: 'sırasını bekliyor', held: 'sonra eklenenlerde', paused: 'duraklatıldı', interrupted: 'kesintiye uğradı', completed: 'tamamlandı' };
      function askDuplicate(answer, optionId, mode) {
        panel.querySelector?.('.dupe')?.remove();
        const box = el('div', 'dupe'), actions = el('div', 'pactions');
        for (const item of (answer.duplicates || []).slice(-2)) box.append(el('div', '', `• ${item.title === 'video' ? 'Adsız video' : item.title}${item.formatLabel ? ` · ${item.formatLabel}` : ''} — ${states[item.status] || item.status}`));
        box.prepend(el('div', '', 'Bu video aynı kalitede zaten listede:'));
        const again = el('button', 'go', 'Yine de indir'), cancel = el('button', 'sub', 'Vazgeç');
        again.addEventListener('click', () => { box.remove(); begin(optionId, mode, true); }); cancel.addEventListener('click', () => box.remove());
        actions.append(again, cancel); box.append(actions); panel.append(box); place();
      }
      const rowButton = (kind, title, act) => {
        const button = el('button', `ib ${kind}`); button.title = title; button.setAttribute('aria-label', title);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', kind === 'now' ? 'M12 4v12m-5-5 5 5 5-5M5 20h14' : 'M4 6h12M4 12h12M4 18h6m8-4v8m-4-4h8');
        svg.append(path); button.append(svg);
        button.addEventListener('click', event => { event.stopPropagation(); act(); }); return button;
      };
      // Complete files the page loaded sit under the qualities: MP4 and other common containers in view, odd containers and sound folded away.
      const files = result.files || [], primaryRows = [...main, ...files.filter(file => file.main)], extraRows = [...more, ...files.filter(file => !file.main)];
      const draw = () => {
        list.replaceChildren();
        for (const option of expanded ? [...primaryRows, ...extraRows] : primaryRows) {
          const row = el('div', `opt${option.id === result.defaultOptionId ? ' preferred' : ''}`), text = el('div', 'option-copy');
          row.tabIndex = 0; row.setAttribute('role', 'group'); row.setAttribute('aria-label', option.label);
          row.title = `${option.label} · ${option.size} — hemen indir`;
          text.append(el('span', 'oname', option.label), el('small', '', option.size));
          row.append(text, rowButton('now', `${option.label} indir`, () => begin(option.id, 'now')), rowButton('later', `${option.label} sonra ekle`, () => begin(option.id, 'queue')));
          row.addEventListener('click', () => begin(option.id, 'now'));
          row.addEventListener('keydown', event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); begin(option.id, 'now'); } });
          list.append(row);
        }
        if (extraRows.length) {
          const toggle = el('button', 'sub', expanded ? 'Diğer kaynakları gizle' : `Diğer kaynaklar (${extraRows.length})`);
          toggle.setAttribute('aria-expanded', String(expanded)); toggle.addEventListener('click', () => { expanded = !expanded; draw(); place(); }); list.append(toggle);
        }
      };
      const meta = [result.duration, !options.length ? result.fileNote : null].filter(Boolean).join(' · ');
      const children = [el('div', 'ptitle', result.title || 'Video'), ...(meta ? [el('div', 'pmeta', meta)] : []), ...(result.alert ? [el('div', 'err', result.alert)] : [])];
      const hasRows = options.length > 0 || files.length > 0;
      if (hasRows) draw();
      const detail = el('details', 'detail'), facts = el('p', ''), actions = el('div', 'pactions');
      detail.append(el('summary', '', 'Ayrıntılar'), facts);
      const defaultOption = options.find(option => option.id === result.defaultOptionId) || options[0];
      facts.textContent = [defaultOption ? ({ included: 'Ses dahil', merged: 'Ses birleştirilir', none: 'Ses yok' }[defaultOption.audio]) : result.qualityNote, result.sessionUsed ? 'Tarayıcı oturumun kullanılıyor' : null, result.warning].filter(Boolean).join(' · ') || 'Kaynak olduğu gibi indirilir.';
      if (!options.length) {
        go = el('button', 'go', 'İndir'); const later = el('button', 'sub', 'Sonra ekle');
        go.addEventListener('click', () => begin(null, 'now')); later.addEventListener('click', () => begin(null, 'queue'));
        actions.append(go, later); children.push(actions);
      }
      if (hasRows) children.push(list);
      children.push(detail);
      panel.replaceChildren(...children, note);
    }
    start.addEventListener('click', () => { if (!moved) openPanel(); });
    // The page changed under the panel (new video, new quality, new source captured): look again, without cookies and without
    // touching anything the user is doing. An open panel is redrawn only when its content really differs.
    const refresher = () => {
      if (removed) return;
      if (pendingStart?.working) { refreshPending = true; return; }
      lookup = null; lookupPage = String(win.location?.href || '');
      if (panel.hidden) { prefetch(); return; }
      const mine = ++loadSerial;
      load().then(result => {
        if (mine !== loadSerial || panel.hidden || panel.classList.contains('busy') || JSON.stringify(result) === shownSig) return;
        showResult(result); place();
      });
    };
    refreshers.add(refresher);
    prefetch();
    timer = setInterval(place, 400); place();
    return { remove: () => remove(null) };
  }

  // Video in this very frame (e.g. the top-level page): draw right here.
  let localOverlay = null, dismissedLocal = false;
  function showLocal(video) {
    try {
      if (dismissedLocal || localOverlay || !document.body) return;
      localOverlay = drawOverlay(() => video.isConnected ? video.getBoundingClientRect() : null, why => { localOverlay = null; if (why === 'closed') dismissedLocal = true; });
    } catch { /* Overlay is optional; capture keeps working without it. */ }
  }

  // Video inside an embedded frame: the frame cannot draw outside itself, so it reports the video's box to its parent
  // page (which knows where the frame sits) and that page draws the button. If nobody above answers, draw locally.
  let sharing = null, acked = false;
  function share(video) {
    if (sharing) return;
    let sent = 0;
    const tell = message => { try { win.parent.postMessage({ type: 'hypernab:rect', ...message }, '*'); } catch { /* parent unreachable */ } };
    const tick = () => {
      if (!video.isConnected || drm) { clearInterval(sharing?.timer); sharing = null; tell({ gone: true }); return; }
      const r = video.getBoundingClientRect();
      tell({ rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
      sent++;
      if (acked && localOverlay) { localOverlay.remove(); localOverlay = null; }
      else if (!acked && sent >= 5) showLocal(video);
    };
    sharing = { timer: setInterval(tick, 400) }; tick();
  }

  // Parent side: place the child's box in this window's coordinates, then draw it here or pass it one level up.
  const remote = new Map(); // iframe element -> { rect, at, overlay, dismissed }
  function onMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hypernab:rect-ack') { if (isChild && event.source === win.parent) acked = true; return; }
    if (data.type === 'hypernab:outside') {
      if (event.source === win) return;
      let known = false; for (const element of document.querySelectorAll('iframe')) { if (element.contentWindow === event.source) { known = true; break; } }
      if (!known) return; // only our own child frames can close the panel
      for (const close of closers) close();
      if (isChild) { try { win.parent.postMessage({ type: 'hypernab:outside' }, '*'); } catch { /* parent unreachable */ } }
      return;
    }
    if (data.type !== 'hypernab:rect' || event.source === win) return;
    let frame = null;
    for (const element of document.querySelectorAll('iframe')) { if (element.contentWindow === event.source) { frame = element; break; } }
    if (!frame) return; // not one of our child frames
    if (data.gone) { const entry = remote.get(frame); entry?.overlay?.remove(); if (entry) entry.overlay = null; return; }
    const r = data.rect;
    if (!r || ![r.left, r.top, r.width, r.height].every(Number.isFinite)) return;
    const box = frame.getBoundingClientRect();
    const rect = { left: box.left + frame.clientLeft + r.left, top: box.top + frame.clientTop + r.top, width: r.width, height: r.height };
    rect.right = rect.left + rect.width; rect.bottom = rect.top + rect.height;
    try { event.source.postMessage({ type: 'hypernab:rect-ack' }, '*'); } catch { /* child went away */ }
    if (isChild) { try { win.parent.postMessage({ type: 'hypernab:rect', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }, '*'); } catch { /* parent unreachable */ } return; }
    let entry = remote.get(frame);
    if (!entry) { entry = { dismissed: false, overlay: null, rect: null, at: 0 }; remote.set(frame, entry); }
    entry.rect = rect; entry.at = Date.now();
    if (entry.dismissed || entry.overlay || !document.body) return;
    try {
      entry.overlay = drawOverlay(() => frame.isConnected && Date.now() - entry.at < 1500 ? entry.rect : null, why => { entry.overlay = null; if (why === 'closed') entry.dismissed = true; });
    } catch { /* Overlay is optional. */ }
  }
  win.addEventListener?.('message', onMessage);
  if (isChild) win.addEventListener?.('pointerdown', () => { try { win.parent.postMessage({ type: 'hypernab:outside' }, '*'); } catch { /* parent unreachable */ } }, true);

  function onPlaying(video) {
    try {
      if (drm || !document.body || !video.getBoundingClientRect || !document.createElement) return;
      const first = video.getBoundingClientRect();
      if (first.width < 240 || first.height < 135) return; // thumbnails, ad pixels, tiny previews
      if (isChild) share(video); else showLocal(video);
    } catch { /* Overlay is optional. */ }
  }
  // All <video> elements of the page, including those inside open shadow roots (many modern players use them).
  function allVideos(root = document, depth = 0, found = []) {
    try {
      for (const video of root.querySelectorAll('video')) found.push(video);
      if (depth < 6) for (const element of root.querySelectorAll('*')) if (element.shadowRoot) allVideos(element.shadowRoot, depth + 1, found);
    } catch { /* detached or restricted tree */ }
    return found;
  }
  const isPlaying = video => !video.paused && !video.ended && video.readyState >= 2;
  function scan() {
    queued = false;
    const found = allVideos();
    for (const video of found) {
      if (!videos.has(video)) {
        videos.add(video);
        for (const event of ['loadedmetadata', 'play', 'emptied', 'resize', 'durationchange']) video.addEventListener(event, () => report(video));
        video.addEventListener('playing', () => onPlaying(video));
        video.addEventListener('timeupdate', () => onPlaying(video)); // catches players whose size is only known after start
        video.addEventListener('encrypted', () => { drm = true; report(video); });
        report(video);
      }
      // Already playing before this script attached (autoplay, late-loaded script): no 'playing' event will ever come again.
      if (isPlaying(video)) onPlaying(video);
    }
    const video = found.find(isPlaying) ?? found[0];
    if (video) report(video);
  }
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(scan, 250); } }).observe(document.documentElement, { subtree: true, childList: true });
  setInterval(scan, 2000); // shadow-root content and late starts do not trigger the observer
  // ---- Subtitles of this frame's players. Read ONLY when the user has asked for a download (the background asks), never passively.
  // The browser already decoded every track the player loaded (any site, any format, even blob/obfuscated sources), so the text
  // comes from the player's own TextTrack cues. A track that was off is switched to "hidden" for a moment (nothing becomes visible)
  // and put back exactly as it was. Tracks the page may not read are passed on as their address instead.
  const cueClock = seconds => { const t = Math.max(0, Math.round(seconds * 1000)); return `${String(Math.floor(t / 3600000)).padStart(2, '0')}:${String(Math.floor(t / 60000) % 60).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`; };
  const cuesToVtt = cues => {
    let out = 'WEBVTT\n\n';
    for (const cue of cues) {
      const text = String(cue.text ?? '').replace(/-->/g, '->').trim();
      if (text && Number.isFinite(cue.startTime) && Number.isFinite(cue.endTime) && cue.endTime > cue.startTime) out += `${cueClock(cue.startTime)} --> ${cueClock(cue.endTime)}\n${text}\n\n`;
      if (out.length > 1500000) return '';
    }
    return out;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function collectSubtitles(serial) {
    const found = allVideos(); if (!found.length) return;
    const tracks = [], urls = [], seenUrl = new Set();
    for (const video of found) {
      for (const element of video.querySelectorAll?.('track') || []) {
        const src = element.src;
        if (/^https?:/i.test(src) && src.length <= 600 && !seenUrl.has(src) && urls.length < 12) { seenUrl.add(src); urls.push({ url: src, lang: String(element.srclang || '').slice(0, 20), label: String(element.label || '').slice(0, 60), default: element.default === true }); }
      }
      for (const track of Array.from(video.textTracks || [])) {
        if (!['subtitles', 'captions'].includes(track.kind) || tracks.length >= 12) continue;
        const original = track.mode;
        try {
          if (original === 'disabled') track.mode = 'hidden';
          for (let waited = 0; !(track.cues && track.cues.length) && waited < 1500; waited += 100) await sleep(100);
          const vtt = track.cues && track.cues.length ? cuesToVtt(Array.from(track.cues)) : '';
          if (vtt.length > 20) tracks.push({ lang: String(track.language || '').slice(0, 20), label: String(track.label || '').slice(0, 60), default: original === 'showing', vtt });
        } catch { /* a track the page may not read: its address (if any) was sent above */ }
        finally { try { if (track.mode !== original) track.mode = original; } catch { /* player removed it */ } }
      }
    }
    try { await Promise.resolve(api.runtime.sendMessage({ type: 'hypernab:subtitles', serial, tracks, urls })); } catch { /* extension reloaded */ }
  }
  // The background saw something new on this tab (a stream, a file, another address): redo the look-up of every open overlay.
  api.runtime?.onMessage?.addListener?.(message => {
    if (message?.type === 'hypernab:refresh') for (const refresh of refreshers) refresh();
    if (message?.type === 'hypernab:collect-subtitles' && Number.isFinite(message.serial)) void collectSubtitles(message.serial);
    return false;
  });
  // Single-page sites change the address without reloading.
  let seenHref = String(win.location?.href || '');
  setInterval(() => { const now = String(win.location?.href || ''); if (now !== seenHref) { seenHref = now; for (const refresh of refreshers) refresh(); } }, 1000);
  scan();
})();
