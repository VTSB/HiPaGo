Set-StrictMode -Version Latest

function Get-HipagoRequiredEnvironmentVariable {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required environment variable '$Name' is not set."
  }
  return $value
}

function Get-HipagoSignTool {
  $override = [Environment]::GetEnvironmentVariable('HIPAGO_SIGNTOOL_PATH', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    if (-not (Test-Path -LiteralPath $override -PathType Leaf)) {
      throw "HIPAGO_SIGNTOOL_PATH does not point to a file: $override"
    }
    return (Resolve-Path -LiteralPath $override).Path
  }

  $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -ne $fromPath) {
    return $fromPath.Source
  }

  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $kitsRoot = Join-Path $programFilesX86 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
    $sdkDirectories = Get-ChildItem -LiteralPath $kitsRoot -Directory |
      Where-Object { $_.Name -match '^\d+(\.\d+)+$' } |
      Sort-Object { [version]$_.Name } -Descending
    foreach ($sdkDirectory in $sdkDirectories) {
      $candidate = Join-Path $sdkDirectory.FullName 'x64\signtool.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
      }
    }
  }

  throw 'signtool.exe was not found. Install the Windows 10/11 SDK or set HIPAGO_SIGNTOOL_PATH.'
}

function Invoke-HipagoExternalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Get-HipagoCodeSigningCertificate {
  $rawThumbprint = Get-HipagoRequiredEnvironmentVariable 'HIPAGO_WINDOWS_CERTIFICATE_THUMBPRINT'
  $thumbprint = ($rawThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  if ($thumbprint.Length -ne 40) {
    throw 'HIPAGO_WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint.'
  }

  $candidateErrors = @()
  foreach ($storeName in @('CurrentUser', 'LocalMachine')) {
    $certificatePath = "Cert:\$storeName\My\$thumbprint"
    $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction SilentlyContinue
    if ($null -eq $certificate) {
      continue
    }
    if (-not $certificate.HasPrivateKey) {
      $candidateErrors += "Code-signing certificate $thumbprint in $storeName\My has no accessible private key."
      continue
    }

    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
      $candidateErrors += "Code-signing certificate $thumbprint in $storeName\My is outside its validity period ($($certificate.NotBefore) - $($certificate.NotAfter))."
      continue
    }

    $codeSigningOid = '1.3.6.1.5.5.7.3.3'
    $ekuValues = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value })
    if ($ekuValues -notcontains $codeSigningOid) {
      $candidateErrors += "Certificate $thumbprint in $storeName\My is not valid for Code Signing EKU ($codeSigningOid)."
      continue
    }

    if ($certificate.NotAfter -lt $now.AddDays(30)) {
      Write-Warning "Code-signing certificate expires in less than 30 days: $($certificate.NotAfter.ToString('u'))"
    }

    return [pscustomobject]@{
      Certificate = $certificate
      StoreName = $storeName
      Thumbprint = $thumbprint
    }
  }

  if ($candidateErrors.Count -gt 0) {
    throw ($candidateErrors -join ' ')
  }
  throw "Code-signing certificate $thumbprint was not found in CurrentUser\My or LocalMachine\My."
}

function Assert-HipagoAuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$SignToolPath = ''
  )

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "Signed file was not found: $FilePath"
  }
  if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
    $SignToolPath = Get-HipagoSignTool
  }

  Invoke-HipagoExternalCommand -FilePath $SignToolPath -Arguments @('verify', '/pa', '/all', '/v', $FilePath) -Description "Authenticode verification for $FilePath"

  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode status for $FilePath is $($signature.Status): $($signature.StatusMessage)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signature for $FilePath has no signer certificate."
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode signature for $FilePath has no trusted timestamp."
  }

  $expectedThumbprint = [Environment]::GetEnvironmentVariable('HIPAGO_WINDOWS_CERTIFICATE_THUMBPRINT', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($expectedThumbprint)) {
    $expectedThumbprint = ($expectedThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    $actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($actualThumbprint -ne $expectedThumbprint) {
      throw "Authenticode signer thumbprint mismatch for $FilePath. Expected $expectedThumbprint, got $actualThumbprint."
    }
  }

  $expectedSubject = [Environment]::GetEnvironmentVariable('HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($expectedSubject) -and $signature.SignerCertificate.Subject -ne $expectedSubject) {
    throw "Authenticode signer subject mismatch for $FilePath. Expected '$expectedSubject', got '$($signature.SignerCertificate.Subject)'."
  }
}
