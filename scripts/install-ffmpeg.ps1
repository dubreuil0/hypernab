$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
    if (Test-Path (Join-Path $tools $name)) { throw "$name zaten var. Mevcut araclarin uzerine yazilmaz." }
}
$staging = Join-Path $tools ('ffmpeg-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $base = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    Write-Host 'FFmpeg Windows essentials derlemesi indiriliyor (Gyan.dev, FFmpeg indirme sayfasinda listelenen saglayici)...'
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($base + '.sha256')).Content
    if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
    $expected = [regex]::Match([string]$checksum, '(?i)\b[a-f0-9]{64}\b').Value
    if (-not $expected) { throw 'SHA256 dogrulama degeri bulunamadi.' }
    $archivePath = Join-Path $staging 'ffmpeg.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $base -OutFile $archivePath
    if ((Get-FileHash -Path $archivePath -Algorithm SHA256).Hash -ne $expected) { throw 'Arsivin SHA256 degeri eslesmedi.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
            $matches = @($zip.Entries | Where-Object { $_.FullName -match ('^[^/]+/bin/' + [regex]::Escape($name) + '$') })
            if ($matches.Count -ne 1) { throw "Arsivde $name bulunamadi." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($matches[0], (Join-Path $staging $name))
        }
    } finally { $zip.Dispose() }
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) { Move-Item -Path (Join-Path $staging $name) -Destination (Join-Path $tools $name) }
    Write-Host 'FFmpeg ve ffprobe kuruldu. Arsiv SHA256 dogrulandi. Sistem PATH ayari degistirilmedi.'
} finally {
    if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
