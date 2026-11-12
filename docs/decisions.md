# Decisions, rejected ideas and open work

The owner made these calls, mostly after trying the alternative. Read this before "improving" one of them. Dates are 2026.

## Product decisions

| Decision | Why |
|---|---|
| **No automatic takeover of browser downloads** (removed in app 0.16.0 / extension 0.11.0). Files come only from the link menu "Download with Hypernab", the on-page video button or pasted links. | Chromium cannot hold a download it hands over, so files got duplicated or half-written; it needed the `downloads` permission, which makes store review much harder. Tests guard that it stays removed. |
| **No extension popup.** Toolbar click = capture on/off (grey icon with a red slash when off); right-click menu; a settings page. | Fewer clicks, nothing to keep in sync. The toolbar tooltip and right-click menu stay in English on purpose (`extension/control.js`). |
| **No queue.** "Add for later" only means "do not start yet"; it shows as paused and Resume starts it (0.19.0). "Resume all" also starts the held ones. | Named queues and start/stop confused users. Old settings fields are read and ignored. |
| **One action bar for the list** (selection-aware Pause/Resume/Cancel/Remove). Cancelling several downloads always asks, says how many and how much half-written data goes; never "don't ask again". Remove from list asks nothing and can be undone. | Never lose a file by accident; never nag for harmless actions. |
| **Cancel deletes the half-written files; pause touches nothing** and resumes where it stopped (also for yt-dlp downloads after closing the app). | Clear meaning for each button. |
| **Subtitles are embedded by default** (no extra file); side `.srt` is optional; "save as mkv" is optional. No burning subtitles into the picture. | VLC does not switch on an embedded mp4 subtitle by itself but does in mkv; the user chooses. |
| **Subtitle language "automatic" = the app's interface language**, not the Windows language. The sound language is a separate setting and does not follow the subtitle language. | Users watch dubbed or original sound independently of subtitles. |
| **The extension is only installed from the stores.** The app shows a one-time "get the extension" window on a new install and a compact row at the top of Settings. No manual/unpacked install path for users, no per-browser names (only "Chromium-based" and "Firefox"). | Browsers never let an app add an extension silently; one clear path. |
| **Stores: Chrome Web Store and Firefox Add-ons only.** Edge, Brave, Opera install from the Chrome Web Store. | Fewer accounts and reviews. |
| **8 interface languages** (en, tr, es, de, fr, ru, pt, ar). No CJK/Hebrew/Greek UI for now. Subtitle language detection covers 30+ languages. | Enough reach; translations are machine-quality until reviewed. |
| **Compact layout by default, light UI** (no blur, big shadows, endless animation). | Smooth on weak PCs. |
| **The main window is built only when shown and destroyed a minute after closing to the tray**; the engine uses 2 libuv threads; the list rebuilds only changed rows; the extension's native bridge closes after a quiet minute. | Measured: tray idle 226 → 138 MB, 200-row list 364 → 284 MB and CPU ~8% → 3%, extension idle cost +60–115 MB → ~9 MB, download speed unchanged. |
| **Hardware acceleration stays on.** `app.disableHardwareAcceleration()` was tried and reverted. | With it, the main process sometimes froze 15 s+ after the tray panel opened and the tray icon was double-clicked (desktop smoke failed ~25–50% of runs). Not worth ~50 MB. The cause was not investigated further. |

## Rejected ideas (do not reopen without the owner)

- Automatic file capture in any form (see above); polishing the link-menu feedback; following "interstitial" download pages.
- Locking the local server to our extension ids only (another store may issue a different id).
- An installer wizard for the extension (replaced by the one-time window), a release script that publishes by itself.
- Edge Add-ons / Opera Add-ons listings.
- Per-site rules, DRM circumvention, reading cookies without a user action.
- Rewriting git history to purge an accidentally committed test video (the content was a generated colour-bar test pattern; a force push would break 23 release tags).

## Known limits

- A server without HTTP range support cannot resume.
- Windows Media Player does not show subtitles embedded in mp4 (VLC and most players do; side `.srt` or mkv helps).
- Installers and updates are not code-signed (SHA-512 verified).
- Translations were not reviewed by native speakers.
- Subtitles drawn only as a page overlay cannot be captured.

## Open work (as of 13 November 2026)

- Extension 0.12.2 is live on both stores (checked 13 November 2026 with the URLs in `release.md`).
- The Firefox Add-ons description still says "English and Turkish" (checked 13 November 2026); it should list the 8 languages.
- Code signing (needs the owner's certificate).
- Real-world check of non-Latin content: subtitle detection (30+ languages) and legacy code pages are covered by tests and `scripts/smoke/subtitle-scripts-check.js`, but not yet tried on real foreign-language sites and players.
- Optional: find the cause of the freeze with hardware acceleration off (see above).
