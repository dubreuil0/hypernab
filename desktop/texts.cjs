// Texts of the desktop shell (tray menu, update and error boxes). They live in public/strings.js with the app window's texts; this file
// only reads them. The language follows the app's interface language (main.cjs sets it from the engine's settings).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let texts = null;
for (const file of [path.join(process.resourcesPath || '', 'engine', 'public', 'strings.js'), path.join(__dirname, '..', 'public', 'strings.js')]) {
  try {
    const sandbox = {}, context = vm.createContext({ globalThis: sandbox });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    for (const code of sandbox.HypernabText.packs) { try { vm.runInContext(fs.readFileSync(path.join(path.dirname(file), 'lang', `${code}.js`), 'utf8'), context); } catch { /* that language falls back to English */ } }
    texts = sandbox.HypernabText; break;
  } catch { /* try the next place */ }
}
let language = 'en';
function setLanguage(code) { language = texts?.TEXTS?.[code] ? code : 'en'; }
function t(key, vars) {
  const text = texts?.TEXTS?.[language]?.[key] ?? texts?.TEXTS?.en?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
}
module.exports = { t, setLanguage, language: () => language };
