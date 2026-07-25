#!/usr/bin/env node
/*
 * Build a Tauri-updater `latest.json` manifest from updater signature files
 * downloaded from the just-created GitHub Release.
 *
 * A publishable manifest must contain every currently distributable updater
 * target: Linux x86_64 plus both Windows x86_64 installer families. macOS is
 * intentionally excluded until Apple Developer ID signing and notarization are
 * configured; an updater minisign signature alone is not a distributable macOS
 * trust chain. The script fails before writing a partial manifest.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_PLATFORMS = ['linux-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-msi'];

/** @typedef {{ signature: string, url: string }} UpdaterPlatform */
/** @typedef {{ version: string, notes: string, pub_date: string, platforms: Record<string, UpdaterPlatform> }} LatestManifest */

export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${key}`);
    }

    const name = key.slice(2);
    const value = argv[i + 1];
    if (!name || value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    if (Object.hasOwn(args, name)) {
      throw new Error(`Duplicate argument: ${key}`);
    }

    args[name] = value;
    i += 1;
  }
  return args;
}

// File basename -> Tauri updater platform key + paired asset filename (the
// thing the .sig signs, which is what the URL points at).
export function classifySignature(sigFile) {
  if (typeof sigFile !== 'string' || !sigFile.endsWith('.sig')) return null;

  const base = sigFile.slice(0, -4);
  const lower = base.toLowerCase();

  // macOS: HiPaGo.app.tar.gz, HiPaGo_<ver>_<arch>.app.tar.gz
  if (lower.endsWith('.app.tar.gz')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) {
      return { platform: 'darwin-aarch64', asset: base };
    }
    if (lower.includes('x64') || lower.includes('x86_64') || lower.includes('amd64')) {
      return { platform: 'darwin-x86_64', asset: base };
    }
    // The current macos-latest release runner is arm64. Keep supporting the
    // architecture-less filename emitted for that target.
    return { platform: 'darwin-aarch64', asset: base };
  }

  if (lower.endsWith('.appimage')) {
    return { platform: 'linux-x86_64', asset: base };
  }

  if (lower.endsWith('-setup.exe')) {
    return { platform: 'windows-x86_64-nsis', asset: base };
  }
  if (lower.endsWith('.msi')) {
    return { platform: 'windows-x86_64-msi', asset: base };
  }

  return null;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateSlug(value, label) {
  requireNonEmptyString(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} contains invalid GitHub slug characters: ${value}`);
  }
}

function validateSignature(signature, sigFile) {
  if (!signature) {
    throw new Error(`Signature file is empty: ${sigFile}`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 === 1) {
    throw new Error(`Signature file is not valid base64: ${sigFile}`);
  }

  const unpadded = signature.replace(/=+$/, '');
  const canonical = Buffer.from(signature, 'base64').toString('base64').replace(/=+$/, '');
  if (canonical !== unpadded) {
    throw new Error(`Signature file is not valid base64: ${sigFile}`);
  }
}

/**
 * @param {object} options
 * @param {string} options.sigDir
 * @param {string} options.version
 * @param {string} options.tag
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.out
 * @param {string} [options.notes]
 * @param {string} [options.pubDate]
 * @param {(...args: any[]) => void} [options.log]
 * @param {(...args: any[]) => void} [options.warn]
 * @returns {LatestManifest}
 */
export function buildLatestJson({
  sigDir,
  version,
  tag,
  owner,
  repo,
  out,
  notes,
  pubDate = new Date().toISOString(),
  log = console.log,
  warn = console.warn,
}) {
  requireNonEmptyString(sigDir, 'sigDir');
  requireNonEmptyString(out, 'out');
  requireNonEmptyString(version, 'version');
  requireNonEmptyString(tag, 'tag');
  validateSlug(owner, 'owner');
  validateSlug(repo, 'repo');

  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error(`version must match X.Y.Z: ${version}`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag must exactly match v${version}: ${tag}`);
  }
  if (notes !== undefined && typeof notes !== 'string') {
    throw new Error('notes must be a string when provided.');
  }
  if (typeof pubDate !== 'string' || !Number.isFinite(Date.parse(pubDate))) {
    throw new Error(`pubDate must be a valid date string: ${pubDate}`);
  }

  const sigFiles = readdirSync(sigDir)
    .filter((file) => file.endsWith('.sig'))
    .sort((a, b) => a.localeCompare(b));
  if (sigFiles.length === 0) {
    throw new Error(`No .sig files found in ${sigDir}`);
  }

  /** @type {Record<string, UpdaterPlatform>} */
  const platforms = {};
  for (const sigFile of sigFiles) {
    const classified = classifySignature(sigFile);
    if (!classified) {
      warn(`Skipping unmapped sig: ${sigFile}`);
      continue;
    }

    const signature = readFileSync(join(sigDir, sigFile), 'utf8').trim();
    validateSignature(signature, sigFile);
    const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(classified.asset)}`;
    const candidate = { signature, url };
    const existing = platforms[classified.platform];

    if (existing) {
      throw new Error(
        `Multiple updater signatures map to ${classified.platform}: ${existing.url}, ${url}`,
      );
    }
    platforms[classified.platform] = candidate;
  }

  const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms[platform]);
  if (missing.length > 0) {
    throw new Error(`Missing required updater signatures: ${missing.join(', ')}`);
  }

  // updater >=2.10 selects the installer-qualified key first, which keeps MSI
  // installations on MSI and NSIS installations on NSIS. Retain the generic
  // NSIS entry for clients released with older updater plugins.
  platforms['windows-x86_64'] = platforms['windows-x86_64-nsis'];

  const manifest = {
    version,
    notes: notes || `See https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    pub_date: new Date(pubDate).toISOString(),
    platforms,
  };

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`Wrote ${out} with ${Object.keys(platforms).length} platform entries:`);
  for (const [platform, entry] of Object.entries(platforms)) {
    log(`  ${platform} -> ${entry.url}`);
  }
  return manifest;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const requiredArgs = ['sig-dir', 'version', 'tag', 'owner', 'repo', 'out'];
  for (const key of requiredArgs) {
    if (!args[key]) {
      throw new Error(`Missing required arg --${key}`);
    }
  }

  buildLatestJson({
    sigDir: args['sig-dir'],
    version: args.version,
    tag: args.tag,
    owner: args.owner,
    repo: args.repo,
    notes: args.notes,
    out: args.out,
  });
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
