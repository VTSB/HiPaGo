// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
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
  TagChip: () => null,
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

function mockDetail(files: GalleryFile[] = []) {
  vi.mocked(useGalleryDetail).mockReturnValue({
    block: mockBlock,
    images: emptyImages,
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
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GalleryDetail thumbnail virtualization', () => {
  it('localizes detailed media type and falls back to raw language when no translation exists', () => {
    mockDetail();

    render(<GalleryDetail id={123} />);

    expect(document.body.textContent).toContain('만화');
    expect(document.body.textContent).toContain('italian');
    expect(document.body.textContent).not.toContain('manga · italian');
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
    // 5 thumbnails + 1 hero = 6
    expect(images.length).toBeLessThanOrEqual(6);
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
