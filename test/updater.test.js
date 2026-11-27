import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Updater, busy } = createRequire(import.meta.url)('../desktop/updater.cjs');
createRequire(import.meta.url)('../desktop/texts.cjs').setLanguage('tr'); // these tests read the Turkish texts

function fixture({ latest = '0.10.24', answers = [0, 0], fail = false } = {}) {
  const calls = [], queue = [...answers], messages = [];
  const autoUpdater = {
    checkForUpdates: async () => { calls.push('check'); if (fail) throw new Error('offline https://secret.example/?token=SECRET'); return { updateInfo: { version: latest } }; },
    downloadUpdate: async () => { calls.push('download'); },
    quitAndInstall: (...args) => calls.push(['install', ...args])
  };
  const dialog = { showMessageBox: async options => { messages.push(options); return { response: queue.length ? queue.shift() : 1 }; } };
  const updater = new Updater({ autoUpdater, dialog, version: '0.10.23', onInstall: async finish => { calls.push('shutdown'); finish(); } });
  return { updater, calls, messages, autoUpdater };
}

test('updater never downloads automatically and refuses prerelease/downgrade', () => {
  const f = fixture();
  assert.equal(f.autoUpdater.autoDownload, false); assert.equal(f.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(f.autoUpdater.allowPrerelease, false); assert.equal(f.autoUpdater.allowDowngrade, false);
});

test('quiet check: same or older version shows nothing and downloads nothing', async () => {
  for (const latest of ['0.10.23', '0.10.22', '0.9.99', 'abc']) {
    const f = fixture({ latest }); await f.updater.check(false);
    assert.deepEqual(f.calls, ['check']); assert.equal(f.messages.length, 0); assert.equal(f.updater.state, 'idle');
  }
});

test('manual check reports up to date and failures without leaking error text', async () => {
  const f = fixture({ latest: '0.10.23' }); await f.updater.check(true);
  assert.match(f.messages[0].message, /güncel/);
  const g = fixture({ fail: true }); await g.updater.check(true);
  assert.equal(g.messages.length, 1); assert.doesNotMatch(JSON.stringify(g.messages), /secret|SECRET|https/);
  const q = fixture({ fail: true }); await q.updater.check(false); assert.equal(q.messages.length, 0, 'quiet check stays silent on failure');
});

test('newer version needs a click to download; declining downloads nothing', async () => {
  const f = fixture({ answers: [1] }); await f.updater.check(false);
  assert.deepEqual(f.calls, ['check']); assert.equal(f.updater.state, 'idle');
  const g = fixture({ latest: '0.11.0', answers: [0] }); await g.updater.check(false);
  assert.deepEqual(g.calls, ['check', 'download']); assert.equal(g.updater.state, 'ready');
  assert.equal(fixture().updater.newer('0.10.100'), true); assert.equal(fixture().updater.newer('1.0'), true);
});

test('install is offered only when no transfer is active, then shuts the engine down before installing', async () => {
  const f = fixture(); await f.updater.check(false);
  assert.equal(f.updater.state, 'ready');
  for (const status of ['running', 'queued']) assert.equal(await f.updater.idle([{ status }]), false);
  assert.equal(await f.updater.idle([{ status: 'paused', settling: true }]), false);
  assert.equal(f.messages.length, 1, 'no install prompt while busy');
  assert.equal(await f.updater.idle([{ status: 'held' }, { status: 'paused' }, { status: 'completed' }]), true);
  assert.deepEqual(f.calls.slice(-2), ['shutdown', ['install', true, true]]);
});

test('"later" on the install prompt does not nag again', async () => {
  const f = fixture({ answers: [0, 1] }); await f.updater.check(false);
  assert.equal(await f.updater.idle([]), false); assert.equal(await f.updater.idle([]), false);
  assert.equal(f.messages.length, 2); assert.ok(!f.calls.includes('shutdown'));
  await f.updater.check(true); assert.equal(f.updater.pending, true, 'a later manual check re-arms the prompt');
});

test('inline check (Settings row): returns the outcome and shows no "up to date" / "failed" / "busy" box', async () => {
  const f = fixture({ latest: '0.10.23' });
  assert.deepEqual(await f.updater.check(true, true), { state: 'current', version: '0.10.23' }); assert.equal(f.messages.length, 0);
  const g = fixture({ fail: true });
  const failed = await g.updater.check(true, true);
  assert.deepEqual(failed, { state: 'failed', version: '0.10.23', error: 'check-failed' });
  assert.equal(g.messages.length, 0); assert.doesNotMatch(JSON.stringify(failed), /secret|SECRET|https/);
  const slow = fixture(); slow.updater.state = 'checking';
  assert.equal((await slow.updater.check(true, true)).state, 'busy'); assert.equal(slow.messages.length, 0);
});

test('inline check: a newer version still asks before downloading, and the answer is reported', async () => {
  const declined = fixture({ latest: '0.11.0', answers: [1] });
  assert.deepEqual(await declined.updater.check(true, true), { state: 'available', version: '0.10.23', latest: '0.11.0' });
  assert.deepEqual(declined.calls, ['check']); assert.equal(declined.messages.length, 1, 'the existing download question is shown');
  const accepted = fixture({ latest: '0.11.0', answers: [0] });
  assert.deepEqual(await accepted.updater.check(true, true), { state: 'downloading', version: '0.10.23', latest: '0.11.0' }, 'the row does not wait for the download');
  assert.deepEqual(accepted.calls, ['check', 'download']);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(accepted.updater.state, 'ready');
  const broken = fixture({ latest: '0.11.0', answers: [0] }); broken.autoUpdater.downloadUpdate = async () => { throw new Error('network'); };
  assert.equal((await broken.updater.check(true, true)).state, 'downloading');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(broken.updater.state, 'idle', 'a failed background download returns to idle');
  assert.deepEqual(await accepted.updater.check(true, true), { state: 'ready', version: '0.10.23', latest: '0.11.0' }, 'a second click re-arms, no new network');
  assert.equal(typeof (await fixture().updater.check(false)), 'string', 'without inline the new state string is still returned');
});

test('the start check is skipped only when the setting is explicitly off', () => {
  const { checkAtStart } = createRequire(import.meta.url)('../desktop/updater.cjs');
  assert.equal(checkAtStart({ checkUpdatesOnStart: false }), false);
  for (const value of [{ checkUpdatesOnStart: true }, {}, undefined, null]) assert.equal(checkAtStart(value), true);
});

test('busy() treats unfinished pausing as busy', () => {
  assert.equal(busy([{ status: 'paused', settling: true }]), true);
  assert.equal(busy([{ status: 'failed' }, { status: 'interrupted' }]), false);
});
