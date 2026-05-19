#!/usr/bin/env node
// Cross-platform postinstall
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Copy sql.js wasm to public/
const wasmSrc = join(root, 'node_modules/sql.js/dist/sql-wasm-browser.wasm');
const wasmDest = join(root, 'public/sql-wasm-browser.wasm');
mkdirSync(dirname(wasmDest), { recursive: true });
copyFileSync(wasmSrc, wasmDest);
console.log('Copied sql-wasm-browser.wasm to public/');

// 2. Sync bypass-napi files (package.json/index.js/index.d.ts + .node binaries) to node_modules
const napiSrc = join(root, 'crates/bypass-napi');
const napiDest = join(root, 'node_modules/@hipago/bypass-napi');
mkdirSync(napiDest, { recursive: true });
const nodeFiles = readdirSync(napiSrc).filter(f => f.endsWith('.node'));
for (const f of ['package.json', 'index.js', 'index.d.ts', ...nodeFiles]) {
  const s = join(napiSrc, f);
  if (existsSync(s)) {
    copyFileSync(s, join(napiDest, f));
  }
}
console.log('Synced bypass-napi package files + native binaries to node_modules');
