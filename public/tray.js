(() => {
  const bridge = globalThis.hypernabTray, $ = id => document.getElementById(id);
  const labels = { running: 'İniyor', queued: 'Sırasını bekliyor', paused: 'Duraklatıldı', interrupted: 'Kesildi' };
  let latest = { connected: false }, busy = false, painted = '', preferences = { theme: 'dark' };
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const appearance = value => {
    preferences = value;
    const root = document.documentElement;
    root.dataset.scheme = value.theme === 'system' ? systemDark.matches ? 'dark' : 'light' : value.theme;
    root.dataset.accent = value.accent; root.dataset.textSize = value.textSize;
  };
  systemDark.addEventListener('change', () => { if (preferences.theme === 'system') appearance(preferences); });
  const rate = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B/sn';
    const power = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** power).toLocaleString('tr-TR', { maximumFractionDigits: power ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB'][power]}/sn`;
  };
  const message = (text, error = false) => { $('tray-status').textContent = text; $('tray-status').className = error ? 'error' : 'hint'; };
  function controls() {
    $('tray-pause').disabled = busy || !latest.connected || !latest.canPause;
    $('tray-resume').disabled = busy || !latest.connected || !latest.canResume;
    $('tray-refresh').disabled = busy || !bridge;
    for (const button of $('tray-rows').querySelectorAll('button')) button.disabled = busy || !latest.connected;
  }
  async function command(action, id) {
    if (!bridge || (busy && !['open', 'close'].includes(action))) return;
    busy = true; controls();
    try {
      const result = await bridge.command(action, id);
      if (!['open', 'close', 'refresh'].includes(action)) message(result.changed ? `${result.changed} indirmeye uygulandı.` : 'Durumu değiştirilecek indirme yok.');
    } catch { message('İşlem uygulanamadı. Bağlantıyı ve indirme durumunu kontrol et.', true); }
    finally { busy = false; controls(); }
  }
  function paint(state) {
    latest = state;
    if (state.appearance) appearance(state.appearance);
    if (!state.connected) {
      painted = ''; $('tray-speed').textContent = '—'; $('tray-counts').textContent = 'Bağlantı yok';
      $('tray-rows').replaceChildren(); $('tray-extra').textContent = '';
      message('Motor durumu alınamadı; eski hız gösterilmiyor.', true); controls(); return;
    }
    const key = JSON.stringify(state);
    if (key === painted) { controls(); return; }
    const recovered = !painted; painted = key;
    const focus = document.activeElement?.dataset.trayJob;
    $('tray-speed').textContent = rate(state.speed);
    $('tray-counts').textContent = `${state.active} aktif · ${state.queued} sırada · ${state.paused} duraklatılmış`;
    $('tray-extra').textContent = [state.more ? `Diğer ${state.more} iş ana pencerede.` : '', state.held ? `${state.held} video “Sonra ekle” kuyruğunda.` : ''].filter(Boolean).join(' ');
    const rows = state.rows.map(job => {
      const row = document.createElement('article'); row.className = 'tray-row';
      const info = document.createElement('div'); info.className = 'tray-row-info';
      const title = document.createElement('strong'); title.textContent = job.title; title.title = job.title;
      const facts = document.createElement('p'); facts.className = 'hint'; facts.textContent = `${labels[job.status]}${job.status === 'running' ? ` · ${rate(job.speed)}` : ''}`;
      info.append(title, facts); row.append(info);
      if (job.canPause || job.canResume) {
        const action = job.canPause ? 'pause' : 'resume', label = job.canPause ? 'Duraklat' : 'Sürdür';
        const button = document.createElement('button'); button.className = 'btn icon-only ghost'; button.title = label; button.setAttribute('aria-label', `${label}: ${job.title}`); button.dataset.trayJob = job.id;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', job.canPause ? '#i-pause' : '#i-play'); svg.append(use); button.append(svg);
        button.onclick = () => { void command(action, job.id); }; row.append(button);
      }
      return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Aktif veya duraklatılmış indirme yok.'; rows.push(empty); }
    $('tray-rows').replaceChildren(...rows); controls();
    if (focus) [...$('tray-rows').querySelectorAll('button')].find(button => button.dataset.trayJob === focus)?.focus({ preventScroll: true });
    if (recovered) message('Durum güncel.');
  }
  for (const [id, action] of [['tray-pause', 'pause-all'], ['tray-resume', 'resume-all'], ['tray-open', 'open'], ['tray-close', 'close'], ['tray-refresh', 'refresh']]) $(id).onclick = () => { void command(action); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void command('close'); } });
  if (bridge) bridge.subscribe(paint);
  else { paint({ connected: false }); $('tray-open').disabled = $('tray-close').disabled = true; }
})();
