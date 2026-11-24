param(
    [Parameter(Mandatory = $true)][string]$ObsSdkDir,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [string[]]$DependencyPrefix = @(),
    [string]$NodeLicense,
    [string]$ObsExe = 'C:\Program Files\obs-studio\bin\64bit\obs64.exe'
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ObsSdkDir = (Resolve-Path -LiteralPath $ObsSdkDir).Path
$Prefixes = @($ObsSdkDir) + @($DependencyPrefix | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
if (-not $NodeLicense) { $NodeLicense = Join-Path (Split-Path -Parent $NodeExe) 'LICENSE' }
$NodeLicense = (Resolve-Path -LiteralPath $NodeLicense).Path
if (-not (Test-Path -LiteralPath $ObsExe)) { throw 'Supply -ObsExe pointing to installed OBS Studio 33.0.1 x64.' }
$ObsVersion = (Get-Item -LiteralPath $ObsExe).VersionInfo.ProductVersion
if ($ObsVersion -notmatch '^33\.0\.1(?:\D|$)') { throw "OBS 33.0.1 required; found $ObsVersion." }
$NodeArch = & $NodeExe -p 'process.arch'
if ($LASTEXITCODE -ne 0 -or $NodeArch.Trim() -ne 'x64') { throw 'Provide a Windows x64 Node.js runtime.' }
$NodeMajor = & $NodeExe -p 'Number.parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$NodeMajor.Trim() -lt 20) { throw 'Provide Node.js 20 or newer x64 and its matching LICENSE. A supported LTS version is recommended.' }

$Build = Join-Path $ProjectRoot '.build\windows-x64'
$Package = Join-Path $ProjectRoot 'dist\windows-x64\SkiRaceOverlay'
cmake -S (Join-Path $ProjectRoot 'native') -B $Build -G 'Visual Studio 18 2026' -A x64 "-DCMAKE_PREFIX_PATH=$($Prefixes -join ';')"
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed. Supply the complete OBS 33.0.1 x64 exported SDK, including dependency CMake packages.' }
cmake --build $Build --config Release
if ($LASTEXITCODE -ne 0) { throw 'Windows compilation failed.' }
ctest --test-dir $Build -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Windows native test failed.' }
if (Test-Path -LiteralPath $Package) { Remove-Item -LiteralPath $Package -Recurse -Force }
cmake --install $Build --config Release --prefix $Package
if ($LASTEXITCODE -ne 0) { throw 'Plugin staging failed.' }
$Data = Join-Path $Package 'data'
$App = Join-Path $Data 'app'
$Runtime = Join-Path $Data 'runtime'
New-Item -ItemType Directory -Force -Path $App, $Runtime | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $Runtime 'node.exe')
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $Runtime 'LICENSE')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'native\COPYING') -Destination (Join-Path $Data 'COPYING')
foreach ($File in @('server.mjs', 'package.json')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot $File) -Destination $App }
foreach ($Folder in @('lib', 'public', 'examples', 'simulator')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot $Folder) -Destination $App -Recurse }
New-Item -ItemType Directory -Force -Path (Join-Path $App 'node_modules') | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'node_modules\ws') -Destination (Join-Path $App 'node_modules') -Recurse
$Zip = Join-Path $ProjectRoot 'dist\SkiRaceOverlay-windows-x64.zip'
Compress-Archive -LiteralPath $Package -DestinationPath $Zip -Force
Write-Host "Built $Zip"
Write-Host 'Windows runtime behavior still needs verification on the target PC. Close OBS before installing.'
