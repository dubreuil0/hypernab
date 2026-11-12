# Hypernab: guide for agents and new maintainers

Read this first. It says what the project is, where everything lives and which rules are not negotiable. Details are one link away in [`docs/`](docs/README.md).

## What it is

Hypernab is a local download manager for Windows 10/11 (x64) with a browser extension that captures videos and links.

- **App:** an Electron shell (`desktop/`) starts a Node engine (`src/server.js`). The engine is an HTTP server on `127.0.0.1:17846` that serves the window UI (`public/`) and the API. yt-dlp, FFmpeg and ffprobe ship with the installer.
- **Extension:** one source (`extension/`), built for Chromium (MV3 service worker) and Firefox (event page). It talks to the app through native messaging.
- **Published:** app installers on GitHub Releases (`dubreuil0/hypernab`, auto-update through `electron-updater`). Extension on the Chrome Web Store (id `decnigdaajpbapbcaieefjnjapeombpb`) and Firefox Add-ons (slug `hypernab-video-catcher`).
- **Versions:** app `package.json` `version`; extension `extension/manifest.json` `version`. The two are versioned separately; the README line `app X · extension Y` shows both.
- **UI languages:** 8 (en, tr, es, de, fr, ru, pt, ar; ar is right-to-left). No translation has been reviewed by a native speaker yet.

## Map of the repository

```
AGENTS.md            this guide (CLAUDE.md points here)
README.md / .tr.md   user-facing description, install, privacy summary (English / Turkish)
PRIVACY.md / .tr.md  privacy policy (linked from the stores)
THIRD_PARTY_NOTICES.md
package.json         npm scripts, electron-builder config ("build"), app version
docs/                developer documentation; start at docs/README.md
src/                 the engine (Node, ES modules, no framework); entry: server.js
public/              the app window and tray panel (plain HTML/CSS/JS, served by the engine)
  strings.js         EVERY user-facing text, English + Turkish inline
  lang/<code>.js     the other 6 UI languages (loaded only when used)
  ds.css, ds.js      shared design-system parts (also used by the extension)
desktop/             Electron main process: window, tray, tray panel, updater, browser detection
extension/           browser extension source (manifest, background, content script, panel, options page)
  lang/<code>.js     extension-only texts for the 6 extra languages
  _locales/          store name/description per language
scripts/             everything you run by hand; see scripts/README.md
  release/           build extensions, store zips, installer staging, privacy check
  setup/             native-messaging install, media tools, test-browser download
  e2e/               real-browser and packaged-app end-to-end checks (+ browser-driver.js)
  smoke/             engine checks with real network/FFmpeg, no browser
  perf/              memory/CPU measurements
  test-support/      harness shared by unit tests
test/                unit tests (node:test), one file per area: *.test.js
tools/               yt-dlp.exe, ffmpeg.exe, ffprobe.exe (not in git; see tools/README.md)
```

Generated or local only (all in `.gitignore`): `node_modules/`, `build/` (extension builds, installer staging), `dist/` (installers and store zips), `data/` and `downloads/` (dev data), `.privacy-terms`, `handover/`.

## Where to find what

| Question | Look in |
|---|---|
| How the parts talk to each other, data files, ports, native messaging | [docs/architecture.md](docs/architecture.md) |
| Setting up, running, every npm script and hand-run script | [docs/development.md](docs/development.md), [scripts/README.md](scripts/README.md) |
| Which test proves what, how to run real-browser tests, known flaky checks | [docs/testing.md](docs/testing.md) |
| Releasing the app, uploading the extension, privacy checks | [docs/release.md](docs/release.md) |
| Why things are the way they are, rejected ideas, open work | [docs/decisions.md](docs/decisions.md) |
| UI parts and visual rules | [docs/design-system.md](docs/design-system.md) |
| Store texts, permission justifications, reviewer notes | [docs/store-listing.md](docs/store-listing.md) |
| History of the work (old plans and notes, Turkish) | `handover/` if this copy of the folder has it (local only, never committed) |

## Rules

These were decided by the owner and enforced by tests or review. Do not relax them without the owner.

1. **Privacy first.** No real name, personal e-mail, Windows user name or path (`C:\Users\<name>`), IP address, screenshot or photo goes into the repository, a release note, a store text or a package. Commits use the GitHub no-reply identity. Run `node scripts/release/privacy-check.js --repo` before every push; the pre-push hook can be installed with `--install-hook`. Images, video, audio and archives are refused except the app icons (`.gitignore` and the privacy check both enforce it).
2. **Commit only what you changed.** Never `git add -A` / `git add .`; add files by name and read `git status --short` first. Test output (downloaded chunks, screenshots, reports) never stays in the repository root.
3. **Texts:** never write user-facing text in code. Add a key to `public/strings.js` (en + tr) and the same key to every `public/lang/<code>.js` (and `extension/lang/<code>.js` for extension texts). `scripts/e2e/ui-language-check.js` and the unit tests check coverage. Before deleting a key, run that check (some keys are built dynamically).
4. **UI:** use the design-system parts (`public/ds.css`, `ds.js`), never raw browser controls. Every `button.btn` has an SVG icon (the desktop smoke test checks it). Keep it light for weak PCs: no blur, big shadows or endless animation.
5. **No per-site code.** Capture and resolving work by content and standards (HLS, DASH, MIME types), never by host name. No DRM bypass. Cookies are read only after an explicit user action (the page button or the link menu), only for that address, kept in memory, never written to history, logs or reports.
6. **Never lose a user's file.** Pausing keeps everything; cancelling deletes only the half-written files of that download; finished files are never touched by list actions.
7. **Version bump:** change `package.json`, only the two root `version` lines of `package-lock.json` (never dependency versions) and the README version lines. The extension version is only in `extension/manifest.json`.
8. **Releases need the owner's approval** and go through the checklist in [docs/release.md](docs/release.md).
9. **No competitor product names** in the repository, notes or store texts.
10. **Lightweight without losing speed.** A memory or CPU saving that slows downloads or makes the UI stutter is not accepted; measure with `scripts/perf/`.

## Working style the owner expects

- Plan larger changes first and get approval; small fixes can go straight in.
- Verify before you claim (run the test, read the output, check the published state).
- A bug found along the way is fixed first, then the planned work continues.
- Talk to the owner in Turkish, short and plain.
- Long work is tracked in a plan that is updated after every step, so a new session can continue where the last one stopped.

## Quick start

```powershell
npm install
npm test                         # ~590 unit tests, about a minute
npm run check                    # syntax check of the main files
npm start                        # engine + UI in the browser at http://127.0.0.1:17846 (dev data in ./data)
npm run desktop                  # the Electron app against the source tree
npm run dist                     # installer in dist/ (needs tools/*.exe)
node scripts/e2e/desktop-smoke.js  # end-to-end check of the built app
```

Node.js 22.13 or newer. Windows only (the native-messaging launcher is compiled with the .NET Framework `csc.exe` that ships with Windows).
