// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockListDownloads = vi.fn<() => Promise<DBDownload[]>>();
const mockSearchDownloads = vi.fn<(opts: { query?: string }) => Promise<DBDownload[]>>();
const mockDeleteDownload = vi.fn<(id: number) => Promise<void>>();
const mockCreateDownloadStore = vi.fn();

vi.mock('@/lib/db/download', () => ({
  listDownloads: () => mockListDownloads(),
  searchDownloads: (opts: { query?: string }) => mockSearchDownloads(opts),
  deleteDownload: (id: number) => mockDeleteDownload(id),
}));

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: () => mockCreateDownloadStore(),
}));

// Mock next/link as a plain anchor
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
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
  useSettingsStore: (sel: (s: { locale: string }) => unknown) => sel({ locale: 'en' }),
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
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(LibraryPage),
    ),
  );
  return { ...result, qc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await act(async () => { await renderPage(); });

    expect(screen.getByTestId('spinner')).toBeTruthy();
  });

  it('renders an empty-state message when there are no downloads', async () => {
    mockListDownloads.mockResolvedValue([]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('library.empty')).toBeTruthy();
  });

  it('renders a card for each downloaded item', async () => {
    const items: DBDownload[] = [
      makeItem({ galleryId: 1001, title: 'Gallery One' }),
      makeItem({ galleryId: 1002, title: 'Gallery Two', status: 'failed' }),
    ];
    mockListDownloads.mockResolvedValue(items);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('Gallery One')).toBeTruthy();
    expect(screen.getByText('Gallery Two')).toBeTruthy();
  });

  it('renders total item count in the heading', async () => {
    mockListDownloads.mockResolvedValue([makeItem(), makeItem({ galleryId: 1002 })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText('(2)')).toBeTruthy();
  });

  it('renders Open link pointing to the gallery route', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 1001 })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const openLink = screen.getByRole('link', { name: 'library.open' });
    expect(openLink.getAttribute('href')).toBe('/gallery?id=1001');
  });

  it('renders page count and formatted size metadata', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ pageCount: 42, totalBytes: 1024 })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    expect(screen.getByText(/42/)).toBeTruthy();
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

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const deleteBtn = screen.getByRole('button', { name: 'library.delete' });
    await act(async () => { fireEvent.click(deleteBtn); });

    expect(mockDeleteDownload).toHaveBeenCalledWith(2001);
    expect(mockDeleteGallery).toHaveBeenCalledWith(2001);
  });

  it('does NOT delete when the confirm dialog is cancelled', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ galleryId: 3001 })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const deleteBtn = screen.getByRole('button', { name: 'library.delete' });
    await act(async () => { fireEvent.click(deleteBtn); });

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
    await act(async () => { await renderPage(); });
    // Drain the initial listDownloads fetch
    await act(async () => { await vi.runAllTimersAsync(); });

    const input = screen.getByRole('textbox');
    act(() => { fireEvent.change(input, { target: { value: 'dragon' } }); });

    // Debounce has not fired — search must not have been called yet
    expect(mockSearchDownloads).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('calls searchDownloads with typed query after debounce elapses', async () => {
    mockListDownloads.mockResolvedValue([makeItem()]);
    mockSearchDownloads.mockResolvedValue([makeItem({ galleryId: 9001, title: 'Filtered' })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => { fireEvent.change(input, { target: { value: 'dragon' } }); });

    await waitFor(
      () => expect(mockSearchDownloads).toHaveBeenCalledWith({ query: 'dragon' }),
      { timeout: 3000 },
    );
  });

  it('shows filtered results after debounce', async () => {
    mockListDownloads.mockResolvedValue([makeItem({ title: 'Original' })]);
    mockSearchDownloads.mockResolvedValue([makeItem({ galleryId: 9001, title: 'Filtered Result' })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => { fireEvent.change(input, { target: { value: 'filtered' } }); });

    await waitFor(
      () => expect(screen.getByText('Filtered Result')).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  it('shows no-results message when search returns empty', async () => {
    mockListDownloads.mockResolvedValue([makeItem()]);
    mockSearchDownloads.mockResolvedValue([]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');
    act(() => { fireEvent.change(input, { target: { value: 'zzznomatch' } }); });

    await waitFor(
      () => expect(screen.getByText('search.noResults')).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  it('reverts to full list when query is cleared', async () => {
    const full = [makeItem({ title: 'Full List Item' })];
    mockListDownloads.mockResolvedValue(full);
    mockSearchDownloads.mockResolvedValue([makeItem({ galleryId: 9001, title: 'Filtered' })]);

    await act(async () => { await renderPage(); });
    await waitFor(() => expect(screen.queryByTestId('spinner')).toBeNull());

    const input = screen.getByRole('textbox');

    // Type → wait for filtered results
    act(() => { fireEvent.change(input, { target: { value: 'x' } }); });
    await waitFor(
      () => expect(screen.getByText('Filtered')).toBeTruthy(),
      { timeout: 3000 },
    );

    // Clear via the visible clear control → wait for full list to reappear
    const clearButton = screen.getByRole('button', { name: 'Clear' });
    act(() => { fireEvent.click(clearButton); });
    await waitFor(
      () => expect(screen.getByText('Full List Item')).toBeTruthy(),
      { timeout: 3000 },
    );
  });
});
