// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveVersion,
  parseTag,
  patchAndroidBuildGradle,
  patchCargoLockPackageVersion,
  patchCargoTomlVersion,
  patchIosProjectVersion,
} from '../derive-version.mjs';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hipago-derive-version-'));
  tempDirs.push(dir);
  return dir;
}

function writeProject(root: string, gradle: string) {
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  mkdirSync(join(root, 'android/app'), { recursive: true });
  mkdirSync(join(root, 'ios/App/App.xcodeproj'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri/tauri.conf.json'),
    JSON.stringify({ version: '0.0.7', productName: 'HiPaGo' }, null, 2),
  );
  writeFileSync(
    join(root, 'src-tauri/Cargo.toml'),
    '[package]\nname = "hipago"\nversion = "0.0.7"\n\n[dependencies]\ntauri = { version = "2" }\n',
  );
  writeFileSync(
    join(root, 'src-tauri/Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "hipago"\nversion = "0.0.7"\ndependencies = ["tauri"]\n\n[[package]]\nname = "tauri"\nversion = "2.0.0"\n',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hipago', version: '0.0.7' }, null, 2),
  );
  writeFileSync(join(root, 'android/app/build.gradle'), gradle);
  writeFileSync(
    join(root, 'ios/App/App.xcodeproj/project.pbxproj'),
    '\t\tMARKETING_VERSION = 0.0.7;\n\t\tCURRENT_PROJECT_VERSION = 7;\n\t\tMARKETING_VERSION = 0.0.7;\n\t\tCURRENT_PROJECT_VERSION = 7;\n',
  );
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

  it('rejects ambiguous or out-of-range Android version codes', () => {
    expect(() => parseTag('v0.0.0')).toThrow('positive Android versionCode');
    expect(() => parseTag('v1.1000.0')).toThrow('minor and patch components must be <= 999');
    expect(() => parseTag('v1.0.1000')).toThrow('minor and patch components must be <= 999');
    expect(() => parseTag('v2100.0.1')).toThrow('maximum versionCode of 2100000000');
    expect(parseTag('v2100.0.0').versionCode).toBe(2_100_000_000);
  });

  it('rejects leading zeroes and unsafe numeric components', () => {
    expect(() => parseTag('v01.2.3')).toThrow('does not match required vX.Y.Z');
    expect(() => parseTag('v99999999999999999.0.0')).toThrow('safe range');
  });
});

describe('patchAndroidBuildGradle', () => {
  it.each([
    ['space form', '        versionCode 7\n        versionName "0.0.7"\n'],
    ['equals form', '        versionCode = 7\n        versionName = "0.0.7"\n'],
    [
      'property form',
      '        versionCode rootProject.ext.versionCode\n        versionName rootProject.ext.versionName\n',
    ],
  ])('patches %s', (_label, input) => {
    const root = makeTempDir();
    const file = join(root, 'build.gradle');
    writeFileSync(file, input);

    patchAndroidBuildGradle(file, '0.0.9', 9);

    expect(readFileSync(file, 'utf8')).toContain('versionCode 9');
    expect(readFileSync(file, 'utf8')).toContain('versionName "0.0.9"');
  });
});

describe('patchCargoTomlVersion', () => {
  it('patches only the package version', () => {
    const root = makeTempDir();
    const file = join(root, 'Cargo.toml');
    writeFileSync(
      file,
      '[package]\nname = "hipago"\nversion = "0.0.7" # release version\n\n[dependencies]\nexample = { version = "1.2.3" }\n',
    );

    patchCargoTomlVersion(file, '0.0.9');

    expect(readFileSync(file, 'utf8')).toBe(
      '[package]\nname = "hipago"\nversion = "0.0.9" # release version\n\n[dependencies]\nexample = { version = "1.2.3" }\n',
    );
  });

  it('rejects a manifest without one unambiguous package version', () => {
    const root = makeTempDir();
    const file = join(root, 'Cargo.toml');
    writeFileSync(file, '[package]\nname = "hipago"\n');

    expect(() => patchCargoTomlVersion(file, '0.0.9')).toThrow(
      'Expected exactly one version in [package]',
    );
  });
});

describe('patchCargoLockPackageVersion', () => {
  it('patches only the root package entry', () => {
    const root = makeTempDir();
    const file = join(root, 'Cargo.lock');
    writeFileSync(
      file,
      'version = 4\n\n[[package]]\nname = "hipago"\nversion = "0.0.7"\n\n[[package]]\nname = "dependency"\nversion = "0.0.7"\n',
    );

    patchCargoLockPackageVersion(file, 'hipago', '9.9.9');

    expect(readFileSync(file, 'utf8')).toBe(
      'version = 4\n\n[[package]]\nname = "hipago"\nversion = "9.9.9"\n\n[[package]]\nname = "dependency"\nversion = "0.0.7"\n',
    );
  });

  it('rejects a lockfile without one unambiguous package entry', () => {
    const root = makeTempDir();
    const file = join(root, 'Cargo.lock');
    writeFileSync(file, 'version = 4\n');

    expect(() => patchCargoLockPackageVersion(file, 'hipago', '9.9.9')).toThrow(
      "Expected exactly one 'hipago' package",
    );
  });
});

describe('patchIosProjectVersion', () => {
  it('patches every Xcode build configuration', () => {
    const root = makeTempDir();
    const file = join(root, 'project.pbxproj');
    writeFileSync(
      file,
      '\tMARKETING_VERSION = 1.0;\n\tCURRENT_PROJECT_VERSION = 1;\n\tMARKETING_VERSION = 1.0;\n\tCURRENT_PROJECT_VERSION = 1;\n',
    );

    patchIosProjectVersion(file, '9.9.9', 9_009_009);

    const patched = readFileSync(file, 'utf8');
    expect(patched.match(/MARKETING_VERSION = 9\.9\.9;/g)).toHaveLength(2);
    expect(patched.match(/CURRENT_PROJECT_VERSION = 9009009;/g)).toHaveLength(2);
  });

  it('fails closed when the Xcode version settings are missing', () => {
    const root = makeTempDir();
    const file = join(root, 'project.pbxproj');
    writeFileSync(file, '// no version settings\n');

    expect(() => patchIosProjectVersion(file, '9.9.9', 9_009_009)).toThrow(
      'Failed to patch iOS project version',
    );
  });
});

describe('deriveVersion', () => {
  it('patches release files and writes GitHub action outputs', () => {
    const root = makeTempDir();
    const outputFile = join(root, 'github-output.txt');
    writeProject(
      root,
      'android { defaultConfig {\n        versionCode 7\n        versionName "0.0.7"\n} }\n',
    );

    const result = deriveVersion({ root, refName: 'v0.0.9', outputFile, log: () => {} });

    expect(result).toEqual({ version: '0.0.9', versionCode: 9 });
    expect(JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version).toBe(
      '0.0.9',
    );
    expect(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')).toContain('version = "0.0.9"');
    expect(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')).toContain(
      'name = "hipago"\nversion = "0.0.9"',
    );
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.0.9');
    expect(readFileSync(join(root, 'android/app/build.gradle'), 'utf8')).toContain('versionCode 9');
    expect(readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')).toContain(
      'MARKETING_VERSION = 0.0.9;',
    );
    expect(readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')).toContain(
      'CURRENT_PROJECT_VERSION = 9;',
    );
    expect(readFileSync(outputFile, 'utf8')).toBe('version=0.0.9\nversion_code=9\n');
  });
});
