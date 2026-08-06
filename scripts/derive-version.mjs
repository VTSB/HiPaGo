#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseTag(tag) {
  if (!tag) {
    throw new Error('GITHUB_REF_NAME is empty; derive-version must run on a tag-push event.');
  }

  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error(
      `Tag '${tag}' does not match required vX.Y.Z (got version='${version}'). Pre-release suffixes are not supported.`,
    );
  }

  const [major, minor, patch] = version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Tag '${tag}' contains a version component outside JavaScript's safe range.`);
  }
  if (minor > 999 || patch > 999) {
    throw new Error(
      `Tag '${tag}' cannot be encoded uniquely: minor and patch components must be <= 999.`,
    );
  }
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (versionCode < 1) {
    throw new Error(`Tag '${tag}' must produce a positive Android versionCode.`);
  }
  if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
    throw new Error(`Tag '${tag}' exceeds Google Play's maximum versionCode of 2100000000.`);
  }
  return {
    version,
    versionCode,
  };
}

function patchJsonVersion(file, version, log) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const old = data.version;
  data.version = version;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  log(`${file}: ${old} -> ${version}`);
}

export function patchCargoTomlVersion(file, version, log = () => {}) {
  const text = readFileSync(file, 'utf8');
  const packageHeaders = [...text.matchAll(/^\[package\]\s*$/gm)];
  if (packageHeaders.length !== 1) {
    throw new Error(
      `Expected exactly one [package] section in ${file}, found ${packageHeaders.length}.`,
    );
  }

  const sectionStart = packageHeaders[0].index + packageHeaders[0][0].length;
  const nextSection = text.slice(sectionStart).search(/^\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSection === -1 ? text.length : sectionStart + nextSection;
  const packageSection = text.slice(sectionStart, sectionEnd);
  const versionPattern = /^(\s*version\s*=\s*)"([^"]*)"(\s*(?:#.*)?)$/gm;
  const matches = [...packageSection.matchAll(versionPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one version in [package] section of ${file}, found ${matches.length}.`,
    );
  }

  const old = matches[0][2];
  const patchedSection = packageSection.replace(versionPattern, `$1"${version}"$3`);
  writeFileSync(file, text.slice(0, sectionStart) + patchedSection + text.slice(sectionEnd));
  log(`${file}: ${old} -> ${version}`);
}

export function patchCargoLockPackageVersion(file, packageName, version, log = () => {}) {
  const text = readFileSync(file, 'utf8');
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const packageStarts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '[[package]]') packageStarts.push(index);
  }

  const matchingBlocks = [];
  for (let blockIndex = 0; blockIndex < packageStarts.length; blockIndex += 1) {
    const start = packageStarts[blockIndex];
    const end = packageStarts[blockIndex + 1] ?? lines.length;
    const nameLine = lines.slice(start + 1, end).find((line) => /^\s*name\s*=/.test(line));
    const nameMatch = nameLine?.match(/^\s*name\s*=\s*"([^"]+)"\s*$/);
    if (nameMatch?.[1] === packageName) matchingBlocks.push({ start, end });
  }

  if (matchingBlocks.length !== 1) {
    throw new Error(
      `Expected exactly one '${packageName}' package in ${file}, found ${matchingBlocks.length}.`,
    );
  }

  const { start, end } = matchingBlocks[0];
  const versionPattern = /^(\s*version\s*=\s*)"([^"]*)"(\s*(?:#.*)?)$/;
  const versionIndexes = [];
  for (let index = start + 1; index < end; index += 1) {
    if (versionPattern.test(lines[index])) versionIndexes.push(index);
  }
  if (versionIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one version for '${packageName}' in ${file}, found ${versionIndexes.length}.`,
    );
  }

  const versionIndex = versionIndexes[0];
  const old = lines[versionIndex].match(versionPattern)[2];
  lines[versionIndex] = lines[versionIndex].replace(versionPattern, `$1"${version}"$3`);
  writeFileSync(file, lines.join(lineEnding));
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
    throw new Error(
      `Failed to patch ${label} in android/app/build.gradle (pattern miss).\n${versionLines}`,
    );
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
  if (
    !new RegExp(
      `^\\s*versionName\\s+"${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*$`,
      'm',
    ).test(text)
  ) {
    throw new Error('Failed to verify versionName in android/app/build.gradle after patch.');
  }

  writeFileSync(file, text);
}

export function patchIosProjectVersion(file, version, buildNumber) {
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 0) {
    throw new Error(`iOS build number must be a non-negative safe integer: ${buildNumber}`);
  }

  let text = readFileSync(file, 'utf8');
  let marketingVersionCount = 0;
  let currentProjectVersionCount = 0;

  text = text.replace(
    /^(\s*MARKETING_VERSION\s*=\s*)[^;\r\n]+(\s*;.*)$/gm,
    (_line, prefix, suffix) => {
      marketingVersionCount += 1;
      return `${prefix}${version}${suffix}`;
    },
  );
  text = text.replace(
    /^(\s*CURRENT_PROJECT_VERSION\s*=\s*)[^;\r\n]+(\s*;.*)$/gm,
    (_line, prefix, suffix) => {
      currentProjectVersionCount += 1;
      return `${prefix}${buildNumber}${suffix}`;
    },
  );

  if (marketingVersionCount === 0 || currentProjectVersionCount === 0) {
    throw new Error(
      `Failed to patch iOS project version in ${file}: found ${marketingVersionCount} MARKETING_VERSION and ${currentProjectVersionCount} CURRENT_PROJECT_VERSION settings.`,
    );
  }
  writeFileSync(file, text);
}

export function deriveVersion({
  root = process.cwd(),
  refName = process.env.GITHUB_REF_NAME,
  outputFile = process.env.GITHUB_OUTPUT,
  log = console.log,
} = {}) {
  const { version, versionCode } = parseTag(refName);
  log(`Tag ${refName} -> version=${version} versionCode=${versionCode}`);

  patchJsonVersion(resolve(root, 'src-tauri/tauri.conf.json'), version, log);
  patchCargoTomlVersion(resolve(root, 'src-tauri/Cargo.toml'), version, log);
  patchCargoLockPackageVersion(resolve(root, 'src-tauri/Cargo.lock'), 'hipago', version, log);
  patchJsonVersion(resolve(root, 'package.json'), version, log);
  patchAndroidBuildGradle(resolve(root, 'android/app/build.gradle'), version, versionCode);
  patchIosProjectVersion(
    resolve(root, 'ios/App/App.xcodeproj/project.pbxproj'),
    version,
    versionCode,
  );

  if (outputFile) {
    appendFileSync(outputFile, `version=${version}\nversion_code=${versionCode}\n`);
  }

  log('android/app/build.gradle patched:');
  const gradle = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8');
  for (const line of gradle
    .split(/\r?\n/)
    .filter((l) => /versionCode|versionName/.test(l))
    .slice(0, 2)) {
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
