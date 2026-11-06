// Which kind of browser the extension goes into, and opening its store page. Only two kinds matter: Chromium-based browsers (Chrome,
// Edge, Opera, Brave... all take the Chrome Web Store extension) and Firefox. Nothing is installed without the user: a store page opens and the
// person presses "Add" there. The page is opened in the default browser when it is of the right kind, else in an installed browser of that kind.
const fs = require('node:fs');
const path = require('node:path');

const BROWSERS = [
  { id: 'firefox', family: 'firefox', where: [['ProgramFiles', 'Mozilla Firefox\\firefox.exe'], ['ProgramFiles(x86)', 'Mozilla Firefox\\firefox.exe'], ['LOCALAPPDATA', 'Mozilla Firefox\\firefox.exe']] },
  { id: 'chrome', family: 'chromium', where: [['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'], ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'], ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe']] },
  { id: 'edge', family: 'chromium', where: [['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'], ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe']] },
  { id: 'brave', family: 'chromium', where: [['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], ['ProgramFiles(x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']] },
  { id: 'opera', family: 'chromium', where: [['LOCALAPPDATA', 'Programs\\Opera\\opera.exe'], ['ProgramFiles', 'Opera\\opera.exe'], ['ProgramFiles(x86)', 'Opera\\opera.exe']] }
];

function detectBrowsers({ env = process.env, exists = fs.existsSync } = {}) {
  const found = [];
  for (const browser of BROWSERS) {
    for (const [variable, relative] of browser.where) {
      const base = env[variable]; if (!base) continue;
      const exe = path.join(base, relative);
      if (exists(exe)) { found.push({ id: browser.id, family: browser.family, exe }); break; }
    }
  }
  return found;
}

// Windows keeps a list of the browsers that are installed (Settings > Default apps reads it). It names every browser, also the ones this file
// has no install place for (Vivaldi, Opera GX, a browser on another drive...). The kind is told from the program's file name.
const KIND_BY_PROGRAM = [
  [/^(firefox|waterfox|librewolf|palemoon|floorp|zen)\.exe$/i, 'firefox'],
  [/^(chrome|msedge|brave|opera|vivaldi|chromium|yandex|browser|thorium|whale|coccoc|iridium|arc|sidekick|duckduckgo)\.exe$/i, 'chromium']
];
const REGISTERED = ['HKLM\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet'];

/** The browsers in the output of eg query <StartMenuInternet> /s: [{ id, family, exe }]; programs of an unknown kind (Internet Explorer...) are left out. */
function parseRegisteredBrowsers(output) {
  const found = []; let inCommand = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { inCommand = /\\shell\\open\\command$/i.test(line.trim()); continue; }
    const value = inCommand && /^\s+.*?\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line)?.[1]; if (!value) continue;
    inCommand = false;
    const exe = (/^"([^"]+)"/.exec(value.trim()) || /^(.+?\.exe)/i.exec(value.trim()))?.[1]; if (!exe) continue;
    const name = path.win32.basename(exe), family = KIND_BY_PROGRAM.find(([pattern]) => pattern.test(name))?.[1];
    if (family) found.push({ id: name.replace(/\.exe$/i, '').toLowerCase(), family, exe });
  }
  return found;
}

/** Every installed browser Hypernab can use: Windows' own list first, then the known install places; each program once, only if the file exists. */
async function installedBrowsers({ run, exists = fs.existsSync, env = process.env }) {
  const listed = [];
  for (const key of REGISTERED) { try { listed.push(...parseRegisteredBrowsers(await run('reg', ['query', key, '/s']))); } catch { /* that list does not exist */ } }
  const seen = new Set(), result = [];
  for (const item of [...listed, ...detectBrowsers({ env, exists })]) {
    const key = item.exe.toLowerCase(); if (seen.has(key) || !exists(item.exe)) continue;
    seen.add(key); result.push({ id: item.id, family: item.family, exe: item.exe });
  }
  return result;
}

// The two store pages the app may open (the page that asks passes its address; anything else is refused).
const STORE_PAGES = {
  chromium: /^https:\/\/chromewebstore\.google\.com\/detail\/[a-p]{32}$/,
  firefox: /^https:\/\/addons\.mozilla\.org\/[A-Za-z-]+\/firefox\/addon\/[\w-]+\/?$/
};

/** 'chromium', 'firefox' or null from the name Windows keeps for the default web browser ("ChromeHTML", "FirefoxURL-308046B0AF4A39CB"...). */
function familyOfProgId(progId) {
  const id = String(progId || '');
  if (/^FirefoxURL/i.test(id)) return 'firefox';
  if (/^(ChromeHTML|MSEdgeHTM|BraveHTML|BraveFile|OperaStable|OperaGXStable|OperaDeveloper|VivaldiHTM|ChromiumHTM|ThoriumHTM|YandexHTML|ArcHTML)/i.test(id)) return 'chromium';
  return null; // unknown: the page then offers both store buttons and no "my browser" shortcut
}

/** Reads Windows' default browser. `run(file, args)` resolves to the command's output (injected so tests need no registry). */
async function defaultBrowserFamily({ run }) {
  try {
    const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
    return familyOfProgId(/ProgId\s+REG_SZ\s+(\S+)/i.exec(String(out))?.[1]);
  } catch { return null; }
}

/**
 * Opens a store page. family: 'chromium' | 'firefox' (which store). defaultFamily: the family of the default browser (or null).
 * Same family as the default: the default browser opens it. Otherwise an installed browser of that family opens it. None installed:
 * with an unknown default the default browser is tried, else the address is copied so it can be pasted.
 */
async function openStorePage(family, url, { defaultFamily, detect = async () => detectBrowsers(), spawn, shell, clipboard }) {
  if (!STORE_PAGES[family]?.test(String(url))) throw new Error('unknown store page');
  if (defaultFamily === family) { await shell.openExternal(url); return { opened: 'default' }; }
  const browser = (await detect()).find(item => item.family === family);
  if (browser) {
    const child = spawn(browser.exe, [url], { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {}); child.unref?.();
    return { opened: 'browser' };
  }
  if (!defaultFamily) { await shell.openExternal(url); return { opened: 'default' }; }
  try { clipboard.writeText(url); } catch { /* the address is on the page */ }
  return { opened: false, copied: true };
}

module.exports = { BROWSERS, STORE_PAGES, detectBrowsers, parseRegisteredBrowsers, installedBrowsers, familyOfProgId, defaultBrowserFamily, openStorePage };
