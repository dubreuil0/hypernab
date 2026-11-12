# scripts/

Everything here is run by hand (or by an npm script). Unit tests live in `test/` and run with `npm test`; nothing in this folder runs during `npm test` except `test-support/`.

Every check that starts a server or a browser uses its own port, temporary data/download folders and a throw-away browser profile. None of them touches an installed Hypernab or a personal browser profile.

## release/ — building and shipping

| Script | What it does |
|---|---|
| `build-extensions.js` | Builds `build/extensions/{chromium,firefox}` from `extension/` plus the shared `public/ds.css`, `ds.js`, `strings.js` and language packs. `npm run build:extensions` |
| `package-extensions.js` | Store zips `dist/store/hypernab-{chrome,firefox}-<version>.zip` (Chrome zip without the dev key). `npm run package:extensions` |
| `zip-store.js` | Zip helper used by the two above and by the e2e checks (Firefox needs a zip to load a temporary add-on). |
| `prepare-desktop.js` | Stages `build/engine` (src, public, native installer) and `build/runtime/node.exe` for electron-builder. Run by `npm run dist`. |
| `desktop-icon.js` | Draws the app icon set from geometry (`desktop/icon*`). Imported by `prepare-desktop.js`. |
| `privacy-check.js` | Release gate: personal data, private terms (`.privacy-terms`) and media files. `--repo --package --history --text "<notes>"`, `--install-hook` adds a git pre-push hook. |

## setup/ — one-time machine setup

| Script | What it does |
|---|---|
| `install-native.js` | Registers the native-messaging host for Firefox/Chrome/Edge/Brave (HKCU) and compiles the small launcher exe. The packaged app runs the same file itself. `npm run install:native` / `uninstall:native` |
| `install-ytdlp.ps1`, `install-ffmpeg.ps1` | Download yt-dlp / FFmpeg+ffprobe into `tools/` with hash checks. |
| `verify-tools.js` | Checks that the tools in `tools/` run. `npm run verify-tools` |
| `prepare-browser-tests.js` | Downloads the isolated test browsers (Chrome for Testing, Firefox + geckodriver) into `%LOCALAPPDATA%\Temp\opencode\hypernab-browser-tools`. Needed before any `e2e/` script; run again when that folder was cleaned. `npm run test:browsers:prepare` |

## e2e/ — real browsers, real extension, packaged app

`browser-driver.js` is the shared driver (Chrome DevTools Protocol for Chromium, geckodriver for Firefox). Most scripts take `firefox` and/or `chrome` as arguments; without arguments they run both.

| Script | Checks |
|---|---|
| `desktop-smoke.js` | The built app in `dist/win-unpacked`: start, tray, window, engine, native messaging, every `button.btn` has an icon. Run after every `npm run dist`. |
| `float-e2e.js` | The on-page download panel against a real app (quality list, sound choice, "add for later", bridge idle close/reopen). `HD_FLOAT_NOISE=1` adds a noisy page. |
| `capture-e2e.js` | Capture inside embedded player frames, panel closing. |
| `link-e2e.js` | "Download with Hypernab" on a link (real context-menu click). |
| `subtitle-e2e.js` | Three generic ways a page shows subtitles; they end up in the file. |
| `switch-e2e.js` | Capture on/off from the toolbar icon and the extension's settings page. |
| `overlay-real-browser.js` | The on-page button appears/hides correctly (also full screen). |
| `site-diagnose.js` | Look-only: what the extension and the app see on a given real page URL. For bug reports. |
| `bulk-add-check.js` | "Add several links" dialog. |
| `list-actions-check.js` | The list's action bar, selection, cancel confirmation, undo. Prints "failed" inside OK lines; exit code 0 means pass. |
| `list-browser-smoke.js`, `history-browser-smoke.js`, `appearance-browser-smoke.js` | List layout, history view, themes in the web UI. |
| `playlist-browser-smoke.js` | Playlist flow with the real yt-dlp (internet; needs `HD_PLAYLIST=<url>`). |
| `ui-language-check.js`, `language-settings-check.js`, `language-packs-check.js` | Interface language selection and that every language pack covers every key. |
| `ds-check.js`, `panel-visual.js`, `visual-matrix.js` | Design-system controls and screenshots in every theme/accent/size/RTL (screenshots go to a temp folder, never the repo). |

## smoke/ — engine with real network or real FFmpeg, no browser

| Script | Checks |
|---|---|
| `network-smoke.js` | One real download over the network. `npm run smoke` |
| `automatic-smoke.js` | Real-network acceptance of the automatic flow. `npm run smoke:auto` |
| `recovery-smoke.js` | Drops, resets and resume over real local sockets + FFmpeg. `npm run smoke:recovery` |
| `hls-smoke.js` | One segment per track of a public HLS sample. |
| `subtitle-scripts-check.js` | Subtitles in many alphabets and legacy code pages through the whole path with the real tools. |
| `vlc-subtitle-check.mjs` | Lets an installed VLC open a built file and reports which subtitle it shows. |
| `protection-check.js` | Runs the adversarial "protection" unit tests and proves no source file changed during the run. See `docs/protection-tests.md`. |

## perf/ — measurements

| Script | Measures |
|---|---|
| `app-perf.js` | Memory/CPU of the whole app process tree: tray idle, window, 200-row list, scrolling, downloading. |
| `extension-cost.js` | What the extension (and its native bridge) costs the browser, idle and under many requests. |
| `extension-perf.js` | Content-script cost on heavy, constantly changing pages. |
| `benchmark.js` | Time to resolve one URL with yt-dlp. `npm run benchmark -- <url>` |

## test-support/

`extension-harness.js` loads the unmodified extension scripts in a fresh VM with fake browser/app APIs; used by `test/protection-*.test.js`.
