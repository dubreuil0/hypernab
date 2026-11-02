import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// "Download with Hypernab" on a link's right-click menu: the real core.js + link-download.js against a fake browser and a fake app connection.
const read = name => fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');

function setup({ online = true, take, receipt = { known: false }, on = true } = {}) {
  const requests = [], cookieReads = [], notices = [];
  let onMenu;
  const api = {
    runtime: { id: 'ext' },
    contextMenus: { onClicked: { addListener: listener => { onMenu = listener; } } },
    cookies: { getAll: async query => { cookieReads.push(query); return [{ name: 'sid', value: 'SECRET-COOKIE', domain: new URL(query.url).hostname, path: '/', secure: true, hostOnly: true, expirationDate: 4102444800 }]; } }
  };
  const client = {
    request: async (route, options = {}) => {
      requests.push({ route, body: options.body ? JSON.parse(options.body) : undefined });
      if (route === '/api/files/take') return take ? take(JSON.parse(options.body)) : { id: 'job-1', name: 'Real Name.zip' };
      if (route.startsWith('/api/submissions/')) return receipt;
      throw new Error(`unexpected ${route}`);
    }
  };
  const context = vm.createContext({ URL, crypto: webcrypto, navigator: { userAgent: 'UA/Test' }, console, clearTimeout, setTimeout, chrome: api });
  vm.runInContext(read('core.js'), context);
  context.HypernabFloat = { connection: async userAction => { if (!online) throw Object.assign(new Error('offline'), { code: 'APP_OFFLINE' }); requests.push({ route: 'connection', userAction }); return client; } };
  context.HypernabControl = { on, notice: async (...args) => { notices.push(args); } };
  vm.runInContext(read('link-download.js'), context);
  const click = async (info, tab = { id: 7 }) => { onMenu({ menuItemId: 'download-link', ...info }, tab); await context.HypernabLinkDownload.idle(); };
  return { requests, cookieReads, notices, click, send: (...args) => onMenu(...args), context };
}
const link = 'https://files.example.org/get/Veri%20Paketi.zip', page = 'https://files.example.org/page';

test('a click on "Download with Hypernab" sends that one link to the app, with its page as referrer and its own cookies', async () => {
  const f = setup();
  assert.equal(f.cookieReads.length, 0, 'no cookie is read before the user asks');
  await f.click({ linkUrl: link, pageUrl: page });
  const take = f.requests.find(request => request.route === '/api/files/take').body;
  assert.equal(take.url, link); assert.equal(take.referer, page); assert.equal(take.start, 'now'); assert.equal(take.userAgent, 'UA/Test');
  assert.match(take.submissionId, /^[a-f0-9-]{36}$/);
  assert.equal(take.cookies[0].value, 'SECRET-COOKIE');
  assert.ok(f.cookieReads.every(query => query.url.startsWith('https://files.example.org/')), 'only the cookies of these two addresses');
  assert.equal(f.requests.find(request => request.route === 'connection').userAction, true, 'a closed app is started, like the video button');
  assert.deepEqual(f.notices, [['added', 'Real Name.zip']]);
});

test('private windows and containers: the cookie store of that tab is used, and the normal session is never borrowed', async () => {
  const container = setup();
  await container.click({ linkUrl: link, pageUrl: page }, { id: 7, cookieStoreId: 'firefox-container-3' });
  assert.ok(container.cookieReads.length > 0 && container.cookieReads.every(query => query.storeId === 'firefox-container-3'));
  const privateWindow = setup();
  await privateWindow.click({ linkUrl: link, pageUrl: page }, { id: 7, incognito: true });
  assert.equal(privateWindow.cookieReads.length, 0, 'a private tab without a named store: no cookie is read');
  assert.deepEqual(privateWindow.requests.find(request => request.route === '/api/files/take').body.cookies, []);
});

test('not a web address, closed app, refusal, duplicate: each shows on the icon and never throws', async () => {
  const mail = setup(); await mail.click({ linkUrl: 'mailto:someone@example.org', pageUrl: page });
  assert.equal(mail.requests.some(request => request.route === '/api/files/take'), false); assert.equal(mail.notices[0][0], 'failed');
  const offline = setup({ online: false }); await offline.click({ linkUrl: link, pageUrl: page });
  assert.equal(offline.notices[0][0], 'failed'); assert.equal(offline.notices[0][1], 'Veri Paketi.zip');
  const refused = setup({ take: async () => { throw Object.assign(new Error('The link returned a web page.'), { code: 'NOT_A_FILE' }); } });
  await refused.click({ linkUrl: link, pageUrl: page });
  assert.deepEqual(refused.notices, [['failed', 'Veri Paketi.zip', 'The link returned a web page.']]);
  const twice = setup({ take: async () => { throw Object.assign(new Error('already'), { code: 'duplicate' }); } });
  await twice.click({ linkUrl: link, pageUrl: page });
  assert.deepEqual(twice.notices, [['duplicate', 'Veri Paketi.zip']]);
});

test('a lost answer is not a lost file: the submission receipt tells whether the app has it', async () => {
  const timeout = async () => { throw Object.assign(new Error('timeout'), { code: 'APP_TIMEOUT' }); };
  const known = setup({ take: timeout, receipt: { known: true, id: 'job-9', listed: true } });
  await known.click({ linkUrl: link, pageUrl: page });
  assert.deepEqual(known.notices, [['added', 'Veri Paketi.zip']]);
  const unknown = setup({ take: timeout });
  await unknown.click({ linkUrl: link, pageUrl: page });
  assert.equal(unknown.notices[0][0], 'failed');
});

test('other menu items and a capture switched off do nothing', async () => {
  const f = setup();
  f.send({ menuItemId: 'capture', linkUrl: link, pageUrl: page }, { id: 7 }); await f.context.HypernabLinkDownload.idle();
  assert.equal(f.requests.length, 0);
  const off = setup({ on: false }); await off.click({ linkUrl: link, pageUrl: page });
  assert.equal(off.requests.length, 0); assert.equal(off.notices.length, 0);
});
