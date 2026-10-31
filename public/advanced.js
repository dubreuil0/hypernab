import { upgradeSelects } from './select-upgrade.js';
export function setupAdvanced(api, refreshStatus) {
  const $ = id => document.getElementById(id), desktop = globalThis.hypernabDesktop;
  let loaded = false;
  for (const node of document.querySelectorAll('.switch input, .setting-control select, .setting-control input')) {
    const title = node.closest('.setting')?.querySelector('strong')?.textContent;
    if (title) node.setAttribute('aria-label', title);
  }
  const post = (route, body) => api(route, { method: 'POST', body: JSON.stringify(body) });
  const show = (text, error = false) => { $('settings-saved').textContent = text; $('settings-saved').className = error ? 'saved error' : 'saved'; };
  const run = fn => async () => { try { await fn(); await refreshStatus(); show('Kaydedildi.'); } catch (error) { show(error.message, true); } };
  const save = async body => { await post('/api/settings', body); if (desktop) await desktop.action('settings-changed'); };
  $('open-settings').onclick = () => { $('view-downloads').hidden = true; $('view-history').hidden = true; $('open-history').setAttribute('aria-pressed', 'false'); $('view-settings').hidden = false; $('tabs').hidden = true; $('open-settings').setAttribute('aria-pressed', 'true'); };
  $('close-settings').onclick = () => { $('view-downloads').hidden = false; $('view-settings').hidden = true; $('tabs').hidden = false; $('open-settings').setAttribute('aria-pressed', 'false'); };
  for (let n = 1; n <= 16; n++) $('set-maxConnections').add(new Option(String(n), String(n)));
  const keys = ['appearance', 'textSize', 'theme', 'accent', 'subtitleMode', 'smartNames', 'folderLayout', 'maxQuality', 'preferCompatible', 'maxConnections', 'autoRetries', 'deepVerifyDefault', 'notifyOnFinish', 'closeToTray', 'startMinimized'];
  for (const key of keys) {
    const node = $(`set-${key}`);
    node.onchange = run(async () => {
      await save({ [key]: node.type === 'checkbox' ? node.checked : ['appearance', 'textSize', 'theme', 'accent', 'subtitleMode', 'folderLayout'].includes(key) || node.value === 'best' ? node.value : Number(node.value) });
      if (key === 'deepVerifyDefault') $('deep-verify').checked = node.checked;
    });
  }
  // Language preferences (shared design-system list with a search box; texts come from translation keys).
  const DS = globalThis.HypernabDS, T = globalThis.HypernabText, languageSelects = {};
  if (DS && T) {
    const ui = T.language(), system = String(navigator.language || 'en').toLowerCase().split('-')[0];
    const rows = [
      ['subtitleLanguage', 'lang.subtitle', [{ value: 'auto', label: T.t('lang.auto', { name: DS.languageInfo(system, ui).name }) }, { value: 'off', label: T.t('lang.off') }]],
      ['audioLanguage', 'lang.audio', [{ value: 'player', label: T.t('lang.player') }, { value: 'original', label: T.t('lang.original') }]],
    ];
    for (const [key, prefix, first] of rows) {
      const row = document.createElement('div'); row.className = 'setting';
      const copy = document.createElement('div'), title = document.createElement('strong'), hint = document.createElement('p'), control = document.createElement('div');
      title.textContent = T.t(`${prefix}.title`); hint.className = 'hint'; hint.textContent = T.t(`${prefix}.hint`); control.className = 'setting-control';
      const select = DS.select(document, { options: DS.languageOptions(DS.LANGUAGE_CODES, ui, first), value: first[0].value, label: title.textContent, search: true, searchLabel: T.t('lang.search'), emptyText: T.t('lang.empty'),
        onChange: value => run(() => save({ [key]: value }))() });
      languageSelects[key] = select; copy.append(title, hint); control.append(select.el); row.append(copy, control); $('language-settings').append(row);
    }
  }
  $('named-queue').onchange = run(() => save({ selectedQueue: $('named-queue').value }));
  $('new-queue').onclick = run(async () => { await save({ addQueue: $('new-queue-name').value }); $('new-queue-name').value = ''; });
  $('save-speed').onclick = run(() => save({ speedLimitKiB: Math.round(Number($('speed-limit-mb').value) * 1024) }));
  $('save-schedule').onclick = run(() => {
    const at = new Date($('schedule-at').value).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error('Gelecekteki bir tarih ve saat seç.');
    return post('/api/automation', { schedule: { at, queue: $('named-queue').value } });
  });
  $('cancel-schedule').onclick = run(() => post('/api/automation', { schedule: null }));
  $('arm-power').onclick = run(() => post('/api/automation', { power: $('power-action').value || null }));
  $('cancel-power').onclick = run(() => post('/api/automation', { power: null }));
  $('dir-change').onclick = run(async () => { const directory = desktop ? await desktop.action('pick-folder') : $('dir-input').value.trim(); if (directory) await save({ downloadDirectory: directory }); });
  $('dir-reset').onclick = run(() => save({ downloadDirectory: null }));
  if (desktop) {
    for (const id of ['s-desktop', 'nav-desktop', 'desktop-settings', 'open-downloads', 'open-extensions']) $(id).hidden = false;
    $('dir-edit').hidden = true;
    desktop.settings().then(info => { $('desktop-startup').checked = info.startup; $('desktop-startup').disabled = !info.packaged; $('app-version').textContent = info.version; }).catch(error => show(error.message, true));
    $('desktop-startup').onchange = run(() => desktop.action('startup', $('desktop-startup').checked));
    for (const [id, action] of [['open-downloads', 'downloads'], ['open-extensions', 'extensions'], ['repair-native', 'native']]) $(id).onclick = run(() => desktop.action(action));
  }
  upgradeSelects(); // every drop-down of the app window becomes the design system's list
  async function poll() {
    const [info, settings] = await Promise.all([api('/api/automation'), api('/api/settings')]);
    globalThis.HypernabAppearance?.apply(settings);
    globalThis.HypernabLayoutSync?.(settings.listLayout);
    for (const key of keys) { const node = $(`set-${key}`); if (document.activeElement === node) continue; if (node.type === 'checkbox') node.checked = settings[key]; else node.value = String(settings[key]); }
    for (const [key, select] of Object.entries(languageSelects)) if (settings[key] && select.getValue() !== settings[key]) select.setValue(settings[key]);
    if (!loaded) { $('deep-verify').checked = settings.deepVerifyDefault; loaded = true; }
    const parts = [];
    if (info.schedule) parts.push(`${info.schedule.queue}: ${new Date(info.schedule.at).toLocaleString('tr-TR')} tarihinde başlayacak.`);
    if (info.power) parts.push(info.power.deadline ? `${Math.max(0, Math.ceil((info.power.deadline - Date.now()) / 1000))} saniye sonra ${info.power.action === 'shutdown' ? 'bilgisayar kapanacak' : 'uykuya geçilecek'}!` : 'Mevcut indirmeler bitince güç işlemi uygulanacak.');
    if (info.error) parts.push(info.error);
    $('automation-status').textContent = parts.join(' '); $('automation-bar').hidden = !parts.length; $('cancel-power').hidden = !info.power;
  }
  return { poll, render(queue) {
    const select = $('named-queue');
    if (JSON.stringify([...select.options].map(option => option.value)) !== JSON.stringify(queue.queueNames)) select.replaceChildren(...queue.queueNames.map(name => new Option(name, name)));
    if (document.activeElement !== select) select.value = queue.selectedQueue;
    if (document.activeElement !== $('speed-limit-mb')) $('speed-limit-mb').value = queue.speedLimitKiB / 1024;
  } };
}
