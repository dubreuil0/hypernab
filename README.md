# Hypernab

[Türkçe](README.tr.md)

A local download manager for Windows, with a media-capture extension for Firefox, Chrome, Edge, Brave and Opera. Your downloads stay on your computer; there is no account, cloud or tracking.

**Version:** app 0.16.4 · extension 0.11.1 · Windows 10/11 (x64)

## Features

- **Fast downloads:** segmented download with an adaptive number of connections, resume from where it stopped, and a speed limit (applied to a running download at once).
- **Any file, on request:** right-click a link in the browser and choose **Download with Hypernab**, or paste links into the app (**Add several links**, or the optional clipboard offer). The file is saved under its real name, accelerated in segments, its size and structure (zip, pdf, program, image...) are verified, and Windows' “downloaded from the internet” mark is added. Hypernab never takes over the browser's own downloads behind your back.
- **Capture from the browser:** the extension detects the video you play and shows a “Download with Hypernab” button on the page. You choose from the quality list; it never silently falls back to a quality you did not choose. When a site has several sounds (e.g. dubbed and original) you pick the **Sound** in the panel; the sound playing in the player is preselected. When the page changes, **Refresh** scans the video again.
- **Queue:** named queues, scheduling, drag-and-drop ordering, a global concurrency limit, “Add for later”.
- **Automatic recovery:** limited, cancellable retries after temporary server errors, drops and missing data; only the damaged part is downloaded again. For HLS downloads, pausing, restarting and retrying keep the finished segments; only the missing ones are downloaded. Downloads made by the media engine (yt-dlp) also carry on from their half-written files after a pause, a lost connection or closing the app, as long as the source is the same; a changed source starts afresh so no wrong piece ends up in a file. Cancelling deletes the half-written files.
- **Streams:** HLS and separate picture/sound streams are merged with FFmpeg; the result is verified with ffprobe.
- **Subtitles (embedded by default, no extra file):** a subtitle captured from the player or the stream is put inside the video (choose it in the subtitle menu of VLC and most players). If you like, the default subtitle is also written next to it as a `.srt` with the same name, so VLC, Media Player and Films & TV show it by themselves. A subtitle file without a name is recognised by its words in 30 languages, and files in old code pages (Windows-125x, GBK, Shift_JIS, EUC-KR, Big5, UTF-16...) are read correctly. In Settings you can choose embed only (default), embed and side file, side file only or off.
- **Language:** the app and the extension come in English and Turkish. By default they follow the language of Windows (English when the app has no text in it); you can choose in Settings. The default subtitle language and the sound language are separate settings. A subtitle the page says it showed wins; if there is no track in the chosen language, none is marked. The sound does not follow the subtitle language: the sound playing in the player, otherwise your sound preference, otherwise the site's default is selected, and the panel says which.
- **Video format with subtitles:** VLC does not switch on a subtitle embedded in an mp4 by itself (it does load the side `.srt`). If you like, choose “Save as mkv” in Settings: the video is copied without loss into an mkv and VLC opens the default subtitle by itself. The default keeps the mp4.
- **Playlists:** see the list and add the episodes you want to the queue.
- **Several links at once:** the button next to the link box takes up to 100 links, one per line. A file is taken like a browser download (real name, size and structure checked); a page goes to the media engine at its best quality; links already in the list are skipped. Optionally (Settings > Desktop, off by default) the app offers to add links it finds in the clipboard when its window gets focus; the clipboard is only read while that is on, and nothing is stored or sent.
- **Smart naming and folders:** safe Windows file names in any alphabet, an optional folder layout; existing files are never overwritten. Everything goes into one download folder, like Windows; one switch in Settings sorts new downloads into Video, Music, Images, Documents, Archives, Programs and Other folders (files already downloaded are never moved).
- **History:** a searchable history that is kept even if you clear the queue. Clearing the queue does not delete files.
- **Tray quick panel:** total speed and the first jobs; pause/resume one or all.
- **Interface:** dark, light and system theme; four accent colours; small/normal/large text; compact or normal list. To stay smooth on weak hardware, no blur, big shadows or endless animation is used.

## Install

1. Download `Hypernab-Setup-<version>.exe` from the [Releases](../../releases) page and run it.
2. The installer is **not yet code-signed**; Windows may show an “unknown publisher” warning.
3. The installer brings Node.js, yt-dlp and FFmpeg with it; you do not need to install anything else.

