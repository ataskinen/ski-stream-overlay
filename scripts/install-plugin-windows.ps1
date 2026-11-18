param([string]$PackageDir)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $PackageDir) { $PackageDir = Join-Path $ProjectRoot 'dist\windows-x64\SkiRaceOverlay' }
$PackageDir = (Resolve-Path -LiteralPath $PackageDir).Path
if (Get-Process -Name obs64 -ErrorAction SilentlyContinue) { throw 'Close OBS Studio before replacing plugin files.' }
if (-not (Test-Path -LiteralPath (Join-Path $PackageDir 'bin\64bit\SkiRaceOverlay.dll'))) { throw 'The complete Windows build is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $PackageDir 'data\runtime\node.exe'))) { throw 'The bundled Node.js runtime is missing.' }
foreach ($Required in @('data\runtime\LICENSE', 'data\COPYING', 'data\app\server.mjs', 'data\app\package.json', 'data\app\lib\parent-control.mjs', 'data\app\lib\feed.mjs', 'data\app\public\index.html', 'data\app\public\overlay.html', 'data\app\examples\competitors.csv')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackageDir $Required))) { throw "Incomplete plugin package: $Required is missing." }
}
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from an Administrator PowerShell. OBS loads Windows plugins from ProgramData, not the user configuration folder.' }
$Target = Join-Path $env:ProgramData 'obs-studio\plugins\SkiRaceOverlay'
$Backup = $null
if (Test-Path -LiteralPath $Target) {
    $BackupRoot = Join-Path $env:LOCALAPPDATA 'ski-stream-overlay\plugin-backups'
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    $Backup = Join-Path $BackupRoot ('SkiRaceOverlay-' + (Get-Date -Format 'yyyyMMdd-HHmmss-ffff'))
    Move-Item -LiteralPath $Target -Destination $Backup
}
try {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Path (Join-Path $PackageDir '*') -Destination $Target -Recurse
} catch {
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    if ($Backup) { Move-Item -LiteralPath $Backup -Destination $Target }
    throw
}
if ($Backup) { Write-Host "Previous plugin backed up to $Backup" }
Write-Host "Installed $Target. Start OBS and add a Ski Race Overlay source."
Write-Host 'Race state and service.log are stored per user under LOCALAPPDATA\ski-stream-overlay.'
