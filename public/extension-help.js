// Settings > Browser extension: how to put the extension into the user's browser, for every browser Hypernab supports. Chrome, Edge, Brave
// and Opera share one folder; Firefox takes a temporary add-on. Addresses and paths can be copied (a browser does not let a web page open
// its own extension pages). All texts come from strings.js keys.
export function setupExtensionHelp(extensionsFolder, getStatus) {
  const T = globalThis.HypernabText.t, root = document.getElementById('extension-help');
  if (!root) return;
  const desktop = globalThis.hypernabDesktop;
  const h = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const symbol = id => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); svg.setAttribute('class', 'ic'); use.setAttribute('href', `#${id}`); svg.append(use); return svg; };
  const iconButton = (word, id) => { const button = h('button', 'btn sm'), label = h('span', '', word); button.type = 'button'; button.append(symbol(id), label); button.setLabel = text => { label.textContent = text; }; return button; };
  const chip = (text, label) => {
    const wrap = h('span', 'ext-chip'), copy = iconButton(T('ext.copy'), 'i-copy');
    if (label) wrap.append(h('span', 'ext-label', label));
    copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); copy.setLabel(T('ext.copied')); setTimeout(() => { copy.setLabel(T('ext.copy')); }, 1600); } catch { /* the address stays readable */ } });
    wrap.append(h('code', '', text), copy);
    return wrap;
  };
  const folder = (extensionsFolder || 'build\\extensions').replace(/[\\/]+$/, '');
  const openButton = () => { if (!desktop) return null; const button = iconButton(T('ext.open'), 'i-folder'); button.addEventListener('click', () => { desktop.action('extensions').catch(() => {}); }); return button; };
  const step = (text, ...extra) => { const li = h('li'); li.append(h('span', '', text)); const box = h('div', 'ext-extra'); for (const item of extra) if (item) box.append(item); if (box.children.length) li.append(box); return li; };
  const card = (title, hint, steps) => { const box = h('div', 'setting ext-card'), copy = h('div'), list = h('ol', 'steps'); copy.append(h('strong', '', title)); if (hint) copy.append(h('p', 'hint', hint)); list.append(...steps); copy.append(list); box.append(copy); return box; };
  // The wizard (desktop app only): the browsers found on this computer, one button each, and a green mark when the extension reaches the app.
  const wizard = () => {
    const box = h('div', 'setting ext-card ext-wizard'), copy = h('div'), rows = h('div', 'ext-browsers'), guide = h('p', 'hint ext-guide'), state = h('p', 'ext-state');
    guide.hidden = true; copy.append(h('strong', '', T('ext.wizard.title')), h('p', 'hint', T('ext.wizard.hint')), rows, guide, state); box.append(copy);
    const mark = connected => { state.replaceChildren(h('span', `badge${connected ? ' ok' : ''}`, T(connected ? 'ext.wizard.connected.badge' : 'ext.wizard.waiting.badge')), h('span', 'hint', ` ${T(connected ? 'ext.wizard.connected' : 'ext.wizard.waiting')}`)); };
    mark(false);
    desktop.action('browsers').then(list => {
      if (!list.length) { rows.append(h('p', 'hint', T('ext.wizard.none'))); return; }
      for (const browser of list) {
        const button = iconButton(T('ext.wizard.setup', { browser: browser.name }), 'i-plug');
        button.addEventListener('click', async () => { button.disabled = true; try { const result = await desktop.action('browser-setup', browser.id); guide.textContent = T(`ext.wizard.guide.${result.family}`, { path: result.pick }); guide.hidden = false; } catch { guide.textContent = T('ext.wizard.failed'); guide.hidden = false; } finally { button.disabled = false; } });
        rows.append(button);
      }
    }).catch(() => rows.append(h('p', 'hint', T('ext.wizard.none'))));
    // while this page is on screen the mark follows the app's own knowledge of the extension (a look every few seconds)
    let attached = false; // the box is put on the page right after it is made; it stops looking once it has been taken off again
    const look = async () => { if (box.isConnected) attached = true; else { if (attached) clearInterval(timer); return; } if (box.offsetParent === null || !getStatus) return; try { mark((await getStatus()).connected === true); } catch { /* keep the last mark */ } };
    const timer = setInterval(look, 3000); void look();
    return box;
  };
  root.replaceChildren(
    ...(desktop ? [wizard()] : []),
    card(T('ext.chromium.title'), T('ext.chromium.hint'), [
      step(T('ext.chromium.s1'), chip('chrome://extensions', 'Chrome'), chip('edge://extensions', 'Edge'), chip('brave://extensions', 'Brave'), chip('opera://extensions', 'Opera')),
      step(T('ext.chromium.s2')),
      step(T('ext.chromium.s3'), chip(`${folder}\\chromium`), openButton()),
      step(T('ext.chromium.s4')),
    ]),
    card(T('ext.firefox.title'), T('ext.firefox.hint'), [
      step(T('ext.firefox.s1'), chip('about:debugging#/runtime/this-firefox')),
      step(T('ext.firefox.s2'), chip(`${folder}\\firefox\\manifest.json`), openButton()),
      step(T('ext.firefox.s3')),
    ]),
  );
}
