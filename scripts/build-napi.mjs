#!/usr/bin/env node
// Cross-platform bypass-napi build.
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const napiDir = join(root, 'crates/bypass-napi');

console.log('Building bypass-napi native addon...');
execSync('corepack pnpm --package=@napi-rs/cli dlx napi build --release --platform', {
  cwd: napiDir,
  stdio: 'inherit',
});

const nodes = readdirSync(napiDir).filter((f) => f.endsWith('.node'));
console.log(`napi build complete! Output: ${nodes.join(', ') || 'check crates/bypass-napi/'}`);
