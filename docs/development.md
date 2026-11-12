# Development

## Setup (once)

1. Windows 10/11 x64, Node.js 22.13+ (the installer bundles the Node you build with), Git.
2. `npm install`
3. Media tools into `tools/` (not in git): `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup\install-ytdlp.ps1` and `...\install-ffmpeg.ps1`, then `npm run verify-tools`.
4. For real-browser tests: `npm run test:browsers:prepare` (downloads Chrome for Testing, Firefox and geckodriver into `%LOCALAPPDATA%\Temp\opencode\hypernab-browser-tools`; run it again if that temp folder was cleaned).
5. Privacy terms: the privacy check refuses to run without a local `.privacy-terms` file in the repository root (git-ignored, never published). One case-insensitive regular expression per line, `#` for comments: real names, personal e-mail ids, private site names. Keep the terms of every previous maintainer in it as well, so their names can never slip into a release. Then `node scripts/release/privacy-check.js --install-hook` installs the git pre-push gate. The check also flags the current Windows user name automatically.

## Running

| Command | What runs |
|---|---|
| `npm start` | Engine only; open `http://127.0.0.1:17846` in a browser. Data in `./data`, downloads in `./downloads`. |
| `npm run desktop` | Electron shell on the source tree (same `./data`). |
| `npm run build:extensions` | `build/extensions/{chromium,firefox}`. Load unpacked: Chromium → extensions page, Developer mode, *Load unpacked*; Firefox → `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`. |
| `npm run install:native` | Lets the dev extension reach the dev engine (registers the native host for the current user). `npm run uninstall:native` removes it. |
| `npm run dist` | Installer in `dist/`. |

Do not run development builds against the installed app's data: the dev engine uses `./data` unless `HYPERNAB_DATA_DIR` says otherwise, and every test script uses its own temp folders and port.

## Where to change what

| Change | Files | Also update |
|---|---|---|
| A user-facing text | `public/strings.js` (en + tr), `public/lang/*.js` | extension texts: `extension/lang/*.js`; run `scripts/e2e/ui-language-check.js` |
| A setting | `src/downloads.js` (defaults, validation), `public/advanced.js` / `index.html` (UI) | `test/settings*.test.js`; "Reset to defaults" reads the engine's `defaults` |
| A new API route | `src/server.js` | if the extension uses it: `src/native-protocol.js` (allowed commands) |
| Download behaviour | `src/downloads.js`, `transfer.js`, `hls-download.js`, `recovery.js` | `test/` has one file per area; run `scripts/smoke/recovery-smoke.js` |
| Page capture | `extension/content.js`, `float.js`, `background.js` | `scripts/e2e/float-e2e.js`, `capture-e2e.js`, `overlay-real-browser.js` |
| Look of a control | `public/ds.css`, `ds.js` | `docs/design-system.md`, `scripts/e2e/ds-check.js` |
| Tray / window / updater | `desktop/*.cjs` | `scripts/e2e/desktop-smoke.js` after `npm run dist` |

## Conventions

- Code comments and docs in English; user texts only through `strings.js` keys.
- ES modules in `src/`, `public/`, `scripts/`; CommonJS (`.cjs`) in `desktop/` (Electron main).
- No new runtime dependency without a strong reason (the only one is `electron-updater`).
- Comments explain *why*; match the density of the surrounding code.

## Shell notes (Windows PowerShell)

- Use `npm.cmd` in scripts launched from PowerShell 5 if `npm` is blocked by the execution policy.
- Native tools write warnings to stderr, which PowerShell shows as red error records even when the exit code is 0; redirect to a file and read it, or check `$LASTEXITCODE`.
- Write commit message files without a BOM: `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))`.
