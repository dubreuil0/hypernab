$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root 'tools'
$target = Join-Path $tools 'yt-dlp.exe'
$staging = Join-Path $tools 'yt-dlp.exe.download'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
if (Test-Path $target) {
    throw 'yt-dlp.exe zaten var. Bu betik mevcut dosyanin uzerine yazmaz. Guncellemeyi elle yapabilirsiniz.'
}
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host 'Resmi yt-dlp surumu GitHub uzerinden kontrol ediliyor...'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -Headers @{ 'User-Agent' = 'Hypernab-Setup' }
    $binary = $release.assets | Where-Object { $_.name -eq 'yt-dlp.exe' } | Select-Object -First 1
    $checksums = $release.assets | Where-Object { $_.name -eq 'SHA2-256SUMS' } | Select-Object -First 1
    if (-not $binary -or -not $checksums) { throw 'Resmi surumde gerekli dosyalar bulunamadi.' }
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri $checksums.browser_download_url).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $match = [regex]::Match([string]$sums, '(?m)^([a-fA-F0-9]{64})\s+\*?yt-dlp\.exe\s*$')
    if (-not $match.Success) { throw 'SHA256 dogrulama degeri bulunamadi.' }
    Invoke-WebRequest -UseBasicParsing -Uri $binary.browser_download_url -OutFile $staging
    $actual = (Get-FileHash -Algorithm SHA256 -Path $staging).Hash
    if ($actual -ne $match.Groups[1].Value) { throw 'SHA256 eslesmedi; kurulum durduruldu.' }
    Move-Item -Path $staging -Destination $target
    Write-Host "Kuruldu: $($release.tag_name). SHA256 dogrulandi."
    Write-Host 'Birlestirme icin ffmpeg.exe ve ffprobe.exe dosyalarini tools klasorune ekleyin.'
} finally {
    if (Test-Path $staging) { Remove-Item -Path $staging -Force }
}
