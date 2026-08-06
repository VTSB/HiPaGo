#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const releaseRoot = resolve(repoRoot, 'src-tauri', 'target', 'release');
const bundleRoot = resolve(releaseRoot, 'bundle');
const relativeBundleRoot = relative(repoRoot, bundleRoot);

if (
  dirname(bundleRoot) !== releaseRoot ||
  relativeBundleRoot === '..' ||
  relativeBundleRoot.startsWith(`..${sep}`) ||
  isAbsolute(relativeBundleRoot)
) {
  throw new Error(`Refusing to clean unexpected path: ${bundleRoot}`);
}

rmSync(bundleRoot, { recursive: true, force: true });
console.log(`Cleaned stale Tauri bundles: ${bundleRoot}`);
