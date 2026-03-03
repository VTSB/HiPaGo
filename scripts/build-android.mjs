#!/usr/bin/env node
// Cross-compile bypass-uniffi for Android targets.
// Requires: cargo-ndk, Android NDK
import { mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Building bypass-uniffi for Android...');

execSync(
  'cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build --release -p bypass-uniffi',
  { cwd: root, stdio: 'inherit' },
);

// Copy .so files to Android jniLibs
const jniLibs = join(root, 'android/app/src/main/jniLibs');
const targets = [
  ['aarch64-linux-android', 'arm64-v8a'],
  ['armv7-linux-androideabi', 'armeabi-v7a'],
  ['x86_64-linux-android', 'x86_64'],
];

for (const [rustTarget, abi] of targets) {
  const destDir = join(jniLibs, abi);
  mkdirSync(destDir, { recursive: true });
  cpSync(
    join(root, `target/${rustTarget}/release/libbypass_uniffi.so`),
    join(destDir, 'libbypass_uniffi.so'),
  );
}

// Generate Kotlin bindings
console.log('Generating Kotlin bindings...');
execSync(
  [
    'cargo run -p bypass-uniffi --bin uniffi-bindgen generate',
    `--library target/aarch64-linux-android/release/libbypass_uniffi.so`,
    '--language kotlin',
    `--out-dir android/app/src/main/java/`,
  ].join(' '),
  { cwd: root, stdio: 'inherit' },
);

console.log('Android build complete!');
