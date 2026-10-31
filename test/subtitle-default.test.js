import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSubtitleIndex, muxArguments, pickLead } from '../src/subtitles.js';
import { resolveLanguage, systemLanguage, validSubtitleLanguage, validAudioLanguage } from '../src/language.js';

const ISO1 = { eng: 'en', tur: 'tr', deu: 'de', rus: 'ru' };
const track = (iso3, extra = {}) => ({ file: `${iso3}.srt`, iso3, iso1: ISO1[iso3], name: iso3, default: false, cues: Array(100), ...extra });

test('a player that names no default still leaves a subtitle switched on: the only track, else the one in the preferred language', () => {
  assert.equal(defaultSubtitleIndex([track('eng')]), 0);
  assert.equal(defaultSubtitleIndex([track('eng'), track('tur')], 'tr'), 1);
  assert.equal(defaultSubtitleIndex([track('eng'), track('tur')], 'en'), 0, 'the preference decides, not Turkish');
  assert.equal(defaultSubtitleIndex([track('eng'), track('deu')], 'tr'), -1, 'no track in the preferred language: nothing is guessed');
  assert.equal(defaultSubtitleIndex([track('eng'), track('deu')]), -1, 'no preference: nothing is guessed');
  assert.equal(defaultSubtitleIndex([track('eng'), track('tur', { default: true })], 'tr'), -1, 'the page already chose: its flags stay');
});

test('the default flag reaches the container (ffmpeg arguments)', () => {
  const flags = (tracks, preferred) => { const args = muxArguments('film.mp4', tracks, 'out.mp4', preferred); return args.flatMap((arg, i) => arg.startsWith('-disposition:s:') ? [args[i + 1]] : []); };
  assert.deepEqual(flags([track('eng'), track('tur')], 'tr'), ['0', 'default']);
  assert.deepEqual(flags([track('eng'), track('deu'), track('rus')], 'de'), ['0', 'default', '0'], 'a German user gets German');
  assert.deepEqual(flags([track('eng'), track('tur')]), ['0', '0'], 'no preference and several tracks: none flagged');
  assert.deepEqual(flags([track('tur')]), ['default']);
  assert.deepEqual(flags([track('eng', { default: true }), track('tur')], 'tr'), ['default', '0'], 'the page\'s own choice is untouched');
});

test('lead track: the page\'s choice, else a full-length track in the preferred language, else none', () => {
  assert.equal(pickLead([track('eng', { default: true }), track('tur')], 'tr'), 0, 'the page\'s own choice leads');
  assert.equal(pickLead([track('eng'), track('tur')], 'tr'), 1);
  assert.equal(pickLead([track('eng'), track('tur')], 'en'), 0, 'English preferred: English, even with Turkish present');
  assert.equal(pickLead([track('eng'), track('deu')], 'tr'), -1, 'the preferred language is missing: never a wrong one');
  assert.equal(pickLead([track('eng'), track('tur')], null), -1, 'subtitle language off: nothing flagged');
  assert.equal(pickLead([track('eng')], 'tr'), 0, 'a single track is the default whatever the language');
  assert.equal(pickLead([track('tur', { cues: Array(3) }), track('eng')], 'tr'), -1, 'a short foreign-phrases track never leads');
  assert.equal(pickLead([track('eng', { cues: Array(3) }), track('eng')], 'en'), 1, 'the full one wins over the sparse one of the same language');
  assert.equal(pickLead([], 'tr'), -1);
});

test('language settings: system language, off, explicit code; sound is validated separately', () => {
  assert.equal(systemLanguage('tr-TR'), 'tr');
  assert.equal(systemLanguage('de_DE'), 'de');
  assert.equal(systemLanguage('en-US'), 'en');
  assert.equal(systemLanguage(''), null);
  assert.equal(resolveLanguage('auto', 'pt-BR'), 'pt');
  assert.equal(resolveLanguage('off', 'tr-TR'), null);
  assert.equal(resolveLanguage('ja', 'tr-TR'), 'ja');
  assert.equal(resolveLanguage('../x', 'tr-TR'), null, 'junk is not a language');
  for (const ok of ['auto', 'off', 'tr', 'yue']) assert.ok(validSubtitleLanguage(ok), ok);
  for (const bad of ['', 'player', 'TR', 'tür', 5, null, 'a'.repeat(5)]) assert.ok(!validSubtitleLanguage(bad), String(bad));
  for (const ok of ['player', 'original', 'en']) assert.ok(validAudioLanguage(ok), ok);
  for (const bad of ['auto', '', 'EN', null, 'orig']) assert.ok(!validAudioLanguage(bad), String(bad));
});

test('lead track: a page default that is only foreign phrases gives way to the full track of the same language', () => {
  const sparseDefault = track('tur', { default: true, cues: Array(20) }), full = track('tur', { cues: Array(100) });
  assert.equal(pickLead([sparseDefault, full], 'en'), 1, 'two Turkish tracks, the page flagged the short one: the full one leads, whatever the user\'s language');
  assert.equal(pickLead([track('tur', { default: true, cues: Array(60) }), track('tur', { cues: Array(100) })], 'en'), 0, 'a track that is not that short keeps the page\'s flag');
  assert.equal(pickLead([track('tur', { default: true, cues: Array(20) }), track('eng', { cues: Array(100) })], 'en'), 0, 'no full track of the same language: the page\'s choice stays');
});

test('lead track: when the file offers one language only, its full track leads even if that is not the user\'s language', () => {
  assert.equal(pickLead([track('tur', { cues: Array(20) }), track('tur', { cues: Array(100) })], 'en'), 1);
  assert.equal(pickLead([track('tur', { cues: Array(100) }), track('tur', { cues: Array(90) })], null), 0, 'subtitle language off: still the single language of the file');
  assert.equal(pickLead([track('eng', { cues: Array(100) }), track('deu', { cues: Array(100) })], 'tr'), -1, 'two languages, none preferred: nothing is guessed');
  assert.equal(pickLead([track('und', { iso1: undefined, cues: Array(100) }), track('und', { iso1: undefined, cues: Array(90) })], 'tr'), -1, 'unknown languages are not "one language"');
});
