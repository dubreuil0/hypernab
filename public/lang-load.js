// Loads the text file of the language the window last showed, before ui-language.js applies it. English and Turkish are built in;
// every other language is a small file of its own (public/lang/<code>.js), so only the language in use is ever read.
(() => {
  const T = globalThis.HypernabText; if (!T) return;
  let saved = null; try { saved = localStorage.getItem('hypernab-language'); } catch { /* storage may be off */ }
  if (saved && T.packs.includes(saved) && !T.TEXTS[saved]) document.write(`<script src="/lang/${saved}.js"><\/script>`);
})();
