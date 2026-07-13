$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

npm run check
if ($LASTEXITCODE -ne 0) { throw "Application checks failed with exit code $LASTEXITCODE." }
& (Join-Path $PSScriptRoot "build-desktop.ps1")
& (Join-Path $PSScriptRoot "build-android.ps1")
