// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGalleryBlock } from '../useGalleryBlock';
import { GalleryBlockType } from '@/lib/utils/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/api/gallery', () => ({
  fetchGalleryBlockHtmlById: vi.fn(),
  createLoadingBlock: (id: number) => ({
    id,
    type: GalleryBlockType.LOADING,
    title: '',
    date: new Date(),
    tags: {},
    thumbnail: '',
    related: [],
  }),
}));

vi.mock('@/lib/db/gallery', () => ({
  getGalleryBlock: vi.fn(),
  saveGalleryBlock: vi.fn().mockResolvedValue(undefined),
}));

import { fetchGalleryBlockHtmlById as _fetchBlock } from '@/lib/api/gallery';
import { getGalleryBlock as _getGalleryBlock } from '@/lib/db/gallery';

const fetchGalleryBlockHtmlById = _fetchBlock as ReturnType<typeof vi.fn>;
const getGalleryBlock = _getGalleryBlock as ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe('useGalleryBlock signal threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // DB returns null by default — falls through to fetch
    getGalleryBlock.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // Test 1: AbortSignal is passed to fetchGalleryBlockHtmlById
  // -------------------------------------------------------------------------
  it('passes an AbortSignal instance to fetchGalleryBlockHtmlById', async () => {
    const mockBlock = {
      id: 42,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Test',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
    };
    fetchGalleryBlockHtmlById.mockResolvedValue(mockBlock);

    const { result } = renderHook(() => useGalleryBlock(42), { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(result.current.type).toBe(GalleryBlockType.NOT_DETAILED);
    });

    expect(fetchGalleryBlockHtmlById).toHaveBeenCalledOnce();
    const [_id, signal] = fetchGalleryBlockHtmlById.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  // -------------------------------------------------------------------------
  // Test 2: Returns loading block while the query is pending
  // -------------------------------------------------------------------------
  it('returns a LOADING block while the query is still pending', () => {
    // Never resolves
    fetchGalleryBlockHtmlById.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useGalleryBlock(99), { wrapper: makeWrapper() });

    // Synchronously the hook must return the loading placeholder
    expect(result.current.id).toBe(99);
    expect(result.current.type).toBe(GalleryBlockType.LOADING);
  });

  // -------------------------------------------------------------------------
  // Test 3: AbortError does not break the hook — returns loading block
  // -------------------------------------------------------------------------
  it('returns loading block when fetchGalleryBlockHtmlById throws AbortError', async () => {
    // React Query cancels queries by aborting the signal; the queryFn throwing
    // an AbortError causes RQ to treat it as a cancelled (not failed) query —
    // the hook should still return the loading placeholder, not throw.
    fetchGalleryBlockHtmlById.mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    );

    const { result } = renderHook(() => useGalleryBlock(77), { wrapper: makeWrapper() });

    // Allow React Query to process the rejection
    await new Promise((r) => setTimeout(r, 50));

    // Hook must still return the loading block — not throw or return undefined
    expect(result.current).toBeDefined();
    expect(result.current.id).toBe(77);
    expect(result.current.type).toBe(GalleryBlockType.LOADING);
  });
});
