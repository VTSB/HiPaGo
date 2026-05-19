#!/usr/bin/env node
// Cross-compile bypass-uniffi for iOS.
// Requires: Xcode, Rust iOS targets
import { mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// iOS deployment target — must match the app's minimum (ios/App Xcode project
// IPHONEOS_DEPLOYMENT_TARGET = 13.0). Unifies rustc and cc-rs (zstd-sys,
// boring-sys2) on one target. Without it the C objects compile for the SDK's
// newest iOS while the Rust link defaults to iOS 10.0, and the link fails with
// undefined `___chkstk_darwin` (a symbol the newer C objects reference).
const buildEnv = { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: '13.0' };

console.log('Building bypass-uniffi for iOS...');

execSync(
  'cargo build --release --target aarch64-apple-ios -p bypass-uniffi',
  { cwd: root, stdio: 'inherit', env: buildEnv },
);

// Copy static library
const frameworkDir = join(root, 'ios/App/App/Frameworks');
mkdirSync(frameworkDir, { recursive: true });
cpSync(
  join(root, 'target/aarch64-apple-ios/release/libbypass_uniffi.a'),
  join(frameworkDir, 'libbypass_uniffi.a'),
);

// Generate Swift bindings
console.log('Generating Swift bindings...');
execSync(
  [
    'cargo run -p bypass-uniffi --bin uniffi-bindgen generate',
    '--library target/aarch64-apple-ios/release/libbypass_uniffi.a',
    '--language swift',
    '--out-dir ios/App/App/',
  ].join(' '),
  { cwd: root, stdio: 'inherit', env: buildEnv },
);

console.log('iOS build complete!');
