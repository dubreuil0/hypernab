// The browsers Hypernab's extension can be set up in, found on this computer, and the "set up" step of the wizard: open that browser's
// extensions page and the extension folder, and put the path to pick into the clipboard. Nothing is installed without the user: the
// browser itself asks, and in a browser that lets a person load an unpacked extension the person presses the buttons.
const fs = require('node:fs');
const path = require('node:path');

const BROWSERS = [
  { id: 'firefox', name: 'Firefox', family: 'firefox', url: 'about:debugging#/runtime/this-firefox', where: [['ProgramFiles', 'Mozilla Firefox\\firefox.exe'], ['ProgramFiles(x86)', 'Mozilla Firefox\\firefox.exe'], ['LOCALAPPDATA', 'Mozilla Firefox\\firefox.exe']] },
  { id: 'chrome', name: 'Chrome', family: 'chromium', url: 'chrome://extensions', where: [['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'], ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'], ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe']] },
  { id: 'edge', name: 'Edge', family: 'chromium', url: 'edge://extensions', where: [['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'], ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe']] },
  { id: 'brave', name: 'Brave', family: 'chromium', url: 'brave://extensions', where: [['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], ['ProgramFiles(x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']] },
  { id: 'opera', name: 'Opera', family: 'chromium', url: 'opera://extensions', where: [['LOCALAPPDATA', 'Programs\\Opera\\opera.exe'], ['ProgramFiles', 'Opera\\opera.exe'], ['ProgramFiles(x86)', 'Opera\\opera.exe']] }
];

function detectBrowsers({ env = process.env, exists = fs.existsSync } = {}) {
  const found = [];
  for (const browser of BROWSERS) {
    for (const [variable, relative] of browser.where) {
      const base = env[variable]; if (!base) continue;
      const exe = path.join(base, relative);
      if (exists(exe)) { found.push({ id: browser.id, name: browser.name, family: browser.family, exe, url: browser.url }); break; }
    }
  }
  return found;
}

// The wizard's button: only a browser that was found can be opened, only with its own extensions page.
async function openBrowserSetup(id, { detect = detectBrowsers, spawn, shell, clipboard, extensionsFolder }) {
  const browser = detect().find(item => item.id === id);
  if (!browser) throw new Error('unknown browser');
  const folder = path.join(extensionsFolder, browser.family === 'firefox' ? 'firefox' : 'chromium');
  const pick = browser.family === 'firefox' ? path.join(folder, 'manifest.json') : folder; // what the browser's file window asks for
  const child = spawn(browser.exe, [browser.url], { detached: true, stdio: 'ignore' });
  child.on?.('error', () => {}); child.unref?.();
  try { await shell.openPath(folder); } catch { /* the path is still copied */ }
  try { clipboard.writeText(pick); } catch { /* it can be typed */ }
  return { family: browser.family, pick };
}

module.exports = { BROWSERS, detectBrowsers, openBrowserSetup };
