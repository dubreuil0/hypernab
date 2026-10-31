import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { audioChoices, hlsInfo, parseHls } from '../src/hls.js';
import { DownloadQueue } from '../src/downloads.js';

const tools = path.resolve('tools');
const temp = process.env.LOCALAPPDATA + '/Temp/opencode';
const base = 'https://cdn.example.org/m/master.m3u8';
// One picture list and two sounds in one group: the Turkish dub is the site's default, the original is the one the viewer may switch to.
const master = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="au",NAME="Türkçe Dublaj",LANGUAGE="tr",DEFAULT=YES,URI="tr/audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="au",NAME="Orijinal",LANGUAGE="en",DEFAULT=NO,URI="en/audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="au"', 'v720.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="au"', 'v360.m3u8', ''
].join('\n');
const list = prefix => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${[0, 1, 2].map(i => `#EXTINF:2,\n${prefix}-${i}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`;
const body = new Map([
  ['/m/master.m3u8', master], ['/m/v720.m3u8', list('v720')], ['/m/v360.m3u8', list('v360')], ['/m/tr/audio.m3u8', list('tr')], ['/m/en/audio.m3u8', list('en')]
]);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(temp, 'hypernab-audio-test-'));
  const request = async target => {
    const text = body.get(new URL(target).pathname);
    if (text === undefined) throw new Error(`unexpected ${target}`);
    return { url: new URL(target), response: Object.assign(Readable.from([Buffer.from(text)]), { statusCode: 200, headers: { 'content-length': String(Buffer.byteLength(text)) } }) };
  };
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: request, mediaInspector: () => { throw new Error('yt-dlp must not run'); } });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
async function inspected(queue) {
  const view = await queue.inspect({ url: base, mediaKind: 'HLS', title: 'Film' });
  await Promise.all([...queue.hlsInspections.values()].map(entry => entry.work));
  return view;
}

test('a master with several sounds offers all of them (names, languages, the site\'s default) without leaking addresses', () => {
  const raw = hlsInfo(parseHls(master, base), base, 'Film');
  const choices = audioChoices(raw);
  assert.deepEqual(choices, [{ id: 'a0', name: 'Türkçe Dublaj', language: 'tr', default: true }, { id: 'a1', name: 'Orijinal', language: 'en', default: false }]);
  assert.ok(!JSON.stringify(choices).includes('cdn.example.org'));
  const single = hlsInfo(parseHls(master.replace(/#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="au",NAME="Orijinal"[^\n]*\n/, ''), base), base, 'Film');
  assert.deepEqual(audioChoices(single), [], 'no choice, nothing to show');
});

test('the inspection result lists the sounds, and the chosen one decides which sound is downloaded', async t => {
  const queue = fixture(t), view = await inspected(queue);
  assert.deepEqual(view.audioTracks.map(track => track.id), ['a0', 'a1']);
  const option = view.options[0];
  const add = extra => queue.add({ url: base, engine: 'extractor', formatId: option.id, title: 'Film', start: 'queue', ...extra });
  const defId = add({}), origId = add({ audioTrack: 'a1' });
  const def = queue.jobs.find(job => job.id === defId), orig = queue.jobs.find(job => job.id === origId);
  const audioOf = job => queue.cachedSelection(job).requested_formats.find(format => format.vcodec === 'none').url;
  assert.equal(audioOf(def), 'https://cdn.example.org/m/tr/audio.m3u8', 'without a choice the site\'s default sound is used, as before');
  assert.equal(audioOf(orig), 'https://cdn.example.org/m/en/audio.m3u8', 'the picked sound replaces it');
  assert.equal(orig.audioTrack, 'a1'); assert.equal(orig.audioName, 'Orijinal');
  assert.equal(queue.findDuplicates({ url: base, formatId: option.id }).length, 1, 'the default-sound download is one');
  assert.equal(queue.findDuplicates({ url: base, formatId: option.id, audioTrack: 'a1' }).length, 1, 'another sound is another download');
  assert.equal(queue.findDuplicates({ url: base, formatId: option.id, audioTrack: 'a0' }).length, 0);
});

test('a sound the server never offered, or one on a plain file, is refused (selection expired)', async t => {
  const queue = fixture(t), view = await inspected(queue);
  for (const bad of ['a9', 'x', '../a0', 7]) {
    assert.throws(() => queue.add({ url: base, engine: 'extractor', formatId: view.options[0].id, audioTrack: bad }), error => error.code === 'SELECTION_EXPIRED', String(bad));
  }
  assert.equal(queue.jobs.length, 0);
});

test('the sound the page is fetching right now is found from its newest piece requests', async t => {
  const queue = fixture(t); await inspected(queue);
  const piece = (name, at) => ({ url: `https://cdn.example.org/m/${name}`, at });
  // The viewer started with the dub and switched to the original: the newest audio pieces are the original's.
  const switched = await queue.activeAudio({ url: base, recent: [piece('tr/tr-0.ts', 1000), piece('tr/tr-1.ts', 2000), piece('v720-1.ts', 2500), piece('en/en-0.ts', 3000), piece('en/en-1.ts', 4000)] });
  assert.deepEqual(switched, { active: 'a1' });
  const dub = await queue.activeAudio({ url: base, recent: [piece('en/en-0.ts', 1000), piece('tr/tr-0.ts', 2000), piece('tr/tr-1.ts', 3000)] });
  assert.deepEqual(dub, { active: 'a0' });
  assert.deepEqual(await queue.activeAudio({ url: base, recent: [piece('v720-2.ts', 5000), { url: 'not an address', at: 1 }] }), { active: null }, 'picture pieces and junk prove nothing');
  assert.deepEqual(await queue.activeAudio({ url: base, recent: [] }), { active: null });
  assert.deepEqual(await queue.activeAudio({ url: 'https://cdn.example.org/never-inspected.m3u8', recent: [piece('en/en-0.ts', 1)] }), { active: null });
});
