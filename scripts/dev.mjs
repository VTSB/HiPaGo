#!/usr/bin/env node
// Cross-platform dev script.
// 1. Builds bypass-napi if .node file doesn't exist
// 2. Starts next dev + cargo-watch (if installed) in parallel
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const napiDir = join(root, 'crates/bypass-napi');

// Collect newest mtime from Rust source dirs
function newestMtime(...dirs) {
  let max = 0;
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) {
          const t = statSync(join(entry.parentPath ?? entry.path, entry.name)).mtimeMs;
          if (t > max) max = t;
        }
      }
    } catch {}
  }
  return max;
}

// 1. Build napi if .node missing or Rust source changed
const nodeFile = readdirSync(napiDir).find((f) => f.endsWith('.node'));
const hasNode = !!nodeFile;
let needsBuild = !hasNode;
if (hasNode) {
  const nodeMtime = statSync(join(napiDir, nodeFile)).mtimeMs;
  const srcMtime = newestMtime(
    join(root, 'crates/bypass-core/src'),
    join(root, 'crates/bypass-napi/src'),
  );
  if (srcMtime > nodeMtime) {
    needsBuild = true;
    console.log('[bypass] Rust source changed — rebuilding napi addon...');
  }
}
if (needsBuild) {
  try {
    if (!hasNode) {
      console.log('[bypass] Installing napi-rs/cli...');
      execSync('npm install', { cwd: napiDir, stdio: 'inherit' });
    }
    if (!hasNode) console.log('[bypass] Building napi addon (first time)...');
    execSync('npx napi build --release --platform', {
      cwd: napiDir,
      stdio: 'inherit',
    });
    console.log('[bypass] napi build complete.');
  } catch {
    console.warn('[bypass] napi build failed — skipping. JS fallback will be used.');
  }
}

// 2. Start Next.js dev server
const next = spawn('node', ['node_modules/next/dist/bin/next', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

// Cleanup on exit
process.on('SIGINT', () => next.kill());
process.on('SIGTERM', () => next.kill());
next.on('exit', (code) => process.exit(code ?? 0));
