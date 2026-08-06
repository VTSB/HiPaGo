#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION_PATTERN = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseStableVersion(value) {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Release version '${value}' must match vX.Y.Z or X.Y.Z.`);
  }
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`Release version '${value}' contains a component outside the safe range.`);
  }
  return parts;
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertReleaseIsNewer(candidate, releases) {
  parseStableVersion(candidate);
  const publishedStableTags = releases
    .filter((release) => !release.isDraft && STABLE_VERSION_PATTERN.test(release.tagName))
    .map((release) => release.tagName)
    .sort(compareStableVersions);
  const latest = publishedStableTags.at(-1);
  if (latest && compareStableVersions(candidate, latest) <= 0) {
    throw new Error(`Candidate ${candidate} must be newer than published release ${latest}.`);
  }
  return latest;
}

function main() {
  const [candidate, releasesPath] = process.argv.slice(2);
  if (!candidate || !releasesPath) {
    throw new Error('Usage: node scripts/assert-release-version.mjs <candidate> <releases.json>');
  }
  const releases = JSON.parse(readFileSync(releasesPath, 'utf8'));
  if (!Array.isArray(releases)) throw new Error('Release list JSON must be an array.');
  const latest = assertReleaseIsNewer(candidate, releases);
  console.log(
    latest
      ? `Release monotonicity verified: ${candidate} > ${latest}`
      : `No public stable release precedes ${candidate}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
