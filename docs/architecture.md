# Architecture

## The pieces

```
 Browser                                   Windows (the user's PC)
 ┌──────────────────────────┐              ┌──────────────────────────────────────────────┐
 │ extension/               │  native      │ HypernabNative-<hash>.exe  (launcher,        │
 │  content.js  (page)      │  messaging   │   compiled from src/windows-native-launcher.cs)│
 │  background: core.js,    │ ───────────► │        │ stdio                               │
 │  float.js, native.js,    │ com.hypernab │        ▼                                     │
 │  control.js,             │ .app         │ node src/native-host.js  ──HTTP + token──┐   │
 │  link-download.js        │              │                                          ▼   │
 │  options.html            │              │ desktop/main.cjs (Electron) ─spawns─► node src/server.js
 └──────────────────────────┘              │   window, tray, tray panel, updater   127.0.0.1:17846
                                           │                                      ├─ serves public/ (UI)
                                           │                                      ├─ /api/* (JSON)
                                           │                                      └─ runs tools/yt-dlp, ffmpeg, ffprobe
                                           └──────────────────────────────────────────────┘
```

### Engine (`src/`)

`server.js` is a plain `node:http` server bound to `127.0.0.1` (port `HYPERNAB_PORT`, default 17846). It serves `public/` and a JSON API under `/api/*`. Every API call needs `Authorization: Bearer <pairing token>`; the token is random, stored in `<data>/pairing-token`, and the UI gets it from `/api/bootstrap` (same origin only). Requests with an `Origin` other than the engine itself or a `chrome-extension://` / `moz-extension://` origin are refused.

Main modules:

| Area | Files |
|---|---|
| Download list, scheduling, states, settings | `downloads.js` (the `DownloadQueue`, biggest file), `job-progress.js`, `automation.js` (scheduled resume) |
| Plain files (non-video) | `file-download.js`, `transfer.js` (segmented ranges), `connection-budget.js`, `rate-limit.js`, `verification.js` |
| Video sources | `media.js` (yt-dlp), `source-plan.js`, `quality.js`, `hls.js` + `hls-download.js` + `hls-size.js` (own HLS reader), `playlist.js`, `playlist-probe.js`, `sniffer.js` (throw-away browser for pages yt-dlp cannot resolve) |
| Recovery | `recovery.js`, `network.js` (stall detection, retries), `process.js` (kills whole tool process trees) |
| Subtitles and languages | `subtitles.js`, `text-decode.js`, `language-detect.js`, `language.js` |
| Browser bridge | `native-host.js`, `native-protocol.js`, `session.js` (cookies of one chosen video, memory only), `submissions.js` |
| Safety | `security.js` (URL/host checks, no private-network targets), `file-layout.js` (safe Windows names) |
| History | `history.js` (SQLite through `node:sqlite`, searched off the main thread) |
| Texts | `messages.js` reads keys from `public/strings.js` |

### App window (`public/`)

Plain ES modules and classic scripts, no framework, no build step. `index.html` + `app.js` is the main window; `tray.html` + `tray.js` is the small tray panel. Texts come from `strings.js` (en + tr) and `lang/<code>.js` (loaded only for the chosen language, `lang-load.js`, `ui-language.js`). Shared look: `ds.css`/`ds.js` (design system, see `design-system.md`), `theme.css`, `rtl.css` (Arabic only). `appearance.js` runs before first paint so the theme never flashes. The list renders rows by key (`rowKey`/`buildRow` in `app.js`): only rows whose data changed are rebuilt.

### Desktop shell (`desktop/`)

`main.cjs` is the Electron main process. It starts the engine with the bundled Node (`resources/runtime/node.exe` when packaged), points it at the data and download folders, and loads `http://127.0.0.1:<port>` in a window. The window is built only when it is shown and destroyed a minute after it is closed to the tray (memory). Other files: `tray-panel.cjs` (tray quick panel), `updater.cjs` (electron-updater; never downloads or installs without a click, never during a transfer), `browsers.cjs` (which browsers are installed, open the right store page), `clipboard-links.cjs` (optional, off by default), `job-location.cjs`, `texts.cjs` (reads `public/strings.js`).

