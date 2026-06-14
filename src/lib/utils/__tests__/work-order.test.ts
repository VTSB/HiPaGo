// @vitest-environment node
/**
 * Tests for resolveWorkOrder (AC-004) — the pure per-page URL + ext resolver
 * extracted from downloadGalleryToLibrary. Asserts it produces the same URL/ext
 * the inline logic did (getImageUrl 'auto' + urlExt split).
 */
import { describe, it, expect } from 'vitest';
import { resolveWorkOrder } from '../work-order';
import { getImageUrl } from '../image-url';
import type { GalleryFile, GgConfig } from '../types';

const ggConfig: GgConfig = {
  pathCode: '1700000000',
  mDefault: 0,
  mCases: new Set<number>([1, 2]),
  mCaseValue: 1,
};

const file = (overrides: Partial<GalleryFile> = {}): GalleryFile => ({
  width: 800,
  height: 1200,
  haswebp: 1,
  hasavif: 0,
  hasavifsmalltn: 0,
  name: 'page.webp',
  hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  ...overrides,
});

describe('resolveWorkOrder', () => {
  it('returns one entry per file with ascending indices', () => {
    const files = [file(), file({ hash: 'b'.repeat(64) }), file({ hash: 'c'.repeat(64) })];
    const order = resolveWorkOrder(files, ggConfig);
    expect(order).toHaveLength(3);
    expect(order.map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it('url matches getImageUrl(file, cfg, "auto") for each page (no behavior drift)', () => {
    const files = [
      file({ haswebp: 1, hasavif: 0 }),
      file({ haswebp: 0, hasavif: 1, name: 'p.avif', hash: 'd'.repeat(64) }),
    ];
    const order = resolveWorkOrder(files, ggConfig);
    expect(order[0].url).toBe(getImageUrl(files[0], ggConfig, 'auto'));
    expect(order[1].url).toBe(getImageUrl(files[1], ggConfig, 'auto'));
  });

  it('ext is the URL-derived ext (strip query, last dot segment)', () => {
    const order = resolveWorkOrder([file({ haswebp: 1 })], ggConfig);
    const expected = order[0].url.split('?')[0].split('.').pop();
    expect(order[0].ext).toBe(expected);
    expect(order[0].ext).toBe('webp');
  });

  it('avif file resolves to an avif ext under auto', () => {
    const order = resolveWorkOrder([file({ haswebp: 0, hasavif: 1, name: 'p.avif' })], ggConfig);
    expect(order[0].ext).toBe('avif');
  });

  it('empty file list yields an empty work order', () => {
    expect(resolveWorkOrder([], ggConfig)).toEqual([]);
  });
});
