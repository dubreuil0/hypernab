import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DownloadQueue } from '../src/downloads.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { linksIn, offerFor } = createRequire(import.meta.url)('../desktop/clipboard-links.cjs');

test('links are found in any text: trailing punctuation is dropped, only http/https, no credentials, no repeats', () => {
  assert.deepEqual(linksIn('see https://example.org/a.zip, and (https://example.org/b?x=1). also https://example.org/a.zip'), ['https://example.org/a.zip', 'https://example.org/b?x=1']);
  assert.deepEqual(linksIn('ftp://example.org/x file:///C:/x javascript:alert(1) https://user:pass@example.org/x'), [], 'only plain http/https');
  assert.deepEqual(linksIn('no link here'), []); assert.deepEqual(linksIn(null), []); assert.deepEqual(linksIn(''), []);
  assert.equal(linksIn(Array.from({ length: 150 }, (_, i) => `https://example.org/${i}`).join(' ')).length, 100, 'at most 100');
  assert.equal(linksIn(`https://example.org/${'a'.repeat(3000)}`).length, 0, 'an absurdly long address is not offered');
});

test('the same clipboard text is offered only once; nothing is offered when there is no link', () => {
  const text = 'https://example.org/video';
  assert.deepEqual(offerFor(text, ''), [text]);
  assert.equal(offerFor(text, text), null, 'already offered');
  assert.deepEqual(offerFor('https://example.org/other', text), ['https://example.org/other']);
  assert.equal(offerFor('just words', ''), null); assert.equal(offerFor('', 'x'), null);
});

test('the clipboard offer is a setting that is off by default and must be a switch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-clip-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'd'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(queue.settings.watchClipboard, false);
  queue.setSettings({ watchClipboard: true }); assert.equal(queue.settings.watchClipboard, true);
  assert.throws(() => queue.setSettings({ watchClipboard: 'yes' }));
});
