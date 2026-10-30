# Üçüncü taraf bileşenler

Hypernab kurulum paketi aşağıdaki programları değiştirmeden içerir. Her biri kendi lisansıyla dağıtılır.

| Bileşen | Kullanım | Lisans | Kaynak |
| --- | --- | --- | --- |
| Electron | Masaüstü penceresi ve tepsi | MIT | https://github.com/electron/electron |
| Node.js | İndirme motorunu çalıştırır | MIT (ve içerdiği bileşenlerin lisansları) | https://github.com/nodejs/node |
| yt-dlp | Site bağımsız kaynak çözümleme ve yedek indirme | Unlicense (kamu malı) | https://github.com/yt-dlp/yt-dlp |
| FFmpeg / ffprobe (Gyan.dev "essentials" derlemesi) | Ses ve görüntüyü birleştirme, dosya doğrulama | GPL-3.0 (derleme `--enable-gpl --enable-version3` ile yapılmıştır) | https://ffmpeg.org/ · https://www.gyan.dev/ffmpeg/builds/ |

FFmpeg GPL-3.0 ile dağıtıldığı için, paketi başkalarına dağıtan kişi FFmpeg'in karşılık gelen kaynak koduna erişim sağlamalıdır (yukarıdaki bağlantılar ve derleyicinin yayımladığı kaynak arşivi). Hypernab FFmpeg'i ayrı bir program olarak çalıştırır; onunla bağlanmaz (link edilmez).

