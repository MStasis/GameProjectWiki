$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$buildStarted = Get-Date
npm run desktop:build
if ($LASTEXITCODE -ne 0) { throw "Windows desktop build failed with exit code $LASTEXITCODE." }

$artifactDirectory = Join-Path $root "artifacts"
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$installerPath = Join-Path $root "release\Title-Placeholder-Wiki-Setup-$version.exe"
$installer = Get-Item -LiteralPath $installerPath -ErrorAction SilentlyContinue
if (-not $installer) { throw "Windows installer was not created." }
if ($installer.LastWriteTime -lt $buildStarted.AddSeconds(-2)) { throw "Windows installer was not refreshed by this build." }

$destination = Join-Path $artifactDirectory $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
Get-FileHash -LiteralPath $destination -Algorithm SHA256 |
    Format-List Algorithm, Hash, Path
