// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';
import type { QueueItem } from '@/lib/store/download-progress';
import { useZipExportStore } from '@/lib/store/zip-export';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';
import { TagType } from '@/lib/utils/types';

// Stub matchMedia (jsdom doesn't ship it) so the useIsMobile branch in the new
// LibraryHub wrapper resolves deterministically to "desktop" — on desktop the
// hub renders <DownloadsView /> byte-equivalent to the old library page, keeping
// these assertions valid. Mobile segmented-control behavior is covered by
// qa-browser. Same stub shape as FloatingPageNav.test.tsx.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (typeof window !== 'undefined' && !window.IntersectionObserver) {
  class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const mockDevice = vi.hoisted(() => ({
  isMobile: false,
}));
const mockSettings = vi.hoisted(() => ({
  libraryInitialTab: 'favorites' as 'favorites' | 'history' | 'downloads',
  favoriteTags: [] as string[],
}));
const mockQueueOps = vi.hoisted(() => ({
  enqueueDownload: vi.fn(async () => 1),
}));
const mockRetryOps = vi.hoisted(() => ({
  clearAutoRetry: vi.fn(async () => {}),
}));
const mockDownloadProgressState = vi.hoisted(() => ({
  entries: {},
  downloaded: {},
  queue: [] as QueueItem[],
  globalPaused: false,
  start: vi.fn(async () => {}),
  cancel: vi.fn(),
  refreshDownloaded: vi.fn(async () => {}),
  refreshQueue: vi.fn(async () => {}),
  reorder: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  pauseAll: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  clearRetryPending: vi.fn(),
}));
const mockListDownloads = vi.fn<() => Promise<DBDownload[]>>();
const mockSearchDownloads = vi.fn<(opts: { query?: string }) => Promise<DBDownload[]>>();
const mockDeleteDownload = vi.fn<(id: number) => Promise<void>>();
const mockCreateDownloadStore = vi.fn();
const mockExportGalleryZip =
  vi.fn<
    (
      galleryId: number,
      title: string,
      onProgress?: (progress: { current: number; total: number }) => void,
    ) => Promise<'saved' | 'started' | 'cancelled'>
  >();
const mockHasCompleteDownloadedGallery =
  vi.fn<
    (
      galleryId: number,
      expectedPageCount: number,
      options?: { folderName?: string | null },
    ) => Promise<boolean>
  >();
const mockProcessQueue = vi
  .fn<(opts?: { onlyGalleryId?: number }) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockNavigation.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('@/shared/hooks/useIsMobile', () => ({
  useIsMobile: () => mockDevice.isMobile,
}));

vi.mock('@/lib/db/download', () => ({
  listDownloads: () => mockListDownloads(),
  // DownloadsView now reads the LIBRARY-filtered list; point it at the same
  // mock so existing assertions (which seed mockListDownloads) keep working.
  listLibraryDownloads: () => mockListDownloads(),
  searchDownloads: (opts: { query?: string }) => mockSearchDownloads(opts),
  deleteDownload: (id: number) => mockDeleteDownload(id),
  // The redesigned card deserializes tags at render time (not just in retry),
  // so the mock must provide it too.
  deserializeTags: (raw: string) => {
    try {
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  },
}));

// The queue layer + processor are pulled in by the rewired retry path; stub them
// so the page test stays a pure UI render test (no DB adapter / network).
vi.mock('@/lib/db/download-queue', () => ({
  enqueueDownload: mockQueueOps.enqueueDownload,
}));

vi.mock('@/lib/db/download-retry', () => ({
  clearAutoRetry: mockRetryOps.clearAutoRetry,
  AUTO_RETRY_MAX: 3,
}));

vi.mock('@/lib/store/download-progress', () => {
  // Full-enough store shape: DownloadQueueView (mounted atop DownloadsView since
  // Task B) reads queue/globalPaused + action selectors, and renders nothing when
  // queue is empty — so an empty queue keeps this a pure library-list render test.
  const useDownloadProgressStore = Object.assign(
    (sel: (s: typeof mockDownloadProgressState) => unknown) => sel(mockDownloadProgressState),
    { getState: () => mockDownloadProgressState },
  );
  return {
    DOWNLOAD_LIBRARY_CHANGED_EVENT: 'hipago:download-library-changed',
    processQueue: mockProcessQueue,
    useDownloadProgressStore,
  };
});

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: () => mockCreateDownloadStore(),
}));

