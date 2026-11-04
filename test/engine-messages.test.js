import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { DownloadQueue } from '../src/downloads.js';
import { m, setMessageLanguage } from '../src/messages.js';

const strings = {}; vm.runInContext(fs.readFileSync(new URL('../public/strings.js', import.meta.url), 'utf8'), vm.createContext({ globalThis: strings }));
const { TEXTS } = strings.HypernabText;
const srcDir = new URL('../src/', import.meta.url);

test('every message key used by the engine exists in both languages, and no Turkish text is left in a message', () => {
  const used = new Set(); const leftovers = [];
  for (const name of fs.readdirSync(srcDir).filter(file => file.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(name, srcDir), 'utf8');
    for (const match of text.matchAll(/\bm\('([^']+)'/g)) used.add(match[1]);
    // a Turkish sentence in an Error or a note must come from m(); data tables (language names) are not messages
    if (!['subtitles.js', 'language-detect.js', 'messages.js', 'native-host.js'].includes(name)) for (const match of text.matchAll(/(?:new \w*Error|throw|note:|message:)\(?\s*['`"]([^'`"\n]*[ğüşıöçĞÜŞİÖÇ][^'`"\n]*)['`"]/g)) leftovers.push(`${name}: ${match[1].slice(0, 60)}`);
  }
  assert.ok(used.size > 200, `only ${used.size} keys`);
  for (const key of used) { assert.ok(TEXTS.en[key], `en: ${key}`); assert.ok(TEXTS.tr[key], `tr: ${key}`); }
  assert.deepEqual(leftovers, []);
});

test('the engine speaks the interface language and follows a change at once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-msg-'));
  try {
    const queue = new DownloadQueue({ locale: 'ja-JP', directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
    const fail = () => { try { queue.setSettings({ maxConnections: 99 }); } catch (error) { return error.message; } return null; };
    assert.equal(fail(), 'The number of connections must be between 1 and 16.', 'German Windows: English');
    queue.setSettings({ interfaceLanguage: 'tr' });
    assert.equal(fail(), 'Bağlantı sayısı 1 ile 16 arasında olmalı.');
    queue.setSettings({ interfaceLanguage: 'auto' });
    assert.equal(fail(), 'The number of connections must be between 1 and 16.');
    // a constructed second queue starts in its own language
    new DownloadQueue({ locale: 'tr-TR', directory: path.join(root, 'd2'), stateFile: path.join(root, 'q2.json'), toolsDirectory: root });
    assert.equal(m('e.the-server-sent-too-much-part'), 'Sunucu fazla parça verisi gönderdi.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); setMessageLanguage('tr'); }
});

test('variables are filled in, and a missing key shows its name instead of nothing', () => {
  setMessageLanguage('en');
  assert.equal(m('e.http-code-the-hls-source-address', { code: 403 }), 'HTTP 403: the HLS source address/access must be refreshed.');
  assert.equal(m('e.must-be-on-or-off', { name: m('e.name.tray') }), 'Minimize to the tray must be on or off.');
  assert.equal(m('e.not.a.key'), 'e.not.a.key');
  setMessageLanguage('tr');
  assert.equal(m('e.must-be-on-or-off', { name: m('e.name.tray') }), 'Tepsiye küçültme açık veya kapalı olmalı.');
});
