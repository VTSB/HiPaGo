# Tauri updater key operations

HiPaGo's updater signature is separate from Windows Authenticode signing. A public Windows installer needs both. The application embeds the updater public key from `src-tauri/tauri.conf.json`; GitHub Actions receives only the matching private key through the protected `production` environment.

## Existing key policy

The current public key is already embedded in version 9.9.9. If any build using this key has been distributed, do not replace it until the matching private key has been recovered. Existing clients will reject releases signed with an unrelated new key.

Losing the private key breaks the automatic-update chain. A public-key rotation must be delivered by a release signed with the old key before future releases switch to the new key.

## First-time generation

Only use this procedure if no production client depends on the current public key, or as part of a planned rotation.

```powershell
New-Item -ItemType Directory -Path D:\hipago-release-secrets -Force
pnpm tauri signer generate -w D:\hipago-release-secrets\hipago-updater.key
```

Use a strong, unique password when prompted. The generated private key and password must never be committed, pasted into an issue, or stored together in a shared folder.

After generation:

1. Put the generated public key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
2. Add the complete private-key content to the protected GitHub environment secret `TAURI_SIGNING_PRIVATE_KEY`.
3. Add its password to `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Store two encrypted offline backups of the private key and keep the password in a separate password manager.
5. Run a private release rehearsal and confirm that every generated updater payload has a non-empty `.sig` file before creating a public tag. With the current Tauri v2 configuration, Windows signs both the NSIS `*-setup.exe` and the MSI directly; it does not use the legacy `.nsis.zip`/`.msi.zip` format.

The release workflow refuses tag builds when either updater secret is missing. The `release` branch uses `src-tauri/tauri.local-only.conf.json`, which deliberately disables updater artifacts and cannot be published by the release job.

## GitHub environment protection

Create a GitHub Actions environment named `production` and configure:

- required reviewers;
- deployment branch/tag policy restricted to protected `v*` tags;
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as environment secrets, not repository variables.

Also create a repository ruleset that restricts `v*` tag creation/deletion to release maintainers. A release tag must point at a reviewed commit from the protected release/default branch; the protected environment alone does not prove the tagged source was reviewed.

Enable GitHub immutable releases for the canonical `VTSB/HiPaGo` repository. This prevents a published installer, `latest.json`, checksum, or release tag from being replaced after the workflow has verified it.

The final publish job runs only after Linux, Windows, Android, macOS-validation, and iOS-validation jobs have passed. Only the distributable Linux, Windows, and Android artifacts use the `release-assets-*` channel. `scripts/build-latest-json.mjs` requires Linux plus both Windows installer-family signatures, so a partial manifest cannot replace the last valid release. Assets are checked against an exact filename allowlist, uploaded to a private draft, re-downloaded, compared byte-for-byte through the local checksum manifest, and only then published. Dependabot is configured to propose reviewed updates for the commit-SHA-pinned GitHub Actions.

macOS and iOS outputs are compile-validation artifacts only. They are deliberately excluded from GitHub Releases and `latest.json` until Apple Developer ID/App Store signing and notarization/provisioning are configured and independently verified. A Tauri updater `.sig` is not a substitute for Apple's platform trust chain, and an unsigned `.xcarchive` is not a distributable iOS application.

## Release checks

For every production tag, verify that the release contains:

- `latest.json` with `linux-x86_64`, `windows-x86_64-nsis`, and `windows-x86_64-msi` entries; the generic `windows-x86_64` NSIS fallback is retained for older clients;
- a matching asset for every URL in `latest.json`;
- non-empty, cryptographically verified `.sig` files beside the AppImage, NSIS setup executable, and MSI;
- `SHA256SUMS.txt` covering all published assets.

See the official [Tauri updater guide](https://v2.tauri.app/plugin/updater/) for the key format and runtime behavior.
