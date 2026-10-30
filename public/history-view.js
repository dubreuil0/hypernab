const mediaFile = file => /\.(?:mp4|mkv|webm|mov|avi|m4v|mpeg|mpg|ts|m2ts|flv|wmv|mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)$/i.test(file || '');
export const canPlayFile = job => job.status === 'completed' && mediaFile(job.file);

export function setupHistory({ api, el, icon, fmt }) {
  const $ = id => document.getElementById(id);
  let cursor = null, pages = [], page = 0, generation = 0;
  const say = (text, error = false) => { $('history-status').textContent = text; $('history-status').className = error ? 'error' : 'hint'; };
  const button = (label, symbol, run) => {
    const node = el('button', 'btn icon-only ghost'); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label); node.append(icon(symbol));
    node.onclick = async () => {
      node.disabled = true;
      try { await run(); } catch (error) { say(error.message, true); }
      finally { node.disabled = false; }
    };
    return node;
  };
  async function load(reset = false) {
    const request = ++generation;
    if (reset) { pages = [null]; page = 0; }
    cursor = null;
    $('history-prev').disabled = $('history-next').disabled = true;
    $('history-rows').replaceChildren();
    $('history-rows').setAttribute('aria-busy', 'true'); say('Geçmiş okunuyor…');
    try {
      const query = new URLSearchParams({ search: $('history-search').value.trim() });
      if (pages[page]) query.set('cursor', pages[page]);
      const data = await api(`/api/history?${query}`);
      if (request !== generation || $('view-history').hidden) return;
      cursor = data.cursor;
      const rows = data.entries.map(entry => {
        const row = el('article', 'history-row'); row.dataset.historyId = entry.id;
        const info = el('div', 'history-info');
        const name = el('strong', 'history-name', entry.title); name.title = entry.title;
        const time = entry.completedAt || entry.createdAt;
        const date = time && Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString('tr-TR') : '';
        info.append(name, el('div', 'hint', [entry.host, fmt(entry.total), date ? `${entry.completedAt ? 'Bitti' : 'Eklendi'}: ${date}` : ''].filter(Boolean).join(' · ')));
        const file = el('div', 'hint history-path', entry.file); file.title = `${entry.directory}\\${entry.file}`; info.append(file);
        row.append(info);
        if (globalThis.hypernabDesktop) {
          const actions = el('div', 'history-actions');
          if (mediaFile(entry.file)) {
            const play = button('Oynat', 'play', () => globalThis.hypernabDesktop.action('history-play', entry.id)); play.dataset.historyPlay = entry.id; actions.append(play);
          }
          const folder = button('Dosya konumunu aç', 'folder', () => globalThis.hypernabDesktop.action('history-location', entry.id)); folder.dataset.historyLocation = entry.id; actions.append(folder);
          row.append(actions);
        }
        return row;
      });
      $('history-rows').replaceChildren(...(rows.length ? rows : [el('p', 'hint', $('history-search').value.trim() ? 'Aramayla eşleşen geçmiş kaydı yok.' : 'Henüz tamamlanmış indirme yok. Önceden listeden kaldırılmış kayıtlar geriye dönük bulunamaz.')]));
      say(`Sayfa ${page + 1} · ${rows.length} kayıt${cursor ? ' · daha fazlası var' : ''}`);
    } catch (error) { if (request === generation) { cursor = null; say(error.message, true); } }
    finally {
      if (request === generation) {
        $('history-rows').setAttribute('aria-busy', 'false');
        $('history-prev').disabled = page === 0; $('history-next').disabled = !cursor;
      }
    }
  }
  $('open-history').onclick = () => {
    $('view-downloads').hidden = $('view-settings').hidden = $('tabs').hidden = true;
    $('view-history').hidden = false; $('open-history').setAttribute('aria-pressed', 'true'); $('open-settings').setAttribute('aria-pressed', 'false');
    $('history-search').focus(); void load(true);
  };
  $('close-history').onclick = () => {
    ++generation; $('view-history').hidden = true; $('view-downloads').hidden = $('tabs').hidden = false;
    $('open-history').setAttribute('aria-pressed', 'false'); $('open-history').focus();
  };
  $('history-form').onsubmit = event => { event.preventDefault(); void load(true); };
  $('history-refresh').onclick = () => { void load(true); };
  $('history-prev').onclick = () => { if (page > 0) { page--; void load(); } };
  $('history-next').onclick = () => { if (cursor) { pages[++page] = cursor; void load(); } };
  document.addEventListener('keydown', event => {
    if (!$('view-history').hidden && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); $('history-search').focus(); $('history-search').select(); }
  });
}
