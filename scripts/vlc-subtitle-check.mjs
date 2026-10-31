// Builds a film with two unnamed subtitle files like a real page (sparse English first, full Turkish second) through the real
// subtitle code, then lets the installed VLC open it and reports which subtitle track VLC switched on by itself. Test files live in a
// temporary folder that is removed afterwards. Usage: node scripts/vlc-subtitle-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DownloadQueue } from '../src/downloads.js';

const tools = path.resolve('tools');
const vlc = ['C:/Program Files/VideoLAN/VLC/vlc.exe', 'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe'].find(file => fs.existsSync(file));
if (!vlc) { console.log('VLC bulunamadı'); process.exit(2); }
const clock = seconds => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.000`;
const vtt = lines => `WEBVTT\n\n${lines.map((text, i) => `${clock(i * 2 + 1)} --> ${clock(i * 2 + 2)}\n${text}\n`).join('\n')}`;
const TURKISH = Array.from({ length: 4 }, (_, i) => ['Bu işi bir daha yapmak için ben çok geç kaldım.', 'Sen ne yapıyorsun burada? Hiç anlamıyorum.', 'Evet, ama bunu şimdi değil, daha sonra konuşuruz.', 'Neden bana bunu söylemedin? Çünkü korkuyordum.'][i]);
const FORCED = ['You don\'t know what you\'re doing.', 'That is not the way it works in this place.'];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-vlc-'));
try {
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: tools, rangeRequest: async () => { throw new Error('no network'); } });
  const directory = path.join(root, 'd'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'v-Film.mp4');
  const made = spawnSync(path.join(tools, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=9', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const job = { id: 'v', status: 'running', directory, file: 'v-Film.mp4', headers: {}, url: 'https://cdn.example.org/v.mp4', subtitlePending: queue.storeSubtitleInputs('v', { subtitleTracks: [{ text: vtt(FORCED) }, { text: vtt(TURKISH) }] }) };
  await queue.attachSubtitles(job, new AbortController().signal);
  queue.stop();
  console.log('altyazı sonucu:', job.subtitleResult.mode, JSON.stringify(job.subtitleResult.tracks), JSON.stringify(job.subtitleResult.files));

  const play = (label, target) => {
    const run = spawnSync(vlc, ['-I', 'dummy', '--no-video-title-show', '--vout', 'dummy', '--aout', 'dummy', '--play-and-exit', '--run-time=4', '--verbose=2', '--no-one-instance', '--no-plugins-cache', target], { encoding: 'utf8', timeout: 40000 });
    const log = `${run.stdout || ''}\n${run.stderr || ''}`;
    const interesting = log.split(/\r?\n/).filter(line => /(subtitle|spu|sub-track|Adding ES|selected|SPU|auto-?select|\.srt|mov_text|tx3g)/i.test(line) && !/plugin|cache|module/i.test(line)).slice(0, 40);
    console.log(`\n=== ${label} ===`); console.log(interesting.join('\n') || '(ilgili satır yok)');
  };
  // 1) embedded only (the sidecar removed): does VLC switch the default track on by itself?
  const sidecars = fs.readdirSync(directory).filter(name => name.endsWith('.srt'));
  const hidden = sidecars.map(name => { const from = path.join(directory, name), to = path.join(root, `moved-${name}`); fs.renameSync(from, to); return [from, to]; });
  play('yalnız gömülü altyazı', file);
  // 2) with the side file next to the video
  for (const [from, to] of hidden) fs.renameSync(to, from);
  play('gömülü + yan .srt', file);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
