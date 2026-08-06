# Windows production release signing

HiPaGo's public Windows release has two independent trust layers:

1. **Authenticode** signs `hipago.exe`, the NSIS setup executable, and the MSI. This is the Windows/SmartScreen identity.
2. **Tauri updater signing** signs the updater payload with the private key matching the public key embedded in the app.

`pnpm release:windows` requires both layers and stops before producing a distributable build when either signer is unavailable. Its preflight signs a unique challenge with the updater private key and verifies it against the embedded public key. After the build it verifies trusted Authenticode timestamps, requires the Tauri v2 NSIS and MSI updater signatures (`*-setup.exe.sig` and `*.msi.sig`), cryptographically checks both, and writes SHA-256 checksums.

## Required local tools

- Windows 10/11 SDK with `signtool.exe`
- Visual Studio Build Tools with the Desktop development with C++ workload and the x64 MSVC toolchain
- LLVM/Clang in `C:\Program Files\LLVM`
- CMake 3.24+, NASM 2.15+, LLVM/Clang 17+, Rust 1.96.0 with the `x86_64-pc-windows-msvc` target, Node.js 22, and the exact pnpm/Tauri CLI versions pinned by the repository
- a production code-signing provider
- the existing Tauri updater private key and password

The release script discovers the newest x64 `signtool.exe` in the Windows SDK and configures `LIBCLANG_PATH`, `CLANG_PATH`, and the Clang resource include path for the current process.

## Choose one Authenticode provider

### Azure Artifact Signing

Use this when the publisher is eligible for Azure Artifact Signing. Install the official CLI and configure:

```powershell
cargo install artifact-signing-cli --version 0.11.0 --locked
$env:HIPAGO_WINDOWS_SIGNING_PROVIDER = 'azure-artifact-signing'
$env:HIPAGO_AZURE_ARTIFACT_SIGNING_ENDPOINT = 'https://<region>.codesigning.azure.net'
$env:HIPAGO_AZURE_ARTIFACT_SIGNING_ACCOUNT = '<account>'
$env:HIPAGO_AZURE_ARTIFACT_SIGNING_PROFILE = '<certificate-profile>'
$env:HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT = '<exact certificate subject>'
$env:AZURE_CLIENT_ID = '<application-id>'
$env:AZURE_CLIENT_SECRET = '<client-secret>'
$env:AZURE_TENANT_ID = '<tenant-id>'
```

In GitHub's protected `production` environment, put the three Azure credentials in secrets and the endpoint/account/profile in variables. Set `WINDOWS_SIGNING_PROVIDER=azure-artifact-signing` and `WINDOWS_EXPECTED_SIGNER_SUBJECT` as environment variables. The release verifier requires the exact configured subject so a valid signature from an unintended identity cannot pass.

### Certificate store or hardware-backed certificate

Use this locally for a CA-issued certificate whose private key is available through the Windows certificate store. The checked-in GitHub workflow runs on a GitHub-hosted runner, so its `certificate-store` mode requires the two PFX secrets below. A hardware-backed certificate needs a separately reviewed self-hosted-runner job; do not point the existing hosted job at hardware that it cannot access.

```powershell
$env:HIPAGO_WINDOWS_SIGNING_PROVIDER = 'certificate-store'
$env:HIPAGO_WINDOWS_CERTIFICATE_THUMBPRINT = '<40-character SHA-1 thumbprint>'
$env:HIPAGO_WINDOWS_EXPECTED_SIGNER_SUBJECT = '<exact certificate subject>'
```

The certificate must be in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`, have an accessible private key, be valid now, and include the Code Signing EKU.

The signer uses DigiCert's RFC 3161 timestamp service by default. If the certificate issuer requires another service, set `HIPAGO_WINDOWS_TIMESTAMP_URL` locally or the `WINDOWS_TIMESTAMP_URL` variable in the GitHub `production` environment.

GitHub-hosted runners import an existing exportable PFX using the required `WINDOWS_CODE_SIGNING_PFX_BASE64` and `WINDOWS_CODE_SIGNING_PFX_PASSWORD` environment secrets. Always set the independently recorded `WINDOWS_CERTIFICATE_THUMBPRINT` and `WINDOWS_EXPECTED_SIGNER_SUBJECT` environment variables too; the workflow rejects a PFX whose signer does not match both. This path is intended for eligible existing certificates. Public OV/EV certificates issued under modern key-protection rules are commonly hardware- or cloud-backed; use Azure Artifact Signing or a separately secured self-hosted runner instead of exporting the private key. See [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

Never use a self-signed certificate for public distribution.

## Configure updater credentials

Set these only in the process that performs the production build:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw D:\hipago-release-secrets\hipago-updater.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<updater-key-password>'
```

Do not generate a replacement key merely because the current private key is absent. Follow [the updater key guide](./GUIDE__updater-keys.md) and preserve compatibility with installed clients.

## Local production build

Start from a clean checkout whose `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` versions match.

```powershell
pnpm install --frozen-lockfile
pnpm release:windows:check
pnpm release:windows
```

Verified artifacts are written below `src-tauri\target\release\bundle`. The production command fails if the worktree is dirty. `-AllowDirty` exists only for local preflight diagnostics and must not be used to publish an artifact.

`pnpm build:tauri:local` is explicitly non-distributable: it disables Authenticode and updater artifacts through `src-tauri/tauri.local-only.conf.json`.

## GitHub release setup

Create and protect a GitHub Actions environment named `production`. Add required reviewers and permit deployments only from protected `v*` tags. Store all private credentials as environment secrets. Add a repository ruleset that restricts creation and deletion of `v*` tags to release maintainers, and require each release tag to point at a reviewed commit on the protected default branch. Enable GitHub **immutable releases** so assets and tags cannot be changed after publication; the workflow's draft-upload, verification, then publish flow is compatible with that protection.

The workflow behavior is intentional:

- pushes to `release` compile non-distributable rehearsal artifacts without production secrets;
- `vX.Y.Z` tags enter the protected environment and require every signing credential;
- Windows artifacts are checked with `signtool verify /pa /all /v` before staging;
- build jobs upload internal Actions artifacts only;
- one final job validates the complete asset set, creates `latest.json` and checksums, uploads a private draft, downloads and re-verifies the remote asset set, then makes the draft public.

Before publishing a first public build, confirm the Publisher shown by Windows matches the intended long-term legal identity. Changing the signing identity later resets reputation and can produce an alarming upgrade experience.
