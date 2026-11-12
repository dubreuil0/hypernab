# Media tools

`yt-dlp.exe`, `ffmpeg.exe` and `ffprobe.exe` go into this folder. They are not in git (`.gitignore`); the installer bundles them. The app never runs a tool from the system PATH.

- yt-dlp: https://github.com/yt-dlp/yt-dlp/releases — helper: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup\install-ytdlp.ps1`
- FFmpeg / ffprobe (Windows builds): https://ffmpeg.org/download.html#build-windows — helper: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup\install-ffmpeg.ps1`. It uses the Gyan.dev build listed on the FFmpeg site and checks the archive's SHA-256 (build and licence details: https://www.gyan.dev/ffmpeg/builds/). Existing tools are never overwritten.

By hand: copy only `bin/ffmpeg.exe` and `bin/ffprobe.exe` from the FFmpeg archive here. The tools keep their own licences (see `THIRD_PARTY_NOTICES.md`). yt-dlp is a third-party program and connects to the target sites while downloading.

Check them with `npm run verify-tools`.
