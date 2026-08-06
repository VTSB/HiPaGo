param(
  [switch]$CheckOnly,
  [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-signing-common.ps1')

if ($env:OS -ne 'Windows_NT') {
  throw 'The Windows production release must run on Windows.'
}
if ($AllowDirty -and -not $CheckOnly) {
  throw '-AllowDirty is restricted to -CheckOnly diagnostics and cannot be used for a production build.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  foreach ($command in @('node.exe', 'pnpm.cmd', 'git.exe', 'cargo.exe', 'rustup.exe', 'cmake.exe', 'nasm.exe')) {
    if ($null -eq (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "Required command was not found: $command"
    }
  }

  $nodeVersionText = (& node.exe --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(\d+)\.') {
    throw "Unable to determine the Node.js version: $nodeVersionText"
  }
  if ([int]$Matches[1] -lt 22) {
    throw "Node.js 22 or newer is required, got $nodeVersionText."
  }

  $rustVersionText = (& rustc.exe --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $rustVersionText -notmatch '^rustc (\d+\.\d+\.\d+) ') {
    throw "Unable to determine the Rust compiler version: $rustVersionText"
  }
  if ([version]$Matches[1] -ne [version]'1.96.0') {
    throw "Rust 1.96.0 is required by rust-toolchain.toml, got $rustVersionText."
  }

  $cmakeVersionOutput = @(& cmake.exe --version)
  $cmakeExitCode = $LASTEXITCODE
  $cmakeVersionText = ($cmakeVersionOutput | Select-Object -First 1).Trim()
  if ($cmakeExitCode -ne 0 -or $cmakeVersionText -notmatch '^cmake version (\d+\.\d+\.\d+)') {
    throw "Unable to determine the CMake version: $cmakeVersionText"
  }
  if ([version]$Matches[1] -lt [version]'3.24.0') {
    throw "CMake 3.24.0 or newer is required, got $cmakeVersionText."
  }

  $nasmVersionText = (& nasm.exe -v).Trim()
  if ($LASTEXITCODE -ne 0 -or $nasmVersionText -notmatch '^NASM version (\d+\.\d+(?:\.\d+)?)') {
    throw "Unable to determine the NASM version: $nasmVersionText"
  }
  if ([version]$Matches[1] -lt [version]'2.15.0') {
    throw "NASM 2.15.0 or newer is required, got $nasmVersionText."
  }

  $installedRustTargets = @(& rustup.exe target list --installed)
  if ($LASTEXITCODE -ne 0 -or $installedRustTargets -notcontains 'x86_64-pc-windows-msvc') {
    throw 'The Rust target x86_64-pc-windows-msvc is required.'
  }

  $vswherePath = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
    throw 'Visual Studio Installer vswhere.exe was not found. Install Visual Studio Build Tools with Desktop development with C++.'
  }
  $visualStudioPaths = @(& $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
  $vswhereExitCode = $LASTEXITCODE
  $visualStudioPath = $visualStudioPaths | Select-Object -First 1
  if ($vswhereExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($visualStudioPath)) {
    throw 'The x64 MSVC C++ toolchain was not found. Install the Desktop development with C++ workload.'
  }

  $llvmRoot = 'C:\Program Files\LLVM'
  $llvmBin = Join-Path $llvmRoot 'bin'
  $clang = Join-Path $llvmBin 'clang.exe'
  $libclang = Join-Path $llvmBin 'libclang.dll'
  if (-not (Test-Path -LiteralPath $clang -PathType Leaf) -or -not (Test-Path -LiteralPath $libclang -PathType Leaf)) {
    throw 'LLVM/libclang is missing. Install LLVM and ensure C:\Program Files\LLVM\bin contains clang.exe and libclang.dll.'
  }
  $clangVersionOutput = @(& $clang --version)
  $clangExitCode = $LASTEXITCODE
  $clangVersionText = ($clangVersionOutput | Select-Object -First 1).Trim()
  if ($clangExitCode -ne 0 -or $clangVersionText -notmatch '^clang version (\d+\.\d+\.\d+)') {
    throw "Unable to determine the Clang version: $clangVersionText"
  }
  if ([version]$Matches[1] -lt [version]'17.0.0') {
    throw "Clang 17.0.0 or newer is required, got $clangVersionText."
  }
  $resourceDirectory = Get-ChildItem -LiteralPath (Join-Path $llvmRoot 'lib\clang') -Directory |
    Where-Object { $_.Name -match '^\d+(?:\.\d+){0,3}$' } |
    Sort-Object {
      $parts = @($_.Name -split '\.')
      $padded = @($parts + @('0', '0', '0', '0'))
      [version](($padded[0..3]) -join '.')
    } -Descending |
    Select-Object -First 1
  if ($null -eq $resourceDirectory -or -not (Test-Path -LiteralPath (Join-Path $resourceDirectory.FullName 'include'))) {
    throw 'The Clang resource include directory was not found.'
  }
  $resourceInclude = (Join-Path $resourceDirectory.FullName 'include').Replace('\', '/')
  $env:LIBCLANG_PATH = $llvmBin
  $env:CLANG_PATH = $clang
  $env:BINDGEN_EXTRA_CLANG_ARGS = "-isystem `"$resourceInclude`""

  $packageVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
  $packageManager = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).packageManager
  $requiredPnpmVersion = ($packageManager -replace '^pnpm@', '')
  $actualPnpmVersion = (& pnpm.cmd --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualPnpmVersion -ne $requiredPnpmVersion) {
    throw "pnpm $requiredPnpmVersion is required by package.json, got $actualPnpmVersion."
  }
  if (-not $AllowDirty) {
    $status = git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) {
      throw 'git status failed.'
    }
    if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) {
      throw 'The working tree is not clean. Commit the intended release or rerun only the preflight with -AllowDirty.'
    }
  }
  $previousCi = $env:CI
  $sensitiveEnvironmentNames = @(
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'WINDOWS_CODE_SIGNING_PFX_BASE64',
    'WINDOWS_CODE_SIGNING_PFX_PASSWORD',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_TENANT_ID'
  )
  $sensitiveEnvironment = @{}
  foreach ($name in $sensitiveEnvironmentNames) {
    $sensitiveEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  try {
    # A release preflight must behave deterministically even when invoked from
    # a non-interactive runner where pnpm cannot ask before rebuilding modules.
    # Dependency lifecycle scripts do not need access to signing credentials.
    $env:CI = 'true'
    Invoke-HipagoExternalCommand -FilePath 'pnpm.cmd' -Arguments @(
      'install',
      '--frozen-lockfile'
    ) -Description 'Locked dependency installation'
  }
  finally {
    $env:CI = $previousCi
    foreach ($name in $sensitiveEnvironmentNames) {
      [Environment]::SetEnvironmentVariable($name, $sensitiveEnvironment[$name], 'Process')
    }
  }
  if (-not $AllowDirty) {
    $statusAfterInstall = git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) {
      throw 'git status failed after dependency installation.'
    }
    if (-not [string]::IsNullOrWhiteSpace(($statusAfterInstall -join "`n"))) {
      throw 'Locked dependency installation changed the working tree; refusing to continue with signing credentials.'
    }
  }
  $tauriCommand = Join-Path $repoRoot 'node_modules\.bin\tauri.CMD'
  if (-not (Test-Path -LiteralPath $tauriCommand -PathType Leaf)) {
    throw 'The project-local Tauri CLI was not found. Run pnpm install --frozen-lockfile.'
  }
  $tauriCliVersionText = (& $tauriCommand --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $tauriCliVersionText -ne 'tauri-cli 2.11.4') {
    throw "Tauri CLI 2.11.4 is required for the signed-NSIS plugin fix, got $tauriCliVersionText."
  }
  $tauriConfig = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $tauriVersion = $tauriConfig.version
  $cargoMetadata = cargo metadata --manifest-path src-tauri\Cargo.toml --no-deps --format-version 1 | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) {
    throw 'cargo metadata failed.'
  }
  $cargoPackage = $cargoMetadata.packages | Where-Object { $_.name -eq 'hipago' } | Select-Object -First 1
  if ($null -eq $cargoPackage) {
    throw 'The hipago package was not found in Cargo metadata.'
  }
  $versions = @(@($packageVersion, $tauriVersion, $cargoPackage.version) | Select-Object -Unique)
  if ($versions.Count -ne 1) {
    throw "Release versions do not match: package.json=$packageVersion, tauri.conf.json=$tauriVersion, Cargo.toml=$($cargoPackage.version)"
  }
  if ($packageVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Release version must match X.Y.Z: $packageVersion"
  }

  [void](Get-HipagoRequiredEnvironmentVariable 'TAURI_SIGNING_PRIVATE_KEY')
  [void](Get-HipagoRequiredEnvironmentVariable 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
  if ($null -eq $tauriConfig.plugins.updater.pubkey -or [string]::IsNullOrWhiteSpace($tauriConfig.plugins.updater.pubkey)) {
    throw 'The updater public key is missing from tauri.conf.json.'
  }
  if (@($tauriConfig.plugins.updater.endpoints).Count -eq 0) {
    throw 'At least one updater endpoint is required.'
  }
  foreach ($endpoint in $tauriConfig.plugins.updater.endpoints) {
    if ($endpoint -notmatch '^https://') {
      throw "Updater endpoint must use HTTPS: $endpoint"
    }
  }

  $updaterProbePath = Join-Path ([System.IO.Path]::GetTempPath()) ("hipago-updater-key-{0}.bin" -f [Guid]::NewGuid().ToString('N'))
  $updaterProbeSignature = "$updaterProbePath.sig"
  try {
    $probeBytes = [System.Text.Encoding]::UTF8.GetBytes("HiPaGo updater key preflight $([Guid]::NewGuid())")
    [System.IO.File]::WriteAllBytes($updaterProbePath, $probeBytes)
    Invoke-HipagoExternalCommand -FilePath $tauriCommand -Arguments @(
      'signer',
      'sign',
      $updaterProbePath
    ) -Description 'Updater key preflight signing'
    if (-not (Test-Path -LiteralPath $updaterProbeSignature -PathType Leaf)) {
      throw "Updater preflight signature was not created: $updaterProbeSignature"
    }
    Invoke-HipagoExternalCommand -FilePath 'cargo.exe' -Arguments @(
      'run',
      '--quiet',
      '--locked',
      '--release',
      '--manifest-path',
      (Join-Path $repoRoot 'scripts\updater-signature-verifier\Cargo.toml'),
      '--',
      $updaterProbePath,
      $updaterProbeSignature,
      $tauriConfig.plugins.updater.pubkey
    ) -Description 'Updater private/public key match preflight'
  }
  finally {
    foreach ($probeFile in @($updaterProbePath, $updaterProbeSignature)) {
      Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
    }
  }

  & (Join-Path $PSScriptRoot 'sign-windows.ps1') -CheckOnly
  if ($LASTEXITCODE -ne 0) {
    throw 'Windows signing preflight failed.'
  }

  Write-Host "Windows production release preflight passed for HiPaGo $packageVersion."
  Write-Host "LLVM resource include: $resourceInclude"
  if ($CheckOnly) {
    exit 0
  }

  & node.exe scripts\clean-tauri-bundle.mjs
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to clean stale Tauri bundle outputs.'
  }
  & $tauriCommand build --verbose
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE."
  }
  & (Join-Path $PSScriptRoot 'verify-windows-release.ps1')
  if ($LASTEXITCODE -ne 0) {
    throw 'Windows release artifact verification failed.'
  }
}
finally {
  Pop-Location
}
