// General (non-video) file downloads: real file names, categories, risk hints, structural checks and the Windows
// "downloaded from the internet" mark. Decisions come from the file name / bytes / headers only, never from a site name.
import fs from 'node:fs';
import path from 'node:path';
import { cleanName } from './file-layout.js';
import { VerificationError } from './verification.js';

// Right-to-left overrides and other invisible controls are used to disguise "gpj.exe" as "exe.jpg".
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;
const MIME_EXTENSIONS = {
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/pdf': 'pdf', 'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-tar': 'tar',
  'application/x-msdownload': 'exe', 'application/vnd.microsoft.portable-executable': 'exe', 'application/x-msi': 'msi', 'application/x-iso9660-image': 'iso',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'text/plain': 'txt', 'text/csv': 'csv',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'video/webm': 'webm'
};
const PROGRAM = new Set(['exe', 'msi', 'msix', 'appx', 'msp', 'scr', 'com', 'pif', 'dll', 'cpl', 'sys', 'jar', 'apk']);
const SCRIPT = new Set(['bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'reg', 'msc', 'url', 'docm', 'xlsm', 'pptm']);
const GROUPS = [
  ['video', 'Video', ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'ts', '3gp', 'mpg', 'mpeg', 'ogv']],
  ['audio', 'Ses', ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'wma', 'weba']],
  ['image', 'Resim', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'avif']],
  ['document', 'Belge', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'odt', 'ods', 'odp', 'epub', 'md']],
  ['archive', 'Arşiv', ['zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'zst', 'cab']],
  ['program', 'Program', [...PROGRAM, ...SCRIPT]],
  ['disk', 'Disk görüntüsü', ['iso', 'img', 'vhd', 'vhdx', 'dmg']]
];
const CATEGORY_BY_EXTENSION = new Map(GROUPS.flatMap(([id, label, list]) => list.map(ext => [ext, { id, label }])));

export const extensionOf = name => path.extname(String(name || '')).slice(1).toLowerCase();

// RFC 6266 / 5987: filename*=UTF-8''%C3%A7... wins over filename="...".
export function parseDisposition(header) {
  const text = String(header || '');
  if (!text) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(text);
  if (star) {
    const match = /^\s*([A-Za-z0-9-]+)'[^']*'(.*)$/.exec(star[1].trim().replace(/^"|"$/g, ''));
    if (match) { try { const buffer = Buffer.from(decodeURIComponent(match[2].replace(/%(?![0-9a-f]{2})/gi, '%25')).normalize(), 'utf8'); return buffer.toString(/^iso-8859-1$/i.test(match[1]) ? 'latin1' : 'utf8'); } catch { /* fall through to the plain name */ } }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(text);
  if (!plain) return null;
  let value = plain[2] !== undefined ? plain[2].replace(/\\(["\\])/g, '$1') : plain[1].trim();
  // Node decodes header bytes as Latin-1; servers that send raw UTF-8 show up as mojibake.
  if (/[\u0080-ÿ]/.test(value) && !/[^\u0000-ÿ]/.test(value)) {
    const utf8 = Buffer.from(value, 'latin1').toString('utf8');
    if (!utf8.includes('�')) value = utf8;
  }
  return value;
}

function decoded(value) { try { return decodeURIComponent(value); } catch { return value; } }

// The name the finished file gets. The browser's own choice (what the user saw) leads, then the server's, then the address.
export function fileNameFor({ hint = '', disposition = '', url = '', contentType = '' } = {}) {
  let raw = '';
  for (const candidate of [hint, parseDisposition(disposition), (() => { try { return decoded(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; } })()]) {
    const base = String(candidate || '').replace(INVISIBLE, '').split(/[\\/]/).pop().trim();
    if (base && !/^\.+$/.test(base)) { raw = base; break; }
  }
  let ext = extensionOf(raw);
  if (!/^[a-z0-9]{1,10}$/.test(ext)) ext = '';
  let stem = ext ? raw.slice(0, -(ext.length + 1)) : raw;
  if (!ext) ext = MIME_EXTENSIONS[String(contentType).split(';')[0].trim().toLowerCase()] || (raw ? '' : 'bin');
  stem = cleanName(stem, 'dosya').slice(0, 120).replace(/[. ]+$/g, '') || 'dosya';
  return ext ? `${stem}.${ext}` : stem;
}

export function categoryFor(name, contentType = '') {
  const ext = extensionOf(name);
  if (CATEGORY_BY_EXTENSION.has(ext)) return CATEGORY_BY_EXTENSION.get(ext);
  const major = String(contentType).split('/')[0].toLowerCase();
  if (major === 'video') return { id: 'video', label: 'Video' };
  if (major === 'audio') return { id: 'audio', label: 'Ses' };
  if (major === 'image') return { id: 'image', label: 'Resim' };
  return { id: 'other', label: 'Diğer' };
}

// 'program' runs code, 'script' can run code or macros. Only a hint for the user; nothing is blocked.
export function riskOf(name) {
  const ext = extensionOf(name);
  return PROGRAM.has(ext) ? 'program' : SCRIPT.has(ext) ? 'script' : null;
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, position));
  return buffer.subarray(0, bytesRead);
}

const ZIP_FAMILY = new Set(['zip', 'jar', 'apk', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'xpi', 'epub', 'nupkg', 'vsix', 'msix', 'appx', 'docm', 'xlsm', 'pptm']);
const OLE_FAMILY = new Set(['doc', 'xls', 'ppt', 'msi', 'msp']);
const TEXT_LIKE = new Set(['html', 'htm', 'xhtml', 'txt', 'xml', 'json', 'svg', 'csv', 'md', 'js', 'css', 'url', 'reg', 'bat', 'cmd', 'ps1', 'php', 'asp', 'aspx', 'jsp', 'rtf', 'log', 'ini', 'cfg', 'yaml', 'yml', 'm3u', 'm3u8', 'srt', 'vtt', 'ass']);
const startsWith = (buffer, bytes) => bytes.every((value, index) => buffer[index] === value);

// Cheap structural check (reads the first and last bytes only). Throws VerificationError when the bytes clearly are not what the
// name says, e.g. a login page saved as ".zip". Unknown formats pass with 'limited' (size was still compared when it was known).
export async function verifyFileFormat(file, name, { sizeCompared = false } = {}) {
  const ext = extensionOf(name);
  const handle = await fs.promises.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size === 0) throw new VerificationError('İndirilen dosya boş.');
    const head = await readAt(handle, 0, Math.min(size, 1024));
    if (!TEXT_LIKE.has(ext) && /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(head.subarray(0, 512).toString('latin1'))) {
      throw new VerificationError('Sunucu dosya yerine bir web sayfası gönderdi (giriş veya hata sayfası olabilir). Dosya tamamlandı sayılmadı.');
    }
    const pass = format => ({ status: 'passed', format });
    if (ZIP_FAMILY.has(ext)) {
      if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04]) && !startsWith(head, [0x50, 0x4b, 0x05, 0x06]) && !startsWith(head, [0x4d, 0x5a])) throw new VerificationError('Dosya ZIP yapısında değil; bozuk veya eksik olabilir.');
      const tailLength = Math.min(size, 65557), tail = await readAt(handle, size - tailLength, tailLength);
      const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (at < 0 || at + 22 > tail.length) throw new VerificationError('ZIP dosyasının sonu eksik; indirme tamamlanmamış veya bozuk.');
      const centralSize = tail.readUInt32LE(at + 12), centralOffset = tail.readUInt32LE(at + 16), zip64 = centralOffset === 0xffffffff || centralSize === 0xffffffff;
      if (!zip64 && centralOffset + centralSize > size - tailLength + at) throw new VerificationError('ZIP içindeki dosya listesi dosya sınırlarının dışında; arşiv bozuk.');
      return pass('zip');
    }
    if (ext === 'pdf') {
      if (!head.toString('latin1').includes('%PDF-')) throw new VerificationError('Dosya PDF başlığı taşımıyor.');
      const tail = (await readAt(handle, size - Math.min(size, 2048), Math.min(size, 2048))).toString('latin1');
      if (!tail.includes('%%EOF')) {
        if (!sizeCompared) throw new VerificationError('PDF dosyasının sonu eksik; indirme tamamlanmamış olabilir.');
        return { status: 'passed', format: 'pdf', note: 'PDF sonu işareti bulunamadı ama boyut sunucudakiyle eşleşti.' };
      }
      return pass('pdf');
    }
    if (ext === 'png') {
      if (!startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new VerificationError('Dosya PNG imzası taşımıyor.');
      if (!(await readAt(handle, size - Math.min(size, 16), 16)).includes(Buffer.from('IEND'))) throw new VerificationError('PNG dosyasının sonu eksik.');
      return pass('png');
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      if (!startsWith(head, [0xff, 0xd8, 0xff])) throw new VerificationError('Dosya JPEG imzası taşımıyor.');
      const tail = await readAt(handle, size - Math.min(size, 64), 64);
      if (tail.lastIndexOf(Buffer.from([0xff, 0xd9])) < 0) throw new VerificationError('JPEG dosyasının sonu eksik.');
      return pass('jpeg');
    }
    if (ext === 'gif') { if (!startsWith(head, [0x47, 0x49, 0x46, 0x38])) throw new VerificationError('Dosya GIF imzası taşımıyor.'); return pass('gif'); }
    if (ext === 'webp') { if (head.subarray(0, 4).toString('latin1') !== 'RIFF' || head.subarray(8, 12).toString('latin1') !== 'WEBP') throw new VerificationError('Dosya WebP imzası taşımıyor.'); return pass('webp'); }
    if (['exe', 'dll', 'sys', 'scr', 'cpl'].includes(ext)) {
      if (!startsWith(head, [0x4d, 0x5a])) throw new VerificationError('Dosya Windows programı yapısında değil.');
      const peOffset = head.length >= 0x40 ? head.readUInt32LE(0x3c) : 0;
      if (!peOffset || peOffset + 4 > size) throw new VerificationError('Windows programının başlığı eksik; indirme bozuk olabilir.');
      if ((await readAt(handle, peOffset, 4)).toString('latin1') !== 'PE\u0000\u0000') throw new VerificationError('Windows programının başlığı geçersiz.');
      return pass('pe');
    }
    if (OLE_FAMILY.has(ext)) { if (!startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) throw new VerificationError('Dosya beklenen Microsoft biçiminde değil.'); return pass('ole'); }
    if (ext === '7z') { if (!startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) throw new VerificationError('Dosya 7z imzası taşımıyor.'); return pass('7z'); }
    if (ext === 'rar') { if (head.subarray(0, 4).toString('latin1') !== 'Rar!') throw new VerificationError('Dosya RAR imzası taşımıyor.'); return pass('rar'); }
    if (ext === 'gz' || ext === 'tgz') { if (!startsWith(head, [0x1f, 0x8b])) throw new VerificationError('Dosya gzip imzası taşımıyor.'); return pass('gzip'); }
    if (ext === 'xz') { if (!startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) throw new VerificationError('Dosya xz imzası taşımıyor.'); return pass('xz'); }
    if (ext === 'bz2') { if (head.subarray(0, 3).toString('latin1') !== 'BZh') throw new VerificationError('Dosya bzip2 imzası taşımıyor.'); return pass('bzip2'); }
    return { status: 'limited', format: null };
  } finally { await handle.close(); }
}

// Windows' own "this file came from the internet" mark (an NTFS stream, like browsers write). Without it SmartScreen and
// Defender treat the file as local. Only the zone is written, never the address. FAT/exFAT and other systems simply skip it.
export function markFromInternet(file) {
  try { fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n'); return true; } catch { return false; }
}
