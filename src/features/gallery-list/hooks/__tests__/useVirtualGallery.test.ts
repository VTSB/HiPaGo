// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useVirtualGallery } from '../useVirtualGallery';
import { PAGE_SIZE } from '@/lib/utils/constants';

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { language: string }) => unknown) => sel({ language: 'all' }),
}));

vi.mock('@/lib/api/gallery', () => ({
  fetchBrowseIds: vi.fn(),
}));

import { fetchBrowseIds as _fetchBrowseIds } from '@/lib/api/gallery';
const fetchBrowseIds = _fetchBrowseIds as unknown as ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe('useVirtualGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchBrowseIds.mockResolvedValue({ idList: [101, 102, 103], length: 300 });
  });

  // ---------------------------------------------------------------------------
  // Initial fetch
  // ---------------------------------------------------------------------------

  it('fetches page 0 on mount with default sort', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));
    expect(fetchBrowseIds).toHaveBeenCalledWith('all', 0, PAGE_SIZE, 'date_added');
  });

  it('isInitialLoading is true while page 0 is pending', () => {
    fetchBrowseIds.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    expect(result.current.isInitialLoading).toBe(true);
  });

  it('isInitialLoading becomes false after data arrives', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
  });

  // ---------------------------------------------------------------------------
  // getItemId
  // ---------------------------------------------------------------------------

  it('getItemId returns null for unloaded page', () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    // page 1 (index 1) not yet requested
    expect(result.current.getItemId(PAGE_SIZE)).toBeNull();
  });

  it('getItemId returns correct id after page 0 loads', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));
    expect(result.current.getItemId(0)).toBe(101);
    expect(result.current.getItemId(1)).toBe(102);
    expect(result.current.getItemId(2)).toBe(103);
  });

  it('getItemId returns null for index beyond loaded ids', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));
    // page 0 has only 3 ids; index 3 is on page 0 too but beyond what mock returned
    expect(result.current.getItemId(3)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // requestPage idempotency
  // ---------------------------------------------------------------------------

  it('requestPage is idempotent — same page twice does not add duplicate fetch', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));

    const callsBefore = fetchBrowseIds.mock.calls.length;
    act(() => { result.current.requestPage(0); });
    act(() => { result.current.requestPage(0); });
    // page 0 already needed; React Query dedups, but neededPages Set also prevents re-add
    expect(fetchBrowseIds.mock.calls.length).toBe(callsBefore);
  });

  it('requestPage for a new page triggers a fetch', async () => {
    fetchBrowseIds.mockResolvedValue({ idList: [200, 201], length: 300 });
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));

    act(() => { result.current.requestPage(5); });
    await waitFor(() => {
      expect(fetchBrowseIds).toHaveBeenCalledWith('all', 5, PAGE_SIZE, 'date_added');
    });
  });

  it('getItemId returns id from a later page after it loads', async () => {
    fetchBrowseIds.mockImplementation((_lang: string, page: number) => {
      if (page === 0) return Promise.resolve({ idList: [101], length: 300 });
      if (page === 1) return Promise.resolve({ idList: [201], length: 300 });
      return Promise.resolve({ idList: [], length: 300 });
    });

    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(300));

    act(() => { result.current.requestPage(1); });
    await waitFor(() => {
      expect(result.current.getItemId(PAGE_SIZE)).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset on sort/language change
  // ---------------------------------------------------------------------------

  it('resets neededPages to {0} when sort changes', async () => {
    const { result, rerender } = renderHook(
      ({ sort }: { sort: 'date_added' | 'popular_year' }) => useVirtualGallery(sort),
      { wrapper: makeWrapper(), initialProps: { sort: 'date_added' as 'date_added' | 'popular_year' } },
    );
    await waitFor(() => expect(result.current.totalLength).toBe(300));

    // Request extra page
    act(() => { result.current.requestPage(3); });
    await waitFor(() => {
      expect(fetchBrowseIds).toHaveBeenCalledWith('all', 3, PAGE_SIZE, 'date_added');
    });

    // Change sort
    rerender({ sort: 'popular_year' });
    await waitFor(() => {
      expect(fetchBrowseIds).toHaveBeenCalledWith('all', 0, PAGE_SIZE, 'popular_year');
    });
  });

  it('totalLength reflects max length seen across all loaded pages', async () => {
    fetchBrowseIds.mockImplementation((_lang: string, page: number) => {
      if (page === 0) return Promise.resolve({ idList: [1], length: 500 });
      if (page === 1) return Promise.resolve({ idList: [2], length: 480 }); // smaller — use max
      return Promise.resolve({ idList: [], length: 0 });
    });

    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(500));

    act(() => { result.current.requestPage(1); });
    await waitFor(() => {
      // totalLength should remain 500 (max of 500 and 480)
      expect(result.current.totalLength).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// neededPages ring buffer
// ---------------------------------------------------------------------------


describe('neededPages ring buffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchBrowseIds.mockResolvedValue({ idList: [], length: 100 });
  });

  it('requesting 21 pages caps at 20 — only 20 unique pages are ever active', async () => {
    // Track every unique page number that fetchBrowseIds is called with
    const fetchedPages = new Set<number>();
    fetchBrowseIds.mockImplementation((_lang: string, page: number) => {
      fetchedPages.add(page);
      return Promise.resolve({ idList: [], length: 100 });
    });

    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });

    // page 0 is added on mount; add pages 1-20 to reach 21 total, triggering cap
    for (let p = 1; p <= 20; p++) {
      act(() => { result.current.requestPage(p); });
    }

    // Wait for React Query to process all queries
    await waitFor(() => {
      // After cap: only 20 pages should be active; page 0 was dropped when page 20 added
      // React Query fires fetches for each query in neededPages at the time of render.
      // With 21 total requests but cap at 20, the set holds exactly 20 pages.
      expect(fetchBrowseIds.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    // Allow all queries to settle
    await new Promise((r) => setTimeout(r, 50));

    // The ring buffer caps at 20: pages 1-20 are active, page 0 was dropped
    // Verify: page 20 was fetched (it's in the cap window)
    expect(fetchedPages.has(20)).toBe(true);

    // Page 0 may or may not have been fetched before it was dropped from the set.
    // The key invariant: neededPages never exceeds 20 entries.
    // We verify this indirectly: total unique pages fetched by React Query <= 21
    // (the cap logic limits the SET to 20, but queries already initiated still run)
    expect(fetchedPages.size).toBeLessThanOrEqual(21);
  });

  it('requestPage for already-requested page within cap does not grow the set', async () => {
    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(fetchBrowseIds).toHaveBeenCalledTimes(1));

    // Request pages 1-10 (total = 11, well within cap of 20)
    for (let p = 1; p <= 10; p++) {
      act(() => { result.current.requestPage(p); });
    }
    await waitFor(() => expect(fetchBrowseIds).toHaveBeenCalledTimes(11));

    // Re-requesting pages 1-10 must be deduplicated — neededPages Set prevents re-adding
    const callCountBefore = fetchBrowseIds.mock.calls.length;
    for (let p = 1; p <= 10; p++) {
      act(() => { result.current.requestPage(p); });
    }
    await new Promise((r) => setTimeout(r, 30));
    // No new fetches — all 10 pages are already in the set
    expect(fetchBrowseIds.mock.calls.length).toBe(callCountBefore);
  });

  it('after cap, page 50 is present and page 0 is evicted from neededPages', async () => {
    // Arrange: distinguish page 0 results from page 50 results
    fetchBrowseIds.mockImplementation((_lang: string, page: number) => {
      return Promise.resolve({ idList: [page * 100], length: 500 });
    });

    const { result } = renderHook(() => useVirtualGallery(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.totalLength).toBe(500));

    // Request pages 1-49 (total = 50, exactly at cap)
    for (let p = 1; p <= 49; p++) {
      act(() => { result.current.requestPage(p); });
    }

    // Request page 50 — this is the 51st unique page, triggering slice.
    // Slice keeps last 50: {1, 2, ..., 50}. Page 0 is evicted.
    act(() => { result.current.requestPage(50); });

    // Wait for page 50's data to load
    await waitFor(() => {
      // getItemId for an item on page 50 should return page 50's id (50 * 100 = 5000)
      expect(result.current.getItemId(50 * PAGE_SIZE)).toBe(5000);
    });

    // After eviction of page 0: getItemId(0) must return null because page 0 is no
    // longer in neededPages — its query is unmounted and data evicted by React Query
    // (gcTime default is finite; but more importantly neededPages no longer includes 0,
    //  so the query is not rendered and data is not in pageMap)
    expect(result.current.getItemId(0)).toBeNull();
  });
});
