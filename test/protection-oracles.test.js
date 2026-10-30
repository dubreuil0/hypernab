import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionHarness, mediaInfo } from '../scripts/test-support/extension-harness.js';

function changeOnce(from, to) {
  return source => {
    assert.equal(source.split(from).length, 2, 'test mutation must target exactly one known rule; update test if production formatting changed');
    return source.replace(from, to);
  };
}

test('protection oracle: the same video-selection assertion rejects an in-memory reintroduction of UNKNOWN-first ranking', async () => {
  const url = 'https://media.example.org/?signature=EXACT';
  const scenario = async transformFloat => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ kind: 'UNKNOWN', url: `https://noise.example.org/ping?i=${i}` }));
    entries.push({ kind: 'VIDEO', url, mime: 'video/mp4', frameId: 0 });
    const app = extensionHarness({ transformFloat, entries, frames: { 0: { mediaUrl: url, height: 720 } }, inspect: body => body.url === url ? mediaInfo : { httpError: 'Not video' } });
    return (await app.inspect()).ok;
  };
  assert.equal(await scenario(undefined), true, 'production reference must find the file');
  assert.equal(await scenario(changeOnce("item.kind === 'UNKNOWN' ? 2 : 3", "item.kind === 'UNKNOWN' ? -2 : 3")), false, 'the intentionally wrong ranking must be detected');
});

test('protection oracle: the same cache assertion rejects an in-memory removal of source-kind isolation', async () => {
  const url = 'https://media.example.org/opaque';
  const scenario = async transformFloat => {
    const app = extensionHarness({ transformFloat, entries: [{ kind: 'UNKNOWN', url }], inspect: (body, route) => body.url === url && route === '/api/inspect' ? mediaInfo : { httpError: 'Not HLS' } });
    assert.equal((await app.inspect()).ok, false);
    app.session['tab:7'] = [{ kind: 'VIDEO', url, mime: 'video/mp4' }];
    return (await app.inspect()).ok;
  };
  assert.equal(await scenario(undefined), true);
  assert.equal(await scenario(changeOnce('hit.sourceKind === sourceKind && ', '')), false, 'the intentionally stale cache must be detected');
});
