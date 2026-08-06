import { describe, expect, it } from 'vitest';

import {
  assertReleaseIsNewer,
  compareStableVersions,
  parseStableVersion,
} from '../assert-release-version.mjs';

describe('release version monotonicity', () => {
  it('compares numeric stable versions', () => {
    expect(compareStableVersions('v9.9.9', '10.0.0')).toBeLessThan(0);
    expect(compareStableVersions('2.10.0', 'v2.9.99')).toBeGreaterThan(0);
    expect(compareStableVersions('1.2.3', 'v1.2.3')).toBe(0);
  });

  it('rejects unsupported version shapes', () => {
    expect(() => parseStableVersion('v1.2.3-beta.1')).toThrow(/vX\.Y\.Z/);
  });

  it('requires the candidate to exceed every published stable release', () => {
    const releases = [
      { tagName: 'v9.9.8', isDraft: false },
      { tagName: 'v10.0.0', isDraft: true },
      { tagName: 'nightly', isDraft: false },
    ];
    expect(assertReleaseIsNewer('9.9.9', releases)).toBe('v9.9.8');
    expect(() => assertReleaseIsNewer('9.9.8', releases)).toThrow(/must be newer/);
  });
});
