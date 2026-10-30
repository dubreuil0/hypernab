# Medya araçları

`yt-dlp.exe`, `ffmpeg.exe` ve `ffprobe.exe` bu klasöre konur. Uygulama sistem PATH'inden rastgele araç çalıştırmaz.

yt-dlp: https://github.com/yt-dlp/yt-dlp/releases

FFmpeg Windows derlemeleri: https://ffmpeg.org/download.html#build-windows

yt-dlp kurulum yardımcısı: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-ytdlp.ps1`

FFmpeg/ffprobe kurulum yardımcısı: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-ffmpeg.ps1`. FFmpeg'in sitesinde listelenen Gyan.dev derlemesi kullanılır; arşiv SHA256 doğrulaması yapılır. Bu sağlayıcının derleme/lisans bilgileri: https://www.gyan.dev/ffmpeg/builds/ . Var olan araçların üzerine yazılmaz.

FFmpeg arşivinden yalnızca `bin/ffmpeg.exe` ve `bin/ffprobe.exe` dosyalarını buraya kopyala. Araçların kendi lisansları geçerlidir. yt-dlp üçüncü taraf bir programdır ve indirme sırasında hedef sitelere bağlanır.
