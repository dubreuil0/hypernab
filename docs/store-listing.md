# Store listing texts (Chrome Web Store and Firefox add-ons)

Ready-to-paste texts for the extension's store pages. Packages: `npm run package:extensions` writes `dist/store/hypernab-chrome-<version>.zip` and `hypernab-firefox-<version>.zip`.
Privacy policy address (both stores): `https://github.com/dubreuil0/hypernab/blob/main/PRIVACY.md`

## Name, summary, category

- **Name:** Hypernab - Video Catcher
- **Summary (max 132 characters):** Sends the DRM-free videos that play, and any link you right-click, to the Hypernab download manager on your PC.
- **Category:** Productivity (Chrome) / Download Management (Firefox)
- **Language:** English (Turkish listing: below)

## Description (English)

Hypernab - Video Catcher is the browser part of **Hypernab**, a free download manager for Windows. It does nothing on its own: it hands videos and files to the Hypernab app running on the same computer, which downloads them faster, resumes them if the connection drops and keeps your queue.

**Requires the Hypernab app for Windows 10/11:** https://github.com/dubreuil0/hypernab/releases

What it does
- Notices the video you are playing (DRM-free files, HLS and DASH streams) and shows a **Download with Hypernab** button on the page. You choose the quality and, when a video has several, the sound and subtitle. It never silently falls back to a quality you did not choose.
- Any file: right-click a link and choose **Download with Hypernab**. Only that file is handed over; nothing else in the browser is touched.

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
- Herhangi bir dosya: bağlantıya sağ tıkla ve **Hypernab ile indir**'i seç. Yalnızca o dosya verilir; tarayıcıda başka hiçbir şeye dokunulmaz.

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
| `webRequest` | Observes the response headers of media requests (type, size, address) to notice a playing video or stream. Nothing is modified or blocked. |
| `cookies` | Reads the cookies of one file's address, only after the user presses a button for that file or chooses "Download with Hypernab" on a link, so a download that needs the user's signed-in session works. Sent only to the app on the same computer; never stored. |
| `nativeMessaging` | Pairs the extension with the Hypernab app on the same computer (a pairing key), so only this extension can control it. |
| `storage` | Keeps the user's extension settings (language, minimum file size, remembered choices). |
| `activeTab` | Lets the toolbar menu inspect the current page when the user asks. |
| `contextMenus` | The toolbar icon's right-click menu (open Hypernab, inspect this page, settings) and the **Download with Hypernab** item on links. |
| `alarms` | Once a minute, keeps the extension language in step with the app's language setting. |
| `http://*/*`, `https://*/*` (host access and content script) | Videos and files can be on any website, so the page button and the media detection must work on any page. The content script only looks for playable videos and subtitles and draws the user's download button; the extension sends data only to the app on the same computer (127.0.0.1). |

**Remote code:** none. All code is in the package; nothing is loaded from the internet.

## Privacy practices tab (Chrome)

- The extension handles web addresses of media requests and of links the user chooses, and (on user action) cookies. All of it stays on the user's computer: it is sent only to the Hypernab app on the same computer, never to the developer or a third party.
- Be conservative when ticking the data types: tick *Authentication information* (cookies), *Web history* (addresses) and *Website content* (videos, subtitles found on pages) and explain they are handled locally only.
- Tick all three statements: no sale of data, no use unrelated to the single purpose, no use for credit or lending.

## Notes for the reviewer (paste into the "Test instructions" / "Notes to reviewer" field)

The extension is the browser part of a Windows desktop download manager and only works when that app is running (the app listens on 127.0.0.1 only). To test:
1. Install the app from https://github.com/dubreuil0/hypernab/releases (Hypernab-Setup-x.y.z.exe, Windows 10/11; the installer is not yet code-signed, so Windows may show an "unknown publisher" notice). Start it.
2. Open the extension's settings page (right-click the toolbar icon, *Settings and diagnostics*): the connection shows as connected.
3. Open any page with a plain video file; the **Download with Hypernab** button appears on the page. Or right-click any link to a file and choose **Download with Hypernab**: the job appears in the app.
The extension makes no network request except to 127.0.0.1. Source code (not minified, no obfuscation): https://github.com/dubreuil0/hypernab ; the package is produced by `npm run package:extensions` (it copies the files in `extension/` and `public/` and writes one generated file, `panel-css.js`, from `public/ds.css` and `extension/panel.css`).

## Firefox add-ons (AMO) notes

- Submit as **"On this site"** (listed) to appear in the store search; or **"On your own"** (unlisted) to get a signed file without the store page. Listed is recommended; both give a signed, permanent install.
- Manifest already declares `data_collection_permissions: { required: ["none"] }` and a permanent id (a random GUID, no name or address).
- Licence choice: *All Rights Reserved* (the project's licence).
- Reviewers may ask for the source: give the repository address above and the commands in the reviewer note.

## Screenshots (Chrome 1280x800, at least 1; up to 5)

1. The **Download with Hypernab** panel on a video page (quality, sound, subtitle).
2. The right-click menu on a link ("Download with Hypernab").
3. The Hypernab app with a running download and the queue.
4. The extension's settings page (connection, capture switch).

Screenshots must not show real accounts, personal files, user names or paths. Use a neutral test page.
