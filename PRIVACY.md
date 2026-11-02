# Hypernab privacy policy

[Türkçe](PRIVACY.tr.md)

Last updated: 2 November 2026

Hypernab is a download manager that runs on your own computer, with a browser extension that hands videos and files to it. **Hypernab does not collect, store on a server, sell or share your data.** There is no account, no cloud service, no advertising and no analytics. The developer never receives anything about you or your downloads.

## What the browser extension does with your data

The extension needs access to the pages you visit only to do its single job: find the video or file you want and give it to the Hypernab app installed on the same computer.

| What | Why | Where it goes |
|---|---|---|
| Addresses and response headers of media requests on the pages you open | To notice a playing video or stream and show the **Download** button | Only to the Hypernab app on your computer (`127.0.0.1`), when you ask to download |
| The address of a link you right-click and choose **Download with Hypernab** (and the page it is on) | To hand that one file to Hypernab | Only to the Hypernab app on your computer, only at that click |
| Browser cookies | Some files and videos need your signed-in session to be fetched | Read **only when you press a button for that one file or choose "Download with Hypernab" on a link**, only for that file's address, sent only to the app on your computer, and never written to disk, a log or a report |
| Your extension settings (for example the language and the file-size limit) | To remember your choices | Kept in the browser's own extension storage on your computer |

The extension does not read the content of pages beyond finding videos and subtitles you can play, does not record what you type, does not track your browsing history, and makes **no network request to any server other than the Hypernab app on your own computer.** It does not run code loaded from the internet. The extension does not watch or take over the browser's own downloads. Browsers run extensions in private (incognito) windows only if you allow it; in a private window the normal session's cookies are never used.

## What the Hypernab app does

- Downloads the files you choose from the address you chose, to a folder on your computer. Those servers see an ordinary download request from you, like a browser would send.
- Keeps a download history (file name, state, size) in a local database on your computer. It contains no cookie or request header. You can clear it.
- Once after it starts, asks GitHub whether a newer version exists. A new version is never downloaded without your approval. GitHub receives the usual information of a web request (such as your IP address), as with any website.
- Optionally (off by default), reads the clipboard to offer to add links, only while that setting is on. Nothing from the clipboard is stored or sent.

## What Hypernab does not do

- It does not send your downloads, history, cookies, addresses or settings to the developer or to any third party.
- It does not bypass DRM or access restrictions.
- It does not use your data for advertising, profiling or credit decisions, and it does not sell it.

## Your control

Turn capture off with one click on the toolbar icon, remove the extension in your browser, or uninstall the app from Windows. Removing them removes the settings and history stored on your computer. Files you downloaded are yours and are not deleted.

## Changes and contact

If this policy changes, the new version is published here with a new date. Questions: open an issue at <https://github.com/dubreuil0/hypernab/issues>.
