// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderBase, waitFor, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

vi.mock('@/features/reader/hooks/useOfflineImages', () => ({
  useOfflineImages: vi.fn(),
}));

vi.mock('@/features/gallery-list/hooks/useGalleryBlock', () => ({
  useGalleryBlock: vi.fn(() => ({ type: 0 })), // GalleryBlockType.LOADING = 0
}));

const galleryActions = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
}));
vi.mock('@/shared/hooks/useGalleryActions', () => ({ useGalleryActions: () => galleryActions }));

vi.mock('@/features/gallery-detail/hooks/useDownloadGallery', () => ({
  useDownloadGallery: vi.fn(() => ({
    progress: null,
    start: vi.fn(),
    cancel: vi.fn(),
    queuedPosition: null,
    isDownloaded: false,
    error: null,
  })),
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
  getThumbnailUrl: vi.fn(
    (file: { name: string }, size?: string) => `https://cdn.test/${size || 'small'}/${file.name}`,
  ),
}));

vi.mock('@/lib/api/url-resolver', () => ({
  resolveThumbnailUrl: (url: string) => url,
}));

vi.mock('@/lib/db/adapter', () => ({ ensureDb: vi.fn(async () => ({ query: async () => [] })) }));

vi.mock('@/lib/db/gallery', () => ({
  recordVisit: vi.fn(() => Promise.resolve()),
  isFavorite: vi.fn(async () => false),
  getReadingProgress: vi.fn(async () => null),
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
import { rememberDetailEntryThumbnail } from '@/features/gallery-detail/utils/detailEntryThumbnail';
import { useOfflineImages } from '@/features/reader/hooks/useOfflineImages';
import { getThumbnailUrl } from '@/lib/utils/image-url';
import { useDownloadedFilesPresent } from '../hooks/useDownloadedFilesPresent';
import { useDownloadGallery } from '../hooks/useDownloadGallery';

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderBase(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

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
  galleryActions.open.mockClear();
  galleryActions.save.mockClear();
  galleryActions.download.mockClear();
  vi.mocked(useDownloadGallery).mockReturnValue({
    progress: null,
    start: vi.fn(),
    cancel: vi.fn(),
    queuedPosition: null,
    isDownloaded: false,
    error: null,
  });
  vi.mocked(useDownloadedFilesPresent).mockReturnValue({ filesMissing: false, checking: false });
  vi.mocked(useOfflineImages).mockReturnValue({
    sources: null,
    urls: null,
    dims: null,
    missing: false,
    loading: false,
  });
  vi.mocked(getThumbnailUrl).mockClear();
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
  it('loads manifest-only hero and visible previews from lazy local sources without hashless CDN URLs', async () => {
    mockDetail(makeFiles(80).map((file) => ({ ...file, hash: '', name: '' })));
    const sources = Array.from({ length: 80 }, (_, index) => ({
      index,
      ext: 'webp',
      loadUrl: vi.fn(async () => `http://localhost/_capacitor_content_/page-${index}.webp`),
    }));
    vi.mocked(useOfflineImages).mockReturnValue({
      sources,
      urls: null,
      dims: null,
      missing: false,
      loading: false,
    });

    const { container } = render(<GalleryDetail id={123} />);
    await waitFor(() =>
      expect(container.querySelector('img[alt="Test Gallery"]')).toHaveAttribute(
        'src',
        'http://localhost/_capacitor_content_/page-0.webp',
      ),
    );
    await waitFor(() =>
      expect(container.querySelector('img[alt="Page 2"]')).toHaveAttribute(
        'src',
        'http://localhost/_capacitor_content_/page-1.webp',
      ),
    );
    expect(getThumbnailUrl).not.toHaveBeenCalled();
    expect(container.querySelectorAll('img[alt^="Page "]')).toHaveLength(20);
    expect(sources.slice(20).every((source) => source.loadUrl.mock.calls.length === 0)).toBe(true);
    expect(useGalleryDetail).toHaveBeenCalledWith(123, { refreshDownloadedMetadata: true });
  });

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

describe('GalleryDetail shared work management', () => {
  it('exposes a single Download acquisition entry and visible work management', async () => {
    mockDetail(makeFiles(1));
    render(<GalleryDetail id={123} />);
    expect(screen.queryByRole('button', { name: 'actions.save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'actions.saved' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'detail.download' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'detail.download' }));
    expect(galleryActions.download).toHaveBeenCalledWith(
      expect.objectContaining({ id: 123, title: 'Test Gallery' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'detail.download' })).toBeEnabled(),
    );
    expect(galleryActions.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'actions.title' }));
    expect(galleryActions.open).toHaveBeenCalledWith(expect.objectContaining({ id: 123 }));
  });

  it.each([
    { action: 'download' as const, outcome: 'success', missing: false },
    { action: 'download' as const, outcome: 'failure', missing: false },
    { action: 'download' as const, outcome: 'success', missing: true },
    { action: 'download' as const, outcome: 'failure', missing: true },
  ])(
    'disables $action (missing=$missing) and restores controls after $outcome',
    async ({ action, outcome, missing }) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      galleryActions[action].mockImplementationOnce(
        () =>
          new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
          }),
      );
      vi.mocked(useDownloadedFilesPresent).mockReturnValue({
        filesMissing: missing,
        checking: false,
      });
      mockDetail(makeFiles(1));
      render(<GalleryDetail id={123} />);
      const download = screen.getByRole('button', {
        name: missing ? 'detail.filesMissing' : 'detail.download',
      });
      const trigger = download;
      fireEvent.click(trigger);
      expect(download).toBeDisabled();
      expect(trigger).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(trigger);
      expect(galleryActions[action]).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === 'success') resolve();
        else reject(new Error('Failed'));
      });
      await waitFor(() => expect(download).toBeEnabled());
      expect(trigger).toHaveAttribute('aria-busy', 'false');
      expect(galleryActions.save).not.toHaveBeenCalled();
    },
  );

  it('opens management from the completed detail state without starting another download', () => {
    mockDetail(makeFiles(1));
    vi.mocked(useDownloadGallery).mockReturnValue({
      progress: null,
      start: vi.fn(),
      cancel: vi.fn(),
      queuedPosition: null,
      isDownloaded: true,
      error: null,
    });
    render(<GalleryDetail id={123} />);
    expect(screen.queryByRole('button', { name: 'actions.save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'actions.saved' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'detail.downloaded' }));
    expect(galleryActions.open).toHaveBeenCalledWith(expect.objectContaining({ id: 123 }));
    expect(galleryActions.download).not.toHaveBeenCalled();
    expect(galleryActions.save).not.toHaveBeenCalled();
  });

  it('retains queued cancellation and visible download failures', () => {
    const cancel = vi.fn();
    mockDetail(makeFiles(1));
    vi.mocked(useDownloadGallery).mockReturnValue({
      progress: null,
      start: vi.fn(),
      cancel,
      queuedPosition: 2,
      isDownloaded: false,
      error: 'Download unavailable',
    });
    render(<GalleryDetail id={123} />);
    fireEvent.click(screen.getByRole('button', { name: 'library.queue.queued#2' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByText('Download unavailable')).toBeInTheDocument();
    expect(galleryActions.download).not.toHaveBeenCalled();
  });
});
