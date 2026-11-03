import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function chromiumExtensionId(key) {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}
export function nativeRegistryKeys(host) {
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(host)) throw new Error('Geçersiz Native host adı.');
  return ['Mozilla', 'Google\\Chrome', 'Google\\ChromeForTesting', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'].map(browser => ({ key: `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${host}`, family: browser === 'Mozilla' ? 'firefox' : 'chromium' }));
}
function reg(args) {
  const result = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  if (result.error) throw result.error; return result;
}
export function installNative({ directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Hypernab', 'NativeMessaging'), host = 'com.hypernab.app', port = 17846,
  dataDirectory = path.join(root, 'data'), downloadDirectory = path.join(root, 'downloads'), register = true, rootDirectory = root, nodePath = process.execPath, desktopExecutable } = {}) {
  if (process.platform !== 'win32') throw new Error('Bu geliştirme kurucusu Windows içindir.');
  const keys = nativeRegistryKeys(host);
  directory = path.resolve(directory); dataDirectory = path.resolve(dataDirectory); downloadDirectory = path.resolve(downloadDirectory);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Geçersiz uygulama portu.');
  const marker = path.join(directory, '.hypernab-native');
  if (fs.existsSync(directory) && !fs.existsSync(marker)) throw new Error('Kurulum klasörü Hypernab tarafından oluşturulmamış; üzerine yazılmadı.');
  const keys_ = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'extension/chromium-key.json'), 'utf8'));
  const chromiumIds = [...new Set([keys_.key, ...(keys_.previousKeys || [])].map(chromiumExtensionId))]; // the store id first, earlier ids stay allowed
  const firefoxId = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'extension/manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
  const manifests = { firefox: path.join(directory, 'firefox.json'), chromium: path.join(directory, 'chromium.json') };
  // Refuse to overwrite a registration belonging to another installation.
  if (register) for (const item of keys) for (const view of ['32', '64']) {
    const existing = reg(['query', item.key, '/ve', `/reg:${view}`]);
    if (existing.status === 0 && !existing.stdout.toLowerCase().includes(manifests[item.family].toLowerCase())) throw new Error(`Farklı Native host kaydı var; değiştirilmedi: ${item.key}`);
  }
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(marker, 'Hypernab native messaging development installation\n');
  // Browser-held native executables cannot be overwritten. A new launcher version gets a new owned filename.
  const launcherSource = path.join(rootDirectory, 'src/windows-native-launcher.cs');
  const launcherHash = createHash('sha256').update(fs.readFileSync(launcherSource)).digest('hex').slice(0, 12);
  const exe = path.join(directory, `HypernabNative-${launcherHash}.exe`), configFile = path.join(directory, 'host-config.json');
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Windows .NET Framework C# derleyicisi bulunamadı.');
  if (!fs.existsSync(exe)) {
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`, '/reference:System.Web.Extensions.dll', launcherSource], { windowsHide: true, encoding: 'utf8' });
    if (compiled.status !== 0) throw new Error(`Native başlatıcı derlenemedi: ${compiled.stdout || compiled.stderr}`);
  }
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, host, port, dataDirectory, downloadDirectory, launcher: exe, firefoxManifest: manifests.firefox, firefoxIds: [firefoxId], chromiumIds }, null, 2));
  fs.writeFileSync(path.join(directory, 'launcher.json'), JSON.stringify({ node: nodePath, host: path.join(rootDirectory, 'src/native-host.js'), server: path.join(rootDirectory, 'src/server.js'), config: configFile, desktop: desktopExecutable }, null, 2));
  const base = { name: host, description: 'Hypernab local download manager', path: exe, type: 'stdio' };
  fs.writeFileSync(manifests.firefox, JSON.stringify({ ...base, allowed_extensions: [firefoxId] }, null, 2));
  fs.writeFileSync(manifests.chromium, JSON.stringify({ ...base, allowed_origins: chromiumIds.map(id => `chrome-extension://${id}/`) }, null, 2));
  if (register) for (const item of keys) for (const view of ['32', '64']) {
    const result = reg(['add', item.key, '/ve', '/t', 'REG_SZ', '/d', manifests[item.family], '/f', `/reg:${view}`]);
    if (result.status !== 0) throw new Error(`Kullanıcı Native kaydı yazılamadı: ${item.key}`);
  }
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ host, keys, manifests, registered: register, chromiumId: chromiumIds[0], chromiumIds, firefoxId, launcher: path.basename(exe) }, null, 2));
  return { host, directory, exe, configFile, chromiumId: chromiumIds[0], chromiumIds, firefoxId, registered: register };
}
export function uninstallNative(directory, { removeFiles = false } = {}) {
  const installation = JSON.parse(fs.readFileSync(path.join(directory, 'installation.json'), 'utf8'));
  if (!fs.existsSync(path.join(directory, '.hypernab-native'))) throw new Error('Hypernab kurulum işareti yok.');
  if (installation.registered) for (const item of nativeRegistryKeys(installation.host)) for (const view of ['32', '64']) {
    const current = reg(['query', item.key, '/ve', `/reg:${view}`]);
    if (current.status === 0 && current.stdout.toLowerCase().includes(installation.manifests[item.family].toLowerCase())) reg(['delete', item.key, '/f', `/reg:${view}`]); // whole key: an empty one would be left behind otherwise
  }
  if (removeFiles) {
    const launchers = fs.readdirSync(directory).filter(file => /^HypernabNative(?:-[a-f0-9]{12})?\.exe$/.test(file));
    for (const file of [...launchers, 'host-config.json', 'launcher.json', 'firefox.json', 'chromium.json', 'installation.json', '.hypernab-native']) fs.rmSync(path.join(directory, file), { force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--uninstall') uninstallNative(process.argv[3] || path.join(process.env.LOCALAPPDATA, 'Hypernab/NativeMessaging'));
    else console.log(JSON.stringify(installNative(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
