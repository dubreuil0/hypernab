import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode/hypernab-browser-tools');
const driverOnly = process.argv.includes('--driver-only');
fs.mkdirSync(base, { recursive: true });
const json = async url => { const response = await fetch(url, { headers: { 'User-Agent': 'Hypernab-browser-tests' } }); if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`); return response.json(); };
async function archive(name, url, digest) {
  const zip = path.join(base, `${name}.zip`), dir = path.join(base, name);
  if (!fs.existsSync(path.join(dir, '.download-complete'))) {
    console.log(`Downloading official test dependency: ${name}`);
    const response = await fetch(url); if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const hash = createHash('sha256'); let received = 0; const started = performance.now();
    const limiter = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); received += chunk.length; const wait = Math.max(0, received / (driverOnly ? 1000000 : 4000000) * 1000 - (performance.now() - started)); setTimeout(() => done(null, chunk), wait); } });
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(zip));
    const sha256 = hash.digest('hex');
    if (digest?.startsWith('sha256:') && digest.slice(7) !== sha256) throw new Error(`${name}: official digest mismatch`);
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force`], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Archive extraction failed: ${name}`);
    fs.writeFileSync(path.join(dir, '.download-complete'), JSON.stringify({ url, sha256 }));
  }
  return dir;
}
try {
  if (driverOnly) {
    const gecko = await json('https://api.github.com/repos/mozilla/geckodriver/releases/latest');
    const asset = gecko.assets.find(asset => /win64\.zip$/.test(asset.name));
    const directory = await archive(`geckodriver-solo-${gecko.tag_name}`, asset.browser_download_url, asset.digest);
    const result = { geckodriver: path.join(directory, 'geckodriver.exe'), versions: { geckodriver: gecko.tag_name } };
    fs.writeFileSync(path.join(base, 'driver.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } else {
  const chrome = (await json('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json')).channels.Stable;
  const brave = await json('https://api.github.com/repos/brave/brave-browser/releases/latest');
  const gecko = await json('https://api.github.com/repos/mozilla/geckodriver/releases/latest');
  const braveAsset = brave.assets.find(asset => /win32-x64\.zip$/.test(asset.name));
  const geckoAsset = gecko.assets.find(asset => /win64\.zip$/.test(asset.name));
  if (!braveAsset || !geckoAsset) throw new Error('Official portable archive not found.');
  const chromeDir = await archive(`chrome-${chrome.version}`, chrome.downloads.chrome.find(d => d.platform === 'win64').url);
  const braveDir = await archive(`brave-${brave.tag_name}`, braveAsset.browser_download_url, braveAsset.digest);
  const geckoDir = await archive(`geckodriver-${gecko.tag_name}`, geckoAsset.browser_download_url, geckoAsset.digest);
  const result = { chrome: path.join(chromeDir, 'chrome-win64/chrome.exe'), brave: path.join(braveDir, 'brave.exe'), geckodriver: path.join(geckoDir, 'geckodriver.exe'), versions: { chrome: chrome.version, brave: brave.tag_name, geckodriver: gecko.tag_name } };
  for (const name of ['chrome', 'brave']) {
    if (!fs.existsSync(result[name])) throw new Error(`${name} executable missing.`);
    if (name === 'chrome') {
      // Chrome for Testing builds are not Authenticode-signed by design; trust is the official HTTPS origin plus the recorded SHA-256.
      const marker = JSON.parse(fs.readFileSync(path.join(chromeDir, '.download-complete'), 'utf8'));
      if (!marker.url.startsWith('https://storage.googleapis.com/chrome-for-testing-public/') || !/^[0-9a-f]{64}$/.test(marker.sha256)) throw new Error('chrome: official download origin could not be verified.');
      continue;
    }
    const signature = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${result[name].replaceAll("'", "''")}'; if ($s.Status -ne 'Valid') { throw $s.Status }; $s.SignerCertificate.Subject`], { windowsHide: true, encoding: 'utf8' });
    if (signature.status !== 0 || !/Google|Brave/i.test(signature.stdout)) throw new Error(`${name}: executable publisher could not be verified.`);
  }
  fs.writeFileSync(path.join(base, 'browsers.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
