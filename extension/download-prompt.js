// The window the user sees when the browser starts a file download: one file at a time, the oldest first.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const $ = id => document.getElementById(id);
  const IDLE_MS = 180000;
  let current = null, busy = false, idle;
  const send = message => Promise.resolve(api.runtime.sendMessage(message));
  const formatSize = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Bilinmiyor';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'], power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** power).toLocaleString('tr-TR', { maximumFractionDigits: power > 1 ? 1 : 0 })} ${units[power]}`;
  };
  const show = (id, text) => { const node = $(id); if (text !== undefined) node.textContent = text; node.hidden = !text && text !== undefined; };

  // No answer for three minutes: the browser carries on by itself (nothing is ever lost or stuck).
  const arm = () => { clearTimeout(idle); idle = setTimeout(async () => { try { await send({ type: 'hypernab:takeover:release' }); } catch { /* window closes anyway */ } window.close(); }, IDLE_MS); };

  // The window is only as tall as its content (the frame around the page differs between systems).
  async function fit() {
    try {
      const win = await api.windows.getCurrent();
      const height = Math.ceil(document.documentElement.scrollHeight + (window.outerHeight - window.innerHeight));
      if (Math.abs(height - win.height) > 3) await api.windows.update(win.id, { height });
    } catch { /* the default size is fine */ }
  }

  function fill(item) {
    current = item;
    $('name').textContent = item.name; $('name').title = item.name;
    $('meta').textContent = [formatSize(item.bytes), item.host].filter(Boolean).join('  ·  ');
    $('directory').textContent = item.directory ? `\u202A${item.directory}` : 'Hypernab indirme klasörü';
    $('directory').title = item.directory || '';
    $('queue-note').textContent = item.remaining > 0 ? `Sırada ${item.remaining} dosya daha` : '';
    show('risk', item.risk === 'program' ? 'Program dosyası: yalnızca güvendiğin bir kaynaktansa çalıştır.' : item.risk === 'script' ? 'Bu dosya komut veya makro çalıştırabilir.' : '');
    show('duplicate', item.duplicate ? 'Bu bağlantı Hypernab listesinde zaten var.' : '');
    show('message', '');
    $('browser').hidden = true;
    $('now').textContent = item.duplicate ? 'Yine de indir' : 'İndir';
    $('remember-type').checked = false;
    $('remember-type-text').textContent = item.ext ? `Bir daha sorma: .${item.ext} dosyalarını hep Hypernab ile indir` : 'Bir daha sorma: bu tür dosyaları hep Hypernab ile indir';
    $('remember').hidden = !item.ext;
    $('card').hidden = false; $('done').hidden = true;
    $('now').focus();
    void fit();
  }

  async function next() {
    const item = await send({ type: 'hypernab:takeover:next' });
    if (!item?.ok || item.empty) { window.close(); return; }
    fill(item);
  }

  function working(on) { busy = on; for (const id of ['now', 'later', 'browser', 'cancel']) $(id).disabled = on; }

  async function decide(choice) {
    if (!current || busy) return;
    arm(); working(true);
    try {
      const answer = await send({ type: 'hypernab:takeover:decide', id: current.id, choice, rememberType: $('remember-type').checked, allowDuplicate: current.duplicate === true || current.allowDuplicate === true });
      if (answer?.ok) {
        if (choice === 'now' || choice === 'later') {
          $('card').hidden = true;
          show('done', answer.browserDone ? 'Tarayıcı dosyayı zaten indirmiş; Hypernab’a eklenmedi.' : answer.gone ? 'İndirme tarayıcıdan kaldırılmıştı; işlem yapılmadı.' : answer.browserCopy ? 'Hypernab’a eklendi. Tarayıcı da bitirmişti; iki kopya olabilir.' : choice === 'later' ? 'Hypernab listesine eklendi (Sonra ekle).' : 'Hypernab indiriyor.');
          await new Promise(resolve => setTimeout(resolve, answer.browserCopy || answer.browserDone ? 2600 : 450));
        }
        working(false); await next(); return;
      }
      // Hypernab could not take the file: the browser's download is untouched and still waiting.
      show('message', answer?.error || 'Hypernab dosyayı alamadı.');
      if (answer?.duplicate) { current.allowDuplicate = true; $('now').textContent = 'Yine de indir'; }
      else $('browser').hidden = false; // the way out when Hypernab cannot take it: the browser downloads it itself
    } catch (error) {
      show('message', 'Hypernab ile bağlantı kurulamadı.');
      $('browser').hidden = false;
    }
    working(false); void fit();
  }

  for (const [id, choice] of [['now', 'now'], ['later', 'later'], ['browser', 'browser'], ['cancel', 'cancel']]) $(id).addEventListener('click', () => { void decide(choice); });
  document.addEventListener('keydown', event => { arm(); if (event.key === 'Escape') { event.preventDefault(); void decide('cancel'); } });
  document.addEventListener('pointerdown', arm);
  arm(); next().catch(() => window.close());
})();
