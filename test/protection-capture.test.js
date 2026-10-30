import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionHarness, mediaInfo, shuffled } from '../scripts/test-support/extension-harness.js';

const mediaRequests = app => app.requests.filter(r => ['/api/inspect', '/api/sniff'].includes(r.route));
const noise = Array.from({ length: 12 }, (_, i) => ({ kind: 'UNKNOWN', url: `https://noise${i % 3}.example.org/event?n=${i}`, size: i % 3 === 0 ? 3 : null, frameId: i % 2 }));

for (const [kind, ext, mime] of [
  ['VIDEO', 'mp4', 'video/mp4'], ['VIDEO', 'webm', 'video/webm'], ['VIDEO', 'mov', 'video/quicktime'],
  ['VIDEO', 'mkv', 'video/x-matroska'], ['OTHER', 'avi', 'video/x-msvideo'], ['OTHER', 'flv', 'video/x-flv']
]) for (const frameId of [0, 2]) test(`protection: ${ext} frame ${frameId}, 24 seeded request orderings never hide the playing file`, async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const url = `https://media.example.org/${seed % 2 ? '' : 'movie.' + ext}?rendition=720&signature=KEEP-${seed}`;
    const video = { kind, url, mime, size: 203832171, partial: true, rangeLimited: false, playerBlob: false, frameId };
    const unrelated = Array.from({ length: 4 }, (_, i) => ({ kind: 'HLS', frameId: 4, url: `https://stream${i}.example.org/master.m3u8` }));
    const app = extensionHarness({ entries: shuffled([...noise, ...unrelated, video], seed), frames: { [frameId]: { mediaUrl: url, height: 720, duration: 100 } }, inspect: body => {
      assert.equal(body.url, url, `seed ${seed}`); assert.equal(body.engine, 'direct'); return mediaInfo;
    } });
    const answer = await app.inspect();
    assert.equal(answer.ok, true, `seed ${seed}: ${answer.error}`);
    assert.equal(mediaRequests(app).length, 1); assert.equal(mediaRequests(app)[0].body.url, url);
    assert.equal(app.cookieCalls.length, 0);
  }
});

test('protection: same host/path but different signature or quality is not the player URL', async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const wanted = 'https://media.example.org/?quality=720&sig=EXACT';
    const entries = [1080, 480, 360].map(height => ({ kind: 'VIDEO', url: `https://media.example.org/?quality=${height}&sig=OTHER`, mime: 'video/mp4', frameId: 0 }));
    entries.push({ kind: 'VIDEO', url: wanted, mime: 'video/mp4', frameId: 0 });
    const app = extensionHarness({ entries: shuffled([...noise, ...entries], seed), frames: { 0: { mediaUrl: wanted, height: 720 } }, inspect: body => {
      assert.equal(body.url, wanted); return mediaInfo;
    } });
    assert.equal((await app.inspect()).ok, true); assert.equal(mediaRequests(app).length, 1);
  }
});

test('protection: multiple players select an actually playing resource, not telemetry, without inventing qualities', async () => {
  const urls = ['https://one.example.org/a.mp4', 'https://two.example.org/b.webm'];
  for (let seed = 1; seed <= 24; seed++) {
    const entries = urls.map((url, frameId) => ({ kind: 'VIDEO', url, frameId, mime: frameId ? 'video/webm' : 'video/mp4' }));
    const app = extensionHarness({ entries: shuffled([...noise, ...entries], seed), frames: Object.fromEntries(urls.map((url, id) => [id, { mediaUrl: url, height: 720 }])), inspect: body => {
      assert.ok(urls.includes(body.url)); return mediaInfo;
    } });
    const answer = await app.inspect(); assert.equal(answer.ok, true);
    assert.deepEqual(Array.from(answer.options, o => o.id), ['720', '1080']); assert.equal(mediaRequests(app).length, 1);
  }
});

