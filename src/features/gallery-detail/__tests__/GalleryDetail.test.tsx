// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
const mockUnobserve = vi.fn();
const mockTakeRecords = vi.fn(() => []);

function MockIntersectionObserver(
  this: IntersectionObserver,
  _callback: IntersectionObserverCallback,
  _options?: IntersectionObserverInit,
) {
  void _options;
  Object.assign(this, {
    observe: mockObserve,
    unobserve: mockUnobserve,
    disconnect: mockDisconnect,
    takeRecords: mockTakeRecords,
    root: null,
    rootMargin: '',
    thresholds: [],
  });
}

// Mock Next.js
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// Generate N fake files
const makeFiles = (count: number): GalleryFile[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `${String(i + 1).padStart(3, '0')}.jpg`,
    hash: `hash${i}`,
    width: 800,
    height: 1200,
    haswebp: 1,
    hasavifsmalltn: 1,
    hasavif: 1,
  }));

vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  useGalleryDetail: vi.fn(),
}));

vi.mock('@/features/gallery-list/hooks/useGalleryBlock', () => ({
  useGalleryBlock: vi.fn(() => ({ type: 0 })), // GalleryBlockType.LOADING = 0
}));

vi.mock('@/features/gallery-detail/hooks/useFavoriteToggle', () => ({
  useFavoriteToggle: vi.fn(() => ({ isFav: false, isPending: false, toggle: vi.fn() })),
}));

vi.mock('@/features/gallery-detail/hooks/useDownloadGallery', () => ({
  useDownloadGallery: vi.fn(() => ({ progress: null, start: vi.fn(), cancel: vi.fn() })),
}));

vi.mock('@/features/gallery-detail/hooks/useDownloadedFilesPresent', () => ({
  useDownloadedFilesPresent: vi.fn(() => ({ filesMissing: false, checking: false })),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/i18n/useTagI18n', () => ({
  useTagI18n: () => new Map(),
  useTagLocalName: (type: string, name: string | undefined) => {
    const translations = new Map([['type:manga', '만화']]);
    return name ? translations.get(`${type}:${name}`) : undefined;
  },
}));

vi.mock('@/lib/api/client', () => ({
  getGgConfig: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/lib/utils/image-url', () => ({
  getThumbnailUrl: (file: { name: string }, size?: string) =>
    `https://cdn.test/${size || 'small'}/${file.name}`,
}));

vi.mock('@/lib/api/url-resolver', () => ({
  resolveThumbnailUrl: (url: string) => url,
}));

vi.mock('@/lib/db/gallery', () => ({
  recordVisit: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/shared/components/Spinner', () => ({
  Spinner: () => React.createElement('div', { 'data-testid': 'spinner' }),
}));

vi.mock('@/shared/components/AbortableImage', () => ({
  AbortableImage: ({ src, alt, ...props }: { src: string; alt: string; [key: string]: unknown }) =>
    React.createElement('img', { src, alt, ...props }),
  preloadImageSource: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/shared/components/TagChip', () => ({
  TagChip: ({ tag, type }: { tag: string; type: string }) =>
    React.createElement('span', { 'data-tag-chip': `${type}:${tag}` }, tag),
}));

vi.mock('@/features/gallery-list/components/GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) =>
    React.createElement('div', { 'data-testid': `related-${id}` }),
}));

// Import component AFTER mocks
import { GalleryDetail } from '../components/GalleryDetail';
import { useGalleryDetail } from '../hooks/useGalleryDetail';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile, GalleryImages } from '@/lib/utils/types';
import { rememberDetailEntryThumbnail } from '@/features/gallery-detail/utils/detailEntryThumbnail';
import { useSettingsStore } from '@/lib/store/settings';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const mockBlock: GalleryBlock = {
  type: GalleryBlockType.DETAILED,
  id: 123,
  title: 'Test Gallery',
  thumbnail: 'https://cdn.test/thumb.jpg',
  tags: { [TagType.TAG]: ['test'] },
  date: new Date('2025-01-01'),
  related: [],
  language: 'italian',
  mediaType: 'manga',
};

const emptyImages: GalleryImages = {
  id: mockBlock.id,
  images: [],
};

function mockDetail(files: GalleryFile[] = [], block: GalleryBlock = mockBlock) {
  vi.mocked(useGalleryDetail).mockReturnValue({
    block,
    images: { ...emptyImages, id: block.id },
    files,
    isLoading: false,
    error: null,
  });
}

