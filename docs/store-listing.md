# Store listing texts (Chrome Web Store and Firefox add-ons)

Ready-to-paste texts for the extension's store pages. Packages: `npm run package:extensions` writes `dist/store/hypernab-chrome-<version>.zip` and `hypernab-firefox-<version>.zip`.
Privacy policy address (both stores): `https://github.com/dubreuil0/hypernab/blob/main/PRIVACY.md`

## Name, summary, category

- **Name:** Hypernab - Video Catcher
- **Summary (max 132 characters):** Sends the DRM-free videos that play, and the files your browser downloads, to the Hypernab download manager on your PC.
- **Category:** Productivity (Chrome) / Download Management (Firefox)
- **Language:** English (Turkish listing: below)

## Description (English)

Hypernab - Video Catcher is the browser part of **Hypernab**, a free download manager for Windows. It does nothing on its own: it hands videos and files to the Hypernab app running on the same computer, which downloads them faster, resumes them if the connection drops and keeps your queue.

**Requires the Hypernab app for Windows 10/11:** https://github.com/dubreuil0/hypernab/releases

What it does
- Notices the video you are playing (DRM-free files, HLS and DASH streams) and shows a **Download with Hypernab** button on the page. You choose the quality and, when a video has several, the sound and subtitle. It never silently falls back to a quality you did not choose.
- Optionally takes over the browser's own file downloads (zip, pdf, iso, programs...). A small window asks: **Download**, **Later** or **Cancel**. The file is never lost: if the app is closed or anything fails, the browser carries on with its own download.
- Click the toolbar icon to turn capture on or off. Right-click for the menu and settings.
- English and Turkish.

Privacy
- No account, no cloud, no ads, no analytics. The extension talks only to the Hypernab app on your own computer (127.0.0.1) and makes no other network request.
- Cookies are read only when you press the button for one file, only for that file's address, and are never saved.
- Does not bypass DRM or access restrictions. Use it only for content you are allowed to download.

## Description (Türkçe)

Hypernab - Video Yakalayıcı, Windows için ücretsiz indirme yöneticisi **Hypernab**'ın tarayıcı parçasıdır. Tek başına bir şey yapmaz: video ve dosyaları aynı bilgisayardaki Hypernab uygulamasına verir; uygulama onları daha hızlı indirir, bağlantı kopunca kaldığı yerden sürdürür ve sırayı tutar.

**Windows 10/11 için Hypernab uygulaması gerekir:** https://github.com/dubreuil0/hypernab/releases