for (const flag of ['rangeLimited', 'playerBlob']) test(`protection: ${flag} video is never blindly treated as a complete direct file`, async () => {
  const url = 'https://media.example.org/opaque.mp4?bytes=100-200';
  const app = extensionHarness({ entries: [...noise, { kind: 'VIDEO', url, mime: 'video/mp4', [flag]: true }], frames: { 0: { mediaUrl: url, height: 720 } }, inspect: body => {
    assert.notEqual(body.engine, 'direct'); return { httpError: 'Kaynak doğrulanamadı.' };
  } });
  assert.equal((await app.inspect()).ok, false);
  assert.equal(app.requests.some(r => r.route === '/api/jobs'), false);
});

test('protection: DRM evidence stops all inspections, downloads and cookie access', async () => {
  const app = extensionHarness({ entries: [...noise, { kind: 'VIDEO', url: 'https://media.example.org/movie.mp4', drmSuspected: true }], inspect: () => { assert.fail('DRM must stop before inspection'); } });
  const answer = await app.inspect(true);
  assert.equal(answer.code, 'drm'); assert.equal(app.requests.length, 0); assert.equal(app.cookieCalls.length, 0);
});

test('protection: cache separates source kinds, engine instances, cookie stores, user action and expiry', async () => {
  const url = 'https://media.example.org/opaque';
  const app = extensionHarness({ entries: [{ kind: 'UNKNOWN', url }], inspect: (body, route) => route === '/api/inspect' && body.url === url ? mediaInfo : { httpError: 'Yanıt bir HLS listesi değil.' } });
  assert.equal((await app.inspect()).ok, false);
  app.session['tab:7'] = [{ kind: 'VIDEO', url, mime: 'video/mp4' }];
  assert.equal((await app.inspect()).ok, true);
  let count = mediaRequests(app).length;
  await app.inspect(); assert.equal(mediaRequests(app).length, count, 'identical source uses cache');
  app.restart(); await app.inspect(); assert.equal(mediaRequests(app).length, ++count);
  app.tab.cookieStoreId = 'store-b'; await app.inspect(); assert.equal(mediaRequests(app).length, ++count);
  app.session[`inspect:${url}`].at -= 16 * 60 * 1000;
  await app.inspect(); assert.equal(mediaRequests(app).length, ++count);
  assert.equal(app.cookieCalls.length, 0);
  await app.inspect(true); assert.equal(mediaRequests(app).length, ++count);
  assert.ok(app.cookieCalls.length > 0 && app.cookieCalls.every(query => query.storeId === 'store-b'));
  assert.doesNotMatch(JSON.stringify([app.session, app.local]), /SYNTHETIC-COOKIE-NEVER-STORE/);
  const report = await app.diagnose();
  assert.equal(report.ok, true); assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC-COOKIE-NEVER-STORE/);
});

test('protection: concurrent identical lookups share one inspection, then later lookups use its cache', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
  const app = extensionHarness({ entries: [{ kind: 'HLS', url: 'https://media.example.org/master.m3u8' }], inspect: async () => { entered(); await gate; return mediaInfo; } });
  const answers = Array.from({ length: 12 }, () => app.inspect());
  await began; assert.equal(mediaRequests(app).length, 1);
  release(); assert.ok((await Promise.all(answers)).every(answer => answer.ok));
  await app.inspect(); assert.equal(mediaRequests(app).length, 1); assert.equal(app.cookieCalls.length, 0);
});

test('protection: foreign senders cannot inspect or request diagnostics', async () => {
  const app = extensionHarness({ entries: noise });
  for (const sender of [{ id: 'foreign', tab: app.tab, url: app.tab.url }, { id: 'test-extension', tab: app.tab, url: 'file:///private' }]) {
    assert.equal((await app.raw({ type: 'hypernab:float', action: 'inspect', cookies: true }, sender)).ok, false);
  }
  assert.equal((await app.raw({ type: 'hypernab:diagnose', tabId: 7 }, { id: 'test-extension', tab: app.tab })).ok, false);
  assert.equal(app.requests.length, 0); assert.equal(app.cookieCalls.length, 0);
});
