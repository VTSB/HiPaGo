// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLatestJson } from '../build-latest-json.mjs';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hipago-latest-json-'));
  tempDirs.push(dir);
  return dir;
}

function signature(label: string) {
  return Buffer.from(`signed updater payload: ${label}`).toString('base64');
}

function writeRequiredSignatures(dir: string) {
  writeFileSync(join(dir, 'HiPaGo_1.2.3_amd64.AppImage.sig'), signature('linux'));
  writeFileSync(join(dir, 'HiPaGo_1.2.3_x64-setup.exe.sig'), signature('windows nsis'));
  writeFileSync(join(dir, 'HiPaGo_1.2.3_x64_en-US.msi.sig'), signature('windows msi'));
}

function build(dir: string, overrides: Record<string, unknown> = {}) {
  return buildLatestJson({
    sigDir: dir,
    version: '1.2.3',
    tag: 'v1.2.3',
    owner: 'VTSB',
    repo: 'HiPaGo',
    out: join(dir, 'latest.json'),
    pubDate: '2026-07-23T00:00:00.000Z',
    log: () => {},
    warn: () => {},
    ...overrides,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildLatestJson', () => {
  it('writes a complete manifest for every required updater platform', () => {
    const dir = makeTempDir();
    writeRequiredSignatures(dir);

    const manifest = build(dir);

    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'linux-x86_64',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    expect(manifest).toMatchObject({
      version: '1.2.3',
      pub_date: '2026-07-23T00:00:00.000Z',
      platforms: {
        'linux-x86_64': { signature: signature('linux') },
        'windows-x86_64': {
          signature: signature('windows nsis'),
          url: 'https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_x64-setup.exe',
        },
        'windows-x86_64-nsis': {
          signature: signature('windows nsis'),
          url: 'https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_x64-setup.exe',
        },
        'windows-x86_64-msi': {
          signature: signature('windows msi'),
          url: 'https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_x64_en-US.msi',
        },
      },
    });
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))).toEqual(manifest);
  });

  it('requires Linux and both Windows updater signatures before writing output', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'HiPaGo_1.2.3_amd64.AppImage.sig'), signature('linux'));
    const out = join(dir, 'latest.json');

    expect(() => build(dir)).toThrow(
      'Missing required updater signatures: windows-x86_64-nsis, windows-x86_64-msi',
    );
    expect(existsSync(out)).toBe(false);
  });

  it('rejects empty and malformed signature files', () => {
    const emptyDir = makeTempDir();
    writeRequiredSignatures(emptyDir);
    writeFileSync(join(emptyDir, 'HiPaGo_1.2.3_amd64.AppImage.sig'), '  \n');
    expect(() => build(emptyDir)).toThrow(
      'Signature file is empty: HiPaGo_1.2.3_amd64.AppImage.sig',
    );

    const malformedDir = makeTempDir();
    writeRequiredSignatures(malformedDir);
    writeFileSync(join(malformedDir, 'HiPaGo_1.2.3_x64_en-US.msi.sig'), 'not base64!');
    expect(() => build(malformedDir)).toThrow('Signature file is not valid base64');
  });

  it.each([
    ['malformed version', { version: '1.2' }, 'version must match X.Y.Z'],
    ['mismatched tag', { tag: 'v1.2.4' }, 'tag must exactly match v1.2.3'],
    ['invalid owner', { owner: 'VTSB/other' }, 'owner contains invalid GitHub slug characters'],
    ['invalid date', { pubDate: 'not-a-date' }, 'pubDate must be a valid date string'],
  ])('rejects %s input', (_label, overrides, message) => {
    const dir = makeTempDir();
    writeRequiredSignatures(dir);

    expect(() => build(dir, overrides)).toThrow(message);
  });

  it('keeps MSI and NSIS installer families separate while retaining a generic NSIS fallback', () => {
    const dir = makeTempDir();
    writeRequiredSignatures(dir);

    const manifest = build(dir);

    expect(manifest.platforms['windows-x86_64']).toMatchObject({
      signature: signature('windows nsis'),
      url: 'https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_x64-setup.exe',
    });
    expect(manifest.platforms['windows-x86_64-nsis']).toEqual(manifest.platforms['windows-x86_64']);
    expect(manifest.platforms['windows-x86_64-msi']).toMatchObject({
      signature: signature('windows msi'),
      url: 'https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_x64_en-US.msi',
    });
  });

  it('rejects duplicate updater signatures for one installer target', () => {
    const dir = makeTempDir();
    writeRequiredSignatures(dir);
    writeFileSync(join(dir, 'duplicate-x64-setup.exe.sig'), signature('duplicate nsis'));

    expect(() => build(dir)).toThrow('Multiple updater signatures map to windows-x86_64-nsis');
  });
});