Ne yapar
- Oynattığın videoyu (DRM'siz dosyalar, HLS ve DASH yayınları) fark eder ve sayfada **Hypernab ile indir** düğmesi gösterir. Kaliteyi, bir videoda birden çok varsa sesi ve altyazıyı sen seçersin. Seçmediğin bir kaliteye sessizce düşmez.
- İsteğe bağlı olarak tarayıcının kendi dosya indirmelerini (zip, pdf, iso, programlar...) devralır. Küçük bir pencere sorar: **İndir**, **Sonra ekle** ya da **İptal**. Dosya asla kaybolmaz: uygulama kapalıysa ya da bir şey ters giderse tarayıcı kendi indirmesine devam eder.
- Araç çubuğundaki simgeye tıklayarak yakalamayı açıp kapatırsın. Sağ tık menüsü ve ayarlar da orada.
- İngilizce ve Türkçe.

Gizlilik
- Hesap, bulut, reklam ve analiz yok. Eklenti yalnızca kendi bilgisayarındaki Hypernab uygulamasıyla (127.0.0.1) konuşur, başka ağ isteği yapmaz.
- Çerezler yalnızca bir dosya için düğmeye bastığında, yalnızca o dosyanın adresi için okunur ve hiç kaydedilmez.
- DRM'yi ya da erişim kısıtlarını aşmaz. Yalnızca indirmeye hakkın olan içerikler için kullan.

## Single purpose (Chrome "Single purpose" field)

Find the video or file the user wants to download in the browser and hand it to the Hypernab download manager installed on the same computer.

## Permission justifications

| Permission | Why it is needed |
|---|---|
| `webRequest` | Observes the response headers of media requests (type, size, address) to notice a playing video or stream. In Firefox, with `webRequestBlocking`, it holds a file download's response only while the user decides whether Hypernab should take it. Nothing is modified or blocked otherwise. |
| `downloads` | Pauses the browser's own file download while the user chooses, cancels it only after Hypernab has accepted the file, and gives it back to the browser if anything fails. |
| `downloads.ui` (Chromium) | Hides the browser's download bubble for the moment a download is handed to Hypernab. |
| `cookies` | Reads the cookies of one file's address, only after the user presses a button for that file, so a download that needs the user's signed-in session works. Sent only to the app on the same computer; never stored. |
| `nativeMessaging` | Pairs the extension with the Hypernab app on the same computer (a pairing key), so only this extension can control it. |
| `storage` | Keeps the user's extension settings (language, minimum file size, remembered choices). |
| `activeTab` | Lets the toolbar menu inspect the current page when the user asks. |
| `contextMenus` | The toolbar icon's right-click menu (open Hypernab, inspect this page, settings). |
| `alarms` | Once a minute, keeps the extension language in step with the app's language setting. |
| `http://*/*`, `https://*/*` (host access and content script) | Videos and files can be on any website, so the page button and the media detection must work on any page. The content script only looks for playable videos and subtitles and draws the user's download button; the extension sends data only to the app on the same computer (127.0.0.1). |

**Remote code:** none. All code is in the package; nothing is loaded from the internet.

## Privacy practices tab (Chrome)

- The extension handles web addresses of media requests, file download information and (on user action) cookies. All of it stays on the user's computer: it is sent only to the Hypernab app on the same computer, never to the developer or a third party.
- Be conservative when ticking the data types: tick *Authentication information* (cookies), *Web history* (addresses) and *Website content* (videos, subtitles found on pages) and explain they are handled locally only.
- Tick all three statements: no sale of data, no use unrelated to the single purpose, no use for credit or lending.

## Notes for the reviewer (paste into the "Test instructions" / "Notes to reviewer" field)

The extension is the browser part of a Windows desktop download manager and only works when that app is running (the app listens on 127.0.0.1 only). To test:
1. Install the app from https://github.com/dubreuil0/hypernab/releases (Hypernab-Setup-x.y.z.exe, Windows 10/11; the installer is not yet code-signed, so Windows may show an "unknown publisher" notice). Start it.
2. Open the extension's settings page (right-click the toolbar icon, *Settings and diagnostics*): the connection shows as connected.
3. Open any page with a plain video file; the **Download with Hypernab** button appears on the page. Or start a file download (a zip over 1 MB): a small window asks Download / Later / Cancel.
The extension makes no network request except to 127.0.0.1. Source code (not minified, no obfuscation): https://github.com/dubreuil0/hypernab ; the package is produced by `npm run package:extensions` (it copies the files in `extension/` and `public/` and writes one generated file, `panel-css.js`, from `public/ds.css` and `extension/panel.css`).

## Firefox add-ons (AMO) notes

- Submit as **"On this site"** (listed) to appear in the store search; or **"On your own"** (unlisted) to get a signed file without the store page. Listed is recommended; both give a signed, permanent install.
- Manifest already declares `data_collection_permissions: { required: ["none"] }` and a permanent id (a random GUID, no name or address).
- Licence choice: *All Rights Reserved* (the project's licence).
- Reviewers may ask for the source: give the repository address above and the commands in the reviewer note.

## Screenshots (Chrome 1280x800, at least 1; up to 5)

1. The **Download with Hypernab** panel on a video page (quality, sound, subtitle).
2. The small file-download window (Download / Later / Cancel).
3. The Hypernab app with a running download and the queue.
4. The extension's settings page (connection, file downloads).

Screenshots must not show real accounts, personal files, user names or paths. Use a neutral test page.
