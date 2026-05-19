// uniffi-bindgen CLI entry point.
//
// The build scripts (scripts/build-android.mjs, scripts/build-ios.mjs) invoke
// `cargo run -p bypass-uniffi --bin uniffi-bindgen generate ...` to produce the
// Kotlin / Swift bindings. Cargo auto-discovers this file as the bin target.
// `uniffi_bindgen_main` is gated behind the uniffi `cli` feature (enabled in
// Cargo.toml).
fn main() {
    uniffi::uniffi_bindgen_main()
}
