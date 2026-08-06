// @vitest-environment node
/**
 * Tests for resolveWorkOrder (AC-004) — the pure per-page URL + ext resolver
 * extracted from downloadGalleryToLibrary. Asserts it produces the same URL/ext
 * the inline logic did (getImageUrl 'auto' + urlExt split).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveWorkOrder,
  buildWorkOrder,
  buildIosWorkOrder,
  createDownloadRunId,
} from '../work-order';
import { getImageUrl } from '../image-url';
import { galleryFolderName, LIBRARY_ROOT } from '@/lib/storage/base-path-resolver';
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

describe('buildWorkOrder (Task C handoff)', () => {
  it('assigns a fresh opaque run id to each concrete attempt', () => {
    const first = createDownloadRunId();
    const second = createDownloadRunId();

    expect(first).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second).not.toBe(first);
  });

  it('preserves an explicitly supplied run id in the serialized handoff', () => {
    const order = buildWorkOrder(12345, 'My Title', [file()], ggConfig, 'run-aaaaaaaaaaaaaaaa');
    expect(order.runId).toBe('run-aaaaaaaaaaaaaaaa');
  });

  it('produces the galleryId/title/folderName + one page per file', () => {
    const files = [file(), file({ hash: 'b'.repeat(64) })];
    const order = buildWorkOrder(12345, 'My Title', files, ggConfig);
    expect(order.galleryId).toBe(12345);
    expect(order.title).toBe('My Title');
    expect(order.folderName).toBe(galleryFolderName(12345, 'My Title'));
    expect(order.pages).toHaveLength(2);
  });

  it('keeps an existing physical folder name when a retry sees a changed title', () => {
    const order = buildWorkOrder(
      12345,
      'New Title',
      [file()],
      ggConfig,
      'run-aaaaaaaaaaaaaaaa',
      '12345 Old Title',
    );

    expect(order.folderName).toBe('12345 Old Title');
    expect(order.pages[0].relPath).toContain(`${LIBRARY_ROOT}/12345 Old Title/0001.`);
  });

  it('relPath is HiPaGo/<folder>/<1-based zero-padded>.<ext> (matches imageFileName)', () => {
    const files = [file({ haswebp: 1 }), file({ hash: 'b'.repeat(64) })];
    const order = buildWorkOrder(777, 'T', files, ggConfig);
    const folder = galleryFolderName(777, 'T');
    expect(order.pages[0].relPath).toBe(`${LIBRARY_ROOT}/${folder}/0001.${order.pages[0].ext}`);
    expect(order.pages[1].relPath).toBe(`${LIBRARY_ROOT}/${folder}/0002.${order.pages[1].ext}`);
  });

  it('each page carries the same url/ext as resolveWorkOrder (no drift)', () => {
    const files = [file({ haswebp: 1, hasavif: 0 })];
    const order = buildWorkOrder(1, 'T', files, ggConfig);
    const flat = resolveWorkOrder(files, ggConfig);
    expect(order.pages[0].url).toBe(flat[0].url);
    expect(order.pages[0].ext).toBe(flat[0].ext);
    expect(order.pages[0].index).toBe(0);
  });

  it('headers default to {} off-native (getNativeHeaders is empty in node env)', () => {
    const order = buildWorkOrder(1, 'T', [file()], ggConfig);
    expect(order.pages[0].headers).toEqual({});
  });

  it('empty file list yields an empty pages array', () => {
    const order = buildWorkOrder(9, 'T', [], ggConfig);
    expect(order.pages).toEqual([]);
  });
});

describe('buildIosWorkOrder (Task D backstop)', () => {
  it('preserves an explicitly supplied run id for shared native bridge calls', () => {
    const order = buildIosWorkOrder(12345, 'My Title', [file()], ggConfig, 'run-aaaaaaaaaaaaaaaa');
    expect(order.runId).toBe('run-aaaaaaaaaaaaaaaa');
  });

  it('uses the NUMERIC downloads/<id>/ layout (no title), unlike the Android HiPaGo/<id title>/', () => {
    const files = [file({ haswebp: 1 }), file({ hash: 'b'.repeat(64) })];
    const order = buildIosWorkOrder(12345, 'My Title', files, ggConfig);
    expect(order.galleryId).toBe(12345);
    // Numeric-only folder (CapacitorDownloadStore galleryFolderName = String(id)).
    expect(order.folderName).toBe('12345');
    expect(order.pages).toHaveLength(2);
    expect(order.pages[0].relPath).toBe(`downloads/12345/0001.${order.pages[0].ext}`);
    expect(order.pages[1].relPath).toBe(`downloads/12345/0002.${order.pages[1].ext}`);
    // Must NOT carry the Android SAF prefix.
    expect(order.pages[0].relPath).not.toMatch(/^HiPaGo\//);
  });

  it('title with FS-unsafe chars never leaks into the iOS numeric path', () => {
    const order = buildIosWorkOrder(777, 'A/B:C?', [file()], ggConfig);
    expect(order.folderName).toBe('777');
    expect(order.pages[0].relPath).toBe(`downloads/777/0001.${order.pages[0].ext}`);
  });

  it('each page carries the same url/ext/index as resolveWorkOrder (no drift vs Android)', () => {
    const files = [file({ haswebp: 1, hasavif: 0 })];
    const order = buildIosWorkOrder(1, 'T', files, ggConfig);
    const flat = resolveWorkOrder(files, ggConfig);
    expect(order.pages[0].url).toBe(flat[0].url);
    expect(order.pages[0].ext).toBe(flat[0].ext);
    expect(order.pages[0].index).toBe(0);
  });

  it('headers default to {} off-native (getNativeHeaders is empty in node env)', () => {
    const order = buildIosWorkOrder(1, 'T', [file()], ggConfig);
    expect(order.pages[0].headers).toEqual({});
  });

  it('empty file list yields an empty pages array', () => {
    const order = buildIosWorkOrder(9, 'T', [], ggConfig);
    expect(order.pages).toEqual([]);
  });
});
