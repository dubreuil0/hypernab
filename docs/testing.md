# Testing

Three layers, from cheap to expensive. Run the first two before every commit; run the matching real-browser checks when you touch the extension, the UI or the desktop shell; run all of them before a release.

## 1. Unit tests (offline, ~600 tests)

```powershell
npm test          # node --import ./test/setup-locale.js --test   (test/*.test.js)
npm run check     # node --check on the main files
```

- One file per area (`downloads.test.js`, `transfer.test.js`, `float.test.js`, `native.test.js`, ...). Name new files `<area>.test.js`.
- `test/setup-locale.js` pins the locale so text-dependent assertions are stable; `test/content-scripts.js` loads the real content scripts for tests.
- `protection-*.test.js` are adversarial tests (request-order shuffles, failing servers, foreign senders, cookie isolation); see [protection-tests.md](protection-tests.md). `node scripts/smoke/protection-check.js [--full]` runs them and proves no source file changed during the run.
- Some tests are guards that a removed feature stays removed (automatic file takeover, the old popup, the queue, the old extension wizard). Do not delete them as "dead references".
- `privacy-source.test.js` and `store-package.test.js` check that packages contain only what they should.

## 2. Smoke checks (real tools/network, no browser)

`scripts/smoke/`: `recovery-smoke.js` (local sockets + FFmpeg, no internet), `network-smoke.js`, `automatic-smoke.js`, `hls-smoke.js` (internet), `subtitle-scripts-check.js`, `vlc-subtitle-check.mjs` (needs VLC). See [scripts/README.md](../scripts/README.md).

## 3. Real browsers and the packaged app

Prepare once per machine (and again when the temp folder is cleaned): `npm run test:browsers:prepare`.

| After changing | Run |
|---|---|
| anything in `desktop/` or before a release | `npm run dist` then `node scripts/e2e/desktop-smoke.js` (19 OK lines expected) |
| page capture / panel | `node scripts/e2e/float-e2e.js`, `capture-e2e.js`, `overlay-real-browser.js` |
| link menu | `node scripts/e2e/link-e2e.js` |
| subtitles | `node scripts/e2e/subtitle-e2e.js` |
| extension settings / capture switch | `node scripts/e2e/switch-e2e.js` |
| list UI | `list-actions-check.js`, `list-browser-smoke.js`, `bulk-add-check.js`, `history-browser-smoke.js` |
| texts / languages | `ui-language-check.js`, `language-settings-check.js`, `language-packs-check.js` |
| design system / theme | `ds-check.js`, `appearance-browser-smoke.js`, `visual-matrix.js` |

Most accept `firefox` / `chrome` arguments; the default is both. Browsers run headless; `HD_HEADED=1` shows them. Keep the screen on and do not use the mouse during desktop or headed runs.

### Test hooks (environment variables)

| Variable | Used by |
|---|---|
| `HD_HEADED` | browser-driver: show the browser windows |
| `HD_DEBUG` | `subtitle-e2e.js`: extra logging |
| `HD_FLOAT_NOISE`, `HD_FLOAT_MEDIA` | `float-e2e.js` (and `subtitle-e2e.js` for media): noisy page / custom media |
| `HD_PAGE_URL` | `float-e2e.js`: also try a real page |
| `HD_LINK_URL` | `link-e2e.js`: also try a real link |
| `HD_PLAYLIST` | `playlist-browser-smoke.js` (required) |
| `HD_DESKTOP_TEST=1`, `HD_DESKTOP_PROFILE`, `HD_WINDOW_DROP_MS` | read by `desktop/main.cjs` only in test mode (set by `desktop-smoke.js`, `app-perf.js`): own profile folder, no real store page opened, shorter "destroy hidden window" delay |

`site-diagnose.js` takes the page as an argument: `node scripts/e2e/site-diagnose.js <url> [firefox|chrome]`.
| `HYPERNAB_LOCALE` | force a Windows locale (language tests) |

## Known quirks

- `list-actions-check.js` prints the word "failed" inside some OK lines; exit code 0 means pass.
- Headless Chrome 157+: the extension's first-install options tab takes the front; the driver calls `front()`. Viewport emulation makes full-screen requests answer "not granted", so the driver sets a real window size.
- `float-e2e.js` on Firefox has shown a rare "Browser wait timeout" at the very end; a rerun passes.
- Two real-browser checks must not share one engine: every script starts its own on a free port.
- If the privacy check flags a fake Windows path in a test, use a neutral one such as `D:\LocalData`.
