// Public, unprotected Apple sample. Download only ONE segment per track into an isolated temporary folder.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { readHls, hlsInfo } from '../../src/hls.js';
import { downloadHls } from '../../src/hls-download.js';
import { requestRemote } from '../../src/network.js';
import { spawnManaged } from '../../src/process.js';
import { verifyVideo } from '../../src/media.js';
import { buildQualityOptions } from '../../src/quality.js';

const toolsDirectory = path.resolve(import.meta.dirname, '../../tools');
const directory = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-hls-public-'));
const url = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8';
const signal = AbortSignal.timeout(90000);
try {
  const started = performance.now(), playlist = await readHls({ url, signal });
  const info = hlsInfo(playlist, url), { options } = buildQualityOptions(info, { ffmpeg: true });
  const ms = Math.round(performance.now() - started);
  const video = process.argv.includes('--1080') ? playlist.variants.find(v => v.height === 1080) : playlist.variants.find(v => v.url.includes('/v2/'));
  const audio = playlist.audios.find(a => a.group === video.audioGroup);
  const sources = [{ url: video.url }, { url: audio.url }], short = new Map(); let expectedDuration;
  for (const source of sources) {
    const p = await readHls({ url: source.url, signal });
    const segment = p.segments[0]; expectedDuration ||= segment.duration;
    short.set(source.url, ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(segment.duration)}`,
      ...(p.map ? [`#EXT-X-MAP:URI="${p.map}"`] : []), `#EXTINF:${segment.duration},`, segment.url, '#EXT-X-ENDLIST'].join('\n'));
  }
  const request = async (target, requestSignal, headers) => short.has(target)
    ? { url: new URL(target), response: Object.assign(Readable.from([Buffer.from(short.get(target))]), { statusCode: 200, headers: {} }) }
    : requestRemote(target, requestSignal, headers);
  const result = await downloadHls({ sources, directory, toolsDirectory, signal, request, spawn: spawnManaged, connections: 2 });
  const verified = await verifyVideo(result.output, toolsDirectory, expectedDuration, signal);
  if (verified.height !== video.height || !verified.audio) throw new Error('Seçilen kalite/ses doğrulanmadı.');
  console.log(JSON.stringify({ masterMilliseconds: ms, qualities: options.map(o => o.label), tested: `Apple ${video.height}p + audio (one segment each)`, bytes: fs.statSync(result.output).size, verified }, null, 2));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