vi.mock('@/lib/utils/download-zip', () => ({
  exportGalleryZip: (
    galleryId: number,
    title: string,
    onProgress?: (progress: { current: number; total: number }) => void,
  ) => mockExportGalleryZip(galleryId, title, onProgress),
  hasCompleteDownloadedGallery: (
    galleryId: number,
    expectedPageCount: number,
    options?: { folderName?: string | null },
  ) => mockHasCompleteDownloadedGallery(galleryId, expectedPageCount, options),
}));

// Mock next/link as a plain anchor
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    [k: string]: unknown;
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

// Mock Spinner
vi.mock('@/shared/components/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

// Mock i18n — return the key so tests are locale-agnostic
vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (
    sel: (s: {
      locale: string;
      libraryInitialTab: 'favorites' | 'history' | 'downloads';
      favoriteTags: string[];
    }) => unknown,
  ) =>
    sel({
      locale: 'en',
      libraryInitialTab: mockSettings.libraryInitialTab,
      favoriteTags: mockSettings.favoriteTags,
    }),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<DBDownload> = {}): DBDownload {
  return {
    galleryId: 1001,
    title: 'Test Gallery',
    thumbnail: '',
    tags: '{}',
    pageCount: 20,
    totalBytes: 1024 * 1024 * 5,
    downloadedAt: new Date('2024-01-15').toISOString(),
    status: 'complete',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Render helper — lazy import so vi.mock factories are applied first
// ---------------------------------------------------------------------------

async function renderPage() {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { default: LibraryPage } = await import('../page');
  const React = await import('react');

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const result = render(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(LibraryPage)),
  );
  return { ...result, qc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDevice.isMobile = false;
    mockSettings.libraryInitialTab = 'favorites';
    mockSettings.favoriteTags = [];
    mockDownloadProgressState.entries = {};
    mockDownloadProgressState.downloaded = {};
    mockDownloadProgressState.queue = [];
    mockDownloadProgressState.globalPaused = false;
    useZipExportStore.getState().reset();
    window.history.replaceState({}, '', '/library');
    sessionStorage.clear();
    mockCreateDownloadStore.mockResolvedValue({
      usage: vi.fn().mockResolvedValue(0),
      deleteGallery: vi.fn().mockResolvedValue(undefined),
    });
    mockExportGalleryZip.mockResolvedValue('saved');
    mockHasCompleteDownloadedGallery.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC-004: list renders ──────────────────────────────────────────────────

  it('shows a spinner while loading', async () => {
    mockListDownloads.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await renderPage();
    });

    expect(screen.getByTestId('spinner')).toBeTruthy();
  });

  it('renders an empty-state message when there are no downloads', async () => {
    mockListDownloads.mockResolvedValue([]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('library.empty')).toBeTruthy();
  });

  it('renders a card for each downloaded item', async () => {
    const items: DBDownload[] = [
      makeItem({ galleryId: 1001, title: 'Gallery One' }),
      makeItem({ galleryId: 1002, title: 'Gallery Two', status: 'failed' }),
    ];
    mockListDownloads.mockResolvedValue(items);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Gallery One')).toBeTruthy();
    expect(screen.getByText('Gallery Two')).toBeTruthy();
  });

  it('does not show a downloading badge for a complete row with stale 100% progress', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 1010, title: 'Already Complete', status: 'complete', pageCount: 20 }),
    ]);
    mockDownloadProgressState.entries = {
      1010: { progress: { current: 20, total: 20 }, error: null },
    };

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Already Complete')).toBeTruthy();
    expect(screen.queryByText('20/20 · 100%')).toBeNull();
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('does not show a downloading badge for a complete row with stale partial progress', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 1012, title: 'Complete With Stale Entry', status: 'complete' }),
    ]);
    mockDownloadProgressState.downloaded = { 1012: true };
    mockDownloadProgressState.entries = {
      1012: { progress: { current: 19, total: 20 }, error: null },
    };

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Complete With Stale Entry')).toBeTruthy();
    expect(screen.queryByText('19/20 · 95%')).toBeNull();
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('does not show stale partial progress for an unseeded complete row', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 1014, title: 'Complete Unseeded', status: 'complete' }),
    ]);
    mockDownloadProgressState.entries = {
      1014: { progress: { current: 19, total: 20 }, error: null },
    };

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Complete Unseeded')).toBeTruthy();
    expect(screen.queryByText('19/20 · 95%')).toBeNull();
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('still shows progress for an active re-download of a complete row', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 1011, title: 'Re-downloading', status: 'complete', pageCount: 20 }),
    ]);
    mockDownloadProgressState.downloaded = { 1011: false };
    mockDownloadProgressState.entries = {
      1011: { progress: { current: 7, total: 20 }, error: null },
    };

    await act(async () => {
      await renderPage();
    });
    await screen.findByText('7/20 · 35%');

    expect(screen.getByText('Re-downloading')).toBeTruthy();
    expect(screen.getByText('7/20 · 35%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'library.more' })).toBeNull();
  });

  it('does not show the empty library CTA when only queued downloads exist', async () => {
    mockListDownloads.mockResolvedValue([]);
    mockDownloadProgressState.queue = [
      {
        id: 1013,
        title: 'Queued Only',
        thumbnail: '',
        status: 'queued',
        position: 1,
        progress: null,
      },
    ];

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Queued Only')).toBeTruthy();
    expect(screen.queryByText('library.empty')).toBeNull();
    expect(screen.queryByText('empty.browseGalleries')).toBeNull();
  });

  it('renders total item count in the heading', async () => {
    mockListDownloads.mockResolvedValue([makeItem(), makeItem({ galleryId: 1002 })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('(2)')).toBeTruthy();
  });

  it('makes the whole card a link pointing to the gallery route', async () => {
    // The card is now a cover-forward gallery-block card: tapping the card
    // itself opens the gallery (no inline "Open" button).
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 1001 })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const cardLink = screen.getByRole('link');
    expect(cardLink.getAttribute('href')).toBe('/gallery?id=1001');
  });

  it('opens the downloads segment on mobile when the URL tab is downloads', async () => {
    mockDevice.isMobile = true;
    window.history.replaceState({}, '', '/library?tab=downloads');
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 1001, title: 'Saved Download' })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(
      screen.getByRole('tab', { name: 'saved.seg.downloads' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('Saved Download')).toBeTruthy();
  });

  it('uses the configured initial tab on mobile when the URL has no tab', async () => {
    mockDevice.isMobile = true;
    mockSettings.libraryInitialTab = 'downloads';
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 1001, title: 'Saved Download' })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(
      screen.getByRole('tab', { name: 'saved.seg.downloads' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('Saved Download')).toBeTruthy();
  });

  it('writes the downloads tab into the URL when selected on mobile', async () => {
    mockDevice.isMobile = true;
    mockListDownloads.mockResolvedValue([]);

    await act(async () => {
      await renderPage();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'saved.seg.downloads' }));
    });

    expect(mockNavigation.replace).toHaveBeenCalledWith('/library?tab=downloads', {
      scroll: false,
    });
  });

  it('remembers the downloads tab URL before opening a downloaded gallery', async () => {
    mockDevice.isMobile = true;
    window.history.replaceState({}, '', '/library?tab=downloads');
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 1001, title: 'Saved Download' })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('link'));
    });

    expect(sessionStorage.getItem('hipago:last-list-url')).toBe('/library?tab=downloads');
  });

  it('does NOT show per-card size/page-count metadata on the card face', async () => {
    // The redesigned card matches the gallery-block card: title + tags only.
    // Page count and size were removed from the card (storage-used stays in the
    // page header). Verify the page-count number is not rendered on the card.
    mockListDownloads.mockResolvedValue([
      makeItem({ pageCount: 42, totalBytes: 1024, title: 'Sized Gallery' }),
    ]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Sized Gallery')).toBeTruthy();
    expect(screen.queryByText(/42/)).toBeNull();
  });

  it('shows favorite metadata first on downloaded gallery cards', async () => {
    const favoriteKey = toFavoriteTagKey(TagType.TAG, 'favorite tag');
    mockSettings.libraryInitialTab = 'downloads';
    mockSettings.favoriteTags = [favoriteKey];
    mockListDownloads.mockResolvedValue([
      makeItem({
        title: 'Tagged Download',
        tags: JSON.stringify({
          artist: ['priority artist'],
          tag: ['favorite tag', 'ordinary tag'],
        }),
      }),
    ]);

    let view: Awaited<ReturnType<typeof renderPage>>;
    await act(async () => {
      view = await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const renderedKeys = Array.from(view!.container.querySelectorAll('[data-tag-key]')).map((tag) =>
      tag.getAttribute('data-tag-key'),
    );
    expect(renderedKeys[0]).toBe(favoriteKey);
  });

  // ── AC-004: delete action ─────────────────────────────────────────────────

  it('calls deleteDownload and deleteGallery when delete is confirmed', async () => {
    const item = makeItem({ galleryId: 2001 });
    mockListDownloads.mockResolvedValue([item]);
    mockDeleteDownload.mockResolvedValue(undefined);
    const mockDeleteGallery = vi.fn().mockResolvedValue(undefined);
    mockCreateDownloadStore.mockResolvedValue({
      usage: vi.fn().mockResolvedValue(0),
      deleteGallery: mockDeleteGallery,
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const moreBtn = screen.getByRole('button', { name: 'library.more' });
    await act(async () => {
      fireEvent.click(moreBtn);
    });

    const deleteBtn = screen.getByRole('menuitem', { name: 'library.delete' });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(mockDeleteDownload).toHaveBeenCalledWith(2001);
    expect(mockDeleteGallery).toHaveBeenCalledWith(2001, { folderName: null });
    expect(mockDeleteGallery.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteDownload.mock.invocationCallOrder[0],
    );
    expect(mockDownloadProgressState.cancel).not.toHaveBeenCalled();
  });

  it('keeps the DB row and shows an error when physical folder deletion fails', async () => {
    const item = makeItem({ galleryId: 2005, folderName: '2005 Exact Folder' });
    mockListDownloads.mockResolvedValue([item]);
    const mockDeleteGallery = vi.fn().mockRejectedValue(new Error('provider denied delete'));
    mockCreateDownloadStore.mockResolvedValue({
      usage: vi.fn().mockResolvedValue(0),
      deleteGallery: mockDeleteGallery,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      await renderPage();
    });
    await screen.findByText('Test Gallery');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.delete' }));
    });

    await screen.findByText('library.deleteFailed');
    expect(mockDeleteGallery).toHaveBeenCalledWith(2005, { folderName: '2005 Exact Folder' });
    expect(mockDeleteDownload).not.toHaveBeenCalled();
    expect(useZipExportStore.getState().deletingGalleryIds.has(2005)).toBe(false);
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('keeps delete claimed across a remount and releases it after completion', async () => {
    const item = makeItem({ galleryId: 2006, title: 'Deleting Gallery' });
    mockListDownloads.mockResolvedValue([item]);
    let finishDelete!: () => void;
    const mockDeleteGallery = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    mockCreateDownloadStore.mockResolvedValue({
      usage: vi.fn().mockResolvedValue(0),
      deleteGallery: mockDeleteGallery,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    let firstRender!: Awaited<ReturnType<typeof renderPage>>;
    await act(async () => {
      firstRender = await renderPage();
    });
    await screen.findByText('Deleting Gallery');
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'library.delete' }));
    await waitFor(() => expect(mockDeleteGallery).toHaveBeenCalledTimes(1));
    expect(useZipExportStore.getState().deletingGalleryIds.has(2006)).toBe(true);

    firstRender.unmount();
    await act(async () => {
      await renderPage();
    });
    await screen.findByText('Deleting Gallery');
    expect(screen.queryByRole('button', { name: 'library.more' })).toBeNull();
    expect(useZipExportStore.getState().begin(2006, 'Deleting Gallery')).toBeNull();
    expect(mockExportGalleryZip).not.toHaveBeenCalled();

    await act(async () => finishDelete());
    await waitFor(() =>
      expect(useZipExportStore.getState().deletingGalleryIds.has(2006)).toBe(false),
    );
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('cancels native/in-flight work before deleting a downloading row', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 2002, title: 'Active Native Download', status: 'downloading' }),
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      await renderPage();
    });
    await screen.findByText('Active Native Download');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.delete' }));
    });

    expect(mockDownloadProgressState.cancel).toHaveBeenCalledWith(2002);
    expect(mockDeleteDownload).toHaveBeenCalledWith(2002);
  });

  it('clears a pending auto-retry before deleting a failed row', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({
        galleryId: 2003,
        title: 'Retry Pending',
        status: 'failed',
        nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
        retryCount: 1,
      }),
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.delete' }));
    });

    expect(mockRetryOps.clearAutoRetry).toHaveBeenCalledWith(2003);
    expect(mockDownloadProgressState.clearRetryPending).toHaveBeenCalledWith(2003);
    expect(mockDeleteDownload).toHaveBeenCalledWith(2003);
  });

  it('clears live pending auto-retry before deleting a just-failed row', async () => {
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    mockListDownloads.mockResolvedValue([
      makeItem({
        galleryId: 2004,
        title: 'Live Retry Pending',
        status: 'failed',
        nextRetryAt: null,
        retryCount: 0,
      }),
    ]);
    mockDownloadProgressState.entries = {
      2004: { progress: null, error: 'boom', retryAt, attempt: 1 },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.delete' }));
    });

    expect(mockRetryOps.clearAutoRetry).toHaveBeenCalledWith(2004);
    expect(mockDownloadProgressState.clearRetryPending).toHaveBeenCalledWith(2004);
    expect(mockDeleteDownload).toHaveBeenCalledWith(2004);
  });

  it('does NOT delete when the confirm dialog is cancelled', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 3001 })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const moreBtn = screen.getByRole('button', { name: 'library.more' });
    await act(async () => {
      fireEvent.click(moreBtn);
    });

    const deleteBtn = screen.getByRole('menuitem', { name: 'library.delete' });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(mockDeleteDownload).not.toHaveBeenCalled();
  });

  it('shows an export error when stored files are missing', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4001, title: 'Broken Export' })]);
    const sourceError = new Error('Missing downloaded page 2');
    sourceError.name = 'ZipExportSourceError';
    mockExportGalleryZip.mockRejectedValue(sourceError);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('library.exportSourceFailed');
    expect(mockExportGalleryZip).toHaveBeenCalledWith(4001, 'Broken Export', expect.any(Function));
  });

  it('shows a storage-specific export error when saving the ZIP fails', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4006, title: 'Disk Full' })]);
    mockExportGalleryZip.mockRejectedValue(new Error('disk full'));

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('library.exportFailed');
  });

  it('shows a failed badge and hides export when a complete DB row is missing files', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4003, title: 'Missing Files' })]);
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);

    let qc: Awaited<ReturnType<typeof renderPage>>['qc'];
    await act(async () => {
      ({ qc } = await renderPage());
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());
    await waitFor(() =>
      expect(mockHasCompleteDownloadedGallery).toHaveBeenCalledWith(4003, 20, {
        folderName: null,
      }),
    );
    const invalidate = vi.spyOn(qc!, 'invalidateQueries');

    expect(screen.getByText('library.status.failed')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });

    expect(screen.queryByRole('menuitem', { name: 'library.exportZip' })).toBeNull();
    const retry = screen.getByRole('menuitem', { name: 'library.retry' });
    expect(retry).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'library.delete' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => expect(mockProcessQueue).toHaveBeenCalledWith({ onlyGalleryId: 4003 }));
    expect(mockRetryOps.clearAutoRetry).toHaveBeenCalledWith(4003);
    expect(mockQueueOps.enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 4003, title: 'Missing Files' }),
      { userInitiated: true },
    );
    expect(mockDownloadProgressState.clearRetryPending).toHaveBeenCalledWith(4003);
    expect(mockDownloadProgressState.refreshQueue).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['download-integrity'] });
  });

  it('manual retry only starts the selected failed gallery', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 4100, title: 'Failed Retry', status: 'failed' }),
    ]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.retry' }));
    });

    await waitFor(() => expect(mockProcessQueue).toHaveBeenCalledWith({ onlyGalleryId: 4100 }));
    expect(mockRetryOps.clearAutoRetry).toHaveBeenCalledWith(4100);
    expect(mockQueueOps.enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 4100, title: 'Failed Retry' }),
      { userInitiated: true },
    );
    expect(mockDownloadProgressState.clearRetryPending).toHaveBeenCalledWith(4100);
    expect(mockDownloadProgressState.refreshQueue).toHaveBeenCalled();
  });

  it('shows pending auto-retry from the live store before the DB row refetches', async () => {
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    mockListDownloads.mockResolvedValue([
      makeItem({
        galleryId: 4200,
        title: 'Just Failed',
        status: 'failed',
        nextRetryAt: null,
        retryCount: 0,
      }),
    ]);
    mockDownloadProgressState.entries = {
      4200: { progress: null, error: 'boom', retryAt, attempt: 1 },
    };

    await act(async () => {
      await renderPage();
    });

    expect(await screen.findByText('library.retry.autoIn (library.retry.attempt)')).toBeTruthy();
  });

  it('hides export while complete-row integrity is still being checked', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4004, title: 'Pending Check' })]);
    mockHasCompleteDownloadedGallery.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });

    expect(screen.queryByRole('menuitem', { name: 'library.exportZip' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'library.retry' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'library.delete' })).toBeTruthy();
  });

  it('shows ZIP export progress while a large export is pending', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4005, title: 'Large Export' })]);
    let finishExport!: () => void;
    mockExportGalleryZip.mockImplementation((_galleryId, _title, onProgress) => {
      onProgress?.({ current: 3, total: 20 });
      return new Promise<'saved'>((resolve) => {
        finishExport = () => resolve('saved');
      });
    });

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));
    });

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('library.exportingZip');
    expect(status.textContent).toContain('(3/20)');
    expect(status.textContent).toContain('Large Export');

    await act(async () => finishExport());
    const success = await screen.findByRole('status');
    expect(success.textContent).toContain('library.exportSucceeded');
    expect(success.textContent).toContain('Large Export');
  });

  it('reports a browser download as started instead of claiming it was saved', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4007, title: 'Web Export' })]);
    mockExportGalleryZip.mockResolvedValue('started');

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('library.exportStarted'),
    );
    const status = screen.getByRole('status');
    expect(status.textContent).not.toContain('library.exportSucceeded');
    expect(status.textContent).toContain('Web Export');
  });

  it('restores ZIP progress and the source-card lock after a remount', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 4008, title: 'Persistent Export' }),
    ]);
    let finishExport!: () => void;
    mockExportGalleryZip.mockImplementation((_galleryId, _title, onProgress) => {
      onProgress?.({ current: 4, total: 20 });
      return new Promise<'saved'>((resolve) => {
        finishExport = () => resolve('saved');
      });
    });

    let firstRender!: Awaited<ReturnType<typeof renderPage>>;
    await act(async () => {
      firstRender = await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));
    expect((await screen.findByRole('status')).textContent).toContain('(4/20)');

    firstRender.unmount();
    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const restored = await screen.findByRole('status');
    expect(restored.textContent).toContain('(4/20)');
    expect(restored.textContent).toContain('Persistent Export');
    expect(screen.queryByRole('button', { name: 'library.more' })).toBeNull();

    await act(async () => finishExport());
    expect((await screen.findByRole('status')).textContent).toContain('library.exportSucceeded');
    expect(screen.getByRole('button', { name: 'library.more' })).toBeTruthy();
  });

  it('keeps unrelated card actions but globally single-flights ZIP export', async () => {
    mockListDownloads.mockResolvedValue([
      makeItem({ galleryId: 4009, title: 'Active Export' }),
      makeItem({ galleryId: 4010, title: 'Other Gallery' }),
    ]);
    let finishExport!: () => void;
    mockExportGalleryZip.mockImplementation(
      () =>
        new Promise<'saved'>((resolve) => {
          finishExport = () => resolve('saved');
        }),
    );

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'library.more' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));
    await waitFor(() => expect(mockExportGalleryZip).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'library.more' })).toHaveLength(1),
    );
    const remainingMenu = screen.getByRole('button', { name: 'library.more' });
    fireEvent.click(remainingMenu);
    expect(screen.queryByRole('menuitem', { name: 'library.exportZip' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'library.delete' })).toBeTruthy();

    await act(async () => finishExport());
  });

  it('hides card actions while an export is pending', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 4002, title: 'Slow Export' })]);
    mockExportGalleryZip.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'library.more' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'library.exportZip' }));
    });
    expect(mockExportGalleryZip).toHaveBeenCalledTimes(1);
    expect(mockExportGalleryZip).toHaveBeenCalledWith(4002, 'Slow Export', expect.any(Function));
    expect(screen.queryByRole('button', { name: 'library.more' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'library.delete' })).toBeNull();
  });

  // ── AC-006: search filters the list ──────────────────────────────────────
  //
  // The search path involves two layers of async: the debounce setTimeout
  // (250 ms) and React-Query's own internal scheduler (also setTimeout-based).
  // Both layers interact with fake timers, making flush-and-check patterns
  // unreliable.  The cleanest solution: bypass the debounce by testing the
  // underlying query behaviour directly — set debouncedQuery by typing text
  // and relying on real timers + waitFor.  The debounce is 250 ms; with a
  // 3 s waitFor timeout there is ample headroom even in slow CI.
  //
  // A separate test verifies the debounce mechanism in isolation without
  // React-Query involvement.

  it('does not call searchDownloads immediately on typing (debounce check)', async () => {
    // Use fake timers only to prove searchDownloads is NOT called before 250 ms.
    // We do NOT advance timers here — just check the call count right after typing.
    mockListDownloads.mockResolvedValue([makeItem()]);
    mockSearchDownloads.mockResolvedValue([]);

    vi.useFakeTimers();
    try {
      await act(async () => {
        await renderPage();
      });
      // Drain the initial listDownloads fetch
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const input = screen.getByRole('textbox');
      act(() => {
        fireEvent.change(input, { target: { value: 'dragon' } });
      });

      // Debounce has not fired — search must not have been called yet
      expect(mockSearchDownloads).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls searchDownloads with typed query after debounce elapses', async () => {
    mockListDownloads.mockResolvedValue([makeItem()]);
    mockSearchDownloads.mockResolvedValue([makeItem({ galleryId: 9001, title: 'Filtered' })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => {
      fireEvent.change(input, { target: { value: 'dragon' } });
    });

    await waitFor(() => expect(mockSearchDownloads).toHaveBeenCalledWith({ query: 'dragon' }), {
      timeout: 3000,
    });
  });

  it('shows filtered results after debounce', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ title: 'Original' })]);
    mockSearchDownloads.mockResolvedValue([
      makeItem({ galleryId: 9001, title: 'Filtered Result' }),
    ]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => {
      fireEvent.change(input, { target: { value: 'filtered' } });
    });

    await waitFor(() => expect(screen.getByText('Filtered Result')).toBeTruthy(), {
      timeout: 3000,
    });
  });

  it('shows no-results message when search returns empty', async () => {
    mockListDownloads.mockResolvedValue([makeItem()]);
    mockSearchDownloads.mockResolvedValue([]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => {
      fireEvent.change(input, { target: { value: 'zzznomatch' } });
    });

    await waitFor(() => expect(screen.getByText('search.noResults')).toBeTruthy(), {
      timeout: 3000,
    });
  });

  it('reverts to full list when query is cleared', async () => {
    const full = [makeItem({ title: 'Full List Item' })];
    mockListDownloads.mockResolvedValue(full);
    mockSearchDownloads.mockResolvedValue([makeItem({ galleryId: 9001, title: 'Filtered' })]);

    await act(async () => {
      await renderPage();
    });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');

    // Type → wait for filtered results
    act(() => {
      fireEvent.change(input, { target: { value: 'x' } });
    });
    await waitFor(() => expect(screen.getByText('Filtered')).toBeTruthy(), { timeout: 3000 });

    // Clear via the visible clear control → wait for full list to reappear
    const clearButton = screen.getByRole('button', { name: 'Clear' });
    act(() => {
      fireEvent.click(clearButton);
    });
    await waitFor(() => expect(screen.getByText('Full List Item')).toBeTruthy(), { timeout: 3000 });
  });
});
