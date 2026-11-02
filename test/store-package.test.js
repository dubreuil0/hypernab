import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packageExtensions } from '../scripts/package-extensions.js';
import { buildExtensions } from '../scripts/build-extensions.js';

test('store packages: no development key for Chrome, a neutral permanent id and a "no data collected" declaration for Firefox', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-store-'));
  try {
    const result = packageExtensions({ outDir: path.join(base, 'out'), work: path.join(base, 'work') });
    assert.ok(Object.values(result.sizes).every(size => size > 10000), 'both packages have content');
    const chrome = JSON.parse(fs.readFileSync(path.join(base, 'work/chromium/manifest.json'), 'utf8'));
    const firefox = JSON.parse(fs.readFileSync(path.join(base, 'work/firefox/manifest.json'), 'utf8'));
    assert.equal(chrome.key, undefined, 'the store gives the item its own key');
    assert.equal(chrome.browser_specific_settings, undefined);
    assert.match(firefox.browser_specific_settings.gecko.id, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/, 'an id with no name or address in it');
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
    assert.equal(chrome.version, firefox.version);
    // the sensitive permissions of the old automatic file capture are gone for good (they make store review harder and nothing needs them)
    for (const manifest of [chrome, firefox]) for (const gone of ['downloads', 'downloads.ui', 'webRequestBlocking']) assert.equal(manifest.permissions.includes(gone), false, `${gone} is not asked`);
    for (const family of ['chromium', 'firefox']) {
      assert.ok(fs.existsSync(path.join(base, 'work', family, 'link-download.js')), 'the link menu ships');
      for (const old of ['takeover.js', 'download-prompt.html']) assert.equal(fs.existsSync(path.join(base, 'work', family, old)), false, `${old} is not shipped`);
    }
    // the development build still carries the key, so unpacked copies keep their id
    buildExtensions(path.join(base, 'dev'));
    assert.match(JSON.parse(fs.readFileSync(path.join(base, 'dev/chromium/manifest.json'), 'utf8')).key, /^[A-Za-z0-9+/=]{100,}$/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
