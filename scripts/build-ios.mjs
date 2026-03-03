#!/usr/bin/env node
// Cross-compile bypass-uniffi for iOS.
// Requires: Xcode, Rust iOS targets
import { mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Building bypass-uniffi for iOS...');

execSync(
  'cargo build --release --target aarch64-apple-ios -p bypass-uniffi',
  { cwd: root, stdio: 'inherit' },
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
  { cwd: root, stdio: 'inherit' },
);

console.log('iOS build complete!');
