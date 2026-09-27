#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseTag(tag) {
  if (!tag) {
    throw new Error('Release tag is empty; pass the pushed tag validated by the beta preparation job.');
  }

  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error(`Tag '${tag}' does not match required vX.Y.Z (got version='${version}'). Pre-release suffixes are not supported.`);
  }

  const [major, minor, patch] = version.split('.').map(Number);
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(versionCode) || minor > 999 || patch > 999 || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`Tag '${tag}' exceeds the Android versionCode range (minor/patch <= 999; code 1..2100000000).`);
  }
  return { version, versionCode };
}

function patchJsonVersion(file, version, log) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const old = data.version;
  data.version = version;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  log(`${file}: ${old} -> ${version}`);
}

function replaceOne(text, pattern, replacement, label) {
  let count = 0;
  const next = text.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count !== 1) {
    const versionLines = text
      .split(/\r?\n/)
      .filter((line) => line.includes('versionCode') || line.includes('versionName'))
      .join('\n');
    throw new Error(`Failed to patch ${label} in android/app/build.gradle (pattern miss).\n${versionLines}`);
  }
  return next;
}

export function patchAndroidBuildGradle(file, version, versionCode) {
  let text = readFileSync(file, 'utf8');

  text = replaceOne(
    text,
    /^(\s*)versionCode(?:\s*=\s*|\s+).*$/m,
    (_line, indent) => `${indent}versionCode ${versionCode}`,
    'versionCode',
  );
  text = replaceOne(
    text,
    /^(\s*)versionName(?:\s*=\s*|\s+).*$/m,
    (_line, indent) => `${indent}versionName "${version}"`,
    'versionName',
  );

  if (!new RegExp(`^\\s*versionCode\\s+${versionCode}\\s*$`, 'm').test(text)) {
    throw new Error('Failed to verify versionCode in android/app/build.gradle after patch.');
  }
  if (!new RegExp(`^\\s*versionName\\s+"${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*$`, 'm').test(text)) {
    throw new Error('Failed to verify versionName in android/app/build.gradle after patch.');
  }

  writeFileSync(file, text);
}

export function deriveVersion({ root = process.cwd(), refName = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME, outputFile = process.env.GITHUB_OUTPUT, log = console.log } = {}) {
  const { version, versionCode } = parseTag(refName);
  log(`Tag ${refName} -> version=${version} versionCode=${versionCode}`);

  patchJsonVersion(resolve(root, 'src-tauri/tauri.conf.json'), version, log);
  patchJsonVersion(resolve(root, 'package.json'), version, log);
  patchAndroidBuildGradle(resolve(root, 'android/app/build.gradle'), version, versionCode);

  if (outputFile) {
    appendFileSync(outputFile, `version=${version}\nversion_code=${versionCode}\n`);
  }

  log('android/app/build.gradle patched:');
  const gradle = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8');
  for (const line of gradle.split(/\r?\n/).filter((l) => /versionCode|versionName/.test(l)).slice(0, 2)) {
    log(line);
  }

  return { version, versionCode };
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    deriveVersion();
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
