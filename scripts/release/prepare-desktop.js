import fs from 'node:fs';
import path from 'node:path';
import { buildExtensions } from './build-extensions.js';
import './desktop-icon.js';
const root = path.resolve(import.meta.dirname, '../..');
for (const name of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe']) if (!fs.existsSync(path.join(root, 'tools', name))) throw new Error(`Missing bundled engine: ${name}`);
fs.mkdirSync(path.join(root, 'build/runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(root, 'build/runtime/node.exe'));
buildExtensions();
const engine = path.join(root, 'build/engine');
fs.rmSync(engine, { recursive: true, force: true }); // generated staging folder: it starts empty, so no file of an older version can ship in the installer
fs.mkdirSync(engine, { recursive: true });
for (const name of ['src', 'public']) fs.cpSync(path.join(root, name), path.join(engine, name), { recursive: true });
for (const name of ['scripts/setup/install-native.js', 'extension/manifest.json', 'extension/chromium-key.json', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
  fs.mkdirSync(path.dirname(path.join(engine, name)), { recursive: true });
  fs.copyFileSync(path.join(root, name), path.join(engine, name));
}
fs.writeFileSync(path.join(engine, 'package.json'), JSON.stringify({ type: 'module', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version }));
fs.mkdirSync(path.join(engine, 'tools'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'tools'))) if (/\.exe$|LICENSE|COPYING/i.test(name)) fs.copyFileSync(path.join(root, 'tools', name), path.join(engine, 'tools', name));
