import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DownloadQueue } from '../src/downloads.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hypernab-undo-test-'));
  const queue = new DownloadQueue({ directory: path.join(root, 'downloads'), stateFile: path.join(root, 'queue.json'), toolsDirectory: root });
  t.after(() => { queue.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return queue;
}
const job = (status, extra = {}) => ({ id: randomUUID(), url: 'https://example.com/a.mp4', engine: 'direct', title: 'Test', status, received: 0, speed: 0, ...extra });

test('"Remove from the list" can be undone: the records return to the same places, nothing in the folder changes', t => {
  const queue = fixture(t), a = job('completed'), b = job('paused'), c = job('failed'), d = job('running'), e = job('completed');
  a.file = `${a.id}-a.mp4`; fs.mkdirSync(queue.directory, { recursive: true }); fs.writeFileSync(path.join(queue.directory, a.file), 'finished bytes');
  queue.jobs = [a, b, c, d, e];
  queue.active.set(d.id, new AbortController());
  const before = fs.readdirSync(queue.directory).map(name => [name, fs.readFileSync(path.join(queue.directory, name)).toString('hex')]);
  const result = queue.clearFinished();
  assert.equal(result.removed, 3); assert.deepEqual(queue.jobs.map(j => j.id), [b.id, d.id]);
  assert.equal(typeof result.undoToken, 'string');
  assert.deepEqual(queue.restoreRemoved({ token: result.undoToken }), { restored: 3 });
  assert.deepEqual(queue.jobs.map(j => j.id), [a.id, b.id, c.id, d.id, e.id], 'every record is back at its place');
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).length, 5, 'and the saved list says so');
  assert.deepEqual(fs.readdirSync(queue.directory).map(name => [name, fs.readFileSync(path.join(queue.directory, name)).toString('hex')]), before, 'no file was touched');
  assert.throws(() => queue.restoreRemoved({ token: result.undoToken }), /geri al|undo/i, 'an undo works once');
  queue.active.clear();
});

test('undo needs the right token, comes only a short time after, and only the last removal can be undone', t => {
  const queue = fixture(t), a = job('completed'), b = job('completed'), c = job('cancelled');
  queue.jobs = [a, b, c];
  const first = queue.clearFinished({ ids: [a.id] });
  assert.throws(() => queue.restoreRemoved({ token: 'not-the-token' }), /geri al|undo/i);
  assert.throws(() => queue.restoreRemoved({}), /geri al|undo/i);
  assert.throws(() => queue.restoreRemoved(), /geri al|undo/i);
  const second = queue.clearFinished({ ids: [b.id] });
  assert.throws(() => queue.restoreRemoved({ token: first.undoToken }), /geri al|undo/i, 'the earlier removal can no longer be undone');
  queue.lastRemoved.at -= 61000; // too long ago
  assert.throws(() => queue.restoreRemoved({ token: second.undoToken }), /geri al|undo/i);
  assert.deepEqual(queue.jobs.map(j => j.id), [c.id], 'a refused undo changes nothing');
  assert.equal(queue.clearFinished({ ids: [] }).undoToken, null, 'nothing removed, nothing to undo');
});

test('a record that came back by other means is not added twice', t => {
  const queue = fixture(t), a = job('completed');
  queue.jobs = [a];
  const result = queue.clearFinished();
  queue.jobs.push({ ...a }); // the same download was added again meanwhile
  assert.deepEqual(queue.restoreRemoved({ token: result.undoToken }), { restored: 1 });
  assert.equal(queue.jobs.filter(j => j.id === a.id).length, 1);
});
