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
import { getGalleryBlock as _getGalleryBlock, saveGalleryBlock as _saveGalleryBlock } from '@/lib/db/gallery';
import { resolveBlock } from '../useGalleryBlock';

const fetchGalleryBlockHtmlById = _fetchBlock as ReturnType<typeof vi.fn>;
const getGalleryBlock = _getGalleryBlock as ReturnType<typeof vi.fn>;
const saveGalleryBlock = _saveGalleryBlock as ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe('resolveBlock SWR revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached block immediately without fetching when fresh', async () => {
    const freshBlock = {
      id: 200,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Fresh',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
      updatedAt: new Date(), // just now — not stale
    };
    getGalleryBlock.mockResolvedValue(freshBlock);

    const result = await resolveBlock(200);

    expect(result).toBe(freshBlock);
    expect(fetchGalleryBlockHtmlById).not.toHaveBeenCalled();
  });

  it('returns cached block immediately AND triggers background revalidation when stale (NOT_DETAILED, >7 days)', async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    const staleBlock = {
      id: 201,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Stale',
      date: new Date('2024-01-01'),
      tags: {},
      thumbnail: '',
      related: [],
      updatedAt: staleDate,
    };
    const freshBlock = { ...staleBlock, title: 'Updated', updatedAt: new Date() };
    getGalleryBlock.mockResolvedValue(staleBlock);
    fetchGalleryBlockHtmlById.mockResolvedValue(freshBlock);

    const result = await resolveBlock(201);

    // Returns cached immediately
    expect(result).toBe(staleBlock);

    // Background revalidation triggered (no signal)
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryBlockHtmlById).toHaveBeenCalledWith(201);
    expect(saveGalleryBlock).toHaveBeenCalledWith(freshBlock);
  });

  it('returns cached block immediately AND triggers background revalidation when stale (DETAILED, >3 days)', async () => {
    const staleDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
    const staleBlock = {
      id: 202,
      type: GalleryBlockType.DETAILED,
      title: 'Stale Detailed',
      date: new Date('2024-01-01'),
      tags: {},
      thumbnail: '',
      related: [],
      updatedAt: staleDate,
    };
    const freshBlock = { ...staleBlock, title: 'Updated Detailed', updatedAt: new Date() };
    getGalleryBlock.mockResolvedValue(staleBlock);
    fetchGalleryBlockHtmlById.mockResolvedValue(freshBlock);

    const result = await resolveBlock(202);

    expect(result).toBe(staleBlock);

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryBlockHtmlById).toHaveBeenCalledWith(202);
    expect(saveGalleryBlock).toHaveBeenCalledWith(freshBlock);
  });

  it('does NOT revalidate when NOT_DETAILED is only 6 days old (within threshold)', async () => {
    const freshEnough = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000); // 6 days
    const block = {
      id: 203,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'OK',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
      updatedAt: freshEnough,
    };
    getGalleryBlock.mockResolvedValue(block);

    const result = await resolveBlock(203);

    expect(result).toBe(block);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryBlockHtmlById).not.toHaveBeenCalled();
  });

  it('does NOT revalidate when block has no updatedAt', async () => {
    const block = {
      id: 204,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'No updatedAt',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
      // no updatedAt
    };
    getGalleryBlock.mockResolvedValue(block);

    const result = await resolveBlock(204);

    expect(result).toBe(block);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryBlockHtmlById).not.toHaveBeenCalled();
  });
});

describe('resolveBlock FAILED block handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGalleryBlock.mockResolvedValue(null);
  });

  it('should NOT save FAILED blocks to DB', async () => {
    const failedBlock = {
      id: 100,
      type: GalleryBlockType.FAILED,
      title: '',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
    };
    fetchGalleryBlockHtmlById.mockResolvedValue(failedBlock);

    await resolveBlock(100);

    expect(saveGalleryBlock).not.toHaveBeenCalled();
  });

  it('should save NOT_DETAILED blocks to DB', async () => {
    const notDetailedBlock = {
      id: 101,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Test',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
    };
    fetchGalleryBlockHtmlById.mockResolvedValue(notDetailedBlock);

    await resolveBlock(101);

    expect(saveGalleryBlock).toHaveBeenCalledWith(notDetailedBlock);
  });
});

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
