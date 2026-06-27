# Android release keystore

HiPaGo release APKs are always signed by Gradle.

- If all distribution signing properties are provided, Gradle signs with the
  private release keystore.
- If distribution signing properties are omitted, Gradle signs the release APK
  with the Android debug key. This is the expected local/agent behavior because
  agents and non-release operators do not have access to the private
  distribution key.

Do not ask for private keystore credentials during routine local or agent
builds. Use the debug-key-signed release APK unless a release operator
explicitly provides the distribution-key properties.

## Required properties

Gradle reads these properties directly or through `ORG_GRADLE_PROJECT_*`
environment variables:

- `HIPAGO_KEYSTORE_PATH`
- `HIPAGO_KEYSTORE_PASSWORD`
- `HIPAGO_KEY_ALIAS`
- `HIPAGO_KEY_ALIAS_PASSWORD`

If any distribution signing property is provided, all four must be provided.
Partial distribution signing configuration fails before building. When none are
provided, Gradle falls back to the Android debug key.

## Local signed build

From the repository root:

```sh
export ORG_GRADLE_PROJECT_HIPAGO_KEYSTORE_PATH=/absolute/path/to/hipago-release.jks
export ORG_GRADLE_PROJECT_HIPAGO_KEYSTORE_PASSWORD='...'
export ORG_GRADLE_PROJECT_HIPAGO_KEY_ALIAS='...'
export ORG_GRADLE_PROJECT_HIPAGO_KEY_ALIAS_PASSWORD='...'
pnpm build:android:release
```

Expected signed output with distribution credentials:

```text
android/app/build/outputs/apk/release/app-release.apk
```

If signing properties are omitted, `pnpm build:android:release` and
`./gradlew assembleRelease` emit a release APK signed with the Android debug key:

```text
android/app/build/outputs/apk/release/app-release.apk
```

This debug-key-signed APK is installable for local testing, but it is not a
store/distribution artifact.

## GitHub Actions secrets

The release workflow expects these repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_ALIAS_PASSWORD`

Create the base64 value without line wrapping:

```sh
base64 -w 0 /absolute/path/to/hipago-release.jks
```

On macOS, use:

```sh
base64 -i /absolute/path/to/hipago-release.jks | tr -d '\n'
```

The workflow decodes `ANDROID_KEYSTORE_BASE64` to
`android/app/hipago-release.jks`, runs `assembleRelease`, and verifies
`app-release.apk` with `apksigner`.
