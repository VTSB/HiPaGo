import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure calculation logic extracted from VirtualGalleryGrid.tsx
//
// rowHeight = Math.ceil((containerWidth - gap * (cols - 1)) / cols * 1.5) + gap
// where gap = 12
// ---------------------------------------------------------------------------

const GAP = 12;

function computeRowHeight(containerWidth: number, cols: number): number {
  const cardWidth = (containerWidth - GAP * (cols - 1)) / cols;
  return Math.ceil(cardWidth * (3 / 2)) + GAP;
}

function rowPosition(rowIndex: number, rowHeight: number): number {
  return rowIndex * rowHeight;
}

function totalHeight(totalRows: number, rowHeight: number): number {
  return totalRows * rowHeight;
}

// ---------------------------------------------------------------------------
// Test 1: Row height calculation matches aspect-[2/3] + gap
// ---------------------------------------------------------------------------

describe('computeRowHeight — matches aspect-[2/3] formula', () => {
  it('returns 358 for 1200px wide, 5 cols', () => {
    // cardWidth = (1200 - 12*4) / 5 = (1200 - 48) / 5 = 1152 / 5 = 230.4
    // rowHeight = ceil(230.4 * 1.5) + 12 = ceil(345.6) + 12 = 346 + 12 = 358
    expect(computeRowHeight(1200, 5)).toBe(358);
  });

  it('returns 400 for 800px wide, 3 cols', () => {
    // cardWidth = (800 - 12*2) / 3 = (800 - 24) / 3 = 776 / 3 = 258.666...
    // rowHeight = ceil(258.666 * 1.5) + 12 = ceil(388) + 12 = 388 + 12 = 400
    expect(computeRowHeight(800, 3)).toBe(400);
  });

  it('returns 453 for 600px wide, 2 cols', () => {
    // cardWidth = (600 - 12*1) / 2 = 588 / 2 = 294
    // rowHeight = ceil(294 * 1.5) + 12 = ceil(441) + 12 = 441 + 12 = 453
    expect(computeRowHeight(600, 2)).toBe(453);
  });

  it('returns an integer (ceil ensures whole pixels)', () => {
    // Any fractional cardWidth should produce an integer rowHeight
    const height = computeRowHeight(1000, 7);
    expect(Number.isInteger(height)).toBe(true);
  });

  it('includes the gap in the final height', () => {
    // rowHeight must always be > cardHeight (gap is always added)
    const cols = 4;
    const width = 960;
    const cardWidth = (width - GAP * (cols - 1)) / cols;
    const cardHeight = Math.ceil(cardWidth * 1.5);
    expect(computeRowHeight(width, cols)).toBe(cardHeight + GAP);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Row positions are deterministic (index * rowHeight)
// ---------------------------------------------------------------------------

describe('rowPosition — index * rowHeight', () => {
  it('row 0 has position 0', () => {
    expect(rowPosition(0, 358)).toBe(0);
  });

  it('row 1 has position equal to rowHeight', () => {
    const rh = 358;
    expect(rowPosition(1, rh)).toBe(rh);
  });

  it('row N has position N * rowHeight', () => {
    const rh = 400;
    for (let n = 0; n <= 10; n++) {
      expect(rowPosition(n, rh)).toBe(n * rh);
    }
  });

  it('positions are strictly increasing with row index', () => {
    const rh = 453;
    for (let n = 1; n < 20; n++) {
      expect(rowPosition(n, rh)).toBeGreaterThan(rowPosition(n - 1, rh));
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Total height = totalRows * rowHeight
// ---------------------------------------------------------------------------

describe('totalHeight — totalRows * rowHeight', () => {
  it('is 0 when totalRows is 0', () => {
    expect(totalHeight(0, 358)).toBe(0);
  });

  it('equals rowHeight when there is exactly one row', () => {
    const rh = 400;
    expect(totalHeight(1, rh)).toBe(rh);
  });

  it('equals totalRows * rowHeight for arbitrary counts', () => {
    const cases: [number, number][] = [
      [10, 358],
      [100, 400],
      [250, 453],
      [1000, 312],
    ];
    for (const [rows, rh] of cases) {
      expect(totalHeight(rows, rh)).toBe(rows * rh);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Row height changes with container width (same col count)
// ---------------------------------------------------------------------------

describe('computeRowHeight — varies with container width', () => {
  it('wider container produces larger row height with same col count', () => {
    const cols = 4;
    const narrowHeight = computeRowHeight(800, cols);
    const wideHeight = computeRowHeight(1200, cols);
    expect(wideHeight).toBeGreaterThan(narrowHeight);
  });

  it('different widths produce different row heights', () => {
    const cols = 5;
    const h1 = computeRowHeight(900, cols);
    const h2 = computeRowHeight(1400, cols);
    expect(h1).not.toBe(h2);
  });

  it('narrower container produces smaller row height with same col count', () => {
    const cols = 3;
    const h480 = computeRowHeight(480, cols);
    const h768 = computeRowHeight(768, cols);
    const h1024 = computeRowHeight(1024, cols);
    expect(h480).toBeLessThan(h768);
    expect(h768).toBeLessThan(h1024);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Row height changes with column count (same container width)
// ---------------------------------------------------------------------------

describe('computeRowHeight — varies with column count', () => {
  it('more columns produce smaller row height at the same width', () => {
    const width = 1200;
    const h2 = computeRowHeight(width, 2);
    const h5 = computeRowHeight(width, 5);
    const h7 = computeRowHeight(width, 7);
    expect(h2).toBeGreaterThan(h5);
    expect(h5).toBeGreaterThan(h7);
  });

  it('different col counts produce different row heights', () => {
    const width = 1024;
    const heights = [2, 3, 4, 5, 6].map((cols) => computeRowHeight(width, cols));
    const unique = new Set(heights);
    expect(unique.size).toBe(heights.length);
  });

  it('single column fills full width so card height is ceil(width*1.5) + gap', () => {
    const width = 600;
    // With 1 col: cardWidth = (600 - 12*0) / 1 = 600, height = ceil(900) + 12 = 912
    expect(computeRowHeight(width, 1)).toBe(Math.ceil(width * 1.5) + GAP);
  });
});

// ---------------------------------------------------------------------------
// Test 6: GalleryCard has no contentVisibility style
// ---------------------------------------------------------------------------
// This test verifies statically that the Link element in GalleryCard.tsx
// does not use contentVisibility, which was removed as part of the fix.

import fs from 'fs';
import path from 'path';

describe('GalleryCard — contentVisibility removed', () => {
  it('GalleryCard.tsx does not contain contentVisibility', () => {
    const filePath = path.resolve(
      __dirname,
      '../GalleryCard.tsx',
    );
    const source = fs.readFileSync(filePath, 'utf-8');
    expect(source).not.toContain('contentVisibility');
  });
});
