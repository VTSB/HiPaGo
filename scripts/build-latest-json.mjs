#!/usr/bin/env node
// Build the Tauri updater manifest from release signatures. The release helper
// separately verifies every paired binary and the complete platform set.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag } from './derive-version.mjs';

export const REQUIRED_PLATFORMS = ['darwin-aarch64', 'linux-x86_64', 'windows-x86_64'];

export function classifySignature(sigFile) {
  if (!sigFile.endsWith('.sig')) return null;
  const asset = sigFile.slice(0, -4);
  const lower = asset.toLowerCase();
  if (lower.endsWith('.app.tar.gz')) {
    const intel = /(?:x64|x86_64|amd64)/.test(lower);
    return { platform: intel ? 'darwin-x86_64' : 'darwin-aarch64', asset, priority: 1 };
  }
  if (lower.endsWith('.appimage')) return { platform: 'linux-x86_64', asset, priority: 1 };
  // Prefer native NSIS, then its legacy zip, then MSI. Both current Tauri 2
  // installers and legacy zipped updater artifacts are supported.
  for (const [suffix, priority] of [['-setup.exe', 4], ['.nsis.zip', 3], ['.msi', 2], ['.msi.zip', 1]]) {
    if (lower.endsWith(suffix)) return { platform: 'windows-x86_64', asset, priority };
  }
  return null;
}

export function buildLatestJson({ signatures, version, tag, repository, notes, pubDate = new Date().toISOString() }) {
  if (parseTag(tag).version !== version || tag !== `v${version}`) throw new Error('Manifest version must match its canonical release tag.');
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  const priorities = {};
  for (const [name, contents] of Object.entries(signatures).sort(([a], [b]) => a.localeCompare(b))) {
    const item = classifySignature(name);
    if (!item) continue;
    if (!contents.trim()) throw new Error(`Empty signature: ${name}`);
    if ((priorities[item.platform] ?? 0) >= item.priority) continue;
    priorities[item.platform] = item.priority;
    platforms[item.platform] = {
      signature: contents.trim(),
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(item.asset)}`,
    };
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!platforms[platform]) throw new Error(`Missing updater platform: ${platform}`);
  }
  return { version, notes: notes ?? `See https://github.com/${repository}/releases/tag/${tag}`, pub_date: pubDate, platforms };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    for (const key of ['sig-dir', 'version', 'tag', 'owner', 'repo', 'out']) {
      if (!args[key]) throw new Error(`Missing required arg --${key}`);
    }
    const signatures = Object.fromEntries(readdirSync(args['sig-dir']).filter((name) => name.endsWith('.sig'))
      .map((name) => [name, readFileSync(join(args['sig-dir'], name), 'utf8')]));
    const manifest = buildLatestJson({ signatures, version: args.version, tag: args.tag, repository: `${args.owner}/${args.repo}`, notes: args.notes });
    writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${args.out}: ${Object.keys(manifest.platforms).join(', ')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
