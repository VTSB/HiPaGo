param(
  [string]$BundleRoot,
  [switch]$NoChecksums
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-signing-common.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
  $BundleRoot = Join-Path $repoRoot 'src-tauri\target\release\bundle'
}
$BundleRoot = [System.IO.Path]::GetFullPath($BundleRoot)
if (-not (Test-Path -LiteralPath $BundleRoot -PathType Container)) {
  throw "Tauri bundle directory was not found: $BundleRoot"
}

$provider = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_SIGNING_PROVIDER'
if ($provider -notin @('certificate-store', 'azure-artifact-signing')) {
  throw "Unsupported HIPAGO_WINDOWS_SIGNING_PROVIDER '$provider'."
}
[void](Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT')
if ($provider -eq 'certificate-store') {
  [void](Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_CERTIFICATE_THUMBPRINT')
}

$mainExecutable = Join-Path (Split-Path -Parent $BundleRoot) 'hipago.exe'
$nsisInstallers = @(Get-ChildItem -LiteralPath (Join-Path $BundleRoot 'nsis') -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue)
$msiInstallers = @(Get-ChildItem -LiteralPath (Join-Path $BundleRoot 'msi') -Filter '*.msi' -File -ErrorAction SilentlyContinue)

if ($nsisInstallers.Count -ne 1) {
  throw "Expected exactly one NSIS installer (*-setup.exe), found $($nsisInstallers.Count)."
}
if ($msiInstallers.Count -ne 1) {
  throw "Expected exactly one MSI installer (*.msi), found $($msiInstallers.Count)."
}
$signTool = Get-HipagoSignTool
$authenticodeFiles = @((Get-Item -LiteralPath $mainExecutable)) + $nsisInstallers + $msiInstallers
foreach ($file in $authenticodeFiles) {
  Assert-HipagoAuthenticodeSignature -FilePath $file.FullName -SignToolPath $signTool
}

$tauriConfig = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$updaterPublicKey = $tauriConfig.plugins.updater.pubkey
if ([string]::IsNullOrWhiteSpace($updaterPublicKey)) {
  throw 'The updater public key is missing from tauri.conf.json.'
}

$updaterFiles = @()
$updaterInstallers = @($nsisInstallers + $msiInstallers)
foreach ($installer in $updaterInstallers) {
  # createUpdaterArtifacts=true uses the Tauri v2 direct-installer format:
  # the updater signs each NSIS/MSI installer itself, not a legacy zip.
  $signaturePath = "$($installer.FullName).sig"
  if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "Updater signature is missing: $signaturePath"
  }
  if ((Get-Item -LiteralPath $signaturePath).Length -le 16) {
    throw "Updater signature is empty or truncated: $signaturePath"
  }
  Invoke-HipagoExternalCommand -FilePath 'cargo.exe' -Arguments @(
    'run',
    '--quiet',
    '--locked',
    '--release',
    '--manifest-path',
    (Join-Path $repoRoot 'scripts\updater-signature-verifier\Cargo.toml'),
    '--',
    $installer.FullName,
    $signaturePath,
    $updaterPublicKey
  ) -Description "Updater signature verification for $($installer.FullName)"
  $updaterFiles += $installer
  $updaterFiles += Get-Item -LiteralPath $signaturePath
}

$releaseFiles = @($nsisInstallers + $msiInstallers + $updaterFiles) | Sort-Object FullName -Unique
if (-not $NoChecksums) {
  $checksumPath = Join-Path $BundleRoot 'SHA256SUMS-windows.txt'
  $checksumLines = foreach ($file in $releaseFiles) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relativePath = $file.FullName.Substring($BundleRoot.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
    "$hash  $relativePath"
  }
  [System.IO.File]::WriteAllLines($checksumPath, $checksumLines, [System.Text.UTF8Encoding]::new($false))
  Write-Host "SHA-256 checksums: $checksumPath"
}

Write-Host "Verified $($authenticodeFiles.Count) Authenticode files and $($updaterInstallers.Count) updater installer/signature pair(s) against the embedded public key."
