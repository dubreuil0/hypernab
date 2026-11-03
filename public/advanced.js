import { upgradeSelects } from './select-upgrade.js';
import { setupExtensionHelp } from './extension-help.js';
export function setupAdvanced(api, refreshStatus) {
  const $ = id => document.getElementById(id), desktop = globalThis.hypernabDesktop;
  let loaded = false;
  for (const node of document.querySelectorAll('.switch input, .setting-control select, .setting-control input')) {
    const title = node.closest('.setting')?.querySelector('strong')?.textContent;
    if (title) node.setAttribute('aria-label', title);
  }
  const post = (route, body) => api(route, { method: 'POST', body: JSON.stringify(body) });
  const show = (text, error = false) => { $('settings-saved').textContent = text; $('settings-saved').className = error ? 'saved error' : 'saved'; };
  const run = fn => async () => { try { await fn(); await refreshStatus(); show(T.t('app.saved')); } catch (error) { show(error.message, true); } };
  const save = async body => { await post('/api/settings', body); if (desktop) await desktop.action('settings-changed'); };
  $('open-settings').onclick = () => { $('view-downloads').hidden = true; $('view-history').hidden = true; $('open-history').setAttribute('aria-pressed', 'false'); $('view-settings').hidden = false; $('tabs').hidden = true; $('open-settings').setAttribute('aria-pressed', 'true'); };
  $('close-settings').onclick = () => { $('view-downloads').hidden = false; $('view-settings').hidden = true; $('tabs').hidden = false; $('open-settings').setAttribute('aria-pressed', 'false'); };
  for (let n = 1; n <= 16; n++) $('set-maxConnections').add(new Option(String(n), String(n)));
  const keys = ['interfaceLanguage', 'appearance', 'textSize', 'theme', 'accent', 'subtitleMode', 'smartNames', 'sortByType', 'watchClipboard', 'folderLayout', 'maxQuality', 'preferCompatible', 'maxConnections', 'autoRetries', 'deepVerifyDefault', 'notifyOnFinish', 'closeToTray', 'startMinimized'];
  for (const key of keys) {
    const node = $(`set-${key}`);
    node.onchange = run(async () => {
      await save({ [key]: node.type === 'checkbox' ? node.checked : ['interfaceLanguage', 'appearance', 'textSize', 'theme', 'accent', 'subtitleMode', 'folderLayout'].includes(key) || node.value === 'best' ? node.value : Number(node.value) });
      if (key === 'deepVerifyDefault') $('deep-verify').checked = node.checked;
    });
  }
  // Language preferences (shared design-system list with a search box; texts come from translation keys).
  const DS = globalThis.HypernabDS, T = globalThis.HypernabText, languageSelects = {};
  if (DS && T) {
    const ui = T.language(), system = ui; // "automatic" = the interface language
    const rows = [
      ['subtitleLanguage', 'lang.subtitle', [{ value: 'auto', label: T.t('lang.auto', { name: DS.languageInfo(system, ui).name }) }, { value: 'off', label: T.t('lang.off') }]],
      ['audioLanguage', 'lang.audio', [{ value: 'player', label: T.t('lang.player') }, { value: 'original', label: T.t('lang.original') }]],
    ];
    const container = [{ value: 'keep', label: T.t('sub.container.keep') }, { value: 'mkv', label: T.t('sub.container.mkv') }];
    for (const [key, prefix, first, plain] of [...rows.map(row => [...row, false]), ['subtitleContainer', 'sub.container', container, true]]) {
      const row = document.createElement('div'); row.className = 'setting';
      const copy = document.createElement('div'), title = document.createElement('strong'), hint = document.createElement('p'), control = document.createElement('div');
      title.textContent = T.t(`${prefix}.title`); hint.className = 'hint'; hint.textContent = T.t(`${prefix}.hint`); control.className = 'setting-control';
      const select = DS.select(document, plain
        ? { options: first, value: first[0].value, label: title.textContent, onChange: value => run(() => save({ [key]: value }))() }
        : { options: DS.languageOptions(DS.LANGUAGE_CODES, ui, first), value: first[0].value, label: title.textContent, search: true, searchLabel: T.t('lang.search'), emptyText: T.t('lang.empty'),
          onChange: value => run(() => save({ [key]: value }))() });
      languageSelects[key] = select; copy.append(title, hint); control.append(select.el); row.append(copy, control); $('language-settings').append(row);
    }
  }
  $('named-queue').onchange = run(() => save({ selectedQueue: $('named-queue').value }));
  $('new-queue').onclick = run(async () => { await save({ addQueue: $('new-queue-name').value }); $('new-queue-name').value = ''; });
  $('save-speed').onclick = run(() => save({ speedLimitKiB: Math.round(Number($('speed-limit-mb').value) * 1024) }));
  $('save-schedule').onclick = run(() => {
    const at = new Date($('schedule-at').value).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error(T.t('app.err.futureTime'));
    return post('/api/automation', { schedule: { at, queue: $('named-queue').value } });
  });
  $('cancel-schedule').onclick = run(() => post('/api/automation', { schedule: null }));
  $('arm-power').onclick = run(() => post('/api/automation', { power: $('power-action').value || null }));
  $('cancel-power').onclick = run(() => post('/api/automation', { power: null }));
  $('dir-change').onclick = run(async () => { const directory = desktop ? await desktop.action('pick-folder') : $('dir-input').value.trim(); if (directory) await save({ downloadDirectory: directory }); });
  $('dir-reset').onclick = run(() => save({ downloadDirectory: null }));
  if (desktop) {
    for (const id of ['s-desktop', 'nav-desktop', 'desktop-settings', 'open-downloads']) $(id).hidden = false;
    $('dir-edit').hidden = true;
    desktop.settings().then(info => { setupExtensionHelp(info.extensions, () => api('/api/extension')); $('desktop-startup').checked = info.startup; $('desktop-startup').disabled = !info.packaged; $('app-version').textContent = info.version; }).catch(error => show(error.message, true));
    $('desktop-startup').onchange = run(() => desktop.action('startup', $('desktop-startup').checked));
    for (const [id, action] of [['open-downloads', 'downloads'], ['repair-native', 'native']]) $(id).onclick = run(() => desktop.action(action));
  }
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = globalThis.HypernabText.t(node.dataset.t);
  // Every setting keeps its explanation behind a small "?" button instead of a paragraph under it (the text itself is unchanged).
  for (const row of document.querySelectorAll('#view-settings .setting:not(.ext-card)')) { // the browser-extension cards keep their own texts (steps, connection state)
    const copy = row.firstElementChild, title = copy?.querySelector('strong'), hint = copy?.querySelector('.hint');
    if (!hint || !title || row.querySelector('.help')) continue;
    const button = document.createElement('button'), icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    button.type = 'button'; button.className = 'btn icon-only ghost sm help'; button.setAttribute('aria-expanded', 'false');
    button.title = button.ariaLabel = `${T.t('app.help')}: ${title.textContent}`;
    icon.setAttribute('class', 'ic sm'); use.setAttribute('href', '#i-info'); icon.append(use); button.append(icon);
    button.onclick = () => { const open = row.classList.toggle('hint-open'); button.setAttribute('aria-expanded', String(open)); };
    row.classList.add('has-help'); title.after(button);
  }  // "Reset to defaults" beside a section heading: the preferences of that section go back to the values the app starts with.
  // Downloads, history and files are never touched; the page asks first.
  const SECTION_KEYS = {
    general: ['interfaceLanguage', 'appearance', 'theme', 'accent', 'textSize'],
    download: ['downloadDirectory', 'maxQuality', 'preferCompatible', 'speedLimitKiB', 'subtitleMode', 'subtitleLanguage', 'audioLanguage', 'subtitleContainer', 'maxConnections', 'autoRetries', 'smartNames', 'sortByType', 'folderLayout', 'deepVerifyDefault'],
    desktop: ['closeToTray', 'startMinimized', 'watchClipboard', 'notifyOnFinish']
  };
  let resetting = null;
  for (const button of document.querySelectorAll('[data-reset]')) {
    button.onclick = () => {
      resetting = button.dataset.reset;
      $('reset-confirm-title').textContent = T.t('app.reset.title', { section: button.closest('.group').querySelector('h2').textContent });
      $('reset-confirm-text').textContent = T.t('app.reset.text');
      $('reset-confirm').showModal(); $('reset-confirm-cancel').focus();
    };
  }
  $('reset-confirm-cancel').onclick = () => { resetting = null; $('reset-confirm').close(); };
  $('reset-confirm-accept').onclick = async () => {
    const section = resetting; resetting = null; $('reset-confirm').close();
    if (!SECTION_KEYS[section]) return;
    try {
      const { defaults } = await api('/api/settings'), body = {};
      for (const key of SECTION_KEYS[section]) body[key] = defaults[key];
      await save(body);
      if (section === 'desktop' && desktop) { await desktop.action('startup', false); $('desktop-startup').checked = false; }
      await refreshStatus(); show(T.t('app.reset.done'));
    } catch (error) { show(error.message, true); }
  };
  setupExtensionHelp(null); // without the desktop app the folder is the development one; the app passes the real one below
  upgradeSelects(); // every drop-down of the app window becomes the design system's list
  async function poll() {
    const [info, settings] = await Promise.all([api('/api/automation'), api('/api/settings')]);
    globalThis.HypernabAppearance?.apply(settings);
    globalThis.HypernabText?.switchTo?.(settings.interfaceLanguageResolved); // the app's language changed (here or by the engine's own default): reload once
    globalThis.HypernabLayoutSync?.(settings.listLayout);
    for (const key of keys) { const node = $(`set-${key}`); if (document.activeElement === node) continue; if (node.type === 'checkbox') node.checked = settings[key]; else node.value = String(settings[key]); }
    for (const [key, select] of Object.entries(languageSelects)) if (settings[key] && select.getValue() !== settings[key]) select.setValue(settings[key]);
    if (!loaded) { $('deep-verify').checked = settings.deepVerifyDefault; loaded = true; }
    const parts = [];
    if (info.schedule) parts.push(T.t('app.schedule.status', { queue: info.schedule.queue === 'Genel' ? T.t('app.queue.general') : info.schedule.queue, date: new Date(info.schedule.at).toLocaleString(T.language()) }));
    if (info.power) parts.push(info.power.deadline ? T.t(`app.power.countdown.${info.power.action === 'shutdown' ? 'shutdown' : 'sleep'}`, { s: Math.max(0, Math.ceil((info.power.deadline - Date.now()) / 1000)) }) : T.t('app.power.armed'));
    if (info.error) parts.push(info.error);
    $('automation-status').textContent = parts.join(' '); $('automation-bar').hidden = !parts.length; $('cancel-power').hidden = !info.power;
  }
  return { poll, render(queue) {
    const select = $('named-queue');
    if (JSON.stringify([...select.options].map(option => option.value)) !== JSON.stringify(queue.queueNames)) select.replaceChildren(...queue.queueNames.map(name => new Option(name === 'Genel' ? T.t('app.queue.general') : name, name)));
    if (document.activeElement !== select) select.value = queue.selectedQueue;
    if (document.activeElement !== $('speed-limit-mb')) $('speed-limit-mb').value = queue.speedLimitKiB / 1024;
  } };
}
