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
  const queue = new DownloadQueue({ locale: 'tr-TR', directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } }); queue.setSettings({ subtitleMode: 'both' }); // these tests are about the default track and the side file: they ask for both
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
for (const [locale, setting, expectFlag, expectFiles] of [['en-US', 'auto', 'eng', ['k-Film.en.srt']], ['de-DE', 'auto', 'eng', ['k-Film.en.srt']], ['de-DE', 'tr', 'tur', ['k-Film.tr.srt']], ['tr-TR', 'off', null, []]]) {
  test(`default subtitle for system language ${locale}, setting "${setting}": ${expectFlag || 'none flagged'}`, { skip: !haveTools }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-pref-'));
    const queue = new DownloadQueue({ locale, directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } }); queue.setSettings({ subtitleMode: 'both' }); // these tests are about the default track and the side file: they ask for both
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

test('a page that flags the short (foreign phrases) Turkish track as default: the full Turkish track leads, with an English system', { skip: !haveTools }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-twotr-'));
  const queue = new DownloadQueue({ locale: 'en-US', directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } }); queue.setSettings({ subtitleMode: 'both' }); // these tests are about the default track and the side file: they ask for both
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'd'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'm-Film.mp4');
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(made.status, 0, String(made.stderr));
  const job = { id: 'm', status: 'running', directory, file: 'm-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4',
    subtitlePending: queue.storeSubtitleInputs('m', { subtitleTracks: [{ lang: 'tr', label: 'Türkçe', default: true, text: vtt(TURKISH.slice(0, 8)) }, { lang: 'tr', label: 'Türkçe', default: false, text: vtt(TURKISH) }] }) };
  await queue.attachSubtitles(job, new AbortController().signal);
  assert.equal(job.subtitleResult.mode, 'embedded+sidecar', job.subtitleResult.note);
  assert.deepEqual(job.subtitleResult.files, ['m-Film.tr.srt']);
  assert.match(fs.readFileSync(path.join(directory, 'm-Film.tr.srt'), 'utf8'), /Sen ne yapıyorsun burada/, 'the side file is the full track');
  const subs = JSON.parse(spawnSync(path.join(tools, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index:stream_disposition=default', '-of', 'json', file]).stdout).streams;
  assert.deepEqual(subs.map(sub => sub.disposition.default), [1, 0], 'the first track in the file (the full one) is the flagged default');
  const first = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', '-']).stdout.toString();
  assert.match(first, /Sen ne yapıyorsun burada/, 'and it is the full one');
});

test('settings saved by the first version ("embed" as the untouched default) move to "embed + side file" once; a later explicit choice stays', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-mig-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'queue.json');
  fs.writeFileSync(`${stateFile}.settings.json`, JSON.stringify({ subtitleMode: 'embed', theme: 'dark' }));
  const first = new DownloadQueue({ directory: path.join(root, 'd'), stateFile, toolsDirectory: tools });
  assert.equal(first.settings.subtitleMode, 'off', 'the old default moved over to off');
  first.setSettings({ subtitleMode: 'embed' }); first.stop();
  const second = new DownloadQueue({ directory: path.join(root, 'd'), stateFile, toolsDirectory: tools });
  assert.equal(second.settings.subtitleMode, 'embed', 'a choice made after the move is kept'); second.stop();
});

