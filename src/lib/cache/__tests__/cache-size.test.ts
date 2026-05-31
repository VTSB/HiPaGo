// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mbToBytes, bytesToMb, formatBytes } from '../cache-size';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('cache-size helpers', () => {
  it('mbToBytes: MB -> bytes; 0/negative/NaN -> 0 (off)', () => {
    expect(mbToBytes(250)).toBe(250 * MB);
    expect(mbToBytes(1)).toBe(MB);
    expect(mbToBytes(0)).toBe(0);
    expect(mbToBytes(-5)).toBe(0);
    expect(mbToBytes(Number.NaN)).toBe(0);
  });

  it('bytesToMb: bytes -> whole MB', () => {
    expect(bytesToMb(250 * MB)).toBe(250);
    expect(bytesToMb(0)).toBe(0);
    expect(bytesToMb(GB)).toBe(1024);
  });

  it('formatBytes: human-readable, MB under 1GB and GB above', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(-1)).toBe('0 MB');
    expect(formatBytes(120 * MB)).toBe('120 MB');
    expect(formatBytes(2 * GB)).toBe('2 GB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
  });
});
