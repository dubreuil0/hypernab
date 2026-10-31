import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['background.js', 'native-config.js', 'native.js', 'core.js', 'float.js', 'takeover.js', 'download-prompt.html', 'download-prompt.js', 'download-prompt.css', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'preview.css'];
export function buildExtensions(outDir = path.join(root, 'build', 'extensions'), { nativeHost } = {}) {
  if (nativeHost !== undefined && !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(nativeHost)) throw new Error('Geçersiz Native host adı.');
  const base = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const outputs = {};
  for (const family of ['firefox', 'chromium']) {
    const dir = path.join(outDir, family);
    const marker = path.join(dir, '.hypernab-build');
    // .hyperdown-build: the same generated folder from before the product was renamed.
    if (fs.existsSync(dir) && !fs.existsSync(marker) && !fs.existsSync(path.join(dir, '.hyperdown-build'))) throw new Error(`Hedef klasör Hypernab tarafından üretilmemiş: ${dir}`);
    fs.rmSync(path.join(dir, '.hyperdown-build'), { force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, 'Generated development extension; do not keep personal files here.\n');
    const manifest = structuredClone(base);
    // Firefox can hold a file's response until the user decides (nothing ever lands in the browser's download list);
    // Chrome and Edge can only hide the download bubble for the moment the file is handed over.
    if (family === 'firefox') manifest.permissions = [...manifest.permissions, 'webRequestBlocking'];
    if (family === 'chromium') {
      manifest.permissions = [...manifest.permissions, 'downloads.ui'];
      manifest.background = { service_worker: 'background.js' };
      manifest.minimum_chrome_version = '121';
      manifest.key = JSON.parse(fs.readFileSync(path.join(root, 'extension/chromium-key.json'), 'utf8')).key;
      delete manifest.browser_specific_settings;
    }
    for (const asset of assets) fs.copyFileSync(path.join(root, 'extension', asset), path.join(dir, asset));
    fs.cpSync(path.join(root, 'extension', 'icons'), path.join(dir, 'icons'), { recursive: true });
    if (nativeHost) fs.writeFileSync(path.join(dir, 'native-config.js'), `globalThis.HypernabNativeHost = ${JSON.stringify(nativeHost)};\n`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    outputs[family] = dir;
  }
  return outputs;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildExtensions(process.argv[2] ? path.resolve(process.argv[2]) : undefined), null, 2));
