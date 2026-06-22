#!/usr/bin/env node
// Cross-compile bypass-uniffi for Android targets.
// Requires: cargo-ndk, Android NDK
import { mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function ensureCargoNdk() {
  try {
    execSync('cargo ndk --version', { cwd: root, stdio: 'pipe' });
  } catch {
    console.error(
      [
        'Android bypass build requires cargo-ndk.',
        'Install it with: cargo install cargo-ndk',
        'Also make sure Android NDK is installed and ANDROID_NDK_HOME or Android SDK local.properties is configured.',
      ].join('\n'),
    );
    process.exit(1);
  }
}

console.log('Building bypass-uniffi for Android...');
ensureCargoNdk();

execSync(
  'cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build --release -p bypass-uniffi',
  { cwd: root, stdio: 'inherit' },
);

// Copy .so files to the generated jniLibs dir (outside src/, gitignored;
// registered as a jniLibs srcDir in app/build.gradle).
const jniLibs = join(root, 'android/app/generated/jniLibs');
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

// Generate Kotlin bindings into the generated source dir (outside src/,
// gitignored; registered as a java srcDir in app/build.gradle).
console.log('Generating Kotlin bindings...');
execSync(
  [
    'cargo run -p bypass-uniffi --bin uniffi-bindgen generate',
    `--library target/aarch64-linux-android/release/libbypass_uniffi.so`,
    '--language kotlin',
    `--out-dir android/app/generated/java/`,
  ].join(' '),
  { cwd: root, stdio: 'inherit' },
);

console.log('Android build complete!');
