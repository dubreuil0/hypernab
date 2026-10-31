import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DownloadQueue } from '../src/downloads.js';
import { guessLanguage, parseSubtitle } from '../src/subtitles.js';

const tools = path.resolve('tools');
const haveTools = fs.existsSync(path.join(tools, 'ffmpeg.exe')) && fs.existsSync(path.join(tools, 'ffprobe.exe'));
const clock = seconds => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.000`;
const vtt = lines => `WEBVTT\n\n${lines.map((text, i) => `${clock(i * 2 + 1)} --> ${clock(i * 2 + 2)}\n${text}\n`).join('\n')}`;
const TURKISH = Array.from({ length: 40 }, (_, i) => ['Bu işi bir daha yapmak için ben çok geç kaldım.', 'Sen ne yapıyorsun burada? Hiç anlamıyorum.', 'Evet, ama bunu şimdi değil, daha sonra konuşuruz.', 'Neden bana bunu söylemedin? Çünkü korkuyordum.'][i % 4]);
const ENGLISH_FORCED = ['You don\'t know what you\'re doing.', 'That is not the way it works in this place.', 'What do you want from me?'];
const ENGLISH_FULL = Array.from({ length: 40 }, (_, i) => ['I think that is what he said to me in the end.', 'You know the way it is, and we can do this together.', 'What are you doing here? It was not for you.', 'She has the keys and they are in the car with him.'][i % 4]);

test('the language of an unnamed subtitle file is read from its words', () => {
  const cues = lines => parseSubtitle(vtt(lines)).cues;
  assert.equal(guessLanguage(cues(TURKISH)), 'tr');
  assert.equal(guessLanguage(cues(ENGLISH_FULL)), 'en');
  assert.equal(guessLanguage(cues(ENGLISH_FORCED)), 'en', 'a few lines are enough when they are plain English');
  assert.equal(guessLanguage(cues(['Merhaba, nasılsın?'])), null, 'too little text to say');
  assert.equal(guessLanguage(cues(Array.from({ length: 30 }, () => 'Zxqv wplk mnbv tfrd qwer'))), null, 'nonsense is not guessed');
  assert.equal(guessLanguage(cues(Array.from({ length: 30 }, (_, i) => ['Das ist nicht das, was ich gesagt habe.', 'Ich weiß, aber du bist auch nicht hier.'][i % 2]))), 'de');
});

test('files named only "1.vtt" / "2.vtt": the full Turkish track leads and is the default, not the sparse foreign-phrases track that came first', { skip: !haveTools }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-lead-'));
  const queue = new DownloadQueue({ locale: 'tr-TR', directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'd'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'j-Film.mp4');
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(made.status, 0, String(made.stderr));
  // the sparse English track arrives FIRST (like "1.vtt"), the full Turkish one second ("2.vtt"); the page names no language or default
  const job = { id: 'j', status: 'running', directory, file: 'j-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4',
    subtitlePending: queue.storeSubtitleInputs('j', { subtitleTracks: [{ text: vtt(ENGLISH_FORCED) }, { text: vtt(TURKISH) }] }) };
  await queue.attachSubtitles(job, new AbortController().signal);
  assert.equal(job.subtitleResult.mode, 'embedded+sidecar', job.subtitleResult.note);
  assert.deepEqual(job.subtitleResult.files, ['j-Film.tr.srt'], 'the leading (Turkish) track is also written next to the video: Media Player and Films & TV load it by themselves');
  assert.ok(fs.existsSync(path.join(directory, 'j-Film.tr.srt')) && !fs.existsSync(path.join(directory, 'j-Film.en.srt')), 'one side file, not one per track');
  const subs = JSON.parse(spawnSync(path.join(tools, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index:stream_tags=language,title:stream_disposition=default', '-of', 'json', file]).stdout).streams;
  assert.equal(subs.length, 2);
  assert.equal(subs[0].disposition.default, 1, 'the first (and default) track is the one a player shows');
  assert.equal(subs[0].tags.language, 'tur', 'and it is the Turkish one'); assert.equal(job.subtitleResult.tracks[0].name, 'Türkçe'); assert.equal(job.subtitleResult.tracks[1].lang, 'en');
  assert.equal(subs[1].disposition.default, 0); assert.notEqual(subs[1].tags.language, 'tur');
});

// Same two files, different system languages: the default follows the user, and without a match nothing is flagged or written.
for (const [locale, setting, expectFlag, expectFiles] of [['en-US', 'auto', 'eng', ['k-Film.en.srt']], ['de-DE', 'auto', null, []], ['de-DE', 'tr', 'tur', ['k-Film.tr.srt']], ['tr-TR', 'off', null, []]]) {
  test(`default subtitle for system language ${locale}, setting "${setting}": ${expectFlag || 'none flagged'}`, { skip: !haveTools }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-pref-'));
    const queue = new DownloadQueue({ locale, directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } });
    t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    queue.setSettings({ subtitleLanguage: setting });
    const directory = path.join(root, 'd'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'k-Film.mp4');
    const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    assert.equal(made.status, 0, String(made.stderr));
    const job = { id: 'k', status: 'running', directory, file: 'k-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4',
      subtitlePending: queue.storeSubtitleInputs('k', { subtitleTracks: [{ text: vtt(ENGLISH_FULL) }, { text: vtt(TURKISH) }] }) };
    await queue.attachSubtitles(job, new AbortController().signal);
    assert.deepEqual(job.subtitleResult.files, expectFiles);
    const subs = JSON.parse(spawnSync(path.join(tools, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index:stream_tags=language:stream_disposition=default', '-of', 'json', file]).stdout).streams;
    assert.equal(subs.length, 2, 'every track is still inside the file');
    assert.deepEqual(job.subtitleResult.tracks.filter(track => track.default).length, expectFlag ? 1 : 0, 'what Hypernab flags as the default');
    // The mp4 container itself always enables its first subtitle when none is flagged (the muxer does this), so only a flagged case is checked in the file.
    if (expectFlag) assert.deepEqual(subs.filter(sub => sub.disposition.default === 1).map(sub => sub.tags.language), [expectFlag]);
  });
}
