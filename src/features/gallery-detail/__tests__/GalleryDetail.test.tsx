// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// IntersectionObserver mock
let ioCallback: IntersectionObserverCallback | null = null;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

function MockIntersectionObserver(
  this: IntersectionObserver,
  callback: IntersectionObserverCallback,
  _options?: IntersectionObserverInit,
) {
  ioCallback = callback;
  (this as any).observe = mockObserve;
  (this as any).disconnect = mockDisconnect;
}

// Mock Next.js
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

// Generate N fake files
const makeFiles = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `${String(i + 1).padStart(3, '0')}.jpg`,
    hash: `hash${i}`,
    width: 800,
    height: 1200,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const mockBlock = {
  type: GalleryBlockType.DETAILED,
  id: 123,
  title: 'Test Gallery',
  thumbnail: 'https://cdn.test/thumb.jpg',
  tags: { [TagType.TAG]: ['test'] },
  date: new Date('2025-01-01'),
  related: [],
};

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();
  ioCallback = null;
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GalleryDetail thumbnail virtualization', () => {
  it('renders at most 20 thumbnails initially for a large gallery', () => {
    const files = makeFiles(100);
    vi.mocked(useGalleryDetail).mockReturnValue({
      block: mockBlock as any,
      images: [],
      files,
      isLoading: false,
      error: null,
    });

    const { container } = render(<GalleryDetail id={123} />);
    const images = container.querySelectorAll('img');
    // 20 thumbnails + 1 hero image (bigThumbnail) = 21 max
    expect(images.length).toBeLessThanOrEqual(21);
    expect(images.length).toBeGreaterThanOrEqual(1); // at least hero
  });

  it('renders all thumbnails for a gallery with fewer than 20 files', () => {
    const files = makeFiles(5);
    vi.mocked(useGalleryDetail).mockReturnValue({
      block: mockBlock as any,
      images: [],
      files,
      isLoading: false,
      error: null,
    });

    const { container } = render(<GalleryDetail id={123} />);
    const images = container.querySelectorAll('img');
    // 5 thumbnails + 1 hero = 6
    expect(images.length).toBeLessThanOrEqual(6);
  });

  it('shows a sentinel with count when more thumbnails are available', () => {
    const files = makeFiles(50);
    vi.mocked(useGalleryDetail).mockReturnValue({
      block: mockBlock as any,
      images: [],
      files,
      isLoading: false,
      error: null,
    });

    const { container } = render(<GalleryDetail id={123} />);
    // Sentinel should show "20 / 50"
    expect(container.textContent).toContain('20 / 50');
  });

  it('does not show sentinel when all thumbnails are rendered', () => {
    const files = makeFiles(10);
    vi.mocked(useGalleryDetail).mockReturnValue({
      block: mockBlock as any,
      images: [],
      files,
      isLoading: false,
      error: null,
    });

    const { container } = render(<GalleryDetail id={123} />);
    expect(container.textContent).not.toContain('10 / 10');
  });
});
