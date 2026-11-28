# Decisions, rejected ideas and open work

The owner made these calls, mostly after trying the alternative. Read this before "improving" one of them. Dates are 2026.

## Product decisions

| Decision | Why |
|---|---|
| **No automatic takeover of browser downloads** (removed in app 0.16.0 / extension 0.11.0). Files come only from the link menu "Download with Hypernab", the on-page video button or pasted links. | Chromium cannot hold a download it hands over, so files got duplicated or half-written; it needed the `downloads` permission, which makes store review much harder. Tests guard that it stays removed. |
| **No extension popup.** Toolbar click = capture on/off (grey icon with a red slash when off); right-click menu; a settings page. | Fewer clicks, nothing to keep in sync. The toolbar tooltip and right-click menu stay in English on purpose (`extension/control.js`). |
| **No queue.** "Add for later" only means "do not start yet"; it shows as paused and Resume starts it (0.19.0). "Resume all" also starts the held ones. | Named queues and start/stop confused users. Old settings fields are read and ignored. |
| **One action bar for the list** (selection-aware Pause/Resume/Cancel/Remove). Cancelling several downloads always asks, says how many and how much half-written data goes; never "don't ask again". Remove from list asks nothing and can be undone. | Never lose a file by accident; never nag for harmless actions. |
| **An expired captured address is renewed from its page** (0.20.2). A direct download refused with 401/403/410 reads the page it was captured on again with yt-dlp and the saved browser identity (at most 2 pages at a time), picks the address whose size and validator match the half-written file and goes on from it; otherwise the best working address from the start (earlier bytes are set aside, never deleted). "Retry failed" in the action bar retries every failed download; the bar drops button names to icons instead of wrapping. | Many videos captured at once outlived their signed addresses, failed with HTTP 403 and could only be found again by hand. Works by content and standards, no site names. |
| **Look-ups never wait behind downloads; connections are shared fairly** (0.20.3).<br>• `ConnectionBudget` has a separate 2-slot reserve for interactive look-ups (extension inspect, sniff, link-menu probe, active audio). These read headers and close.<br>• Download requests carry their job as owner, and a freed slot goes to the owner holding the fewest.<br>• While another download is waiting for a connection, a download adds connections only while its own total throughput still rises by about 10% per step. Otherwise it drops back and holds there for 60 s.<br>• With nobody waiting, the per-block window behaves exactly as before. A test checks this step by step. | Measured with 4 downloads from a site that caps each file at ~1 MB/s:<br>• The budget sat at 12/12 with 9–12 requests queued, so the extension panel waited 10–15 s.<br>• Two of the four downloads held 0 connections.<br>• One file gave the same speed with 4, 8 or 16 connections.<br>The rule must never slow a download that is not competing (AGENTS rule 10). |
| **Same size, other ETag: compare content instead of restarting** (0.20.5). On resume, a checkpoint whose only difference is the ETag (same total, block size, source key, overlap) is kept after a mandatory sample of at least 24 completed blocks, 1 KiB at both ends, without `If-Range`. Mid-download, a range with another ETag and the same total is accepted only if its overlap prefix matches the disk (or a 64-byte anchor fetched on the look-up lane); `If-Range` → 200 is re-requested without it. One differing byte keeps the old behaviour (`.previous`, restart, or `SourceChangedError`); assembly overlap checks and media verification are unchanged. `.previous` files are never deleted automatically. | Sites serve one file from many CDN nodes, and nginx ETags are `hex(mtime)-hex(size)`, so identical content gets different ETags. On a real list all 15 "source changed" failures were this, and 43 jobs had restarted from zero up to 8 times (10.8 GB of `.previous`). Real check on copies: both resumed (8.4 MB kept), completed and passed verification. |
| **Waiting for our own connection slot never counts as server silence** (0.20.5). `Deadline` (src/deadline.js) is a pausable limit; `ConnectionBudget.acquire` pauses every limit behind its signal while a normal-lane request waits. Covers `recoverRead`, the probe's 10 s/25 s and the HLS list's 6 s. | With queue limit "all", Resume all started ~230 jobs on one host (8 per-host slots); probes waiting in our queue hit the 10 s/25 s limits and 123 jobs failed with 0 bytes in 5 minutes. Real check, 30 copies at once: 0.20.4 lost 17, 0.20.5 none (all moving, ~5 MB/s). |
| **The shared connection total grows with running downloads** (0.20.4): `clamp(4 × running, 12, 24)`, i.e. 12 for 1–3 downloads (unchanged), 16, 20, 24. Per-host 8 and the look-up reserve stay. | With 6 downloads from a site that caps each file, the 12 connections were all in use and requests waited while the line had several MB/s spare. Interleaved measurement (0.20.3, new, new, 0.20.3; 3 min each, copies of real jobs): 2697 / 4378 / 4235 / 2675 KB/s, i.e. about +60%. |
| **Updates can be checked from Settings and the start check can be turned off** (0.20.3). Settings → Desktop → Updates: "Check at start" (default on; off = no contact with GitHub at start) and "Check now" with the result inline. A newer version still asks before downloading, and the download runs in the background. | The check existed only in the tray menu and always ran a minute after start. |
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
