import { describe, expect, it } from 'vitest';
import { downloadProgressPercent } from '@/lib/utils/download-progress-percent';

describe('downloadProgressPercent', () => {
  it('does not round an incomplete download up to 100%', () => {
    expect(downloadProgressPercent({ current: 199, total: 200 })).toBe(99);
  });

  it('reports 100% only at or beyond the total', () => {
    expect(downloadProgressPercent({ current: 200, total: 200 })).toBe(100);
    expect(downloadProgressPercent({ current: 201, total: 200 })).toBe(100);
  });

  it('returns 0 for an unknown or invalid total', () => {
    expect(downloadProgressPercent({ current: 0, total: 0 })).toBe(0);
  });
});
