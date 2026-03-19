// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveTnSubdomain } from '../route';
import type { GgConfig } from '@/lib/utils/types';

function makeConfig(overrides: Partial<GgConfig> = {}): GgConfig {
  return {
    pathCode: 'gg',
    mDefault: 1,
    mCases: new Set(),
    mCaseValue: 0,
    ...overrides,
  };
}

describe('resolveTnSubdomain', () => {
  it('resolves correctly with a 64-char hex hash (mDefault=1 → btn)', () => {
    const hash = 'a'.repeat(64);
    const targetPath = `avifsmalltn/4/23/${hash}.avif`;
    const config = makeConfig({ mDefault: 1, mCases: new Set() });
    // g = parseInt(last1 + last3..last1, 16) = parseInt('aaa', 16) = 2730
    // mDefault=1 → 'b' + 'tn' = 'btn'
    expect(resolveTnSubdomain(targetPath, config)).toBe('btn');
  });

  it('resolves correctly with a 10-char hex hash (shorter than 64)', () => {
    const hash = 'abcdef1234';
    const targetPath = `avifsmalltn/4/23/${hash}.avif`;
    const config = makeConfig({ mDefault: 1, mCases: new Set() });
    // g = parseInt('4' + '23', 16) = parseInt('423', 16) = 1059
    // mDefault=1, 1059 not in mCases → m=1 → 'btn'
    expect(resolveTnSubdomain(targetPath, config)).toBe('btn');
  });

  it('resolves correctly with a 32-char hex hash (shorter than 64)', () => {
    const hash = 'deadbeefcafe1234deadbeefcafe1234';
    const targetPath = `avifsmalltn/4/23/${hash}.avif`;
    const config = makeConfig({ mDefault: 0, mCases: new Set() });
    // mDefault=0 → 'a' + 'tn' = 'atn'
    expect(resolveTnSubdomain(targetPath, config)).toBe('atn');
  });

  it('falls back to atn when no hash found in path', () => {
    const targetPath = 'avifsmalltn/no-hash-here/image';
    const config = makeConfig({ mDefault: 1, mCases: new Set() });
    expect(resolveTnSubdomain(targetPath, config)).toBe('atn');
  });

  it('uses mCaseValue when g is in mCases', () => {
    const hash = 'abcdef1234'; // g = parseInt('423', 16) = 1059
    const targetPath = `avifsmalltn/4/23/${hash}.avif`;
    const config = makeConfig({ mDefault: 1, mCaseValue: 0, mCases: new Set([1059]) });
    // g=1059 is in mCases → m=0 → 'atn'
    expect(resolveTnSubdomain(targetPath, config)).toBe('atn');
  });
});
