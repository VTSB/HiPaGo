// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveVersion, parseTag, patchAndroidBuildGradle } from '../derive-version.mjs';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hipago-derive-version-'));
  tempDirs.push(dir);
  return dir;
}

function writeProject(root: string, gradle: string) {
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  mkdirSync(join(root, 'android/app'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.0.7', productName: 'HiPaGo' }, null, 2));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hipago', version: '0.0.7' }, null, 2));
  writeFileSync(join(root, 'android/app/build.gradle'), gradle);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseTag', () => {
  it('derives semver and Android versionCode from vX.Y.Z', () => {
    expect(parseTag('v2.3.4')).toEqual({ version: '2.3.4', versionCode: 2_003_004 });
  });

  it('rejects prerelease suffixes', () => {
    expect(() => parseTag('v1.2.3-beta.1')).toThrow('Pre-release suffixes are not supported');
  });
});

describe('patchAndroidBuildGradle', () => {
  it.each([
    ['space form', '        versionCode 7\n        versionName "0.0.7"\n'],
    ['equals form', '        versionCode = 7\n        versionName = "0.0.7"\n'],
    ['property form', '        versionCode rootProject.ext.versionCode\n        versionName rootProject.ext.versionName\n'],
  ])('patches %s', (_label, input) => {
    const root = makeTempDir();
    const file = join(root, 'build.gradle');
    writeFileSync(file, input);

    patchAndroidBuildGradle(file, '0.0.9', 9);

    expect(readFileSync(file, 'utf8')).toContain('versionCode 9');
    expect(readFileSync(file, 'utf8')).toContain('versionName "0.0.9"');
  });
});

describe('deriveVersion', () => {
  it('patches release files and writes GitHub action outputs', () => {
    const root = makeTempDir();
    const outputFile = join(root, 'github-output.txt');
    writeProject(root, 'android { defaultConfig {\n        versionCode 7\n        versionName "0.0.7"\n} }\n');

    const result = deriveVersion({ root, refName: 'v0.0.9', outputFile, log: () => {} });

    expect(result).toEqual({ version: '0.0.9', versionCode: 9 });
    expect(JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version).toBe('0.0.9');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.0.9');
    expect(readFileSync(join(root, 'android/app/build.gradle'), 'utf8')).toContain('versionCode 9');
    expect(readFileSync(outputFile, 'utf8')).toBe('version=0.0.9\nversion_code=9\n');
  });
});
