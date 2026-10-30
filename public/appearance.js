// Runs before first paint. This cache contains ONLY validated visual preferences, never credentials or job data.
(() => {
  const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const normalize = value => ({
    appearance: pick(value?.appearance, ['compact', 'normal'], 'compact'),
    textSize: pick(value?.textSize, ['small', 'normal', 'large'], 'normal'),
    theme: pick(value?.theme, ['dark', 'light', 'system'], 'dark'),
    accent: pick(value?.accent, ['green', 'blue', 'orange', 'violet'], 'green')
  });
  let current = normalize(null);
  const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  // "system" follows the operating system; the page only ever sees a resolved light/dark value.
  const scheme = theme => theme === 'system' ? (dark && !dark.matches ? 'light' : 'dark') : theme;
  const paint = () => {
    const root = document.documentElement;
    root.dataset.appearance = current.appearance; root.dataset.textSize = current.textSize;
    root.dataset.theme = current.theme; root.dataset.scheme = scheme(current.theme); root.dataset.accent = current.accent;
  };
  const apply = value => {
    current = normalize(value); paint();
    try { localStorage.setItem('hypernab-appearance', JSON.stringify(current)); } catch { /* optional cache */ }
    return current;
  };
  dark?.addEventListener?.('change', () => { if (current.theme === 'system') paint(); });
  let cached;
  try { cached = JSON.parse(localStorage.getItem('hypernab-appearance')); } catch { /* defaults */ }
  apply(cached);
  globalThis.HypernabAppearance = Object.freeze({ apply, normalize });
})();
