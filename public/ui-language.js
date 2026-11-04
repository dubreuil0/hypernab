// The app window's language. Runs after the page markup and before app.js: the language of the last session (kept locally, so the first
// paint is already right) is applied to the static texts; the engine's resolved language corrects it later (see advanced.js).
(() => {
  const T = globalThis.HypernabText; if (!T) return;
  const KEY = 'hypernab-language';
  let saved = null; try { saved = localStorage.getItem(KEY); } catch { /* storage may be off: the browser language is used */ }
  if (saved && T.supported().includes(saved)) T.setLanguage(saved);
  document.documentElement.lang = T.language();
  T.apply(document);
  /** Remembers the language and reloads the window once, so every text (also the ones built by code) is in it. */
  T.switchTo = code => {
    if (!T.available().includes(code) || code === T.language()) return;
    let guard = null; try { guard = sessionStorage.getItem(KEY); } catch { /* none */ }
    if (guard === code) return; // already reloaded for this language: never loop
    try { localStorage.setItem(KEY, code); sessionStorage.setItem(KEY, code); } catch { return; }
    location.reload();
  };
})();
