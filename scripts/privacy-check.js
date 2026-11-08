// Gizlilik denetimi: yayına (depo, kurulum paketi, sürüm notu) kişisel bilgi veya özel site adı girmesini engeller.
// Özel terimler (ad, site adları) .privacy-terms dosyasındadır; o dosya depoya girmez, bu betik terim içermez.
// Kullanım: node scripts/privacy-check.js [--repo] [--package] [--history] [--text "metin"] [--install-hook]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const skipExtensions = new Set(['.exe', '.dll', '.node', '.png', '.ico', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.zip', '.blockmap', '.sqlite', '.pak', '.bin', '.dat', '.asar']);
const emailAllowed = /(?:users\.noreply\.github\.com|example\.(?:com|org|net)|local\.invalid|localhost)$/i;
const generic = [
  ['windows-yolu', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|All Users\b|<|%|\$|\{)[^\\/\s'"`]+/i],
  ['e-posta', /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ['gizli-anahtar', /(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/]
];

function rules() {
  const list = [...generic];
  const user = os.userInfo().username;
  if (user && user.length > 2) list.push(['bilgisayar-kullanici-adi', new RegExp(`(?<![A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')]);
  const file = path.join(root, '.privacy-terms');
  if (!fs.existsSync(file)) throw new Error('.privacy-terms bulunamadı; denetim özel terimler olmadan güvenilir değil. Yayın durduruldu.');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    list.push(['özel-terim', new RegExp(line.trim(), 'i')]);
  }
  return list;
}

function scanText(label, text, ruleList, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [name, pattern] of ruleList) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (name === 'e-posta' && (emailAllowed.test(match[0]) || label.endsWith('package-lock.json'))) continue;
      findings.push(`${label}:${index + 1} [${name}]`);
    }
  });
}

function scanFile(file, label, ruleList, findings) {
  scanText(`${label} (dosya adı)`, label, ruleList, findings);
  if (skipExtensions.has(path.extname(file).toLowerCase())) return;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 3 * 1048576) return;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) return;
  scanText(label, buffer.toString('utf8'), ruleList, findings);
}

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, visit); else visit(full);
  }
}

export function check({ repo = false, pkg = false, history = false, text = [] } = {}) {
  const ruleList = rules(), findings = [];
  if (repo) {
    const names = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    for (const name of names) if (fs.existsSync(path.join(root, name))) scanFile(path.join(root, name), `depo/${name}`, ruleList, findings);
    // Pictures, video, sound, archives and documents never belong in the repository (a screenshot or a photo could show a person or a
    // screen; test downloads are junk). Only the app's own icons are allowed. Text scanning cannot judge a picture, so none gets in.
    const allowed = /^(?:desktop\/icon(?:-32)?\.(?:png|ico|svg)|extension\/icons\/icon(?:-off)?-\d+\.png|public\/icon\.svg)$/;
    const media = /\.(?:png|jpe?g|gif|webp|bmp|ico|heic|tiff?|svg|avif|mp4|m4s|m4a|m4v|ts|mkv|webm|mov|avi|flv|mp3|wav|ogg|opus|flac|aac|zip|7z|rar|tar|gz|exe|dll|msi|pdf|docx?|xlsx?|pptx?|har|crx|xpi|psd)$/i;
    for (const name of names) if (media.test(name) && !allowed.test(name)) findings.push(`depo/${name} [izin verilmeyen görsel/medya/arşiv dosyası]`);
  }
  if (pkg) {
    const resources = path.join(root, 'dist/win-unpacked/resources');
    if (!fs.existsSync(path.join(resources, 'app.asar'))) throw new Error('Paket bulunamadı; önce npm run dist.');
    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-privacy-'));
    try {
      execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@electron/asar', 'extract', path.join(resources, 'app.asar'), unpacked], { stdio: 'ignore', shell: process.platform === 'win32' });
      for (const [base, label] of [[unpacked, 'paket/asar'], [path.join(resources, 'engine'), 'paket/engine'], [path.join(resources, 'app-update.yml'), 'paket/app-update.yml']]) {
        if (!fs.existsSync(base)) continue;
        if (fs.statSync(base).isFile()) scanFile(base, label, ruleList, findings);
        else walk(base, file => { if (!file.includes(`${path.sep}node_modules${path.sep}`)) scanFile(file, `${label}/${path.relative(base, file).replaceAll('\\', '/')}`, ruleList, findings); });
      }
    } finally { fs.rmSync(unpacked, { recursive: true, force: true }); }
    const yml = path.join(root, 'dist/latest.yml');
    if (fs.existsSync(yml)) scanFile(yml, 'paket/latest.yml', ruleList, findings);
  }
  if (history) {
    const log = execFileSync('git', ['log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B'], { cwd: root, encoding: 'utf8' });
    scanText('commit-geçmişi', log, ruleList, findings);
    const patch = execFileSync('git', ['log', '--all', '-p', '--format=', '--', '.', ':(exclude)package-lock.json'], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1048576 });
    scanText('commit-değişiklikleri', patch, ruleList, findings);
  }
  text.forEach((value, index) => scanText(`metin#${index + 1}`, value, ruleList, findings));
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--install-hook')) {
    const hook = path.join(root, '.git/hooks/pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\nnode scripts/privacy-check.js --repo --history || { echo "Gizlilik denetimi başarısız: push durduruldu."; exit 1; }\n');
    console.log('pre-push kancası kuruldu.'); process.exit(0);
  }
  const text = args.flatMap((arg, i) => arg === '--text' ? [args[i + 1] || ''] : []);
  const options = { repo: args.includes('--repo'), pkg: args.includes('--package'), history: args.includes('--history'), text };
  if (!options.repo && !options.pkg && !options.history && !text.length) Object.assign(options, { repo: true });
  try {
    const findings = check(options);
    if (findings.length) {
      console.error(`GİZLİLİK DENETİMİ BAŞARISIZ: ${findings.length} bulgu (eşleşen metin bilerek yazılmaz).`);
      for (const finding of findings.slice(0, 200)) console.error(`  ${finding}`);
      process.exit(1);
    }
    console.log('Gizlilik denetimi temiz.');
  } catch (error) { console.error(error.message); process.exit(2); }
}
