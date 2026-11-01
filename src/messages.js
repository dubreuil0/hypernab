// Messages of the engine (errors, notes, status lines) in the app's interface language. The texts live in public/strings.js with the
// app window's texts. The language is set by the download queue from the interface-language setting; until then it follows Windows.
// Every message is made at the moment it is needed, never kept in a constant, so a language change applies to the next one.
import fs from 'node:fs';
import vm from 'node:vm';
import { interfaceLanguage } from './language.js';

let texts = {};
try { const sandbox = {}; vm.runInNewContext(fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8'), { globalThis: sandbox }); texts = sandbox.HypernabText.TEXTS; } catch { /* keys show */ }
let language = interfaceLanguage('auto', process.env.HYPERNAB_LOCALE);
export function setMessageLanguage(code) { language = texts[code] ? code : 'en'; }
export const messageLanguage = () => language;
export function m(key, vars) {
  const text = texts[language]?.[key] ?? texts.en?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
}