### Extension (`extension/`)

Built by `scripts/release/build-extensions.js` into `build/extensions/chromium` and `build/extensions/firefox` (shared `ds.css`, `ds.js`, `strings.js` and language packs are copied in).

| File | Role |
|---|---|
| `manifest.json` | Source manifest; the build script writes the Chromium (service worker) and Firefox (event page, gecko id) variants. Permissions: `webRequest`, `storage`, `nativeMessaging`, `cookies`, `contextMenus`. |
| `core.js` | Shared background logic and the native-messaging client (`Client.request` reopens a closed channel). |
| `native.js` | The native port; closes itself after 60 s without pending requests (`IDLE_MS`). |
| `background.js` | Watches media requests (URLs and metadata only, session storage). |
| `float.js` | Backend of the on-page download panel: inspects the tab, asks the app for qualities, runs a page resolver in parallel when a candidate is slow (`PAGE_HEDGE_MS`). |
| `content.js` | Runs in the page's isolated world: finds videos incrementally (MutationObserver + shadow roots), draws the download button and panel, hides in full screen. |
| `control.js` | Toolbar icon = capture on/off, right-click menu (kept in English on purpose). |
| `link-download.js` | "Download with Hypernab" on a link. |
| `options.html/.js/.css` | Settings and diagnostics page. |
| `chromium-key.json` | Public key that pins the Chromium extension id (not a secret). |

Cookies are read only in `float.js`/`link-download.js` after the user's click, for that one address, and handed to the app; never stored.

### Native messaging

`scripts/setup/install-native.js` (also run by the packaged app at start) writes host manifests under `%LOCALAPPDATA%\Hypernab\NativeMessaging`, registers them in `HKCU` for Firefox, Chrome, Chrome for Testing, Edge and Brave, and compiles `src/windows-native-launcher.cs` with the .NET Framework `csc.exe` into `HypernabNative-<hash>.exe` (a new launcher version gets a new file name because the browser keeps the old exe open). The launcher starts `node src/native-host.js`, which forwards requests to the engine over HTTP with the pairing token, and can start the app (`--launch-server`, `--show-app`) when it is not running.

## Data on disk

| Where | What |
|---|---|
| `%APPDATA%\Hypernab\data` (packaged) or `./data` (dev, `HYPERNAB_DATA_DIR`) | `queue.json` (jobs; never cookies or request headers), `queue.json.settings.json`, `queue.json.history.sqlite`, `automation.json`, `pairing-token`, `window-state.json`, yt-dlp cache |
| `%USERPROFILE%\Downloads\Hypernab` (packaged) or `./downloads` (dev, `HYPERNAB_DOWNLOAD_DIR`) | Downloaded files |
| Windows temp folder | Short-lived cookie file for one yt-dlp run (deleted at the end; leftovers swept at start) |

Environment variables read by the engine/shell: `HYPERNAB_PORT`, `HYPERNAB_DATA_DIR`, `HYPERNAB_DOWNLOAD_DIR`, `HYPERNAB_LOCALE` (force a Windows locale, used by tests), `HYPERNAB_NODE` (dev: which node.exe the shell starts). Test-only hooks start with `HD_` (see `testing.md`).

## Packaging

`npm run dist` runs `scripts/release/prepare-desktop.js` (copies `src/`, `public/`, the native installer, manifest, README and notices into `build/engine`, the running `node.exe` into `build/runtime`, the tools into `build/engine/tools`, and builds the extensions), then electron-builder makes `dist/Hypernab-Setup-<version>.exe` (NSIS, per-user, not code-signed). The `build` section of `package.json` holds the electron-builder config, including the GitHub publish target used by the updater.
