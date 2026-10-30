// Test-only browser/app doubles. Loads the unmodified production scripts in a fresh VM per scenario.
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const sources = ['core.js', 'float.js'].map(name => fs.readFileSync(new URL(`../../extension/${name}`, import.meta.url), 'utf8'));
export const mediaInfo = { title: 'Synthetic video', defaultOptionId: '720', options: [
  { id: '720', label: '720p · MP4', height: 720, fps: 30, ext: 'mp4', codec: 'H.264', audio: 'included' },
  { id: '1080', label: '1080p · MP4', height: 1080, fps: 30, ext: 'mp4', codec: 'H.264', audio: 'included' }
] };
export function extensionHarness({ entries = [], frames = {}, inspect = () => mediaInfo, transformFloat = source => source } = {}) {
  const tab = { id: 7, url: 'https://page.example.org/watch?id=fixture', title: 'Synthetic video', cookieStoreId: 'store-a' };
  const session = { 'tab:7': entries, 'context:7': { frames } }, local = { token: 'a'.repeat(64) };
  const requests = [], cookieCalls = [];
  let listener, instanceId = 'instance-a';
  const browser = {
    runtime: { id: 'test-extension', getManifest: () => ({ version: 'test' }), onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { get: async () => ({ ...tab }), sendMessage: async (_tabId, message) => {
      if (message.type === 'hypernab:collect-subtitles') session['subs:7'] = Object.fromEntries(Object.keys(session['context:7']?.frames || {}).map(key => [key, { serial: message.serial, tracks: [], urls: [] }]));
    } },
    storage: Object.fromEntries([['session', session], ['local', local]].map(([name, state]) => [name, {
      get: async keys => Object.fromEntries([].concat(keys).map(key => [key, state[key]])),
      set: async values => { Object.assign(state, values); }
    }])),
    cookies: { getAll: async query => {
      cookieCalls.push(query);
      return [{ name: 'sid', value: 'SYNTHETIC-COOKIE-NEVER-STORE', domain: new URL(query.url).hostname, path: '/', secure: true, hostOnly: true }];
    } }
  };
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body });
    const data = route === '/api/status' ? { extensionProtocol: 1, instanceId }
      : ['/api/inspect', '/api/sniff'].includes(route) ? await inspect(body, route)
        : route.startsWith('/api/submissions/') ? { known: false }
          : route === '/api/duplicates' ? { duplicates: [] } : { id: '11111111-1111-4111-8111-111111111111' };
    return { ok: !data?.httpError, status: data?.httpError ? 422 : 200, json: async () => data?.httpError ? { error: data.httpError, code: data.code } : data };
  };
  const context = vm.createContext({ browser, URL, AbortSignal, Date, Math, JSON, Promise, crypto: { randomUUID }, navigator: { userAgent: 'Synthetic-UA' }, setTimeout, clearTimeout, fetch: fetcher });
  sources.forEach((source, index) => vm.runInContext(index === 1 ? transformFloat(source) : source, context));
  const raw = (message, sender) => new Promise(resolve => { if (listener(message, sender, resolve) !== true) resolve(null); });
  return { tab, session, local, requests, cookieCalls,
    raw,
    inspect: (cookies = false) => raw({ type: 'hypernab:float', action: 'inspect', cookies }, { id: browser.runtime.id, tab: { ...tab }, url: tab.url }),
    diagnose: () => raw({ type: 'hypernab:diagnose', tabId: tab.id }, { id: browser.runtime.id }),
    restart: () => { instanceId += '-new'; }
  };
}

// Seeded permutations make a failure reproducible, unlike Math.random() fuzzing in a normal test run.
export function shuffled(items, seed) {
  const list = [...items]; let state = seed >>> 0;
  for (let i = list.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = state % (i + 1); [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
