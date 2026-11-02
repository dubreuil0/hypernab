import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const TOKEN = 'a'.repeat(64);

// Real core.js + float.js against a fake browser and a fake app server (an async one, so concurrency can be watched).
function setup({ entries = [], frames = {}, inspect, activity = [], onJob, settings = {} } = {}) {
  const session = { 'tab:7': entries, 'context:7': { frames } }, local = { token: TOKEN };
  const requests = [];
  let listener = null, running = 0, peak = 0;
  const browser = {
    runtime: { id: 'ext', getManifest: () => ({ version: '9.9.9' }), onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { async get(id) { return { id, url: 'https://example.org/watch?v=1', title: 'Film' }; }, async sendMessage() {} },
    storage: {
      session: { async get(keys) { return Object.fromEntries([].concat(keys).map(key => [key, session[key]]).filter(([, value]) => value !== undefined)); }, async set(values) { Object.assign(session, values); } },
      local: { async get(keys) { if (keys === null) return { ...local }; return Object.fromEntries([].concat(keys).map(key => [key, local[key]]).filter(([, value]) => value !== undefined)); }, async set(values) { Object.assign(local, values); }, async remove(keys) { for (const key of [].concat(keys)) delete local[key]; } }
    },
    cookies: { async getAll() { return []; } }
  };
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body });
    const inspection = ['/api/inspect', '/api/sniff'].includes(route); // the limit is about inspections, not tiny reads
    if (inspection) { running++; peak = Math.max(peak, running); }
    try {
      await new Promise(resolve => setTimeout(resolve, 8));
      const data = route === '/api/status' ? { extensionProtocol: 1, instanceId: 'engine-1' }
        : ['/api/inspect', '/api/sniff'].includes(route) ? await inspect(body)
          : route === '/api/prefs' ? settings
          : route === '/api/hls/active-audio' ? { active: activity.length ? 'a1' : null }
            : route === '/api/duplicates' ? { duplicates: [] }
              : route.startsWith('/api/submissions/') ? { known: false } : (onJob?.(body), { id: 'job-1' });
      return { ok: !data?.httpError, status: data?.httpError ? 422 : 200, json: async () => data?.httpError ? { error: data.httpError } : data };
    } finally { if (inspection) running--; }
  };
  const context = vm.createContext({ browser, URL, AbortSignal, JSON, Promise, Date, Math, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, navigator: { userAgent: 'UA' }, setTimeout, clearTimeout, fetch: fetcher, globalThis: null });
  context.globalThis = context;
  context.HypernabActivity = { recent: () => activity, on() {}, summary: () => [] };
  vm.runInContext(read('core.js'), context); vm.runInContext(read('float.js'), context);
  const send = message => new Promise(resolve => {
    const keep = listener(message, { id: 'ext', tab: { id: 7, url: 'https://example.org/watch?v=1', title: 'Film' }, url: 'https://example.org/watch?v=1' }, resolve);
    if (keep !== true) resolve(null);
  });
  return { send, requests, session, peak: () => peak };
}
const option = (id, height) => ({ id, label: `${height}p · MP4 · H.264`, height, fps: null, hdr: false, codec: 'H.264', ext: 'mp4', filesize: 5e7, sizeKind: 'approx', recommended: true, audio: 'merged' });
const sounds = [{ id: 'a0', name: 'Türkçe Dublaj', language: 'tr', default: true }, { id: 'a1', name: 'Orijinal', language: 'en', default: false }];
const master = { title: 'Film', duration: 6000, defaultOptionId: 'v2', options: [option('v2', 720), option('v1', 360)], audioTracks: sounds };
const stream = (path, size) => ({ url: `https://cdn.example.org/${path}`, kind: 'HLS', size, frameId: 0, identity: `https://cdn.example.org/${path}`, detectedAt: 1 });
const ask = (app, extra = {}) => app.send({ type: 'hypernab:float', action: 'inspect', cookies: false, ...extra });

test('the small master list wins even when it was captured first (oldest) and a sound-only list came last', async () => {
  // newest first, like the extension stores them: a picture list, a sound list, and the master (the player asked for it first)
  const entries = [stream('mg/pic', 4608), stream('m2/snd', 6121), stream('ml/master', 615)];
  const app = setup({ entries, frames: { 0: { duration: 6000 } }, inspect: body => body.url.endsWith('/master') ? master
    : body.url.endsWith('/snd') ? { title: 'Film', audioOnly: true, options: [] } : { title: 'Film', silentStream: true, options: [option('x', 360)] } });
  const answer = await ask(app);
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(answer.options.map(item => item.height), [720, 360]);
  assert.equal(app.requests.find(r => r.route === '/api/inspect').body.url, 'https://cdn.example.org/ml/master', 'the master is looked at first');
  assert.equal(app.requests.filter(r => r.route === '/api/inspect').length, 1, 'and nothing else needs to be asked');
});

test('a sound-only list is never the answer when something with a picture exists', async () => {
  const entries = [stream('m2/snd', 6121), stream('mg/pic', 4608)];
  const app = setup({ entries, inspect: body => body.url.endsWith('/snd') ? { title: 'Film', audioOnly: true, options: [] } : { title: 'Film', silentStream: true, options: [option('x', 360)] } });
  const answer = await ask(app);
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.options.length, 1, 'the picture list is shown, not the empty sound list');
});

