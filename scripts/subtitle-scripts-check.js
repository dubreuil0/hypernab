// Real tools, real files: subtitles in many alphabets go through the whole path. A subtitle file in its country's legacy code page is
// decoded, parsed, put into a video whose NAME is in the same alphabet (mp4 and mkv), read back out with ffmpeg and compared; the track
// language tag and title are read back with ffprobe; the side .srt is checked too. Runs against tools/ in the repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeText } from '../src/text-decode.js';
import { guessLanguage, parseSubtitle, toVtt, languageInfo, embedSubtitles, writeSidecars } from '../src/subtitles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), tools = path.join(root, 'tools');
const ffmpeg = path.join(tools, 'ffmpeg.exe'), ffprobe = path.join(tools, 'ffprobe.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-scripts-'));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'HATA'} ${name}${ok ? '' : ` ${detail}`}`); };

const CASES = [
  { lang: 'ru', page: 'windows-1251', title: 'Фильм про зиму', lines: ['Я не знаю, что ты хочешь от меня.', 'Это было так давно, и теперь все изменилось.', 'Мы должны идти, потому что уже поздно.'] },
  { lang: 'ar', page: 'windows-1256', title: 'فيلم عن الشتاء', lines: ['أنا لا أعرف ماذا تريد مني.', 'كان هذا قبل وقت طويل وكل شيء قد تغير الآن.', 'نحن يجب أن نذهب لأن الوقت متأخر.'] },
  { lang: 'he', page: 'windows-1255', title: 'סרט על החורף', lines: ['אני לא יודע מה אתה רוצה ממני.', 'זה היה לפני הרבה זמן ועכשיו הכל השתנה.', 'אנחנו צריכים ללכת כי כבר מאוחר.'] },
  { lang: 'el', page: 'windows-1253', title: 'Ταινία για τον χειμώνα', lines: ['Δεν ξέρω τι θέλεις από εμένα.', 'Αυτό ήταν πριν από πολύ καιρό και τώρα όλα έχουν αλλάξει.', 'Πρέπει να φύγουμε γιατί είναι αργά.'] },
  { lang: 'zh', page: 'gbk', title: '冬天的故事', lines: ['我不知道你想要我做什么。', '这是很久以前的事了，现在一切都变了。', '我们必须走了，因为已经很晚了。'] },
  { lang: 'ja', page: 'shift_jis', title: '冬の物語', lines: ['あなたが私に何を望んでいるのか、私にはわかりません。', 'それはずっと昔のことで、今はすべてが変わってしまいました。', 'もう遅いので、私たちは行かなければなりません。'] },
  { lang: 'ko', page: 'euc-kr', title: '겨울 이야기', lines: ['나는 당신이 나에게 무엇을 원하는지 모르겠어요.', '그것은 아주 오래전의 일이고 지금은 모든 것이 변했어요.', '우리는 가야 해요, 이미 늦었으니까요.'] },
  { lang: 'tr', page: 'windows-1254', title: 'Kış hikâyesi', lines: ['Senden ne istediğimi bilmiyorum ama bu çok önemli.', 'Şimdi gitmemiz gerekiyor çünkü hava karardı.', 'Bunu bana daha önce söylemeliydin, değil mi?'] }
];
// the browser's own decoder, run backwards, writes the bytes of a legacy page
function legacyBytes(label, text) {
  const decoder = new TextDecoder(label), map = new Map();
  for (let a = 0; a < 256; a++) { const ch = decoder.decode(Uint8Array.of(a)); if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a]); }
  if (['gbk', 'shift_jis', 'euc-kr'].includes(label)) for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) { const ch = decoder.decode(Uint8Array.of(a, b)); if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [a, b]); }
  const bytes = []; for (const ch of text) { const value = map.get(ch); if (!value) throw new Error(`${label} cannot hold ${ch}`); bytes.push(...value); }
  return Buffer.from(bytes);
}
const srtOf = lines => lines.map((line, i) => `${i + 1}\r\n00:00:0${i},000 --> 00:00:0${i},900\r\n${line}\r\n`).join('\r\n');
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true });

try {
  const base = path.join(work, 'base.mp4');
  let made = run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  if (made.status !== 0) made = run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', base]);
  check('test video made with the bundled ffmpeg', made.status === 0, made.stderr);

  for (const item of CASES) {
    const raw = srtOf(item.lines), bytes = legacyBytes(item.page, raw);
    const decoded = decodeText(bytes);
    check(`${item.lang}: ${item.page} file is read back exactly (${decoded.encoding})`, decoded.text === raw && decoded.confident, decoded.text.slice(0, 60));
    const parsed = parseSubtitle(decoded.text);
    check(`${item.lang}: parsed into ${item.lines.length} cues`, parsed?.cues.length === item.lines.length);
    const long = srtOf(Array.from({ length: 6 }, () => item.lines).flat());
    check(`${item.lang}: the language is told from the words alone`, guessLanguage(parseSubtitle(long).cues) === item.lang, String(guessLanguage(parseSubtitle(long).cues)));
    for (const container of ['keep', 'mkv']) {
      const dir = path.join(work, `${item.lang}-${container}`); fs.mkdirSync(dir);
      const video = path.join(dir, `${item.title}.mp4`); fs.copyFileSync(base, video);
      const lang = languageInfo(item.lang), track = { ...lang, name: item.title, default: true, cues: parsed.cues, file: path.join(dir, 'track.vtt') };
      fs.writeFileSync(track.file, toVtt(parsed.cues));
      const finished = await embedSubtitles({ video, tracks: [track], toolsDirectory: tools, signal: AbortSignal.timeout(60000), preferred: item.lang, container });
      check(`${item.lang}/${container}: embedded into a file named "${path.basename(video)}"`, Boolean(finished) && fs.existsSync(finished), String(finished));
      if (!finished) continue;
      const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:stream_tags=language,title', '-of', 'json', finished]).stdout || '{}');
      const sub = (probe.streams || []).find(stream => stream.codec_type === 'subtitle');
      // an mp4 keeps the language tag only; a track title is a Matroska feature
      check(`${item.lang}/${container}: language tag ${lang.iso3}${container === 'mkv' ? ` and title "${item.title}"` : ''} survive`, sub?.tags?.language === lang.iso3 && (container === 'keep' || sub?.tags?.title === item.title), JSON.stringify(sub));
      const out = path.join(dir, 'back.srt'); run(ffmpeg, ['-v', 'error', '-y', '-i', finished, '-map', '0:s:0', out]);
      const back = fs.existsSync(out) ? parseSubtitle(fs.readFileSync(out, 'utf8')) : null;
      check(`${item.lang}/${container}: the text read back out of the video is the same`, JSON.stringify(back?.cues.map(cue => cue.text)) === JSON.stringify(item.lines), JSON.stringify(back?.cues.map(cue => cue.text)));
      if (container === 'keep') {
        const side = writeSidecars(finished, [track]), sideText = side[0] ? fs.readFileSync(path.join(dir, side[0]), 'utf8') : '';
        check(`${item.lang}: the side file carries the video's name and the same text`, side[0] === `${item.title}.${lang.iso1}.srt` && sideText.startsWith('﻿') && parseSubtitle(sideText)?.cues.map(cue => cue.text).join('|') === item.lines.join('|'), side[0]);
      }
    }
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }
console.log(failed ? `SONUÇ: ${failed} hata` : 'SONUÇ: hepsi geçti');
process.exitCode = failed ? 1 : 0;
