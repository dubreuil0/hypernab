// Settings > Browser extension: how to put the extension into the user's browser, for every browser Hypernab supports. Chrome, Edge, Brave
// and Opera share one folder; Firefox takes a temporary add-on. Addresses and paths can be copied (a browser does not let a web page open
// its own extension pages). All texts come from strings.js keys.
export function setupExtensionHelp(extensionsFolder) {
  const T = globalThis.HypernabText.t, root = document.getElementById('extension-help');
  if (!root) return;
  const desktop = globalThis.hypernabDesktop;
  const h = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const chip = (text, label) => {
    const wrap = h('span', 'ext-chip'), copy = h('button', 'btn sm', T('ext.copy'));
    if (label) wrap.append(h('span', 'ext-label', label));
    copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); copy.textContent = T('ext.copied'); setTimeout(() => { copy.textContent = T('ext.copy'); }, 1600); } catch { /* the address stays readable */ } });
    wrap.append(h('code', '', text), copy);
    return wrap;
  };
  const folder = (extensionsFolder || 'build\\extensions').replace(/[\\/]+$/, '');
  const openButton = () => { if (!desktop) return null; const button = h('button', 'btn sm', T('ext.open')); button.type = 'button'; button.addEventListener('click', () => { desktop.action('extensions').catch(() => {}); }); return button; };
  const step = (text, ...extra) => { const li = h('li'); li.append(h('span', '', text)); const box = h('div', 'ext-extra'); for (const item of extra) if (item) box.append(item); if (box.children.length) li.append(box); return li; };
  const card = (title, hint, steps) => { const box = h('div', 'setting ext-card'), copy = h('div'), list = h('ol', 'steps'); copy.append(h('strong', '', title)); if (hint) copy.append(h('p', 'hint', hint)); list.append(...steps); copy.append(list); box.append(copy); return box; };
  root.replaceChildren(
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
