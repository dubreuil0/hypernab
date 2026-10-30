import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const session = {}; let headersReceived;
  const browser = { webRequest: { onHeadersReceived: { addListener: fn => { headersReceived = fn; } } },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, sendMessage: async () => {} },
    runtime: { id: 'test', onMessage: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    storage: { session: { get: async keys => Object.fromEntries([].concat(keys).map(key => [key, session[key]])), set: async values => Object.assign(session, values) } } };
  const context = vm.createContext({ browser, URL, Date, Math, Promise, setTimeout: () => 0, clearTimeout() {} });
  for (const name of ['core.js', 'background.js']) vm.runInContext(fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8'), context);
  const capture = async (extra = {}) => {
    headersReceived({ url: 'https://example.org/opaque', tabId: 7, frameId: 0, type: 'xmlhttprequest', statusCode: 200, responseHeaders: [], ...extra });
    await vm.runInContext('writes', context);
  };
  return { session, capture };
}
const header = (name, value) => ({ name, value });

test('202/204, explicit empty and tiny text responses never occupy unknown media slots; no hostname filters', async () => {
  const f = fixture();
  for (const [index, statusCode, responseHeaders] of [
    [0, 202, []], [1, 204, []], [2, 200, [header('content-length', '0')]],
    [3, 200, [header('content-type', 'text/plain'), header('content-length', '3')]],
    [4, 200, [header('content-type', 'application/json'), header('content-length', '100')]]
  ]) await f.capture({ url: `https://any.example.org/opaque-${index}`, statusCode, responseHeaders });
  assert.equal((f.session['tab:7'] || []).length, 0);
});

test('unknown-length and plausible plain/binary manifests remain candidates', async () => {
  const f = fixture();
  await f.capture({ url: 'https://cdn.example.org/unknown-length', responseHeaders: [header('content-type', 'text/plain')] });
  await f.capture({ url: 'https://cdn.example.org/plain-list', responseHeaders: [header('content-type', 'text/plain'), header('content-length', '1000')] });
  assert.equal(f.session['tab:7'].length, 2); assert.ok(f.session['tab:7'].every(e => e.kind === 'UNKNOWN'));
});

test('normal byte-range 206 MP4 remains a full-resource candidate; signed URL and total are preserved', async () => {
  const f = fixture(), url = 'https://cdn.example.org/?signed=unchanged';
  await f.capture({ url, type: 'media', statusCode: 206, responseHeaders: [header('content-type', 'video/mp4'), header('content-range', 'bytes 0-999/203832171'), header('content-length', '1000')] });
  const [entry] = f.session['tab:7'];
  assert.equal(entry.kind, 'VIDEO'); assert.equal(entry.url, url); assert.equal(entry.partial, true);
  assert.equal(entry.rangeLimited, false); assert.equal(entry.size, 203832171);
});

test('explicit HLS endpoint is not discarded merely because it is temporarily returning 202', async () => {
  const f = fixture();
  await f.capture({ url: 'https://cdn.example.org/master.m3u8', statusCode: 202 });
  assert.equal(f.session['tab:7'][0].kind, 'HLS');
});