test('a master that is not the player\'s video (an advertisement) is not preferred over what is playing', async () => {
  const entries = [stream('ad/master', 600), stream('film/master', 700)];
  const ad = { ...master, duration: 30, options: [option('ad1', 720), option('ad2', 360)], audioTracks: undefined };
  const app = setup({ entries, frames: { 0: { duration: 6000 } }, inspect: body => body.url.includes('/ad/') ? ad : master });
  const answer = await ask(app);
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(answer.options.map(item => item.id), ['v2', 'v1'], 'the 30 second advertisement is not the 100 minute video');
});

test('several sounds are offered; the one the player fetches is preselected; the chosen one travels with the download', async () => {
  const jobs = [];
  const app = setup({ entries: [stream('ml/master', 615)], activity: [{ url: 'https://cdn.example.org/m/en/en-0.ts', at: 5 }], inspect: () => master, onJob: body => jobs.push(body) });
  const answer = await ask(app);
  assert.deepEqual(answer.audioTracks.map(track => track.id), ['a0', 'a1']); assert.equal(answer.audioActive, 'a1');
  assert.ok(!JSON.stringify(answer).includes('cdn.example.org/m/'), 'no piece address reaches the page');
  const started = await app.send({ type: 'hypernab:float', action: 'start', optionId: 'v2', mode: 'now', audioTrack: 'a1' });
  assert.equal(started.ok, true, started.error);
  assert.equal(jobs[0].audioTrack, 'a1'); assert.equal(jobs[0].formatId, 'v2');
  const other = setup({ entries: [stream('ml/master', 615)], inspect: () => master, onJob: body => jobs.push(body) });
  await ask(other);
  await other.send({ type: 'hypernab:float', action: 'start', optionId: 'v2', mode: 'now', audioTrack: 'a7' });
  assert.equal(jobs[1].audioTrack, undefined, 'a sound the app never offered is not sent');
  await other.send({ type: 'hypernab:float', action: 'start', optionId: 'v1', mode: 'queue' });
  assert.equal(jobs[2].audioTrack, undefined, 'no choice, no field: the site default applies as before');
  const unknown = await ask(setup({ entries: [stream('ml/master', 615)], inspect: () => master }));
  assert.equal(unknown.audioActive, null, 'nothing fetched yet: the panel says it cannot tell and lets the user choose');
});

test('"fresh" looks at the page from scratch; an ordinary second look uses the answer it already has', async () => {
  const app = setup({ entries: [stream('ml/master', 615)], inspect: () => master });
  await ask(app); await ask(app);
  assert.equal(app.requests.filter(r => r.route === '/api/inspect').length, 1);
  await ask(app, { fresh: true });
  assert.equal(app.requests.filter(r => r.route === '/api/inspect').length, 2);
});

test('lists are looked at two at a time at most: the app is never sent more than it accepts', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => stream(`m${i}/list`, 5000 + i));
  const app = setup({ entries, inspect: () => ({ title: 'Film', silentStream: true, options: [option('x', 360)] }) });
  const answer = await ask(app);
  assert.equal(answer.ok, true, answer.error);
  assert.ok(app.peak() <= 2, `at most two requests at once (saw ${app.peak()})`);
});

test('sound preselection: playing wins; else the preference (one match only); else the site default, said as such', async () => {
  const plain = value => JSON.parse(JSON.stringify(value ?? null)); // objects from the test's own vm realm
  const pick = async settings => plain((await ask(setup({ entries: [stream('ml/master', 615)], inspect: () => master, settings }))).audioPick);
  assert.deepEqual(await pick({}), { id: 'a0', why: 'site-default' }, 'no preference, nothing playing: the site\'s own default');
  assert.deepEqual(await pick({ audioLanguage: 'player' }), { id: 'a0', why: 'site-default' });
  assert.deepEqual(await pick({ audioLanguage: 'original' }), { id: 'a1', why: 'preference' }, 'the sound named "Orijinal"');
  assert.deepEqual(await pick({ audioLanguage: 'en' }), { id: 'a1', why: 'preference' });
  assert.deepEqual(await pick({ audioLanguage: 'tr' }), { id: 'a0', why: 'preference' });
  assert.deepEqual(await pick({ audioLanguage: 'ja' }), { id: 'a0', why: 'site-default' }, 'no Japanese sound: never a wrong one, the site default stays');
  const playing = await ask(setup({ entries: [stream('ml/master', 615)], activity: [{ url: 'https://cdn.example.org/m/en/en-0.ts', at: 5 }], inspect: () => master, settings: { audioLanguage: 'tr' } }));
  assert.deepEqual(plain(playing.audioPick), { id: 'a1', why: 'playing' }, 'what the player plays beats the preference');
});

test('pickSound on its own: the subtitle language never decides the sound; ambiguous matches are not guessed', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8'), context);
  const plain = value => JSON.parse(JSON.stringify(value ?? null));
  const core = { pickSound: (...args) => plain(context.Hypernab.pickSound(...args)) };
  const tracks = [{ id: 'a0', name: 'Deutsch', language: 'de', default: true }, { id: 'a1', name: 'English', language: 'en-US' }, { id: 'a2', name: 'English Commentary', language: 'en' }];
  assert.equal(core.pickSound(tracks, null, 'de').id, 'a0');
  assert.deepEqual(core.pickSound(tracks, null, 'en'), { id: 'a0', why: 'site-default' }, 'two English sounds: not guessed');
  assert.deepEqual(core.pickSound(tracks, 'a2', 'de'), { id: 'a2', why: 'playing' });
  assert.equal(core.pickSound([tracks[0]], null, 'de'), null, 'one sound: nothing to choose');
  assert.deepEqual(core.pickSound([{ id: 'a0', name: 'x' }, { id: 'a1', name: 'y' }], null, 'player'), { id: 'a0', why: 'first' });
});
