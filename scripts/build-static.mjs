#!/usr/bin/env node
// Cross-platform static export build for native platforms (Tauri/Capacitor).
// Temporarily hides API routes and dynamic pages incompatible with static export.
import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backup = join(root, '.build-backup');

const HIDE_DIRS = [
  'src/app/api',
  'src/app/(main)/gallery',
  'src/app/(reader)/gallery',
];

function hide() {
  mkdirSync(backup, { recursive: true });
  for (const dir of HIDE_DIRS) {
    const src = join(root, dir);
    const dest = join(backup, dir);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
      console.log(`Hidden: ${dir}`);
    }
  }
}

function restore() {
  for (const dir of HIDE_DIRS) {
    const src = join(backup, dir);
    const dest = join(root, dir);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
      console.log(`Restored: ${dir}`);
    }
  }
  if (existsSync(backup)) rmSync(backup, { recursive: true });
}

try {
  hide();
  execSync('node node_modules/next/dist/bin/next build', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NEXT_OUTPUT: 'export' },
  });
  console.log('Static export complete -> out/');

  // SPA fallback for native webviews
  const indexHtml = join(root, 'out/index.html');
  if (existsSync(indexHtml)) {
    const fallbackDir = join(root, 'out/gallery');
    mkdirSync(fallbackDir, { recursive: true });
    cpSync(indexHtml, join(fallbackDir, 'index.html'));
    console.log('Created SPA fallback: out/gallery/index.html');
  }
} finally {
  restore();
}
