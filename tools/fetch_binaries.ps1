# Скачивает ffmpeg/ffprobe и rife-ncnn-vulkan в tools/bin (Windows x64).
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File tools\fetch_binaries.ps1 [-Force]

param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # иначе Invoke-WebRequest в 5.1 очень медленный
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Bin = Join-Path $PSScriptRoot 'bin'
$Tmp = Join-Path $PSScriptRoot '.download'
New-Item -ItemType Directory -Force -Path $Bin, $Tmp | Out-Null

function Expand-Zip([string]$Zip, [string]$Dest) {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

# --- ffmpeg (gyan.dev, release essentials) ---
$ffmpeg = Join-Path $Bin 'ffmpeg.exe'
if ($Force -or -not (Test-Path $ffmpeg)) {
    Write-Host 'ffmpeg: скачивание...'
    $zip = Join-Path $Tmp 'ffmpeg.zip'
    Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
    $x = Join-Path $Tmp 'ffmpeg'
    Expand-Zip $zip $x
    $binDir = Get-ChildItem -Path $x -Recurse -Directory -Filter 'bin' | Select-Object -First 1
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
        Copy-Item -Force (Join-Path $binDir.FullName $exe) $Bin
    }
    Write-Host "ffmpeg: готово ($((& $ffmpeg -hide_banner -version | Select-Object -First 1)))"
} else {
    Write-Host 'ffmpeg: уже есть (используйте -Force для обновления)'
}

# --- rife-ncnn-vulkan (последний релиз nihui/rife-ncnn-vulkan) ---
$rifeDir = Join-Path $Bin 'rife-ncnn-vulkan'
$rifeExe = Join-Path $rifeDir 'rife-ncnn-vulkan.exe'
if ($Force -or -not (Test-Path $rifeExe)) {
    Write-Host 'rife-ncnn-vulkan: поиск последнего релиза...'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/nihui/rife-ncnn-vulkan/releases/latest' `
        -Headers @{ 'User-Agent' = 'AIEditor-fetch' }
    $asset = $release.assets | Where-Object { $_.name -like '*windows*.zip' } | Select-Object -First 1
    if (-not $asset) { throw 'Не найден windows-архив в релизе rife-ncnn-vulkan' }
    Write-Host "rife-ncnn-vulkan: скачивание $($asset.name)..."
    $zip = Join-Path $Tmp 'rife.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
    $x = Join-Path $Tmp 'rife'
    Expand-Zip $zip $x
    $inner = Get-ChildItem -Path $x -Recurse -Filter 'rife-ncnn-vulkan.exe' | Select-Object -First 1
    if (Test-Path $rifeDir) { Remove-Item -Recurse -Force $rifeDir }
    Copy-Item -Recurse -Force $inner.Directory.FullName $rifeDir
    $models = Get-ChildItem -Path $rifeDir -Directory -Filter 'rife-v4*' | ForEach-Object { $_.Name }
    Write-Host "rife-ncnn-vulkan: готово ($($release.tag_name)); модели: $($models -join ', ')"
} else {
    Write-Host 'rife-ncnn-vulkan: уже есть (используйте -Force для обновления)'
}

Remove-Item -Recurse -Force $Tmp
Write-Host "Бинарники в $Bin"
