import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSubtitleIndex, muxArguments } from '../src/subtitles.js';

const track = (iso3, extra = {}) => ({ file: `${iso3}.srt`, iso3, name: iso3, default: false, ...extra });

test('a player that names no default still leaves a subtitle switched on: the only track, else the Turkish one', () => {
  assert.equal(defaultSubtitleIndex([track('eng')]), 0);
  assert.equal(defaultSubtitleIndex([track('eng'), track('tur')]), 1);
  assert.equal(defaultSubtitleIndex([track('eng'), track('deu')]), -1, 'two foreign tracks and no hint: nothing is guessed');
  assert.equal(defaultSubtitleIndex([track('eng'), track('tur', { default: true })]), -1, 'the page already chose: its flags stay');
});

test('the default flag reaches the container (ffmpeg arguments)', () => {
  const flags = tracks => { const args = muxArguments('film.mp4', tracks, 'out.mp4'); return args.flatMap((arg, i) => arg.startsWith('-disposition:s:') ? [args[i + 1]] : []); };
  assert.deepEqual(flags([track('eng'), track('tur')]), ['0', 'default']);
  assert.deepEqual(flags([track('tur')]), ['default']);
  assert.deepEqual(flags([track('eng', { default: true }), track('tur')]), ['default', '0'], 'the page\'s own choice is untouched');
});