beforeEach(() => {
  mockObserve.mockClear();
  mockUnobserve.mockClear();
  mockDisconnect.mockClear();
  mockTakeRecords.mockClear();
  useSettingsStore.setState({ locale: 'en', favoriteTags: [] });
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GalleryDetail', () => {
  it('prioritizes favorites within each metadata type and toggles them as a sibling control', () => {
    const favoriteKey = toFavoriteTagKey(TagType.ARTIST, 'favorite artist');
    useSettingsStore.setState({ favoriteTags: [favoriteKey] });
    mockDetail([], {
      ...mockBlock,
      tags: {
        [TagType.ARTIST]: ['popular artist', 'favorite artist', 'second artist'],
        [TagType.TAG]: ['other tag'],
      },
    });

    const { container } = render(<GalleryDetail id={123} />);
    const artistChips = Array.from(container.querySelectorAll('[data-tag-chip^="artist:"]')).map(
      (chip) => chip.getAttribute('data-tag-chip'),
    );

    expect(artistChips).toEqual([
      'artist:favorite artist',
      'artist:popular artist',
      'artist:second artist',
    ]);

    const favoriteButton = container.querySelector<HTMLButtonElement>(
      `[data-tag-favorite-key="${favoriteKey}"]`,
    );
    expect(favoriteButton).not.toBeNull();
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
    expect(favoriteButton?.closest('a')).toBeNull();

    act(() => {
      fireEvent.click(favoriteButton!);
    });
    expect(useSettingsStore.getState().favoriteTags).toEqual([]);
  });

  it('localizes detailed media type and falls back to raw language when no translation exists', () => {
    mockDetail();

    const { container } = render(<GalleryDetail id={123} />);

    expect(document.body.textContent).toContain('만화');
    expect(document.body.textContent).toContain('italian');
    expect(document.body.textContent).not.toContain('manga · italian');
    expect(
      container.querySelector(
        `[data-tag-favorite-key="${toFavoriteTagKey(TagType.TYPE, 'manga')}"]`,
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        `[data-tag-favorite-key="${toFavoriteTagKey(TagType.LANGUAGE, 'italian')}"]`,
      ),
    ).toBeNull();
  });

  it('renders at most 20 thumbnails initially for a large gallery', () => {
    const files = makeFiles(100);
    mockDetail(files);

    const { container } = render(<GalleryDetail id={123} />);
    const images = container.querySelectorAll('img');
    // 20 thumbnails + 1 hero image (bigThumbnail) = 21 max
    expect(images.length).toBeLessThanOrEqual(21);
    expect(images.length).toBeGreaterThanOrEqual(1); // at least hero
  });

  it('renders all thumbnails for a gallery with fewer than 20 files', () => {
    const files = makeFiles(5);
    mockDetail(files);

    const { container } = render(<GalleryDetail id={123} />);
    const images = container.querySelectorAll('img');
    // 5 thumbnails + up to 2 hero layers (cached + big) = 7; cached is null here
    // (no remembered/cachedBlock thumbnail) so it is 5 + 1 big = 6.
    expect(images.length).toBeLessThanOrEqual(7);
  });

  it('layers the clicked thumbnail UNDER the big thumbnail (no src-swap flicker)', () => {
    // The clicked thumbnail is remembered outside the React tree on list-card click.
    rememberDetailEntryThumbnail(777, 'https://cdn.test/clicked/777.jpg');
    mockDetail(makeFiles(3));

    const { container } = render(<GalleryDetail id={777} />);
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    // Both layers are present at the same time — the cached image is never
    // removed/swapped, so there is no blank frame when the big one decodes.
    expect(srcs).toContain('https://cdn.test/clicked/777.jpg');
    expect(srcs.some((s) => s?.startsWith('https://cdn.test/big/'))).toBe(true);
  });

  it('remounts the hero on id change so the previous gallery image cannot persist', () => {
    rememberDetailEntryThumbnail(771, 'https://cdn.test/clicked/771.jpg');
    rememberDetailEntryThumbnail(772, 'https://cdn.test/clicked/772.jpg');
    mockDetail(); // no files → a single (cached) hero layer

    const { container, rerender } = render(<GalleryDetail id={771} />);
    const before = container.querySelector('img');
    expect(before?.getAttribute('src')).toBe('https://cdn.test/clicked/771.jpg');

    // Navigate detail→detail. The hero is keyed by id, so it must be a FRESH
    // node (not the reused element that would keep painting 771's pixels).
    rerender(<GalleryDetail id={772} />);
    const after = container.querySelector('img');
    expect(after?.getAttribute('src')).toBe('https://cdn.test/clicked/772.jpg');
    expect(after).not.toBe(before);
  });

  it('shows a sentinel with count when more thumbnails are available', () => {
    const files = makeFiles(50);
    mockDetail(files);

    const { container } = render(<GalleryDetail id={123} />);
    // Sentinel should show "20 / 50"
    expect(container.textContent).toContain('20 / 50');
  });

  it('does not show sentinel when all thumbnails are rendered', () => {
    const files = makeFiles(10);
    mockDetail(files);

    const { container } = render(<GalleryDetail id={123} />);
    expect(container.textContent).not.toContain('10 / 10');
  });
});
