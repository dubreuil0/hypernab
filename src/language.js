// Language preferences. Subtitle language: 'auto' (the language of the system), 'off' (never choose one), or an ISO 639-1/2 code.
// Sound language: 'player' (whatever the page's player plays), 'original', or an ISO code. Sound never follows the subtitle language:
// someone may want the original sound with subtitles in their own language.
const CODE = /^[a-z]{2,3}$/;
export const validSubtitleLanguage = value => value === 'auto' || value === 'off' || (typeof value === 'string' && CODE.test(value));
export const validAudioLanguage = value => value === 'player' || value === 'original' || (typeof value === 'string' && CODE.test(value));

/** The language of the system as a lower-case code ('tr', 'de'...), or null when it cannot be told. */
export function systemLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const base = String(locale || '').toLowerCase().replace(/_/g, '-').split('-')[0];
  return CODE.test(base) ? base : null;
}
/** The language the setting means right now, or null for "no preference". */
export function resolveLanguage(setting, locale) {
  if (setting === 'off') return null;
  if (setting === 'auto' || setting === undefined) return systemLanguage(locale);
  return typeof setting === 'string' && CODE.test(setting) ? setting : null;
}
