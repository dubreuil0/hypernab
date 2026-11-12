// Builds the two store packages: Chrome Web Store (zip, no development key) and Firefox add-ons (zip, signed by Mozilla on upload).
// Output: dist/store/hypernab-chrome-<version>.zip and dist/store/hypernab-firefox-<version>.zip. Nothing is uploaded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtensions } from './build-extensions.js';
import { zipFolder } from './zip-store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function packageExtensions({ outDir = path.join(root, 'dist', 'store'), work = path.join(root, 'build', 'store-extensions') } = {}) {
  const folders = buildExtensions(work, { store: true });
  fs.mkdirSync(outDir, { recursive: true });
  const read = family => JSON.parse(fs.readFileSync(path.join(folders[family], 'manifest.json'), 'utf8'));
  const chromium = read('chromium'), firefox = read('firefox');
  // What the stores require; checked here so a wrong package is never uploaded.
  if (chromium.key) throw new Error('Mağaza paketinde geliştirme anahtarı (key) olmamalı.');
  if (chromium.version !== firefox.version) throw new Error('Chromium ve Firefox sürümleri aynı olmalı.');
  const gecko = firefox.browser_specific_settings?.gecko;
  if (!gecko?.id || /local\.invalid/.test(gecko.id)) throw new Error('Firefox kalıcı kimliği yok.');
  if (JSON.stringify(gecko.data_collection_permissions?.required) !== '["none"]') throw new Error('Firefox veri toplama beyanı yok.');
  if (JSON.stringify(read('firefox')).match(/https?:\/\/(?!127\.0\.0\.1|\*)/)) throw new Error('Manifest dış adres içeriyor.');
  const files = {
    chrome: zipFolder(folders.chromium, path.join(outDir, `hypernab-chrome-${chromium.version}.zip`)),
    firefox: zipFolder(folders.firefox, path.join(outDir, `hypernab-firefox-${firefox.version}.zip`))
  };
  return { version: chromium.version, files, sizes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.statSync(file).size])) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageExtensions(), null, 2));
