// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseNozomiData, calculateRange } from '../nozomi';

describe('parseNozomiData', () => {
  it('parses big-endian 32-bit integers from buffer', () => {
    const buffer = new ArrayBuffer(12);
    const view = new DataView(buffer);
    view.setInt32(0, 100, false);
    view.setInt32(4, 200, false);
    view.setInt32(8, 300, false);

    const ids = parseNozomiData(buffer);
    expect(ids).toEqual([100, 200, 300]);
  });

  it('returns empty array for empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    expect(parseNozomiData(buffer)).toEqual([]);
  });

  it('ignores trailing bytes that are not a full 4-byte int', () => {
    // 5 bytes = 1 full int + 1 leftover byte
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setInt32(0, 42, false);

    const ids = parseNozomiData(buffer);
    expect(ids).toEqual([42]);
  });

  it('handles large gallery IDs correctly', () => {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt32(0, 2147483, false);

    const ids = parseNozomiData(buffer);
    expect(ids).toEqual([2147483]);
  });

  it('parses multiple pages worth of data', () => {
    const count = 25;
    const buffer = new ArrayBuffer(count * 4);
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      view.setInt32(i * 4, 1000 + i, false);
    }

    const ids = parseNozomiData(buffer);
    expect(ids).toHaveLength(25);
    expect(ids[0]).toBe(1000);
    expect(ids[24]).toBe(1024);
  });
});

describe('calculateRange', () => {
  it('calculates byte range for first page', () => {
    expect(calculateRange(0, 25)).toBe('bytes=0-99');
  });

  it('calculates byte range for second page', () => {
    expect(calculateRange(1, 25)).toBe('bytes=100-199');
  });

  it('calculates byte range for third page', () => {
    expect(calculateRange(2, 25)).toBe('bytes=200-299');
  });

  it('handles custom page size', () => {
    expect(calculateRange(0, 10)).toBe('bytes=0-39');
    expect(calculateRange(1, 10)).toBe('bytes=40-79');
  });

  it('handles page size of 1', () => {
    expect(calculateRange(0, 1)).toBe('bytes=0-3');
    expect(calculateRange(1, 1)).toBe('bytes=4-7');
  });
});
