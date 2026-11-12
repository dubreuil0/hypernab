# Releasing

Nothing is published without the owner's approval. Show the verification results first, then publish.

## App (GitHub Release + auto-update)

1. Stop any Hypernab started from `dist\` (installed copies are not touched).
2. Bump the version: `package.json`, the **two root** `"version"` lines at the top of `package-lock.json` (never a dependency's version), and the version line in `README.md` / `README.tr.md` (`app X · extension Y`).
3. Verify:
   ```powershell
   npm test
   npm run check
   node scripts/release/build-extensions.js
   npm run dist                          # dist\Hypernab-Setup-<v>.exe, .blockmap, latest.yml
   node scripts/e2e/desktop-smoke.js     # all OK
   ```
   Plus the real-browser checks that match the change (see `testing.md`).
4. Privacy gate (stops on any finding; matched text is never printed):
   ```powershell
   node scripts/release/privacy-check.js --repo --package --history --text "<release notes>"
   ```
   `--package` unpacks the installer's `app.asar` and scans the engine folder; `--history` scans every commit.
5. Commit only the changed files (by name), push, and **check that `origin/main` equals `HEAD`** (a failed push would make the tag point at an old commit).
6. Publish with the notes in a file (English section, then Turkish):
   ```powershell
   gh release create v<v> dist\Hypernab-Setup-<v>.exe dist\Hypernab-Setup-<v>.exe.blockmap dist\latest.yml --target <sha> --title "Hypernab <v>" --notes-file notes.md
   ```
   The extension zip is not attached (the extension comes from the stores).
7. Verify: the tag points at the pushed commit, the three asset sizes equal the local files, the release is not a draft and is `latest`. Installed apps see the update through `latest.yml`.

Release notes describe what the user notices, measured numbers where there are some, and say that translations are not reviewed by native speakers. No personal data, no competitor names.

## Extension (Chrome Web Store + Firefox Add-ons)

The extension version lives only in `extension/manifest.json`. An app release is not needed when only the extension changes, and vice versa.

1. Bump `extension/manifest.json` `version` and the README version line.
2. `npm test`, the real-browser checks for the extension (`float-e2e`, `capture-e2e`, `link-e2e`, `switch-e2e`, `overlay-real-browser`).
3. `npm run package:extensions` → `dist/store/hypernab-chrome-<v>.zip`, `hypernab-firefox-<v>.zip`. Check the permissions in both manifests did not change (now: `webRequest`, `storage`, `nativeMessaging`, `cookies`, `contextMenus`); a new permission means a longer review and a store-text update.
4. Firefox needs the source code: `git archive --format=zip -o dist/store/hypernab-source-<v>.zip HEAD docs extension package.json package-lock.json PRIVACY.md public README.md scripts` (commit first so the archive matches the package).
5. The owner uploads: Chrome Developer Dashboard → the item → Package → upload → Submit for review. AMO Developer Hub → Upload new version → answer "Yes" to source code and attach the source zip → version notes (short, user-facing, English).
6. After approval, verify the live versions:
   - Firefox: `https://addons.mozilla.org/api/v5/addons/addon/hypernab-video-catcher/` → `current_version.version`
   - Chrome: `https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx2,crx3&prodversion=150.0&x=id%3Ddecnigdaajpbapbcaieefjnjapeombpb%26uc` → `<updatecheck ... version="...">`

Store texts, permission justifications and reviewer notes: [store-listing.md](store-listing.md). Store accounts belong to the owner; the public contact is the project e-mail shown on the store pages, never a personal address.

## Code signing

The installer is not code-signed (Windows shows "unknown publisher"; updates are still verified by SHA-512). Signing needs a certificate bought by the owner; when it exists, enable signing in the `build.win` config and make the updater require a valid signature.
