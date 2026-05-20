#!/usr/bin/env node
/*
 * Open-source license collector.
 *
 * Walks node_modules (production deps only) and runs `cargo metadata` in
 * src-tauri/ to collect each dep's name + version + license + repo URL.
 * Outputs a sorted, deduplicated JSON manifest to src/lib/licenses.json
 * for the /licenses page to statically import.
 *
 * Re-runs automatically as the `prebuild` script in package.json.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const TAURI_MANIFEST = join(ROOT, 'src-tauri/Cargo.toml');
const OUT_PATH = join(ROOT, 'src/lib/licenses.json');

// Names of THIS project (and its workspace members) — never include in the list.
const SELF_NAMES = new Set(['hipago', 'HiPaGo', 'bypass-core', 'bypass-uniffi', 'bypass-napi', '@hipago/bypass-napi']);

function normalizeRepoUrl(repo) {
  if (!repo) return undefined;
  let url = typeof repo === 'string' ? repo : repo.url;
  if (!url) return undefined;
  // Strip git-flavored prefixes / suffixes that aren't web-resolvable.
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  // `github:owner/repo` shorthand
  const ghShort = url.match(/^github:([^/]+)\/([^/]+)$/);
  if (ghShort) return `https://github.com/${ghShort[1]}/${ghShort[2]}`;
  // Bare `owner/repo` (npm's package.json shorthand for github)
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) return `https://github.com/${url}`;
  // `gitlab:owner/repo` / `bitbucket:owner/repo`
  const otherShort = url.match(/^(gitlab|bitbucket):([^/]+)\/([^/]+)$/);
  if (otherShort) return `https://${otherShort[1]}.com/${otherShort[2]}/${otherShort[3]}`;
  return url;
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

/**
 * Walk node_modules one level (and through .pnpm/* virtual store) collecting
 * package.json metadata. Skips dev-only deps by checking devDependencies of
 * the root package.json — but transitive deps are kept (a runtime dep of a
 * dev dep is a runtime dep of the bundle).
 */
function collectNpm() {
  const rootPkg = readJsonSafe(join(ROOT, 'package.json')) || {};
  const devDeps = new Set(Object.keys(rootPkg.devDependencies || {}));

  const out = new Map(); // key=name@version

  function visit(pkgDir) {
    const pkgPath = join(pkgDir, 'package.json');
    const pkg = readJsonSafe(pkgPath);
    if (!pkg || !pkg.name || !pkg.version) return;
    if (SELF_NAMES.has(pkg.name)) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (out.has(key)) return;
    // Skip top-level direct dev deps; we still walk into them because
    // a dev tool may have prod-shipping transitives, but the dev tool
    // itself doesn't ship to the user.
    if (devDeps.has(pkg.name)) {
      // still continue into its node_modules below
    } else {
      const licenseField = pkg.license ?? pkg.licenses;
      const license = typeof licenseField === 'string'
        ? licenseField
        : Array.isArray(licenseField)
          ? licenseField.map((l) => l.type || l).filter(Boolean).join(' OR ')
          : licenseField?.type || 'UNKNOWN';
      out.set(key, {
        name: pkg.name,
        version: pkg.version,
        license,
        repository: normalizeRepoUrl(pkg.repository) || pkg.homepage,
      });
    }

    // Recurse into nested node_modules (npm layout) and into .pnpm-virtual
    // store layout — both produce a `node_modules/<name>` dir under the dep.
    const nestedNm = join(pkgDir, 'node_modules');
    if (safeDir(nestedNm)) walkNodeModulesDir(nestedNm);
  }

  function walkNodeModulesDir(nm) {
    let entries;
    try { entries = readdirSync(nm); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.pnpm') continue;
      const full = join(nm, entry);
      if (entry === '.pnpm') {
        // pnpm virtual store: node_modules/.pnpm/<name>@<ver>/node_modules/<name>
        try {
          for (const pkgDir of readdirSync(full)) {
            const inner = join(full, pkgDir, 'node_modules');
            if (safeDir(inner)) walkNodeModulesDir(inner);
          }
        } catch { /* virtual store unreadable on this machine */ }
        continue;
      }
      if (entry.startsWith('@')) {
        // scoped: node_modules/@scope/<name>
        try {
          for (const scoped of readdirSync(full)) {
            visit(join(full, scoped));
          }
        } catch { /* scope dir unreadable */ }
        continue;
      }
      visit(full);
    }
  }

  function safeDir(p) {
    try { return statSync(p).isDirectory(); } catch { return false; }
  }

  if (!safeDir(NODE_MODULES)) {
    console.warn('[licenses] node_modules not found; npm list will be empty.');
    return [];
  }
  walkNodeModulesDir(NODE_MODULES);

  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Collect Cargo crate metadata via `cargo metadata`. */
function collectCargo() {
  try {
    const raw = execSync(
      `cargo metadata --format-version 1 --manifest-path "${TAURI_MANIFEST}"`,
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    );
    const meta = JSON.parse(raw);
    const out = new Map();
    for (const p of meta.packages || []) {
      if (!p.name) continue;
      if (SELF_NAMES.has(p.name)) continue;
      // Workspace members have `id` resolvable to the local workspace; skip them.
      if (Array.isArray(meta.workspace_members) && meta.workspace_members.includes(p.id)) continue;
      const key = `${p.name}@${p.version}`;
      if (out.has(key)) continue;
      out.set(key, {
        name: p.name,
        version: p.version,
        license: p.license || 'UNKNOWN',
        repository: p.repository || p.homepage,
      });
    }
    return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn(`[licenses] cargo metadata failed (${err.message?.split('\n')[0] || err}); cargo list will be empty.`);
    return [];
  }
}

function main() {
  const npm = collectNpm();
  const cargo = collectCargo();
  const manifest = {
    generatedAt: new Date().toISOString(),
    counts: { npm: npm.length, cargo: cargo.length },
    npm,
    cargo,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[licenses] wrote ${OUT_PATH} — npm=${npm.length} cargo=${cargo.length}`);
}

main();
