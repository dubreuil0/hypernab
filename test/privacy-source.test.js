import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseExtractorArgs } from '../src/media.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function files(dir, pattern) { return fs.readdirSync(path.join(root, dir), { recursive: true }).map(name => path.join(dir, String(name))).filter(file => pattern.test(file) && fs.statSync(path.join(root, file)).isFile()); }

test('the old product name and any competitor name appear nowhere in the shipped code or the documents', () => {
  const list = [...files('src', /\.(js|cjs|mjs|html|css|json)$/), ...files('extension', /\.(js|html|css|json)$/), ...files('public', /\.(js|html|css|svg)$/), ...files('desktop', /\.(js|cjs|html|css)$/), ...files('scripts', /\.(js|ps1)$/), ...files('docs', /\.md$/), 'README.md', 'README.tr.md', 'PRIVACY.md', 'PRIVACY.tr.md', 'THIRD_PARTY_NOTICES.md', 'package.json'];
  const found = list.filter(file => /\bidm/i.test(read(file)));
  assert.deepEqual(found, []);
});

test('downloads introduce themselves as Hypernab with its version, and yt-dlp keeps its cache inside Hypernab\'s own data folder', () => {
  assert.match(read('src/network.js'), /'User-Agent': `Hypernab\/\$\{process\.env\.HYPERNAB_VERSION/);
  const before = process.env.HYPERNAB_DATA_DIR;
  try {
    delete process.env.HYPERNAB_DATA_DIR;
    assert.ok(baseExtractorArgs('C:/not-installed').includes('--no-cache-dir'), 'no data folder known: no cache at all (never the home folder)');
    process.env.HYPERNAB_DATA_DIR = 'D:/LocalData/hypernab';
    const args = baseExtractorArgs('C:/not-installed'), at = args.indexOf('--cache-dir');
    assert.ok(at >= 0 && args[at + 1].replaceAll('\\', '/') === 'D:/LocalData/hypernab/ytdlp-cache');
    assert.equal(args.includes('--no-cache-dir'), false);
  } finally { if (before === undefined) delete process.env.HYPERNAB_DATA_DIR; else process.env.HYPERNAB_DATA_DIR = before; }
});

test('the extension keeps no address of a visited page in its key names, and the app\'s saved error text carries no address', () => {
  assert.equal(/float-outbox:\$\{[^}]*tab\.url/.test(read('extension/float.js')), false);
  assert.match(read('src/downloads.js'), /job\.error = String\(error\.message\)\.replace\(\/https\?:/);
});

test('the installer\'s staging folder is emptied before it is filled (no file of an older version ships)', () => {
  const script = read('scripts/release/prepare-desktop.js');
  assert.ok(script.indexOf('fs.rmSync(engine, { recursive: true, force: true })') > 0 && script.indexOf('fs.rmSync(engine') < script.indexOf('fs.cpSync(path.join(root, name), path.join(engine, name)'));
});

test('the app window has DevTools only in development', () => {
  assert.match(read('desktop/main.cjs'), /devTools: !app\.isPackaged/);
});
