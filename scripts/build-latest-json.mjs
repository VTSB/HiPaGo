#!/usr/bin/env node
/*
 * Build a Tauri-updater `latest.json` manifest from a directory of `.sig` files
 * downloaded from the just-created GitHub Release.
 *
 * Expected layout under <sigDir>:
 *   HiPaGo_<ver>_aarch64.app.tar.gz.sig    # macOS arm64
 *   HiPaGo_<ver>_x64.app.tar.gz.sig        # macOS x86_64 (if matrix builds it)
 *   HiPaGo_<ver>_amd64.AppImage.sig        # Linux x86_64
 *   HiPaGo_<ver>_x64-setup.exe.sig         # Windows x86_64 (NSIS)
 *   HiPaGo_<ver>_x64_en-US.msi.sig         # Windows x86_64 (MSI)
 *
 * Tauri 2 emits one `.sig` per generated bundle. We map each known extension
 * to a Tauri updater platform key. Any unmapped `.sig` is logged and skipped.
 *
 * Usage:
 *   node scripts/build-latest-json.mjs \
 *     --sig-dir ./release-sigs \
 *     --version 0.0.7 \
 *     --tag v0.0.7 \
 *     --owner VTSB --repo HiPaGo \
 *     --notes "see release page" \
 *     --out latest.json
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const required = ['sig-dir', 'version', 'tag', 'owner', 'repo', 'out'];
for (const k of required) {
  if (!args[k]) {
    console.error(`Missing required arg --${k}`);
    process.exit(1);
  }
}

const sigDir = args['sig-dir'];
const version = args.version;
const tag = args.tag;
const owner = args.owner;
const repo = args.repo;
const notes = args.notes || `See https://github.com/${owner}/${repo}/releases/tag/${tag}`;
const out = args.out;

// File basename → Tauri updater platform key + paired asset filename (the
// thing the .sig signs, which is what the URL points at).
function classify(sigFile) {
  // strip ".sig" suffix
  const base = sigFile.endsWith('.sig') ? sigFile.slice(0, -4) : sigFile;
  const lower = base.toLowerCase();

  // macOS: HiPaGo.app.tar.gz, HiPaGo_<ver>_<arch>.app.tar.gz
  if (lower.endsWith('.app.tar.gz')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) {
      return { platform: 'darwin-aarch64', asset: base };
    }
    if (lower.includes('x64') || lower.includes('x86_64') || lower.includes('amd64')) {
      return { platform: 'darwin-x86_64', asset: base };
    }
    // No arch token → assume aarch64 (current default macos-latest runner)
    return { platform: 'darwin-aarch64', asset: base };
  }

  // Linux: .AppImage is the canonical Tauri updater target on Linux
  if (lower.endsWith('.appimage')) {
    return { platform: 'linux-x86_64', asset: base };
  }

  // Windows: prefer NSIS (.exe) — Tauri 2 default. Fall back to .msi.
  if (lower.endsWith('-setup.exe') || lower.endsWith('.nsis.zip')) {
    return { platform: 'windows-x86_64', asset: base };
  }
  if (lower.endsWith('.msi')) {
    return { platform: 'windows-x86_64', asset: base };
  }

  return null;
}

const sigFiles = readdirSync(sigDir).filter((f) => f.endsWith('.sig'));
if (sigFiles.length === 0) {
  console.error(`No .sig files found in ${sigDir}`);
  process.exit(2);
}

const platforms = {};
for (const sig of sigFiles) {
  const klass = classify(sig);
  if (!klass) {
    console.warn(`Skipping unmapped sig: ${sig}`);
    continue;
  }
  const signature = readFileSync(join(sigDir, sig), 'utf8').trim();
  const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(klass.asset)}`;

  // If the platform already has an entry, prefer NSIS over MSI on Windows
  // (Tauri 2 docs recommend NSIS for the updater path).
  const existing = platforms[klass.platform];
  if (existing) {
    const existingIsMsi = existing.url.toLowerCase().endsWith('.msi');
    const newIsNsis = klass.asset.toLowerCase().endsWith('-setup.exe');
    if (existingIsMsi && newIsNsis) {
      platforms[klass.platform] = { signature, url };
    }
    // otherwise keep existing
  } else {
    platforms[klass.platform] = { signature, url };
  }
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${out} with ${Object.keys(platforms).length} platform entries:`);
for (const [k, v] of Object.entries(platforms)) {
  console.log(`  ${k} → ${v.url}`);
}