### Downloading any file

Right-click a link on a page and choose **Download with Hypernab**. That is all: nothing is paused, held or watched in the browser, so it works the same in every browser. The cookies of that one address are read only at that click, only for that address, are sent only to the app on your computer and are never saved. The result shows on the toolbar icon for a moment (“OK”, or “!” with the reason in the tooltip); if the app is closed it is started, like the video button does. The item is hidden while capture is off.

The extension asks for no `downloads` permission. A link to a web page (instead of a file) is refused with a clear reason.

### Extension

The extension is built from source: `npm run build:extensions` produces the Firefox and Chromium packages under `build/extensions`.

- **Chrome, Edge, Brave, Opera** (same folder): the browser's extensions page (`chrome://extensions`, `edge://extensions`, `brave://extensions`, `opera://extensions`) → Developer mode → *Load unpacked* → `build/extensions/chromium`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `build/extensions/firefox/manifest.json`. A temporary add-on disappears when Firefox closes; a permanent install needs a signed package.

The app's **Settings > Browser extension** section shows these steps with copyable addresses.

In the desktop app the same section starts with a **Set up in <browser>** button for every supported browser found on the computer: it opens that browser's extensions page and the extension folder and copies the path to pick; the browser itself always asks you to confirm, nothing is installed behind your back. A green mark shows when the extension has reached the app.

**Use:** there is no pop-up. **Clicking** the Hypernab icon in the toolbar **turns capture on or off** (when off, the icon turns grey with a red slash; no button or panel appears on pages and nothing is captured). **Right-clicking** opens a menu: *Open Hypernab*, *Inspect this page*, *Capture videos*, *Settings and diagnostics*. On a link, right-click shows *Download with Hypernab*. The **Download** button that appears on the page when a video plays is the main place to download.

## Updates

Shortly after it starts, the app checks once for a new version. You can also check by hand with **Check for updates** in the tray menu.

- A new version is **never downloaded without your approval**.
- Installing is offered **when no download is active**; the engine is stopped safely before closing, and the queue and settings are kept.
- The package comes from the release page and is verified with its SHA-512 digest.

## Privacy and security

The full policy is in [PRIVACY.md](PRIVACY.md).

- The local engine only runs on `127.0.0.1`; every request needs the pairing key and a source check.
- Browser cookies are used only when you press the button on the page (or choose “Download with Hypernab” on a link), only for the address you chose. They are kept in memory. When the media engine (yt-dlp) needs them, they are written to a short-lived temporary file in the Windows temp folder for the length of that one run and deleted as soon as it ends (leftovers are swept at the next start). They are never written to the history, a log or a report.
- DRM-protected content and access restrictions are **not bypassed**. Use it only for content you are allowed to download.
- The download list (`queue.json` in `%APPDATA%\Hypernab\data`) keeps for each job its file name, state, folder, the source address (with any signed query it had), the address of the page it came from (without query) and the User-Agent. The history keeps title, file name, folder, site name, size and times. **Cookies and other request headers are never saved.** Clearing the queue removes its entries from the list; downloaded files stay. The data folder stays when you uninstall, so a reinstall finds your queue and settings; delete it to remove everything. yt-dlp's own cache is kept in that folder too, never in your home folder.

## Limits

- It is not guaranteed to work on every site; sites change. If there is a problem, the **Copy the diagnostic report** button on the extension's settings page makes a report without cookie or query information (it does contain the site names and shortened path parts of the pages involved).
- Subtitles that are only drawn as a special layer on the page cannot be captured.
- A Windows code signature and a permanent (signed) Firefox package do not exist yet.

## Development

Requirement: Node.js 22.13 or newer.

```
npm install
npm test                  # unit tests
npm run check             # syntax check
npm run build:extensions  # extension packages
npm run dist              # Windows installer (dist/)
node scripts/desktop-smoke.js   # end-to-end check of the packaged app
```

Texts live in `public/strings.js` (English and Turkish side by side); new text is never written into the code. Before a release, `node scripts/privacy-check.js --repo --package --history` is run; if it finds personal information or a private term, the release stops.

## License and third-party components

All rights reserved. The installer contains Electron, Node.js, yt-dlp and FFmpeg unchanged; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their licences.
