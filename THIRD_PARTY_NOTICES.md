# Third-party components ([Türkçe](#üçüncü-taraf-bileşenler))

The Hypernab installer contains the following programs unchanged. Each is distributed under its own licence.

| Component | Used for | Licence | Source |
| --- | --- | --- | --- |
| Electron (with Chromium) | Desktop window and tray | MIT (Chromium's own licences are in `LICENSES.chromium.html`, installed with the app) | https://github.com/electron/electron |
| Node.js | Runs the download engine | MIT (and the licences of the components it contains) | https://github.com/nodejs/node |
| yt-dlp | Site-independent source resolving and fallback download | Unlicense (public domain) | https://github.com/yt-dlp/yt-dlp |
| FFmpeg / ffprobe (Gyan.dev "essentials" build) | Merging picture and sound, verifying files | GPL-3.0 (the build was made with `--enable-gpl --enable-version3`) | https://ffmpeg.org/ · https://www.gyan.dev/ffmpeg/builds/ |

Because FFmpeg is distributed under GPL-3.0, whoever passes the package on must give access to the corresponding FFmpeg source code (the links above and the source archive published by the builder). Hypernab runs FFmpeg as a separate program; it is not linked with it.

---

# Üçüncü taraf bileşenler

Hypernab kurulum paketi aşağıdaki programları değiştirmeden içerir. Her biri kendi lisansıyla dağıtılır.

| Bileşen | Kullanım | Lisans | Kaynak |
| --- | --- | --- | --- |
| Electron | Masaüstü penceresi ve tepsi | MIT | https://github.com/electron/electron |
| Node.js | İndirme motorunu çalıştırır | MIT (ve içerdiği bileşenlerin lisansları) | https://github.com/nodejs/node |
| yt-dlp | Site bağımsız kaynak çözümleme ve yedek indirme | Unlicense (kamu malı) | https://github.com/yt-dlp/yt-dlp |
| FFmpeg / ffprobe (Gyan.dev "essentials" derlemesi) | Ses ve görüntüyü birleştirme, dosya doğrulama | GPL-3.0 (derleme `--enable-gpl --enable-version3` ile yapılmıştır) | https://ffmpeg.org/ · https://www.gyan.dev/ffmpeg/builds/ |

FFmpeg GPL-3.0 ile dağıtıldığı için, paketi başkalarına dağıtan kişi FFmpeg'in karşılık gelen kaynak koduna erişim sağlamalıdır (yukarıdaki bağlantılar ve derleyicinin yayımladığı kaynak arşivi). Hypernab FFmpeg'i ayrı bir program olarak çalıştırır; onunla bağlanmaz (link edilmez).

