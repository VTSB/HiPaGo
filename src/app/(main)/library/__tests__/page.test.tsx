// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

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
}));
const mockListDownloads = vi.fn<() => Promise<DBDownload[]>>();
const mockSearchDownloads = vi.fn<(opts: { query?: string }) => Promise<DBDownload[]>>();
const mockDeleteDownload = vi.fn<(id: number) => Promise<void>>();
const mockCreateDownloadStore = vi.fn();

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
  enqueueDownload: vi.fn(async () => 1),
}));

vi.mock('@/lib/store/download-progress', () => {
  // Full-enough store shape: DownloadQueueView (mounted atop DownloadsView since
  // Task B) reads queue/globalPaused + action selectors, and renders nothing when
  // queue is empty — so an empty queue keeps this a pure library-list render test.
  const state = {
    entries: {},
    downloaded: {},
    queue: [],
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
  };
  return {
    DOWNLOAD_LIBRARY_CHANGED_EVENT: 'hipago:download-library-changed',
    processQueue: vi.fn(async () => {}),
    useDownloadProgressStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: () => mockCreateDownloadStore(),
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
    }) => unknown,
  ) => sel({ locale: 'en', libraryInitialTab: mockSettings.libraryInitialTab }),
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
    window.history.replaceState({}, '', '/library');
    sessionStorage.clear();
    mockCreateDownloadStore.mockResolvedValue({
      usage: vi.fn().mockResolvedValue(0),
      deleteGallery: vi.fn().mockResolvedValue(undefined),
    });
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
    expect(mockDeleteGallery).toHaveBeenCalledWith(2001);
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

    vi.useRealTimers();
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