// Optional "save as mkv" (off by default): VLC opens a default subtitle by itself in mkv, never in mp4.
async function mkvFixture(t, name, settings, prepare = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-mkv-'));
  const queue = new DownloadQueue({ locale: 'tr-TR', directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } }); queue.setSettings({ subtitleMode: 'both' }); // these tests are about the default track and the side file: they ask for both
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  if (settings) queue.setSettings(settings);
  const directory = path.join(root, 'd'); fs.mkdirSync(directory, { recursive: true });
  prepare(directory);
  const file = path.join(directory, `${name}-Film.mp4`);
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(made.status, 0, String(made.stderr));
  const job = { id: name, status: 'running', directory, file: `${name}-Film.mp4`, headers: {}, url: 'https://cdn.example.org/v.mp4',
    subtitlePending: queue.storeSubtitleInputs(name, { subtitleTracks: [{ lang: 'tr', label: 'Türkçe', default: true, text: vtt(TURKISH.slice(0, 8)) }, { lang: 'tr', label: 'Türkçe', default: false, text: vtt(TURKISH) }] }) };
  await queue.attachSubtitles(job, new AbortController().signal);
  const probe = target => JSON.parse(spawnSync(path.join(tools, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_disposition=default', '-of', 'json', target]).stdout).streams;
  return { job, directory, queue, probe };
}

test('the video format with subtitles is "keep" by default and only "keep" or "mkv" are accepted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-mkvset-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools }); queue.setSettings({ subtitleMode: 'both' }); // these tests are about the default track and the side file: they ask for both
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(queue.settings.subtitleContainer, 'keep');
  assert.throws(() => queue.setSettings({ subtitleContainer: 'avi' }));
  assert.equal(queue.setSettings({ subtitleContainer: 'mkv' }).subtitleContainer, 'mkv');
});

test('"mkv": the mp4 becomes an mkv with the same picture and sound, the full subtitle flagged default, the side .srt still written', { skip: !haveTools }, async t => {
  const { job, directory, probe } = await mkvFixture(t, 'n', { subtitleContainer: 'mkv' });
  assert.equal(job.file, 'n-Film.mkv', 'the job now points at the mkv');
  assert.ok(fs.existsSync(path.join(directory, 'n-Film.mkv')) && !fs.existsSync(path.join(directory, 'n-Film.mp4')), 'one file, not both');
  const streams = probe(path.join(directory, 'n-Film.mkv'));
  assert.deepEqual(streams.map(s => s.codec_type), ['video', 'audio', 'subtitle', 'subtitle']);
  assert.equal(streams[0].codec_name, 'h264'); assert.equal(streams[1].codec_name, 'aac', 'copied, not re-encoded');
  assert.deepEqual(streams.filter(s => s.codec_type === 'subtitle').map(s => s.disposition.default), [1, 0], 'the full track (first) is the default');
  assert.deepEqual(job.subtitleResult.files, ['n-Film.tr.srt']);
  assert.match(fs.readFileSync(path.join(directory, 'n-Film.tr.srt'), 'utf8'), /Sen ne yapıyorsun burada/);
});

test('"mkv" never overwrites an mkv that is already there: the mp4 keeps the subtitles', { skip: !haveTools }, async t => {
  const { job, directory, probe } = await mkvFixture(t, 'o', { subtitleContainer: 'mkv' }, dir => fs.writeFileSync(path.join(dir, 'o-Film.mkv'), 'someone else'));
  assert.equal(job.file, 'o-Film.mp4');
  assert.equal(fs.readFileSync(path.join(directory, 'o-Film.mkv'), 'utf8'), 'someone else');
  assert.equal(probe(path.join(directory, 'o-Film.mp4')).filter(s => s.codec_type === 'subtitle').length, 2);
});

test('default ("keep"): the file stays an mp4', { skip: !haveTools }, async t => {
  const { job, directory } = await mkvFixture(t, 'p', null);
  assert.equal(job.file, 'p-Film.mp4'); assert.ok(!fs.existsSync(path.join(directory, 'p-Film.mkv')));
});

test('subtitles are off by default; an old default moves to off once, a deliberate choice is kept', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-subdef-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const open = (name, saved) => {
    const stateFile = path.join(root, `${name}.json`);
    if (saved) fs.writeFileSync(`${stateFile}.settings.json`, JSON.stringify(saved));
    const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile, toolsDirectory: tools }); const mode = queue.settings.subtitleMode; queue.stop(); return mode;
  };
  assert.equal(open('fresh'), 'off', 'a new install writes no subtitle by itself');
  assert.equal(open('v2-both', { subtitleMode: 'both', settingsVersion: 2 }), 'off', 'the old default (embed + side file) moves over');
  assert.equal(open('v2-embed', { subtitleMode: 'embed', settingsVersion: 2 }), 'embed', 'a deliberate choice is kept');
  assert.equal(open('v2-side', { subtitleMode: 'sidecar', settingsVersion: 2 }), 'sidecar');
  assert.equal(open('v3-both', { subtitleMode: 'both', settingsVersion: 3 }), 'both', 'chosen after the move: kept');
});