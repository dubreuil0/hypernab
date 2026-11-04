// Language preferences. Subtitle language: 'auto' (the language of the system), 'off' (never choose one), or an ISO 639-1/2 code.
// Sound language: 'player' (whatever the page's player plays), 'original', or an ISO code. Sound never follows the subtitle language:
// someone may want the original sound with subtitles in their own language.
const CODE = /^[a-z]{2,3}$/;
export const validSubtitleLanguage = value => value === 'auto' || value === 'off' || (typeof value === 'string' && CODE.test(value));
export const validAudioLanguage = value => value === 'player' || value === 'original' || (typeof value === 'string' && CODE.test(value));

// "Automatic" means the language of the interface, not of Windows: a Turkish user may run an English Windows and reads the app in the
// language the app shows.
export const INTERFACE_LANGUAGES = ['en', 'tr', 'es', 'de', 'fr', 'ru', 'pt', 'ar']; // the languages the app itself is translated into
export const validInterfaceLanguage = value => value === 'auto' || INTERFACE_LANGUAGES.includes(value);
/** The language of the app: the setting, or (automatic) the language of Windows when the app has it, else English. */
export function interfaceLanguage(setting, systemLocale) {
  if (INTERFACE_LANGUAGES.includes(setting)) return setting;
  const system = systemLanguage(systemLocale);
  return INTERFACE_LANGUAGES.includes(system) ? system : 'en';
}
/** A lower-case language code ('tr', 'de'...) from a locale name such as 'de-DE', or null when it cannot be told. */
export function systemLanguage(locale = '') {
  const base = String(locale || '').toLowerCase().replace(/_/g, '-').split('-')[0];
  return CODE.test(base) ? base : null;
}
/** The language the setting means right now, or null for "no preference". */
export function resolveLanguage(setting, locale) {
  if (setting === 'off') return null;
  if (setting === 'auto' || setting === undefined) return systemLanguage(locale);
  return typeof setting === 'string' && CODE.test(setting) ? setting : null;
}
