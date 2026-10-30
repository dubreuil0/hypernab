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

  function fill(item) {
    current = item;
    $('name').textContent = item.name; $('name').title = item.name;
    $('size').textContent = formatSize(item.bytes);
    $('host').textContent = item.host || '—';
    $('directory').textContent = item.directory || 'Hypernab indirme klasörü';
    $('queue-note').textContent = item.remaining > 0 ? `Sırada ${item.remaining} dosya daha var` : '';
    show('risk', item.risk === 'program' ? 'Bu bir program dosyası. Yalnızca güvendiğin bir kaynaktan indirdiysen çalıştır.' : item.risk === 'script' ? 'Bu dosya komut veya makro çalıştırabilir. Yalnızca güvendiğin bir kaynaktan indirdiysen aç.' : '');
    show('duplicate', item.duplicate ? 'Bu bağlantı Hypernab listesinde zaten var. İstersen yine de indirebilirsin.' : '');
    show('message', '');
    $('now').textContent = item.duplicate ? 'Yine de indir' : 'İndir';
    $('remember-type').checked = false; $('remember-host').checked = false;
    $('remember-type-text').textContent = item.ext ? `.${item.ext} dosyalarını bir daha sormadan Hypernab ile indir` : 'Bu dosya türünü bir daha sormadan Hypernab ile indir';
    $('remember-type').parentElement.hidden = !item.ext;
    $('remember-host-text').textContent = item.host ? `${item.host} sitesinde bir daha sorma; tarayıcı kendisi indirsin` : 'Bu sitede bir daha sorma';
    $('remember-host').parentElement.hidden = !item.host;
    $('card').hidden = false; $('done').hidden = true;
    $('now').focus();
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
      const answer = await send({ type: 'hypernab:takeover:decide', id: current.id, choice, rememberType: $('remember-type').checked, rememberHost: $('remember-host').checked, allowDuplicate: current.duplicate === true || current.allowDuplicate === true });
      if (answer?.ok) {
        if (choice === 'now' || choice === 'later') {
          $('card').hidden = true;
          show('done', answer.browserDone ? 'Tarayıcı dosyayı zaten indirmiş; Hypernab’a eklenmedi.' : answer.gone ? 'İndirme tarayıcıdan kaldırılmıştı; işlem yapılmadı.' : answer.browserCopy ? 'Hypernab’a eklendi. Tarayıcı da bitirmişti; iki kopya olabilir.' : choice === 'later' ? 'Hypernab listesine eklendi (Sonra ekle).' : 'Hypernab indiriyor.');
          await new Promise(resolve => setTimeout(resolve, answer.browserCopy || answer.browserDone ? 2600 : 900));
        }
        working(false); await next(); return;
      }
      // Hypernab could not take the file: the browser's download is untouched and still waiting.
      show('message', `${answer?.error || 'Hypernab dosyayı alamadı.'} Tarayıcı ile indirmeyi seçebilirsin.`);
      if (answer?.duplicate) { current.allowDuplicate = true; $('now').textContent = 'Yine de indir'; }
    } catch (error) {
      show('message', 'Hypernab ile bağlantı kurulamadı. Tarayıcı ile indirmeyi seçebilirsin.');
    }
    working(false);
  }

  for (const [id, choice] of [['now', 'now'], ['later', 'later'], ['browser', 'browser'], ['cancel', 'cancel']]) $(id).addEventListener('click', () => { void decide(choice); });
  document.addEventListener('keydown', event => { arm(); if (event.key === 'Escape') { event.preventDefault(); $('remember-host').checked = false; void decide('browser'); } });
  document.addEventListener('pointerdown', arm);
  arm(); next().catch(() => window.close());
})();
