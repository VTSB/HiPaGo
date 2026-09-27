# Android release keystore

HiPaGo release APKs are signed by Gradle when all release signing properties are
provided. Local unsigned release builds are still allowed through
`./gradlew assembleRelease`, but signed release builds must use the explicit
release path below.

## Required properties

Gradle reads these properties directly or through `ORG_GRADLE_PROJECT_*`
environment variables:

- `HIPAGO_KEYSTORE_PATH`
- `HIPAGO_KEYSTORE_PASSWORD`
- `HIPAGO_KEY_ALIAS`
- `HIPAGO_KEY_ALIAS_PASSWORD`

The release script also sets `HIPAGO_REQUIRE_SIGNED_RELEASE=true`, which makes
Gradle fail before building if any required property is missing.

## Local signed build

From the repository root:

```sh
export ORG_GRADLE_PROJECT_HIPAGO_KEYSTORE_PATH=/absolute/path/to/hipago-release.jks
export ORG_GRADLE_PROJECT_HIPAGO_KEYSTORE_PASSWORD='...'
export ORG_GRADLE_PROJECT_HIPAGO_KEY_ALIAS='...'
export ORG_GRADLE_PROJECT_HIPAGO_KEY_ALIAS_PASSWORD='...'
pnpm build:android:release
```

Expected signed output:

```text
android/app/build/outputs/apk/release/app-release.apk
```

If signing properties are omitted and `./gradlew assembleRelease` is run
directly, Android Gradle Plugin emits:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

Do not publish the unsigned APK.

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

## Version and publication

Commit changes on `release`, create one unused `vX.Y.Z` tag higher than existing
numeric tags/releases, and push that tag explicitly (`git push origin vX.Y.Z`).
The tag must point at a commit containing the tag-triggered release workflow.
CI uses exactly X.Y.Z for the beta; a branch push alone does not publish or bump
the version. Do not edit Gradle/package versions for CI or move a used tag.

After beta CI and device testing succeed, run `git switch master`,
`git merge --ff-only vX.Y.Z`, then `git push origin master`. This promotes the
same release and APK without rebuilding. The pushed master commit must equal
the tested tag commit; merge/squash commits with different SHAs are rejected.
Repeating an already completed promotion does not create another release.
For a failed beta, keep its tag and draft; fix the issue in a new commit and
push a new higher version tag.
