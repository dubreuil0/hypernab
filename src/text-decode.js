// Text files of unknown encoding (subtitles from any country). Order of trust: a byte-order mark, UTF-16 without a mark (zero bytes
// in a regular pattern), valid UTF-8, and only then the legacy code pages: every candidate reads the same bytes and the reading that
// looks like real language wins (common words of the language, or the commonest characters of Chinese/Japanese/Korean). A reading with
// broken characters never wins. Not sure = a fixed code page chosen from the language hint, reported as not confident.
import { analyseText } from './language-detect.js';

const COMMON = {
  gbk: '的一是不了人我在有他这中大来上个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工',
  big5: '的一是不了人我在有他這中大來上個到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工',
  ja: 'のにはをたがでてとしれさあいるですますなもこそかよねっんーことうからまでよりだけ',
  ko: '이는은가을를에의다요하고지서도한로면나아있어그것과들자수보않리습니까'
};
const SETS = Object.fromEntries(Object.entries(COMMON).map(([name, chars]) => [name, new Set(chars)]));
// [label, kind]: the first of equal readings wins, so the common western page comes first.
const LEGACY = [
  ['windows-1252', 'text'], ['windows-1254', 'text'], ['windows-1250', 'text'], ['windows-1251', 'text'], ['koi8-r', 'text'], ['windows-1253', 'text'],
  ['windows-1256', 'text'], ['windows-1255', 'text'], ['windows-1257', 'text'], ['windows-874', 'text'],
  ['gbk', 'gbk'], ['big5', 'big5'], ['shift_jis', 'ja'], ['euc-jp', 'ja'], ['euc-kr', 'ko']
];
// What to fall back on when nothing is clear, from the language the page said the file is in.
const FALLBACK = { tr: 'windows-1254', ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251', el: 'windows-1253', ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256', he: 'windows-1255',
  pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250', zh: 'gbk', ja: 'shift_jis', ko: 'euc-kr', th: 'windows-874' };

const read = (label, buffer, fatal = false) => new TextDecoder(label, { fatal }).decode(buffer);
function zeroPattern(buffer) {
  const size = Math.min(buffer.length, 8000) & ~1; if (size < 8) return null;
  let odd = 0, even = 0;
  for (let i = 0; i < size; i += 2) { if (buffer[i] === 0) even++; if (buffer[i + 1] === 0) odd++; }
  const pairs = size / 2;
  if (odd >= pairs * 0.03 && even <= odd * 0.2) return 'utf-16le'; // the high byte of a Latin letter sits second
  if (even >= pairs * 0.03 && odd <= even * 0.2) return 'utf-16be';
  return null;
}
function score(text, kind) {
  const broken = (text.match(/[�\u0080-\u009f]/g) || []).length;
  if (broken > Math.max(2, text.length * 0.002)) return 0;
  if (SETS[kind]) {
    const wide = [...text].filter(ch => ch.codePointAt(0) > 0x2e7f);
    if (wide.length < 10) return 0;
    const set = SETS[kind];
    return wide.filter(ch => set.has(ch)).length / wide.length * (kind === 'big5' || kind === 'gbk' ? 1 : 1.2);
  }
  const info = analyseText(text);
  if (info.direct) return info.direct === 'sr' || info.direct === 'mk' ? 0.3 : info.direct === 'th' ? info.score : 0;
  // real words are required; letters from another script mean a wrong reading (Hebrew letters inside Italian)
  return info.words >= 0.06 ? info.score - (1 - info.share) : 0;
}
const nonAscii = text => (text.match(/[^\x00-\x7f]/g) || []).length;

/**
 * @param {Buffer} buffer
 * @param {{hint?: string}} options hint: the language the page said the text is in (ISO 639-1), used only when nothing is clear
 * @returns {{text: string, encoding: string, confident: boolean, suspect: boolean}} suspect = unsure AND enough non-ASCII text for it to matter
 */
export function decodeText(buffer, { hint } = {}) {
  const done = (text, encoding, confident = true) => ({ text, encoding, confident, suspect: !confident && nonAscii(text) >= 20 });
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return done(read('utf-8', buffer.subarray(3)), 'utf-8');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return done(read('utf-16le', buffer.subarray(2)), 'utf-16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return done(read('utf-16be', buffer.subarray(2)), 'utf-16be');
  const wide = zeroPattern(buffer); if (wide) return done(read(wide, buffer), wide);
  try { return done(read('utf-8', buffer, true), 'utf-8'); } catch { /* not UTF-8: a legacy code page */ }
  let best = null;
  for (const [label, kind] of LEGACY) {
    let text; try { text = read(label, buffer, true); } catch { continue; }
    const value = score(text, kind);
    if (!best || value > best.value + 0.015) best = { label, text, value }; // near-equal readings: the first, most common page
  }
  const enough = best && (SETS[LEGACY.find(item => item[0] === best.label)[1]] ? best.value >= 0.15 : best.value > 0);
  if (enough) return done(best.text, best.label);
  const fallback = FALLBACK[String(hint || '').toLowerCase()] || 'windows-1252';
  return done(read(fallback, buffer), fallback, false);
}
