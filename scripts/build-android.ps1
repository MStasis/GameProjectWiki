$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$androidStudioJava = "C:\Program Files\Android\Android Studio\jbr"
if (-not (Test-Path -LiteralPath (Join-Path $androidStudioJava "bin\java.exe"))) {
    throw "Android Studio JDK was not found at $androidStudioJava"
}
$sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
if (-not (Test-Path -LiteralPath $sdk)) { throw "Android SDK was not found at $sdk" }

$env:JAVA_HOME = $androidStudioJava
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$(Join-Path $androidStudioJava 'bin');$(Join-Path $sdk 'platform-tools');$env:Path"

if (-not (Test-Path -LiteralPath (Join-Path $root "android"))) {
    throw "The tracked Android project is missing. Restore the android directory from Git before building so release signing safeguards are preserved."
}

$secretDirectory = Join-Path $root "build-secrets"
$keyStore = Join-Path $secretDirectory "title-placeholder-wiki-release.jks"
$properties = Join-Path $secretDirectory "android-signing.properties"
$certificateFingerprintFile = Join-Path $root "build\android-signing-certificate.sha256"
if ((Test-Path -LiteralPath $certificateFingerprintFile) -and (
    -not (Test-Path -LiteralPath $keyStore) -or -not (Test-Path -LiteralPath $properties)
)) {
    throw "The established Android signing files are incomplete. Restore both files under build-secrets before building."
}
New-Item -ItemType Directory -Force -Path $secretDirectory | Out-Null

$signing = @{}
if (Test-Path -LiteralPath $properties) {
    Get-Content -LiteralPath $properties | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") { $signing[$matches[1]] = $matches[2] }
    }
} elseif (Test-Path -LiteralPath $keyStore) {
    throw "The Android keystore exists but android-signing.properties is missing. Restore the matching properties file; do not generate a new key."
} else {
    $passwordBytes = New-Object byte[] 24
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($passwordBytes)
    } finally {
        $random.Dispose()
    }
    $password = [Convert]::ToBase64String($passwordBytes).Replace("+", "A").Replace("/", "B").TrimEnd("=")
    $signing.storePassword = $password
    $signing.keyAlias = "title-placeholder-wiki"
    $signing.keyPassword = $password
}

if (-not $signing.storePassword -or -not $signing.keyAlias -or -not $signing.keyPassword) {
    throw "android-signing.properties is incomplete. Restore the credentials that match the release keystore."
}
$signing.storeFile = $keyStore.Replace('\', '/')
$signingLines = @(
    "storeFile=$($signing.storeFile)"
    "storePassword=$($signing.storePassword)"
    "keyAlias=$($signing.keyAlias)"
    "keyPassword=$($signing.keyPassword)"
)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($properties, $signingLines, $utf8NoBom)

if (-not (Test-Path -LiteralPath $keyStore)) {
    if (Test-Path -LiteralPath $certificateFingerprintFile) {
        throw "The established Android release key is missing. Restore build-secrets/title-placeholder-wiki-release.jks; generating a new key would prevent app updates."
    }
    & (Join-Path $androidStudioJava "bin\keytool.exe") `
        -genkeypair `
        -keystore $keyStore `
        -storepass $signing.storePassword `
        -alias $signing.keyAlias `
        -keypass $signing.keyPassword `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -dname "CN=Title Placeholder Wiki, OU=Personal, O=MStasis, C=KR"
    if ($LASTEXITCODE -ne 0) { throw "Android signing key generation failed with exit code $LASTEXITCODE." }
}

npm run android:sync
if ($LASTEXITCODE -ne 0) { throw "Capacitor asset synchronization failed with exit code $LASTEXITCODE." }

$source = Join-Path $root "android\app\build\outputs\apk\release\app-release.apk"
if (Test-Path -LiteralPath $source) { Remove-Item -LiteralPath $source -Force }
Push-Location -LiteralPath (Join-Path $root "android")
try {
    .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "Android release build failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $source)) { throw "Signed Android APK was not created." }
$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdk "build-tools") -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "apksigner.bat") } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $buildTools) { throw "Android apksigner was not found in the installed SDK build-tools." }
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$signatureReport = & $apksigner verify --verbose --print-certs $source 2>&1
$signatureReport | Write-Output
if ($LASTEXITCODE -ne 0) { throw "Android APK signature verification failed with exit code $LASTEXITCODE." }
$digestMatch = $signatureReport | Select-String -Pattern "certificate SHA-256 digest:\s*([0-9a-fA-F]+)" | Select-Object -First 1
if (-not $digestMatch) { throw "Android APK signer certificate fingerprint could not be read." }
$certificateFingerprint = $digestMatch.Matches[0].Groups[1].Value.ToLowerInvariant()
if (Test-Path -LiteralPath $certificateFingerprintFile) {
    $expectedFingerprint = (Get-Content -LiteralPath $certificateFingerprintFile -Raw).Trim().ToLowerInvariant()
    if ($certificateFingerprint -ne $expectedFingerprint) {
        throw "Android APK was signed with a different certificate. Restore the established release key."
    }
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $certificateFingerprintFile) | Out-Null
    [System.IO.File]::WriteAllText($certificateFingerprintFile, "$certificateFingerprint`r`n", [System.Text.Encoding]::ASCII)
}
$artifactDirectory = Join-Path $root "artifacts"
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$destination = Join-Path $artifactDirectory "Title-Placeholder-Wiki-Android-v$version.apk"
Copy-Item -LiteralPath $source -Destination $destination -Force
Get-FileHash -LiteralPath $destination -Algorithm SHA256 |
    Format-List Algorithm, Hash, Path

Write-Warning "Keep build-secrets/title-placeholder-wiki-release.jks and android-signing.properties. Future APK updates must use the same key."
