// Links in the clipboard text, for the optional "offer links from the clipboard" setting (off by default). The text is only looked at in
// memory when the window gets focus; it is never stored, logged or sent anywhere. Pure functions, no Electron here.
const LINK = /https?:\/\/[^\s<>"'`]+/gi;
const MAX_TEXT = 20000, MAX_LINKS = 100;

function linksIn(text) {
  const found = new Set();
  for (const raw of String(text || '').slice(0, MAX_TEXT).match(LINK) || []) {
    const link = raw.replace(/[),.;]+$/, '');
    try { const url = new URL(link); if (/^https?:$/.test(url.protocol) && !url.username && !url.password && link.length <= 2048) found.add(link); } catch { /* not a link */ }
    if (found.size >= MAX_LINKS) break;
  }
  return [...found];
}

// What to offer now: the links of this clipboard text, unless it is the very text that was already offered (or there is none).
function offerFor(text, lastOffered) {
  if (!text || text === lastOffered) return null;
  const links = linksIn(text);
  return links.length ? links : null;
}

module.exports = { linksIn, offerFor };
