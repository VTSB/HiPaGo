# Android native bypass run sync

**Date:** 2026-06-22
**Area:** Android / bypass-core / tag sync

Android packages `bypass-core` through the generated UniFFI shared libraries in
`android/app/generated/jniLibs`. Those files are build outputs and can become
stale when Rust bypass code changes. If a developer runs `cap run android`
directly, the APK can keep using an older `libbypass_uniffi.so`, so fixes to
DoH, fragmentation, or tag-page native fetching do not reach the device.

`cap:run:android` now rebuilds the Android UniFFI library, rebuilds the static
web assets, runs `cap sync android`, and only then launches Capacitor. This keeps
local device runs aligned with the Rust bypass implementation used by tag sync.

The Android UniFFI wrapper also mirrors the NAPI wrapper's recovery behavior:
when a fetch or native download fails, it shuts down the cached `BypassClient`
and retries once with a fresh proxy/client. This prevents a transient SOCKS
connect failure from poisoning later tag-sync requests in the same Android app
process.

Operational note: the native rebuild requires `cargo-ndk` and an Android NDK
environment. The build script now checks for `cargo-ndk` before building; a
failure there means the APK was not rebuilt with the latest Rust bypass code.
