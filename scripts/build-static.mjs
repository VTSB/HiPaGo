#!/usr/bin/env node
// Cross-platform static export build for native platforms (Tauri/Capacitor).
// Temporarily hides API routes and dynamic pages incompatible with static export.
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backup = join(root, '.build-backup');

const HIDE_DIRS = [
  'src/app/api',
  'src/app/(main)/gallery/[id]',
  'src/app/(reader)/gallery/[id]',
];

function hide() {
  mkdirSync(backup, { recursive: true });
  for (const dir of HIDE_DIRS) {
    const src = join(root, dir);
    const dest = join(backup, dir);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
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
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      console.log(`Restored: ${dir}`);
    }
  }
  if (existsSync(backup)) rmSync(backup, { recursive: true });
}

function createCleanUrlAliases() {
  const outDir = join(root, 'out');
  if (!existsSync(outDir)) return;

  for (const entry of readdirSync(outDir)) {
    if (!entry.endsWith('.html')) continue;
    if (entry === 'index.html' || entry === '404.html' || entry === '_not-found.html') continue;

    const routeName = basename(entry, '.html');
    const routeDir = join(outDir, routeName);
    if (existsSync(routeDir) && !statSync(routeDir).isDirectory()) continue;
    mkdirSync(routeDir, { recursive: true });
    cpSync(join(outDir, entry), join(routeDir, 'index.html'));
    console.log(`Created clean URL alias: out/${routeName}/index.html`);
  }
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

    const readerFallbackDir = join(root, 'out/reader');
    mkdirSync(readerFallbackDir, { recursive: true });
    cpSync(indexHtml, join(readerFallbackDir, 'index.html'));
    console.log('Created SPA fallback: out/reader/index.html');
  }

  createCleanUrlAliases();
} finally {
  restore();
}
