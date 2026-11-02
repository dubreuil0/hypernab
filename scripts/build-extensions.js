import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = ['background.js', 'native-config.js', 'native.js', 'core.js', 'float.js', 'link-download.js', 'content.js', 'control.js', 'options.html', 'options.js', 'options.css'];
const sharedAssets = ['ds.css', 'ds.js', 'strings.js'];
// The page panel lives in a closed shadow root and cannot load a stylesheet file: its CSS (design system + panel) travels as a script.
export function panelCssScript() {
  const css = ['public/ds.css', 'extension/panel.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n').replace(/\s*\n\s*/g, '\n').trim();
  return `globalThis.HypernabPanelCss = ${JSON.stringify(css)};\n`;
}
// store: the packages sent to the Chrome Web Store / Firefox add-ons site. The development key is left out of the Chromium one: the store
// gives the item its own key (shown in its dashboard), which then replaces the development key so the extension id stays the same.
export function buildExtensions(outDir = path.join(root, 'build', 'extensions'), { nativeHost, store = false } = {}) {
  if (nativeHost !== undefined && !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(nativeHost)) throw new Error('Geçersiz Native host adı.');
  const base = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const outputs = {};
  for (const family of ['firefox', 'chromium']) {
    const dir = path.join(outDir, family);
    const marker = path.join(dir, '.hypernab-build');
    // .hyperdown-build: the same generated folder from before the product was renamed.
    if (fs.existsSync(dir) && !fs.existsSync(marker) && !fs.existsSync(path.join(dir, '.hyperdown-build'))) throw new Error(`Hedef klasör Hypernab tarafından üretilmemiş: ${dir}`);
    fs.rmSync(path.join(dir, '.hyperdown-build'), { force: true });
    // This folder is ours (the marker says so, checked above): start empty, so no file of an older version can ever ride along into a package.
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, 'Generated development extension; do not keep personal files here.\n');
    const manifest = structuredClone(base);
    if (family === 'chromium') {
      manifest.background = { service_worker: 'background.js' };
      manifest.minimum_chrome_version = '121';
      if (!store) manifest.key = JSON.parse(fs.readFileSync(path.join(root, 'extension/chromium-key.json'), 'utf8')).key;
      delete manifest.browser_specific_settings;
    }
    for (const asset of assets) fs.copyFileSync(path.join(root, 'extension', asset), path.join(dir, asset));
    // The design system is written once (public/) and shared by the app, the page panel and the extension windows.
    for (const asset of sharedAssets) fs.copyFileSync(path.join(root, 'public', asset), path.join(dir, asset));
  fs.cpSync(path.join(root, 'extension', '_locales'), path.join(dir, '_locales'), { recursive: true }); // the name and description in each language
    fs.cpSync(path.join(root, 'extension', 'icons'), path.join(dir, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'panel-css.js'), panelCssScript());
    if (nativeHost) fs.writeFileSync(path.join(dir, 'native-config.js'), `globalThis.HypernabNativeHost = ${JSON.stringify(nativeHost)};\n`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    outputs[family] = dir;
  }
  return outputs;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildExtensions(process.argv[2] ? path.resolve(process.argv[2]) : undefined), null, 2));
