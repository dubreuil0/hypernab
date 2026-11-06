// Isolated-world metadata only. No page scripts, cookies, keys or request headers are read. Also draws the optional download button.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const DS = globalThis.HypernabDS, T = (key, vars) => globalThis.HypernabText.t(key, vars); // shared design system and texts (strings.js, ds.js)
  const retexts = new Set(); // every drawn button writes its words again when the language changes (a further language arrives a moment after the page)
  globalThis.HypernabText.follow?.(api, () => { for (const again of retexts) again(); }); // the panel speaks the app's language
  const videos = new WeakSet();
  let last = '', drm = false, queued = false;
  // Capture switched off on the toolbar icon: no button, no panel. Read once, then followed through storage changes.
  let captureOff = false;
  const removers = new Set(); // every overlay of this window can be taken down at once
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
    const bar = document.createElement('div'); bar.className = 'bar';
    const start = document.createElement('button'); start.className = 'start'; let startLabel;
    { const dot = document.createElement('span'); dot.className = 'dot'; dot.append(DS.icon(document, 'download')); const label = document.createElement('span'); label.textContent = T('panel.download'); start.append(dot, label); startLabel = label; }
    start.title = T('panel.download.title'); start.setAttribute?.('aria-label', T('panel.download.aria'));
    const close = document.createElement('button'); close.className = 'x'; close.append(DS.icon(document, 'close')); close.title = T('panel.hide'); close.setAttribute?.('aria-label', T('panel.hide'));
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
    const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = T('panel.toast.queued'); toast.hidden = true;
    const retext = () => { if (startLabel) startLabel.textContent = T('panel.download'); start.title = T('panel.download.title'); start.setAttribute?.('aria-label', T('panel.download.aria')); close.title = T('panel.hide'); close.setAttribute?.('aria-label', T('panel.hide')); };
    retexts.add(retext);
    toast.setAttribute?.('role', 'status'); toast.setAttribute?.('aria-live', 'polite');
    bar.append(start, close); root.append(bar, panel, toast, hint);
    // A constructed stylesheet is not blocked by a page's Content-Security-Policy (an inline <style> can be); fall back to <style> only without it.
    // The panel follows the system's light/dark and the app's accent: the first look-up reports them (result.look); until then dark/green.
    let look = { scheme: 'auto', accent: 'green' }, sheet = null, styleNode = null;
    const sheetText = () => DS.tokens(look.scheme, look.accent, ':host') + (globalThis.HypernabPanelCss || '');
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) { sheet = new CSSStyleSheet(); sheet.replaceSync(sheetText()); root.adoptedStyleSheets = [sheet]; }
      else throw new Error('no constructed stylesheets');
    } catch { sheet = null; styleNode = document.createElement('style'); styleNode.textContent = sheetText(); root.append(styleNode); }
    const applyLook = value => {
      const scheme = { dark: 'dark', light: 'light', system: 'auto' }[value?.theme], accent = ['green', 'blue', 'orange', 'violet'].includes(value?.accent) ? value.accent : null;
      if (!scheme || !accent || (scheme === look.scheme && accent === look.accent)) return;
      look = { scheme, accent };
      try { if (sheet) sheet.replaceSync(sheetText()); else if (styleNode) styleNode.textContent = sheetText(); } catch { /* keep the previous look */ }
    };
    document.body.append(host);
    // Default spot: just OUTSIDE the video, above its top-right corner. If the video touches the top of the window,
    // use the space to its right, and only as a last resort the inside corner. The user can drag it anywhere on the page:
    // that shift lives in this variable only (never stored; gone on reload) and follows the video while scrolling.
    let offset = { x: 0, y: 0 }, timer = null, drag = null, moved = false, removed = false;
    // A click inside an embedded player frame never reaches this window; the frame tells us (hypernab:outside) and we close here too.
    const closer = () => { if (!panel.hidden) closePanel(); };
    closers.add(closer);
    removers.add(() => remove('disabled'));
    const remove = why => {
      if (removed) return; removed = true; closers.delete(closer); refreshers.delete(refresher); retexts.delete(retext); clearInterval(timer); stopDrag(); closePanel(); host.remove(); if (why) onClose(why);
    };
    // The placement mode is decided ONCE from where the video sits in the page, then kept. Re-deciding on every tick made the
    // button jump left/right while scrolling. Vertically the button is never clamped to the window: it travels with the video,
    // slides out of the window and is simply hidden once fully out; scrolling back brings it up again in the same spot.
    let mode = null;
    const place = () => {
      panel.dir = toast.dir = hint.dir = globalThis.HypernabText.dir?.() || 'ltr';
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
      try { return Promise.resolve(api.runtime.sendMessage({ type: 'hypernab:float', ...body })).then(answer => answer || { ok: false, code: 'REPLY_LOST', error: T('panel.replyLost') }, () => ({ ok: false, code: 'REPLY_LOST', error: T('panel.replyLostDisconnected') })); }
      catch { return Promise.resolve({ ok: false, code: 'REPLY_LOST', error: T('panel.replyLostDisconnected') }); }
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
      // Escape closes an open sound list first, and the panel only when no list is open.
      outside = event => { if (event.type === 'keydown' ? event.key === 'Escape' && !panel.querySelector?.('.hd-select[data-open="true"]') : event.target !== host) closePanel(); };
      win.addEventListener('pointerdown', outside, true); win.addEventListener('keydown', outside, true);
      const serial = ++loadSerial;
      load().then(result => { if (serial === loadSerial && !panel.hidden) { showResult(result); place(); } });
    }
    function showLoading() {
      panel.replaceChildren(el('div', 'ptitle', T('panel.preparing')), el('div', 'skel'));
    }
    function showError(text, retry = true, appProblem = false) {
      const children = [el('div', 'err', text)];
      if (appProblem) { const get = el('a', 'sub hd-btn primary', T('panel.getApp')); get.href = 'https://github.com/dubreuil0/hypernab/releases/latest'; get.target = '_blank'; get.rel = 'noopener noreferrer'; children.push(get); }
      const open = el('button', 'sub hd-btn quiet', T('panel.openSettings')); open.addEventListener('click', () => { closePanel(); try { api.runtime.sendMessage({ type: 'hypernab:open-options' }); } catch { /* extension reloaded */ } }); children.push(open);
      panel.replaceChildren(...children);
    }
    function showResult(result) {
      shownSig = JSON.stringify(result);
      if (!result.ok) { showError(result.error || T('panel.infoFailed'), result.code !== 'drm', result.appProblem === true); return; }
      applyLook(result.look);
      const options = result.options || [], main = options.filter(option => option.recommended !== false), more = options.filter(option => option.recommended === false);
      const list = el('div', 'opts'), note = el('div', 'err'); note.hidden = true;
      let expanded = false, go = null;
      // Several sounds (dubbed / original ...): the one the player is playing is selected when that could be told; otherwise the site's
      // default, and the user can pick. What is chosen here is exactly what is downloaded.
      const sounds = result.audioTracks || [];
      let chosenAudio = sounds.length ? (sounds.find(track => track.id === result.audioPick?.id) || sounds.find(track => track.id === result.audioActive) || sounds.find(track => track.default) || sounds[0]).id : null;
      async function begin(optionId, mode, allowDuplicate = false) {
        if (pendingStart?.working) return;
        const page = String(win.location?.href || '');
        // The outbox and receipt check in float.js use this SAME id after an ambiguous reply, even if the panel redraws.
        if (!pendingStart || !pendingStart.ambiguous || pendingStart.page !== page) pendingStart = { page, optionId, mode, audioTrack: chosenAudio, intentId: globalThis.crypto?.randomUUID?.() || null };
        const intent = pendingStart; intent.working = true;
        note.hidden = true; panel.classList.add('busy'); panel.setAttribute?.('aria-busy', 'true');
        const previous = go?.textContent; if (go) go.textContent = T('panel.preparing');
        note.className = 'pmeta'; note.textContent = T('panel.preparing'); note.hidden = false;
        let answer;
        for (let attempt = 0; attempt < 3; attempt++) {
          answer = await message({ action: 'start', optionId: intent.optionId, mode: intent.mode, intentId: intent.intentId, ...(intent.audioTrack ? { audioTrack: intent.audioTrack } : {}), ...(allowDuplicate ? { allowDuplicate: true } : {}) });
          if (answer.code !== 'REPLY_LOST') break;
        }
        intent.working = false; intent.ambiguous = answer.code === 'REPLY_LOST';
        if (!intent.ambiguous) pendingStart = null;
        panel.classList.remove('busy'); panel.setAttribute?.('aria-busy', 'false'); if (go) go.textContent = previous; note.hidden = true;
        if (removed || page !== String(win.location?.href || '')) return;
        if (answer.ok) {
          toast.textContent = answer.queued ? T('panel.toast.queued') : T('panel.toast.started');
          closePanel(); toast.hidden = false; place(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
          if (refreshPending) { refreshPending = false; refresher(); }
          return;
        }
        if (panel.hidden) return;
        if (answer.code === 'duplicate') { askDuplicate(answer, optionId, mode); return; }
        if (answer.refresh?.ok) { lookup = Promise.resolve(answer.refresh); showResult(answer.refresh); const warning = panel.querySelector?.('.err'); if (warning) { warning.textContent = answer.error; warning.hidden = false; } place(); return; }
        const errorNote = panel.querySelector?.('.err') || note;
        errorNote.className = 'err'; errorNote.textContent = answer.error || T('panel.startFailed'); errorNote.hidden = false;
      }
      // The same source in the same quality is already in the app: say so, and let the user decide. Nothing is removed or replaced.
      // A download added for later (held) is shown as a paused one: that is all it is.
      const stateText = status => ['running', 'queued', 'paused', 'interrupted', 'completed'].includes(status) ? T(`panel.status.${status}`) : status === 'held' ? T('panel.status.paused') : status;
      function askDuplicate(answer, optionId, mode) {
        panel.querySelector?.('.dupe')?.remove();
        const box = el('div', 'dupe'), actions = el('div', 'pactions');
        for (const item of (answer.duplicates || []).slice(-2)) box.append(el('div', '', `• ${item.title === 'video' ? T('panel.unnamed') : item.title}${item.formatLabel ? ` · ${item.formatLabel}` : ''} — ${stateText(item.status)}`));
        box.prepend(el('div', '', T('panel.dupe.title')));
        const again = el('button', 'go hd-btn primary', T('panel.dupe.again')), cancel = el('button', 'sub hd-btn quiet', T('panel.dupe.cancel'));
        again.addEventListener('click', () => { box.remove(); begin(optionId, mode, true); }); cancel.addEventListener('click', () => box.remove());
        actions.append(again, cancel); box.append(actions); panel.append(box); place();
      }
      const rowButton = (kind, title, act) => {
        const button = el('button', `ib ${kind} hd-icon-btn${kind === 'now' ? ' filled' : ''}`); button.title = title; button.setAttribute('aria-label', title);
        button.append(DS.icon(document, kind === 'now' ? 'download' : 'queue'));
        button.addEventListener('click', event => { event.stopPropagation(); act(); }); return button;
      };
      // Complete files the page loaded sit under the qualities: MP4 and other common containers in view, odd containers and sound folded away.
      const files = result.files || [], primaryRows = [...main, ...files.filter(file => file.main)], extraRows = [...more, ...files.filter(file => !file.main)];
      const draw = () => {
        list.replaceChildren();
        for (const option of expanded ? [...primaryRows, ...extraRows] : primaryRows) {
          const row = el('div', `opt${option.id === result.defaultOptionId ? ' preferred' : ''}`), text = el('div', 'option-copy');
          row.tabIndex = 0; row.setAttribute('role', 'group'); row.setAttribute('aria-label', option.label);
          row.title = T('panel.row.title', { label: option.label, size: option.size });
          text.append(el('span', 'oname', option.label), el('small', '', option.size));
          row.append(text, rowButton('now', T('panel.row.now', { label: option.label }), () => begin(option.id, 'now')), rowButton('later', T('panel.row.later', { label: option.label }), () => begin(option.id, 'queue')));
          row.addEventListener('click', () => begin(option.id, 'now'));
          row.addEventListener('keydown', event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); begin(option.id, 'now'); } });
          list.append(row);
        }
        if (extraRows.length) {
          const toggle = el('button', 'sub hd-btn quiet', expanded ? T('panel.more.hide') : T('panel.more.show', { n: extraRows.length }));
          toggle.setAttribute('aria-expanded', String(expanded)); toggle.addEventListener('click', () => { expanded = !expanded; draw(); place(); }); list.append(toggle);
        }
      };
      const meta = [result.duration, !options.length ? result.fileNote : null].filter(Boolean).join(' · ');
      // Refresh sits next to the title: the page may have changed what it plays (language, source) without any request the extension could notice.
      const head = el('div', 'phead'), again = el('button', 'rfr hd-icon-btn');
      again.title = T('panel.refresh.title'); again.setAttribute('aria-label', T('panel.refresh.aria')); again.append(DS.icon(document, 'refresh'));
      again.addEventListener('click', event => { event.stopPropagation?.(); reloadFresh(); });
      head.append(el('div', 'ptitle', result.title || T('panel.video')), again);
      const children = [head, ...(meta ? [el('div', 'pmeta', meta)] : []), ...(result.alert ? [el('div', 'err', result.alert)] : [])];
      const hasRows = options.length > 0 || files.length > 0;
      if (hasRows) draw();
      if (sounds.length) {
        const row = el('div', 'soundrow'), hint = el('div', 'pmeta'), caption = el('div', 'pmeta');
        const codeOf = track => { const base = String(track.language || '').toLowerCase().split(/[-_]/)[0]; return /^[a-z]{2,3}$/.test(base) ? base.toUpperCase() : undefined; };
        const picker = DS.select(document, { label: T('panel.sound'), value: chosenAudio, onChange: value => { chosenAudio = value; },
          options: sounds.map(track => ({ value: track.id, code: codeOf(track), label: track.name || track.language || T('panel.sound.unnamed'),
            ...(track.id === result.audioActive ? { badge: { text: T('panel.sound.playing'), tone: 'live' } } : track.default ? { badge: { text: T('panel.sound.default') } } : {}) })) });
        hint.textContent = result.audioPick?.why === 'preference' ? T('panel.sound.hint.pref') : result.audioActive ? T('panel.sound.hint.playing') : T('panel.sound.hint.unknown');
        caption.append(DS.icon(document, 'sound'), el('span', '', T('panel.sound')));
        row.append(caption, picker.el, hint);
        children.push(row);
      }
      const detail = el('details', 'detail'), facts = el('p', ''), actions = el('div', 'pactions');
      detail.append(el('summary', '', T('panel.details')), facts);
      const defaultOption = options.find(option => option.id === result.defaultOptionId) || options[0];
      facts.textContent = [defaultOption ? (['included', 'merged', 'none'].includes(defaultOption.audio) ? T(`panel.audio.${defaultOption.audio}`) : null) : result.qualityNote, result.sessionUsed ? T('panel.session') : null, result.warning].filter(Boolean).join(' · ') || T('panel.asIs');
      if (!options.length) {
        go = el('button', 'go hd-btn primary', T('panel.download')); const later = el('button', 'sub hd-btn quiet', T('panel.later'));
        go.addEventListener('click', () => begin(null, 'now')); later.addEventListener('click', () => begin(null, 'queue'));
        actions.append(go, later); children.push(actions);
      }
      if (hasRows) children.push(list);
      children.push(detail);
      panel.replaceChildren(...children, note);
    }
    // Looks at the page from scratch (no cached answers) while the panel stays open.
    function reloadFresh() {
      if (removed || pendingStart?.working) return;
      const mine = ++loadSerial;
      showLoading(); place();
      lookupPage = String(win.location?.href || ''); lookup = message({ action: 'inspect', cookies: false, fresh: true });
      load().then(result => { if (mine === loadSerial && !panel.hidden) { showResult(result); place(); } });
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
    return { remove: () => remove(null), open: () => { if (panel.hidden) openPanel(); } };
  }

  // Video in this very frame (e.g. the top-level page): draw right here.
  let localOverlay = null, dismissedLocal = false;
  function showLocal(video) {
    try {
      if (captureOff || dismissedLocal || localOverlay || !document.body) return;
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
    if (captureOff || entry.dismissed || entry.overlay || !document.body) return;
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
    if (message?.type === 'hypernab:show-panel') showPanelFromMenu();
    return false;
  });
  // The toolbar menu's "Inspect this page": the top window opens the panel of the video it knows, or anchors one at the top right.
  function showPanelFromMenu() {
    if (isChild || captureOff || !document.body) return;
    let overlay = localOverlay || [...remote.values()].map(entry => entry.overlay).find(Boolean);
    if (!overlay) {
      const video = allVideos().find(isPlaying) ?? allVideos()[0];
      const getRect = video ? () => (video.isConnected ? video.getBoundingClientRect() : null) : () => { const w = win.innerWidth || 1200; return { left: w - 340, top: 90, width: 320, height: 180, right: w - 20, bottom: 270 }; };
      try { localOverlay = overlay = drawOverlay(getRect, why => { localOverlay = null; if (why === 'closed') dismissedLocal = true; }); } catch { return; }
    }
    overlay?.open?.();
  }
  try {
    Promise.resolve(api.storage?.local?.get?.('captureEnabled')).then(stored => { captureOff = stored?.captureEnabled === false; if (captureOff) for (const remove of [...removers]) remove(); }).catch(() => {});
    api.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local' || !changes.captureEnabled) return;
      captureOff = changes.captureEnabled.newValue === false;
      if (captureOff) for (const remove of [...removers]) remove(); else scan();
    });
  } catch { /* storage is optional for the content script */ }
  // Single-page sites change the address without reloading.
  let seenHref = String(win.location?.href || '');
  setInterval(() => { const now = String(win.location?.href || ''); if (now !== seenHref) { seenHref = now; for (const refresh of refreshers) refresh(); } }, 1000);
  scan();
})();
