param(
  [Parameter(Position = 0)][string]$FilePath,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-signing-common.ps1')

if ($env:OS -ne 'Windows_NT') {
  throw 'Windows Authenticode signing must run on Windows.'
}

$provider = [Environment]::GetEnvironmentVariable('HIPAGO_WINDOWS_SIGNING_PROVIDER', 'Process')
if ([string]::IsNullOrWhiteSpace($provider)) {
  $provider = 'certificate-store'
}
$provider = $provider.Trim().ToLowerInvariant()
$signTool = Get-HipagoSignTool
[void](Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT')

if ($provider -eq 'certificate-store') {
  $certificateInfo = Get-HipagoCodeSigningCertificate
  $expectedSubject = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT'
  if ($certificateInfo.Certificate.Subject -ne $expectedSubject) {
    throw "Code-signing certificate subject mismatch. Expected '$expectedSubject', got '$($certificateInfo.Certificate.Subject)'."
  }
  Write-Host "Windows signer: certificate-store ($($certificateInfo.StoreName)\My, thumbprint $($certificateInfo.Thumbprint))"
  if ($CheckOnly) {
    Write-Host "signtool: $signTool"
    return
  }

  if ([string]::IsNullOrWhiteSpace($FilePath) -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "File to sign was not found: $FilePath"
  }

  $timestampUrl = [Environment]::GetEnvironmentVariable('HIPAGO_WINDOWS_TIMESTAMP_URL', 'Process')
  if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
    $timestampUrl = 'http://timestamp.digicert.com'
  }

  $arguments = @('sign', '/sha1', $certificateInfo.Thumbprint, '/s', 'My')
  if ($certificateInfo.StoreName -eq 'LocalMachine') {
    $arguments += '/sm'
  }
  $arguments += @('/fd', 'SHA256', '/tr', $timestampUrl, '/td', 'SHA256', '/d', 'HiPaGo', '/du', 'https://github.com/VTSB/HiPaGo', $FilePath)
  Invoke-HipagoExternalCommand -FilePath $signTool -Arguments $arguments -Description "Authenticode signing for $FilePath"
}
elseif ($provider -eq 'azure-artifact-signing') {
  $endpoint = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_AZURE_ARTIFACT_SIGNING_ENDPOINT'
  $account = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_AZURE_ARTIFACT_SIGNING_ACCOUNT'
  $profile = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_AZURE_ARTIFACT_SIGNING_PROFILE'
  $endpointUri = $null
  if (-not [Uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref]$endpointUri) -or
      $endpointUri.Scheme -ne 'https' -or
      $endpointUri.Port -ne 443 -or
      $endpointUri.UserInfo -ne '' -or
      ($endpointUri.Host -ne 'codesigning.azure.net' -and -not $endpointUri.Host.EndsWith('.codesigning.azure.net', [StringComparison]::OrdinalIgnoreCase))) {
    throw 'HIPAGO_AZURE_ARTIFACT_SIGNING_ENDPOINT must be an HTTPS endpoint under codesigning.azure.net on port 443.'
  }
  [void](Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT')
  [void](Get-HipagoRequiredEnvironmentVariable 'AZURE_CLIENT_ID')
  [void](Get-HipagoRequiredEnvironmentVariable 'AZURE_CLIENT_SECRET')
  [void](Get-HipagoRequiredEnvironmentVariable 'AZURE_TENANT_ID')

  $artifactSigner = Get-Command artifact-signing-cli -ErrorAction SilentlyContinue
  if ($null -eq $artifactSigner) {
    throw 'artifact-signing-cli was not found. Install it with cargo install artifact-signing-cli --version 0.11.0 --locked.'
  }
  $artifactSignerVersion = & $artifactSigner.Source --version
  if ($LASTEXITCODE -ne 0 -or $artifactSignerVersion -notmatch '\b0\.11\.0\b') {
    throw "artifact-signing-cli 0.11.0 is required, got: $artifactSignerVersion"
  }
  Write-Host "Windows signer: Azure Artifact Signing ($account / $profile)"
  if ($CheckOnly) {
    Write-Host "artifact-signing-cli: $($artifactSigner.Source)"
    Write-Host "signtool: $signTool"
    return
  }

  if ([string]::IsNullOrWhiteSpace($FilePath) -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "File to sign was not found: $FilePath"
  }
  Invoke-HipagoExternalCommand -FilePath $artifactSigner.Source -Arguments @('-e', $endpoint, '-a', $account, '-c', $profile, '-d', 'HiPaGo', $FilePath) -Description "Azure Artifact Signing for $FilePath"
}
else {
  throw "Unsupported HIPAGO_WINDOWS_SIGNING_PROVIDER '$provider'. Use 'certificate-store' or 'azure-artifact-signing'."
}

Assert-HipagoAuthenticodeSignature -FilePath $FilePath -SignToolPath $signTool
Write-Host "Authenticode signature and timestamp verified: $FilePath"
